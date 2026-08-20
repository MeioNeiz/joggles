/**
 * Text on the panel: four faces, one layout engine, and the placement rules that
 * keep glyphs off the dead LEDs.
 *
 * The panel is 9 rows and only rows 2 to 7 have an LED in every column. That one
 * fact splits every font here into two kinds:
 *
 *     band5   5 rows at baseline 2   scrolling. One row of air above the caps
 *     band6   6 rows at baseline 2   scrolling. The whole band, x-height of 4
 *     slim5   5 rows at baseline 2   scrolling. Condensed, more free columns
 *     tall7   7 rows at baseline 1   static only, placed around the notch
 *
 * **Six rows is the ceiling for anything that moves, and the rows above and
 * below are the notch rather than waste.** Scrolling content visits every
 * column, so a glyph outside rows 2 to 7 loses a stroke for the four to six
 * columns it spends crossing the nose bridge and reads as a different letter.
 * There is no 9-row scrolling font to be had, however much of the panel looks
 * unused; height beyond the band is available to *static* text only, which is
 * what `tall7` is. `fonts/band6.ts` carries the long form of that argument, and
 * `band5` spending its sixth row on air is a legibility choice rather than an
 * oversight (`fonts/band5.ts`).
 *
 * **`DEFAULT_FONT` is `band6`, and it is what a *new* item starts as.**
 * *Corrected 2026-08-14: this said the default was `band5` and that changing it
 * changes old content. The second half was wrong, and it is the reason the
 * default sat on the less legible face. An item saved with no face recorded is
 * read through `fit.fontByName(undefined)`, which answers `LEGACY_FONT`, pinned
 * to `band5` and deliberately not following this constant. So old content is
 * unaffected by this line; only what a new message starts as moves.*
 *
 * `band6` is the default because it is measurably the clearest at 24 columns, not
 * as a matter of taste. Compared pixel by pixel across letters and digits,
 * `band5` has ten pairs that differ by a single pixel (`H`/`K`, `K`/`X`, `O`/`Q`,
 * `O`/`0`, `Z`/`2`, `F`/`f`, `c`/`q`, `g`/`o`, `g`/`q`, `o`/`u`) and `slim5` has
 * fifteen; `band6` has none. One pixel is a coin toss on a panel that is moving.
 * The sixth row is what buys it, by giving lowercase an x-height of 4 instead of
 * 3. `font.test.ts` holds the default to that standard so it cannot regress.
 *
 * What it costs is width, and the cost is small: over the corpus in
 * `font.test.ts` the mean message is 19.9 columns against `band5`'s 16.4, and of
 * 34 sample messages 27 still fit the free 24 columns where `band5` fits 29. Two
 * messages in 34 move from free to a five-erase save, in exchange for an
 * alphabet with no one-pixel ambiguity left in it.
 *
 * `panelBitmap` is the scrolling path and it is what `content.text` uses. It
 * keeps every glyph inside the safe band at every column, so a message can be
 * uploaded once and scrolled unattended. `staticText` is the tall one and it
 * moves glyphs sideways instead, which only works because nothing moves
 * afterwards.
 *
 * **`textWidth` and `textBitmap` are the same layout.** Both go through
 * `kern.pieces`, so a caller that measures and then renders cannot be told two
 * different widths; the width of the bitmap is the number `textWidth` returns.
 * That mattered once kerning arrived, because the gap between two glyphs is now
 * a property of the pair rather than a constant.
 *
 * Which face to offer, and where the free-or-flash line falls in each of them:
 * `fonts/fit.ts`. Glyph tables and the kerning arithmetic: `fonts/`.
 */
import { ROWS } from './display.js'
import { BAND6 } from './fonts/band6.js'
import { CAPS5 } from './fonts/caps5.js'
import * as kern from './fonts/kern.js'
import { type StaticOptions, staticText } from './fonts/place.js'
import type { Font } from './fonts/types.js'

export { BAND5 } from './fonts/band5.js'
export { BAND6 } from './fonts/band6.js'
export { CAPS5 } from './fonts/caps5.js'
export { SLIM5 } from './fonts/slim5.js'
export { TALL7 } from './fonts/tall7.js'
export { staticText, widestGlyph } from './fonts/place.js'
export type { StaticOptions, StaticPlacement } from './fonts/place.js'
export type { Font } from './fonts/types.js'
export {
  FONTS,
  FREE_COLUMNS,
  LEGACY_FONT,
  bestFree,
  fit,
  fitAll,
  fontByName,
} from './fonts/fit.js'
export type { Fit } from './fonts/fit.js'
export { kern }

/**
 * Where `band5` sits and how tall it is, kept because every CLI script and the
 * live `Grid` path was written against these two numbers. They are that font's
 * metrics, not every font's: anything handling a chosen face should read
 * `font.baseline` and `font.height` off the `Font`, which is what `panelBitmap`
 * does.
 */
export const BASELINE = 2
export const HEIGHT = 5

