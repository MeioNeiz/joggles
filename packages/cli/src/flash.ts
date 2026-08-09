#!/usr/bin/env bun
/**
 * Flash an OTA image over the `fd00` service.
 *
 *   bun run flash info                      read the device's version. Writes nothing
 *   bun run flash stage <image> [--limit n] stream data, never commit
 *   bun run flash commit <image> --yes      stage, then commit. This one writes flash
 *
 * The three subcommands are the first four steps of "Safe procedure" in
 * `research/firmware-flashing.md`, in order and least committal first. `info` and
 * `stage` cannot damage a device: nothing is committed until the `03` control write,
 * the staging bank is scratch, and the running application is never erased. So a
 * `stage` that is abandoned halfway costs a minute and nothing else.
 *
 * `commit` is different, and everything in this file that looks paranoid is about it:
 * on a CRC match the device programs `CONFIG0`, resets, and lets the bootloader copy
 * the staged image over the running one. A brown-out in that window is the one
 * failure `research/hardware-access.md` rates as possibly not recoverable even by
 * SWD. Charge the unit first.
 *
 * ## What guards what
 *
 * `ota.check` is the gate, and it runs before a single byte is sent, with the stock
 * image supplied so the patch checks run too. It is what refuses type 2, oversized
 * images, an image linked for the wrong base, the other hardware variant, and any
 * edit inside the regions that make a bad flash recoverable. This file adds only the
 * things a static check cannot see: an explicit `--yes` for the committing step, and
 * a refusal to commit an image whose transfer did not complete.
 */
import { protocol as p } from '@joggles/core'
// Not the main barrel: reaching fd00 is an explicit import. See core/src/firmware.ts.
import { dfu, ota } from '@joggles/core/src/firmware.js'
import { findPeripheral } from './noble.js'

const DEFAULT_STOCK = 'firmware/TR1906R04-10_OTA.bin'

/** noble reports custom UUIDs as 32 hex characters and adopted ones as 4. */
const flat = (uuid: string) => uuid.replace(/-/g, '')
const short = (uuid: string) => uuid.slice(4, 8)
const matches = (c: any, uuid: string) => c.uuid === flat(uuid) || c.uuid === short(uuid)

// --- Argument parsing ---------------------------------------------------------------

const TAKES_VALUE = new Set(['limit', 'packet', 'stock', 'timeout'])
const flags = new Set<string>()
const values = new Map<string, string>()
const positional: string[] = []

const argv = Bun.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (!arg.startsWith('--')) {
    positional.push(arg)
    continue
  }
  const name = arg.slice(2)
  if (TAKES_VALUE.has(name)) values.set(name, argv[++i] ?? '')
  else flags.add(name)
}

const [cmd, imagePath] = positional
const num = (name: string, fallback: number) => Number(values.get(name) ?? fallback)

if (!cmd || !['info', 'stage', 'commit'].includes(cmd)) {
  console.error('usage: bun run flash <info|stage|commit> [image] [flags]')
  console.error('  stage <image> [--limit n]   stream data without committing')
  console.error('  commit <image> --yes        stage and commit. Writes flash')
  process.exit(2)
}
if (cmd !== 'info' && !imagePath) {
  console.error(`${cmd} needs an image path`)
  process.exit(2)
}

// --- The pre-flight gate ------------------------------------------------------------

/**
 * Read the image and refuse to go further unless `ota.check` passes.
 *
 * The stock image is passed whenever it is present, because without it the patch
 * checks are silently skipped and those are the ones that stop us flashing away our
 * own way back.
 */
async function checked(path: string): Promise<{ file: Uint8Array; header: ota.Header }> {
  const file = new Uint8Array(await Bun.file(path).arrayBuffer())
  const stockPath = values.get('stock') ?? DEFAULT_STOCK
  const sameFile = Bun.pathToFileURL(stockPath).href === Bun.pathToFileURL(path).href
  const stock =
    (await Bun.file(stockPath).exists()) && !sameFile
      ? new Uint8Array(await Bun.file(stockPath).arrayBuffer())
      : undefined

  console.log(`image  ${path}`)
  if (sameFile) console.log('stock  this IS the stock image; there is nothing to diff')
  else console.log(stock ? `stock  ${stockPath}` : 'stock  NOT FOUND, patch checks skipped')
  console.log()
  const verdict = ota.check(file, { stock })
  console.log(ota.report(verdict))
  console.log()
  if (!verdict.safe) {
    console.error('refusing to send an image with fatal findings')
    process.exit(1)
  }
  // Re-flashing stock over stock is step 4 of the safe procedure and has no patch to
  // check, so only a *patched* image without its baseline is refused here.
  if (!stock && !sameFile) {
    console.error('refusing to flash a patched image with no stock to diff against.')
    console.error(`put the stock image at ${DEFAULT_STOCK}, or pass --stock <path>`)
    process.exit(1)
  }
  return { file, header: verdict.header! }
}

// --- Transport ----------------------------------------------------------------------

