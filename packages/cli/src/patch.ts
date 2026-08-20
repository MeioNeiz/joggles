#!/usr/bin/env bun
/**
 * Push a slot image to a crew unit over Bluetooth, and be able to do it again.
 *
 *   bun run patch status                  HELLO, capabilities, UPD_STATUS. Writes nothing
 *   bun run patch check <image>           validate the image locally. Sends nothing
 *   bun run patch send <image>            transfer every frame, never commit
 *   bun run patch commit <image> --yes    transfer, then UPD_END. This one makes it live
 *   bun run patch abort                   erase the inactive slot's header on purpose
 *
 * The client half of `notes/patch-over-bt.md`, which is the design and whose
 * "Sequencing" section is the bench procedure. The firmware that answers is
 * `research/tools/updater.ts`, driven offline through an ARMv6-M interpreter by
 * `research/tools/updater.test.ts`. **Nothing on either side has run on silicon**, so
 * every claim below is *derived*, and the first hardware session is what settles it.
 *
 * **No unit carries the resident half, so `status` answers "stock" everywhere.** As of
 * 2026-08-20 nothing has been written to any pair: `joggles-v2.bin` is unflashed, all
 * three pairs are stock, and there is no unit anywhere that would answer a HELLO or an
 * `UPD_STATUS` from this tool. Silence is therefore this tool's **normal** case rather
 * than its edge, and `send` refuses on it rather than treating it as a fault to work
 * around. **This file has never been pointed at hardware.** Everything it does was
 * exercised against a fake transport under `bun test` (`patch.test.ts`), which is a
 * model of the firmware written from the same document and so witnesses nothing about
 * silicon.
 *
 * The five subcommands are that procedure in order, least committal first, the same
 * shape `flash.ts` uses for the OTA path: `status` and `check` cannot change a unit,
 * `send` streams a whole slot and still cannot, and `commit` is the one write that
 * decides anything. What it decides is one word.
 *
 * ## Why this commit is not `flash commit`
 *
 * `flash commit` is barred outright and stays barred: it hands control to a bootloader
 * with no recovery entry point, which is what cost `GLASSES-12C3EF` on 2026-08-08. This
 * one programs the four-byte magic at the head of a slot in the OTA staging bank, which
 * is scratch. The live slot is untouched from the first frame to the last, no reset
 * happens, and the resident half owns HELLO and every `UPD_*` and dispatches them
 * before it consults a slot, so a slot that is wrong is replaced by sending another.
 *
 * **The OTA service is not merely unused here, it is unreachable.** The transport comes
 * from `NobleScanner`, which discovers only the four glasses channels and calls
 * `assertChannel` on every write, so nothing above it can address the flash-writing
 * service even by mistake. Nothing in this file imports `firmware.js`: the CRC comes
 * straight from `ota.js`, so the module that speaks the OTA control point is not in
 * this tool's reach at all. `patch.test.ts` crawls the source to keep that true.
 *
 * ## The one failure the device cannot catch, and where it is caught instead
 *
 * Slot code is assembled for a fixed slot base, so **an image built for slot A cannot be
 * programmed into slot B**. Its CRC is valid, its magic is valid, and it simply branches
 * somewhere absurd. `notes/patch-over-bt.md` names that as the one failure the design
 * does not catch on the device, so it has to be caught before a byte goes out.
 *
 * `Checked.verify` is that check. It reads the `ENTRY` word out of the image's own
 * `JGX1` header, which is an absolute Thumb address, and refuses unless it lands inside
 * the span the body will occupy in **the slot the unit just said it would write next**.
 * Two things make it unskippable rather than merely present:
 *
 *  - it is the only producer of a `Checked`, whose constructor is private, and
 *    `transfer()` accepts nothing else. Raw bytes do not typecheck.
 *  - the target it checks against comes only from a live `UPD_STATUS`. The device picks
 *    the slot, there is no flag to name one by hand, and there is no override flag
 *    anywhere in this file.
 *
 * A file with no `JGX1` header is refused for the same reason: with no `ENTRY` word
 * there is nothing to check the base against, and an unskippable check cannot have a
 * shape it declines to look at.
 *
 * ## Pacing, and why a retry is safe
 *
 * One 16-byte block per ATT write, `protocol.PACING_MS` between frames, and every frame
 * write-with-response so the link layer gives ordering and the reply gives flow control.
 * A frame past the declared length comes back `BAD_SEQ` at once rather than as a CRC
 * failure after 8 KB.
 *
 * The write address is derived from the sequence number and nothing else, so **a frame
 * sent twice is harmless**: programming a word to the value it already holds clears no
 * new bits. That is what makes a retry on silence sound, and it is the only reason this
 * file retries anything.
 */
import { type Transport, jgx, protocol as p, sleep as realSleep } from '@joggles/core'
// Not `firmware.js`, which would also put `dfu` and the OTA control point in reach.
// The firmware computes this same CRC-32 in about 30 bytes of Thumb, and it agrees with
// this function by construction (`notes/patch-over-bt.md`, "CRC-32 is ours").
import { crc32 } from '@joggles/core/src/ota.js'

// --- The slot geometry ---------------------------------------------------------------
//
// Copied from `research/tools/updater.ts`, which is the firmware that answers, and NOT
// imported from it: a CLI that pulled in the assembler to learn four numbers would drag
// the whole build path behind it. `patch.test.ts` reads those declarations out of the
// firmware source and fails if any of these drifts, which is the same trick
// `bankdump.ts` uses against `firmware-internals.md`.
//
// These belong in `core/src/jgx.ts` beside the `UPD_*` helpers, so client and firmware
// read one declaration. That file is owned elsewhere today.

