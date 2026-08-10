/**
 * What a font is here.
 *
 * Glyph source is written **top row first**, because that is the only way a
 * bitmap font is readable in a text editor, and every consumer of this package
 * works bottom row first to match the panel's origin. `kern.bottomFirst` is the
 * one place that flips, so no glyph table ever has to be read upside down.
 */
export interface Font {
  readonly name: string
  /** Rows a glyph occupies, which is not the panel's 9. */
  readonly height: number
  /** Panel row the bottom row of a glyph sits on, by default. */
  readonly baseline: number
  /** Blank columns between glyph boxes, before kerning takes any of them back. */
  readonly spacing: number
  /**
   * Most columns kerning may remove from `spacing`.
   *
   * A cap on taste, not on safety: glyphs cannot collide whatever this says,
   * because `kern.tuckLimit` bounds the pull by the facing ink. Raising it makes
   * open pairs like "To" tighter, and past 2 at this size words start to fuse.
   */
  readonly maxTuck: number
  /** Top row first, `#` lit, every row of a glyph the same length. */
  readonly glyphs: Record<string, string[]>
  readonly fallback: string[]
  /**
   * Tuck in columns for one named pair, overriding what the profiles measure.
   * Key is the two characters as typed, before any case folding, so a tall7
   * entry needs both spellings. Still clamped by `tuckLimit`, so an entry here
   * cannot make two glyphs touch.
   */
  readonly pairs: Record<string, number>
}