class Dfu {
  private waiters: Array<(r: dfu.Reply) => void> = []

  /** Set once the peer goes away, so a reboot is told from a stall. */
  private gone = false

  private constructor(
    private peripheral: any,
    private dataChar: any,
    private ctrlChar: any,
    readonly packetSize: number,
  ) {}

  static async open(timeoutMs: number, packetOverride?: number): Promise<Dfu> {
    const peripheral = await findPeripheral(timeoutMs, [p.NAME_PREFIX, p.CREW_NAME_PREFIX])
    const name = peripheral.advertisement.localName ?? '(unnamed)'
    console.log(`found  ${name}`)
    await peripheral.connectAsync()

    const { characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync()
    const data = characteristics.find((c: any) => matches(c, dfu.CHAR_DATA))
    const ctrl = characteristics.find((c: any) => matches(c, dfu.CHAR_CTRL))
    if (!data || !ctrl) {
      await peripheral.disconnectAsync()
      throw new Error('no fd01/fd02 on this device: it does not expose the OTA service')
    }

    // ATT overhead is 3 bytes. noble does not always report an MTU, and 23 is the
    // floor every connection is guaranteed, so an absent value is not an error, only
    // slow. Raising it with --packet is safe to *try*: CoreBluetooth truncates a
    // write past the real MTU rather than failing, which corrupts the stream, but the
    // CRC at ctrl 03 catches that and refuses to commit. The cost is a wasted upload.
    const mtu = Number(peripheral.mtu) || 23
    const negotiated = Math.min(mtu - 3, dfu.MAX_PACKET)
    const size = packetOverride ?? Math.max(negotiated, dfu.MIN_PACKET)
    console.log(`mtu    ${mtu}, using ${size}-byte writes (${size - dfu.PACKET_HEADER} payload)`)

    const d = new Dfu(peripheral, data, ctrl, size)
    peripheral.once('disconnect', () => {
      d.gone = true
    })
    ctrl.on('data', (buf: Buffer) => {
      const reply = dfu.parseReply(new Uint8Array(buf))
      if (!reply) return
      for (const w of d.waiters.splice(0)) w(reply)
    })
    await ctrl.subscribeAsync()
    return d
  }

  get disconnected(): boolean {
    return this.gone
  }

  /** Wait for the next reply. Resolves null on timeout rather than throwing. */
  private next(timeoutMs: number): Promise<dfu.Reply | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs)
      this.waiters.push((r) => {
        clearTimeout(timer)
        resolve(r)
      })
    })
  }

  /** Control writes are acknowledged at the ATT layer, so they go with response. */
  private async ctrlWrite(packet: Uint8Array, timeoutMs: number): Promise<dfu.Reply | null> {
    const reply = this.next(timeoutMs)
    await this.ctrlChar.writeAsync(Buffer.from(packet), false)
    return reply
  }

  async version(h: Parameters<typeof dfu.versionPacket>[0]): Promise<dfu.Reply | null> {
    return this.ctrlWrite(dfu.versionPacket(h), 5000)
  }

  async start(h: Parameters<typeof dfu.sizePacket>[0]): Promise<dfu.Reply | null> {
    return this.ctrlWrite(dfu.sizePacket(h), 5000)
  }

  /**
   * Stream data packets, one per acknowledgement.
   *
   * Strictly ack-driven, which is what the vendor app does and the only flow control
   * available: `fd01` is write-without-response, so nothing else would stop us
   * outrunning the device's page buffer. It also means a stalled device shows up as a
   * timeout here rather than as a corrupt image at the CRC.
   */
  async stream(packets: Uint8Array[], onProgress: (sent: number) => void): Promise<number> {
    for (let i = 0; i < packets.length; i++) {
      const ack = this.next(5000)
      await this.dataChar.writeAsync(Buffer.from(packets[i]), true)
      const reply = await ack
      if (!reply) throw new Error(`no ack for packet ${i} of ${packets.length}`)
      if (reply.kind !== 'ack') throw new Error(`unexpected ${reply.kind} reply mid-stream`)
      onProgress(i + 1)
    }
    return packets.length
  }

  /** Commit. The device reboots on success, so losing the link here is expected. */
  async commit(h: Parameters<typeof dfu.crcPacket>[0], timeoutMs: number) {
    return this.ctrlWrite(dfu.crcPacket(h), timeoutMs)
  }

  async close(): Promise<void> {
    if (this.gone) return
    await this.peripheral.disconnectAsync().catch(() => {})
  }
}

// --- Commands -----------------------------------------------------------------------

const pct = (n: number, total: number) => `${Math.floor((n * 100) / total)}%`