export const SLOT_A = 0x29400
export const SLOT_SIZE = 0x2000
export const SLOT_B = SLOT_A + SLOT_SIZE
/** magic, gen, len, crc. The body starts after it. */
export const SLOT_HDR_LEN = 16
export const MAX_BODY = SLOT_SIZE - SLOT_HDR_LEN

/** Byte offsets in a `JGX1` block, from `research/tools/ext.ts`'s `HDR`. */
export const JGX_HDR = {
  MAGIC: 0x00,
  VERSION: 0x04,
  CAPABILITIES: 0x06,
  ENTRY: 0x08,
  SIZE: 0x0c,
  TABLE_COUNT: 0x10,
  TABLE: 0x14,
} as const

/** Only sub-commands at or above this reach a slot; below it is resident. */
export const SLOT_SUB_FLOOR = 0x10

export type SlotName = 'A' | 'B'

export const baseOf = (slot: SlotName): number => (slot === 'A' ? SLOT_A : SLOT_B)
export const other = (slot: SlotName): SlotName => (slot === 'A' ? 'B' : 'A')

const hex = (n: number) => `0x${(n >>> 0).toString(16)}`

/** Name a device result code from `jgx.UPD` rather than restating the table. */
export function updName(code: number): string {
  const hit = (Object.keys(jgx.UPD) as Array<keyof typeof jgx.UPD>).find(
    (k) => jgx.UPD[k] === code,
  )
  return hit ?? `unknown code ${code}`
}

// --- What a failure leaves behind ----------------------------------------------------

/**
 * Straight out of `notes/patch-over-bt.md`, "What every failure leaves behind".
 *
 * Transcribed rather than invented, and printed before a commit, because the reason
 * this path is affordable at all is that every row of it has a recovery and the design
 * argument is the only thing standing behind that.
 */
export const LEAVES_BEHIND: ReadonlyArray<{
  failure: string
  state: string
  recovery: string
}> = [
  {
    failure: 'power loss mid-UPD_DATA',
    state: 'inactive slot part written, magic erased',
    recovery: 'none needed. Live slot unchanged; resend',
  },
  {
    failure: 'power loss during the magic word',
    state: 'word holds extra 1 bits, so not the magic',
    recovery: 'as above',
  },
  {
    failure: 'bad CRC at UPD_END',
    state: 'magic never programmed',
    recovery: 'UPD_BEGIN again. Live slot unchanged',
  },
  {
    failure: 'slot code that crashes on entry',
    state: 'HardFault on a J frame that reaches the slot',
    recovery:
      'the weak point. HELLO and every UPD_* are resident and dispatched first, ' +
      'so the commands that replace the slot still answer',
  },
  {
    failure: 'both slots erased or invalid',
    state: 'resident-only: HELLO and UPD_* still answer',
    recovery: 'send a slot',
  },
  {
    failure: 'a vendor OTA stages over the slots',
    state: 'as above',
    recovery: 'send a slot',
  },
  {
    failure: 'a bug in the resident half',
    state: 'whatever the bug does',
    recovery: 'probe only',
  },
]

// --- The link ------------------------------------------------------------------------

/**
 * One request, one answer, and silence is an answer.
 *
 * The seam the tests inject at. `Glasses` keeps its notification waiters private and
 * exposes only `probe()`, so a driver that needs every `UPD_*` reply builds its own
 * over the same `Transport` rather than growing a second sequencer inside core.
 */
/** The only two kinds of answer this tool waits for. */
export type Want = 'hello' | 'update'

export interface PatchLink {
  readonly name: string
  /**
   * Write one frame on `9600` and wait for a reply **of the kind asked for**.
   *
   * Resolves null on timeout, which for HELLO is how a stock unit is identified and
   * everywhere else is a lost reply. `want` is not decoration: `MSG.BUTTON` is
   * unsolicited and shares the one notify characteristic, so a press during a
   * transfer would otherwise be taken as the answer to a frame.
   */
  ask(frame: Uint8Array, timeoutMs: number, want: Want): Promise<jgx.Notification | null>
}

export interface PatchDeps {
  link: PatchLink
  /** Injected so a 1,024-frame transfer runs under `bun test` without the wait. */
  sleep(ms: number): Promise<void>
  log(line: string): void
  /** Report only. A throw from here would abandon a transfer, so it is swallowed. */
  progress?(sent: number, total: number): void
}

/**
 * A link over a real connection.
 *
 * The waiter is registered before the write, as in `flash.ts`: a reply can beat the
 * `await` on a fast link, and a dropped one must not be waited for by the next ask.
 */
