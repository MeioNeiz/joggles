/**
 * The fixtures here are assembled byte by byte, LZW encoder included, so every test
 * states the exact bytes it asserts about and no binary blob hides a claim. The cost is
 * that encoder and decoder are the same hand and could share a misreading: the raw
 * hand-packed LZW streams near the bottom pin the bit order and the error paths without
 * the encoder in the loop, and the interlace test proves the flag changed the bytes.
 */
import { expect, test } from 'bun:test'
import type { RgbaFrame } from './anim.js'
import { MAX_CANVAS_PIXELS, decodeGif, isGif } from './gif.js'

// --- fixture assembly -----------------------------------------------------------

const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff]
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))

/**
 * A GIF-side LZW encoder. Mirrors the decoder's widening rule from the other side:
 * the encoder widens when the entry it just added lands on a power of two, which is
 * one entry ahead of when the decoder does, and that is the correct offset because
 * the decoder learns each entry one code late. `full` reports the dictionary hitting
 * 4096 with no clear emitted, which is exactly the deferred-clear stream shape.
 */
function lzwEncode(
  minCodeSize: number,
  pixels: number[],
): { data: Uint8Array; full: boolean } {
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  const dict = new Map<string, number>()
  const out: number[] = []
  let next = eoi + 1
  let width = minCodeSize + 1
  let full = false
  let acc = 0
  let accBits = 0
  const emit = (code: number) => {
    acc |= code << accBits
    accBits += width
    while (accBits >= 8) {
      out.push(acc & 0xff)
      acc >>>= 8
      accBits -= 8
    }
  }
  emit(clear)
  let seqKey = ''
  let seqCode = -1
  let emitted = 0
  for (const px of pixels) {
    if (seqKey === '') {
      seqKey = String(px)
      seqCode = px
      continue
    }
    const key = `${seqKey},${px}`
    const hit = dict.get(key)
    if (hit !== undefined) {
      seqKey = key
      seqCode = hit
      continue
    }
    emit(seqCode)
    emitted += 1
    if (next < 4096) {
      dict.set(key, next)
      next += 1
      if (next - 1 === 1 << width && width < 12) width += 1
    } else {
      full = true
    }
    seqKey = String(px)
    seqCode = px
  }
  if (seqCode !== -1) {
    emit(seqCode)
    // The decoder adds one more entry on reading this code (unless it is the first
    // after the clear), and may widen before it reads the EOI. Mirror that.
    if (emitted > 0 && next < 4096) {
      next += 1
      if (next - 1 === 1 << width && width < 12) width += 1
    }
  }
  emit(eoi)
  if (accBits > 0) out.push(acc & 0xff)
  return { data: new Uint8Array(out), full }
}

const interlaceRows = (h: number): number[] => {
  const rows: number[] = []
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]] as const) {
    for (let y = start; y < h; y += step) rows.push(y)
  }
  return rows
}

function packSubBlocks(data: Uint8Array): number[] {
  const out: number[] = []
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, i + 255)
    out.push(chunk.length, ...chunk)
  }
  out.push(0)
  return out
}

/** Pad a palette up to a power of two and say which size field that is. */
function tableBytes(pal: number[][]): { bytes: number[]; sizeField: number } {
  let entries = 2
  let field = 0
  while (entries < pal.length) {
    entries *= 2
    field += 1
  }
  const bytes: number[] = []
  for (let i = 0; i < entries; i++) bytes.push(...(pal[i] ?? [0, 0, 0]))
  return { bytes, sizeField: field }
}

function codeSizeFor(pal: number[][] | undefined, override?: number): number {
  if (override !== undefined) return override
  let bits = 2
  while (pal && 1 << bits < pal.length) bits += 1
  return bits
}

interface FrameSpec {
  left?: number
  top?: number
  width: number
  height: number
  /** Palette indices, natural row order, row 0 the top. */
  pixels: number[]
  palette?: number[][]
  interlaced?: boolean
  gce?: { delayCs?: number; disposal?: number; transparent?: number }
  minCodeSize?: number
  /** Raw LZW bytes instead of encoding `pixels`; for pinning malformed streams. */
  rawLzw?: number[]
}

interface GifSpec {
  width: number
  height: number
  palette?: number[][]
  background?: number
  frames: FrameSpec[]
  netscape?: boolean
  comment?: string
}