async function main(): Promise<number> {
  const timeout = num('timeout', 20000)
  const packetOverride = values.has('packet') ? num('packet', 20) : undefined

  // Everything that can be decided without touching Bluetooth is decided first, so a
  // bad invocation never reaches a connected device.
  const image = cmd === 'info' ? null : await checked(imagePath!)

  // A stock-over-stock commit bricked GLASSES-12C3EF on 2026-08-08. The image could not
  // have been at fault; the handoff into LDROM is. Until someone has dumped the LDROM
  // over SWD and seen a bootloader in it, this path is known to destroy units, so it
  // takes a claim about evidence rather than a nerve-steeling --yes.
  if (cmd === 'commit' && !flags.has('ldrom-verified')) {
    console.error('REFUSED: commit is barred. It bricked GLASSES-12C3EF on 2026-08-08,')
    console.error('flashing the STOCK image over itself. Staging was fine and the device')
    console.error("verified its own CRC; it reset and never came back.\n")
    console.error('Read research/brick-2026-08-08.md before going further. The bar to lift')
    console.error('this is dumping the LDROM over SWD and confirming a bootloader is there')
    console.error('that restores CBS. Then pass --ldrom-verified --yes.\n')
    console.error('`stage` is unaffected and still safe: it commits nothing.')
    return 2
  }
  if (cmd === 'commit' && !flags.has('yes')) {
    console.error('commit writes flash and reboots the device. Re-run with --yes.')
    console.error('Charge the unit first: the window after the CRC has no protection.')
    return 2
  }

  const d = await Dfu.open(timeout, packetOverride)
  try {
    // Sent before the transfer because these words land in the handoff record the
    // bootloader reads. For `info` there is no image, and nothing will be committed,
    // so zeros are honest rather than borrowed from a file we are not sending.
    const words = image?.header ?? { appVer: 0, devVer: 0, proVer: 0 }
    const reply = await d.version(words)
    if (!reply) {
      console.error('no reply to the version request: the OTA service is not responding')
      return 1
    }
    if (reply.kind !== 'version') {
      console.error(`expected a version reply, got ${reply.kind}`)
      return 1
    }
    console.log(`device app=${reply.appVer} dev=${reply.devVer} pro=${reply.proVer}`)

    if (cmd === 'info') {
      console.log('\nwrote no flash. This is the zero-risk check that the OTA path answers.')
      return 0
    }

    const { file, header } = image!
    const all = dfu.dataPackets(file, d.packetSize)
    const limit = values.has('limit') ? num('limit', 0) : undefined
    const packets =
      limit === undefined
        ? all
        : all.slice(0, Math.ceil(limit / (d.packetSize - dfu.PACKET_HEADER)))
    const partial = packets.length < all.length

    console.log(`\nstaging ${header.codeSize} bytes as ${all.length} packets`)
    if (partial) console.log(`  --limit: sending only ${packets.length} of them`)

    const started = await d.start(header)
    if (!started || started.kind !== 'size') {
      console.error(`start refused or unanswered: ${started?.kind ?? 'timeout'}`)
      return 1
    }
    if (!started.ok) {
      console.error(`device rejected the size, status ${started.status}`)
      return 1
    }

    const began = Date.now()
    let lastShown = -1
    await d.stream(packets, (sent) => {
      const p = Math.floor((sent * 100) / all.length)
      if (p === lastShown) return
      lastShown = p
      process.stdout.write(`\r  ${pct(sent, all.length)}  ${sent}/${all.length} packets`)
    })
    const secs = ((Date.now() - began) / 1000).toFixed(1)
    console.log(`\n  staged in ${secs}s`)

    if (cmd === 'stage' || partial) {
      if (partial && cmd === 'commit') {
        console.error('\nrefusing to commit a partial transfer. Drop --limit to send it all.')
      }
      console.log('\nno commit sent, so nothing was written to the application region.')
      console.log('Power-cycle and re-probe: the unit should be exactly as it was.')
      return partial && cmd === 'commit' ? 1 : 0
    }

    console.log('\ncommitting. Do not power off until the unit has rebooted.')
    const done = await d.commit(header, 30000)
    if (!done) {
      // A reset can outrun the notification, so silence here is genuinely ambiguous.
      console.error('no reply to the commit.')
      console.error(
        d.disconnected
          ? 'The device disconnected, which is what a successful reboot looks like.'
          : 'The device is still connected, so the CRC step did not finish.',
      )
      console.error('Re-probe before flashing again; do not assume either outcome.')
      return 1
    }
    if (done.kind !== 'crc') {
      console.error(`expected a crc reply, got ${done.kind}`)
      return 1
    }
    if (!done.ok) {
      console.error(`\nCRC mismatch, status ${done.status}. Nothing was committed.`)
      console.error('The staged bank is scratch, so the unit is untouched. Retry the transfer.')
      return 1
    }

    console.log('\nCRC matched. The device is rebooting into the new image.')
    console.log('Now: bun cli probe')
    return 0
  } finally {
    await d.close()
  }
}

try {
  const code = await main()
  // noble keeps the process alive on macOS once the adapter has been used.
  process.exit(code)
} catch (err) {
  console.error('\nerror:', (err as Error).message)
  console.error('Nothing is committed without the CRC step, so an abort here is safe.')
  process.exit(1)
}
