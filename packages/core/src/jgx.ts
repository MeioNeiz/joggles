/**
 * The `JGX1` firmware extension, client side.
 *
 * Stock firmware handles eleven opcodes and can say exactly three things back:
 * `DATSOK`, `DATCPOK`, `ERROR`. Our firmware adds one opcode, `J`, whose first
 * payload byte is a sub-command id, and one structured notification frame. Every
 * feature after that is a new sub-command and a new message type, which is what
 * lets the firmware grow without touching the vendor's code again.
 *
 * This module is the wire format and nothing else, so it stays in `core` with no
 * dependencies. The firmware that answers it is built by `research/tools/ext.ts`,
 * which imports the constants below rather than restating them, so the two cannot
 * drift apart.
 *
 * ## What is settled and what is not
 *
 * **No unit carries this extension.** Nothing has been flashed, so every crew unit
 * below is hypothetical and `bun cli probe` answers stock on every pair here.
 *
 * `HELLO` and the five `UPD_*` sub-commands are built: they are the **resident**
 * half, the part only a probe can rewrite (`notes/patch-over-bt.md`), and they have
 * run against an ARMv6-M interpreter and a model of this FMC, which is not silicon.
 * Everything from `TICK` down is a **slot** feature, and every field in it is
 * *derived*: the layouts are chosen against a hand-decoded image and the firmware
 * that answers them is not written yet. The ranked patches those sub-commands serve
 * are `notes/what-to-build.md`, "Firmware patches, ranked".
 *
 * ## Talking to a mixed fleet
 *
 * At a festival the app meets stock units, crew units at v1 and, later, crew units
 * at v2. So it probes rather than assumes. A stock unit does not recognise `J`, the
 * dispatcher falls through to no-match, and nothing is sent back at all: silence is
 * how stock is identified. A crew unit answers HELLO with its version and a
 * capability bitmap, so a v1 app can talk safely to a v2 unit and the reverse.
 *
 * **A family bit does not imply its feature bits, and nothing may gate on one.**
 * `CAP.INPUT` cannot say whether this unit has the button back-channel, the battery
 * reading or both, so every sub-command added after v1 has its own bit, `SUB_CAP`
 * maps each one to the bit that licenses it, and `permits()` is the only question a
 * caller asks before sending. `permits()` never consults a family bit.
 *
 * What a family bit is for, then, is **a summary and a consistency check, not a
 * claim**: a unit sets it exactly when it carries at least one member of that
 * family, so it says something an app could already work out and is there for
 * `bun cli probe` to print. `capabilityProblems()` is that rule with teeth, in both
 * directions: a family bit standing alone is a unit claiming a family with nothing
 * in it, and a feature bit without its family bit is a build that forgot half of
 * what it advertises. Neither is a reason to stop talking to the unit, and both are
 * a reason to fix the firmware that sent it.
 *
 * Both mixed-fleet directions fall out of that:
 *
 *  - **new unit, old app.** The old app sends only `HELLO` and `UPD_*`, which are
 *    resident and answered by every crew unit. The extra capability bits it does
 *    not know are filtered out by `capabilityNames`, and a HELLO reply that grew
 *    trailing fields is still parsed, because `parseNotification` reads by `len`
 *    and ignores the tail.
 *  - **new app, old unit.** The feature bits are clear, `permits()` refuses, and
 *    the app degrades to what the unit advertised. Capabilities are per connection
 *    and must not be cached across one: a vendor OTA wipes both slots and a unit
 *    that had features comes back with only the resident ones.
 *
 * ## Two ceilings, and what they cost
 *
 * **A command body is 15 bytes**, so a sub-command has 13 payload bytes after the
 * opcode and the sub-command id. That is what shapes `TILE_DEF` (4 palette entries
 * a frame, so the palette is not atomic) and `TILE_FRAME` (24 columns as nibbles,
 * which is the only way a whole panel fits in one write). It is the same ceiling
 * that killed `SETNAME`, where 14 bytes of name left room for nothing else
 * (`notes/what-to-build.md`, "Renaming, build time and run time").
 *
 * **A notification payload is 15 bytes**, and the consequence worth naming is what
 * the HELLO reply cannot carry: a per-feature version. There is room for one bit
 * per feature and nothing more, so **a feature's wire format can never change**.
 * A revision is a new sub-command id and a new bit, never a second meaning for an
 * existing one.
 *
 * ## Rules a new sub-command must not break
 *
 *  - **Send on `9600` and nowhere else.** `CHANNEL` is the only answer. A *stock*
 *    unit's `960b` handler routes by wire length, and both routes are bad: 6 to 20
 *    bytes reaches the rhythm arm and draws garbage bars, 4 to 5 reaches the single
 *    column store and writes a garbage column (`core/src/rhythm.ts`). Every frame
 *    here is one or the other, so a `J` frame on `960b` makes a stock unit react
 *    visibly, and silence on stock is the whole identification story.
 *  - **Pad to `MIN_BODY`.** The dispatcher's length gate is 4 to 20 inclusive and
 *    runs before the opcode compare, so a 2-byte or 3-byte frame is dropped in
 *    silence and reads on the wire as a stock unit. `subFrame` pads for you.
 *  - **Route replies by message type, never by arrival order.** `MSG.BUTTON` is
 *    unsolicited: it can land between any command and its reply, and it shares the
 *    one notify characteristic with `DATSOK` because the sender's handle is
 *    hardcoded.
 *  - **Nothing may disable the 2 second hold.** It is the only power switch. No
 *    `BTN` flag means "suppress the hold", `BTN_FLAGS` refuses any bit that is not
 *    defined here, and `MSG.TICK` reports the hold's own tick count so the app can
 *    check the invariant survived a tick-rate change rather than trusting it.
 *
 * ## A note for whoever writes the slot
 *
 * The ids below are grouped by family, not packed, so a dense jump table indexed
 * from 0 would need 50 slots to reach `BATTERY` at `0x31`. Dispatch with a compare
 * chain instead, the way the vendor's own dispatcher does: thirteen compares is
 * about 40 bytes against 100 bytes of mostly-zero table.
 */
