/**
 * Putting a glyph taller than the safe band on a panel that has holes in it.
 *
 * The panel is not a rectangle: the nose notch takes columns 10 to 13 of row 1
 * and 9 to 14 of row 0, and the top row has its own gap. Any font using more
 * than rows 2 to 7 therefore has positions where it would draw into a hole, and
 * a pixel drawn on a dead LED is not dim, it is absent: the glyph loses a stroke
 * and reads as a different letter.
 *
 * So this moves whole glyphs rather than clipping them. Each one advances right
 * until none of its ink lands on a dead LED, which turns the notch into a wide
 * word space rather than a bite out of a letter. Whole strings are then tried
 * from every starting column, and the best-centred placement that fits wins,
 * because shifting the start changes which glyph meets the notch and a string
 * that fails from column 0 often fits from column 1.
 *
 * **Anything that does not fit is reported, never drawn.** `dropped` is what a
 * caller should show the user, and it is the difference between "this message is
 * too long" and a message that silently loses its last letter.
 *
 * Scrolling content cannot use any of this. It visits every column, so there is
 * no placement that keeps it out of the holes; that is what `band5` is for.
 */
import { COLS, ROWS, alive } from '../display.js'
import { type LayoutOptions, type Piece, glyphWidth, pieces } from './kern.js'
import { TALL7 } from './tall7.js'
import type { Font } from './types.js'

export interface StaticOptions extends LayoutOptions {
  /** Panel row the bottom row of a glyph sits on. Defaults to the font's own. */
  baseline?: number
}

export interface StaticPlacement {
  /** 9 rows by 24 columns, 0 or 1. Every lit cell has an LED behind it. */
  bitmap: number[][]
  /** Characters that had no room, in order. Empty when everything landed. */
  dropped: string
  /** Lit columns as [first, last], or null when nothing is lit. */
  ink: [number, number] | null
}

/** Panel row for a glyph's row index, which is counted from the top. */
const panelRow = (baseline: number, height: number, top: number): number =>
  baseline + (height - 1 - top)

/** Would any of this glyph's ink land where there is no LED? */
function clips(piece: Piece, x: number, baseline: number, height: number): boolean {
  for (let t = 0; t < piece.rows.length; t++) {
    const row = panelRow(baseline, height, t)
    for (let c = 0; c < piece.rows[t].length; c++) {
      if (piece.rows[t][c] === '#' && !alive(row, x + c)) return true
    }
  }
  return false
}

interface Run {
  xs: number[]
  placed: number
}

/** Lay pieces out from `start`, stepping each past any hole it would fall in. */
function run(list: readonly Piece[], start: number, baseline: number, height: number): Run {
  const xs: number[] = []
  let x = start
  for (let i = 0; i < list.length; i++) {
    const piece = list[i]
    if (i > 0) x += piece.gap
    while (x + piece.width <= COLS && clips(piece, x, baseline, height)) x++
    if (x + piece.width > COLS) break
    xs.push(x)
    x += piece.width
  }
  return { xs, placed: xs.length }
}

function draw(
  list: readonly Piece[],
  xs: readonly number[],
  baseline: number,
  height: number,
): number[][] {
  const bitmap = Array.from({ length: ROWS }, () => new Array(COLS).fill(0))
  xs.forEach((x, i) => {
    const piece = list[i]
    for (let t = 0; t < piece.rows.length; t++) {
      const row = panelRow(baseline, height, t)
      if (row < 0 || row >= bitmap.length) continue
      for (let c = 0; c < piece.rows[t].length; c++) {
        if (piece.rows[t][c] === '#') bitmap[row][x + c] = 1
      }
    }
  })
  return bitmap
}

function extent(bitmap: readonly number[][]): [number, number] | null {
  let first = -1
  let last = -1
  for (let c = 0; c < COLS; c++) {
    if (bitmap.some((row) => row[c])) {
      if (first < 0) first = c
      last = c
    }
  }
  return first < 0 ? null : [first, last]
}

/**
 * Place text on the panel, stepping glyphs around the dead LEDs.
 *
 * Defaults to `tall7`, which is the font that needs this. A shorter font placed
 * through here simply never clips and comes back centred.
 */
export function staticText(text: string, opts: StaticOptions = {}): StaticPlacement {
  const font: Font = opts.font ?? TALL7
  const baseline = opts.baseline ?? font.baseline
  const height = font.height
  const list = pieces(text, font, { font, spacing: opts.spacing, kern: opts.kern })

  let best: Run | null = null
  let bestScore = Infinity
  // Keeps the fullest attempt, so a string that never fits still shows what it can.
  let fullest: Run = { xs: [], placed: -1 }
  for (let start = 0; start < COLS; start++) {
    const candidate = run(list, start, baseline, height)
    if (candidate.placed < list.length) {
      if (candidate.placed > fullest.placed) fullest = candidate
      continue
    }
    const ink = extent(draw(list, candidate.xs, baseline, height))
    // Centred first, then tightest. Centring wins because the notch is the
    // bridge between the two lenses, so balanced text reads as one thing across
    // both; spread breaks the ties, which is what stops a word being flung to
    // the two ends of the panel when a compact placement scores the same.
    const score = ink
      ? Math.abs(ink[0] - (COLS - 1 - ink[1])) * COLS + (ink[1] - ink[0])
      : 0
    if (score < bestScore) {
      best = candidate
      bestScore = score
    }
    if (!ink) break // nothing lit, so every start scores the same
  }

  const chosen = best ?? fullest
  const bitmap = draw(list, chosen.xs, baseline, height)
  return {
    bitmap,
    dropped: list
      .slice(chosen.xs.length)
      .map((p) => p.ch)
      .join(''),
    ink: extent(bitmap),
  }
}

/** Widest a single glyph of this font gets, for callers budgeting columns. */
export const widestGlyph = (font: Font): number =>
  Object.values(font.glyphs).reduce((n, rows) => Math.max(n, glyphWidth(rows)), 0)
