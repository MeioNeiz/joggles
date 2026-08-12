#!/usr/bin/env bun
/**
 * Lift the built-in images and animations out of the firmware image, render them, and
 * emit the phone app's catalogue.
 *
 *   bun research/tools/bankdump.ts list            resolved inventory, checked against
 *                                                  research/firmware-internals.md
 *   bun research/tools/bankdump.ts show <id> [n]   one built-in as ASCII, `--all` for
 *                                                  every frame
 *   bun research/tools/bankdump.ts sheet [kind]    every thumbnail, for eyeballing
 *   bun research/tools/bankdump.ts emit [path]     write packages/app/src/builtins-data.ts
 *   bun research/tools/bankdump.ts check [path]    that file still matches the image
 *
 * It reads the OTA container directly (`ota.plaintext()` does the deobfuscation), so
 * there is no decode step to forget, and it **never touches a device**: everything here
 * is a pass over a file. `--image <path>` picks a different container.
 *
 * WHY THIS EXISTS. The 21 built-ins the on-board button cycles are the only content a
 * pair of glasses has when nothing is connected, and until now the app could only offer
 * them as index numbers. Their frames are plain data in the image we have already
 * decoded, so a real preview costs an offline pass and no hardware at all
 * (`notes/what-to-build.md`, "One library to pick from"). The output is checked in as
 * generated source because `firmware/` is gitignored: the phone can never read the
 * image itself.
 *
 * **Nothing here is grep.** Banks are resolved by walking the per-tick dispatch table to
 * each mode's setup function and reading the pointer it loads, the same route
 * `fwtool.ts modes` takes and for the reason in that file's header: bank data is 22.9%
 * of the image and a raw scan for a flash address invents references that are not there.
 * `list` then diffs what it resolved against the table in
 * `research/firmware-internals.md` "Bank inventory" and says so, so a doc that has
 * drifted from the image is a visible failure rather than a silent one.
 *
 * **How a command reaches a bank**, hand-decoded here and agreeing with that file:
 *
 *   ANIM n  ->  set_mode(uxtb(n + 5)).  `abs 0x18506` reads the argument at [r4+6],
 *               `0x18508` adds 5, `0x1850a` truncates it to a byte, `0x1850c` branches
 *               to the `bl set_mode` at `0x185a4` that the IMAG handler also uses. So
 *               the 19 animation banks are modes 5 to 23, i.e. ANIM 0 to ANIM 18.
 *   IMAG n  ->  stores n at RAM `0x2000374e` (`abs 0x1859c`-`0x185a0`) and calls
 *               set_mode(25). Mode 25's tick reads that byte, refuses it at 11
 *               (`cmp #0x0b`, `abs 0x21832`), multiplies by the 72-byte stride and
 *               indexes the bank at `0x265de`. So the eleven images are one bank of
 *               eleven frames selected by index, and that bound is read out of the image
 *               below rather than trusted.
 *
 * That closes the loop the two research files each had half of. It is *derived*, from a
 * hand decode plus the automated walk, and no part of it has been witnessed on a panel.
 *
 * **The one thing to check on hardware before trusting a tap.** The vendor app sends
 * `ANIM 20` to `ANIM 29` for its ten animations (`Agreement.getAnimCommand(i + 20)` in
 * `AnimFragment`, and `research/vendor-app-protocol.md` records that range as verified).
 * Under `n + 5` those are modes 25 to 34, which is the image mode, the type 2 display
 * mode, six oddments, and two values `set_mode` rejects outright at its `cmp #0x21`. Both
 * readings cannot describe the same panel. Either the vendor's animation menu has never
 * addressed the 19 banks the button cycles, or `n + 5` is wrong. The thumbnails this tool
 * emits reduce that to one look: send `ANIM 0` and compare the panel against
 * `show anim-0`. `packages/core/src/protocol.ts`'s `animation()` documents the vendor's
 * +20 as though it were the firmware's rule, which is the reading this file disputes.
 */