import { BLOCK_SIZE, CHAR_COMMAND, frame } from './protocol.js'
import { COLS, MAX_LEVEL, ROWS } from './display.js'

/** Marks a valid extension in the firmware image. Not seen on the wire. */
export const MAGIC = 'JGX1'

/**
 * Our opcode. The stock dispatcher tests D, S, L, A, M, C and I before reaching
 * the hook, so `J` cannot be shadowed by a vendor command.
 */
export const OPCODE = 'J'

/**
 * The characteristic every `J` frame goes to, exported so no caller has to choose.
 *
 * `960b` is not an option: see "Rules a new sub-command must not break".
 */
export const CHANNEL = CHAR_COMMAND

/**
 * Sub-command ids. The ranges are reserved as a whole so later work slots in
 * without renumbering: 0x00-0x0f session and control, 0x10-0x1f sync, 0x20-0x2f
 * content, 0x30-0x3f input and sensors, 0x40 and up unallocated.
 */
export const SUB = {
  HELLO: 0x00,
  /**
   * The five that let us replace our own firmware over Bluetooth, and again after
   * that. `notes/patch-over-bt.md` is the design; the short version is that these are
   * **resident**, i.e. in the half of the firmware only a probe can rewrite, and the
   * trampoline answers them before it consults a slot. So a slot whose code faults
   * cannot make a unit unreachable by the commands that replace it.
   */
  UPD_BEGIN: 0x01,
  UPD_DATA: 0x02,
  UPD_END: 0x03,
  UPD_ABORT: 0x04,
  UPD_STATUS: 0x05,
  /**
   * The animation tick rate, 50 Hz on stock and 100 Hz with the patch.
   *
   * Control rather than sync: it does not align two pairs, it changes this unit's
   * own timebase, and with it every tick-counted timeout in `abs 0x2162c` and
   * `abs 0x22030`, including the 100 ticks the long press counts. That constant is
   * *verified* from bytes; that reaching it powers the unit off is *unverified*,
   * since nobody has held the button and watched. Either way it is the only power
   * switch there is, which is why the reply carries the hold count as well as the
   * rate.
   */
  TICK: 0x06,
  /**
   * Seed `rand()`, which is unseeded on stock and so byte-identical on every boot.
   *
   * Sync family, not content, because the reason to want it is the argument in
   * `notes/what-to-build.md`, "Syncing several pairs": between **your own** pairs
   * that determinism is the feature. One seed word covers both jobs, since setting
   * two pairs the same makes them play the same sequence and setting them
   * differently is the same command with a different word. It is also the only sync
   * primitive that needs no clock, which matters while crystal-versus-RC is open.
   *
   * `0x11`-`0x1f` stay free for set-phase, set-tempo and sync-mark.
   */
  SEED: 0x10,
  /** Define four palette entries. `TILE_COUNT` entries is four frames. */
  TILE_DEF: 0x20,
  /** 24 palette indices, so a whole panel in one atomic write. */
  TILE_FRAME: 0x21,
  /**
   * Sub-column scroll interpolation: blend the two columns either side of a
   * boundary through the four levels instead of stepping a whole column.
   */
  SMOOTH: 0x22,
  /** Button back-channel: which edges to report, and who owns the short press. */
  BUTTON: 0x30,
  /** Battery millivolts. Report only, so there is nothing to set. */
  BATTERY: 0x31,
} as const

/**
 * Shortest and longest body the dispatcher will look at.
 *
 * The gate at `abs 0x18268` reads a length byte and bounds it at **both** ends, 4
 * to 20 inclusive, before the opcode is read at all: *verified* bytes, *derived*
 * behaviour. So a sub-command carrying less than two payload bytes must be padded
 * rather than trimmed, or it is dropped in the same silence a stock unit answers
 * with. `protocol.frame` caps a body at 15, which is the binding limit of the two.
 */
export const MIN_BODY = 4
export const MAX_BODY = BLOCK_SIZE - 1

/** Payload bytes a sub-command has, after the opcode and the sub-command id. */
export const MAX_PAYLOAD = MAX_BODY - 2

/**
 * First payload byte of every setting: ask for the value, or set it.
 *
 * One shape for all of them, so the slot has one prologue and the app has one
 * habit. `TILE_DEF` and `TILE_FRAME` do not carry it, because they are data rather
 * than settings and there is nothing to ask for.
 */
export const ASK = 0x00
export const SET = 0x01

/**
 * Build a sub-command frame, padded to the dispatcher's lower bound.
 *
 * Use this rather than `protocol.frame` for anything with our opcode on it. Pad
 * bytes are zero and no handler may read them.
 */
