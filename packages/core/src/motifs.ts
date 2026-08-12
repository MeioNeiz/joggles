/**
 * Named pictures, drawn by arithmetic rather than typed out as arrays.
 *
 * The first content request this project has had, and it is a costume: *"I am gonna
 * dress up as Walwuiji, luigi's brother, so I defintely need some waluwuiji themed
 * images and or animations. But like at least a W W for each eye"* (Jacob, 2026-08-12,
 * `notes/what-to-build.md`). The letter is the obvious part; the theme has more in it,
 * so the moustache, the overalls' zigzag and the cap emblem are here too.
 *
 * **Why a function per motif and not a pasted grid.** A literal is unreadable, cannot be
 * re-sized when a motif needs to fill a wide loop instead of a panel, and rots silently
 * when the geometry constants move. Every motif below is drawn from `display`'s own
 * numbers, so a change to `ROWS`, `COLS` or the alive band moves the pictures with it.
 *
 * **A W per lens is the panel's own shape.** The two lenses are columns 0-11 and 12-23
 * of one 24-column surface (*verified* 2026-08-12: lighting column 0 lit exactly one
 * column, at the leftmost edge, so this is one surface and not two mirrored halves).
 * `perLens` therefore draws the same glyph twice, centred in each half, rather than
 * drawing once and hoping the panel mirrors it.
 *
 * **Everything here fits the live buffer**, so showing a motif writes no flash at all:
 * 24 columns is the panel, and the free route. The one exception is `wLoop`, which is
 * wide on purpose because the device can only animate by translating a saved buffer.
 *
 * Rows 2 to 7 unless a motif says otherwise: that band is alive in every column, where
 * rows 0, 1 and 8 have holes (`display.alive`). Staying inside it is what stops a motif
 * losing a limb as it crosses the nose bridge.
 */
import { type Bitmap, blank } from './content.js'
import { COLS, MAX_LEVEL, ROWS, alive } from './display.js'

/** The alive band, which is where a motif may draw without losing pixels to a hole. */
export const BAND_LOW = 2
export const BAND_HIGH = 7
export const BAND_ROWS = BAND_HIGH - BAND_LOW + 1

/** Columns belonging to one lens. The panel is two of these, side by side. */
export const LENS_COLS = COLS / 2

const set = (bitmap: Bitmap, row: number, col: number, level = MAX_LEVEL): void => {
  if (row < 0 || row >= ROWS || col < 0 || col >= bitmap[0].length) return
  bitmap[row][col] = level
}

/**
 * A straight line, Bresenham, in bitmap coordinates.
 *
 * The same algorithm the draw canvas uses for a dragged finger, for the same reason:
 * a stroke defined by its endpoints survives being re-scaled, where a stroke typed out
 * as pixels does not.
 */
function stroke(
  bitmap: Bitmap,
  from: [number, number],
  to: [number, number],
  level = MAX_LEVEL,
): void {
  let [r0, c0] = from
  const [r1, c1] = to
  const dr = Math.abs(r1 - r0)
  const dc = Math.abs(c1 - c0)
  const sr = r0 < r1 ? 1 : -1
  const sc = c0 < c1 ? 1 : -1
  let err = dc - dr
  for (;;) {
    set(bitmap, r0, c0, level)
    if (r0 === r1 && c0 === c1) return
    const e2 = 2 * err
    if (e2 > -dr) {
      err -= dr
      c0 += sc
    }
    if (e2 < dc) {
      err += dc
      r0 += sr
    }
  }
}

/**
 * The letter W, as four strokes down-up-down-up across `width` columns.
 *
 * Drawn rather than spelled: the glyph has to work at 7 columns inside a lens and at
 * whatever width a wide loop gives it, and four endpoints scale where a bitmap does
 * not. `font.ts` is not the right home for it, because this is a picture that happens
 * to be a letter shape: it uses the full alive band, it is drawn per lens, and it must
 * not inherit the kerning and baseline rules a text face lives by.
 */