export async function openLink(
  transport: Transport,
  name: string,
  cipher: p.Cipher,
): Promise<PatchLink> {
  interface Waiter {
    want: Want
    settle: (msg: jgx.Notification | null) => void
  }
  const waiters: Waiter[] = []

  await transport.subscribe(p.CHAR_NOTIFY, (block) => {
    if (block.length !== p.BLOCK_SIZE) return
    // The vendor's own DATSOK/DATCPOK parse as null here and are left alone: this tool
    // never starts a DATS handshake, so anything of theirs on this channel is not ours.
    const msg = jgx.parseNotification(cipher.decrypt(block))
    if (!msg) return
    // By type, never by arrival order. A button press is unsolicited and would
    // otherwise be handed back as the answer to whichever frame was in flight.
    const at = waiters.findIndex((w) => w.want === msg.type)
    if (at < 0) return
    waiters.splice(at, 1)[0].settle(msg)
  })

  return {
    name,
    async ask(frame, timeoutMs, want) {
      let waiter: Waiter
      const answer = new Promise<jgx.Notification | null>((resolve) => {
        const timer = setTimeout(() => {
          const at = waiters.indexOf(waiter)
          if (at >= 0) waiters.splice(at, 1)
          resolve(null)
        }, timeoutMs)
        waiter = {
          want,
          settle: (msg) => {
            clearTimeout(timer)
            resolve(msg)
          },
        }
        waiters.push(waiter)
      })
      await transport.write(p.CHAR_COMMAND, cipher.encrypt(frame), true)
      return answer
    },
  }
}

// --- What the unit is ----------------------------------------------------------------

export interface SlotState {
  live: SlotName | null
  generation: number
  /** Where the next `UPD_BEGIN` will write. The device's choice, not ours. */
  next: SlotName
  nextBase: number
  nextGeneration: number
  /**
   * Whether `next` is what the device SAID, or what we inferred by inverting the live
   * slot.
   *
   * It matters because an inferred target is exactly the route into the one failure the
   * firmware cannot catch: a body built for the wrong base has a valid CRC and valid
   * magic and branches into nothing. `UPD_STATUS` now names the target in a seventh
   * payload byte, so `verify` requires it and refuses to check against a guess.
   */
  targetFromDevice: boolean
}

export type UnitState =
  | { kind: 'stock' }
  | {
      kind: 'crew'
      version: number
      capabilities: number
      canUpdate: boolean
      slots: SlotState | null
      /** Why there is no slot state, when the unit should have given one. */
      slotsProblem?: string
    }

/** Timeouts, and the one that is a design decision rather than a guess. */
export const TIMEOUT = {
  /**
   * HELLO. Short on purpose: silence is the answer for a stock unit, so this is how
   * long we are prepared to wait to be told nothing. Matches `Glasses.probe`.
   */
  hello: 1500,
  status: 2000,
  /** 16 page erases back to back, each stalling instruction fetch for a few ms. */
  begin: 5000,
  data: 2000,
  /** CRC-32 over 8 KB in software, then one word programmed. */
  end: 5000,
  abort: 5000,
} as const

/** How many times a frame whose reply never came is sent again. */
export const RETRIES = 2

/** Read the slot state out of an `UPD_STATUS` reply. */
export function slotsFrom(reply: jgx.UpdReply): {
  slots?: SlotState
  problem?: string
} {
  if (!reply.status) {
    return {
      problem:
        'the unit answered UPD_STATUS without the slot state. Its resident half is ' +
        'older than this tool: nothing here can tell which slot it would write',
    }
  }
  const { liveIsB, generation } = reply.status
  if (reply.code === jgx.UPD.NO_SLOT) {
    // Neither slot validates, so the unit is running resident-only code. `target_slot`
    // answers A when nothing is live, and its generation is the live one plus 1.
    return {
      slots: {
        live: null,
        generation: 0,
        next: reply.status.target === 'b' ? 'B' : 'A',
        nextBase: reply.status.target === 'b' ? baseOf('B') : SLOT_A,
        nextGeneration: 1,
        targetFromDevice: reply.status.target !== undefined,
      },
    }
  }
  if (reply.code !== jgx.UPD.OK) {
    return { problem: `UPD_STATUS answered ${updName(reply.code)}` }
  }
  if (generation === 0) {
    return {
      problem:
        'UPD_STATUS reports a live slot at generation 0, which is reserved and never ' +
        'written. Something disagrees about the slot header',
    }
  }
  const live: SlotName = liveIsB ? 'B' : 'A'
  // The device's own word, when it gives one. Inverting `live` is only a fallback, and
  // `verify` will not act on it: see `SlotState.targetFromDevice`.
  const said = reply.status.target
  const next: SlotName = said ? (said === 'b' ? 'B' : 'A') : other(live)
  return {
    slots: {
      live,
      generation,
      next,
      nextBase: baseOf(next),
      nextGeneration: generation + 1,
      targetFromDevice: said !== undefined,
    },
  }
}

/**
 * HELLO, then `UPD_STATUS` if the unit says it can be updated. Writes nothing.
 *
 * A stock unit is silence, and that is a result rather than a failure. It is also what
 * a crew unit looks like under the wrong key, which for this tool matters more than it
 * does for `bun cli probe`: every unit it talks to is one of ours.
 */
export async function readUnit(deps: PatchDeps): Promise<UnitState> {
  const hello = await deps.link.ask(jgx.hello(), TIMEOUT.hello, 'hello')
  if (hello?.type !== 'hello') return { kind: 'stock' }

  const canUpdate = jgx.supports(hello.capabilities, jgx.CAP.UPDATE)
  const base = {
    kind: 'crew' as const,
    version: hello.version,
    capabilities: hello.capabilities,
    canUpdate,
  }
  if (!canUpdate) return { ...base, slots: null }

  const reply = await deps.link.ask(jgx.updStatus(), TIMEOUT.status, 'update')
  if (!reply) {
    return { ...base, slots: null, slotsProblem: 'no answer to UPD_STATUS' }
  }
  if (reply.type !== 'update') {
    return { ...base, slots: null, slotsProblem: `answered a ${reply.type} frame` }
  }
  const { slots, problem } = slotsFrom(reply)
  return { ...base, slots: slots ?? null, slotsProblem: problem }
}