import * as ota from '../../packages/core/src/ota.js'

const BASE = 0x16800

/** Per-tick dispatch table. 33 byte offsets; the walk below resolves one. */
const TICK_TABLE = 0x2204a

/** First and last mode with an animation bank of its own. ANIM 0 to ANIM 18. */
const FIRST_ANIM_MODE = 5
const LAST_ANIM_MODE = 23

/** `ANIM n` selects mode n + 5. Hand-decoded at `abs 0x18508`; see the header. */
const ANIM_MODE_OFFSET = 5

/** The mode `IMAG n` selects, which renders frame n of the one image bank. */
const IMAGE_MODE = 25

/** The whole built-in region, `fwtool.ts`'s `BANK_LO`, wider than what we catalogue. */
const REGION_START = 0x22df8

/**
 * The inventory in `research/firmware-internals.md`, "Bank inventory", as read on
 * 2026-08-11: `[mode, bank, frames, bytes per frame]`. Quoted so `list` can diff the
 * document against the image instead of a reader doing it by eye. The image is the
 * authority; a difference means one of the two needs correcting, and the run says which
 * way round it found them.
 *
 * Exported so `bankdump.test.ts` holds it to the image as part of the suite. `list` prints
 * the same diff for a person, and until review-20 that was the only thing that ever ran it.
 */
export const DOCUMENTED: Array<[number, number, number, number]> = [
  [5, 0x22f06, 31, 27],
  [6, 0x2441e, 19, 72],
  [7, 0x2324b, 35, 27],
  [8, 0x235fc, 35, 27],
  [9, 0x239ad, 5, 27],
  [10, 0x24976, 24, 72],
  [11, 0x23a34, 1, 27],
  [12, 0x23a4f, 30, 27],
  [13, 0x25036, 9, 72],
  [14, 0x23d79, 19, 27],
  [15, 0x252be, 26, 72],
  [16, 0x23f7a, 2, 27],
  [17, 0x23fb0, 5, 27],
  [18, 0x25a0e, 10, 72],
  [19, 0x24037, 4, 27],
  [20, 0x240a3, 4, 27],
  [21, 0x2410f, 2, 27],
  [22, 0x24145, 27, 27],
  [23, 0x25cde, 32, 72],
  [IMAGE_MODE, 0x265de, 11, 72],
]

/** Ticks a built-in frame is held for, `cmp r5, #5` at `abs 0x20bf2`, at 50 Hz. */
const TICKS_PER_FRAME = 6
const TICK_MS = 20

/** Milliseconds a built-in holds one frame: 8.3 fps, not the 50 Hz tick. */
export const FRAME_MS = TICKS_PER_FRAME * TICK_MS

const ROWS = 9
const COLS = 24
const GLYPH = [' ', '.', '+', '#']

export type Levels = number[][]

export type Kind = 'animation' | 'image'

/** One bank as the firmware drives it. 19 animations plus the one image bank. */
export interface Bank {
  /** Display mode, which is what `set_mode` takes. */
  mode: number
  kind: Kind
  addr: number
  frames: number
  stride: 27 | 72
}

/** One row of the app's catalogue: something a single command puts on the panel. */
export interface Item {
  id: string
  kind: Kind
  /** The argument to send: `ANIM arg` or `IMAG arg`. */
  arg: number
  mode: number
  bank: Bank
  /** Frames it cycles. Always 1 for an image, which is one frame of a shared bank. */
  frames: number
  /** Which frame of the bank the thumbnail is. */
  thumbFrame: number
}

interface Fw {
  bytes: Uint8Array
  u8: (a: number) => number
  u16: (a: number) => number
  u32: (a: number) => number
  end: number
}

const hx = (n: number) => '0x' + (n >>> 0).toString(16)

export function fromContainer(container: Uint8Array): Fw {
  const bytes = ota.plaintext(container)
  const dv = new DataView(bytes.buffer, bytes.byteOffset)
  return {
    bytes,
    u8: (a) => bytes[a - BASE],
    u16: (a) => dv.getUint16(a - BASE, true),
    u32: (a) => dv.getUint32(a - BASE, true),
    end: BASE + bytes.length,
  }
}