/**
 * What everything here uses unless told otherwise, and what a new message starts
 * as.
 *
 * `caps5`, Jacob's call 2026-08-20, and the measurement in
 * `packages/cli/src/legibility.ts` backs it rather than merely permitting it: it is
 * the only face here that is narrow **and** unambiguous. `band6` also has no pair
 * within one pixel, but it is the widest, so choosing it meant choosing the face
 * that scrolls soonest and costs flash first; `band5` and `slim5` are narrower and
 * ambiguous, at ten and fifteen such pairs.
 *
 * **What it costs is lowercase, and the cost is silent by design.**
 * `kern.glyphRows` folds a lowercase character onto its capital exactly as `tall7`
 * does, so "Jacob" renders as "JACOB" rather than being refused. Every new message
 * is therefore shouted unless someone picks another face, which is a legibility
 * trade at 5 rows of cap height and not an oversight. A message that wants two
 * cases wants `band6`, and the picker on the Message screen is how you get it.
 *
 * This is **not** the read path for stored items that name no face; that is
 * `LEGACY_FONT`, which stays `band5` so nothing already saved changes shape.
 * Changing this constant changes what a *new* item starts as and nothing else.
 */
export const DEFAULT_FONT = CAPS5

/**
 * A base gap in columns, or the full set. The number form is what every call
 * site used before there was more than one font, and it still means `spacing`.
 */
export type Options = number | kern.LayoutOptions

interface Resolved {
  font: Font
  spacing: number
  kern: boolean
}

function resolve(opts: Options = {}): Resolved {
  const o = typeof opts === 'number' ? { spacing: opts } : opts
  const font = o.font ?? DEFAULT_FONT
  return { font, spacing: o.spacing ?? font.spacing, kern: o.kern !== false }
}

const laid = (text: string, opts: Options) => {
  const r = resolve(opts)
  return { font: r.font, list: kern.pieces(text, r.font, r) }
}

/** A `[row][col]` bitmap for one character, bottom row first. */
export function glyph(ch: string, font: Font = DEFAULT_FONT): number[][] {
  return kern.bottomFirst(kern.glyphRows(font, ch))
}

/** Columns one character occupies, before any kerning with its neighbours. */
export const width = (ch: string, font: Font = DEFAULT_FONT): number =>
  kern.glyphWidth(kern.glyphRows(font, ch))

/** Columns the whole string occupies, kerning included. */
export function textWidth(text: string, opts: Options = {}): number {
  return kern.measure(laid(text, opts).list)
}

/** The string as a `[row][col]` bitmap, bottom row first, font height rows tall. */
export function textBitmap(text: string, opts: Options = {}): number[][] {
  const { font, list } = laid(text, opts)
  const xs = kern.positions(list)
  const out = Array.from({ length: font.height }, () =>
    new Array(kern.measure(list)).fill(0),
  )
  list.forEach((piece, i) => {
    for (let t = 0; t < piece.rows.length; t++) {
      const row = font.height - 1 - t
      for (let c = 0; c < piece.rows[t].length; c++) {
        if (piece.rows[t][c] === '#') out[row][xs[i] + c] = 1
      }
    }
  })
  return out
}

/**
 * Render into the panel's full 9 rows, glyphs sitting at the baseline.
 *
 * `textBitmap` returns only the rows the glyphs occupy, which is what the live
 * `Grid` path wants because it places them itself. Anything addressing panel
 * rows directly - `dats.encodeBitmap`, and any preview claiming to show what the
 * panel will show - needs them placed, or the text draws over the nose notch at
 * rows 0 and 1. One helper so the renderer and the preview cannot disagree.
 */
export function panelBitmap(text: string, opts: Options = {}, baseline?: number): number[][] {
  const { font } = resolve(opts)
  const src = textBitmap(text, opts)
  const at = baseline ?? font.baseline
  const cols = src[0]?.length ?? 0
  const out = Array.from({ length: ROWS }, () => new Array(cols).fill(0))
  for (let r = 0; r < font.height; r++) {
    const row = at + r
    if (row >= ROWS) break
    for (let c = 0; c < cols; c++) out[row][c] = src[r][c]
  }
  return out
}

/**
 * The tall font placed on the panel, as a 9 by 24 bitmap.
 *
 * Drops what does not fit rather than clipping it; `staticText` returns the same
 * bitmap plus the characters it had to drop, which is what a screen should show
 * the user. Static only: see `fonts/place.ts`.
 */
export const staticBitmap = (text: string, opts: StaticOptions = {}): number[][] =>
  staticText(text, opts).bitmap

/**
 * Text in whichever face was chosen, drawn the only way that face can be drawn.
 *
 * **The trap this closes.** `panelBitmap` sits a glyph on the font's baseline
 * and draws it, which is right for the three scrolling faces and wrong for
 * `tall7`: its baseline is panel row 1, where the nose notch has no LEDs, so the
 * direct call puts strokes on dead pixels and the letters come back missing
 * pieces. A static face has to go through `staticText`, which steps whole glyphs
 * past the holes. Anything holding a `Font` a person picked should call this
 * rather than choosing between the two itself.
 *
 * Nine rows either way, and as wide as the text needs for a scrolling face or
 * exactly 24 for a static one. **It does not report drops**: a static placement
 * can leave characters out, and `fit.fit(text, font).dropped` is what says so.
 */
export function panelFor(text: string, font: Font = DEFAULT_FONT): number[][] {
  return font.scrolls ? panelBitmap(text, { font }) : staticText(text, { font }).bitmap
}
