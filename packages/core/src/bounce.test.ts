import { expect, test } from 'bun:test'
import {
  PHASE_OFFSETS,
  PHASE_PERIOD,
  SAFE_ROWS,
  clippedAt,
  command,
  frameAt,
  frames,
  gridAt,
  phaseAt,
  startAt,
  storeColumns,
  storeWindow,
  survives,
  travelPeriod,
  visualPeriod,
  worstClip,
} from './bounce.js'
import { type Bitmap, blank, text } from './content.js'
import { TYPE1_BRACKET } from './dats.js'
import { ROWS, alive } from './display.js'
import { body } from './protocol.js'
import { WIDTH, marqueeWidth } from './viewport.js'

const band = (cols: number, lo: number, hi: number): Bitmap => {
  const b = blank(cols)
  for (let r = lo; r <= hi; r++) b[r].fill(3)
  return b
}

test('the phase table is the fourteen shifts the jump table encodes', () => {
  expect([...PHASE_OFFSETS]).toEqual([0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0, -1, -2, -1])
  expect(PHASE_PERIOD).toBe(14)
  expect(phaseAt(0)).toBe(0)
  expect(phaseAt(5)).toBe(5)
  expect(phaseAt(PHASE_PERIOD)).toBe(0)
  expect(phaseAt(PHASE_PERIOD + 12)).toBe(-2)
})

test('the frame is MODE 03, and the second byte is the direction', () => {
  expect([...body(command(0))]).toEqual([0x4d, 0x4f, 0x44, 0x45, 3, 0])
  expect([...body(command(1))]).toEqual([0x4d, 0x4f, 0x44, 0x45, 3, 1])
})

/**
 * The off-by-one this module was written to stop repeating. `viewport.marqueeWidth` is
 * `cols + 24`; the firmware's forward wrap is `if (ncols - 24 < col) col = 0` against a
 * recorded `ncols` of `cols + 48`, so the start column reaches `cols + 24` inclusive and
 * the period is one longer. Asserted against the neighbour so the disagreement is
 * deliberate and visible rather than a silent drift.
 */
test('the travel is one column longer than the marquee model says', () => {
  expect(storeColumns(55)).toBe(55 + 2 * TYPE1_BRACKET)
  expect(travelPeriod(55)).toBe(80)
  expect(travelPeriod(55)).toBe(marqueeWidth(55) + 1)
  expect(travelPeriod(0)).toBe(TYPE1_BRACKET + 1)
})

test('both clocks run, so the display repeats only at their common multiple', () => {
  expect(visualPeriod(55)).toBe(560)
  expect(visualPeriod(116)).toBe(1974)
  expect(visualPeriod(55) % travelPeriod(55)).toBe(0)
  expect(visualPeriod(55) % PHASE_PERIOD).toBe(0)
})

test('a forward pass opens on the blank lead-in and counts up from zero', () => {
  expect(startAt(55, 0)).toBe(0)
  expect(startAt(55, 1)).toBe(1)
  expect(startAt(55, travelPeriod(55) - 1)).toBe(79)
  expect(startAt(55, travelPeriod(55))).toBe(0)
  expect(frameAt(band(55, 2, 6), 0).every((row) => row.every((v) => v === 0))).toBe(true)
})

/**
 * `set_mode(41)` starts at `ncols - 24` rather than at `ncols`, so the first reverse pass
 * is `cols + 1` frames and every one after it is `travelPeriod`. Worth holding: a preview
 * that started the reverse walk at `ncols` would be a frame out for the whole first pass.
 */
test('a reverse pass has a short first run and then settles', () => {
  const cols = 55
  const first = Array.from({ length: cols + 1 }, (_, i) => startAt(cols, i, { dir: 1 }))
  expect(first[0]).toBe(storeColumns(cols) - WIDTH)
  expect(first[first.length - 1]).toBe(TYPE1_BRACKET)
  expect(startAt(cols, cols + 1, { dir: 1 })).toBe(storeColumns(cols))
  const settled = cols + 1 + travelPeriod(cols)
  expect(startAt(cols, settled, { dir: 1 })).toBe(storeColumns(cols))
})

test('the two directions wrap to different places, as the two handlers do', () => {
  const cols = 30
  expect(storeWindow(cols, travelPeriod(cols) - 1, { dir: 0 }).slice(0, 3)).toEqual([
    54, 0, 1,
  ])
  expect(storeWindow(cols, storeColumns(cols), { dir: 1 }).slice(0, 3)).toEqual([
    78, TYPE1_BRACKET - 1, TYPE1_BRACKET,
  ])
})

