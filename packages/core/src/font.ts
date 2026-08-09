/**
 * A 5-row bitmap font, sized for the band of the panel that has no gaps.
 *
 * Rows 2-7 are the only ones alive across all 24 columns (row 8 has the top
 * gap, rows 0-1 the nose notch), so glyphs are 5 tall and drawn at row 2.
 *
 * Glyphs are written top row first because that is readable in source;
 * `glyph()` flips them, since the panel's origin is bottom-left.
 */

import { ROWS } from './display.js'

export const BASELINE = 2
export const HEIGHT = 5

const GLYPHS: Record<string, string[]> = {
  'A': ['.#.', '#.#', '###', '#.#', '#.#'],
  'B': ['##.', '#.#', '##.', '#.#', '##.'],
  'C': ['.##', '#..', '#..', '#..', '.##'],
  'D': ['##.', '#.#', '#.#', '#.#', '##.'],
  'E': ['###', '#..', '##.', '#..', '###'],
  'F': ['###', '#..', '##.', '#..', '#..'],
  'G': ['.##', '#..', '#.#', '#.#', '.##'],
  'H': ['#.#', '#.#', '###', '#.#', '#.#'],
  'I': ['###', '.#.', '.#.', '.#.', '###'],
  'J': ['..#', '..#', '..#', '#.#', '.#.'],
  'K': ['#.#', '#.#', '##.', '#.#', '#.#'],
  'L': ['#..', '#..', '#..', '#..', '###'],
  'M': ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  'N': ['#..#', '##.#', '#.##', '#..#', '#..#'],
  'O': ['.#.', '#.#', '#.#', '#.#', '.#.'],
  'P': ['##.', '#.#', '##.', '#..', '#..'],
  'Q': ['.#.', '#.#', '#.#', '##.', '.##'],
  'R': ['##.', '#.#', '##.', '#.#', '#.#'],
  'S': ['.##', '#..', '.#.', '..#', '##.'],
  'T': ['###', '.#.', '.#.', '.#.', '.#.'],
  'U': ['#.#', '#.#', '#.#', '#.#', '.#.'],
  'V': ['#.#', '#.#', '#.#', '#.#', '.#.'],
  'W': ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  'X': ['#.#', '#.#', '.#.', '#.#', '#.#'],
  'Y': ['#.#', '#.#', '.#.', '.#.', '.#.'],
  'Z': ['###', '..#', '.#.', '#..', '###'],
  '0': ['.#.', '#.#', '#.#', '#.#', '.#.'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['.##', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '#..', '#..'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '##.'],
  ' ': ['..', '..', '..', '..', '..'],
  '!': ['#', '#', '#', '.', '#'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
  '.': ['.', '.', '.', '.', '#'],
  ',': ['.', '.', '.', '#', '#'],
  '-': ['...', '...', '###', '...', '...'],
  '+': ['...', '.#.', '###', '.#.', '...'],
  ':': ['.', '#', '.', '#', '.'],
  '\'': ['#', '#', '.', '.', '.'],
  '<': ['..#', '.#.', '#..', '.#.', '..#'],
  '>': ['#..', '.#.', '..#', '.#.', '#..'],
  '*': ['#.#', '.#.', '###', '.#.', '#.#'],
  '/': ['..#', '..#', '.#.', '#..', '#..'],
  '=': ['...', '###', '...', '###', '...'],
  '(': ['.#', '#.', '#.', '#.', '.#'],
  ')': ['#.', '.#', '.#', '.#', '#.'],
  '#': ['#.#', '###', '#.#', '###', '#.#'],
  '@': ['.#.', '#.#', '###', '#..', '.##'],
  '%': ['#.#', '..#', '.#.', '#..', '#.#'],
  '$': ['.#.', '###', '##.', '###', '.#.'],
  '^': ['.#.', '#.#', '...', '...', '...'],
  '_': ['...', '...', '...', '...', '###'],
  '"': ['#.#', '#.#', '...', '...', '...'],
}
const FALLBACK = ['###', '#.#', '#.#', '#.#', '###']

const rowsFor = (ch: string): string[] => GLYPHS[ch.toUpperCase()] ?? FALLBACK

/** A [row][col] bitmap for one character, bottom row first. */
export function glyph(ch: string): number[][] {
  return rowsFor(ch)
    .map((line) => [...line].map((p) => (p === '#' ? 1 : 0)))
    .reverse()
}

export const width = (ch: string): number => rowsFor(ch)[0].length

export function textWidth(text: string, spacing = 1): number {
  const total = [...text].reduce((n, c) => n + width(c) + spacing, 0)
  return Math.max(total - spacing, 0)
}

/**
 * Render text into the panel's full 9 rows, glyphs sitting at the baseline.
 *
 * `textBitmap` returns only the 5 rows the glyphs occupy, which is what the live
 * Grid path wants because it places them itself. Anything addressing panel rows
 * directly - `dats.encodeBitmap`, and any preview claiming to show what the panel
 * will show - needs them placed, or the text draws over the nose notch at rows
 * 0-1. One helper so the renderer and the preview cannot disagree.
 */
export function panelBitmap(text: string, spacing = 1, baseline = BASELINE): number[][] {
  const src = textBitmap(text, spacing)
  const cols = src[0]?.length ?? 0
  const out = Array.from({ length: ROWS }, () => new Array(cols).fill(0))
  for (let r = 0; r < HEIGHT; r++) {
    const row = baseline + r
    if (row >= ROWS) break
    for (let c = 0; c < cols; c++) out[row][c] = src[r][c]
  }
  return out
}

/** Render a whole string to a [row][col] bitmap, bottom row first. */
export function textBitmap(text: string, spacing = 1): number[][] {
  const total = textWidth(text, spacing)
  const out = Array.from({ length: HEIGHT }, () => new Array(total).fill(0))
  let x = 0
  for (const ch of text) {
    const g = glyph(ch)
    const w = width(ch)
    for (let r = 0; r < HEIGHT; r++) {
      for (let c = 0; c < w; c++) {
        if (g[r][c]) out[r][x + c] = 1
      }
    }
    x += w + spacing
  }
  return out
}
