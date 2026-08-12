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
import { TYPE1_BRACKET } from './dats.js'
import { COLS, Grid, ROWS, alive } from './display.js'

/** The window is the panel: 24 columns, all 9 rows. */
export const WIDTH = COLS

export interface WindowOptions {
  /**
   * Wrap round the end of the content rather than running off into blank.
   *
   * True is right for a marquee and false for a static screen.
   *
   * *Corrected 2026-08-10: this said that the device wrapping at all was
   * unverified. It wraps. A solid 32-column type 1 block scrolled with no dark
   * pass at all, watched on hardware in the session that saved it (*verified*,
   * one run). What is open is the width it wraps at once the device has been
   * power-cycled, which is `marqueeAt` below, not this flag.*
   *
   * That one run is also the single observation `research/loop-gap-2026-08-10.md`
   * cannot reconcile with the 27-column measurement of 2026-08-11, which met a full
   * screen width of blank. It stays recorded because it is the contrary evidence and
   * the whole reason the width is still an open question, not because the two have
   * been squared.
   *
   * **Wrapping itself does not rest on that run**, which matters if look 2 overturns
   * it: the 2026-08-11 word came back round too, and so did both directions of the
   * loop in `research/vendor-app-protocol.md`. What is disputed is the width of the
   * blank between repeats, never whether there is a next repeat.
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
 * Whether a walk is of the bitmap or of the panel, which are not the same thing.
 * Track 16; the evidence is `research/loop-gap-2026-08-10.md`.
 *
 * `uploaded` walks exactly the columns that were uploaded, and is right for anything
 * reasoning about the buffer: `effects.ts`'s loop lengths, byte budgets, seam
 * checks.
 *
 * `panel` adds `dats.TYPE1_BRACKET` blank columns after the content, because **that
 * is what a viewer sees.** A save of 27 columns carrying no client gap at all showed
 * about a screen's width of dark between repeats, the word leaving the panel
 * completely before the next arrived (Jacob, by eye, 2026-08-11, against a save
 * whose 27 columns and single blank column are *verified* off the decoded wire log).
 * The record layout explains the magnitude: `DATCP` stores `ncols = N + 48` with the
 * content at store column 24, so a scroll resuming where the content starts walks
 * `N + 24` and meets only the trailing blanks (*derived*, `abs 0x1833e`).
 *
 * **The one contrary observation, unexplained**: a solid 32-column block looped with
 * no dark pass at all in the session that saved it (2026-08-10, *verified*). Either
 * the device's 24 arrives only once it has restored the save from flash, or that
 * reading was wrong. Both are live, the research file names the experiment that
 * separates them, and neither changes which walk a **preview** should use, because a
 * worn pair spends its life on the restored side.
 *
 * So `frames` defaults to `uploaded` - the neutral, bitmap-truthful meaning - and it
 * is `app/src/Preview.tsx` that asks for `panel`.
 */
export type LoopModel = 'uploaded' | 'panel'

/** Columns the panel walks for `cols` uploaded: the device's trailing blanks too. */
export const marqueeWidth = (cols: number): number => Math.max(cols, 0) + TYPE1_BRACKET

/**
 * One panel-sized frame of the loop **as the panel shows it**, at `offset`.
 *
 * Offsets are content columns, because the blank columns the device contributes come
 * after the content: the virtual strip is `[content][TYPE1_BRACKET blank]` and it
 * wraps at `marqueeWidth`. The 24 blank columns the record also holds *before* the
 * content are not modelled, and a preview that opened with a screen of dark would read
 * as broken.
 *
 * **One bracket, not the trailing one.** Under `dir` 0 the pass meets the trailing
 * blanks and never reaches the lead-in; under `dir` 1 it meets the lead-in first, which
 * is what Jacob saw as dead space "at the beginning of the animation"
 * (`research/vendor-app-protocol.md`, "Both scroll directions gap", 2026-08-11,
 * *verified* by eye). The two brackets are 24 blank columns each and a panel cannot
 * tell them apart, so modelling one after the content is right either way: direction
 * selects **which** bracket a pass walks, not **how many**. What it does change is
 * where in the pass the dark falls, and `marqueeOffsets` gets that right for free.
 *
 * Same mask discipline as `windowAt`: `alive()` at the window, in panel coordinates,
 * never on the content.
 */
export function marqueeAt(bitmap: Bitmap, offset = 0): Bitmap {
  const cols = width(bitmap)
  const out = blank(WIDTH)
  if (cols === 0) return out

  const total = marqueeWidth(cols)
  for (let c = 0; c < WIDTH; c++) {
    const from = (((offset + c) % total) + total) % total
    if (from >= cols) continue
    for (let r = 0; r < Math.min(bitmap.length, ROWS); r++) {
      if (alive(r, c)) out[r][c] = bitmap[r][from]
    }
  }
  return out
}

/**
 * Offsets the panel's loop passes through, in display order, starting on the
 * content. `dir` reverses the walk exactly as `scrollOffsets` does.
 *
 * That reversal puts the one dark frame at step `cols` of `cols + 24` under `dir` 0 and
 * at step 24 under `dir` 1, so a wide loop shows its dead space at the end of a pass
 * one way and near the start the other. That is not a design choice here, it is the
 * observation: `research/vendor-app-protocol.md` records both directions gapping and
 * one showing it first, which is also why the app defaults to `dir` 0. `dir`'s physical
 * meaning is still *unverified* (`scrollOffsets` above); what is observed is that the
 * two directions differ in **when**, not in **how much**.
 */
export function marqueeOffsets(cols: number, dir: 0 | 1 = 0): number[] {
  return scrollOffsets(marqueeWidth(cols), dir)
}

export interface FrameOptions {
  /** `uploaded` (default) or `panel`. They differ by 24 columns; see `LoopModel`. */
  loop?: LoopModel
}

/**
 * Every frame the panel will show, in order: one for static content, one per
 * looped column for a scroll.
 *
 * This is the phone's preview loop and it is deliberately not the device's
 * timing. `SPEED` buckets to between 3.8 and 12.5 columns per second at the
 * device end; the preview picks its own interval and only the sequence has to
 * match.
 *
 * A scroll is `width(bitmap)` frames under `uploaded` and `marqueeWidth` of it under
 * `panel`. Static content is one frame either way: what a `MODE 01` display shows
 * out of the record is its own open question, and the panel is showing a static
 * word clipped at 24 columns right now with nobody having sent `MODE 01` at all.
 */
export function frames(
  bitmap: Bitmap,
  motion: { kind: string; dir?: 0 | 1 },
  opts: FrameOptions = {},
): Bitmap[] {
  if (motion.kind !== 'scroll') return [windowAt(bitmap)]
  const cols = width(bitmap)
  const dir = motion.dir ?? 0
  return opts.loop === 'panel'
    ? marqueeOffsets(cols, dir).map((off) => marqueeAt(bitmap, off))
    : scrollOffsets(cols, dir).map((off) => windowAt(bitmap, off, { wrap: true }))
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
