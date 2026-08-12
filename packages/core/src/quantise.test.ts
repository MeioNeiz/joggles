import { expect, test } from 'bun:test'
import type { RgbaFrame } from './anim.js'
import { alive } from './display.js'
import { packBitmap, toAnimation, toBitmap, unpackBitmap } from './quantise.js'

const rgba = (
  w: number,
  h: number,
  at: (x: number, y: number) => [number, number, number, number],
  delayMs = 0,
): RgbaFrame => {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = at(x, y)
      const p = (y * w + x) * 4
      data[p] = r
      data[p + 1] = g
      data[p + 2] = b
      data[p + 3] = a
    }
  }
  return { width: w, height: h, data, delayMs }
}

const grey = (byte: number, a = 255) => rgba(24, 9, () => [byte, byte, byte, a])

/** The distinct levels across cells that physically exist. Dead cells lie: always 0. */
const aliveLevels = (b: number[][]): Set<number> => {
  const out = new Set<number>()
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 24; c++) {
      if (alive(r, c)) out.add(b[r][c])
    }
  }
  return out
}

// A 24-column ramp, dark at the left. Mid greys everywhere, so every dither has work.
const gradient = () => rgba(24, 9, (x) => {
  const v = Math.round((x * 255) / 23)
  return [v, v, v, 255]
})

test('known greys land at known levels', () => {
  // sRGB grey round-trips the gamma decode/encode, so byte/255 is the perceptual
  // value and the level is floor(v * 3 + 0.5): the arithmetic, checked end to end.
  for (const [byte, level] of [
    [0, 0],
    [64, 1],
    [128, 2],
    [230, 3],
    [255, 3],
  ] as const) {
    const b = toBitmap(grey(byte), { fit: 'stretch', dither: 'none' })
    expect(b[4][0]).toBe(level)
  }
})

test('alpha composites over black, not white', () => {
  const at = (a: number) =>
    toBitmap(grey(255, a), { fit: 'stretch', dither: 'none' })[4][0]
  expect(at(0)).toBe(0) // transparent is unlit, however white the colour says it is
  expect(at(16)).toBe(1) // and it is a multiply, not a cutoff
  expect(at(255)).toBe(3)
})

/**
 * One picture, three classic mistakes. Every 2x2 source box holds three whites and one
 * black, so the true mean is linear 0.75, perceptual 0.88, level 3. Averaging the
 * gamma-encoded values instead gives 0.75 -> level 2 (the muddy mistake), and nearest
 * sampling at a box corner hits the black pixel -> level 0. The stripes catch the
 * remaining sampler: a centre-nearest sample lands on one stripe or the other (0 or 3)
 * where the box average mixes them to linear 0.5, perceptual 0.74, level 2.
 */
test('luminance averages in linear light over the whole box', () => {
  const board = rgba(48, 18, (x, y) =>
    x % 2 === 0 && y % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255],
  )
  expect(aliveLevels(toBitmap(board, { fit: 'stretch', dither: 'none' }))).toEqual(
    new Set([3]),
  )
  const stripes = rgba(48, 9, (x) =>
    x % 2 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255],
  )
  expect(aliveLevels(toBitmap(stripes, { fit: 'stretch', dither: 'none' }))).toEqual(
    new Set([2]),
  )
})

test('image row 0 is the top, so it lands on panel row 8', () => {
  const top = rgba(24, 9, (_x, y) => (y === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]))
  const b = toBitmap(top, { fit: 'stretch', dither: 'none' })
  expect(b[8][0]).toBe(3)
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 24; c++) expect(b[r][c]).toBe(0)
  }
})

test('contain letterboxes a tall source', () => {
  // 9x18 fits at 5x9 (4.5 rounded), centred: cols 9-13 are picture, the rest exactly 0.
  const b = toBitmap(rgba(9, 18, () => [255, 255, 255, 255]), { dither: 'none' })
  for (let r = 0; r < 9; r++) {
    for (const c of [0, 4, 8, 14, 19, 23]) expect(b[r][c]).toBe(0)
  }
  for (const c of [9, 10, 11, 12, 13]) expect(b[4][c]).toBe(3)
})

test('cover fills the panel and crops a wide source', () => {
  // 48x9 covers at 1:1 with 12 columns cropped off each side, so the panel shows
  // source columns 12-35: the white half ends mid-panel, and column 0 never appears.
  const half = rgba(48, 9, (x) => (x < 24 ? [255, 255, 255, 255] : [0, 0, 0, 255]))
  const b = toBitmap(half, { fit: 'cover', dither: 'none' })
  for (const c of [0, 6, 11]) expect(b[4][c]).toBe(3)
  for (const c of [12, 18, 23]) expect(b[4][c]).toBe(0)
})

test('levels 2 lights fully or not at all', () => {
  // Never 0 and 1: LIGHT floors at level 1, so "lit" has to mean fully lit.
  for (const dither of ['none', 'ordered', 'floyd'] as const) {
    const seen = aliveLevels(toBitmap(gradient(), { fit: 'stretch', levels: 2, dither }))
    expect(seen).toEqual(new Set([0, 3]))
  }
})

test('dead LEDs are 0 whatever the dither decided', () => {
  for (const dither of ['none', 'ordered', 'floyd'] as const) {
    const b = toBitmap(grey(255), { fit: 'stretch', dither })
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 24; c++) expect(b[r][c]).toBe(alive(r, c) ? 3 : 0)
    }
  }
})