/** Decode a 32-bit Thumb BL/BLX-immediate, returning its target. As `fwtool.ts`. */
function blTarget(fw: Fw, a: number): number | null {
  const hi = fw.u16(a)
  const lo = fw.u16(a + 2)
  if ((hi & 0xf800) !== 0xf000) return null
  if ((lo & 0xd000) !== 0xd000 && (lo & 0xd001) !== 0xc000) return null
  const s = (hi >> 10) & 1
  const i1 = 1 - (((lo >> 13) & 1) ^ s)
  const i2 = 1 - (((lo >> 11) & 1) ^ s)
  let off =
    (s << 24) | (i1 << 23) | (i2 << 22) | ((hi & 0x3ff) << 12) | ((lo & 0x7ff) << 1)
  if (s) off -= 1 << 25
  return a + 4 + off
}

/**
 * The word an `ldr rN, [pc, #imm]` at `a` loads, or null if `a` is not one.
 *
 * The pool address depends on the instruction's own immediate and on `a` being aligned
 * the way the CPU aligns it, which is why this takes the instruction rather than a pool
 * address: handing it the wrong `a` otherwise yields a plausible word from elsewhere in
 * the pool, which is trap 1 in `fwtool.ts`'s header wearing a different hat.
 */
function pcLoad(fw: Fw, a: number): number | null {
  const h = fw.u16(a)
  if ((h & 0xf800) !== 0x4800) return null
  const pool = (((a + 4) >> 2) << 2) + (h & 0xff) * 4
  if (pool < BASE || pool + 4 > fw.end) return null
  return fw.u32(pool)
}

const inFlash = (v: number) => v >= BASE && v < ota.FLASH_DFU_ADDR

/** `target = table + 2 + 2 * table[mode]`, both dispatch tables being byte offsets. */
const tickEntry = (fw: Fw, mode: number) =>
  TICK_TABLE + 2 + 2 * fw.u8(TICK_TABLE + mode)

/**
 * Walk one mode's per-tick entry to its setup function and read the bank it drives.
 *
 * The setup function calls the shared consumer at `abs 0x20be4` as
 * `(frameCount, bank1bpp, bank2bpp, formatFlag)`, so those arguments are loaded in its
 * first few instructions: the first pool word that looks like a flash address is the
 * bank, the first `movs r0` is the frame count, the first `movs r3` is the format flag.
 * Same reading as `fwtool.ts modes`, which is where the register contract was resolved.
 */
function animBank(fw: Fw, mode: number): Bank | null {
  const fn = blTarget(fw, tickEntry(fw, mode))
  if (fn === null) return null
  let addr: number | null = null
  let frames: number | null = null
  let fmt: number | null = null
  for (let a = fn; a < fn + 0x1c; a += 2) {
    const h = fw.u16(a)
    if (addr === null) {
      const word = pcLoad(fw, a)
      if (word !== null && inFlash(word)) addr = word
    }
    if ((h & 0xff00) === 0x2000 && frames === null) frames = h & 0xff
    if ((h & 0xff00) === 0x2300 && fmt === null) fmt = h & 0xff
  }
  if (addr === null || frames === null || fmt === null) return null
  return { mode, kind: 'animation', addr, frames, stride: fmt === 0 ? 27 : 72 }
}

/**
 * The image bank, which needs its own resolver because `IMAG` carries no mode.
 *
 * Mode 25's tick indexes one bank by a RAM byte rather than by a tick counter, so none of
 * the three numbers arrive the way `animBank` reads them. It is anchored on the `muls`,
 * because `index * stride + bank` is the one shape the address arithmetic must have:
 *
 *     ldrb r1, [r0]        the index, from RAM 0x2000374e
 *     cmp  r1, #0xb        eleven images, and out of range shows nothing
 *     movs r1, #0x48       stride
 *     muls r0, r1
 *     ldr  r1, [pc, #n]    the bank
 *     adds r0, r0, r1
 *
 * Scanning for the parts separately took the frame divider's `movs r1, #0` for the stride
 * and would have taken its state pointer for the bank, which is why the anchor earns its
 * place. The frame count is the bound the code refuses the index at, so it comes from the
 * first `cmp` that is not the divider's own compare against 5.
 */
