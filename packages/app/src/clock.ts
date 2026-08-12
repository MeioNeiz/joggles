/**
 * A step counter for animating a preview, honest about rate above all else.
 *
 * Rewritten 2026-08-12 after the first side-by-side of preview and panel. The old
 * clock counted frames and deliberately slowed when the JS thread stalled ("misses
 * rather than queues"), on the argument that the preview's rate was never the
 * device's anyway. Field use overturned that: the panel scrolls at its own pace
 * whatever the phone is doing, so a preview whose rate depends on render load reads
 * as "way slower than the actual speed" and, worse, as speeding up when fewer pixels
 * are lit - the load varies with the content, so the error looked like a property of
 * the content.
 *
 * So this clock is wall-time based and **catches up by jumping, never by replaying**:
 * each display frame computes the step the elapsed time says we should be on and
 * reports it once. A stall now skips columns and holds the rate, exactly what the
 * glasses would appear to do if you looked away and back. That is the opposite
 * degradation to the old one, chosen on the same evidence hierarchy this repo uses
 * everywhere: a person watched both behaviours, and this is the one that matches the
 * device.
 *
 * What survives from the old design: steps are still reported from inside a display
 * frame callback (so a step lands on a frame boundary, not mid-frame), and `frame`/
 * `now` stay injectable so all of this is a test rather than something only a person
 * watching a phone can judge. What is gone: the calibration pass and the
 * frames-per-step quantisation. Quantising held the step cadence perfectly even at
 * the price of rate error and a slow start; wall time holds the rate at the price of
 * a step occasionally landing a frame early or late. The panel comparison is what
 * decided which price to pay.
 */

export interface ClockOptions {
  /** Milliseconds per step, taken literally. */
  intervalMs: number
  /** Called with the step reached, at most once per display frame. */
  onStep: (step: number) => void
  /** Ask for a callback on the next display frame; returns its canceller. */
  frame?: (fn: () => void) => () => void
  now?: () => number
}

const realFrame = (fn: () => void) => {
  const id = requestAnimationFrame(fn)
  return () => cancelAnimationFrame(id)
}

export function stepClock(opts: ClockOptions): () => void {
  const { intervalMs, onStep, frame = realFrame, now = Date.now } = opts
  // A zero or negative interval would divide the elapsed time into infinity steps on
  // the second frame; one millisecond is already far past any display's refresh.
  const interval = Math.max(1, intervalMs)
  let cancel = () => {}
  let stopped = false
  let start = 0
  let step = 0

  const tick = () => {
    if (stopped) return
    const at = now()
    if (start === 0) {
      start = at
    } else {
      const due = Math.floor((at - start) / interval)
      // One report however far behind: catching up is a jump to the right column,
      // not a burst of renders repaying each missed step individually.
      if (due > step) {
        step = due
        onStep(step)
      }
    }
    cancel = frame(tick)
  }

  cancel = frame(tick)
  return () => {
    stopped = true
    cancel()
  }
}