function buildGif(spec: GifSpec): Uint8Array {
  const out: number[] = ascii('GIF89a')
  const global = spec.palette ? tableBytes(spec.palette) : null
  out.push(...u16(spec.width), ...u16(spec.height))
  out.push(global ? 0x80 | global.sizeField : 0, spec.background ?? 0, 0)
  if (global) out.push(...global.bytes)
  if (spec.comment !== undefined) {
    out.push(0x21, 0xfe, spec.comment.length, ...ascii(spec.comment), 0)
  }
  if (spec.netscape) {
    out.push(0x21, 0xff, 11, ...ascii('NETSCAPE2.0'), 3, 1, ...u16(0), 0)
  }
  for (const f of spec.frames) {
    if (f.gce) {
      const packed =
        ((f.gce.disposal ?? 0) << 2) | (f.gce.transparent !== undefined ? 1 : 0)
      const tail = [f.gce.transparent ?? 0, 0]
      out.push(0x21, 0xf9, 4, packed, ...u16(f.gce.delayCs ?? 0), ...tail)
    }
    const local = f.palette ? tableBytes(f.palette) : null
    out.push(0x2c, ...u16(f.left ?? 0), ...u16(f.top ?? 0))
    out.push(...u16(f.width), ...u16(f.height))
    out.push((local ? 0x80 | local.sizeField : 0) | (f.interlaced ? 0x40 : 0))
    if (local) out.push(...local.bytes)
    const minCode = codeSizeFor(f.palette ?? spec.palette, f.minCodeSize)
    out.push(minCode)
    if (f.rawLzw) {
      out.push(f.rawLzw.length, ...f.rawLzw, 0)
    } else {
      const pixels = f.interlaced
        ? interlaceRows(f.height).flatMap((y) =>
            f.pixels.slice(y * f.width, (y + 1) * f.width),
          )
        : f.pixels
      out.push(...packSubBlocks(lzwEncode(minCode, pixels).data))
    }
  }
  out.push(0x3b)
  return new Uint8Array(out)
}

// --- assertion helpers ----------------------------------------------------------

const px = (f: RgbaFrame, x: number, y: number): number[] => [
  ...f.data.subarray((y * f.width + x) * 4, (y * f.width + x) * 4 + 4),
]

/** With palettes shaped [i, 0, 0], the red channel reads the index back out. */
const reds = (f: RgbaFrame): number[] => {
  const out: number[] = []
  for (let i = 0; i < f.data.length; i += 4) out.push(f.data[i])
  return out
}

const identityPalette = (n: number): number[][] =>
  Array.from({ length: n }, (_, i) => [i, 0, 0])

/** Deterministic xorshift32, so the incompressible fixtures are stable bytes. */
function noise(n: number, mod: number): number[] {
  let s = 0x9e3779b9
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    s ^= (s << 13) >>> 0
    s >>>= 0
    s ^= s >>> 17
    s ^= (s << 5) >>> 0
    s >>>= 0
    out.push(s % mod)
  }
  return out
}

const BLACK = [0, 0, 0]
const RED = [255, 0, 0]
const GREEN = [0, 255, 0]
const BLUE = [0, 0, 255]

// --- the format ------------------------------------------------------------------

test('isGif accepts both signatures and nothing else', () => {
  expect(isGif(new Uint8Array(ascii('GIF89a')))).toBe(true)
  expect(isGif(new Uint8Array(ascii('GIF87a')))).toBe(true)
  expect(isGif(new Uint8Array(ascii('GIF88a')))).toBe(false)
  expect(isGif(new Uint8Array(ascii('GIF8')))).toBe(false)
  expect(isGif(new Uint8Array(0))).toBe(false)
})

test('a single frame decodes to its palette colours, row 0 the top', () => {
  const g = buildGif({
    width: 4,
    height: 2,
    palette: [BLACK, [255, 80, 8]],
    frames: [{ width: 4, height: 2, pixels: [0, 1, 0, 1, 1, 0, 1, 0] }],
  })
  const frames = decodeGif(g)
  expect(frames.length).toBe(1)
  const f = frames[0]
  expect(f.width).toBe(4)
  expect(f.height).toBe(2)
  expect(f.delayMs).toBe(0)
  expect(px(f, 0, 0)).toEqual([0, 0, 0, 255])
  expect(px(f, 1, 0)).toEqual([255, 80, 8, 255])
  expect(px(f, 0, 1)).toEqual([255, 80, 8, 255])
  expect(px(f, 3, 1)).toEqual([0, 0, 0, 255])
})