export function wGlyph(width = 7, height = BAND_ROWS): Bitmap {
  const bitmap = Array.from({ length: height }, () => new Array(width).fill(0))
  const top = height - 1
  const bottom = 0
  // The four vertices, spread across the width: outer top, inner bottom, middle top,
  // and back out. Rounded rather than floored so an even width stays symmetric.
  //
  // The inner vertices are mirrored rather than computed separately, or rounding puts
  // them at different distances from the edges: at width 12 the thirds land on 4 and 7
  // of 0-11, which is one column off centre and reads as a leaning W. An EVEN width
  // still cannot be perfectly symmetric, because there is no centre column to put the
  // peak on: the same problem `content.centre` has, answered the same way, by choosing
  // a side and saying so. Odd widths, including the default 7, are exact.
  const inner = Math.round((width - 1) / 3)
  const x = [0, inner, width - 1 - inner, width - 1]
  const mid = Math.floor((width - 1) / 2)
  // The middle peak rises to one row below the outer tops. Two thirds height was tried
  // first and reads as two V's with a stub between them: the peak is what separates a W
  // from a zigzag, so it has to be nearly as tall as the arms.
  const peak = Math.max(bottom + 1, top - 1)
  // Every stroke is drawn from the centre line outwards, so the two halves are mirror
  // images by construction. Drawn as one continuous path instead, Bresenham breaks its
  // ties in opposite directions on the way out and on the way back, and the left arm
  // grows a three-pixel blob the right arm does not have. Symmetry is the whole reason
  // a W is legible at seven columns.
  stroke(bitmap, [top, x[0]], [bottom, x[1]], MAX_LEVEL)
  stroke(bitmap, [top, x[3]], [bottom, x[2]], MAX_LEVEL)
  stroke(bitmap, [peak, mid], [bottom, x[1]], MAX_LEVEL)
  stroke(bitmap, [peak, mid], [bottom, x[2]], MAX_LEVEL)
  return bitmap
}

/** Lift a band-height picture into a full panel bitmap at the alive band. */
function inBand(art: Bitmap, at: number, width = COLS): Bitmap {
  const out = blank(width)
  for (let r = 0; r < art.length; r++) {
    for (let c = 0; c < art[r].length; c++) {
      if (art[r][c] > 0) set(out, BAND_LOW + r, at + c, art[r][c])
    }
  }
  return out
}

/** Draw one picture centred in each lens: the "W W" as asked for. */
export function perLens(art: Bitmap): Bitmap {
  const width = art[0]?.length ?? 0
  const at = Math.max(0, Math.floor((LENS_COLS - width) / 2))
  const out = blank(COLS)
  for (const lens of [0, LENS_COLS]) {
    for (let r = 0; r < art.length; r++) {
      for (let c = 0; c < art[r].length; c++) {
        if (art[r][c] > 0) set(out, BAND_LOW + r, lens + at + c, art[r][c])
      }
    }
  }
  return out
}

/** **The one Jacob asked for**: a W on each lens, panel width, free to show. */
export const ww = (): Bitmap => perLens(wGlyph())

/**
 * The moustache: two upswept curls meeting under the bridge.
 *
 * Drawn as one shape across the whole panel rather than per lens, because a moustache
 * that stops at the nose reads as two commas. It sits low in the band so the curls have
 * somewhere to rise to.
 */
export function moustache(): Bitmap {
  const art = Array.from({ length: BAND_ROWS }, () => new Array(COLS).fill(0))
  const mid = COLS / 2
  for (const dir of [-1, 1]) {
    const end = mid + dir * (mid - 2)
    // The body: a long sweep out from the bridge, rising as it goes.
    stroke(art, [1, mid + dir], [2, end + -dir * 3], MAX_LEVEL)
    stroke(art, [2, mid + dir * 2], [3, end + -dir * 2], MAX_LEVEL)
    // The curl: back down and in, which is what makes it a moustache and not a line.
    stroke(art, [3, end + -dir * 2], [4, end], MAX_LEVEL)
    stroke(art, [4, end], [3, end + dir], MAX_LEVEL)
  }
  return inBand(art, 0)
}

