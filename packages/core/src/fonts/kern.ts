/**
 * Kerning by ink profile: the gap between two glyphs is measured from their ink
 * rather than from their boxes.
 *
 * This is the whole difference between "proportional" and "variable width". A
 * fixed one-column gap is right for "HI" and leaves a hole in "To", because T's
 * arm overhangs three empty columns that the box knows nothing about. Measuring
 * the facing profiles closes the hole without a table of thousands of pairs;
 * `Font.pairs` exists for the handful the measurement gets wrong.
 *
 * **Glyphs cannot collide, and that is arithmetic rather than tuning.**
 * `tuckLimit` is the smallest sum of facing blank runs across the rows where
 * *both* glyphs have ink, so pulling by at most that much leaves at least
 * `spacing` columns of clear air on the tightest row. Rows where only one glyph
 * has ink cannot collide at all, which is why they are skipped, and it is also
 * why the boxes are allowed to overlap. A blank glyph shares no row with
 * anything, so the word space would vanish into `maxTuck`; it is special-cased
 * to zero instead.
 */
import type { Font } from './types.js'

export const glyphWidth = (rows: readonly string[]): number => rows[0]?.length ?? 0

export const isBlank = (rows: readonly string[]): boolean =>
  rows.every((row) => !row.includes('#'))

/** Blank columns from the right edge in to the row's last lit pixel. */
export function rightProfile(rows: readonly string[]): Array<number | null> {
  const w = glyphWidth(rows)
  return rows.map((row) => {
    const last = row.lastIndexOf('#')
    return last < 0 ? null : w - 1 - last
  })
}

/** Blank columns from the left edge in to the row's first lit pixel. */
export function leftProfile(rows: readonly string[]): Array<number | null> {
  return rows.map((row) => {
    const first = row.indexOf('#')
    return first < 0 ? null : first
  })
}

/**
 * The most `b` may be pulled towards `a` before their ink touches.
 *
 * `Infinity` when no row holds ink from both: nothing can collide, so the only
 * thing left to bound the pull is taste, which is `Font.maxTuck`.
 */
export function tuckLimit(a: readonly string[], b: readonly string[]): number {
  if (isBlank(a) || isBlank(b)) return 0
  const right = rightProfile(a)
  const left = leftProfile(b)
  let limit = Infinity
  for (let r = 0; r < Math.min(right.length, left.length); r++) {
    const ra = right[r]
    const lb = left[r]
    if (ra === null || lb === null) continue
    limit = Math.min(limit, ra + lb)
  }
  return limit
}

/** Blank columns to leave between two glyph boxes. Can be 0; never negative. */
export function gapBetween(
  font: Font,
  a: readonly string[],
  b: readonly string[],
  spacing: number,
  pairKey: string,
): number {
  const limit = tuckLimit(a, b)
  const wanted = font.pairs[pairKey] ?? font.maxTuck
  return Math.max(0, spacing - Math.min(wanted, limit))
}

/** Flip a glyph to bottom-row-first, which is how everything else here reads. */
export const bottomFirst = (rows: readonly string[]): number[][] =>
  rows
    .map((row) => [...row].map((p) => (p === '#' ? 1 : 0)))
    .slice()
    .reverse()

export interface Piece {
  ch: string
  /** Top row first, as written in the font. */
  rows: string[]
  width: number
  /** Blank columns before this piece. 0 for the first. */
  gap: number
}

export interface LayoutOptions {
  font?: Font
  /** Base gap between glyph boxes. Defaults to the font's own. */
  spacing?: number
  /** Off means every gap is exactly `spacing`. Defaults to on. */
  kern?: boolean
}

/**
 * Look a character up: exact, then the other case, then the fallback box.
 *
 * The other-case step is what lets a font carry one alphabet and still render
 * mixed-case text, which is how `tall7` gets away with uppercase only.
 */
export function glyphRows(font: Font, ch: string): string[] {
  return (
    font.glyphs[ch] ??
    font.glyphs[ch.toUpperCase()] ??
    font.glyphs[ch.toLowerCase()] ??
    font.fallback
  )
}

/** One entry per character, each carrying the gap that precedes it. */
export function pieces(text: string, font: Font, opts: LayoutOptions = {}): Piece[] {
  const spacing = opts.spacing ?? font.spacing
  const kern = opts.kern !== false
  const out: Piece[] = []
  for (const ch of text) {
    const rows = glyphRows(font, ch)
    const prev = out[out.length - 1]
    const gap = !prev
      ? 0
      : kern
        ? gapBetween(font, prev.rows, rows, spacing, prev.ch + ch)
        : spacing
    out.push({ ch, rows, width: glyphWidth(rows), gap })
  }
  return out
}

/** Left edge of each piece, laid out from x = 0. */
export function positions(list: readonly Piece[]): number[] {
  let x = 0
  return list.map((piece, i) => {
    if (i > 0) x += piece.gap
    const at = x
    x += piece.width
    return at
  })
}

export const measure = (list: readonly Piece[]): number =>
  list.reduce((n, piece, i) => n + piece.width + (i ? piece.gap : 0), 0)