function imageBank(fw: Fw): Bank {
  const fn = blTarget(fw, tickEntry(fw, IMAGE_MODE))
  if (fn === null) throw new Error(`mode ${IMAGE_MODE} has no tick function`)
  const isMuls = (h: number) => (h & 0xffc0) === 0x4340
  const isMovsImm = (h: number) => (h & 0xf800) === 0x2000
  const isCmpImm = (h: number) => (h & 0xf800) === 0x2800

  let count: number | null = null
  let stride: number | null = null
  let addr: number | null = null
  for (let a = fn; a < fn + 0x40; a += 2) {
    const h = fw.u16(a)
    if (isCmpImm(h) && count === null && (h & 0xff) !== TICKS_PER_FRAME - 1) {
      count = h & 0xff
    }
    if (!isMuls(h)) continue
    const before = fw.u16(a - 2)
    if (isMovsImm(before)) stride = before & 0xff
    for (let b = a + 2; b < a + 10 && addr === null; b += 2) {
      const word = pcLoad(fw, b)
      if (word !== null && inFlash(word)) addr = word
    }
    break
  }
  if (count === null || (stride !== 27 && stride !== 72) || addr === null) {
    throw new Error(
      `mode ${IMAGE_MODE} did not decode: count ${count}, stride ${stride}, ` +
        `bank ${addr === null ? 'none' : hx(addr)}`,
    )
  }
  return { mode: IMAGE_MODE, kind: 'image', addr, frames: count, stride }
}

/** Every bank, animations in mode order then the one image bank. Twenty of them. */
export function banks(fw: Fw): Bank[] {
  const out: Bank[] = []
  for (let mode = FIRST_ANIM_MODE; mode <= LAST_ANIM_MODE; mode++) {
    const bank = animBank(fw, mode)
    if (!bank) throw new Error(`mode ${mode} did not resolve to a bank`)
    out.push(bank)
  }
  out.push(imageBank(fw))
  return out
}

/** The id the app knows a built-in by. Derived from what is sent, so it cannot drift. */
export const idOf = (kind: Kind, arg: number): string =>
  kind === 'image' ? `image-${arg}` : `anim-${arg}`

/**
 * The catalogue: images first, then animations.
 *
 * Only the 19 animation banks and the 11 images. Modes 24 and 26 to 32 are reachable as
 * `ANIM 19` and `ANIM 21` to `ANIM 27` and are deliberately absent: 24 is what `LOOP`
 * selects and has no frames of its own, 26 is the type 2 display, and the rest are
 * unwitnessed oddments the vendor app never sends. A row that cannot show a real preview
 * is the list of numbers this whole exercise exists to replace.
 *
 * Images come first because they are the honest thumbnails: one frame each, and what the
 * tile shows is exactly what the panel will.
 */
