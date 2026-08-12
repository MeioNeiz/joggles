/**
 * The scrolling font: 5 rows, drawn to sit in the band that is alive across all
 * 24 columns.
 *
 * **Why it stops at 5 rows when the safe band is 6.** Rows 2 to 7 have an LED in
 * every column, so a sixth row is available, and it is deliberately left empty
 * above the caps. Scrolling text passes through every column including the nose
 * notch, so anything drawn at rows 0 or 1 flickers out for four columns as it
 * crosses; a 5-row cap height with one row of air keeps the whole glyph in the
 * clear at every position, which is the property that makes this font safe to
 * scroll at all. Height is what `tall7` is for, and it is static for the same
 * reason.
 *
 * **No descenders, for the same reason.** g j p q y are drawn inside the
 * x-height. A descender needs a row below the baseline, which is row 1, which is
 * exactly where the notch is. The cost is that g and q differ only in their
 * bottom row; the alternative was a tail that blinks four columns out of every
 * twenty-four.
 *
 * Proportions: cap height 5, ascender 5, x-height 3. Caps and lowercase share
 * the bottom row as their baseline. Widths run 1 to 5, which is what makes the
 * kerning in `kern.ts` worth having.
 *
 * `F` is exactly the glyph it has always been, and `display.test.ts` asserts its
 * bitmap. Two shapes did change: `U` used to be pixel-identical to `V`, and both
 * were the pointed one, so `U` now has a flat bottom.
 */
import type { Font } from './types.js'

const GLYPHS: Record<string, string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '#.#', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],

  a: ['...', '...', '##.', '#.#', '.##'],
  b: ['#..', '#..', '##.', '#.#', '##.'],
  c: ['...', '...', '.##', '#..', '.##'],
  d: ['..#', '..#', '.##', '#.#', '.##'],
  e: ['...', '...', '.#.', '###', '.##'],
  f: ['.##', '#..', '##.', '#..', '#..'],
  g: ['...', '...', '.##', '#.#', '###'],
  h: ['#..', '#..', '##.', '#.#', '#.#'],
  i: ['#', '.', '#', '#', '#'],
  j: ['.#', '..', '.#', '.#', '##'],
  k: ['#..', '#..', '#.#', '##.', '#.#'],
  l: ['#.', '#.', '#.', '#.', '##'],
  m: ['.....', '.....', '#####', '#.#.#', '#.#.#'],
  n: ['...', '...', '##.', '#.#', '#.#'],
  o: ['...', '...', '###', '#.#', '###'],
  p: ['...', '...', '##.', '#.#', '##.'],
  q: ['...', '...', '.##', '#.#', '.##'],
  r: ['..', '..', '##', '#.', '#.'],
  s: ['...', '...', '.##', '.#.', '##.'],
  t: ['...', '.#.', '###', '.#.', '.##'],
  u: ['...', '...', '#.#', '#.#', '###'],
  v: ['...', '...', '#.#', '#.#', '.#.'],
  w: ['.....', '.....', '#.#.#', '#.#.#', '.#.#.'],
  x: ['...', '...', '#.#', '.#.', '#.#'],
  y: ['...', '...', '#.#', '.##', '.#.'],
  z: ['...', '...', '###', '.#.', '###'],

  // Barred, because a 3-wide round zero is pixel-identical to O and unit names
  // are alphanumeric. tall7 solves the same clash by making its zero narrower.
  '0': ['.#.', '#.#', '###', '#.#', '.#.'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['.##', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '#..', '#..'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '##.'],

  ' ': ['.', '.', '.', '.', '.'],
  '!': ['#', '#', '#', '.', '#'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
  '.': ['.', '.', '.', '.', '#'],
  ',': ['.', '.', '.', '#', '#'],
  ';': ['.', '#', '.', '#', '#'],
  ':': ['.', '#', '.', '#', '.'],
  '-': ['...', '...', '###', '...', '...'],
  '+': ['...', '.#.', '###', '.#.', '...'],
  '=': ['...', '###', '...', '###', '...'],
  "'": ['#', '#', '.', '.', '.'],
  '"': ['#.#', '#.#', '...', '...', '...'],
  '<': ['..#', '.#.', '#..', '.#.', '..#'],
  '>': ['#..', '.#.', '..#', '.#.', '#..'],
  '*': ['#.#', '.#.', '###', '.#.', '#.#'],
  '/': ['..#', '..#', '.#.', '#..', '#..'],
  '\\': ['#..', '#..', '.#.', '..#', '..#'],
  '(': ['.#', '#.', '#.', '#.', '.#'],
  ')': ['#.', '.#', '.#', '.#', '#.'],
  '[': ['##', '#.', '#.', '#.', '##'],
  ']': ['##', '.#', '.#', '.#', '##'],
  '#': ['#.#', '###', '#.#', '###', '#.#'],
  '@': ['.#.', '#.#', '###', '#..', '.##'],
  '%': ['#.#', '..#', '.#.', '#..', '#.#'],
  '&': ['.#.', '#.#', '.#.', '#.#', '.##'],
  $: ['.#.', '###', '##.', '###', '.#.'],
  '^': ['.#.', '#.#', '...', '...', '...'],
  _: ['...', '...', '...', '...', '###'],
}

/**
 * Empty, and that is the finding rather than an omission.
 *
 * Every pair a kerning table is usually written for is one the profiles already
 * measure: "To" and "Yo" close to a zero gap because the arm overhangs, "HI" and
 * "no" keep their full column because the facing stems reach the box edge. An
 * entry here is only worth adding for a pair that looks wrong **after** being
 * measured, and none has been found. Adding one that merely repeats `maxTuck`
 * changes nothing and reads as if it does.
 */
const PAIRS: Record<string, number> = {}

export const BAND5: Font = {
  name: 'band5',
  label: 'Standard',
  note: 'mixed case, one row of air above the caps',
  scrolls: true,
  height: 5,
  baseline: 2,
  spacing: 1,
  maxTuck: 1,
  glyphs: GLYPHS,
  fallback: ['###', '#.#', '#.#', '#.#', '###'],
  pairs: PAIRS,
}
