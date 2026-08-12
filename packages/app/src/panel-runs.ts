/**
 * One panel row as runs of identical appearance, so a grid costs a View per run rather
 * than one per pixel.
 *
 * **Why it exists, measured.** A grid that draws a View per pixel costs 216 of them per
 * panel, and the Show tab draws 40 panels: 9,040 Views, which took **7.4 seconds** from
 * first render to first paint on a Pixel 10 Pro with single stalls of 170 skipped frames
 * (2026-08-12, `[perf]` instrumentation and `Choreographer` in logcat). The JS half of
 * that same load was 37ms, so nothing about the thumbnails was slow: the count of native
 * views was the whole cost. Merging horizontally adjacent pixels that look identical is
 * 2.6x fewer views on the real thumbnails (226 to 86.5 average, worst 133 on `anim-5`,
 * walked over all 30 built-ins and the motifs).
 *
 * **What it gives up.** The hairline margin between two neighbours of the *same* colour.
 * Every gutter between rows stays, and so does every gutter where the colour changes, so
 * the panel still reads as rows of pixels rather than as a bitmap; a solid lit area
 * becomes a row of bars instead of a row of dots.
 *
 * **What each grid keeps.** Its own geometry. `Preview.tsx` draws an 11px pixel and
 * `screens/Library.tsx` a 3px one, so the width of a run is theirs to compute; only the
 * merging and the dead-LED mask are here, which is the half the two must not disagree
 * about. `draw/Pad.tsx` is deliberately not a caller: its pixels are touch targets, and
 * merging them would merge what a finger can hit.
 */
import { display } from '@joggles/core'

/** A dead LED. Not a level, and drawn as a hole rather than as an unlit pixel. */
export const HOLE = -1

export interface Run {
  /** A level 0-3, or `HOLE`. */
  cls: number
  /** How many panel columns this run stands in for. At least 1. */
  cells: number
}

/** The physical holes. Fixed geometry, so there is no reason to ask twice. */
const ALIVE = Array.from({ length: display.ROWS }, (_, r) =>
  Array.from({ length: display.COLS }, (_, c) => display.alive(r, c)),
)

/**
 * The runs of one panel row, left to right.
 *
 * `level(col)` rather than a row of values, so a caller with a bitmap and a caller with
 * a string of digits both pay for nothing they do not already hold.
 */
export function runsOf(row: number, level: (col: number) => number): Run[] {
  const out: Run[] = []
  for (let col = 0; col < display.COLS; col++) {
    const cls = ALIVE[row]?.[col] ? level(col) : HOLE
    const last = out[out.length - 1]
    if (last !== undefined && last.cls === cls) last.cells++
    else out.push({ cls, cells: 1 })
  }
  return out
}

/**
 * The width of a run in a grid whose pixels sit on `pitch` and carry `margin` a side.
 *
 * A run stands in for `cells` pixels, so it spans `cells * pitch` and gives back the
 * margin it carries itself, which is what keeps a merged row exactly as wide as the
 * unmerged one it replaced.
 */
export const runWidth = (cells: number, pitch: number, margin: number): number =>
  cells * pitch - 2 * margin