export function catalogue(fw: Fw): Item[] {
  const all = banks(fw)
  const images = all.find((b) => b.kind === 'image')
  if (!images) throw new Error('no image bank')
  const out: Item[] = []
  for (let i = 0; i < images.frames; i++) {
    out.push({
      id: idOf('image', i),
      kind: 'image',
      arg: i,
      mode: images.mode,
      bank: images,
      frames: 1,
      thumbFrame: i,
    })
  }
  for (const bank of all) {
    if (bank.kind !== 'animation') continue
    const arg = bank.mode - ANIM_MODE_OFFSET
    out.push({
      id: idOf('animation', arg),
      kind: 'animation',
      arg,
      mode: bank.mode,
      bank,
      frames: bank.frames,
      thumbFrame: thumbFrame(fw, bank),
    })
  }

  // Modes 7 and 8 are separate banks that share 19 of their 35 frames, and the most
  // detailed frame is one of the shared ones, so the two would arrive at the same
  // thumbnail. Two identical tiles in a catalogue whose whole purpose is telling
  // built-ins apart is worse than a slightly less good frame, so a collision falls back
  // to the next most detailed frame that nothing else has taken. Images are exempt:
  // their frame is fixed by the index the device is being asked for, not chosen. One pass,
  // so it cannot loop; if a bank ever had every frame taken it would keep its first choice
  // and duplicate, which `emit` would then write and the suite would fail on.
  const taken = new Set<string>()
  for (const item of out) {
    if (item.kind === 'image') {
      taken.add(packThumb(frameAt(fw, item.bank, item.thumbFrame)))
      continue
    }
    const ranked = Array.from({ length: item.frames }, (_, i) => i)
      .map((i) => ({ i, detail: detail(frameAt(fw, item.bank, i)) }))
      .sort((a, b) => b.detail - a.detail || a.i - b.i)
    const free = ranked.find(
      ({ i }) => !taken.has(packThumb(frameAt(fw, item.bank, i))),
    )
    item.thumbFrame = free?.i ?? item.thumbFrame
    taken.add(packThumb(frameAt(fw, item.bank, item.thumbFrame)))
  }
  return out
}

/**
 * One frame as 9 rows of 24 levels, row 0 the bottom of the panel.
 *
 * Both formats, and the mapping is the one `research/firmware-internals.md` records
 * under "The built-in banks decode offline". The 27-byte format is 1 bit per pixel: data
 * bits 0 to 6 are rows 1 to 7, bit 7 is row 8, and a separate 24-bit mask supplies row 0,
 * so a lit pixel is level 3 and there is nothing in between. The 72-byte format is three
 * little-endian bytes per column, 2 bits per pixel, and does use the greys.
 */
export function decodeFrame(bytes: Uint8Array, stride: 27 | 72): Levels {
  const px: Levels = Array.from({ length: ROWS }, () => new Array(COLS).fill(0))
  if (stride === 72) {
    for (let c = 0; c < COLS; c++) {
      const w = bytes[c * 3] | (bytes[c * 3 + 1] << 8) | (bytes[c * 3 + 2] << 16)
      for (let r = 0; r < ROWS; r++) px[r][c] = (w >> (2 * r)) & 3
    }
    return px
  }
  const mask = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)
  for (let c = 0; c < COLS; c++) {
    px[0][c] = (mask >> c) & 1 ? 3 : 0
    for (let r = 1; r <= 7; r++) px[r][c] = (bytes[c] >> (r - 1)) & 1 ? 3 : 0
    px[8][c] = (bytes[c] >> 7) & 1 ? 3 : 0
  }
  return px
}

/** Frame `i` of a bank. The bank's own frame count is the only bound on `i`. */
export function frameAt(fw: Fw, bank: Bank, i: number): Levels {
  const start = bank.addr - BASE + i * bank.stride
  return decodeFrame(fw.bytes.subarray(start, start + bank.stride), bank.stride)
}

/**
 * How much structure a frame has: neighbouring pixels that differ, across and up.
 *
 * A blank frame and an all-lit frame both score zero, which is the property that matters.
 */
export function detail(levels: Levels): number {
  let edges = 0
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (c + 1 < COLS && levels[r][c] !== levels[r][c + 1]) edges++
      if (r + 1 < ROWS && levels[r][c] !== levels[r + 1][c]) edges++
    }
  }
  return edges
}

