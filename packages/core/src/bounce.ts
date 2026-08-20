/**
 * `MODE 03`: the device's vertical bounce, and what it costs the content.
 *
 * This is the third and last thing the panel will do to a saved type 1 record for no
 * flash at all, and it is real: `research/mode-03-2026-08-20.md` decodes the handler on
 * both firmware builds, and the two are byte-identical over 210 bytes bar the final `bl`.
 * It is `MODE 02`'s horizontal scroll with one extra step, and the extra step is the
 * whole of this module: before each frame reaches the panel, all 24 columns are shifted
 * vertically by the same amount, and that amount walks `PHASE_OFFSETS`.
 *
 * **What it is not.** `protocol.mode`'s docblock, `notes/protocol.md` and
 * `research/firmware-internals.md` all call `MODE 03 nn` the bounce's *mirror*. There is
 * no mirror: mode 41 on the donor build carries the same phase table byte for byte and
 * differs only in reversing the horizontal travel, exactly as `MODE 02 nn` does. So `dir`
 * here means what it means in `viewport.scrollOffsets` and nothing more.
 *
 * **The swing clips, and that is the reason to read this before offering it.** +5 rows up
 * and -2 down on a 9-row panel, applied by shifting a 16-bit column word whose row `r`
 * lives at bit `7 + r`, so what leaves the top is dropped and what leaves the bottom
 * lands in bits the panel writer never packs. Nothing wraps and nothing smears; it is
 * simply gone. A 5-row band at rows 2 to 6 loses three of its five rows at the top of
 * the swing and sits in the nose notch at the bottom of it. Only rows 2 and 3 survive
 * every phase, which is `SAFE_ROWS`, so `survives` is false for every font in this repo
 * and `worstClip` is the number to put in front of a person instead of a refusal.
 *
 * **The two clocks are independent.** The phase advances on the same `SPEED` gate as the
 * horizontal step, once per frame, and neither resets the other, so the bounce is one row
 * per column of travel and the loop only closes at `visualPeriod`. `MODE 03` itself
 * resets both to zero, which is why a preview may start at step 0.
 *
 * Everything about the *appearance* is unwitnessed. One look at a real panel is on record
 * ("`MODE 03` produced text bouncing left-to-right unattended", `notes/protocol.md`) with
 * no note of clipping, against content whose row band nobody wrote down.
 */
import { type Bitmap, blank, width } from './content.js'
import { TYPE1_BRACKET } from './dats.js'
import { Grid, ROWS, alive } from './display.js'
import { mode } from './protocol.js'
import { WIDTH } from './viewport.js'

/**
 * Rows the content is lifted by, one entry per frame, cycling.
 *
 * *verified* off the 14-byte jump table at `abs 0x21490` (donor) and `abs 0x20e94` (APK),
 * whose arms are a single shift each: `mov`, `lsl #1` to `lsl #5`, back down, then
 * `lsr #1`, `lsr #2`, `lsr #1`. Positive is up, because row 0 is the bottom.
 */
export const PHASE_OFFSETS: readonly number[] = [
  0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0, -1, -2, -1,
]

/** Frames the vertical cycle takes. Fourteen, and the horizontal period is unrelated. */
export const PHASE_PERIOD = PHASE_OFFSETS.length

/** Rows the swing reaches above the resting position. */
export const RISE = 5

/** Rows it reaches below. The swing is not symmetric. */
export const FALL = 2

/**
 * The only rows a lit pixel can occupy and still be on the panel at every phase,
 * inclusive: a row `r` needs `r - FALL >= 0` and `r + RISE <= ROWS - 1`.
 *
 * Two rows. There is no readable glyph in here, which is a fact about the firmware and
 * not a limit this module is imposing.
 */
export const SAFE_ROWS: readonly [number, number] = [FALL, ROWS - 1 - RISE]

