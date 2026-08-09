/**
 * The preview clock, against a display the test drives by hand.
 *
 * Reported twice, and the second report is why these exist. "The preview speeds up
 * and slows down" was a counted `setInterval` surging after a stall; "still not very
 * smooth, slight delays" was what was left once the rate was right - steps landing
 * alternately five and six frames apart, because 90ms is 5.4 frames at 60Hz. Both
 * are questions about *when* a step lands relative to the display, and neither is
 * observable without either a fake clock or a person watching a phone.
 */
import { expect, test } from 'bun:test'
import { stepClock } from './clock.js'

const INTERVAL = 90
const HZ60 = 1000 / 60
const CALIBRATION = 8

/** A display the test advances one frame at a time. */
function rig(intervalMs = INTERVAL) {
  let at = 0
  let pending: (() => void) | null = null
  const steps: number[] = []
  /** The frame number each step was reported on, so spacing is inspectable. */
  const landedOn: number[] = []
  let frames = 0

  const stop = stepClock({
    intervalMs,
    onStep: (step) => {
      steps.push(step)
      landedOn.push(frames)
    },
    now: () => at,
    frame: (fn) => {
      pending = fn
      return () => {
        pending = null
      }
    },
  })

  /** Draw one frame `ms` after the last. */
  const draw = (ms = HZ60) => {
    at += ms
    frames++
    const due = pending
    pending = null
    due?.()
  }

  const gaps = () => landedOn.slice(1).map((f, i) => f - landedOn[i])

  return { steps, landedOn, gaps, draw, stop, armed: () => pending !== null }
}

test('steps land an identical number of frames apart, with no beat', () => {
  const r = rig()
  for (let i = 0; i < 60; i++) r.draw()

  expect(r.steps.length).toBeGreaterThan(5)
  // The whole complaint: 90ms is 5.4 frames at 60Hz, so a millisecond clock
  // alternates 5 and 6. One distinct gap means the motion is metronomic.
  expect([...new Set(r.gaps())]).toEqual([5])
})

test('the rate is rounded to whole frames of the real refresh', () => {
  const fast = rig()
  for (let i = 0; i < 40; i++) fast.draw(HZ60)
  expect(fast.gaps()[0]).toBe(5) // round(90 / 16.67)

  const smooth = rig()
  for (let i = 0; i < 60; i++) smooth.draw(1000 / 120)
  expect(smooth.gaps()[0]).toBe(11) // round(90 / 8.33)
})

test('steps are reported only from inside a frame, never between them', () => {
  const r = rig()
  for (let i = 0; i < 30; i++) r.draw()

  // Every step carries the frame it landed on, and no two share one.
  expect(r.landedOn).toEqual([...new Set(r.landedOn)])
  expect(r.steps).toEqual(r.steps.map((_, i) => i + 1))
})

test('a frame dropped while calibrating does not make it run fast', () => {
  const r = rig()
  // One 100ms hitch among otherwise clean frames. A mean would read the refresh as
  // ~28ms and step every 3 frames; the shortest gap still says 16.67.
  r.draw(HZ60)
  r.draw(100)
  for (let i = 0; i < 50; i++) r.draw(HZ60)

  expect([...new Set(r.gaps())]).toEqual([5])
})

test('a stall slows the marquee rather than making it catch up', () => {
  const r = rig()
  for (let i = 0; i < CALIBRATION + 12; i++) r.draw()
  const before = r.steps.length

  // The JS thread goes away for half a second. Frame callbacks are missed, not
  // queued, so the next frame is one frame's worth of progress and no more.
  r.draw(500)
  r.draw()

  expect(r.steps.length).toBeLessThanOrEqual(before + 1)
  // Monotonic by one, always: a burst is exactly what must not happen.
  expect(r.steps).toEqual(r.steps.map((_, i) => i + 1))
})

test('an implausibly fast frame source is clamped rather than believed', () => {
  const r = rig()
  // What a zero-delay timeout polyfill would look like. Clamped to a 4ms floor, so
  // 90ms is 23 of them: wrong, but watchable, rather than a blur.
  for (let i = 0; i < 200; i++) r.draw(0.2)

  expect([...new Set(r.gaps())]).toEqual([23])
})

test('nothing steps while the refresh is still being measured', () => {
  const r = rig()
  for (let i = 0; i < CALIBRATION; i++) r.draw()

  expect(r.steps).toEqual([])
})

test('stopping disarms the next frame', () => {
  const r = rig()
  for (let i = 0; i < 20; i++) r.draw()
  const seen = r.steps.length
  r.stop()
  for (let i = 0; i < 50; i++) r.draw()

  expect(r.armed()).toBe(false)
  expect(r.steps).toHaveLength(seen)
})
