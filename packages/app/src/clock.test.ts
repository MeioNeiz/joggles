/**
 * The preview clock, against a display the test drives by hand.
 *
 * Three reports shaped this file. "The preview speeds up and slows down" was a
 * counted `setInterval` surging after a stall; "still not very smooth" was the
 * millisecond beat; and 2026-08-12's "way slower than the actual speed ... it seems
 * to speed up the less pixels are showing" was the frame-counted clock stretching
 * time under render load, so the rate varied with the content. The current design
 * answers the third at the cost of the second: wall-clock rate, catch-up by jumping,
 * and a step may land a frame early or late. These tests pin that trade the way the
 * old ones pinned the old one.
 */
import { expect, test } from 'bun:test'
import { stepClock } from './clock.js'

const INTERVAL = 90
const HZ60 = 1000 / 60

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

  return { steps, landedOn, draw, stop, armed: () => pending !== null }
}

test('the rate is the wall clock’s, whatever the display does', () => {
  // One second of 60Hz frames and one second of 120Hz frames reach the same column:
  // the rate is elapsed time over the interval, not a count of frames.
  // The first frame sets the baseline, so one second of motion is 61 and 121 draws.
  const sixty = rig()
  for (let i = 0; i < 61; i++) sixty.draw(HZ60)
  const oneTwenty = rig()
  for (let i = 0; i < 121; i++) oneTwenty.draw(1000 / 120)

  expect(sixty.steps.at(-1)).toBe(Math.floor(1000 / INTERVAL))
  expect(oneTwenty.steps.at(-1)).toBe(sixty.steps.at(-1)!)
})

test('slow frames hold the rate by skipping columns, never by stretching time', () => {
  // The 2026-08-12 report: heavy renders made the marquee slower, so the speed read
  // as a property of how much was lit. 50ms frames are a struggling JS thread; a
  // second of them must still reach the same column as a clean second.
  const r = rig()
  for (let i = 0; i < 21; i++) r.draw(50)

  expect(r.steps.at(-1)).toBe(Math.floor(1000 / INTERVAL))
  // Fewer reports than steps is the point: the gaps are skipped columns.
  expect(r.steps.length).toBeLessThanOrEqual(21)
})

test('a stall is repaid with one jump, never a burst', () => {
  const r = rig()
  for (let i = 0; i < 12; i++) r.draw()
  const before = r.steps.length

  // The JS thread goes away for half a second, then draws one frame. Exactly one
  // report arrives, already at the right column.
  r.draw(500)

  expect(r.steps.length).toBe(before + 1)
  const elapsed = 13 * HZ60 + 500 - HZ60
  expect(r.steps.at(-1)).toBe(Math.floor(elapsed / INTERVAL))
})

test('steps are reported only from inside a frame, at most one per frame', () => {
  const r = rig()
  for (let i = 0; i < 30; i++) r.draw()

  expect(r.landedOn).toEqual([...new Set(r.landedOn)])
})

test('step values only ever increase', () => {
  const r = rig()
  for (let i = 0; i < 40; i++) r.draw(i % 3 === 0 ? 40 : HZ60)

  const sorted = [...r.steps].sort((a, b) => a - b)
  expect(r.steps).toEqual(sorted)
  expect(new Set(r.steps).size).toBe(r.steps.length)
})

test('the first frame sets the baseline without stepping', () => {
  const r = rig()
  r.draw()
  expect(r.steps).toEqual([])
})

test('a zero interval is floored rather than dividing time into infinity', () => {
  const r = rig(0)
  for (let i = 0; i < 5; i++) r.draw()
  expect(r.steps.length).toBeLessThanOrEqual(5)
  expect(Number.isFinite(r.steps.at(-1) ?? 0)).toBe(true)
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
