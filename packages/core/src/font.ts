/**
 * Text on the panel: two fonts, one layout engine, and the placement rules that
 * keep glyphs off the dead LEDs.
 *
 * The panel is 9 rows and only rows 2 to 7 have an LED in every column, which is
 * what splits this into two fonts rather than one:
 *
 *     band5   5 rows at baseline 2   scrolling, and anything that moves
 *     tall7   7 rows at baseline 1   static only, placed around the notch
 *
 * `panelBitmap` is the scrolling one and it is what `content.text` uses. It
 * keeps every glyph inside the safe band at every column, so a message can be
 * uploaded once and scrolled unattended without a stroke blinking out as it
 * crosses the nose bridge. `staticText` is the tall one and it moves glyphs
 * sideways instead, which only works because nothing moves afterwards.
 *
 * **`textWidth` and `textBitmap` are the same layout.** Both go through
 * `kern.pieces`, so a caller that measures and then renders cannot be told two
 * different widths; the width of the bitmap is the number `textWidth` returns.
 * That mattered once kerning arrived, because the gap between two glyphs is now
 * a property of the pair rather than a constant.
 *
 * Glyph tables and the kerning arithmetic: `fonts/`.
 */
import { ROWS } from './display.js'
import { BAND5 } from './fonts/band5.js'
import * as kern from './fonts/kern.js'
import { type StaticOptions, staticText } from './fonts/place.js'
import type { Font } from './fonts/types.js'

export { BAND5 } from './fonts/band5.js'
export { TALL7 } from './fonts/tall7.js'
export { staticText, widestGlyph } from './fonts/place.js'
export type { StaticOptions, StaticPlacement } from './fonts/place.js'
export type { Font } from './fonts/types.js'
export { kern }

/** Panel row the scrolling font sits on, and how tall it is. */
export const BASELINE = 2
export const HEIGHT = 5

/** What everything here uses unless told otherwise. */
export const DEFAULT_FONT = BAND5

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