// --- Checking an image, which is the gate --------------------------------------------

export interface Inspection {
  bytes: number
  crc: number
  frames: number
  /** Absolute Thumb address of the trampoline, as the image's own header states it. */
  entry: number
  version: number
  capabilities: number
  /** What the header says its own size is, which need not be the file's. */
  headerSize: number
  /** The slot whose body span contains `entry`, if either does. */
  builtFor: SlotName | null
  /** Sub-command ids with a handler. Only 0x10 and up are ever reached in a slot. */
  handlers: number[]
  /** Fatal. Anything in here and nothing is sent. */
  problems: string[]
  /** Worth saying out loud, but not a refusal. */
  notes: string[]
}

const ascii = (b: Uint8Array) =>
  [...b].map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.')).join('')

/**
 * Everything about a slot image that can be decided with no device attached.
 *
 * Size against the slot bound, the CRC the firmware will compute, and the base the
 * image was assembled for. It reports; `verify()` is what refuses.
 */
export function inspect(body: Uint8Array): Inspection {
  const problems: string[] = []
  const notes: string[] = []
  const bytes = body.length
  const out: Inspection = {
    bytes,
    crc: crc32(body),
    frames: bytes ? jgx.updFrames(bytes) : 0,
    entry: 0,
    version: 0,
    capabilities: 0,
    headerSize: 0,
    builtFor: null,
    handlers: [],
    problems,
    notes,
  }

  if (bytes === 0) {
    problems.push('the file is empty')
    return out
  }
  if (bytes > MAX_BODY) {
    problems.push(`${bytes} bytes is past the ${MAX_BODY} a slot body holds`)
  }
  if (bytes < JGX_HDR.TABLE) {
    problems.push(
      `${bytes} bytes is too short to hold a JGX1 header, so there is no ENTRY word ` +
        'and the slot base it was built for cannot be checked',
    )
    return out
  }

  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const magic = ascii(body.subarray(0, 4))
  if (magic !== jgx.MAGIC) {
    problems.push(
      `it starts ${JSON.stringify(magic)}, not ${jgx.MAGIC}. A slot body is a JGX1 ` +
        'block, and without its ENTRY word the slot base cannot be checked',
    )
    return out
  }

  out.version = dv.getUint16(JGX_HDR.VERSION, true)
  out.capabilities = dv.getUint16(JGX_HDR.CAPABILITIES, true)
  out.entry = dv.getUint32(JGX_HDR.ENTRY, true)
  out.headerSize = dv.getUint32(JGX_HDR.SIZE, true)

  // The entry is a Thumb address, so bit 0 is set and is not part of it.
  const entry = out.entry & ~1
  for (const slot of ['A', 'B'] as SlotName[]) {
    const from = baseOf(slot) + SLOT_HDR_LEN
    if (entry >= from && entry < from + bytes) out.builtFor = slot
  }
  if (out.builtFor === null) {
    const resident =
      entry < SLOT_A
        ? '. That is below slot A, so this looks like a resident image, which only a ' +
          'probe can write (`bun run flash` is not it either: see notes/swd-flashing.md)'
        : ''
    problems.push(
      `its ENTRY is ${hex(out.entry)}, which is inside neither slot body ` +
        `(${hex(SLOT_A + SLOT_HDR_LEN)} or ${hex(SLOT_B + SLOT_HDR_LEN)}, ` +
        `${bytes} bytes each)${resident}`,
    )
  }

  if (out.headerSize > bytes) {
    problems.push(
      `its header says ${out.headerSize} bytes and the file is ${bytes}, so the file ` +
        'is truncated',
    )
  } else if (out.headerSize !== bytes) {
    notes.push(`header says ${out.headerSize} bytes, file is ${bytes}: padded tail`)
  }

  const count = dv.getUint16(JGX_HDR.TABLE_COUNT, true)
  if (JGX_HDR.TABLE + count * 2 > bytes) {
    problems.push(
      `its sub-command table claims ${count} entries, which runs past the end of the ` +
        'file',
    )
    return out
  }
  for (let i = 0; i < count; i++) {
    if (dv.getUint16(JGX_HDR.TABLE + i * 2, true) !== 0) out.handlers.push(i)
  }
  const reachable = out.handlers.filter((id) => id >= SLOT_SUB_FLOOR)
  const shadowed = out.handlers.filter((id) => id < SLOT_SUB_FLOOR)
  if (shadowed.length) {
    notes.push(
      `sub-commands ${shadowed.map(hex).join(', ')} have handlers that will never be ` +
        'reached: the resident half answers everything below ' +
        `${hex(SLOT_SUB_FLOOR)} itself`,
    )
  }
  if (!reachable.length) {
    notes.push(
      'no handler at or above ' +
        `${hex(SLOT_SUB_FLOOR)}, so this slot answers nothing. That is a legitimate ` +
        'way to retire a slot, and a mistake otherwise',
    )
  }
  if (jgx.supports(out.capabilities, jgx.CAP.UPDATE)) {
    notes.push(
      'it declares the UPDATE capability, which is the resident half\'s to declare. ' +
        'HELLO reports the resident bitmap, so this claim goes nowhere',
    )
  }
  return out
}

/**
 * A slot image that has been checked against the slot the unit said it would write.
 *
 * `transfer()` takes one of these and nothing else, and the constructor is private, so
 * there is no way to hold one without going through `Checked.verify`. That is the whole
 * mechanism: the wrong-slot-base check cannot be skipped because there is no route to
 * the wire that does not carry its output.
 */
