/**
 * The static font: 7 rows, 40% taller than the scrolling band, and it only works
 * because someone chooses where it sits.
 *
 * Rows 2 to 7 have an LED in every column. Row 1 does not: the nose notch takes
 * columns 10 to 13. This font is drawn 7 rows tall and placed with its bottom on
 * panel row 1, so its bottom row is the one row that can fall in a hole, and
 * `place.ts` is what stops that happening. It moves whole glyphs sideways until
 * none of their ink lands on a dead LED, which is why this font is static only:
 * scrolling content visits every column, so no placement can save it.
 *
 * **The capacity is 4 to 5 characters and that is the honest number.** Glyphs
 * are 4 or 5 columns wide against a 24-column panel, and the notch splits the
 * usable space into two runs of about 10 columns for any glyph with ink in its
 * bottom row, which is most of them. `place.staticText` reports what did not
 * fit rather than drawing it into a gap.
 *
 * Uppercase only, deliberately: at 4 columns wide a lowercase x-height would be
 * 4 rows and the ascenders would not distinguish themselves. `kern.glyphRows`
 * folds case, so lowercase input renders as capitals rather than as the fallback
 * box.
 */
import type { Font } from './types.js'

const GLYPHS: Record<string, string[]> = {
  A: ['.##.', '#..#', '#..#', '####', '#..#', '#..#', '#..#'],
  B: ['###.', '#..#', '#..#', '###.', '#..#', '#..#', '###.'],
  C: ['.##.', '#..#', '#...', '#...', '#...', '#..#', '.##.'],
  D: ['###.', '#..#', '#..#', '#..#', '#..#', '#..#', '###.'],
  E: ['####', '#...', '#...', '###.', '#...', '#...', '####'],
  F: ['####', '#...', '#...', '###.', '#...', '#...', '#...'],
  G: ['.##.', '#..#', '#...', '#.##', '#..#', '#..#', '.##.'],
  H: ['#..#', '#..#', '#..#', '####', '#..#', '#..#', '#..#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  J: ['..##', '...#', '...#', '...#', '...#', '#..#', '.##.'],
  K: ['#..#', '#..#', '#.#.', '##..', '#.#.', '#..#', '#..#'],
  L: ['#...', '#...', '#...', '#...', '#...', '#...', '####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#.#.#', '#.#.#', '#..##', '#...#'],
  O: ['.##.', '#..#', '#..#', '#..#', '#..#', '#..#', '.##.'],
  P: ['###.', '#..#', '#..#', '###.', '#...', '#...', '#...'],
  Q: ['.##.', '#..#', '#..#', '#..#', '#..#', '.##.', '..##'],
  R: ['###.', '#..#', '#..#', '###.', '#.#.', '#..#', '#..#'],
  S: ['.###', '#...', '#...', '.##.', '...#', '...#', '###.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#..#', '#..#', '#..#', '#..#', '#..#', '#..#', '.##.'],
  V: ['#...#', '#...#', '#...#', '#...#', '.#.#.', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],

  // Narrower than O, which is how the two stay apart at this size. band5 has no
  // column to spare for that and bars its zero instead.
  '0': ['.#.', '#.#', '#.#', '#.#', '#.#', '#.#', '.#.'],
  '1': ['.#.', '##.', '.#.', '.#.', '.#.', '.#.', '###'],
  '2': ['.##.', '#..#', '...#', '..#.', '.#..', '#...', '####'],
  '3': ['####', '...#', '..#.', '.##.', '...#', '#..#', '.##.'],
  '4': ['..#.', '.##.', '#.#.', '####', '..#.', '..#.', '..#.'],
  '5': ['####', '#...', '###.', '...#', '...#', '#..#', '.##.'],
  '6': ['.##.', '#...', '#...', '###.', '#..#', '#..#', '.##.'],
  '7': ['####', '...#', '...#', '..#.', '..#.', '.#..', '.#..'],
  '8': ['.##.', '#..#', '#..#', '.##.', '#..#', '#..#', '.##.'],
  '9': ['.##.', '#..#', '#..#', '.###', '...#', '...#', '.##.'],

  ' ': ['..', '..', '..', '..', '..', '..', '..'],
  '.': ['.', '.', '.', '.', '.', '.', '#'],
  ',': ['.', '.', '.', '.', '.', '#', '#'],
  ':': ['.', '#', '.', '.', '.', '#', '.'],
  '!': ['#', '#', '#', '#', '#', '.', '#'],
  '?': ['.##.', '#..#', '...#', '..#.', '.#..', '....', '.#..'],
  '-': ['....', '....', '....', '####', '....', '....', '....'],
  '+': ['...', '...', '.#.', '###', '.#.', '...', '...'],
  '=': ['....', '....', '####', '....', '####', '....', '....'],
  "'": ['#', '#', '.', '.', '.', '.', '.'],
  '/': ['..#', '..#', '..#', '.#.', '#..', '#..', '#..'],
  '<': ['..#', '.#.', '#..', '#..', '#..', '.#.', '..#'],
  '>': ['#..', '.#.', '..#', '..#', '..#', '.#.', '#..'],
  '(': ['.#', '#.', '#.', '#.', '#.', '#.', '.#'],
  ')': ['#.', '.#', '.#', '.#', '.#', '.#', '#.'],
  '%': ['#..#', '...#', '..#.', '.##.', '.#..', '#...', '#..#'],
}

export const TALL7: Font = {
  name: 'tall7',
  label: 'Tall',
  note: 'twice the height, 4 or 5 characters, never moves',
  scrolls: false,
  height: 7,
  /** Bottom row on panel row 1, so the glyph reaches row 7 and clears row 8. */
  baseline: 1,
  spacing: 1,
  maxTuck: 1,
  glyphs: GLYPHS,
  fallback: ['####', '#..#', '#..#', '#..#', '#..#', '#..#', '####'],
  pairs: {},
}
