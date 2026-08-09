import { expect, test } from 'bun:test'
import {
  MAX_IMAGE_COLUMNS,
  MAX_SAVED_COLUMNS,
  assertValid,
  check,
  drawing,
  encodeSaved,
  flatten,
  fromGrid,
  hasGrey,
  maxColumns,
  modeArgs,
  normalise,
  pad,
  text,
  toGrid,
  width,
} from './content.js'
import { TYPE_IMAGE, TYPE_TEXT, decodeImage } from './dats.js'
import { Grid } from './display.js'

const grid = (rows: number, cols: number, v = 0) =>
  Array.from({ length: rows }, () => new Array(cols).fill(v))

test('normalise lifts a 5-row render into the panel 9', () => {
  const out = normalise(grid(5, 3, 1))
  expect(out.length).toBe(9)
  expect(out.every((row) => row.length === 3)).toBe(true)
  expect(out[8].every((v) => v === 0)).toBe(true)
})

test('normalise squares off ragged rows and clamps levels', () => {
  const out = normalise([[1, 2, 3, 9], [5], [], [-1]])
  expect(out.every((row) => row.length === 4)).toBe(true)
  expect(out[0]).toEqual([1, 2, 3, 3])
  expect(out[1]).toEqual([3, 0, 0, 0])
  expect(out[3]).toEqual([0, 0, 0, 0])
})

test('pad widens and never truncates', () => {
  expect(width(pad(grid(9, 4), 24))).toBe(24)
  expect(width(pad(grid(9, 40), 24))).toBe(40)
})

test('hasGrey ignores off and full, which every text render is', () => {
  expect(hasGrey(text('HI').bitmap)).toBe(false)
  expect(hasGrey(text('HI', { kind: 'static' }, { level: 2 }).bitmap)).toBe(true)
})

test('flatten collapses to one bit at the threshold', () => {
  const bmp = [[0, 1, 2, 3]]
  expect(flatten(bmp)[0]).toEqual([0, 1, 1, 1])
  expect(flatten(bmp, 3)[0]).toEqual([0, 0, 0, 1])
})

test('text sits in the band alive across all 24 columns', () => {
  const { bitmap } = text('HI')
  expect(bitmap.length).toBe(9)
  // Rows 0-1 are the nose notch and row 8 has the top gap.
  expect(bitmap[0].every((v) => v === 0)).toBe(true)
  expect(bitmap[1].every((v) => v === 0)).toBe(true)
  expect(bitmap[8].every((v) => v === 0)).toBe(true)
  expect(bitmap.slice(2, 7).some((row) => row.some(Boolean))).toBe(true)
})

// Verify item 5 in notes/app-plan.md: nobody has watched MODE handle content
// narrower than the panel, and "HI" is the first thing anyone will type.
test('short text is padded to a full screen', () => {
  expect(width(text('HI').bitmap)).toBeGreaterThanOrEqual(24)
})

test('scrolling text gets a trailing gap so the wrap is readable', () => {
  const still = width(text('HELLO THERE').bitmap)
  const moving = width(text('HELLO THERE', { kind: 'scroll', dir: 0, speed: 50 }).bitmap)
  expect(moving).toBe(still + 24)
})

test('a drawing is 24 columns on the live route', () => {
  const g = new Grid().set(4, 4, 3)
  const c = drawing(g)
  expect(c.route).toBe('live')
  expect(width(c.bitmap)).toBe(24)
  expect(check(c)).toEqual([])
})

test('toGrid and fromGrid round-trip a panel-sized bitmap', () => {
  const g = new Grid().set(0, 0, 1).set(8, 23, 3).set(4, 12, 2)
  expect(fromGrid(toGrid(fromGrid(g)))).toEqual(fromGrid(g))
})

const still = { kind: 'static' } as const
const moving = { kind: 'scroll', dir: 0, speed: 50 } as const

test('check rejects live content wider than the panel', () => {
  const wide = { bitmap: grid(9, 25, 1), route: 'live' as const, motion: still }
  expect(check(wide)).toEqual(['live route holds 24 columns, got 25'])
})

test('check rejects a saved payload past the bisected ceiling', () => {
  const c = { ...text('X'), bitmap: grid(9, MAX_SAVED_COLUMNS, 3) }
  expect(check(c)).toEqual([])
  expect(check({ ...c, bitmap: grid(9, MAX_SAVED_COLUMNS + 1, 3) }).join()).toContain(
    '740 columns',
  )
})

