import { expect, test } from 'bun:test'
import {
  IMAGE_ACCEPT_CEILING,
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
  savedType,
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
 * Type 2 has two different limits and `check` enforces the smaller one.
 *
 * The device answers `DATCPOK` to 383 columns and `ERROR` to 384, because it buffers
 * an image column as a 32-bit word and wraps at 384 (`abs 0x18634`). But it only ever
 * *shows* 24 of them: a 383-column upload with a lit head and a black tail left the
 * panel lit and unchanging for two minutes. Both on hardware 2026-08-09, though the
 * first is a device reply and the second is a person watching a panel not change -
 * `MAX_IMAGE_COLUMNS` carries the caveat and this test enforces it regardless,
 * because 24 is the conservative direction.
 *
 * So content is bounded by what displays, not by what is accepted. Two wrong numbers
 * have already been in this file: 493, from dividing type 1's byte budget by three,
 * and 383, from taking the accept ceiling as a content limit.
 */
test('type 2 content is bounded by the 24 columns that display, not the 383 accepted', () => {
  expect(maxColumns(TYPE_IMAGE)).toBe(MAX_IMAGE_COLUMNS)
  expect(MAX_IMAGE_COLUMNS).toBe(24)
  expect(IMAGE_ACCEPT_CEILING).toBe(383)
  expect(maxColumns(TYPE_TEXT)).toBe(740)

  expect(check({ ...text('X'), bitmap: grid(9, 24, 2) })).toEqual([])
  // Accepted by the device and invisible past column 24, which is the trap.
  const wide = check({ ...text('X'), bitmap: grid(9, 383, 2) })
  expect(wide.length).toBe(1)
  expect(wide.join()).toContain('shows only 24 columns')
  expect(wide.join()).toContain('383')
})

/**
 * The rejection above has to name the way out, because `check` exists to be shown
 * to a user and one grey pixel is what puts them here: `savedType` sends any
 * greyscale content down type 2, so a wide grey scroll reads as impossible when it
 * is one option away from working. Asserted rather than left to the message,
 * because the escape and the sentence promising it can drift apart.
 */
test('a wide grey scroll is rejected with the remedy, and the remedy works', () => {
  const wideGrey = { ...text('X'), bitmap: grid(9, 200, 2) }
  expect(savedType(wideGrey)).toBe(TYPE_IMAGE)
  expect(check(wideGrey).join()).toContain('type 1')

  expect(check(wideGrey, { type: TYPE_TEXT })).toEqual([])
  const forced = encodeSaved(wideGrey, { type: TYPE_TEXT })
  expect(forced.type).toBe(TYPE_TEXT)
  expect(forced.columns).toBe(200)
  expect(forced.flattened).toBe(true)
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