export class Checked {
  private constructor(
    readonly body: Uint8Array,
    readonly crc: number,
    readonly frames: number,
    readonly target: SlotName,
    readonly targetBase: number,
    readonly generation: number,
    readonly inspection: Inspection,
  ) {}

  /**
   * The gate. Throws unless this image is safe to put in *this* unit's next slot.
   *
   * The target is the device's own answer to `UPD_STATUS`, never an argument a person
   * chose, because the device picks the slot from the two generations and the phone
   * cannot influence it. An image built for the other slot has a valid CRC and a valid
   * magic and branches somewhere absurd, and nothing in the firmware can tell.
   */
  static verify(body: Uint8Array, slots: SlotState): Checked {
    const found = inspect(body)
    if (found.problems.length) {
      throw new Error(`refusing this image: ${found.problems.join('; ')}`)
    }
    if (!slots.targetFromDevice) {
      throw new Error(
        'this unit did not say which slot it will write next, so the target here was ' +
          'inferred by inverting the live slot. That inference is the one route into ' +
          'the failure the firmware cannot catch, so it is not good enough to check ' +
          'against. Its resident half predates the seventh UPD_STATUS byte and needs ' +
          'reflashing over SWD before anything is sent to it',
      )
    }
    if (found.builtFor !== slots.next) {
      throw new Error(
        `this image was built for slot ${found.builtFor} at ` +
          `${hex(baseOf(found.builtFor!))}, and the unit says its next write goes to ` +
          `slot ${slots.next} at ${hex(slots.nextBase)}. Slot code is ` +
          'position-dependent, so those bytes would validate, go live and branch into ' +
          `nothing. Rebuild for ${hex(slots.nextBase)} and ask again: the answer moves ` +
          'every time a slot goes live',
      )
    }
    return new Checked(
      body,
      found.crc,
      found.frames,
      slots.next,
      slots.nextBase,
      slots.nextGeneration,
      found,
    )
  }
}

// --- The transfer --------------------------------------------------------------------

export interface TransferOptions {
  /** Stop after this many frames on purpose. The interrupted-transfer drill. */
  stopAfter?: number
  /** Declare a CRC that cannot match, so `UPD_END` refuses. The corrupt-slot drill. */
  badCrc?: boolean
  /** After the last frame, send one past the declared length. Expects `BAD_SEQ`. */
  overrun?: boolean
  /**
   * Skip `UPD_BEGIN` and start here, after a run of THIS image was interrupted.
   *
   * Sound because the interrupted slot never went live, so the device still picks it,
   * and its header still holds the length and CRC the first `UPD_BEGIN` programmed. If
   * that header belongs to some other image the body will not match it and `UPD_END`
   * answers `BAD_CRC`, which costs a transfer and nothing else.
   */
  resumeFrom?: number
  pacingMs?: number
}

export interface TransferResult {
  /** `transferred` is the only one a commit may follow. */
  status: 'transferred' | 'stopped' | 'refused' | 'silent'
  framesSent: number
  frames: number
  /** The device's code, when it gave one. */
  code?: number
  /** What the deliberate overrun frame answered, if one was sent. */
  overrunCode?: number
  /** What this outcome leaves on the unit, in words. */
  leaves: string
}

const LIVE_UNTOUCHED =
  'the magic was never programmed, so the live slot is untouched and this slot ' +
  'cannot validate. Send it again, or run abort'

/**
 * `UPD_BEGIN`, then every frame in order, and never `UPD_END`.
 *
 * So an abort at any point, deliberate or not, leaves a slot whose magic never landed:
 * not a state to recover from, which is the property the whole design is built around.
 * Ctrl-C included, and there is deliberately no signal handler that sends anything on
 * the way out: the state a stop leaves behind is already the safe one, and a write
 * during teardown would be a write nobody asked for. `abort` is a subcommand for when
 * somebody does want the half-written slot made unusable on purpose.
 */