export function subFrame(sub: number, ...args: number[]): Uint8Array {
  const pad = Math.max(0, MIN_BODY - 2 - args.length)
  return frame(OPCODE, sub, ...args, ...new Array<number>(pad).fill(0))
}

/**
 * One bit per capability, reported by HELLO.
 *
 * Bits 0-3 are families and say only that a family is dispatched. Bit 4 was
 * already a feature. Everything from bit 5 is one feature, one bit, because a
 * family bit cannot say which of its members a unit actually carries. Five bits
 * are left; when they run out the HELLO reply grows a second word, which is safe
 * because every parser here reads by `len`.
 */
export const CAP = {
  SESSION: 1 << 0,
  SYNC: 1 << 1,
  CONTENT: 1 << 2,
  INPUT: 1 << 3,
  /** The unit can be re-patched over the air. The bit the whole loop turns on. */
  UPDATE: 1 << 4,
  /** Button edges arrive as notifications. */
  BUTTON: 1 << 5,
  BATTERY: 1 << 6,
  SEED: 1 << 7,
  TILES: 1 << 8,
  SMOOTH: 1 << 9,
  /** The tick rate can be asked for, whether or not it can be changed. */
  TICK: 1 << 10,
} as const

export type Capability = keyof typeof CAP

/**
 * The bit that licenses each sub-command.
 *
 * `permits()` is the question to ask; this table is exported so a diagnostic can
 * say which bit was missing.
 */
export const SUB_CAP: Readonly<Record<number, number | undefined>> = {
  [SUB.HELLO]: CAP.SESSION,
  [SUB.UPD_BEGIN]: CAP.UPDATE,
  [SUB.UPD_DATA]: CAP.UPDATE,
  [SUB.UPD_END]: CAP.UPDATE,
  [SUB.UPD_ABORT]: CAP.UPDATE,
  [SUB.UPD_STATUS]: CAP.UPDATE,
  [SUB.TICK]: CAP.TICK,
  [SUB.SEED]: CAP.SEED,
  [SUB.TILE_DEF]: CAP.TILES,
  [SUB.TILE_FRAME]: CAP.TILES,
  [SUB.SMOOTH]: CAP.SMOOTH,
  [SUB.BUTTON]: CAP.BUTTON,
  [SUB.BATTERY]: CAP.BATTERY,
}

/** The four reserved families, as the bit each range reports. */
export const FAMILIES: ReadonlyArray<{ from: number; to: number; cap: number }> = [
  { from: 0x00, to: 0x0f, cap: CAP.SESSION },
  { from: 0x10, to: 0x1f, cap: CAP.SYNC },
  { from: 0x20, to: 0x2f, cap: CAP.CONTENT },
  { from: 0x30, to: 0x3f, cap: CAP.INPUT },
]

/** Which family a sub-command belongs to, or null for the unallocated 0x40 and up. */
export function familyOf(sub: number): number | null {
  return FAMILIES.find((f) => sub >= f.from && sub <= f.to)?.cap ?? null
}

/** Does a capability bitmap set this bit? */
export const supports = (capabilities: number, cap: number): boolean =>
  (capabilities & cap) === cap

/**
 * May this unit be sent this sub-command?
 *
 * The feature bit and nothing else: a family bit is a summary, never a licence.
 * False for a sub-command this client does not know, so a caller cannot smuggle a
 * number past the gate. A `false` on a unit that had the feature a minute ago is
 * the vendor-OTA case: the slots are gone and only the resident half is left.
 *
 * **The bitmap is only good for the connection it arrived on.** A remembered one is
 * a guess: a unit can be reflashed between sittings, a vendor OTA wipes both slots,
 * and an `UPD_END` replaces the slot that answered. Probe on every connection and
 * gate on what that probe said.
 */
export function permits(capabilities: number, sub: number): boolean {
  const bit = SUB_CAP[sub]
  return bit !== undefined && supports(capabilities, bit)
}

/** Capability names present in a bitmap, for logging and diagnostics. */
export function capabilityNames(capabilities: number): Capability[] {
  return (Object.keys(CAP) as Capability[]).filter((k) => supports(capabilities, CAP[k]))
}

/**
 * The feature bits each family's members are licensed by.
 *
 * Derived from `SUB_CAP` and the numbering rather than listed, so a sub-command
 * added later cannot leave a stale table disagreeing with it.
 */
const MEMBER_BITS: ReadonlyArray<{ family: number; members: number }> = FAMILIES.map(
  (f) => {
    let members = 0
    for (const sub of Object.values(SUB)) {
      if (familyOf(sub) === f.cap) members |= SUB_CAP[sub] ?? 0
    }
    return { family: f.cap, members }
  },
)

/** The family bits a set of feature bits obliges a unit to report. */
export function familyBitsFor(capabilities: number): number {
  let bits = 0
  for (const { family, members } of MEMBER_BITS) {
    if ((capabilities & members) !== 0) bits |= family
  }
  return bits
}

/**
 * Ways a bitmap contradicts itself, as sentences, empty when it is well formed.
 *
 * A family bit is a summary of its members and never a claim of its own, so the two
 * halves must agree. This is a diagnostic and not a gate: `permits()` still answers
 * from the feature bit alone, because a unit that advertises `BUTTON` without
 * `INPUT` almost certainly does answer the button sub-command, and refusing to speak
 * to it would turn a firmware build error into a broken feature at a festival.
 */