test('LZW round-trips incompressible data through the code width growth', () => {
  const pixels = noise(256, 16)
  const g = buildGif({
    width: 32,
    height: 8,
    palette: identityPalette(16),
    frames: [{ width: 32, height: 8, pixels }],
  })
  expect(reds(decodeGif(g)[0])).toEqual(pixels)
})

test('a run of one value round-trips, which is the KwKwK code path', () => {
  const pixels = new Array(12).fill(1)
  const g = buildGif({
    width: 12,
    height: 1,
    palette: [[5, 0, 0], [200, 0, 0]],
    frames: [{ width: 12, height: 1, pixels }],
  })
  const f = decodeGif(g)[0]
  expect(reds(f)).toEqual(new Array(12).fill(200))
  expect(px(f, 11, 0)[3]).toBe(255)
})

test('deferred clear: a full dictionary decodes without another clear code', () => {
  const pixels = noise(12000, 256)
  // The claim only holds if the dictionary really filled; assert it, do not hope.
  expect(lzwEncode(8, pixels).full).toBe(true)
  const g = buildGif({
    width: 120,
    height: 100,
    palette: identityPalette(256),
    frames: [{ width: 120, height: 100, pixels }],
  })
  expect(reds(decodeGif(g)[0])).toEqual(pixels)
})