test('ordered dither shades a mid grey between its two neighbouring levels', () => {
  const seen = aliveLevels(toBitmap(grey(128), { fit: 'stretch', dither: 'ordered' }))
  expect(seen).toEqual(new Set([1, 2]))
})

test('floyd shades a mid grey at levels 2', () => {
  const seen = aliveLevels(
    toBitmap(grey(128), { fit: 'stretch', levels: 2, dither: 'floyd' }),
  )
  expect(seen).toEqual(new Set([0, 3]))
})

/**
 * The reason ordered is the default: its thresholds are panel coordinates, so the
 * same frame quantises the same way every time and a still image stays still. Two
 * separately built copies of one source must land pixel-identical.
 */
test('ordered dither is stable across identical frames', () => {
  const a = toBitmap(gradient(), { fit: 'stretch', dither: 'ordered' })
  const b = toBitmap(gradient(), { fit: 'stretch', dither: 'ordered' })
  expect(a).toEqual(b)
})

test('gain lifts a source that lands too dark', () => {
  const dark = grey(40)
  expect(toBitmap(dark, { fit: 'stretch', dither: 'none' })[4][0]).toBe(0)
  expect(toBitmap(dark, { fit: 'stretch', dither: 'none', gain: 4 })[4][0]).toBe(2)
})

test('invert swaps dark for lit, for black-on-white sources', () => {
  const black = toBitmap(grey(0), { fit: 'stretch', dither: 'none', invert: true })
  expect(aliveLevels(black)).toEqual(new Set([3]))
  const white = toBitmap(grey(255), { fit: 'stretch', dither: 'none', invert: true })
  expect(aliveLevels(white)).toEqual(new Set([0]))
})

test('threshold is the perceptual grey that lights, at levels 2', () => {
  const mid = grey(102) // perceptual 0.4 exactly
  const at = (threshold: number) =>
    toBitmap(mid, { fit: 'stretch', levels: 2, dither: 'none', threshold })[4][0]
  expect(at(0.3)).toBe(3)
  expect(at(0.6)).toBe(0)
})

test('toAnimation carries every delay through raw, including 0', () => {
  const frames = [grey(255), grey(255), rgba(24, 9, () => [0, 0, 0, 255], 40)]
  frames[1].delayMs = 0
  frames[0].delayMs = 70
  const anim = toAnimation(frames, { fit: 'stretch', dither: 'none' })
  // Three frames out, two of them identical: merging and the zero-delay convention
  // are anim.normalise()'s, and doing half of it here would put the rule in two places.
  expect(anim.frames.length).toBe(3)
  expect(anim.frameMs).toEqual([70, 0, 40])
  expect(anim.frames[0]).toEqual(anim.frames[1])
  expect(anim.frames[0].length).toBe(9)
  expect(anim.frames[0][0].length).toBe(24)
})

test('pack and unpack round-trip every level exactly', () => {
  const all: number[][] = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 24 }, (_, c) => (r * 24 + c) % 4),
  )
  const packed = packBitmap(all)
  expect(packed.length).toBe(72) // 216 pixels, 2 bits each, 54 bytes, no padding
  expect(unpackBitmap(packed)).toEqual(all)
  const dark = Array.from({ length: 9 }, () => new Array(24).fill(0))
  const lit = Array.from({ length: 9 }, () => new Array(24).fill(3))
  expect(unpackBitmap(packBitmap(dark))).toEqual(dark)
  expect(unpackBitmap(packBitmap(lit))).toEqual(lit)
})

test('pack refuses what it cannot represent exactly', () => {
  const b = Array.from({ length: 9 }, () => new Array(24).fill(0))
  expect(() => packBitmap(b.slice(1))).toThrow('8 rows')
  const wide = b.map((row) => [...row])
  wide[3].push(0)
  expect(() => packBitmap(wide)).toThrow('25 columns')
  const hot = b.map((row) => [...row])
  hot[2][5] = 4
  expect(() => packBitmap(hot)).toThrow('integer 0 to 3')
  const frac = b.map((row) => [...row])
  frac[2][5] = 1.5
  expect(() => packBitmap(frac)).toThrow('integer 0 to 3')
})

test('unpack refuses corruption rather than guessing', () => {
  expect(() => unpackBitmap('AAAA')).toThrow('3 bytes')
  const packed = packBitmap(Array.from({ length: 9 }, () => new Array(24).fill(2)))
  const bad = `${packed.slice(0, 10)}!${packed.slice(11)}`
  expect(() => unpackBitmap(bad)).toThrow('not base64')
})

test('the untyped caller is told about a bad option or frame by name', () => {
  const f = grey(128)
  expect(() => toBitmap(f, { levels: 3 as never })).toThrow('levels')
  expect(() => toBitmap(f, { dither: 'diffusion' as never })).toThrow('dither')
  expect(() => toBitmap(f, { fit: 'fill' as never })).toThrow('fit')
  expect(() => toBitmap(f, { gain: Number.NaN })).toThrow('gain')
  expect(() => toBitmap(f, { threshold: Number.NaN })).toThrow('threshold')
  const short: RgbaFrame = { width: 2, height: 2, data: new Uint8Array(3), delayMs: 0 }
  expect(() => toBitmap(short)).toThrow('16')
  const empty: RgbaFrame = { width: 0, height: 2, data: new Uint8Array(0), delayMs: 0 }
  expect(() => toBitmap(empty)).toThrow('dimensions')
})