export async function transfer(
  deps: PatchDeps,
  checked: Checked,
  opts: TransferOptions = {},
): Promise<TransferResult> {
  const pacing = opts.pacingMs ?? p.PACING_MS
  const { body, frames } = checked
  const crc = opts.badCrc ? (checked.crc ^ 0xffffffff) >>> 0 : checked.crc
  const limit = Math.min(opts.stopAfter ?? frames, frames)
  const first = opts.resumeFrom ?? 0

  if (opts.resumeFrom === undefined) {
    const begun = await deps.link.ask(
      jgx.updBegin(body.length, crc),
      TIMEOUT.begin,
      'update',
    )
    if (!begun || begun.type !== 'update') {
      return {
        status: 'silent',
        framesSent: 0,
        frames,
        leaves:
          'no answer to UPD_BEGIN. The target slot may be part erased, and ' +
          LIVE_UNTOUCHED,
      }
    }
    if (begun.code !== jgx.UPD.OK) {
      return {
        status: 'refused',
        framesSent: 0,
        frames,
        code: begun.code,
        leaves:
          begun.code === jgx.UPD.BAD_LENGTH
            ? 'nothing: a bad length is refused before any erase'
            : LIVE_UNTOUCHED,
      }
    }
    deps.log(
      `UPD_BEGIN ok: ${body.length} bytes, crc ${hex(crc)}` +
        (opts.badCrc ? ' (DRILL: deliberately wrong)' : ''),
    )
  } else {
    deps.log(`resuming at frame ${first}, so no UPD_BEGIN and no erase`)
  }

  deps.progress?.(first, frames)
  for (let seq = first; seq < limit; seq++) {
    const block = body.subarray(seq * jgx.UPD_DATA_BYTES, (seq + 1) * jgx.UPD_DATA_BYTES)
    const frame = jgx.updData(seq, block)

    let reply: jgx.Notification | null = null
    for (let attempt = 0; attempt <= RETRIES && !reply; attempt++) {
      if (attempt) deps.log(`frame ${seq}: no reply, sending it again`)
      // Safe to repeat: the address comes from the sequence number, so the same frame
      // twice programs the same words and clears no new bits.
      reply = await deps.link.ask(frame, TIMEOUT.data, 'update')
    }
    if (!reply || reply.type !== 'update') {
      return {
        status: 'silent',
        framesSent: seq - first,
        frames,
        leaves: `frame ${seq} went unanswered ${RETRIES + 1} times, so ` + LIVE_UNTOUCHED,
      }
    }
    if (reply.code !== jgx.UPD.OK) {
      return {
        status: 'refused',
        framesSent: seq - first,
        frames,
        code: reply.code,
        leaves: LIVE_UNTOUCHED,
      }
    }
    try {
      deps.progress?.(seq + 1, frames)
    } catch {
      // Report only. A throw from a progress line must not abandon a transfer.
    }
    await deps.sleep(pacing)
  }

  let overrunCode: number | undefined
  if (opts.overrun) {
    const past = await deps.link.ask(
      jgx.updData(frames, new Uint8Array(0)),
      TIMEOUT.data,
      'update',
    )
    overrunCode = past?.type === 'update' ? past.code : undefined
    deps.log(
      `DRILL: frame ${frames} is past the declared length and answered ` +
        (overrunCode === undefined ? 'nothing' : updName(overrunCode)),
    )
  }

  if (limit < frames) {
    return {
      status: 'stopped',
      framesSent: limit - first,
      frames,
      overrunCode,
      leaves: `stopped at frame ${limit} of ${frames} on purpose, so ` + LIVE_UNTOUCHED,
    }
  }
  return {
    status: 'transferred',
    framesSent: limit - first,
    frames,
    overrunCode,
    leaves:
      'every frame is in the slot and the magic is not, so nothing has changed on ' +
      'the unit yet. Commit, or walk away',
  }
}

export interface CommitResult {
  status: 'live' | 'refused' | 'silent'
  code?: number
  /** Read back after a lost reply, because a commit is one word and worth resolving. */
  after?: SlotState | null
  leaves: string
}

/**
 * `UPD_END`: the CRC and, only if it agrees, the magic word. The whole commit.
 *
 * It takes the transfer's own result and refuses unless it completed, which is the
 * `flash.ts` rule (never commit a partial transfer) made structural rather than checked
 * at the call site.
 */
export async function commitSlot(
  deps: PatchDeps,
  checked: Checked,
  transferred: TransferResult,
): Promise<CommitResult> {
  if (transferred.status !== 'transferred') {
    throw new Error(
      `refusing to commit after a transfer that ${transferred.status}: ` +
        `${transferred.framesSent} of ${transferred.frames} frames went out`,
    )
  }
  const reply = await deps.link.ask(jgx.updEnd(), TIMEOUT.end, 'update')
  if (!reply || reply.type !== 'update') {
    // A commit is one word, so silence here is genuinely ambiguous and worth resolving
    // rather than reporting. The generation is the answer.
    const unit = await readUnit(deps)
    const after = unit.kind === 'crew' ? unit.slots : null
    return {
      status: 'silent',
      after,
      leaves:
        'no answer to UPD_END. UPD_STATUS now says ' +
        (after
          ? `slot ${after.live ?? 'none'} at generation ${after.generation}: ` +
            (after.live === checked.target && after.generation === checked.generation
              ? 'the commit landed and only the reply was lost'
              : 'the commit did not land, and the live slot is untouched')
          : 'nothing readable, so run status before deciding anything'),
    }
  }
  if (reply.code !== jgx.UPD.OK) {
    return {
      status: 'refused',
      code: reply.code,
      leaves:
        reply.code === jgx.UPD.BAD_CRC
          ? 'the body did not match the CRC UPD_BEGIN declared, so the magic was ' +
            'never programmed. The live slot is still running. Send it again'
          : LIVE_UNTOUCHED,
    }
  }
  return {
    status: 'live',
    leaves:
      `slot ${checked.target} is live at generation ${checked.generation}. The other ` +
      'slot still holds the previous one, which is what the next update replaces',
  }
}

/**
 * `UPD_ABORT`: erase the inactive slot's first page so its header can never validate.
 *
 * Reachable at any point and needed at none of them. An interrupted transfer is already
 * a slot that cannot validate, so this is for making that visible on purpose rather
 * than for recovering from anything.
 */
export async function abort(deps: PatchDeps): Promise<{ code: number | null }> {
  const reply = await deps.link.ask(jgx.updAbort(), TIMEOUT.abort, 'update')
  if (!reply || reply.type !== 'update') return { code: null }
  return { code: reply.code }
}

// --- The command line ----------------------------------------------------------------

const CREW_KEY_FILE = 'firmware/crew-key.json'
const COMMANDS = ['status', 'check', 'send', 'commit', 'abort'] as const