export function capabilityProblems(capabilities: number): string[] {
  const name = (bit: number) => capabilityNames(bit)[0] ?? `bit 0x${bit.toString(16)}`
  const out: string[] = []
  for (const { family, members } of MEMBER_BITS) {
    const present = capabilities & members
    if (supports(capabilities, family) && present === 0) {
      const all = capabilityNames(members & ~family).join(', ')
      out.push(`${name(family)} is set with no member: it summarises ${all}`)
    }
    if (present !== 0 && !supports(capabilities, family)) {
      const had = capabilityNames(present & ~family).join(', ')
      out.push(`${had} without ${name(family)}: a feature bit obliges its family bit`)
    }
  }
  return out
}

/**
 * First byte of every notification we send.
 *
 * The vendor's three replies are ASCII, so a high byte cannot collide with one.
 * `DATSOK` begins 0x44.
 */
export const MARKER = 0xf0

/**
 * Notification types, additive.
 *
 * *Supersedes the table in `notes/firmware-design.md`, "The back-channel", which
 * has `0x01` as the button event and `0x02` as battery.* `0x01` was spent on
 * `UPD_REPLY` when the updater was built, and that half is resident and flashed by
 * probe only, so the numbering below is the one that cannot move.
 */
export const MSG = {
  HELLO_REPLY: 0x00,
  /** Answer to any `UPD_*`. `UPD_STATUS` answers with three more bytes after the code. */
  UPD_REPLY: 0x01,
  /** Unsolicited, and the only unsolicited message there is. */
  BUTTON: 0x02,
  /** Answer to a setting: the sub-command, a code, and what is now in force. */
  ACK: 0x03,
  BATTERY: 0x04,
  TICK: 0x05,
} as const

/**
 * The device's notify sender pads to one AES block and frames it as
 * `[len][payload]`, so a payload cannot exceed 15 bytes. Anything longer needs a
 * second notification, not a longer frame.
 */
export const MAX_NOTIFY_PAYLOAD = 15

/**
 * Version this client speaks, sent with HELLO so firmware can adapt later.
 *
 * The sub-commands below took it to 2. The only use for the field is a unit
 * telling a client that predates a feature from one that knows it.
 */
export const APP_VERSION = 2

/**
 * What a setting command did.
 *
 * Separate from `UPD` on purpose. `UPD` names flash failures inside the resident
 * updater, which is probe-only and deliberately frozen; these name argument and
 * capability failures in a slot. Merging them would put slot concerns in the half
 * that must not change.
 */
export const STATUS = {
  OK: 0x00,
  /** The sub-command is known to this client but not compiled into this unit. */
  UNSUPPORTED: 0x01,
  BAD_ARG: 0x02,
  /** Would break an invariant, e.g. a tick rate with no compensated timeouts. */
  REFUSED: 0x03,
  /** Something else owns the panel or the DATS buffer right now. */
  BUSY: 0x04,
} as const

// --- Replacing our own firmware over the air --------------------------------------
//
// The wire half of `notes/patch-over-bt.md`. Every constant below is also read by
// `research/tools/updater.ts`, which builds the firmware that answers it, so the two
// cannot drift: a mismatch would be discoverable only by flashing a unit.

/** Body bytes one `UPD_DATA` frame carries. Two words, so slot writes stay aligned. */
export const UPD_DATA_BYTES = 8

/** What the device says happened. */
export const UPD = {
  OK: 0x00,
  /** Zero, or larger than a slot's body. */
  BAD_LENGTH: 0x01,
  /** A sequence number past the length `UPD_BEGIN` declared. */
  BAD_SEQ: 0x02,
  /** The body arrived but its CRC-32 does not match. **The slot stays dead.** */
  BAD_CRC: 0x03,
  /** The flash controller refused, or a word did not read back. */
  FMC_REFUSED: 0x04,
  /** `UPD_STATUS` only: neither slot validates, so the unit is running resident code. */
  NO_SLOT: 0x05,
  /** The next generation would be 0, so `UPD_BEGIN` refuses rather than wrapping. */
  EXHAUSTED: 0x06,
} as const

/**
 * Start an update.
 *
 * The device picks which slot from the two generations; the phone does not choose and
 * cannot. `crc` is `ota.crc32` of the body, and the device computes the same function
 * over what it received before it makes the slot live.
 */
export function updBegin(length: number, crc: number): Uint8Array {
  if (length <= 0 || length > 0xffff) throw new Error(`update length ${length} out of range`)
  return subFrame(
    SUB.UPD_BEGIN,
    length & 0xff, (length >> 8) & 0xff,
    crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff,
  )
}

/**
 * One block of body, at `seq * UPD_DATA_BYTES`.
 *
 * Send these strictly in order and write-with-response: the firmware holds no state
 * between frames, so the sequence number IS the address, and the link layer is what
 * makes "in order" true. A short final block is padded, and the CRC covers only the
 * declared length, so the padding is not counted.
 */
export function updData(seq: number, block: Uint8Array): Uint8Array {
  if (block.length > UPD_DATA_BYTES) throw new Error(`block is ${block.length} bytes`)
  const padded = new Uint8Array(UPD_DATA_BYTES)
  padded.set(block)
  return subFrame(SUB.UPD_DATA, seq & 0xff, (seq >> 8) & 0xff, ...padded)
}

// The three below carry no argument, so `protocol.frame` would give them two-byte
// bodies and the dispatcher's length gate would drop every one of them. `subFrame`
// is what keeps them in range.

