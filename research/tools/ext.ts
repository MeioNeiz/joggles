/**
 * The `JGX1` firmware extension: the block appended in free flash, and the one
 * dispatcher hook that reaches it.
 *
 * Architecture is `notes/firmware-design.md`. In one paragraph: the stock image is
 * patched at exactly one place, adding a single opcode `J` whose first payload byte
 * is a sub-command id. Everything we ever add is a new sub-command in free flash,
 * costing no further edits to the vendor's code. The stock firmware stays the
 * untouchable substrate that guarantees recovery over the air.
 *
 * Every address below is `abs`, i.e. a flash address, and comes from
 * `research/firmware-internals.md`. The load-bearing ones are re-asserted against
 * the stock bytes by `build-firmware.ts`, so a wrong address fails at build time
 * rather than on a device that then has to be recovered.
 *
 * ## The wire frame, and its two coordinate systems
 *
 * A command is one AES block of `[len][opcode ASCII...][args...]`, so on the wire
 * the opcode starts at index 1. The dispatcher is handed a struct pointer whose
 * frame data begins one byte in, so the same opcode byte is `[r4+2]` in the
 * disassembly. Both readings in the research documents are right; they just count
 * from different places. `ARG` below converts.
 */
import { CAP, MAGIC, MARKER, MSG, OPCODE, SUB } from '../../packages/core/src/jgx.js'
import { Asm } from './thumb.js'

// The wire format is defined once, in core, and the firmware is built from it. The
// alternative is two copies of the same table drifting apart, one of which is only
// discoverable by flashing a device.
export { CAP, MAGIC, MARKER, MSG, OPCODE, SUB }

// --- Stock addresses this extension depends on ------------------------------------

/** End of the stock image, and the first free byte of flash. *verified.* */
export const EXT_BASE = 0x26a24

/** OTA staging bank. Our appended block must end well below it. *verified.* */
export const STAGING_BANK = 0x29400

/** The `LOOP` dispatcher arm, 28 bytes, which the hook replaces. *verified.* */
export const HOOK_ADDR = 0x182a6
export const HOOK_LEN = 28

/** Shared dispatcher epilogue, `pop {r3,r4,r5,r6,r7,pc}`. Every arm ends here. */
export const EPILOGUE = 0x182c2

/**
 * The `LIGHT` arm's back-branch, `abs 0x184a6`, jumps here when the second letter
 * is not `I`, i.e. "this is an L opcode but not LIGHT, go try LOOP".
 *
 * This is a **second entry point into the block the hook overwrites**, and neither
 * `research/firmware-internals.md` nor `notes/firmware-design.md` accounted for it.
 * The layout below therefore puts a branch to the epilogue at exactly this address,
 * so an `L` frame that is not `LIGHT` is treated as unmatched, which is what stock
 * did once `LOOP` stopped existing. Move anything here and `LIGHT`'s sibling
 * opcodes start running the trampoline on frames that are not ours.
 */
export const LIGHT_FALLBACK = 0x182aa

/** `notify(r0 = payload length, r1 = payload pointer)`. *verified.* */
export const NOTIFY = 0x2145c

/** The notify sender pads to one AES block, so `[len][payload]` caps payload at 15. */
export const NOTIFY_MAX_PAYLOAD = 15

/** Dispatcher frame struct offset of wire byte `n`. See the header comment. */
export const ARG = (n: number) => n + 1

// --- The extension block ----------------------------------------------------------

/**
 * Byte offsets within the extension header. The trampoline reads `TABLE_COUNT` and
 * `TABLE` at run time; the rest is there so our tooling can read a built image back
 * and report what is in it rather than trusting a constant that can drift.
 *
 * Dispatch indexes `TABLE` from 0, so a sub-command at 0x10 costs 16 empty slots
 * ahead of it. That is 32 bytes of zeros against a two-instruction dispatch, which
 * is the right trade with 10 KB of flash free.
 */
