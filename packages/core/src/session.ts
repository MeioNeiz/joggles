/**
 * Everything the glasses are told to do, with no idea how the bytes get there.
 *
 * Lifted out of `packages/cli/src/glasses.ts`, which welded this sequencing to
 * noble. It is the valuable part and it must not exist twice: a second copy on the
 * phone drifts from this one, and the DATS handshake is where drift is expensive.
 *
 * Two hardware constraints drive the write paths, both learned the hard way:
 *
 *  1. One 16-byte block per ATT write. The panel decodes only the FIRST block of a
 *     write and discards the rest, so batching silently loses columns.
 *  2. Write-without-response has no flow control, so writes must be paced or the
 *     controller drops them, leaving stale columns lit.
 */
import { FlashBudget, type SaveOptions, fingerprint } from './budget.js'
import * as dats from './dats.js'
import { Grid } from './display.js'
import * as jgx from './jgx.js'
import * as p from './protocol.js'
import { LiveSender, type SenderOptions } from './sender.js'
import type { Transport } from './transport.js'

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

/**
 * The DATS type `save()` announces unless told otherwise.
 *
 * Type 1 is the default because it is the only one ever run on hardware, and the
 * only one that writes flash. See `SaveOpts.type`.
 */
const SAVED_TYPE = 1

export interface SessionOptions {
  /** Delay between column writes. Below ~12ms the panel starts dropping them. */
  pacing?: number
  /**
   * Cipher for this connection. Stock units hold the vendor key forever, because
   * we cannot reflash a stranger's glasses; our own hold the crew group key.
   *
   * A function receives the advertised name, which is how a mixed fleet is
   * handled: the rename makes crew units identifiable before the connection is
   * even open, so the right key can be chosen without a round trip.
   */
  cipher?: p.Cipher | ((name: string) => p.Cipher)
  /** Shared by every session on one host, so its rate limits actually span them. */
  budget?: FlashBudget
  /**
   * Ledger key. Defaults to the advert name, which carries the last three bytes of
   * the MAC and so identifies a unit across hosts; the platform's own handle does
   * not (CoreBluetooth hands out a per-host UUID).
   */
  device?: string
}

/** What a unit turned out to be, once probed. */
export type Identity =
  | { kind: 'stock'; name: string }
  | { kind: 'crew'; name: string; version: number; capabilities: number }

export interface SaveOpts extends SaveOptions {
  /** Inter-block delay. The vendor app uses 50ms; it dominates upload time. */
  blockSleep?: number
  /**
   * DATS type: 1 monochrome, 2 greyscale. Both run on hardware.
   *
   * **Type 2 writes no flash** (*verified*: the image is gone after a power cycle and
   * the type 1 store is untouched), yet it is still charged to the wear budget here.
   * That is deliberate rather than an oversight: relaxing the one guard that stops a
   * render loop is a decision for whoever owns the drawing screen, and the cost of
   * leaving it is a smaller allowance, not a wrong result.
   *
   * A type 2 image displays itself on `DATCPOK`. Do not follow it with `MODE`, which
   * switches to the type 1 flash store with no way back.
   */
  type?: number
}

export interface SaveResult {
  /** `refused` means the device never acknowledged, so no flash was touched. */
  status: 'saved' | 'skipped' | 'refused'
  /** The device's own word: `DATCPOK`, `ERROR`, `TIMEOUT`, or why nothing was sent. */
  reply: string
  /** Lifetime saves counted against this device, this one included. */
  saves: number
}

export class Glasses {
  private last: Grid | null = null

  private waiters: Array<(reply: string) => void> = []

  private extWaiters: Array<(msg: jgx.Notification) => void> = []

  private constructor(
    private transport: Transport,
    readonly name: string,
    readonly device: string,
    private pacing: number,
    private cipher: p.Cipher,
    private budget: FlashBudget,
  ) {}

  /**
   * Take a connection that is already open.
   *
   * The name is an argument rather than something read off the connection because
   * the cipher can be a function of it, and because only the scanner ever saw the
   * advert. Scan, connect and subscribe used to be one static here; a Scan screen
   * needs all three apart.
   */
  static async attach(
    transport: Transport,
    name: string,
    opts: SessionOptions = {},
  ): Promise<Glasses> {
    const { pacing = 18, cipher: pick = p.vendor } = opts
    const cipher = typeof pick === 'function' ? pick(name) : pick
    const g = new Glasses(
      transport,
      name,
      opts.device ?? name,
      pacing,
      cipher,
      opts.budget ?? new FlashBudget(),
    )
    await g.listen()
    return g
  }

