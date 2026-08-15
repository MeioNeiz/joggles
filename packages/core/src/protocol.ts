/**
 * Funky Glasses+ BLE wire format.
 *
 * Recovered from the vendor APK; see notes/protocol.md. Every write is exactly
 * one 16-byte AES-128-ECB block:
 *
 *     [len][opcode ASCII...][args...][zero padding to 16]
 *
 * `len` counts opcode plus arguments, excluding padding.
 */
import { decryptBlock, encryptBlock, expandKey } from './aes.js'

export const SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb'
export const CHAR_COMMAND = 'd44bc439-abfd-45a2-b575-925416129600'
export const CHAR_NOTIFY = 'd44bc439-abfd-45a2-b575-925416129601'
export const CHAR_BULK_A = 'd44bc439-abfd-45a2-b575-92541612960a'
export const CHAR_BULK_B = 'd44bc439-abfd-45a2-b575-92541612960b'

// The Panchip OTA service and characteristic UUIDs are deliberately NOT here. They
// live in dfu.ts, which the main barrel does not export, so importing the command
// set does not hand anyone the ability to address the flash-writing service.
// safe-surface.test.ts asserts those UUIDs appear in no module the barrel reaches,
// which is why this comment does not spell one out.

export const BLOCK_SIZE = 16

/** Advert name of a stock unit. */
export const NAME_PREFIX = 'GLASSES-'

/**
 * Advert name of a unit carrying our firmware, so crew and strangers are told
 * apart at scan time. Set by `research/tools/build-firmware.ts --name`; change it
 * there and here together.
 */
export const CREW_NAME_PREFIX = 'JOGGLES-'

/** Manufacturer-data marker the vendor app filters on: "TR\0:". */
export const SIGNATURE = new Uint8Array([0x54, 0x52, 0x00, 0x3a])

/** Hardcoded in the vendor's libAES.so, recovered by brute-forcing the image. */
export const VENDOR_KEY = new Uint8Array([
  0x34, 0x52, 0x2a, 0x5b, 0x7a, 0x6e, 0x49, 0x2c,
  0x08, 0x09, 0x0a, 0x9d, 0x8d, 0x2a, 0x23, 0xf8,
])

export interface Cipher {
  encrypt(frame: Uint8Array): Uint8Array
  decrypt(block: Uint8Array): Uint8Array
}

/**
 * Bind a key into a cipher.
 *
 * Wanting to drive both strangers and crew means the client speaks two keys: the
 * vendor key for stock units, which can never be reflashed and so keep it forever,
 * and the group key for our own. Key expansion happens once, here, so a connection
 * carries its cipher rather than reaching for a module-level one.
 */
export function cipher(key: Uint8Array): Cipher {
  const roundKeys = expandKey(key)
  return {
    encrypt: (frame) => encryptBlock(roundKeys, frame),
    decrypt: (block) => decryptBlock(roundKeys, block),
  }
}

/** The vendor cipher, and the default for anything that does not say otherwise. */
export const vendor: Cipher = cipher(VENDOR_KEY)

export const encrypt = (frame: Uint8Array): Uint8Array => vendor.encrypt(frame)
export const decrypt = (block: Uint8Array): Uint8Array => vendor.decrypt(block)

/** Build a plaintext frame from an ASCII opcode and its arguments. */
export function frame(opcode: string, ...args: number[]): Uint8Array {
  const body = [...opcode].map((c) => c.charCodeAt(0)).concat(args)
  if (body.length > BLOCK_SIZE - 1) {
    throw new Error(`frame body too long: ${body.length}`)
  }
  const out = new Uint8Array(BLOCK_SIZE)
  out[0] = body.length
  out.set(body, 1)
  return out
}

/** The meaningful bytes of a plaintext frame, padding stripped. */
export function body(f: Uint8Array): Uint8Array {
  const n = f[0]
  return n > f.length - 1 ? new Uint8Array(0) : f.subarray(1, 1 + n)
}

const ascii = (b: Uint8Array) => String.fromCharCode(...b)

// --- Command table, transcribed from the vendor app's Agreement.java ---
//
// The firmware handles exactly eleven opcodes (hand-checked opcode scan, see
// research/firmware-internals.md). The app's table is much longer, so several
// helpers below build frames the device silently discards. They are kept because
// the vendor app sends them and our decoders must name what they see; they are
// grouped and marked so nothing builds a UI control on top of one.

export const enterDIY = () => frame('SMVEW', 1)
export const enterDIYAlt = () => frame('SMVEW', 3)
export const exitDIY = () => frame('SMVEW', 0)
export const exitDIYSave = () => frame('SMVEW', 2)
export const brightness = (level: number) => frame('LIGHT', level)
/** 0-100, bucketed to 3.8-12.5 columns/second by the ladder below. */
export const speed = (v: number) => frame('SPEED', v)

