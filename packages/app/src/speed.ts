/**
 * The speeds Compose offers, and how to say one out loud.
 *
 * **The ladder itself lives in `packages/core/src/protocol.ts`**, beside
 * `protocol.speed()` which builds the frame: what `SPEED n` does to the panel is a
 * fact about the firmware, so the CLI and the phone must read it from one place. The
 * disassembly and the correction it makes to `research/firmware-internals.md` live
 * with it. What is left here is a UI choice, which is why it stays in the app.
 *
 * ## Ten rungs, not three, and the top one is the top
 *
 * This screen used to offer Slow, Medium and Fast. Its reasoning was that `Medium`
 * should be the geometric middle of the range rather than the arithmetic one, because
 * speed reads as a ratio: `SPEED 50` gave 1.00x, 1.44x, 3.25x, so Medium sat next to
 * Slow with nothing in the middle, and 65 fixed it at 1.00x, 1.86x, 3.25x. **That
 * reasoning was right and is now moot**, kept here because it is the kind of thing
 * a later session re-derives: with every bucket offered there is no middle to choose.
 *
 * The firmware has ten distinct scroll rates and three chips reached three of them.
 * `PRESETS` is now all ten, one per divisor, so nothing the panel can do is
 * unreachable from the phone.
 *
 * **What more chips cannot buy is a faster panel.** The top rung is the firmware's
 * own ceiling - 12.5 columns per second, `SPEED` 91 and up, all identical - so the
 * screen states the rate and says when it is at the top, rather than leaving someone
 * to hunt for a setting that is not there. `protocol.ts` has the disassembly and the
 * one firmware lever that would move it.
 */
import { protocol as p } from '@joggles/core'

/** Re-exported so a screen needs one import for "how fast, and what to call it". */
export const divisor = p.speedDivisor
export const msPerColumn = p.msPerColumn
export const columnsPerSecond = p.columnsPerSecond

/** Every speed the device has, slowest first, numbered for a chip row. */
export const PRESETS = p.SPEED_STEPS.map((value, i) => ({
  label: String(i + 1),
  value,
}))

/** The fastest argument worth sending. Nothing above it reaches the panel. */
export const FASTEST = PRESETS[PRESETS.length - 1].value

/**
 * Whether two arguments are the same speed.
 *
 * Chips cannot be selected by equality. A library item saved before this row had ten
 * rungs holds whatever number was current then - 50 is a real example, and it is not
 * one of the ten - and comparing values would leave every chip unlit with no way to
 * tell which one was in force. Same bucket is the same speed, so that is the test.
 */
export const sameStep = (a: number, b: number): boolean => divisor(a) === divisor(b)

/** Which rung an argument lands on, 1-based. Every divisor has one, so never 0. */
export const stepOf = (v: number): number =>
  p.SPEED_STEPS.findIndex((s) => sameStep(s, v)) + 1

/** True once an argument is in the fastest bucket, where asking for more changes nothing. */
export const atCeiling = (v: number): boolean => divisor(v) === p.SPEED_FASTEST

/**
 * The caption under the row: which rung, how fast that is, and whether it is the top.
 *
 * The rate is the honest unit here. "Fast" is a promise the panel may not keep; "12.5
 * columns a second" is what it does.
 */
export const describe = (v: number): string => {
  const rate = columnsPerSecond(v).toFixed(1)
  const top = atCeiling(v) ? ' · as fast as the panel scrolls' : ''
  return `${stepOf(v)} of ${PRESETS.length} · ${rate} columns a second${top}`
}
