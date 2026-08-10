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
/** 0-100, bucketed to 3.8-12.5 columns/second by the ladder at `abs 0x183da`. */
export const speed = (v: number) => frame('SPEED', v)
/** Bank index, and the bank starts at 20: the fourth animation is 23, not 3. */
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