/**
 * The frame that starts it. `dir` is the byte the firmware tests for zero versus
 * non-zero, and it reverses the horizontal travel.
 *
 * Delegates to `protocol.mode` rather than restating the opcode, so the two cannot come
 * to disagree about what kind 3 is.
 */
export const command = (dir: 0 | 1 = 0): Uint8Array => mode(3, dir)

/**
 * Columns `DATCP` records for `cols` uploaded, which is `cols + 48`.
 *
 * Both brackets: the receive path starts writing type 1 at byte 48, leaving 24 blank
 * columns in front of the content, and then `DATCP` adds another 24 to the count it
 * stores. So the record claims 24 more columns than were ever written, and those read
 * out of a zeroed staging buffer. `dats.TYPE1_BRACKET` is one bracket.
 */
export const storeColumns = (cols: number): number =>
  Math.max(cols, 0) + 2 * TYPE1_BRACKET

/** Highest start column the firmware's wrap allows: `storeColumns - 24`. */
const lastStart = (cols: number): number => storeColumns(cols) - WIDTH

/**
 * Frames the travel takes to come round, `cols + 25`.
 *
 * **One more than `viewport.marqueeWidth`, and the extra one is real.** The forward wrap
 * is `if (ncols - 24 < col) col = 0`, so the start column runs `0` to `cols + 24`
 * inclusive before resetting. Read cyclically that is `cols` columns of content and 25 of
 * dark, one panel width plus one.
 */
export const travelPeriod = (cols: number): number => lastStart(cols) + 1

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

/**
 * Frames before the whole display repeats: the two clocks realigning.
 *
 * 560 for a 55-column save, 1974 for a 116-column one. A caller wanting to show the
 * loop and not just a pass has to walk this many, which is why `frames` makes the count
 * explicit rather than pretending one pass is the loop.
 */
export const visualPeriod = (cols: number): number => {
  const travel = travelPeriod(cols)
  return (travel / gcd(travel, PHASE_PERIOD)) * PHASE_PERIOD
}

const wrapped = (n: number, m: number): number => ((n % m) + m) % m

/** Rows the content is lifted by at `step`. */
export const phaseAt = (step: number): number =>
  PHASE_OFFSETS[wrapped(step, PHASE_PERIOD)]

export interface BounceOptions {
  /** The byte `MODE 03` carries. 0 counts the store up, 1 counts it down. */
  dir?: 0 | 1
}

/**
 * Store column the frame at `step` begins on.
 *
 * `MODE 03 00` zeroes the start column, so a forward pass **opens on the blank lead-in**
 * and the content scrolls in from the far side. `MODE 03 nn` starts at `ncols - 24` and
 * counts down to 24 before jumping to `ncols`, so its first pass is `cols + 1` frames
 * shorter than every pass after it. Both are modelled, because a preview of the first
 * pass is what a person sees after a tap.
 */
export function startAt(cols: number, step: number, opts: BounceOptions = {}): number {
  const n = Math.max(0, Math.trunc(step))
  const last = lastStart(cols)
  if ((opts.dir ?? 0) === 0) return wrapped(n, travelPeriod(cols))

  const lead = Math.max(cols, 0) + 1
  if (n < lead) return last - n
  return storeColumns(cols) - wrapped(n - lead, travelPeriod(cols))
}

/**
 * The 24 store columns one frame reads, in window order.
 *
 * Walked the way the firmware walks it, one increment and one compare per column, rather
 * than by a modulus: the forward wrap resets to 0 at `ncols - 24` and the reverse one to
 * 23 at `ncols`, which are different limits and different resets, and a modulus over the
 * wrong span is exactly the off-by-one this file exists to stop repeating.
 */
export function storeWindow(
  cols: number,
  start: number,
  opts: BounceOptions = {},
): number[] {
  const reverse = (opts.dir ?? 0) !== 0
  const limit = reverse ? storeColumns(cols) : lastStart(cols)
  const reset = reverse ? TYPE1_BRACKET - 1 : 0
  const out: number[] = []
  let i = start
  for (let c = 0; c < WIDTH; c++) {
    out.push(i)
    i += 1
    if (i > limit) i = reset
  }
  return out
}