/** Commit: CRC the body and, only if it agrees, make the slot live. */
export const updEnd = (): Uint8Array => subFrame(SUB.UPD_END)

/** Give up, and make sure the half-written slot can never validate. */
export const updAbort = (): Uint8Array => subFrame(SUB.UPD_ABORT)

/** Which slot is live, and its generation. */
export const updStatus = (): Uint8Array => subFrame(SUB.UPD_STATUS)

/** How many `UPD_DATA` frames a body of this size needs. */
export const updFrames = (length: number): number =>
  Math.ceil(length / UPD_DATA_BYTES)

// --- The animation tick, and the power switch that rides on it ---------------------

/** Stock's tick, and the rate the 50-to-100 Hz patch offers. */
export const TICK_STOCK_HZ = 50
export const TICK_RATES: readonly number[] = [50, 100]

/** Ticks stock counts before the long press powers the unit off, and what that is. */
export const HOLD_TICKS_STOCK = 100
export const POWER_OFF_SECONDS = 2

/** Milliseconds a tick lasts at this rate. */
export const tickMs = (hz: number): number => 1000 / hz

/** What the long press is worth at a given rate and hold count. */
export const holdSeconds = (hz: number, holdTicks: number): number => holdTicks / hz

/**
 * Is the only power switch still the length it was?
 *
 * Doubling the tick halves every tick-counted timeout, so an uncompensated 100-tick
 * hold at 100 Hz powers the unit off after one second. The app can check that from
 * `MSG.TICK` instead of trusting the patch, which is the reason the reply carries
 * the hold count at all.
 */
export function powerOffIntact(hz: number, holdTicks: number, tolerance = 0.25): boolean {
  return Math.abs(holdSeconds(hz, holdTicks) - POWER_OFF_SECONDS) <= tolerance
}

/** Ask what tick rate is in force, and what the long press costs at it. */
export const tickAsk = (): Uint8Array => subFrame(SUB.TICK, ASK)

/**
 * Change the tick rate.
 *
 * Only the rates in `TICK_RATES` are offered, and the reason is the timeouts rather
 * than the timer: a rate the firmware carries no compensation for changes the 2 s
 * power-off, which nothing may do.
 */
export function tickSet(hz: number): Uint8Array {
  if (!TICK_RATES.includes(hz)) throw new RangeError(`tick rate ${hz} is not offered`)
  return subFrame(SUB.TICK, SET, hz)
}

// --- Seeding rand() ---------------------------------------------------------------

/**
 * Ask what seed is in force, so two pairs can be checked for agreement.
 *
 * Worth asking, because agreement is fragile in a way the seed word does not show:
 * `rand()`'s only two callers on stock are BLE paths (`abs 0x193da` and
 * `abs 0x22432`, *verified*), so anything the radio does consumes randomness. Two
 * pairs given the same seed diverge again the moment one of them handles a
 * connection event the other does not. Seed both after both are connected and idle.
 */
export const seedAsk = (): Uint8Array => subFrame(SUB.SEED, ASK)

/** Set the LCG seed. The same word on two pairs is the point, not an accident. */
export function seedSet(value: number): Uint8Array {
  const v = value >>> 0
  return subFrame(SUB.SEED, SET, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff,
    (v >>> 24) & 0xff)
}

// --- The tile palette -------------------------------------------------------------
//
// A tile is one column of 9 pixels at 4 levels, i.e. the same 18-bit word the
// rhythm channel's bar table holds (`rhythm.SOLID_BARS`), row 0 in the low two
// bits. 24 columns each choosing from 16 tiles is a whole panel in one write: the
// rhythm channel is atomic too but draws only bars, and a type 2 image is atomic
// but costs five page erases, so this is the only near-arbitrary frame that neither
// sweeps nor spends flash.
//
// **The firmware has to compose the frame itself rather than repoint the vendor's
// bar table.** That table is indexed by a height and the handler replaces anything
// above 9 with 0 (*derived*, `rhythm.encode`'s docblock), so six of the sixteen
// entries a nibble addresses would blank their column instead of drawing.
//
// Choosing which 16 tiles to define for a given picture is a renderer's job and is
// deliberately not here.

/** Palette entries. A nibble addresses 16, and 24 nibbles is the atomic frame. */
export const TILE_COUNT = 16

/** Entries one `TILE_DEF` carries. Four, because 4 x 3 + 1 is the 13-byte ceiling. */
export const TILE_DEF_ENTRIES = 4

/** Bytes an entry takes on the wire. 18 bits used of 24. */
export const TILE_WORD_BYTES = 3

/** The 18 bits a column word can set. */
export const TILE_WORD_MASK = (1 << (ROWS * 2)) - 1

/**
 * Pack a column of levels into a tile word, row 0 first.
 *
 * Throws on a level above `MAX_LEVEL` rather than masking it, because the overflow
 * would land in the next row up and draw a pixel nobody asked for.
 */
export function tileWord(levels: readonly number[]): number {
  if (levels.length !== ROWS) {
    throw new Error(`a tile is ${ROWS} levels, got ${levels.length}`)
  }
  let word = 0
  levels.forEach((v, r) => {
    if (!Number.isInteger(v) || v < 0 || v > MAX_LEVEL) {
      throw new RangeError(`level ${v} at row ${r} is outside 0-${MAX_LEVEL}`)
    }
    word |= v << (2 * r)
  })
  return word
}