// --- What `SPEED n` actually does, so a preview can be a simulation ---
//
// *verified*, disassembled by hand from the bucketing ladder at `abs 0x183da`. The
// argument is compared against 10, 20, 30, ... 90 and a frame divisor is written to
// RAM `0x2000266e`; the scroll advances one column every `divisor` ticks of the 50 Hz
// animation clock (`abs 0x18052` holds `0x32`). So a column lasts `divisor * 20ms`,
// from 260ms at the bottom to 80ms at the top.
//
// **This corrects `research/firmware-internals.md`**, which records the ladder as
// comparing against "50, 60, 70, 80, 90". Those are the five comparisons inside the
// address range it quotes (`abs 0x18400`-`0x18428`); four more sit just before it at
// `0x183de`-`0x183fe`, so there are ten buckets rather than six. The 3.8 to 12.5
// columns per second the same paragraph gives is right, and is these two endpoints.
//
// It lives here rather than in the app, next to the opcode it describes, so the CLI
// and the phone cannot disagree about how fast the panel is about to move.

/** One tick of the firmware's animation clock, which runs at 50 Hz. */
export const SPEED_TICK_MS = 20

/**
 * `[argument at most, frame divisor]`, in the order the firmware tests them.
 * Anything above the last threshold gets `SPEED_FASTEST`.
 */
const SPEED_LADDER: Array<[number, number]> = [
  [10, 13],
  [20, 12],
  [30, 11],
  [40, 10],
  [50, 9],
  [60, 8],
  [70, 7],
  [80, 6],
  [90, 5],
]

/** The divisor above the last threshold. */
export const SPEED_FASTEST = 4

/** Ticks the device holds each column for. 13 at the slowest, 4 at the fastest. */
export const speedDivisor = (v: number): number =>
  SPEED_LADDER.find(([atMost]) => v <= atMost)?.[1] ?? SPEED_FASTEST

/** Milliseconds the device holds each column: 260 at the slow end, 80 at the fast. */
export const msPerColumn = (v: number): number => speedDivisor(v) * SPEED_TICK_MS

/** The same as a rate, which is the number worth showing a person. */
export const columnsPerSecond = (v: number): number => 1000 / msPerColumn(v)

// --- The ceiling, and every rung below it ---
//
// **`SPEED` saturates. 12.5 columns per second is the fastest this panel scrolls and
// no argument goes past it.** The ladder's last comparison is against 90, so 91, 100
// and 255 all fall through to divisor 4 and write the same byte to `0x2000266e`.
// Asking for "faster" over BLE is asking for a number the firmware has already
// stopped reading. *derived*, from the disassembly at `abs 0x183da`; `bun cli speed`
// is the hardware check, including whether an argument above 100 does something the
// ladder does not predict.
//
// The one lever that would move the ceiling is not in this protocol at all: the 50 Hz
// animation tick is one byte at `abs 0x18052`, and doubling it doubles the whole
// range. That is a firmware patch, it needs SWD delivery, and both are blocked - see
// `notes/plan-after-the-brick.md`. Nothing here can substitute for it, so a UI should
// say where the top is rather than imply there is more above it.

/** The largest argument worth sending. Everything above behaves identically. */
export const SPEED_ARG_MAX = 100

/**
 * The smallest argument that reaches the fastest bucket, i.e. the top of the ladder.
 *
 * Derived from the ladder rather than written as 91, so a corrected threshold moves
 * this with it.
 */
export const SPEED_FASTEST_ARG = SPEED_LADDER[SPEED_LADDER.length - 1][0] + 1

/**
 * One argument per distinct divisor, slowest first: every speed the device HAS.
 *
 * Ten rungs, because there are ten buckets. A control offering fewer leaves speeds
 * the hardware supports unreachable, and one offering more repeats itself.
 *
 * Each value sits in the MIDDLE of its bucket rather than on a boundary. The
 * boundaries are the fragile part of the transcription - they are `bhi` comparisons,
 * so being off by one moves a rung into its neighbour - and a midpoint absorbs that
 * error where 10 or 11 would not.
 */
export const SPEED_STEPS: readonly number[] = (() => {
  const steps: number[] = []
  let low = 0
  for (const [atMost] of SPEED_LADDER) {
    steps.push(Math.floor((low + atMost) / 2))
    low = atMost + 1
  }
  steps.push(Math.floor((SPEED_FASTEST_ARG + SPEED_ARG_MAX) / 2))
  return steps
})()