/**
 * An independent transcription of the firmware's inner loop: the column is a 16-bit word
 * with row `r` at bit `7 + r`, it is shifted, and only bits 7 to 15 are packed into the
 * panel column. Arrived at by bit arithmetic rather than by row arithmetic, so agreement
 * is a real check on the shift-to-row mapping and not the module restating itself.
 */
const reference = (bitmap: Bitmap, step: number, dir: 0 | 1): Bitmap => {
  const cols = bitmap[0]?.length ?? 0
  const ncols = cols + 48
  const store = Array.from({ length: ncols }, (_, i) => {
    let h = 0
    const c = i - 24
    if (c < 0 || c >= cols) return h
    for (let r = 0; r < Math.min(bitmap.length, ROWS); r++) {
      if (bitmap[r][c]) h |= 1 << (7 + r)
    }
    return h
  })
  const lift = PHASE_OFFSETS[step % PHASE_PERIOD]
  const limit = dir === 0 ? ncols - 24 : ncols
  const reset = dir === 0 ? 0 : 23
  // The start column, advanced from what `set_mode` leaves it at, step by step.
  let i = dir === 0 ? 0 : ncols - 24
  for (let s = 0; s < step; s++) {
    if (dir === 0) i = i + 1 > ncols - 24 ? 0 : i + 1
    else i = i - 1 >= 24 ? i - 1 : ncols
  }
  const out = blank(WIDTH)
  for (let c = 0; c < WIDTH; c++) {
    const raw = store[i] ?? 0
    const shifted = (lift >= 0 ? raw << lift : raw >>> -lift) & 0xffff
    for (let r = 0; r < ROWS; r++) {
      if (!alive(r, c)) continue
      out[r][c] = (shifted >> (7 + r)) & 1 ? 3 : 0
    }
    i += 1
    if (i > limit) i = reset
  }
  return out
}

test('every frame of a full pass matches the firmware transcribed independently', () => {
  for (const dir of [0, 1] as const) {
    const b = text('BOUNCE').bitmap
    const cols = b[0].length
    for (let step = 0; step < travelPeriod(cols) + PHASE_PERIOD; step++) {
      expect(frameAt(b, step, { dir })).toEqual(reference(b, step, dir))
    }
  }
})

test('the swing clips and never wraps: nothing appears at the far edge', () => {
  const one = blank(1)
  one[8][0] = 3
  const lifted = frameAt(one, 5, { dir: 0 })
  expect(lifted.some((row) => row.some((v) => v !== 0))).toBe(false)

  const low = blank(1)
  low[0][0] = 3
  expect(frameAt(low, 12, { dir: 0 }).some((r) => r.some((v) => v !== 0))).toBe(false)
})

test('the lift lands where the phase says, dead LEDs still applied at the window', () => {
  const b = band(WIDTH * 3, 2, 2)
  const step = 30 // phase +2, and a start whose whole window sits inside the content
  expect(phaseAt(step)).toBe(2)
  const f = frameAt(b, step)
  for (let c = 0; c < WIDTH; c++) {
    expect(f[4][c]).toBe(alive(4, c) ? 3 : 0)
    expect(f[2][c]).toBe(0)
  }
})

test('the safe band is two rows, and no font in this repo fits it', () => {
  expect([...SAFE_ROWS]).toEqual([2, 3])
  expect(survives(band(4, 2, 3))).toBe(true)
  expect(survives(band(4, 2, 4))).toBe(false)
  expect(survives(text('HI').bitmap)).toBe(false)
})

test('the clip count is per phase and peaks at the top of the swing', () => {
  const b = band(10, 2, 6)
  expect(clippedAt(b, 0)).toBe(0)
  expect(clippedAt(b, 1)).toBe(0)
  expect(clippedAt(b, 5)).toBe(30)
  expect(worstClip(b)).toBe(30)
  expect(worstClip(blank(10))).toBe(0)
})

test('frames default to one pass, not to the loop, and say so by count', () => {
  const b = text('AB').bitmap
  const cols = b[0].length
  expect(frames(b).length).toBe(travelPeriod(cols))
  expect(frames(b, { count: 3 }).length).toBe(3)
  expect(frames(b)[0]).toEqual(frameAt(b, 0))
  expect(frames(b, { dir: 1 })[7]).toEqual(frameAt(b, 7, { dir: 1 }))
})

test('empty content is a dark panel rather than a throw', () => {
  expect(frameAt([], 3)[0].length).toBe(WIDTH)
  expect(frames([]).length).toBe(travelPeriod(0))
  expect(gridAt([], 0).px.length).toBe(ROWS)
})

test('a grid is the frame, so the sender and the preview cannot disagree', () => {
  const b = text('OK').bitmap
  const g = gridAt(b, 9)
  const f = frameAt(b, 9)
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < WIDTH; c++) expect(g.px[r][c]).toBe(f[r][c])
  }
})