/** The levels a tile word draws, row 0 first. */
export const tileLevels = (word: number): number[] =>
  Array.from({ length: ROWS }, (_, r) => (word >> (2 * r)) & MAX_LEVEL)

/**
 * Define `TILE_DEF_ENTRIES` consecutive palette entries.
 *
 * Always exactly four, so the firmware needs no count and no length to trust. The
 * palette is therefore **not atomic**: four frames define sixteen tiles, and a
 * `TILE_FRAME` sent between them mixes old tiles with new. Define the palette while
 * nothing is drawing from it, and wait for each `MSG.ACK` before the next frame.
 */
export function tileDefine(first: number, words: readonly number[]): Uint8Array {
  if (words.length !== TILE_DEF_ENTRIES) {
    throw new Error(`a TILE_DEF carries ${TILE_DEF_ENTRIES} entries, got ${words.length}`)
  }
  if (!Number.isInteger(first) || first < 0 || first > TILE_COUNT - TILE_DEF_ENTRIES) {
    throw new RangeError(`first entry ${first} would run past entry ${TILE_COUNT - 1}`)
  }
  const bytes: number[] = []
  for (const w of words) {
    if (!Number.isInteger(w) || w < 0 || w > TILE_WORD_MASK) {
      throw new RangeError(`tile word ${w} is outside 0-${TILE_WORD_MASK}`)
    }
    bytes.push(w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff)
  }
  return subFrame(SUB.TILE_DEF, first, ...bytes)
}

/** The whole palette, as the four frames that define it, in order. */
export function tilePalette(words: readonly number[]): Uint8Array[] {
  if (words.length !== TILE_COUNT) {
    throw new Error(`a palette is ${TILE_COUNT} tiles, got ${words.length}`)
  }
  const out: Uint8Array[] = []
  for (let first = 0; first < TILE_COUNT; first += TILE_DEF_ENTRIES) {
    out.push(tileDefine(first, words.slice(first, first + TILE_DEF_ENTRIES)))
  }
  return out
}

/**
 * One panel: 24 palette indices, two to a byte, low nibble first.
 *
 * The nibble order is the rhythm channel's own (`rhythm.encode`: column 2n from
 * `byte & 0xf`, column 2n+1 from `byte >> 4`), so if a build ever does implement
 * the palette by repointing the bar table at `abs 0x22da8`, these same twelve bytes
 * already mean these same 24 columns.
 *
 * **This is the one sub-command that answers nothing.** A reply per frame would
 * double the radio traffic for a value the next frame supersedes, exactly as the
 * vendor's live column writes answer nothing. Send it write-without-response and
 * pace it; `protocol.PACING_MS` is the floor.
 *
 * One payload byte is left spare, deliberately: a second palette page, a mirror
 * flag or a frame counter can have it without needing a second write, and a second
 * write could not be atomic.
 */
export function tileFrame(indices: readonly number[]): Uint8Array {
  if (indices.length !== COLS) {
    throw new Error(`a frame is ${COLS} columns, got ${indices.length}`)
  }
  const bytes = new Array<number>(COLS / 2).fill(0)
  indices.forEach((ix, i) => {
    if (!Number.isInteger(ix) || ix < 0 || ix >= TILE_COUNT) {
      throw new RangeError(`tile index ${ix} at column ${i} is not a palette entry`)
    }
    if (i % 2 === 0) bytes[i >> 1] |= ix
    else bytes[i >> 1] |= ix << 4
  })
  return subFrame(SUB.TILE_FRAME, ...bytes)
}

// --- Sub-column scroll interpolation ----------------------------------------------

/** One phase per step, and a step is one of the four levels. */
export const SMOOTH_OFF = 1
export const SMOOTH_MAX = MAX_LEVEL + 1

/** Ask how many sub-steps a scroll is drawn in. */
export const smoothAsk = (): Uint8Array => subFrame(SUB.SMOOTH, ASK)

/**
 * Set the sub-steps a whole-column scroll step is blended over.
 *
 * `SMOOTH_OFF` is stock behaviour. The ceiling is four because the panel has four
 * levels and their curve belongs to the display module, so a fifth phase has no
 * brightness to draw itself with (`CLAUDE.md`, "The MCU does not drive the LEDs").
 */
export function smoothSet(steps: number): Uint8Array {
  if (!Number.isInteger(steps) || steps < SMOOTH_OFF || steps > SMOOTH_MAX) {
    throw new RangeError(`sub-steps ${steps} is outside ${SMOOTH_OFF}-${SMOOTH_MAX}`)
  }
  return subFrame(SUB.SMOOTH, SET, steps)
}

// --- The button back-channel -------------------------------------------------------

/**
 * What a `BUTTON` command subscribes to, and who owns the short press.
 *
 * `SUPPRESS_CYCLE` is what the playlist needs and the reason this is not just a
 * subscription: on stock a short press does `mode_index++` then `set_mode(index+4)`,
 * so a press meant to advance our playlist would also jump the panel to a built-in
 * mode and fight whatever the app then shows. The instructions are *verified* from
 * bytes (`abs 0x216de`, and the same constant again on the power-on path) and the
 * behaviour is *unverified*, so what a suppressed press looks like is the first
 * thing to watch. `notes/playlist.md` has the rest of that design.
 *
 * There is no flag for the long press, and there must never be one: the 2 s hold is
 * the only power switch. `SUPPRESS_CYCLE` must also live in RAM only, never flash,
 * so a power cycle gives a wearer their button back with no phone in reach.
 */