/**
 * Bank index.
 *
 * **The base is disputed and nothing should be built on either reading yet.** This
 * line used to say flatly that the bank starts at 20, so the fourth animation is 23:
 * that is the *vendor app's* convention, taken from `Agreement.getAnimCommand`, which
 * sends `ANIM 20` to `ANIM 29` for ten animations. Track 20's independent decode of
 * the firmware reads the handler as **mode `i + 5`**, which puts the vendor's 20-29 at
 * modes 25-34: the image mode, the type 2 mode, six oddments, and two values
 * `set_mode` rejects outright. Both cannot be right and no further disassembly can
 * say which, because each is self-consistent.
 *
 * Settling it costs no flash and one look: send `ANIM 0` and compare the panel against
 * `bun run research/tools/bankdump.ts show anim-0`. Until then treat the argument as
 * an opaque index, and see `builtins.ts` plus `research/firmware-internals.md`.
 * *Noted 2026-08-11.*
 */
export const animation = (i: number) => frame('ANIM', i)
/** The firmware matches `LOOP`, not `LOOA`, and our own build removes it entirely:
 *  the dispatcher hook replaces that arm. `animation(19)` reaches the same mode. */
export const animationLoop = () => frame('LOOA')
export const image = (i: number) => frame('IMAG', i)
/** Atomic clear. Undocumented and the vendor app never sends it; `LEDOFF` is a no-op. */
export const clear = () => frame('CLRL')
export const exitRhythm = () => frame('SOUT')

/**
 * Display the saved content. `kind` is 1 static, 2 horizontal, 3 vertical, and
 * the parser accepts nothing else.
 *
 * `dir` is a boolean, tested only for zero versus non-zero, so `MODE 01` gives
 * two displays and not eight:
 *
 *     MODE 01 00 / nn   static, and static inverted
 *     MODE 02 00 / nn   scroll left, scroll right
 *     MODE 03 00 / nn   vertical bounce, and its mirror
 *
 * Replaces `scrollLeft`/`scrollRight`/`modeStatic`/`modeFlash`, which were
 * transcribed from the app's table and **wrong**: `scrollLeft` built `MODE 03`
 * (vertical), `scrollRight` built the dead `MODE 04`, and `modeFlash` implied a
 * strobe rate where the byte is a direction. There is no strobe opcode.
 */
export const mode = (kind: 1 | 2 | 3, dir: 0 | 1 = 0) => frame('MODE', kind, dir)

// --- Absent from the firmware: these reach no handler on our unit ---
// Kept for decoding vendor traffic. Sending one is a no-op, not an error.

export const queryType = () => frame('STYPE')
export const invert = () => frame('EVERT')
export const stopRhythm = () => frame('STOPR')
export const leds = (on: boolean) => (on ? frame('LEDON') : frame('LEDOFF'))
export const flashlight = (on: boolean) => (on ? frame('LIGHTON') : frame('LIGHTOFF'))

/** There is no lens select in the firmware; both arms are unmatched opcodes. */
export function lens(which: 1 | 2): Uint8Array {
  return which === 1 ? frame('LEDFIRST') : frame('LEDSECOND')
}

/** One bulk pixel frame: [04][index][3 bytes of column bitmap]. */
export function column(index: number, bitmap: Uint8Array): Uint8Array {
  if (bitmap.length !== 3) throw new Error('column bitmap must be 3 bytes')
  return frame('', index, bitmap[0], bitmap[1], bitmap[2])
}

/** Decode a STYPE reply. Our unit never answers, but the firmware family does. */
export function parseType(f: Uint8Array): { rows: number; cols: number } | null {
  const text = ascii(body(f))
  if (!text.startsWith('STYPE')) return null
  const [r, c] = text.slice(5).split('X')
  const rows = Number(r)
  const cols = Number(c)
  return Number.isFinite(rows) && Number.isFinite(cols) && c !== undefined
    ? { rows, cols }
    : null
}

/**
 * Milliseconds between live column writes, and between DATS blocks.
 *
 * **Measured, at last.** 18 ms was copied out of an early script and never checked; on
 * 2026-08-12 `verify.ts pacing 6` lit alternate columns 6 ms apart on `GLASSES-125B37`
 * and all twelve arrived, every gap even (*verified* by eye,
 * `research/vendor-app-protocol.md`, "The sitting"). The firmware's own floor is ~6.4
 * ms, one 74-byte frame at 115200 baud on the panel module's UART, so 6 ms is at the
 * hardware's limit rather than merely faster than before.
 *
 * **10, not 6, and the gap is deliberate.** What was proven is that 6 ms works on one
 * link in one room: BLE negotiates its connection interval per connection, and
 * write-without-response has no flow control, so a dropped column produces no error
 * anywhere and looks exactly like dead hardware. 10 ms keeps most of the win with room
 * for a worse radio: a whole-panel change is 240 ms rather than 430, and a 700-column
 * upload is ~1.7 s rather than ~5 s, which is the wait behind "it seems to keep having
 * to send the animation to the device".
 *
 * Lower it only with another look at the panel, and never below 6.4 without a reason
 * to think the module's UART got faster.
 */
export const PACING_MS = 10