  /**
   * Subscribe to the notify channel; DATS is handshake-driven.
   *
   * Two parsers see every block. The vendor's three ASCII replies and our own
   * marked frames share one characteristic, because the device's notify sender
   * hardcodes the handle, so telling them apart is the client's job.
   */
  private async listen(): Promise<void> {
    await this.transport.subscribe(p.CHAR_NOTIFY, (block) => {
      if (block.length !== p.BLOCK_SIZE) return
      const plain = this.cipher.decrypt(block)

      const msg = jgx.parseNotification(plain)
      if (msg) {
        for (const w of this.extWaiters.splice(0)) w(msg)
        return
      }
      const reply = dats.parseReply(plain)
      if (!reply) return
      for (const w of this.waiters.splice(0)) w(reply)
    })
  }

  private send(char: string, frame: Uint8Array, withResponse: boolean): Promise<void> {
    return this.transport.write(char, this.cipher.encrypt(frame), withResponse)
  }

  private waitReply(timeoutMs = 5000): Promise<string> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve('TIMEOUT'), timeoutMs)
      this.waiters.push((r) => {
        clearTimeout(timer)
        resolve(r)
      })
    })
  }

  /**
   * Ask the unit what firmware it carries.
   *
   * Silence is the answer for a stock unit: it does not recognise the opcode, the
   * dispatcher falls through to no-match, and nothing comes back. So a timeout here
   * is a result, not a failure, and the wait is short on purpose.
   */
  async probe(timeoutMs = 1500): Promise<Identity> {
    const name = this.name
    const reply = new Promise<jgx.Notification | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs)
      this.extWaiters.push((m) => {
        clearTimeout(timer)
        resolve(m)
      })
    })
    await this.send(p.CHAR_COMMAND, jgx.hello(), false)

    const msg = await reply
    if (msg?.type !== 'hello') return { kind: 'stock', name }
    return { kind: 'crew', name, version: msg.version, capabilities: msg.capabilities }
  }

  /**
   * Store a bitmap on the device, for it to animate by itself.
   *
   * Unlike `show()`, this survives disconnection: the `MODE` commands display DATS
   * content, not the live DIY buffer. **It is also the only flash write in this
   * codebase**, five page erases per call whatever the payload size, so it is the
   * one caller of `dats.datsComplete()` and it goes through the budget guard.
   * `choke-point.test.ts` fails the build if a second caller appears.
   *
   * No ceiling is enforced here, deliberately: `content.check()` is the app's gate,
   * and `packages/cli/src/type2.ts` has to be able to send one column past the
   * derived ceiling to find out whether it is real.
   */
  async save(bitmap: number[][], opts: SaveOpts = {}): Promise<SaveResult> {
    const { blockSleep = 50, type = SAVED_TYPE } = opts
    const payload =
      type === dats.TYPE_IMAGE ? dats.encodeImage(bitmap) : dats.encodeBitmap(bitmap)
    const columns = bitmap[0]?.length ?? 0
    const hash = fingerprint(payload, type)

    if (!(await this.budget.allow(this.device, hash, opts))) {
      const { lifetime } = await this.budget.ledger(this.device)
      return { status: 'skipped', reply: 'already on the glasses', saves: lifetime }
    }

    const ack = this.waitReply()
    await this.send(p.CHAR_COMMAND, dats.datsStart(payload.length, type), false)
    const started = await ack
    if (started !== 'DATSOK') {
      return {
        status: 'refused',
        reply: `DATS not acknowledged: ${started}`,
        saves: (await this.budget.ledger(this.device)).lifetime,
      }
    }

    // 50ms is the vendor app's inter-chunk delay, copied rather than measured, and it
    // dominates upload time: at the 1480-byte ceiling it is 4.9s of the ~5.9s cycle.
    // 6ms is the measured floor and below it the time moves into DATCP rather than
    // disappearing. Length is checked at the device (DATCP compares a running counter
    // against what DATS predicted, abs 0x182e0), but content is not: dropped blocks
    // still answer DATCPOK, so pacing too hard corrupts silently.
    for (const block of dats.chunkPayload(payload)) {
      await this.send(p.CHAR_BULK_A, block, false)
      if (blockSleep > 0) await sleep(blockSleep)
    }

    const done = this.waitReply()
    await this.send(p.CHAR_COMMAND, dats.datsComplete(), false)
    const reply = await done
    // Counted whatever came back: the erases happen at the device's end, so a
    // rejected save has still spent them.
    const ledger = await this.budget.count(this.device, {
      hash,
      columns,
      ok: reply === 'DATCPOK',
    })
    return { status: 'saved', reply, saves: ledger.lifetime }
  }

  /** Lifetime and rolling counts for this unit. The only wear number we can have. */
  ledger() {
    return this.budget.ledger(this.device)
  }

  async command(frame: Uint8Array): Promise<void> {
    await this.send(p.CHAR_COMMAND, frame, false)
    await sleep(120)
  }

  /**
   * Write one bulk frame directly, bypassing the Grid's 24-column limit.
   *
   * Unacked, so callers driving a whole frame this way must call flush() before
   * disconnecting or the last writes are discarded.
   */
  async commandRaw(frame: Uint8Array): Promise<void> {
    await this.send(p.CHAR_BULK_B, frame, false)
    await sleep(this.pacing)
  }

  /**
   * A `LiveSender` for this connection, with the cipher already settled.
   *
   * The transport and the cipher are private here and a drawing screen needs
   * both, so without this every host would rebuild them: the transport by being
   * handed down beside the session, and the cipher by re-running the advert-name
   * rule. Getting that second one wrong on a crew unit is silent - the frames are
   * garbage the device ignores, and the panel simply does not change.
   *
   * **Call it after `begin()`.** The sender assumes the live buffer starts blank,
   * which is true because `SMVEW 01` clears it, and that is what `begin()` sends.
   *
   * From then on the sender owns the live buffer. Do not interleave `show()` with
   * it - the two keep separate ideas of what the panel was last told - and
   * remember that any `MODE` discards what it drew.
   */
  live(opts: Omit<SenderOptions, 'cipher'> = {}): LiveSender {
    return new LiveSender(this.transport, {
      pacing: this.pacing,
      ...opts,
      cipher: this.cipher,
    })
  }

  /** Enter DIY mode with the panel on, ready for pixel writes. */
  async begin(): Promise<void> {
    await this.command(p.enterDIY())
    // LEDON reaches no handler on our unit (hand-checked opcode scan). Kept because
    // removing it would change what the wire sees for no gain, not because it works.
    await this.command(p.leds(true))
    this.last = null
  }

  /** Push a frame. Sends only changed columns unless `full` is set. */
  async show(grid: Grid, full = false): Promise<number> {
    const frames = full
      ? grid.toFrames().map((f, i) => [i, f] as [number, Uint8Array])
      : grid.deltaFrames(this.last)
    for (const [i, [, frame]] of frames.entries()) {
      // The last write of a frame is acked, so the frame cannot be half-delivered
      // if the caller disconnects or exits immediately afterwards.
      const last = i === frames.length - 1
      await this.send(p.CHAR_BULK_B, frame, last)
      if (!last) await sleep(this.pacing)
    }
    this.last = grid.clone()
    return frames.length
  }

  /**
   * Finish a session.
   *
   * Leaving DIY mode makes the firmware restore whatever image the vendor app
   * saved, which looks exactly like stray pixels appearing from nowhere. So
   * "keep" is the default.
   *
   * It does NOT send `DATCP` on the way out. That would spend a flash cycle to
   * commit a truncated upload over content the user had already saved, and it
   * would put a second caller on the choke point.
   */
  async end(mode: 'keep' | 'off' | 'restore' = 'keep'): Promise<void> {
    if (mode === 'off') {
      await this.show(new Grid(), true)
      await this.command(p.leds(false))
    } else if (mode === 'restore') {
      await this.command(p.exitDIY())
    }
    await this.flush()
    await this.transport.disconnect()
  }

  /**
   * Force any queued writes out.
   *
   * A write WITH response is acknowledged by the peer, so once it returns every
   * earlier write has necessarily been transmitted. show() already ends with an
   * acked write; this covers raw writers that do not.
   */
  async flush(): Promise<void> {
    await this.send(p.CHAR_COMMAND, p.frame('STYPE'), true)
  }
}