export const BTN = {
  PRESS: 1 << 0,
  RELEASE: 1 << 1,
  /** The hold crossed 2 s: the unit is switching off, so expect the link to drop. */
  HOLD: 1 << 2,
  SUPPRESS_CYCLE: 1 << 3,
} as const

/** Every defined flag. Nothing outside this may be sent. */
export const BTN_FLAGS = BTN.PRESS | BTN.RELEASE | BTN.HOLD | BTN.SUPPRESS_CYCLE

/** Report nothing and give the built-in cycle back. The state at power-on. */
export const BTN_OFF = 0

/** Edges a `MSG.BUTTON` can carry. */
export const EDGE = {
  PRESS: 0x01,
  RELEASE: 0x02,
  HOLD: 0x03,
} as const

/** `MSG.BUTTON.index` when the device has no cycle position to report. */
export const INDEX_NONE = 0xff

/** Ask which edges are being reported and who owns the short press. */
export const buttonAsk = (): Uint8Array => subFrame(SUB.BUTTON, ASK)

/**
 * Subscribe, unsubscribe, and decide who owns the short press.
 *
 * Refuses an undefined bit rather than passing it on: on a future build such a bit
 * could mean anything, and the one thing no bit may ever mean is "disable the 2 s
 * power-off". Send `BTN_OFF` when the app stops caring, or the unit keeps building
 * notifications inside the timer ISR for nobody.
 */
export function buttonSet(flags: number): Uint8Array {
  if (!Number.isInteger(flags) || flags < 0 || (flags & ~BTN_FLAGS) !== 0) {
    throw new RangeError(`button flags ${flags} sets a bit that is not defined`)
  }
  return subFrame(SUB.BUTTON, SET, flags)
}

/**
 * Milliseconds between two button edges, from the device's own tick counter.
 *
 * Device timestamps rather than arrival times, which is what makes tap tempo
 * accurate: BLE round-trip jitter never enters the measurement. Wrap-safe, since an
 * unsigned subtraction gives the right interval across the counter's wrap instead of
 * a negative one, and the wrap is 497 days at 100 Hz.
 */
export const tapIntervalMs = (from: number, to: number, hz: number): number =>
  (((to - from) >>> 0) * 1000) / hz

/**
 * Presses that never arrived, from the counter each event carries.
 *
 * Notifications are not acknowledged, so nothing on the wire says one went missing.
 * **What a loss costs depends on who owns the short press**, and this docblock had it
 * the wrong way round until track 67 built the consumer:
 *
 *  - **`SUPPRESS_CYCLE` set.** The host is the only thing that moves the panel, so a
 *    lost press means nothing moved and the app's idea stays correct. What was lost is
 *    the wearer's intent, not the app's model.
 *  - **Suppression off.** The firmware advances its own mode index, so a lost press
 *    leaves the app wrong about what the panel is showing, and it is this case, not the
 *    one above, where the count matters.
 *
 * So a non-zero answer means "the wearer pressed and we did not act" in the first case
 * and "we no longer know what is on the panel" in the second. Do not treat them alike.
 */
export const missedPresses = (previous: number, current: number): number =>
  ((current - previous) & 0xff) - 1

// --- Battery ----------------------------------------------------------------------

/**
 * Above this the reading is saturated and says nothing about charge.
 *
 * There is no charger-state pin in this image (*verified* by an exhaustive scan for
 * peripheral bases), so "charging" is inferable only from the voltage sitting here.
 */
export const BATTERY_SATURATED_MV = 4150

/**
 * Ask for the battery voltage. Report only, and polled rather than pushed.
 *
 * No subscription, deliberately: an unsolicited voltage stream costs radio all day
 * for a number nobody is looking at, and the app is already connected when it cares.
 */
export const batteryAsk = (): Uint8Array => subFrame(SUB.BATTERY, ASK)

// --- Requests ---------------------------------------------------------------------

/**
 * Ask a unit what it is.
 *
 * Four payload bytes, which is also the shortest frame the dispatcher's length gate
 * accepts. A stock unit ignores it in silence.
 */
export function hello(appVersion = APP_VERSION): Uint8Array {
  return subFrame(SUB.HELLO, appVersion & 0xff, (appVersion >> 8) & 0xff)
}

// --- Replies ----------------------------------------------------------------------

export interface HelloReply {
  type: 'hello'
  /** Extension version the unit reports, not the vendor's firmware version. */
  version: number
  capabilities: number
}

export interface UpdReply {
  type: 'update'
  code: number
  /**
   * `UPD_STATUS` only.
   *
   * `liveIsB` is the slot RUNNING. `target` is the slot the next `UPD_BEGIN` will
   * WRITE, and they are never the same slot. **Anything choosing a base to assemble
   * against wants `target`**: a body is position-dependent, and one built for the
   * wrong base carries a valid CRC and valid magic, so it is the failure the
   * firmware cannot catch by inspection. `notes/patch-over-bt.md` records that as
   * the design's one uncatchable case; reading `liveIsB` and inverting it is how a
   * caller walks into it, which is why the device now says the target outright.
   *
   * `target` is absent from a unit whose firmware predates the seventh payload
   * byte. Treat absence as "ask, do not guess", never as slot A.
   */
  status?: { liveIsB: boolean; generation: number; target?: 'a' | 'b' }
}

