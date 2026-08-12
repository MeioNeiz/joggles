import { expect, test } from 'bun:test'
import {
  IMAGE_ACCEPT_CEILING,
  MAX_IMAGE_COLUMNS,
  MAX_SAVED_COLUMNS,
  SCROLL_GAP,
  BLANK_SAVE,
  anyLit,
  assertValid,
  centre,
  centreOffset,
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
import { Grid, alive } from './display.js'
// effects imports content, not the other way round, so there is no cycle here.
import * as fx from './effects.js'
import * as font from './font.js'

const blankBitmap = (cols: number) => grid(9, cols, 0)

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

/**
 * The gap between repeats is the device's, and a client gap adds to it.
 *
 * A 27-column save carrying no client gap showed a full screen width of dark on the
 * panel (2026-08-11, against a payload verified off the wire log), so 0 here is what
 * produces one screen width and 24 would produce two - which is what the original
 * complaint was. Asserted as an equality with the static width rather than against 0,
 * so the day someone reintroduces a scroll-only default it fails here.
 */
test('scrolling text adds no client gap: the gap between repeats is the device\'s', () => {
  const still = width(text('HELLO THERE').bitmap)
  const moving = width(text('HELLO THERE', { kind: 'scroll', dir: 0, speed: 50 }).bitmap)
  expect(SCROLL_GAP).toBe(0)
  expect(moving).toBe(still)
  // Available per call, for a caller that wants two screen widths rather than one.
  const spaced = text('HELLO THERE', { kind: 'scroll', dir: 0, speed: 50 }, { gap: 24 })
  expect(width(spaced.bitmap)).toBe(still + 24)
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

// Track 27. The combination review-13 found on the Pixel, built by name rather than as
// a hand-made dark bitmap: a guard that only catches bitmaps a test invented would not
// have caught this one, which came out of a generator under an enabled Upload button.
const darkLoop = () =>
  fx.EFFECTS.mirror({ inner: 'ripple', folds: 10, dither: 'none', levels: 2, columns: fx.MAX_COLUMNS })

test('the found dark loop really is dark, at the width the screen offered', () => {
  const bitmap = darkLoop()
  expect(width(bitmap)).toBe(fx.MAX_COLUMNS)
  expect(anyLit(bitmap)).toBe(false)
})

test('a type 1 save of nothing is refused, and asking to clear is how you mean it', () => {
  const piece = { bitmap: darkLoop(), route: 'saved' as const, motion: { kind: 'static' as const } }
  expect(check(piece)).toContain(BLANK_SAVE)
  expect(check(piece, { blank: 'clear' })).not.toContain(BLANK_SAVE)
  expect(() => encodeSaved(piece)).toThrow(/nothing here is lit/)
  expect(encodeSaved(piece, { blank: 'clear' }).columns).toBe(fx.MAX_COLUMNS)
})

test('the blank rule is scoped to the one path that spends flash', () => {
  const bitmap = blankBitmap(24)
  // Live writes no flash at all, so a dark panel there costs nothing and is not ours
  // to refuse. Type 2 lands in RAM and dies at power off, same argument.
  expect(check({ bitmap, route: 'live', motion: { kind: 'static' } })).not.toContain(BLANK_SAVE)
  const saved = { bitmap, route: 'saved' as const, motion: { kind: 'static' as const } }
  expect(check(saved, { type: TYPE_IMAGE })).not.toContain(BLANK_SAVE)
  expect(check(saved, { type: TYPE_TEXT })).toContain(BLANK_SAVE)
})

// review-27. The rule read `content.bitmap` while `encodeSaved` wrote
// `flatten(bitmap, threshold)`, so a threshold above every level in the content walked
// straight through it: check() said nothing and the encode produced an all-zero type 1
// payload, which is five page erases for a dark panel. The `threshold` docblock sends
// callers at exactly this pair of options, so it was reachable by following the file.
test('the blank rule reads what reaches the panel, not the bitmap it started from', () => {
  const bitmap = blankBitmap(24)
  bitmap[3][5] = 1
  bitmap[4][6] = 2
  const piece = { bitmap, route: 'saved' as const, motion: { kind: 'static' as const } }
  expect(anyLit(bitmap)).toBe(true)
  expect(anyLit(flatten(bitmap, 3))).toBe(false)

  expect(check(piece, { type: TYPE_TEXT, threshold: 3 })).toContain(BLANK_SAVE)
  expect(() => encodeSaved(piece, { type: TYPE_TEXT, threshold: 3 })).toThrow(/nothing here is lit/)
  // The escape still works on this path, and a threshold everything survives is silent.
  expect(check(piece, { type: TYPE_TEXT, threshold: 3, blank: 'clear' })).not.toContain(BLANK_SAVE)
  expect(check(piece, { type: TYPE_TEXT })).not.toContain(BLANK_SAVE)
})

test('a zero-column bitmap says one thing, not two', () => {
  const empty = { bitmap: blankBitmap(0), route: 'saved' as const, motion: { kind: 'static' as const } }
  expect(check(empty)).toContain('bitmap has no columns')
  expect(check(empty)).not.toContain(BLANK_SAVE)
})

// Track 35. Measured off the bitmap rather than against a fixed column, so track 29's
// new fonts (band6, slim5) cannot break these by being a different width.
const firstLitColumn = (bitmap: number[][]) => {
  const cols = width(bitmap)
  for (let c = 0; c < cols; c++) if (bitmap.some((row) => row[c] > 0)) return c
  return -1
}
const lastLitColumn = (bitmap: number[][]) => {
  for (let c = width(bitmap) - 1; c >= 0; c--) if (bitmap.some((row) => row[c] > 0)) return c
  return -1
}

test('a static word is centred, and the slack is split the way centreOffset says', () => {
  const bitmap = text('HI', { kind: 'static' }).bitmap
  expect(width(bitmap)).toBe(24)
  const left = firstLitColumn(bitmap)
  const drawn = lastLitColumn(bitmap) - left + 1
  expect(left).toBe(centreOffset(drawn, 24))
  // The spare column of an odd remainder sits on the RIGHT: ties left, decided rather
  // than inherited from Math.floor, because the panel's axis is 11.5 and no column is
  // on it.
  const right = 24 - drawn - left
  expect(right - left).toBe((24 - drawn) % 2)
})

test('a scroller is not centred, because its left edge is where the pass begins', () => {
  const bitmap = text('HI', { kind: 'scroll', dir: 0, speed: 50 }).bitmap
  expect(firstLitColumn(bitmap)).toBe(0)
})

test('gap widens a scroller and is ignored for a static', () => {
  const scrolled = text('HI', { kind: 'scroll', dir: 0, speed: 50 }, { gap: 24 }).bitmap
  expect(width(scrolled)).toBeGreaterThan(24)
  expect(width(text('HI', { kind: 'static' }, { gap: 24 }).bitmap)).toBe(24)
})

test('centre never truncates, and centring puts no pixel in a dead hole', () => {
  const wide = grid(9, 40, 1)
  expect(width(centre(wide, 24))).toBe(40)
  const bitmap = text('HI', { kind: 'static' }).bitmap
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 24; c++) {
      if (bitmap[r][c] > 0) expect(alive(r, c)).toBe(true)
    }
  }
})

test('text renders in the font it is given, and the default is unchanged', () => {
  const dflt = text('JOGGLES', { kind: 'scroll', dir: 0, speed: 50 })
  const slim = text('JOGGLES', { kind: 'scroll', dir: 0, speed: 50 }, { font: font.SLIM5 })
  // slim5 exists so this word crosses the price line: 27 columns in band5, 24 here, so
  // the same message is five page erases in one face and free in the other.
  expect(width(dflt.bitmap)).toBeGreaterThan(width(slim.bitmap))
  expect(width(slim.bitmap)).toBe(24)
  // A face that cannot scroll is placed rather than baselined, and still fits the panel.
  const tall = text('HI', { kind: 'static' }, { font: font.TALL7 })
  expect(tall.bitmap.length).toBe(9)
  expect(width(tall.bitmap)).toBe(24)
})
