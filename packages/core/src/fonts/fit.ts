/**
 * Which fonts there are, and what each one does with a given piece of text.
 *
 * Two questions live here because they are the same question. A picker needs the
 * list of faces; a screen needs to know, for the text in the box right now,
 * which of them keep it inside the panel and which push it over the line where
 * showing it starts costing flash. Answering the second per font is the whole
 * reason the first is worth having (`notes/library.md`, "Fonts").
 *
 * **The line, and why it moves when the font does.** Text measuring 24 columns
 * or fewer fits the live buffer: free, no flash, no `MODE`. One column wider has
 * to be a type 1 save, which is five page erases, and it scrolls because it must
 * (`notes/library.md`, "Text decides its own motion"). That boundary is a
 * property of the *rendered width*, so it lands on a different character in
 * every face: a lowercase phrase gets 7 characters in `band5`, 5 in `band6` and
 * 7 in `slim5`, and a capitalised one 6, 5 and 7. A screen that hardcodes one
 * font's boundary is wrong for the other three, which is what this module exists
 * to stop.
 *
 * **A static-only face is a different question and gets a different answer.**
 * `tall7` cannot scroll (`fonts/place.ts`), so for it there is no "wider than
 * the panel" case at all: either the whole string is placed around the notch or
 * some of it is dropped, and dropped is `usable: false` rather than a save.
 *
 * What a caller storing a choice needs, in one place:
 *
 *   - **store `font.name`**, never the object or the label. `fontByName` is the
 *     way back, and it answers `LEGACY_FONT` for anything it does not know.
 *   - **an item with no font stored is `band5` for ever**, which is what
 *     `fontByName(undefined)` gives you. That is deliberately not
 *     `DEFAULT_FONT`: the default is what a *new* item starts as and may change,
 *     while an item saved before fonts were pickable was rendered in `band5` and
 *     has to keep looking like itself.
 */
import { COLS } from '../display.js'
import { BAND5 } from './band5.js'
import { BAND6 } from './band6.js'
import { CAPS5 } from './caps5.js'
import { measure, pieces } from './kern.js'
import { staticText } from './place.js'
import { SLIM5 } from './slim5.js'
import { TALL7 } from './tall7.js'
import type { Font } from './types.js'

/**
 * Every face, in the order a picker should offer them.
 *
 * The default first, then the two that trade legibility against width, then the
 * one that cannot move. Adding a font here is what puts it in front of a user,
 * so a half-drawn face is not in this list even when it exists.
 */
export const FONTS: readonly Font[] = [BAND5, BAND6, CAPS5, SLIM5, TALL7]

/** What an item saved before any of this existed renders in. Never changes. */
export const LEGACY_FONT: Font = BAND5

/**
 * Columns that cost nothing: the live buffer is the panel and no wider.
 *
 * The same number as `content.MAX_LIVE_COLUMNS`, taken from `display.COLS`
 * directly because `content.ts` renders *through* the fonts and importing it
 * back here would be a cycle.
 */
export const FREE_COLUMNS = COLS

/** The face for a stored name. Unknown, missing or misspelt reads as legacy. */
export function fontByName(name: string | null | undefined): Font {
  if (!name) return LEGACY_FONT
  return FONTS.find((f) => f.name === name) ?? LEGACY_FONT
}

export interface Fit {
  font: Font
  /**
   * Columns the string occupies laid out in this font, kerning included.
   *
   * For a static-only font this is a floor rather than the answer: placement
   * steps glyphs sideways past the dead LEDs, so what lands on the panel can be
   * wider. `dropped` is the real verdict there.
   */
  columns: number
  /** Does showing it cost nothing? No flash, no save, straight to the panel. */
  free: boolean
  /** Will it move? Only ever true for a face that is safe to scroll. */
  scrolls: boolean
  /** Characters this font could not place. Always empty for a scrolling face. */
  dropped: string
  /** Can this font show this text at all, on any route? */
  usable: boolean
}

/** What this font does with this text, including what it costs to show it. */
export function fit(text: string, font: Font): Fit {
  const columns = measure(pieces(text, font, { font }))
  if (font.scrolls) {
    return {
      font,
      columns,
      free: columns <= FREE_COLUMNS,
      scrolls: columns > FREE_COLUMNS,
      dropped: '',
      usable: true,
    }
  }
  const dropped = staticText(text, { font }).dropped
  return {
    font,
    columns,
    free: dropped === '',
    scrolls: false,
    dropped,
    usable: dropped === '',
  }
}

/** Every offered font's verdict on one string, in `FONTS` order. */
export const fitAll = (text: string): Fit[] => FONTS.map((f) => fit(text, f))

/**
 * A font that shows this text for nothing, or null when every face has to save.
 *
 * `prefer` wins whenever it qualifies, because a user who picked a face should
 * not have it changed under them for a column; the list order decides otherwise.
 * This answers "would another font keep this free", which is the only reason a
 * screen should ever mention a font the user did not choose.
 */
export function bestFree(text: string, prefer?: Font | null): Fit | null {
  if (prefer) {
    const first = fit(text, prefer)
    if (first.free && first.usable) return first
  }
  return fitAll(text).find((f) => f.free && f.usable) ?? null
}