/**
 * Which frame stands for an animation: the one with the most structure in it.
 *
 * Frame 0 is the wrong answer, because several banks open on nothing much: mode 6 starts
 * as a centred 2x2 block and only resolves into lettering nine frames in, so frame 0 would
 * put a four-pixel thumbnail beside a word.
 *
 * The most **ink** is also the wrong answer, and that is worth recording because it is the
 * obvious one. Mode 6 fills the whole panel on its way through, and several of the text
 * banks pass through a fully lit frame with the lettering knocked out of it, so "most lit
 * pixels" reliably picks the single frame that shows least: a white rectangle. Counting
 * edges instead scores a blank frame and a full frame identically at zero and picks the
 * frame a person would recognise the animation by. Earliest frame on a tie, so the choice
 * is stable across runs.
 */
export function thumbFrame(fw: Fw, bank: Bank): number {
  let best = 0
  let most = -1
  for (let i = 0; i < bank.frames; i++) {
    const v = detail(frameAt(fw, bank, i))
    if (v > most) {
      most = v
      best = i
    }
  }
  return best
}

/**
 * A thumbnail as one string of 216 digits, row 0 (the bottom of the panel) first.
 *
 * `builtins.ts` unpacks it and its test pins the format from the other side.
 * Deliberately not nested JSON arrays: this file is generated and read by people diffing
 * it, and 30 rows of arrays is 60 KB of noise where this is 6.5 KB.
 */
export const packThumb = (levels: Levels): string =>
  levels.map((row) => row.join('')).join('')

/**
 * Whether a built-in ever lights a pixel at level 1 or 2, over all of its frames.
 *
 * Asked of every frame rather than of the thumbnail, because it is a claim about the
 * built-in: a 1bpp bank cannot do it at all, and a 2bpp one may only reach for grey in
 * frames the thumbnail is not. It matters to a person for the reason grey always matters
 * here, that the device's lasting save cannot keep it.
 */
export function usesGrey(fw: Fw, item: Item): boolean {
  const frames =
    item.kind === 'image'
      ? [item.thumbFrame]
      : Array.from({ length: item.frames }, (_, i) => i)
  return frames.some((i) =>
    frameAt(fw, item.bank, i).some((row) => row.some((v) => v === 1 || v === 2)),
  )
}

const asciiFrame = (levels: Levels): string[] =>
  Array.from({ length: ROWS }, (_, i) => {
    const row = levels[ROWS - 1 - i]
    return '   |' + row.map((v) => GLYPH[v] ?? '?').join('') + '|'
  })

const seconds = (frames: number) => ((frames * FRAME_MS) / 1000).toFixed(1)

const sends = (item: Item) =>
  item.kind === 'image' ? `IMAG ${item.arg}` : `ANIM ${item.arg}`

/**
 * The inventory, and whether the quoted document still agrees with the image.
 *
 * The caller exits non-zero on a disagreement: "visible failure rather than a silent one"
 * has to mean an exit code as well as a printed line, or a run inside a script says
 * nothing. `bankdump.test.ts` asserts the same thing without a person present.
 */
