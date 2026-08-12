/**
 * The run merging both panel grids draw through.
 *
 * What these hold is that merging is a drawing optimisation and nothing more: the same
 * pixels, the same colours, the same total width, and the dead LEDs in the same places.
 * A run that spans a hole, or a row that comes out narrower than the one it replaced,
 * would be a silent visual defect on the one screen the app opens on.
 */
import { display } from '@joggles/core'
import { expect, test } from 'bun:test'
import { HOLE, type Run, runWidth, runsOf } from './panel-runs.js'

/** Rows 2-7 are alive in every column, which is what makes them the clean subject. */
const LIVE_ROW = 3

const cells = (runs: Run[]): number => runs.reduce((n, r) => n + r.cells, 0)

/** The levels a run list stands for, one per column, so it can be compared cell by cell. */
const flatten = (runs: Run[]): number[] =>
  runs.flatMap((r) => Array.from({ length: r.cells }, () => r.cls))

test('every row accounts for every column', () => {
  for (let row = 0; row < display.ROWS; row++) {
    expect(cells(runsOf(row, () => 0))).toBe(display.COLS)
    expect(cells(runsOf(row, (col) => col % 4))).toBe(display.COLS)
  }
})

test('a uniform live row is one run', () => {
  const runs = runsOf(LIVE_ROW, () => 2)
  expect(runs).toEqual([{ cls: 2, cells: display.COLS }])
})

test('runs merge only what looks the same, and never across a change', () => {
  const runs = runsOf(LIVE_ROW, (col) => (col < 5 ? 3 : col < 6 ? 0 : 3))
  expect(runs).toEqual([
    { cls: 3, cells: 5 },
    { cls: 0, cells: 1 },
    { cls: 3, cells: display.COLS - 6 },
  ])
})

test('alternating levels merge nothing, which is the worst case and still correct', () => {
  const runs = runsOf(LIVE_ROW, (col) => col % 2)
  expect(runs).toHaveLength(display.COLS)
  expect(flatten(runs)).toEqual(Array.from({ length: display.COLS }, (_, c) => c % 2))
})

test('the merge draws the same levels as the pixels it replaced', () => {
  const level = (col: number) => (col * 7) % 4
  for (let row = 0; row < display.ROWS; row++) {
    const want = Array.from({ length: display.COLS }, (_, col) =>
      display.alive(row, col) ? level(col) : HOLE,
    )
    expect(flatten(runsOf(row, level))).toEqual(want)
  }
})

test('a dead LED is a hole and never merges with an unlit pixel', () => {
  // The mask's own rows: the top row's middle six and the nose notch (`display.alive`).
  const dead: { row: number; col: number }[] = []
  for (let row = 0; row < display.ROWS; row++) {
    for (let col = 0; col < display.COLS; col++) {
      if (!display.alive(row, col)) dead.push({ row, col })
    }
  }
  expect(dead.length).toBeGreaterThan(0)
  for (const { row, col } of dead) {
    // Level 0 everywhere: a hole must still come out as HOLE rather than joining the
    // unlit run either side of it, because the two are different colours on screen.
    expect(flatten(runsOf(row, () => 0))[col]).toBe(HOLE)
  }
})

test('a lit pixel is never swallowed by the mask', () => {
  for (let row = 0; row < display.ROWS; row++) {
    const flat = flatten(runsOf(row, () => 3))
    for (let col = 0; col < display.COLS; col++) {
      expect(flat[col]).toBe(display.alive(row, col) ? 3 : HOLE)
    }
  }
})

test('a merged row is exactly as wide as the pixels it replaced', () => {
  for (const [pitch, margin] of [
    [13, 1],
    [4, 0.5],
  ] as const) {
    const onePixel = runWidth(1, pitch, margin)
    for (let n = 1; n <= display.COLS; n++) {
      // n pixels drawn separately span n * pitch including their own outer margins, and
      // so must the run that stands in for them.
      expect(runWidth(n, pitch, margin) + 2 * margin).toBe(n * pitch)
      expect(runWidth(n, pitch, margin)).toBe(n * onePixel + (n - 1) * 2 * margin)
    }
  }
})