export interface ButtonEvent {
  type: 'button'
  edge: number
  /** Presses since power-on, mod 256. `missedPresses` is what it is for. */
  count: number
  /** The device's own cycle position after this edge, or `INDEX_NONE`. */
  index: number
  /**
   * Free-running tick count at the edge. `tapIntervalMs` turns two into a tempo.
   *
   * It has to be the extension's own counter: the vendor's word at `0x20003070` is
   * how long the *current* press has been held, so it restarts on every press
   * (*derived*, from the compare against 100 that makes the long press).
   */
  ticks: number
}

export interface Ack {
  type: 'ack'
  /** The sub-command being answered, so a reply cannot be misattributed. */
  sub: number
  code: number
  /** What is now in force, if the sub-command has anything to echo. */
  detail?: Uint8Array
}

export interface BatteryReport {
  type: 'battery'
  millivolts: number
}

export interface TickReport {
  type: 'tick'
  hz: number
  /** Ticks the long press counts. `powerOffIntact` is what it is for. */
  holdTicks: number
}

export type Notification =
  | HelloReply
  | UpdReply
  | ButtonEvent
  | Ack
  | BatteryReport
  | TickReport

/**
 * Parse a decrypted notification block.
 *
 * Returns null for anything that is not ours, including the vendor's `DATSOK` and
 * `DATCPOK`, so a caller can hand every notification to both parsers.
 *
 * Every case reads by `len` and ignores trailing bytes, which is how an app older
 * than a unit stays working: a reply that grew a field still parses into what the
 * app already understood.
 */
export function parseNotification(plain: Uint8Array): Notification | null {
  const len = plain[0]
  if (!len || len > MAX_NOTIFY_PAYLOAD || len + 1 > plain.length) return null
  if (plain[1] !== MARKER) return null

  switch (plain[2]) {
    case MSG.HELLO_REPLY:
      if (len < 6) return null
      return {
        type: 'hello',
        version: plain[3] | (plain[4] << 8),
        capabilities: plain[5] | (plain[6] << 8),
      }
    case MSG.UPD_REPLY: {
      if (len < 3) return null
      const code = plain[3]
      // Three bytes is every reply except UPD_STATUS's, which carries the slot state
      // after the code. Parsed by length rather than by a second message type, so a
      // client that only wants the code never has to know the difference.
      if (len < 6) return { type: 'update', code }
      const status: NonNullable<UpdReply['status']> = {
        liveIsB: plain[4] === 1,
        generation: plain[5] | (plain[6] << 8),
      }
      // Purely additive seventh byte, so an older unit's six-byte reply still parses
      // and simply reports no target. Do not infer one from `liveIsB`.
      if (len >= 7) status.target = plain[7] === 1 ? 'b' : 'a'
      return { type: 'update', code, status }
    }
    case MSG.BUTTON:
      if (len < 9) return null
      return {
        type: 'button',
        edge: plain[3],
        count: plain[4],
        index: plain[5],
        ticks: (plain[6] | (plain[7] << 8) | (plain[8] << 16) | (plain[9] << 24)) >>> 0,
      }
    case MSG.ACK: {
      if (len < 4) return null
      const ack: Ack = { type: 'ack', sub: plain[3], code: plain[4] }
      if (len > 4) ack.detail = plain.slice(5, len + 1)
      return ack
    }
    case MSG.BATTERY:
      if (len < 4) return null
      return { type: 'battery', millivolts: plain[3] | (plain[4] << 8) }
    case MSG.TICK:
      if (len < 5) return null
      return { type: 'tick', hz: plain[3], holdTicks: plain[4] | (plain[5] << 8) }
    default:
      return null
  }
}

/** A `J` frame, taken apart. */
export interface Command {
  sub: number
  /** Payload after the sub-command id, pad bytes included. */
  args: Uint8Array
}

/**
 * Parse one of our own command frames, for decoding a captured wire log and for
 * checking a firmware test vector against the client that will send it.
 *
 * Applies the dispatcher's own gate, so a frame this refuses is a frame a unit
 * would drop in silence.
 */
export function parseCommand(f: Uint8Array): Command | null {
  const len = f[0]
  if (len < MIN_BODY || len > MAX_BODY || len + 1 > f.length) return null
  if (f[1] !== OPCODE.charCodeAt(0)) return null
  return { sub: f[2], args: f.slice(3, len + 1) }
}

/** The 24 column indices a `TILE_FRAME`'s payload carries. */
export function readTileFrame(args: Uint8Array): number[] | null {
  if (args.length < COLS / 2) return null
  const out: number[] = []
  for (let i = 0; i < COLS / 2; i++) out.push(args[i] & 0xf, (args[i] >> 4) & 0xf)
  return out
}

/** The entries a `TILE_DEF`'s payload defines, and where they start. */
export function readTileDefine(
  args: Uint8Array,
): { first: number; words: number[] } | null {
  if (args.length < 1 + TILE_DEF_ENTRIES * TILE_WORD_BYTES) return null
  const words: number[] = []
  for (let i = 0; i < TILE_DEF_ENTRIES; i++) {
    const at = 1 + i * TILE_WORD_BYTES
    words.push(args[at] | (args[at + 1] << 8) | (args[at + 2] << 16))
  }
  return { first: args[0], words }
}
