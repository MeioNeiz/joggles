/**
 * The legible scrolling font: 6 rows, the whole safe band, and the one worth
 * reading at arm's length.
 *
 * **Six is the ceiling for anything that moves, and nine is not available at
 * all.** Rows 2 to 7 are the only band with an LED in every column: row 1 loses
 * columns 10-14 to the nose notch, rows 0 and 8 lose columns 9-15. Scrolling
 * content visits every column, so a glyph drawn outside that band has a stroke
 * missing for four to six columns of every pass and reads as a different letter.
 * `place.ts` can step a *static* glyph around the holes, which is what `tall7`
 * does; nothing can step a moving one. So the unused rows above and below are
 * not waste to be reclaimed by a taller face - they are the notch, and this
 * font already fills everything that is left.
 *
 * **What it spends the sixth row on, and what that costs.** `band5` leaves the
 * top row of the band empty above its caps; this one uses it, which buys an
 * x-height of 4 rows instead of 3. Lowercase is where legibility at 24 columns
 * comes from, and a 4-row `e` has a counter you can see where a 3-row `e` is
 * three strokes that merge at any brightness. The price is width, and it is the
 * largest of any face here: caps are 4 columns where `band5`'s are 3, so **122%
 * of `band5`'s width** over the corpus in `font.test.ts`, and 5 characters of a
 * lowercase phrase inside the free 24 columns where `band5` fits 7. `fit.ts` is
 * what tells a screen where that boundary has moved to.
 *
 * That is the entire difference between the two faces and it is a choice, not a
 * fix. Neither is the successor of the other, and `band5` stays `DEFAULT_FONT`
 * because every text item ever saved renders through whatever that is.
 *
 * Proportions: cap height 6, ascender 6, x-height 4, no descenders. The
 * descender row would be panel row 1, which is the notch, so g j p q y sit
 * inside the x-height exactly as they do in `band5` and for the same reason.
 * The dot on `i` sits at the cap line with a clear row under it.
 */
import type { Font } from './types.js'

