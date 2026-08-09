/**
 * A step counter for animating a preview, quantised to the display's own frames.
 *
 * Two bugs live here, and the second only becomes visible once the first is fixed.
 *
 * **Counting steps surges.** `setInterval(() => setStep(s => s + 1))` counts, and
 * React Native's timers do not skip: when the JS thread stalls, every callback that
 * came due fires together on the next free tick. The preview lurches forward several
 * columns and hesitates. Counting turns a stall into a debt repaid in a burst.
 *
 * **Timing in milliseconds beats against the refresh rate.** A 90ms step on a 60Hz
 * display is 5.4 frames, so steps land alternately 5 and 6 frames apart: 83ms, then
 * 100ms, forever. Every step is individually on time and the motion still reads as
 * uneven, because the eye is comparing it against the frames it is drawn in. A step
 * that costs more than one frame to render widens the same gap.
 *
 * So this counts **frames**, not milliseconds, after measuring how long a frame
 * actually is. Every column move is then exactly the same number of frames after the
 * last one. The rate is quantised to the refresh as a result - 90ms becomes 5 frames
 * and 83ms at 60Hz - which costs nothing, because the preview's rate was never the
 * device's anyway (`SPEED` buckets the glasses to 3.8-12.5 columns per second, and
 * `viewport.frames` says only the sequence has to match).
 *
 * It also degrades the right way. A stalled JS thread means frame callbacks are
 * missed rather than queued, so the marquee slows down instead of catching up.
 *
 * `frame` and `now` are injectable so all of the above is a test rather than
 * something only a person watching a phone can judge. See `clock.test.ts`.
 */

export interface ClockOptions {
  /** Target milliseconds per step. Rounded to a whole number of display frames. */
  intervalMs: number
  /** Called with the step reached. Always from inside a frame callback. */
  onStep: (step: number) => void
  /** Ask for a callback on the next display frame; returns its canceller. */
  frame?: (fn: () => void) => () => void
  now?: () => number
}

/** Frames sampled before committing to a rate. About 130ms at 60Hz. */
const CALIBRATION = 8

/** Sanity rails on the measured rate, in frames per step. */
const MIN_EVERY = 1
const MAX_EVERY = 30

/**
 * Rails on the measured frame period, in ms: faster than any display, and slower
 * than one worth quantising to. They exist because everything here rests on `frame`
 * being the display's own callback. If it were ever backed by a zero-delay timeout
 * the measurement would read microseconds and the marquee would bolt; clamping
 * bounds that to wrong-but-watchable instead.
 */
const MIN_PERIOD = 4
const MAX_PERIOD = 40

const realFrame = (fn: () => void) => {
  const id = requestAnimationFrame(fn)
  return () => cancelAnimationFrame(id)
}

export function stepClock(opts: ClockOptions): () => void {
  const { intervalMs, onStep, frame = realFrame, now = Date.now } = opts
  let cancel = () => {}
  let stopped = false

  let last = 0
  /**
   * Shortest gap seen between frames, which is the best estimate of the refresh
   * period. The mean would be dragged out by any frame we happened to drop while
   * measuring, and a period read too long makes the marquee run too fast.
   */
  let shortest = Number.POSITIVE_INFINITY
  let sampled = 0
  let every = 0
  let since = 0
  let step = 0

  const tick = () => {
    if (stopped) return
    const at = now()
    if (last !== 0) {
      if (every === 0) {
        shortest = Math.min(shortest, at - last)
        if (++sampled >= CALIBRATION) {
          const period = Math.max(MIN_PERIOD, Math.min(MAX_PERIOD, shortest))
          const frames = Math.round(intervalMs / period)
          every = Math.max(MIN_EVERY, Math.min(MAX_EVERY, frames))
        }
      } else if (++since >= every) {
        since = 0
        onStep(++step)
      }
    }
    last = at
    cancel = frame(tick)
  }

  cancel = frame(tick)
  return () => {
    stopped = true
    cancel()
  }
}
