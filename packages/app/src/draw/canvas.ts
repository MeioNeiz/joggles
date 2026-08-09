/**
 * The drawing canvas as arithmetic: where a finger landed, which pixels a stroke
 * covers, and what the panel should therefore show.
 *
 * All of it is out here rather than inside the component for the usual reason -
 * the only way to check a React file on this project is a person looking at a
 * phone - but there is a second reason specific to this screen. **The canvas is
 * the one surface where content coordinates and panel coordinates coincide**, so
 * every off-by-one is a pixel drawn somewhere the user did not touch, and none of
 * them throws. `y` grows downwards on a phone and row 0 is the bottom of the
 * panel, which is the flip most likely to go unnoticed: a canvas that is upside
 * down still looks like a canvas.
 *
 * Two facts from `notes/app-plan.md`, "The draw canvas", that this file encodes:
 *
 *  1. **The holes are unpaintable**, not merely unlit. `display.alive()` maps them,
 *     and a stroke through the nose bridge has to come out the other side rather
 *     than stop or bend.
 *  2. **Only rows 2 to 7 exist in every column** (`FULL_ROWS`). Anything drawn
 *     outside that band is chewed as it passes the bridge, so the UI marks it.
 *
 * Nothing here writes flash, or indeed anything: live drawing is SRAM and UART
 * only, which is why it needs no budget guard and no confirmation.
 */
import { Grid, content, display } from '@joggles/core'

/** A pixel of the panel. `row` 0 is the bottom, `col` 0 the left. */
export interface Cell {
  row: number
  col: number
}

/** The drawn area, in whatever units the touch events report. */
export interface Box {
  width: number
  height: number
}

const COLUMNS = Array.from({ length: display.COLS }, (_, c) => c)

/**
 * Rows with an LED in every column: the only band that survives the nose bridge.
 *
 * Derived from `display.alive` rather than written down, so it cannot disagree
 * with the mask the renderer uses. Today it is rows 2 to 7.
 */
export const FULL_ROWS: readonly number[] = Array.from(
  { length: display.ROWS },
  (_, r) => r,
).filter((r) => COLUMNS.every((c) => display.alive(r, c)))

const inBand = Array.from({ length: display.ROWS }, (_, r) => FULL_ROWS.includes(r))

/** Is this row alive in all 24 columns? For the UI's band marker. */
export const full = (row: number): boolean => inBand[row] ?? false

/**
 * Which pixel a touch at (x, y) is on, or `null` if the touch missed the panel.
 *
 * Holes are **not** rejected here. A drag crossing the nose bridge must carry on
 * to the far side, so being over a dead pixel is a fact about that pixel and not
 * about the touch; `Canvas.paint` is where the hole is refused.
 */
export function cellAt(x: number, y: number, box: Box): Cell | null {
  if (!(box.width > 0) || !(box.height > 0)) return null
  if (x < 0 || y < 0 || x >= box.width || y >= box.height) return null
  const col = Math.min(display.COLS - 1, Math.floor((x / box.width) * display.COLS))
  const down = Math.min(display.ROWS - 1, Math.floor((y / box.height) * display.ROWS))
  // The flip: touch coordinates grow downwards, panel rows grow upwards.
  return { row: display.ROWS - 1 - down, col }
}

/**
 * Every cell from `from` to `to` inclusive.
 *
 * Touch move events are sampled per frame, so a fast drag reports cells several
 * apart and painting only what was reported leaves a dotted line. Bresenham
 * between consecutive samples is what makes a stroke a stroke.
 */
export function line(from: Cell, to: Cell): Cell[] {
  const out: Cell[] = []
  const dr = Math.abs(to.row - from.row)
  const dc = Math.abs(to.col - from.col)
  const stepR = from.row < to.row ? 1 : -1
  const stepC = from.col < to.col ? 1 : -1
  let { row, col } = from
  let err = dc - dr
  for (;;) {
    out.push({ row, col })
    if (row === to.row && col === to.col) break
    const e2 = 2 * err
    if (e2 > -dr) {
      err -= dr
      col += stepC
    }
    if (e2 < dc) {
      err += dc
      row += stepR
    }
  }
  return out
}

/**
 * What the user has drawn, and the stroke they are part way through.
 *
 * It holds a `Grid` rather than a `Bitmap` because that is what `LiveSender.set`
 * wants and what `display` already knows how to pack. The screen owns one of
 * these and hands `snapshot()` to the sender after every change.
 *
 * Every mutator answers whether anything actually changed, so a drag that stays
 * inside one pixel - which is most of a slow stroke - costs no re-render and no
 * write. The sender would coalesce the writes anyway; the re-render is 216 views.
 */
export class Canvas {
  private grid = new Grid()

  /** Where the stroke in progress has got to, or `null` between strokes. */
  private from: Cell | null = null

  /** Nothing lit. The clear button reads this to know whether it would do anything. */
  get empty(): boolean {
    return COLUMNS.every((c) => this.grid.columnWord(c) === 0)
  }

  /** `[row][col]` levels for the on-screen pad. Row 0 is the bottom, as ever. */
  levels(): content.Bitmap {
    return content.fromGrid(this.grid)
  }

  /** A copy, so the caller cannot draw into what the sender is diffing against. */
  snapshot(): Grid {
    return this.grid.clone()
  }

  /**
   * Paint one pixel. Level 0 erases; a hole is silently refused.
   *
   * Refusing rather than storing is what keeps the phone honest: a pixel the
   * panel cannot show must not appear on the preview either, or the user paints
   * into the void and wonders where their stroke went.
   */
  paint(cell: Cell, level: number): boolean {
    if (!display.alive(cell.row, cell.col)) return false
    const want = Math.max(0, Math.min(display.MAX_LEVEL, Math.round(level)))
    if (this.grid.get(cell.row, cell.col) === want) return false
    this.grid.set(cell.row, cell.col, want)
    return true
  }

  /**
   * Continue the current stroke to `cell`, filling in what the sampler skipped.
   *
   * The first `drag` after a `lift` starts a new stroke, so lifting a finger and
   * putting it down elsewhere does not draw a line across the panel between the
   * two - which is the bug this method exists to not have.
   */
  drag(cell: Cell, level: number): boolean {
    const path = this.from ? line(this.from, cell) : [cell]
    this.from = cell
    let changed = false
    for (const step of path) changed = this.paint(step, level) || changed
    return changed
  }

  /** End the stroke. Call it on touch release, and on cancel. */
  lift(): this {
    this.from = null
    return this
  }

  clear(): boolean {
    this.lift()
    if (this.empty) return false
    this.grid.clear()
    return true
  }
}