const GLYPHS: Record<string, string[]> = {
  A: ['.##.', '#..#', '#..#', '####', '#..#', '#..#'],
  B: ['###.', '#..#', '###.', '#..#', '#..#', '###.'],
  C: ['.###', '#...', '#...', '#...', '#...', '.###'],
  D: ['###.', '#..#', '#..#', '#..#', '#..#', '###.'],
  E: ['####', '#...', '###.', '#...', '#...', '####'],
  F: ['####', '#...', '###.', '#...', '#...', '#...'],
  G: ['.###', '#...', '#...', '#.##', '#..#', '.###'],
  H: ['#..#', '#..#', '####', '#..#', '#..#', '#..#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '###'],
  J: ['..##', '...#', '...#', '...#', '#..#', '.##.'],
  K: ['#..#', '#.#.', '##..', '##..', '#.#.', '#..#'],
  L: ['#...', '#...', '#...', '#...', '#...', '####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#..#', '##.#', '##.#', '#.##', '#.##', '#..#'],
  O: ['.##.', '#..#', '#..#', '#..#', '#..#', '.##.'],
  P: ['###.', '#..#', '#..#', '###.', '#...', '#...'],
  Q: ['.##.', '#..#', '#..#', '#..#', '#.#.', '.#.#'],
  R: ['###.', '#..#', '#..#', '###.', '#.#.', '#..#'],
  S: ['.###', '#...', '.##.', '...#', '#..#', '.##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.', '.#.'],
  U: ['#..#', '#..#', '#..#', '#..#', '#..#', '.##.'],
  V: ['#...#', '#...#', '#...#', '.#.#.', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '.#.#.', '..#..', '..#..', '.#.#.', '#...#'],
  Y: ['#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['####', '...#', '..#.', '.#..', '#...', '####'],

  a: ['....', '....', '.##.', '#..#', '#..#', '.###'],
  b: ['#...', '#...', '###.', '#..#', '#..#', '###.'],
  c: ['....', '....', '.###', '#...', '#...', '.###'],
  d: ['...#', '...#', '.###', '#..#', '#..#', '.###'],
  e: ['....', '....', '.##.', '####', '#...', '.###'],
  f: ['.##', '#..', '###', '#..', '#..', '#..'],
  // Tail sweeping left along the baseline, where a descender would go if row 1
  // had LEDs in it. That is also what keeps g apart from q.
  g: ['....', '....', '.###', '#..#', '.###', '###.'],
  h: ['#...', '#...', '###.', '#..#', '#..#', '#..#'],
  i: ['#', '.', '#', '#', '#', '#'],
  j: ['.#', '..', '.#', '.#', '.#', '##'],
  k: ['#..', '#..', '#.#', '##.', '##.', '#.#'],
  l: ['#.', '#.', '#.', '#.', '#.', '##'],
  m: ['.....', '.....', '#####', '#.#.#', '#.#.#', '#.#.#'],
  n: ['....', '....', '###.', '#..#', '#..#', '#..#'],
  o: ['....', '....', '.##.', '#..#', '#..#', '.##.'],
  p: ['....', '....', '###.', '#..#', '###.', '#...'],
  q: ['....', '....', '.###', '#..#', '.###', '...#'],
  r: ['...', '...', '#.#', '##.', '#..', '#..'],
  s: ['....', '....', '.###', '##..', '..##', '###.'],
  t: ['.#.', '.#.', '###', '.#.', '.#.', '.##'],
  u: ['....', '....', '#..#', '#..#', '#..#', '.###'],
  v: ['.....', '.....', '#...#', '#...#', '.#.#.', '..#..'],
  w: ['.....', '.....', '#...#', '#.#.#', '#.#.#', '.#.#.'],
  x: ['....', '....', '#..#', '.##.', '.##.', '#..#'],
  y: ['....', '....', '#..#', '.##.', '.#..', '##..'],
  z: ['....', '....', '####', '..#.', '.#..', '####'],

  // Slashed, for the reason band5 bars its zero: every unit is called something
  // like GLASSES-125B37, so a round 0 that reads as O is a wrong answer rather
  // than an ugly one.
  '0': ['.##.', '#..#', '#.##', '##.#', '#..#', '.##.'],
  '1': ['.#.', '##.', '.#.', '.#.', '.#.', '###'],
  '2': ['.##.', '#..#', '...#', '..#.', '.#..', '####'],
  '3': ['####', '..#.', '.##.', '...#', '#..#', '.##.'],
  '4': ['..#.', '.##.', '#.#.', '####', '..#.', '..#.'],
  '5': ['####', '#...', '###.', '...#', '#..#', '###.'],
  '6': ['.##.', '#...', '###.', '#..#', '#..#', '.##.'],
  '7': ['####', '...#', '..#.', '.#..', '.#..', '.#..'],
  '8': ['.##.', '#..#', '.##.', '#..#', '#..#', '.##.'],
  '9': ['.##.', '#..#', '#..#', '.###', '...#', '.##.'],

  ' ': ['..', '..', '..', '..', '..', '..'],
  '!': ['#', '#', '#', '#', '.', '#'],
  '?': ['.##.', '#..#', '...#', '..#.', '....', '..#.'],
  '.': ['.', '.', '.', '.', '.', '#'],
  ',': ['..', '..', '..', '..', '.#', '#.'],
  ';': ['..', '..', '.#', '..', '.#', '#.'],
  ':': ['.', '.', '#', '.', '#', '.'],
  '-': ['...', '...', '...', '###', '...', '...'],
  '+': ['...', '...', '.#.', '###', '.#.', '...'],
  '=': ['...', '...', '###', '...', '###', '...'],
  "'": ['#', '#', '.', '.', '.', '.'],
  '"': ['#.#', '#.#', '...', '...', '...', '...'],
  '<': ['...', '..#', '.#.', '#..', '.#.', '..#'],
  '>': ['...', '#..', '.#.', '..#', '.#.', '#..'],
  '*': ['...', '#.#', '.#.', '###', '.#.', '#.#'],
  '/': ['..#', '..#', '.#.', '.#.', '#..', '#..'],
  '\\': ['#..', '#..', '.#.', '.#.', '..#', '..#'],
  '(': ['.#', '#.', '#.', '#.', '#.', '.#'],
  ')': ['#.', '.#', '.#', '.#', '.#', '#.'],
  '[': ['##', '#.', '#.', '#.', '#.', '##'],
  ']': ['##', '.#', '.#', '.#', '.#', '##'],
  '#': ['.#.#.', '#####', '.#.#.', '.#.#.', '#####', '.#.#.'],
  '@': ['.###.', '#...#', '#.###', '#.#.#', '#....', '.###.'],
  '%': ['##..#', '##.#.', '..#..', '.#...', '#..##', '#..##'],
  '&': ['.#..', '#.#.', '.#..', '#.#.', '#..#', '.##.'],
  $: ['.#.', '###', '##.', '.##', '###', '.#.'],
  '^': ['.#.', '#.#', '...', '...', '...', '...'],
  _: ['....', '....', '....', '....', '....', '####'],
}

/**
 * Empty for the reason `band5`'s is: the ink profiles already close every pair a
 * table is usually written for, and an entry that merely repeats `maxTuck`
 * changes nothing while reading as if it does. The taller x-height makes this
 * more true rather than less, because the facing profiles now have four rows of
 * evidence instead of three.
 */
const PAIRS: Record<string, number> = {}

export const BAND6: Font = {
  name: 'band6',
  label: 'Large',
  note: 'fills the safe band, easiest to read, fewer characters free',
  scrolls: true,
  height: 6,
  /** Bottom row on panel row 2, top row on 7: exactly the band that is alive. */
  baseline: 2,
  spacing: 1,
  maxTuck: 1,
  glyphs: GLYPHS,
  fallback: ['####', '#..#', '#..#', '#..#', '#..#', '####'],
  pairs: PAIRS,
}
