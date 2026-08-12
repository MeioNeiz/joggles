/**
 * The condensed scrolling font: same 5 rows as `band5`, redrawn narrow, so more
 * of a message stays on the free route.
 *
 * **Why narrow is worth a whole font here.** A message that measures 24 columns
 * or fewer rides the live buffer and costs nothing; one column wider has to be
 * saved, which is five page erases, and the boundary falls mid-word
 * (`notes/library.md`, "Text decides its own motion"). Width is therefore not a
 * matter of taste at this size, it is which side of a price change a sentence
 * lands on.
 *
 * **What it actually buys, measured rather than asserted.** Against `band5`,
 * about a twentieth on mixed-case text and about a tenth on capitals: 95% of
 * `band5`'s width over the corpus in `font.test.ts`, and one more capital inside
 * the free 24 columns (7 where `band5` gives 6). The example this repo has been
 * quoting since the boundary was found flips: **`JOGGLES` is 27 columns in
 * `band5` and 24 in this face**, which is the difference between five page
 * erases and free. A tenth is not a different alphabet, and the honest way to
 * offer it is per string through `fit.ts` rather than as a promise.
 *
 * **Where the columns come from.** The stem-and-arm letters drop to 2 columns
 * (C E F J L, and c f j l r t keep or reach 2), `l` becomes a bare 1-column
 * stem, and M N W come down from 5 and 4. Everything else is `band5`'s shape,
 * because it was already at the 3-column floor for a legible 5-row cap.
 *
 * **What deliberately did not shrink.**
 *
 *   - `m` and `w` keep five columns. Three stems need three columns and two
 *     gaps; a four-column `m` reads as an `n` with a thick leg.
 *   - Every digit keeps `band5`'s three columns. Unit names are alphanumeric
 *     (`GLASSES-125B37`), so an ambiguous digit is a wrong answer rather than an
 *     ugly one, and that is also why the zero stays barred.
 *   - `I` keeps its three columns and its serifs, which is what tells it apart
 *     from the now 1-column `l`. Narrowing both is how a condensed face makes
 *     "Ill" unreadable.
 *   - Brackets widen to 3, because a 2-column `[` is pixel-identical to this
 *     font's `C`. Rare punctuation pays for a common letter, not the other way
 *     round.
 *
 * Same band as `band5` (panel rows 2 to 6, one row of air above the caps), so
 * the same reasoning applies unchanged: safe to scroll at every column, no
 * descenders, and `fonts/band6.ts` explains why nothing that moves can be
 * taller than six rows.
 */
import type { Font } from './types.js'

const GLYPHS: Record<string, string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['##', '#.', '#.', '#.', '##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['##', '#.', '##', '#.', '##'],
  F: ['##', '#.', '##', '#.', '#.'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['.#', '.#', '.#', '.#', '##'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#.', '#.', '#.', '#.', '##'],
  M: ['#..#', '####', '#..#', '#..#', '#..#'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '#.#', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#..#', '#..#', '#..#', '####', '.##.'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],

  a: ['...', '...', '##.', '#.#', '.##'],
  b: ['#..', '#..', '##.', '#.#', '##.'],
  c: ['..', '..', '##', '#.', '##'],
  d: ['..#', '..#', '.##', '#.#', '.##'],
  e: ['...', '...', '.#.', '###', '.##'],
  f: ['.#', '#.', '##', '#.', '#.'],
  g: ['...', '...', '.##', '#.#', '###'],
  h: ['#..', '#..', '##.', '#.#', '#.#'],
  i: ['#', '.', '#', '#', '#'],
  j: ['.#', '..', '.#', '.#', '##'],
  k: ['#..', '#..', '#.#', '##.', '#.#'],
  l: ['#', '#', '#', '#', '#'],
  m: ['.....', '.....', '#####', '#.#.#', '#.#.#'],
  n: ['...', '...', '##.', '#.#', '#.#'],
  o: ['...', '...', '###', '#.#', '###'],
  p: ['...', '...', '##.', '#.#', '##.'],
  q: ['...', '...', '.##', '#.#', '.##'],
  r: ['..', '..', '##', '#.', '#.'],
  s: ['...', '...', '.##', '.#.', '##.'],
  t: ['..', '#.', '##', '#.', '.#'],
  u: ['...', '...', '#.#', '#.#', '###'],
  v: ['...', '...', '#.#', '#.#', '.#.'],
  w: ['.....', '.....', '#.#.#', '#.#.#', '.#.#.'],
  x: ['...', '...', '#.#', '.#.', '#.#'],
  y: ['...', '...', '#.#', '.##', '.#.'],
  z: ['...', '...', '###', '.#.', '###'],

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
  '[': ['##.', '#..', '#..', '#..', '##.'],
  ']': ['.##', '..#', '..#', '..#', '.##'],
  '#': ['#.#', '###', '#.#', '###', '#.#'],
  '@': ['.#.', '#.#', '###', '#..', '.##'],
  '%': ['#.#', '..#', '.#.', '#..', '#.#'],
  '&': ['.#.', '#.#', '.#.', '#.#', '.##'],
  $: ['.#.', '###', '##.', '###', '.#.'],
  '^': ['.#.', '#.#', '...', '...', '...'],
  _: ['...', '...', '...', '...', '###'],
}

/**
 * Empty, and it was checked rather than copied from `band5`.
 *
 * At `spacing: 1` a pair entry has exactly one bit of freedom - gap 1 or gap 0 -
 * so the only entry worth writing is one that **refuses** a tuck the profiles
 * allow, for a pair that measures clear and still reads as fused. None was
 * found, because this font's shapes have almost no overhang left to tuck into:
 * the letters that usually need a table ("To", "Ya") are the ones already drawn
 * at 2 columns, so their profiles measure a 0 limit and the pair keeps its
 * column. An entry that repeats `maxTuck` changes nothing and reads as if it
 * does.
 */
const PAIRS: Record<string, number> = {}

export const SLIM5: Font = {
  name: 'slim5',
  label: 'Narrow',
  note: 'condensed, about one more character before it has to scroll',
  scrolls: true,
  height: 5,
  baseline: 2,
  spacing: 1,
  maxTuck: 1,
  glyphs: GLYPHS,
  fallback: ['###', '#.#', '#.#', '#.#', '###'],
  pairs: PAIRS,
}