function listing(fw: Fw): { lines: string[]; agrees: boolean } {
  const all = banks(fw)
  const out: string[] = []
  out.push('mode | send | bank | frames | B/frame | bytes')
  out.push('--- | --- | --- | --- | --- | ---')
  for (const b of all) {
    const send =
      b.kind === 'image'
        ? `IMAG 0-${b.frames - 1}`
        : `ANIM ${b.mode - ANIM_MODE_OFFSET}`
    out.push(
      [b.mode, send, hx(b.addr), b.frames, b.stride, b.stride * b.frames].join(' | '),
    )
  }

  out.push('')
  out.push('Against research/firmware-internals.md, "Bank inventory":')
  let disagreements = 0
  for (const [mode, addr, frames, stride] of DOCUMENTED) {
    const got = all.find((b) => b.mode === mode)
    if (!got) {
      out.push(`  mode ${mode}: documented, and this run resolved no bank for it`)
      disagreements++
      continue
    }
    if (got.addr !== addr || got.frames !== frames || got.stride !== stride) {
      out.push(
        `  mode ${mode}: doc says ${hx(addr)} ${frames}x${stride}, ` +
          `image says ${hx(got.addr)} ${got.frames}x${got.stride}`,
      )
      disagreements++
    }
  }
  out.push(
    disagreements === 0
      ? `  all ${DOCUMENTED.length} rows agree`
      : `  ${disagreements} disagreement(s)`,
  )

  // Contiguity is what shows the map is complete rather than merely self-consistent: a
  // bank we failed to resolve would leave a hole and a wrong length would overlap.
  const spans = all
    .map((b) => ({ lo: b.addr, hi: b.addr + b.stride * b.frames, mode: b.mode }))
    .sort((a, b) => a.lo - b.lo)
  const holes: string[] = []
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].lo !== spans[i - 1].hi) {
      holes.push(
        `${hx(spans[i - 1].hi)} to ${hx(spans[i].lo)}, between modes ` +
          `${spans[i - 1].mode} and ${spans[i].mode}`,
      )
    }
  }
  const bytes = spans.reduce((n, s) => n + (s.hi - s.lo), 0)
  out.push('')
  out.push(
    `${spans.length} banks, ${bytes} bytes, ${hx(spans[0].lo)} to ${hx(spans.at(-1)!.hi)}`,
  )
  out.push(
    holes.length === 0
      ? '  exactly contiguous, so nothing between them is unaccounted for'
      : `  gaps: ${holes.join('; ')}`,
  )
  out.push(
    `  the region starts at ${hx(REGION_START)} and also holds modes 27, 28 and 32, ` +
      'which this tool does not catalogue',
  )
  out.push(
    `  a frame is held ${FRAME_MS}ms (8.3 fps), so the longest of these is a ` +
      `${seconds(Math.max(...all.map((b) => (b.kind === 'animation' ? b.frames : 0))))}s loop`,
  )
  return { lines: out, agrees: disagreements === 0 && holes.length === 0 }
}

const DEFAULT_OUT = 'packages/app/src/builtins-data.ts'
const DEFAULT_IMAGE = 'firmware/TR1906R04-10_OTA.bin'

/**
 * The generated module, as text.
 *
 * `check` compares the whole file, so this has to be deterministic: no timestamp, no
 * image path, nothing that changes between two runs over the same bytes. The version
 * string comes from the image's own header.
 */
export function emitText(fw: Fw, version: string): string {
  const rows = catalogue(fw).map((item) => {
    const thumb = packThumb(frameAt(fw, item.bank, item.thumbFrame))
    const fields = [
      `id: '${item.id}'`,
      `kind: '${item.kind}'`,
      `arg: ${item.arg}`,
      `mode: ${item.mode}`,
      `frames: ${item.frames}`,
      `thumbFrame: ${item.thumbFrame}`,
      `bank: ${hx(item.bank.addr)}`,
      `grey: ${usesGrey(fw, item)}`,
    ].join(', ')
    return `  { ${fields}, thumb: '${thumb}' },`
  })
  return [
    '/**',
    ` * GENERATED by \`bun research/tools/bankdump.ts emit\` from ${version}.`,
    ' * Do not edit: `bankdump.ts check` fails if this file has drifted from the image.',
    ' *',
    ' * The built-in images and animations, lifted out of the firmware image. Checked in',
    ' * because `firmware/` is gitignored and the phone cannot read the image itself. The',
    ' * tool that wrote it explains the decode, the addressing, and what is unwitnessed.',
    ' *',
    ' * `thumb` is 216 digits, 9 rows of 24 levels, row 0 the bottom of the panel.',
    ' * `builtins.ts` unpacks and names these; nothing here is user-facing text.',
    ' */',
    "import type { BuiltinRow } from './builtins.js'",
    '',
    'export const BUILTIN_ROWS: BuiltinRow[] = [',
    ...rows,
    ']',
    '',
  ].join('\n')
}

async function container(path: string): Promise<Uint8Array> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    console.error(`no OTA container at ${path}`)
    console.error('firmware/ is gitignored, so name one with --image <path>')
    process.exit(2)
  }
  return new Uint8Array(await file.arrayBuffer())
}

