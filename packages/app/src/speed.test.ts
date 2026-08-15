/**
 * The `SPEED` ladder, against the two figures the firmware teardown states.
 *
 * These are a transcription check. The ladder was disassembled by hand from
 * `abs 0x183da`, and the one thing that would make the preview a liar rather than a
 * simulation is getting a bucket boundary or the direction wrong.
 *
 * The ladder lives in `core/src/protocol.ts` and the assertions run through the app's
 * re-export, which is what the screens import: a move that left the presets pointing
 * at a stale copy would pass a test aimed straight at core.
 */
import { protocol as p } from '@joggles/core'
import { expect, test } from 'bun:test'
import {
  FASTEST,
  PRESETS,
  atCeiling,
  columnsPerSecond,
  describe as describeSpeed,
  divisor,
  msPerColumn,
  sameStep,
  stepOf,
} from './speed.js'

test('the app re-exports core\'s ladder rather than a second copy of it', () => {
  expect(divisor).toBe(p.speedDivisor)
  expect(msPerColumn).toBe(p.msPerColumn)
  expect(columnsPerSecond).toBe(p.columnsPerSecond)
})

test('the endpoints are the 3.8 and 12.5 columns per second the teardown gives', () => {
  expect(columnsPerSecond(0)).toBeCloseTo(3.8, 1)
  expect(columnsPerSecond(100)).toBeCloseTo(12.5, 1)
  expect(msPerColumn(0)).toBe(260)
  expect(msPerColumn(100)).toBe(80)
})

test('higher is faster, everywhere, with no bucket out of order', () => {
  for (let n = 1; n <= 100; n++) {
    expect(divisor(n)).toBeLessThanOrEqual(divisor(n - 1))
  }
  expect(divisor(0)).toBe(13)
  expect(divisor(100)).toBe(4)
})

test('the boundaries are inclusive, as `bhi` makes them', () => {
  // The firmware tests `cmp n, #10` then branches if HIGHER, so 10 keeps the slower
  // bucket and 11 does not. Getting this off by one shifts every preset.
  expect(divisor(10)).toBe(13)
  expect(divisor(11)).toBe(12)
  expect(divisor(90)).toBe(5)
  expect(divisor(91)).toBe(4)
})

test('there are ten buckets, not the six the research note implies', () => {
  const seen = new Set(Array.from({ length: 101 }, (_, n) => divisor(n)))
  expect([...seen].sort((a, b) => b - a)).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4])
})

/**
 * The ceiling, which is the answer to "how fast can it go".
 *
 * Anything above the last threshold falls through to the same divisor, so a bigger
 * argument is not a faster panel. Asserted well past `MAX_SPEED` because the number
 * a person reaches for when they want more is 255, not 100.
 */
test('SPEED saturates: nothing above 90 is faster than anything else above 90', () => {
  expect(p.SPEED_FASTEST_ARG).toBe(91)
  for (const n of [91, 95, 100, 101, 200, 255, 1000]) {
    expect(divisor(n)).toBe(p.SPEED_FASTEST)
    expect(columnsPerSecond(n)).toBeCloseTo(12.5, 1)
  }
})

test('every rung is a distinct speed, and there is one per bucket', () => {
  const divisors = PRESETS.map((s) => divisor(s.value))
  expect(divisors).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4])
  expect(new Set(divisors).size).toBe(PRESETS.length)
})

test('the rungs sit mid-bucket, so an off-by-one threshold cannot move one', () => {
  // Each value is at least 4 away from either boundary of its own bucket, which is
  // the whole reason for choosing midpoints over 10, 20, 30.
  for (const { value } of PRESETS) {
    expect(divisor(value - 4)).toBe(divisor(value))
    expect(divisor(value + 4)).toBe(divisor(value))
  }
})

test('the rungs are labelled 1 to 10 in the order they get faster', () => {
  expect(PRESETS.map((s) => s.label)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
  for (let i = 1; i < PRESETS.length; i++) {
    expect(columnsPerSecond(PRESETS[i].value)).toBeGreaterThan(
      columnsPerSecond(PRESETS[i - 1].value),
    )
  }
})

test('the fastest rung is the firmware ceiling and not one short of it', () => {
  expect(atCeiling(FASTEST)).toBe(true)
  expect(divisor(FASTEST)).toBe(p.SPEED_FASTEST)
  expect(PRESETS.filter((s) => atCeiling(s.value))).toHaveLength(1)
})

/**
 * A stored value need not be one of the ten.
 *
 * `settings.FALLBACK.speed` is 65 and library items predate this row, so the chips
 * are selected by bucket. Equality would leave every chip unlit for a saved 50, with
 * nothing on screen saying which speed was actually in force.
 */
test('a speed that is not a rung still lights the rung it runs at', () => {
  expect(sameStep(50, 45)).toBe(true)
  expect(sameStep(50, 55)).toBe(false)
  expect(stepOf(50)).toBe(5)
  expect(stepOf(65)).toBe(7)
  expect(stepOf(0)).toBe(1)
  expect(stepOf(255)).toBe(PRESETS.length)
  // Every argument in range lands on some rung: the caption can never say "0 of 10".
  for (let n = 0; n <= 100; n++) expect(stepOf(n)).toBeGreaterThan(0)
})

test('the caption gives the rate, and says so at the top of the ladder', () => {
  expect(describeSpeed(5)).toBe('1 of 10 · 3.8 columns a second')
  expect(describeSpeed(65)).toBe('7 of 10 · 7.1 columns a second')
  expect(describeSpeed(FASTEST)).toBe('10 of 10 · 12.5 columns a second · as fast as the panel scrolls')
})