export const HDR = {
  MAGIC: 0x00,
  VERSION: 0x04,
  CAPABILITIES: 0x06,
  ENTRY: 0x08,
  SIZE: 0x0c,
  TABLE_COUNT: 0x10,
  RESERVED: 0x12,
  TABLE: 0x14,
} as const

export interface ExtOptions {
  /** Our firmware version, reported by HELLO. */
  version: number
  base?: number
}

export interface Extension {
  /** The bytes to append at `base`. */
  code: Uint8Array
  base: number
  version: number
  capabilities: number
  /** Absolute Thumb address of the trampoline, i.e. with bit 0 set. */
  entry: number
  /** The 6-byte payload a HELLO reply carries, for the client tests to match. */
  helloReply: Uint8Array
}

/**
 * Assemble the extension block.
 *
 * Layout is a self-describing header first, so our tooling can read a built image
 * back and report exactly what is compiled into it rather than trusting a constant
 * that can drift. The header is data only; nothing in it is executed.
 */
export function buildExtension(opts: ExtOptions): Extension {
  const base = opts.base ?? EXT_BASE
  const capabilities = CAP.SESSION

  // Adding a sub-command later means one more entry here and one more handler
  // below. Nothing else in the firmware changes, which is the whole point.
  const handlers = [{ id: SUB.HELLO, label: 'hello' }]
  const tableCount = Math.max(...handlers.map((h) => h.id)) + 1

  const a = new Asm(base)
  a.ascii(MAGIC)
  a.half(opts.version)
  a.half(capabilities)
  a.word(0) //               ENTRY, filled in once the trampoline has an address
  a.word(0) //               SIZE, likewise
  a.half(tableCount)
  a.half(0) //               reserved
  if (a.size !== HDR.TABLE) throw new Error(`header is ${a.size} bytes, expected 0x14`)

  // One u16 offset from `base` per sub-command, 0 meaning "not compiled in".
  for (let i = 0; i < tableCount; i++) a.half(0)
  a.align(4)

  // --- trampoline -----------------------------------------------------------------
  // Entered from the dispatcher hook with r0 = the frame struct pointer. Free to
  // clobber r0-r3 and lr; must leave the stack balanced.
  a.label('entry')
  a.push(['r4', 'lr'])
  a.mov('r4', 'r0')
  a.ldrPool('r3', 'ext_base') //                 our own base address
  a.ldrb('r0', 'r4', ARG(2)) //                  sub-command, wire index 2
  a.ldrh('r1', 'r3', HDR.TABLE_COUNT)
  a.cmpReg('r0', 'r1')
  a.bcond('hs', 'done') //                       out of range: ignore in silence
  a.lsls('r0', 'r0', 1)
  a.adds('r0', HDR.TABLE)
  a.ldrhReg('r2', 'r3', 'r0') //                 table[sub], an offset from base
  a.cmp('r2', 0)
  a.bcond('eq', 'done') //                       not compiled in: ignore in silence
  a.addsReg('r2', 'r2', 'r3')
  a.adds('r2', 1) //                             Thumb bit
  a.mov('r0', 'r4') //                           arg 0 is the frame struct pointer
  a.blx('r2')
  a.label('done')
  a.pop(['r4', 'pc'])
  a.align(4)
  a.label('ext_base').word(base)

  // --- HELLO ----------------------------------------------------------------------
  // The reply is entirely constant, so it lives in flash and the handler neither
  // touches RAM nor builds anything on a stack with ~268 bytes of headroom.
  a.label('hello')
  a.push(['r4', 'lr'])
  a.movs('r0', 6) //                             payload length, well under 15
  a.ldrPool('r1', 'hello_ptr')
  a.bl(NOTIFY)
  a.pop(['r4', 'pc'])
  a.align(4)
  a.label('hello_ptr').word('hello_reply')
  a.label('hello_reply')
  const helloReply = new Uint8Array([
    MARKER,
    MSG.HELLO_REPLY,
    opts.version & 0xff,
    (opts.version >> 8) & 0xff,
    capabilities & 0xff,
    (capabilities >> 8) & 0xff,
  ])
  a.byte(...helloReply)
  a.align(4)
  a.label('end')

  const code = a.assemble()
  const entry = a.addressOf('entry')
  const size = a.addressOf('end') - base

  // Fill in what could only be known once the code had been laid out: the entry,
  // the total size, and one table slot per handler.
  const dv = new DataView(code.buffer)
  dv.setUint32(HDR.ENTRY, (entry | 1) >>> 0, true)
  dv.setUint32(HDR.SIZE, size, true)
  for (const h of handlers) {
    dv.setUint16(HDR.TABLE + h.id * 2, a.addressOf(h.label) - base, true)
  }

  if (base + size > STAGING_BANK) {
    throw new Error(`extension runs past the staging bank at ${STAGING_BANK}`)
  }
  return { code, base, version: opts.version, capabilities, entry: entry | 1, helloReply }
}

