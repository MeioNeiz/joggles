/**
 * What `SPEED n` actually does to the scroll rate, so the preview can be a
 * simulation rather than an impression.
 *
 * *verified*, disassembled from the bucketing ladder at `abs 0x183da` in the decoded
 * application image. `SPEED n` compares its argument against 10, 20, 30, ... 90 and
 * writes a frame divisor to RAM `0x2000266e`; the scroll advances one column every
 * `divisor` ticks of the 50 Hz animation clock (`abs 0x18052` holds `0x32`). So a
 * column lasts `divisor * 20ms`, from 260ms at the bottom to 80ms at the top.
 *
 * **This corrects `research/firmware-internals.md`**, which records the ladder as
 * comparing against "50, 60, 70, 80, 90". Those are the five comparisons inside the
 * address range it quotes (`abs 0x18400`-`0x18428`); four more sit just before it at
 * `0x183de`-`0x183fe`, so there are ten buckets rather than six. The 3.8 to 12.5
 * columns per second the same paragraph gives is right, and is these two endpoints.
 *
 * **This belongs in `packages/core/src/protocol.ts`**, next to `protocol.speed()`,
 * so the CLI shares it. It is here because `protocol.ts` is not this track's file
 * while other agents are running; see `notes/parallel-tracks.md`.
 */

/** One tick of the firmware's animation clock, which runs at 50 Hz. */
const TICK_MS = 20

/**
 * `[argument at most, frame divisor]`, in the order the firmware tests them.
 * Anything above the last threshold gets `FASTEST`.
 */
const LADDER: Array<[number, number]> = [
  [10, 13],
  [20, 12],
  [30, 11],
  [40, 10],
  [50, 9],
  [60, 8],
  [70, 7],
  [80, 6],
  [90, 5],
]

const FASTEST = 4

/** Ticks the device holds each column for. 13 at the slowest, 4 at the fastest. */
export const divisor = (speed: number): number =>
  LADDER.find(([atMost]) => speed <= atMost)?.[1] ?? FASTEST

/** Milliseconds the device holds each column: 260 at the slow end, 80 at the fast. */
export const msPerColumn = (speed: number): number => divisor(speed) * TICK_MS

/** The same as a rate, which is the number worth showing a person. */
export const columnsPerSecond = (speed: number): number => 1000 / msPerColumn(speed)

/**
 * The presets the UI offers: both ends of the real ladder, and its middle.
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