async function main(argv: string[]) {
  let imagePath = DEFAULT_IMAGE
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--image') {
      rest.push(argv[i])
      continue
    }
    const next = argv[++i]
    if (!next) {
      console.error('--image needs a path')
      process.exit(2)
    }
    imagePath = next
  }

  const [cmd, ...args] = rest
  if (!cmd) {
    console.log('usage: bankdump.ts <list|show|sheet|emit|check> [args] [--image <path>]')
    console.log('see the header comment for what each one reads and writes')
    process.exit(2)
  }

  const bin = await container(imagePath)
  const fw = fromContainer(bin)

  if (cmd === 'list') {
    const { lines, agrees } = listing(fw)
    for (const line of lines) console.log(line)
    if (!agrees) process.exit(1)
    return
  }

  if (cmd === 'show') {
    const items = catalogue(fw)
    const item = items.find((i) => i.id === args[0])
    if (!item) {
      console.error(`no built-in called ${args[0]}. Try \`list\` or \`sheet\`.`)
      process.exit(2)
    }
    const numbered = args[1] && !args[1].startsWith('--') ? Number(args[1]) : null
    const frames = args.includes('--all')
      ? Array.from({ length: item.frames }, (_, i) => i)
      : [numbered ?? 0]
    console.log(
      `${item.id}  ${sends(item)}  mode ${item.mode}  ${hx(item.bank.addr)}  ` +
        `${item.frames} frame(s), ${seconds(item.frames)}s a cycle`,
    )
    for (const i of frames) {
      if (!Number.isInteger(i) || i < 0 || i >= item.frames) {
        console.error(`frame ${i} is outside 0..${item.frames - 1}`)
        process.exit(2)
      }
      // An image is one frame of a shared bank, so its own frame 0 is the bank's `arg`.
      const at = item.kind === 'image' ? item.thumbFrame : i
      console.log(`\n  frame ${i} of ${item.frames}, bank frame ${at}`)
      for (const line of asciiFrame(frameAt(fw, item.bank, at))) console.log(line)
    }
    return
  }

  if (cmd === 'sheet') {
    const kind = args[0]
    if (kind && kind !== 'image' && kind !== 'animation') {
      console.error(`sheet takes "image" or "animation", not ${kind}`)
      process.exit(2)
    }
    for (const item of catalogue(fw)) {
      if (kind && item.kind !== kind) continue
      const of =
        item.kind === 'animation'
          ? `, thumb is frame ${item.thumbFrame} of ${item.frames}`
          : ''
      console.log(`\n  ${item.id}  ${sends(item)}  mode ${item.mode}${of}`)
      for (const line of asciiFrame(frameAt(fw, item.bank, item.thumbFrame))) {
        console.log(line)
      }
    }
    return
  }

  if (cmd === 'emit' || cmd === 'check') {
    const path = args[0] ?? DEFAULT_OUT
    const header = ota.parseHeader(bin)
    const text = emitText(fw, `${ota.DEVICE_VERSION} app ${header.appVer}`)
    if (cmd === 'emit') {
      await Bun.write(path, text)
      console.log(`wrote ${path}: ${catalogue(fw).length} built-ins, ${text.length} bytes`)
      console.log('`bun test packages/app/src` next: builtins.test.ts checks the shape')
      return
    }
    const existing = Bun.file(path)
    if (!(await existing.exists())) {
      console.error(`${path} does not exist. Run \`emit\`.`)
      process.exit(1)
    }
    if ((await existing.text()) === text) {
      console.log(`${path} matches ${imagePath}`)
      return
    }
    console.error(`${path} DIFFERS from what ${imagePath} produces.`)
    console.error('Either it was hand-edited or it was emitted from another image.')
    console.error('`emit` overwrites it; nothing here does that for you.')
    process.exit(1)
  }

  console.error(`unknown command ${cmd}`)
  process.exit(2)
}

if (import.meta.main) await main(process.argv.slice(2))