/**
 * The one edit to the vendor's code: 28 bytes replacing the `LOOP` dispatcher arm.
 *
 * The block is entered two ways, and both have to keep working:
 *
 *  - by fall-through from `abs 0x182a4`, for any opcode the chain did not match
 *  - by the `LIGHT` arm's back-branch at `abs 0x184a6`, which lands at `0x182aa`
 *
 * So `0x182aa` holds a branch to the epilogue and the trampoline sits after it.
 * An unmatched opcode and a non-`LIGHT` `L` frame both reach the epilogue, exactly
 * as stock did; only `J` reaches us. The cost is `LOOP`, which called `set_mode(24)`
 * and stays reachable as `ANIM 19`.
 */
export function buildHook(entryThumb: number): Uint8Array {
  const a = new Asm(HOOK_ADDR)
  a.cmp('r2', OPCODE.charCodeAt(0))
  a.bcond('eq', 'ours')
  if (a.pc !== LIGHT_FALLBACK) {
    throw new Error(`the LIGHT back-branch lands at ${a.pc}, not ${LIGHT_FALLBACK}`)
  }
  a.b(EPILOGUE) //           reached by fall-through and by the LIGHT arm
  a.label('ours')
  a.mov('r0', 'r4') //       the frame struct pointer is the only argument
  a.ldrPool('r1', 'target')
  a.blx('r1')
  a.b(EPILOGUE)
  a.label('target').word(entryThumb)
  // The rest is unreachable: both paths above branch past it. Nops rather than
  // zeros so that if anything ever does land here it slides into the epilogue.
  while (a.size < HOOK_LEN) a.nop()
  const code = a.assemble()
  if (code.length !== HOOK_LEN) {
    throw new Error(`hook is ${code.length} bytes, must be exactly ${HOOK_LEN}`)
  }
  return code
}

/** Read a built image back and report what the header says is in it. */
export function readExtension(plain: Uint8Array, base = EXT_BASE, imageBase = 0x16800) {
  const off = base - imageBase
  if (off + HDR.TABLE > plain.length) return null
  const magic = String.fromCharCode(...plain.subarray(off, off + 4))
  if (magic !== MAGIC) return null
  const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)
  const count = dv.getUint16(off + HDR.TABLE_COUNT, true)
  const subcommands: number[] = []
  for (let i = 0; i < count; i++) {
    if (dv.getUint16(off + HDR.TABLE + i * 2, true) !== 0) subcommands.push(i)
  }
  return {
    magic,
    version: dv.getUint16(off + HDR.VERSION, true),
    capabilities: dv.getUint16(off + HDR.CAPABILITIES, true),
    entry: dv.getUint32(off + HDR.ENTRY, true),
    size: dv.getUint32(off + HDR.SIZE, true),
    subcommands,
  }
}