/** The content column a store column holds, or null where the store is blank. */
const contentColumn = (cols: number, store: number): number | null => {
  const c = store - TYPE1_BRACKET
  return c >= 0 && c < cols ? c : null
}

/**
 * One panel-sized frame of the bounce at `step`, dead LEDs blanked.
 *
 * Shift first, mask second, which is the order the firmware does it in and the reason a
 * pixel lifted into row 8 can still be swallowed by the missing middle six. Same mask
 * discipline as `viewport.windowAt`: `alive()` in panel coordinates, never on the
 * content.
 */
export function frameAt(
  bitmap: Bitmap,
  step: number,
  opts: BounceOptions = {},
): Bitmap {
  const cols = width(bitmap)
  const out = blank(WIDTH)
  if (cols === 0) return out

  const lift = phaseAt(step)
  const rows = Math.min(bitmap.length, ROWS)
  const window = storeWindow(cols, startAt(cols, step, opts), opts)
  for (let c = 0; c < WIDTH; c++) {
    const from = contentColumn(cols, window[c])
    if (from === null) continue
    for (let r = 0; r < ROWS; r++) {
      const src = r - lift
      if (src < 0 || src >= rows) continue
      if (alive(r, c)) out[r][c] = bitmap[src][from]
    }
  }
  return out
}

/** The same frame as a `Grid`, for `Grid.render()` and the live sender. */
export function gridAt(bitmap: Bitmap, step: number, opts: BounceOptions = {}): Grid {
  const f = frameAt(bitmap, step, opts)
  const g = new Grid()
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < WIDTH; c++) g.set(r, c, f[r][c])
  }
  return g
}

export interface FramesOptions extends BounceOptions {
  /**
   * How many frames to build. Defaults to `travelPeriod`, one pass of the travel, which
   * is **not** the loop: the vertical phase is still mid-cycle at the end of it. Pass
   * `visualPeriod(cols)` for the real thing, and expect hundreds or thousands.
   */
  count?: number
}

/** Frames from step 0, which is where `MODE 03` starts: level, and on the lead-in. */
export function frames(bitmap: Bitmap, opts: FramesOptions = {}): Bitmap[] {
  const cols = width(bitmap)
  const count = Math.max(0, Math.trunc(opts.count ?? travelPeriod(cols)))
  return Array.from({ length: count }, (_, i) => frameAt(bitmap, i, opts))
}

/**
 * Lit pixels the swing pushes off the panel at `step`, counted over the whole bitmap.
 *
 * Content-wide rather than per window, because the lift is uniform across the 24 columns:
 * a pixel clipped at this phase is clipped wherever it happens to be horizontally. It
 * does not count pixels lost to a dead LED, which come and go with the column and are
 * `viewport.hidden`'s business.
 */
export function clippedAt(bitmap: Bitmap, step: number): number {
  const lift = phaseAt(step)
  const rows = Math.min(bitmap.length, ROWS)
  let n = 0
  for (let r = 0; r < rows; r++) {
    const to = r + lift
    if (to >= 0 && to < ROWS) continue
    for (const v of bitmap[r]) if (v) n++
  }
  return n
}

/** The worst phase's clip, which is the number worth showing before a save. */
export const worstClip = (bitmap: Bitmap): number =>
  PHASE_OFFSETS.reduce((worst, _, i) => Math.max(worst, clippedAt(bitmap, i)), 0)

/**
 * Does every lit pixel stay on the panel at every phase?
 *
 * True only for content confined to `SAFE_ROWS`, so false for every font here. Reported
 * rather than enforced: `MODE 03` is free and a clipped bounce may still be what somebody
 * wants.
 */
export const survives = (bitmap: Bitmap): boolean => worstClip(bitmap) === 0