/**
 * The two ceilings are unrelated numbers and neither derives from the other.
 *
 * The device buffers a type 2 column as a 32-bit word and wraps the counter at 384
 * (`abs 0x18634`), so 383 columns is the ceiling however many bytes that is. Dividing
 * type 1's measured 1480-byte budget by three bytes per column gives 493, which the
 * device answers with `ERROR` after taking the whole upload. That figure was in this
 * file until 2026-08-09.
 */
test('the greyscale ceiling is 383 columns, not 493 and not 740', () => {
  expect(maxColumns(TYPE_IMAGE)).toBe(MAX_IMAGE_COLUMNS)
  expect(MAX_IMAGE_COLUMNS).toBe(383)
  expect(maxColumns(TYPE_TEXT)).toBe(740)
  for (const cols of [493, 740]) {
    expect(check({ ...text('X'), bitmap: grid(9, cols, 2) }).join()).toContain(
      '383 columns',
    )
  }
  expect(check({ ...text('X'), bitmap: grid(9, 383, 2) })).toEqual([])
  expect(check({ ...text('X'), bitmap: grid(9, 384, 2) }).length).toBe(1)
})

// Forcing type 1 halves the cost, so the byte check has to be told, or it rejects
// content that would in fact have fitted.
test('a forced type is checked against that type', () => {
  const grey = { ...text('X'), bitmap: grid(9, 600, 2) }
  expect(check(grey).length).toBe(1)
  expect(check(grey, { type: TYPE_TEXT })).toEqual([])
  expect(encodeSaved(grey, { type: TYPE_TEXT }).payload.length).toBe(1200)
})

// MODE displays the saved store, so asking for a scrolling live drawing is a
// request to throw that drawing away.
test('check rejects scrolling on the live route', () => {
  const c = { bitmap: grid(9, 24, 1), route: 'live' as const, motion: moving }
  expect(check(c).join()).toContain('discards the live buffer')
})

test('check rejects empty content and out-of-range speed', () => {
  const empty = { bitmap: grid(9, 0), route: 'saved' as const, motion: still }
  expect(check(empty)).toContain('bitmap has no columns')
  const fast = { ...text('X'), motion: { ...moving, speed: 200 } }
  expect(check(fast).join()).toContain('speed must be 0 to 100')
  expect(() => assertValid(fast)).toThrow()
})

test('monochrome content encodes as type 1, two bytes per column', () => {
  const c = text('HI')
  const enc = encodeSaved(c)
  expect(enc.type).toBe(TYPE_TEXT)
  expect(enc.payload.length).toBe(enc.columns * 2)
  expect(enc.flattened).toBe(false)
})

test('grey content picks type 2 and keeps its levels', () => {
  const g = new Grid().set(3, 1, 1).set(4, 2, 2).set(5, 3, 3)
  const enc = encodeSaved(drawing(g, 'saved'))
  expect(enc.type).toBe(TYPE_IMAGE)
  expect(enc.payload.length).toBe(enc.columns * 3)
  expect(decodeImage(enc.payload)[4][2]).toBe(2)
})

// The UI has to say this happened: the device cannot tell them, and the drawing
// comes back flat with no error anywhere.
test('forcing type 1 on grey content reports the loss', () => {
  const g = new Grid().set(4, 2, 1)
  const enc = encodeSaved(drawing(g, 'saved'), { type: TYPE_TEXT })
  expect(enc.flattened).toBe(true)
  expect(enc.payload.length).toBe(enc.columns * 2)
})

test('encodeSaved refuses content check would reject', () => {
  expect(() =>
    encodeSaved({ bitmap: grid(9, 0), route: 'saved', motion: { kind: 'static' } }),
  ).toThrow()
})

// protocol.scrollLeft used to build MODE 03, the vertical bounce. Deciding this
// once is the whole reason the helper exists.
test('scrolling is MODE 02 and static is MODE 01', () => {
  expect(modeArgs({ kind: 'scroll', dir: 1, speed: 50 })).toEqual({ kind: 2, dir: 1 })
  expect(modeArgs({ kind: 'static' })).toEqual({ kind: 1, dir: 0 })
})
