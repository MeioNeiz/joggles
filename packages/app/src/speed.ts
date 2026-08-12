/**
 * The three speeds Compose offers, and nothing else.
 *
 * **The ladder itself has moved to `packages/core/src/protocol.ts`**, beside
 * `protocol.speed()` which builds the frame: what `SPEED n` does to the panel is a
 * fact about the firmware, so the CLI and the phone must read it from one place. The
 * disassembly and the correction it makes to `research/firmware-internals.md` moved
 * with it. What is left here is a UI choice, which is why it stays in the app.
 */
import { protocol as p } from '@joggles/core'

/** Re-exported so a screen needs one import for "how fast, and what to call it". */
export const divisor = p.speedDivisor
export const msPerColumn = p.msPerColumn
export const columnsPerSecond = p.columnsPerSecond

/**
 * Both ends of the real ladder, and its middle.
 *
 * `Slow` and `Fast` are chosen to reach the extreme buckets rather than stopping one
 * short - 5 lands under the first threshold and 95 above the last.
 *
 * **`Medium` is the geometric middle, not the arithmetic one.** Speed is perceived
 * as a ratio, so the middle preset wants `sqrt(13 * 4)`, which is 7.2, and not the
 * 9 that `SPEED 50` gives. At 9 the three presets ran 1.00x, 1.44x, 3.25x, so Medium
 * was barely distinguishable from Slow and nothing sat near the middle of the range;
 * divisor 7 makes them 1.00x, 1.86x, 3.25x. It is also the firmware's own default.
 */
export const PRESETS = [
  { label: 'Slow', value: 5 },
  { label: 'Medium', value: 65 },
  { label: 'Fast', value: 95 },
]