test('an interlaced frame comes back in natural row order', () => {
  const w = 4
  const h = 11
  const pixels: number[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels.push(y)
  const spec = (interlaced: boolean) => ({
    width: w,
    height: h,
    palette: identityPalette(16),
    frames: [{ width: w, height: h, pixels, interlaced }],
  })
  const g = buildGif(spec(true))
  expect(reds(decodeGif(g)[0])).toEqual(pixels)
  // Prove the flag reordered the stream, or the assertion above is vacuous.
  expect([...g]).not.toEqual([...buildGif(spec(false))])
})

test('delays convert hundredths to ms, and 0 passes through as 0', () => {
  const g = buildGif({
    width: 1,
    height: 1,
    palette: [BLACK, RED],
    frames: [
      { width: 1, height: 1, pixels: [0], gce: { delayCs: 7 } },
      { width: 1, height: 1, pixels: [1], gce: { delayCs: 0 } },
      { width: 1, height: 1, pixels: [0] },
    ],
  })
  const [a, b, c] = decodeGif(g)
  expect(a.delayMs).toBe(70)
  expect(b.delayMs).toBe(0) // anim.normalise owns the 0 -> 100 policy, not the decoder
  expect(c.delayMs).toBe(0) // no GCE at all also reads as 0
})

// --- compositing and disposal -----------------------------------------------------

test('transparent pixels let the previous frame show through', () => {
  const g = buildGif({
    width: 4,
    height: 1,
    palette: [BLACK, RED, GREEN, BLUE],
    frames: [
      { width: 4, height: 1, pixels: [1, 1, 1, 1] },
      { width: 4, height: 1, pixels: [0, 2, 0, 0], gce: { transparent: 0 } },
    ],
  })
  const f = decodeGif(g)[1]
  expect(px(f, 0, 0)).toEqual([...RED, 255])
  expect(px(f, 1, 0)).toEqual([...GREEN, 255])
  expect(px(f, 2, 0)).toEqual([...RED, 255])
  expect(px(f, 3, 0)).toEqual([...RED, 255])
})

test('transparency on the first frame leaves the canvas unpainted', () => {
  const g = buildGif({
    width: 2,
    height: 1,
    palette: [BLACK, RED],
    frames: [{ width: 2, height: 1, pixels: [0, 1], gce: { transparent: 0 } }],
  })
  const f = decodeGif(g)[0]
  expect(px(f, 0, 0)[3]).toBe(0)
  expect(px(f, 1, 0)).toEqual([...RED, 255])
})

test('a patch frame comes back canvas-sized, the rest transparent not background', () => {
  const g = buildGif({
    width: 6,
    height: 4,
    palette: [BLACK, RED],
    background: 1, // a loud background index that must not get painted
    frames: [{ left: 3, top: 2, width: 2, height: 1, pixels: [1, 1] }],
  })
  const f = decodeGif(g)[0]
  expect(f.data.length).toBe(6 * 4 * 4)
  expect(px(f, 3, 2)).toEqual([...RED, 255])
  expect(px(f, 4, 2)).toEqual([...RED, 255])
  expect(px(f, 0, 0)[3]).toBe(0)
  expect(px(f, 5, 3)[3]).toBe(0)
})

test('disposal 1 leaves the previous frame in place', () => {
  const g = buildGif({
    width: 4,
    height: 1,
    palette: [BLACK, RED, GREEN, BLUE],
    frames: [
      { width: 4, height: 1, pixels: [1, 1, 1, 1], gce: { disposal: 1 } },
      { width: 1, height: 1, pixels: [2] },
    ],
  })
  const f = decodeGif(g)[1]
  expect(px(f, 0, 0)).toEqual([...GREEN, 255])
  expect(px(f, 1, 0)).toEqual([...RED, 255])
  expect(px(f, 3, 0)).toEqual([...RED, 255])
})

test('disposal 2 clears only that frame rectangle, and clears to transparent', () => {
  const g = buildGif({
    width: 4,
    height: 1,
    palette: [BLACK, RED, GREEN, BLUE],
    background: 1, // again: the cleared area must be alpha 0, not this red
    frames: [
      { width: 4, height: 1, pixels: [1, 1, 1, 1] },
      { left: 1, width: 2, height: 1, pixels: [3, 3], gce: { disposal: 2 } },
      { left: 1, width: 1, height: 1, pixels: [2] },
    ],
  })
  const [, f2, f3] = decodeGif(g)
  expect(px(f2, 1, 0)).toEqual([...BLUE, 255])
  expect(px(f2, 2, 0)).toEqual([...BLUE, 255])
  expect(px(f3, 0, 0)).toEqual([...RED, 255]) // outside the rect: untouched
  expect(px(f3, 1, 0)).toEqual([...GREEN, 255])
  expect(px(f3, 2, 0)[3]).toBe(0) // inside the rect: transparent, not background
  expect(px(f3, 3, 0)).toEqual([...RED, 255])
})

test('disposal 3 and its Blink alias 4 restore what was under the frame', () => {
  for (const disposal of [3, 4]) {
    const g = buildGif({
      width: 4,
      height: 1,
      palette: [BLACK, RED, GREEN, BLUE],
      frames: [
        { width: 4, height: 1, pixels: [1, 1, 1, 1] },
        { left: 1, width: 2, height: 1, pixels: [3, 3], gce: { disposal } },
        { left: 3, width: 1, height: 1, pixels: [2] },
      ],
    })
    const [, f2, f3] = decodeGif(g)
    expect(px(f2, 1, 0)).toEqual([...BLUE, 255])
    expect(px(f3, 1, 0)).toEqual([...RED, 255]) // blue patch gone, red restored
    expect(px(f3, 2, 0)).toEqual([...RED, 255])
    expect(px(f3, 3, 0)).toEqual([...GREEN, 255])
  }
})

test('a local colour table overrides the global for its frame only', () => {
  const g = buildGif({
    width: 1,
    height: 1,
    palette: [BLACK, RED],
    frames: [
      { width: 1, height: 1, pixels: [1] },
      { width: 1, height: 1, pixels: [1], palette: [BLACK, BLUE] },
    ],
  })
  const [f1, f2] = decodeGif(g)
  expect(px(f1, 0, 0)).toEqual([...RED, 255])
  expect(px(f2, 0, 0)).toEqual([...BLUE, 255])
})

test('a pixel index outside the colour table paints nothing', () => {
  // Two-entry table, but minimum code size 2 makes literals 0..3 legal LZW, so an
  // encoder can name colours that do not exist. Renderers paint nothing; so do we.
  const g = buildGif({
    width: 2,
    height: 1,
    palette: [BLACK, RED],
    frames: [{ width: 2, height: 1, pixels: [1, 3] }],
  })
  const f = decodeGif(g)[0]
  expect(px(f, 0, 0)).toEqual([...RED, 255])
  expect(px(f, 1, 0)[3]).toBe(0)
})

test('comment and application extensions are skipped cleanly', () => {
  const g = buildGif({
    width: 2,
    height: 1,
    palette: [BLACK, RED],
    comment: 'made by hand',
    netscape: true,
    frames: [{ width: 2, height: 1, pixels: [1, 0] }],
  })
  expect(decodeGif(g).length).toBe(1)
})

test('stray zero bytes between blocks are tolerated, as renderers do', () => {
  const g = buildGif({
    width: 1,
    height: 1,
    palette: [BLACK, RED],
    frames: [{ width: 1, height: 1, pixels: [1] }],
  })
  const padded = new Uint8Array([...g.subarray(0, g.length - 1), 0, 0, 0x3b])
  expect(px(decodeGif(padded)[0], 0, 0)).toEqual([...RED, 255])
})

test('a zero logical screen grows to cover the frames', () => {
  const g = buildGif({
    width: 0,
    height: 0,
    palette: [BLACK, RED],
    frames: [{ width: 3, height: 2, pixels: [1, 1, 1, 1, 1, 1] }],
  })
  const f = decodeGif(g)[0]
  expect(f.width).toBe(3)
  expect(f.height).toBe(2)
})

// --- refusals ---------------------------------------------------------------------

test('every truncation of a two-frame GIF throws, never a partial animation', () => {
  const g = buildGif({
    width: 3,
    height: 2,
    palette: [BLACK, RED, GREEN, BLUE],
    comment: 'x',
    frames: [
      { width: 3, height: 2, pixels: [1, 2, 3, 0, 1, 2], gce: { delayCs: 5 } },
      { width: 2, height: 1, pixels: [3, 3], palette: [BLACK, RED, GREEN, BLUE] },
    ],
  })
  expect(decodeGif(g).length).toBe(2) // whole file is good; now every strict prefix
  for (let n = 0; n < g.length; n++) {
    expect(() => decodeGif(g.subarray(0, n))).toThrow()
  }
})

test('a wrong signature throws', () => {
  expect(() => decodeGif(new Uint8Array(ascii('GIF88a')))).toThrow(/GIF8/)
})

test('an LZW code naming a dictionary entry that does not exist throws', () => {
  // Width 3 after min code size 2; 0b111 reads as code 7 with only 0..6 defined.
  const g = buildGif({
    width: 2,
    height: 1,
    palette: [BLACK, RED],
    frames: [{ width: 2, height: 1, pixels: [], minCodeSize: 2, rawLzw: [0b111] }],
  })
  expect(() => decodeGif(g)).toThrow(/dictionary/)
})

test('an end-of-information code short of the pixel count throws', () => {
  // 0x2c LSB-first at width 3 is code 4 (clear) then code 5 (EOI), zero pixels out.
  const g = buildGif({
    width: 2,
    height: 1,
    palette: [BLACK, RED],
    frames: [{ width: 2, height: 1, pixels: [], minCodeSize: 2, rawLzw: [0x2c] }],
  })
  expect(() => decodeGif(g)).toThrow(/short/)
})

test('a frame with no colour table anywhere throws', () => {
  const g = buildGif({
    width: 2,
    height: 1,
    frames: [{ width: 2, height: 1, pixels: [0, 0], minCodeSize: 2 }],
  })
  expect(() => decodeGif(g)).toThrow(/colour table/)
})

test('a GIF with no image data throws', () => {
  const g = buildGif({ width: 1, height: 1, palette: [BLACK, RED], frames: [] })
  expect(() => decodeGif(g)).toThrow(/no image data/)
})

test('a hostile logical screen size is refused before allocating', () => {
  const g = buildGif({
    width: 65535,
    height: 65535,
    palette: [BLACK, RED],
    frames: [{ width: 1, height: 1, pixels: [1] }],
  })
  expect(() => decodeGif(g)).toThrow(new RegExp(String(MAX_CANVAS_PIXELS)))
})

test('a hostile frame size is refused at its descriptor', () => {
  const g = buildGif({
    width: 4,
    height: 4,
    palette: [BLACK, RED],
    frames: [{ width: 65535, height: 65535, pixels: [], rawLzw: [0] }],
  })
  expect(() => decodeGif(g)).toThrow(new RegExp(String(MAX_CANVAS_PIXELS)))
})