/**
 * The overalls' zigzag, as a repeating chevron across both lenses.
 *
 * Continuous across the bridge on purpose: it is the one motif here that reads better
 * spanning the panel than doubled, and it is the shape a viewer recognises before they
 * recognise anything else about the costume.
 */
export function zigzag(step = 4): Bitmap {
  const art = Array.from({ length: BAND_ROWS }, () => new Array(COLS).fill(0))
  const low = 1
  const high = BAND_ROWS - 2
  let up = true
  for (let c = 0; c < COLS - 1; c += step) {
    const to = Math.min(COLS - 1, c + step)
    stroke(art, [up ? low : high, c], [up ? high : low, to], MAX_LEVEL)
    up = !up
  }
  return inBand(art, 0)
}

/**
 * The cap emblem: Waluigi's upside-down L, one per lens.
 *
 * A gamma rather than a triangle. *The board row for this track guessed "inverted
 * triangle" and that is Wario's; the correction is kept rather than quietly fixed,
 * because a wrong emblem on a costume is exactly the kind of thing nobody checks.*
 */
export function capBadge(): Bitmap {
  const h = BAND_ROWS
  const w = 5
  const art = Array.from({ length: h }, () => new Array(w).fill(0))
  stroke(art, [h - 1, 0], [h - 1, w - 1], MAX_LEVEL)
  stroke(art, [h - 1, w - 1], [0, w - 1], MAX_LEVEL)
  return perLens(art)
}

/**
 * A wide loop of W's for the device to scroll, since stock cannot page frames.
 *
 * `MODE 02` translates a saved buffer, so the only animation available for our own
 * content is something wide moving past the window. A row of W's at lens width does
 * that and stays recognisable at every offset, which a picture with a single subject
 * does not.
 *
 * The width is snapped to a whole number of glyph pitches so the loop closes on itself:
 * a partial glyph at the wrap is a visible stutter every pass, on top of the ~24 blank
 * columns the device brackets a scrolling save with (`viewport.marqueeWidth`).
 */
export function wLoop(columns = 240, width = 7, gap = 3): Bitmap {
  const pitch = width + gap
  const count = Math.max(1, Math.round(columns / pitch))
  const total = count * pitch
  const out = blank(total)
  const glyph = wGlyph(width)
  for (let i = 0; i < count; i++) {
    for (let r = 0; r < glyph.length; r++) {
      for (let c = 0; c < width; c++) {
        if (glyph[r][c] > 0) set(out, BAND_LOW + r, i * pitch + c, glyph[r][c])
      }
    }
  }
  return out
}

export interface Motif {
  name: string
  label: string
  /** Panel-width and free to show, or wide and needing the saved route. */
  wide: boolean
  make: () => Bitmap
}

/**
 * Every motif, for a screen that lists them.
 *
 * Walked by the tests in both directions, the same rule `effects.ts` lives by: a motif
 * added without an entry here would exist and be unreachable, and an entry naming a
 * motif that does not render would be a tile that throws when tapped.
 */
export const MOTIFS: readonly Motif[] = [
  { name: 'ww', label: 'W W', wide: false, make: ww },
  { name: 'moustache', label: 'Moustache', wide: false, make: moustache },
  { name: 'zigzag', label: 'Zigzag', wide: false, make: zigzag },
  { name: 'badge', label: 'Cap badge', wide: false, make: capBadge },
  { name: 'wloop', label: 'Rolling Ws', wide: true, make: () => wLoop() },
]

export const motifByName = (name: string): Motif | null =>
  MOTIFS.find((m) => m.name === name) ?? null

/** Lit cells a motif would lose to the panel's holes. Zero for everything here. */
export function hidden(bitmap: Bitmap): number {
  let n = 0
  for (let r = 0; r < Math.min(ROWS, bitmap.length); r++) {
    for (let c = 0; c < Math.min(COLS, bitmap[r].length); c++) {
      if (bitmap[r][c] > 0 && !alive(r, c)) n++
    }
  }
  return n
}
