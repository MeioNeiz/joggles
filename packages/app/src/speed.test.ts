/**
 * The `SPEED` ladder, against the two figures the firmware teardown states.
 *
 * These are a transcription check. The ladder was disassembled by hand from
 * `abs 0x183da`, and the one thing that would make the preview a liar rather than a
 * simulation is getting a bucket boundary or the direction wrong.
 *
 * The ladder now lives in `core/src/protocol.ts` and the assertions run through the
 * app's re-export, which is what the screens import: a move that left the presets
 * pointing at a stale copy would pass a test aimed straight at core.
 */
import { protocol as p } from '@joggles/core'
import { expect, test } from 'bun:test'
import { PRESETS, columnsPerSecond, divisor, msPerColumn } from './speed.js'

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

test('the presets reach both extremes and space evenly by ratio', () => {
  const [slow, medium, fast] = PRESETS.map((p) => divisor(p.value))
  expect(slow).toBe(13)
  expect(fast).toBe(4)

  // Speed reads as a ratio, so the two gaps should be similar multiples rather than
  // similar differences. `SPEED 50` gave 1.44x then 2.25x, which is Medium sitting
  // next to Slow with nothing in the middle of the range.
  const [a, b] = [slow / medium, medium / fast]
  expect(Math.max(a, b) / Math.min(a, b)).toBeLessThan(1.15)
})
