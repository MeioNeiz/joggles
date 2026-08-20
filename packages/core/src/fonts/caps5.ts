/**
 * The narrow legible face: 5 rows, capitals and digits only, and no two glyphs
 * within one pixel of each other.
 *
 * **Why a caps-only face exists at all.** The measurement in
 * `packages/cli/src/legibility.ts` says the lineup had a hole in it: `band6` is
 * the only face with no one-pixel ambiguity, and it is also the widest, so the
 * clear choice was always the one that scrolls soonest and costs flash. `band5`
 * and `slim5` are narrower and ambiguous, ten and fifteen such pairs. Five of
 * `band5`'s ten involve lowercase (`F`/`f`, `c`/`q`, `g`/`o`, `g`/`q`, `o`/`u`),
 * and lowercase is what a 3-row x-height cannot draw distinctly. Dropping it
 * removes those by construction and leaves five capital pairs to solve by hand,
 * which is what this face does. The result is narrow *and* unambiguous, which
 * nothing else here was.
 *
 * **What it gives up.** Lowercase. `kern.glyphRows` folds a lowercase character
 * onto its capital, exactly as `tall7` does, so "Jacob" renders as "JACOB" rather
 * than refusing. A message that wants two cases wants `band6`.
 *
 * **The five capital pairs, and how each is separated.** Every one of these is a
 * pair `band5` leaves a single pixel apart:
 *
 * | Pair | There | Here |
 * | --- | --- | --- |
 * | `H`/`K` | `K` was `H` with one arm pixel moved | `K` has a real junction, arms at rows 1 and 3 off a solid stem |
 * | `K`/`X` | both were two stems with a middle pixel | `X` crosses at the centre, `K` does not touch column 2 in its middle row |
 * | `O`/`Q` | `Q` was `O` plus one corner | `Q` is 4 wide with the tail outside the bowl |
 * | `O`/`0` | `0` was `O` plus a centre bar | `0` is 4 wide and slashed |
 * | `Z`/`2` | `2` was `Z` minus one corner | `2` is 4 wide with a round head |
 *
 * `E`/`F` and `B`/`R` are the same trap one step further out, so `F` is 2 columns
 * against `E`'s 3, and `R`'s leg leaves the stem a row earlier than `B`'s bowl
 * closes.
 *
 * Proportions: cap height 5, baseline 2, widths 1 to 5. Inside rows 2 to 7, the
 * band with an LED in every column, so it scrolls.
 */
import type { Font } from './types.js'

const GLYPHS: Record<string, string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  // 2 wide against E's 3. As a 3-wide glyph F is E without its bottom bar, one
  // pixel away, and narrowing it is both the fix and the right proportion.
  F: ['##', '#.', '##', '#.', '#.'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.##'],
  // A junction rather than a moved pixel: solid stem, arms at rows 1 and 3, and
  // nothing in column 2 of the middle row. Six pixels from H and six from X.
  K: ['#.#', '##.', '#..', '##.', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  // 4 wide, tail outside the bowl. As a 3-wide glyph Q is O with one corner
  // added, which is the single pixel that made unit names unreadable.
  Q: ['.#..', '#.#.', '#.#.', '#.#.', '.#.#'],
  // The leg leaves the stem a row before B's lower bowl closes, so R is four
  // pixels from B rather than the one it is in band5.
  R: ['##.', '#.#', '##.', '##.', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '.#.', '.#.'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],

  // 4 wide and slashed. A 3-wide round zero is O exactly, and a barred one is O
  // plus a pixel; every unit is called something like GLASSES-125B37, so this is
  // the pair that matters most.
  '0': ['.##.', '#.##', '#.##', '##.#', '.##.'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  // 4 wide with a round head, against Z's square 3. As a 3-wide glyph 2 is Z
  // with one corner missing.
  '2': ['.##.', '#..#', '..#.', '.#..', '####'],
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

/** Nothing measured needs overriding, for the reason `band5.ts` sets out. */
const PAIRS: Record<string, number> = {}

export const CAPS5: Font = {
  name: 'caps5',
  label: 'Caps',
  note: 'capitals only, narrow, nothing one pixel from anything else',
  scrolls: true,
  height: 5,
  baseline: 2,
  spacing: 1,
  maxTuck: 1,
  glyphs: GLYPHS,
  fallback: ['###', '#.#', '#.#', '#.#', '###'],
  pairs: PAIRS,
}