function usage(log: (line: string) => void): void {
  log('usage: bun run patch <status|check|send|commit|abort> [image] [flags]')
  log('  status                     HELLO, capabilities, UPD_STATUS. Writes nothing')
  log('  check <image>              validate locally. Sends nothing, needs no unit')
  log('  send <image>               transfer every frame, never commit')
  log('  commit <image> --yes       transfer, then UPD_END. Makes the slot live')
  log('  abort                      erase the inactive slot header on purpose')
  log('')
  log('  --stop-after n             DRILL: stop mid-transfer on purpose')
  log('  --bad-crc                  DRILL: declare a CRC that cannot match')
  log('  --overrun                  DRILL: one frame past the length. Expects BAD_SEQ')
  log('  --resume n                 skip UPD_BEGIN, start at frame n')
  log('  --timeout ms               how long to look for a unit')
  log('  --pacing ms                between frames. Default protocol.PACING_MS')
}

/** The group key our firmware carries. Without it a crew unit looks exactly stock. */
async function crewKey(): Promise<Uint8Array | null> {
  const file = Bun.file(CREW_KEY_FILE)
  if (!(await file.exists())) return null
  const hex = String((await file.json()).key)
  return new Uint8Array((hex.match(/../g) ?? []).map((b) => parseInt(b, 16)))
}

/**
 * Connect and build a link.
 *
 * `noble` is imported here rather than at the top of the file so `check` runs with no
 * adapter, no permission prompt and no Bluetooth stack initialised, and so
 * `patch.test.ts` never loads a native module.
 */
async function connect(
  timeoutMs: number,
  log: (line: string) => void,
): Promise<{ link: PatchLink; close: () => Promise<void> }> {
  const key = await crewKey()
  log(key ? `crew key from ${CREW_KEY_FILE}` : `no ${CREW_KEY_FILE}: vendor key only`)

  const { NobleScanner } = await import('./noble.js')
  const scanner = new NobleScanner()
  const unit = await scanner.first([p.CREW_NAME_PREFIX, p.NAME_PREFIX], timeoutMs)
  const transport = await scanner.connect(unit.id)
  const cipher =
    key && unit.name.startsWith(p.CREW_NAME_PREFIX) ? p.cipher(key) : p.vendor
  log(`found  ${unit.name}`)
  return {
    link: await openLink(transport, unit.name, cipher),
    close: () => transport.disconnect().catch(() => {}),
  }
}

function printUnit(unit: UnitState, log: (line: string) => void): void {
  if (unit.kind === 'stock') {
    log('firmware   stock: no answer to HELLO')
    log('           Expected. No pair has been flashed, so every unit in existence')
    log('           answers this today and there is nothing here to update yet.')
    log('           It is also what a crew unit looks like under the wrong key, so')
    log('           if you believe this one carries the extension, check the key.')
    return
  }
  log(`firmware   JGX1 extension v${unit.version}`)
  log(`capable of ${jgx.capabilityNames(unit.capabilities).join(', ') || 'nothing'}`)
  if (!unit.canUpdate) {
    log('slots      the unit does not declare UPDATE, so it has no resident updater')
    return
  }
  if (!unit.slots) {
    log(`slots      unreadable: ${unit.slotsProblem ?? 'no reason given'}`)
    return
  }
  const s = unit.slots
  log(
    `slots      live ${s.live ?? 'none'}` +
      (s.live ? ` at generation ${s.generation}` : ' (resident-only)'),
  )
  log(`next       slot ${s.next} at ${hex(s.nextBase)}, generation ${s.nextGeneration}`)
}

function printInspection(found: Inspection, log: (line: string) => void): void {
  log(`bytes      ${found.bytes} of ${MAX_BODY}`)
  log(`crc32      ${hex(found.crc)}`)
  log(`frames     ${found.frames} UPD_DATA at ${jgx.UPD_DATA_BYTES} bytes each`)
  if (found.entry) {
    log(`version    ${found.version}`)
    log(`entry      ${hex(found.entry)}`)
    log(`handlers   ${found.handlers.map(hex).join(', ') || 'none'}`)
  }
  const where = found.builtFor
    ? `slot ${found.builtFor} at ${hex(baseOf(found.builtFor))}`
    : 'nothing recognisable'
  log(`built for  ${where}`)
  for (const note of found.notes) log(`note       ${note}`)
  for (const problem of found.problems) log(`PROBLEM    ${problem}`)
}

function printLeavesBehind(log: (line: string) => void): void {
  log('What each failure would leave behind (notes/patch-over-bt.md):')
  for (const row of LEAVES_BEHIND) {
    log(`  ${row.failure}`)
    log(`      leaves   ${row.state}`)
    log(`      recovery ${row.recovery}`)
  }
}

/**
 * The whole command line, returning an exit code rather than calling `process.exit`,
 * so `bun cli patch` can host it and a test can drive it.
 */
