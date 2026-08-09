/**
 * The 24-column window the panel actually is, slid over content that is wider.
 *
 * **The mask goes on the window, never on the content.** `display.alive()` maps
 * physical holes at fixed panel positions: the middle six of the top row, and the
 * nose-bridge notch at rows 0 and 1. Applying it to a 740-column bitmap masks in
 * *content* coordinates and draws a hole that travels along with the glyph, which
 * is the exact opposite of what the hardware does - the content moves and the
 * holes stay put. `notes/app-plan.md` safety item 4 records that trap; this file
 * is the reason no screen has to remember it.
 *
 * A preview built on this is a preview of the panel. A preview built on a masked
 * wide bitmap is a preview of nothing.
 */
import { type Bitmap, blank, width } from './content.js'
import { COLS, Grid, ROWS, alive } from './display.js'

/** The window is the panel: 24 columns, all 9 rows. */
export const WIDTH = COLS

export interface WindowOptions {
  /**
   * Wrap round the end of the content rather than running off into blank.
   *
   * True is right for a marquee and false for a static screen. That the device
   * wraps at all is *unverified*; `MODE 02` scrolls, and what it does at the end
   * of the buffer has not been watched. If it turns out to gap, this default is
   * the only thing that changes.
   */
  wrap?: boolean
}

/**
 * One panel-sized frame of `bitmap`, starting at content column `offset`, with
 * the dead LEDs blanked.
 *
 * Content shorter than a screen is left-aligned and the rest stays dark, which is
 * what padding to 24 columns in `content.text` is hedging against.
 */
export function windowAt(
  bitmap: Bitmap,
  offset = 0,
  opts: WindowOptions = {},
): Bitmap {
  const { wrap = false } = opts
  const cols = width(bitmap)
  const out = blank(WIDTH)
  if (cols === 0) return out

  for (let c = 0; c < WIDTH; c++) {
    const src = offset + c
    const from = wrap ? ((src % cols) + cols) % cols : src
    if (from < 0 || from >= cols) continue
    for (let r = 0; r < Math.min(bitmap.length, ROWS); r++) {
      if (alive(r, c)) out[r][c] = bitmap[r][from]
    }
  }
  return out
}

/** The same window as a `Grid`, for `Grid.render()` and the live sender. */
export function gridAt(bitmap: Bitmap, offset = 0, opts: WindowOptions = {}): Grid {
  const win = windowAt(bitmap, offset, opts)
  const g = new Grid()
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < WIDTH; c++) g.set(r, c, win[r][c])
  }
  return g
}

/**
 * Content-column offsets a scroll passes through, in display order.
 *
 * `dir` is the byte `MODE 02` carries, and the firmware tests it only for zero
 * versus non-zero. Which way each value actually moves the content is
 * *unverified* - the vendor app's table calls 0 left - so the mapping lives here
 * alone, and one hardware run settles it without anything above this file moving.
 */
export function scrollOffsets(cols: number, dir: 0 | 1 = 0): number[] {
  const steps = Math.max(cols, 1)
  const forward = Array.from({ length: steps }, (_, i) => i)
  return dir === 0 ? forward : forward.map((i) => (steps - i) % steps)
}

/**
 * Every frame the panel will show, in order: one for static content, one per
 * content column for a scroll.
 *
 * This is the phone's preview loop and it is deliberately not the device's
 * timing. `SPEED` buckets to between 3.8 and 12.5 columns per second at the
 * device end; the preview picks its own interval and only the sequence has to
 * match.
 */
export function frames(bitmap: Bitmap, motion: { kind: string; dir?: 0 | 1 }): Bitmap[] {
  if (motion.kind !== 'scroll') return [windowAt(bitmap)]
  const cols = width(bitmap)
  return scrollOffsets(cols, motion.dir ?? 0).map((off) =>
    windowAt(bitmap, off, { wrap: true }),
  )
}

/**
 * Lit pixels the window swallows at this offset, because they land on a hole.
 *
 * For a static screen this is the number to put in front of the user before they
 * save: they drew something the panel cannot show. For a scroll it is per frame
 * and mostly noise, since a pixel hidden at one offset appears at the next.
 */
export function hidden(bitmap: Bitmap, offset = 0, opts: WindowOptions = {}): number {
  const { wrap = false } = opts
  const cols = width(bitmap)
  if (cols === 0) return 0
  let n = 0
  for (let c = 0; c < WIDTH; c++) {
    const src = offset + c
    const from = wrap ? ((src % cols) + cols) % cols : src
    if (from < 0 || from >= cols) continue
    for (let r = 0; r < Math.min(bitmap.length, ROWS); r++) {
      if (!alive(r, c) && bitmap[r][from]) n++
    }
  }
  return n
}