export async function runCli(argv: string[]): Promise<number> {
  const log = (line: string) => console.log(line)
  const TAKES_VALUE = new Set(['stop-after', 'resume', 'timeout', 'pacing'])
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const positional: string[] = []
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

  if (!cmd || !(COMMANDS as readonly string[]).includes(cmd)) {
    usage(log)
    return 2
  }
  if (['check', 'send', 'commit'].includes(cmd) && !imagePath) {
    console.error(`${cmd} needs a slot image path`)
    return 2
  }

  // Everything decidable with no radio is decided first, so a bad invocation never
  // reaches a connected unit.
  const body =
    imagePath === undefined
      ? null
      : new Uint8Array(await Bun.file(imagePath).arrayBuffer())

  if (cmd === 'check') {
    log(`image      ${imagePath}`)
    const found = inspect(body!)
    printInspection(found, log)
    log('')
    if (found.problems.length) {
      console.error('this image cannot be sent to any unit as it stands')
      return 1
    }
    log(`Sendable only while the unit's next slot is ${found.builtFor}.`)
    log('Run status against the unit first: that answer changes every time a slot goes')
    log('live, and an image built for the other one branches into nothing.')
    log('Nothing was sent and no unit was touched.')
    return 0
  }

  // Half the gate runs here, before the radio: an image that could not be sent to any
  // unit is refused without spending a connection. The other half needs the device's
  // answer and is `Checked.verify` below.
  if (body && (cmd === 'send' || cmd === 'commit')) {
    const found = inspect(body)
    if (found.problems.length) {
      log(`image      ${imagePath}`)
      printInspection(found, log)
      console.error('\nrefusing to send an image with problems. Nothing was connected.')
      return 1
    }
  }

  if (cmd === 'commit' && !flags.has('yes')) {
    console.error('commit programs the magic word, which is what makes a slot live.')
    console.error('Re-run with --yes. Nothing here hands control to the bootloader and')
    console.error('the live slot is untouched until that one word lands, which is why')
    console.error('this is a --yes and not the bar on `bun run flash commit`.')
    return 2
  }

  const timeout = num('timeout', 20000)
  const { link, close } = await connect(timeout, log)
  const deps: PatchDeps = {
    link,
    sleep: realSleep,
    log,
    progress: (sent, total) => {
      if (total) process.stdout.write(`\r  ${sent}/${total} frames`)
      if (sent === total) process.stdout.write('\n')
    },
  }

  try {
    log('')
    const unit = await readUnit(deps)
    printUnit(unit, log)

    if (cmd === 'status') {
      log('')
      log('Wrote nothing. This is the zero-risk check that the resident half answers,')
      log('and until a unit has been flashed over SWD the honest answer is stock.')
      return 0
    }
    if (cmd === 'abort') {
      const { code } = await abort(deps)
      log('')
      log(
        code === null
          ? 'no answer to UPD_ABORT'
          : `UPD_ABORT answered ${updName(code)}: the inactive slot's first page is ` +
              'erased, so its header can never validate. The live slot is untouched.',
      )
      return code === jgx.UPD.OK ? 0 : 1
    }

    if (unit.kind === 'stock') {
      console.error('\nrefusing to send: this unit answers no HELLO, which is what every')
      console.error('pair answers today. A slot needs the resident half already on the')
      console.error('unit, and that goes on over SWD, once, with the probe attached:')
      console.error('notes/patch-over-bt.md, sequencing step 3. Nothing over Bluetooth')
      console.error('can put it there, and that is deliberate.')
      return 1
    }
    if (!unit.canUpdate || !unit.slots) {
      console.error('\nrefusing to send: no readable slot state, so nothing here knows')
      console.error('which slot the unit would write, and that is the one thing the')
      console.error('device cannot check for itself.')
      return 1
    }

    let checked: Checked
    try {
      checked = Checked.verify(body!, unit.slots)
    } catch (err) {
      console.error(`\n${(err as Error).message}`)
      return 1
    }
    log('')
    printInspection(checked.inspection, log)
    log(
      `target     slot ${checked.target} at ${hex(checked.targetBase)}, ` +
        `generation ${checked.generation}`,
    )

    if (cmd === 'commit') {
      log('')
      printLeavesBehind(log)
      log('')
      log('Nothing on this path has run on silicon. Charge the unit and stay in range.')
    }

    log('')
    const opts: TransferOptions = {
      stopAfter: values.has('stop-after') ? num('stop-after', 0) : undefined,
      resumeFrom: values.has('resume') ? num('resume', 0) : undefined,
      pacingMs: values.has('pacing') ? num('pacing', p.PACING_MS) : undefined,
      badCrc: flags.has('bad-crc'),
      overrun: flags.has('overrun'),
    }
    const sent = await transfer(deps, checked, opts)
    log(`transfer   ${sent.status}, ${sent.framesSent} frames`)
    if (sent.code !== undefined) log(`           ${updName(sent.code)}`)
    log(`           ${sent.leaves}`)

    if (cmd === 'send') {
      log('')
      log('No UPD_END was sent, so the magic never landed and the live slot is as it')
      log('was. Run status: the generation should not have moved.')
      return sent.status === 'transferred' || sent.status === 'stopped' ? 0 : 1
    }
    if (sent.status !== 'transferred') {
      console.error('\nnot committing after a transfer that did not complete.')
      return 1
    }

    const done = await commitSlot(deps, checked, sent)
    log('')
    const why = done.code === undefined ? '' : `, ${updName(done.code)}`
    log(`commit     ${done.status}${why}`)
    log(`           ${done.leaves}`)
    return done.status === 'live' ? 0 : 1
  } finally {
    await close()
  }
}

if (import.meta.main) {
  try {
    const code = await runCli(process.argv.slice(2))
    // noble keeps the process alive on macOS once the adapter has been used.
    process.exit(code)
  } catch (err) {
    console.error('\nerror:', (err as Error).message)
    console.error('No UPD_END goes out on this path unless it is asked for, so an abort')
    console.error('here leaves a slot whose magic never landed, live slot untouched.')
    process.exit(1)
  }
}
