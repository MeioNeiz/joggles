/**
 * What the panel will show, and the marquee that walks it.
 *
 * Two components, and the split is the point. `Panel` draws one frame and knows
 * nothing about time; `Preview` owns the clock and the offset. Keeping the clock
 * down here rather than in the screen means a column step re-renders 216 pixels
 * and nothing else - with it in the screen, every step also re-rendered the text
 * field, four button rows and the save button, eleven times a second.
 *
 * `Panel` takes a frame that is **already** a 24-column window with `alive()`
 * applied, from `viewport.windowAt`. That split is the point too: the mask belongs
 * on the window, never on the content, because the dead LEDs sit at fixed panel
 * positions and a message wider than the panel scrolls THROUGH them. Masking the
 * content instead draws a hole that travels with the glyph, which is the opposite
 * of what the hardware does. See safety item 4 in `notes/app-plan.md`.
 *
 * `alive()` is consulted again here only to draw the holes as absent rather than
 * merely unlit, so nobody types a message and wonders where a stroke went.
 *
 * **216 host views redrawn several times a second, so the cheapness below is
 * load-bearing.** When a frame costs more than the step interval, the preview stops
 * being a preview of anything. Three things keep it cheap and none is optional: the
 * styles are built once rather than per pixel per frame, each row bails out unless
 * its own 24 values changed, and the dead-pixel map is computed once at module load
 * instead of 216 times a frame.
 */
import { content, display, viewport } from '@joggles/core'
import { memo, useEffect, useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { stepClock } from './clock.js'

/** Rows top-first, because row 0 is the bottom of the panel. */
const ORDER = Array.from({ length: display.ROWS }, (_, i) => display.ROWS - 1 - i)

/** The physical holes. Fixed geometry, so there is no reason to ask twice. */
const ALIVE = Array.from({ length: display.ROWS }, (_, r) =>
  Array.from({ length: display.COLS }, (_, c) => display.alive(r, c)),
)

const styles = StyleSheet.create({
  panel: { backgroundColor: '#000', padding: 8, borderRadius: 6, alignSelf: 'flex-start' },
  row: { flexDirection: 'row' },
  pixel: { width: 11, height: 11, margin: 1, borderRadius: 2, backgroundColor: '#1e1e1e' },
  dead: { backgroundColor: 'transparent' },
  // Levels 1 to 3 as three separable greens. The panel's own steps are much subtler
  // than this (*verified*: six-column bands at different levels were not separable
  // side by side), so read these as "there is grey here", not as a rendition of it.
  level1: { backgroundColor: '#14532d' },
  level2: { backgroundColor: '#22c55e' },
  level3: { backgroundColor: '#4ade80' },
})

/**
 * Every appearance a pixel can have, built once.
 *
 * A `style={[a, b]}` literal allocates a fresh array on each render, so the prop is
 * unequal every frame and all 216 views take a native update even when nothing
 * about them changed. Hoisting them means an unchanged pixel diffs to the same
 * reference and is skipped.
 */
const HOLE = [styles.pixel, styles.dead]
const LIT = [
  styles.pixel,
  [styles.pixel, styles.level1],
  [styles.pixel, styles.level2],
  [styles.pixel, styles.level3],
]

const skin = (alive: boolean, level: number) => (alive ? (LIT[level] ?? LIT[0]) : HOLE)

/**
 * One row, redrawn only when its own values change.
 *
 * `levels` is the row as 24 digits rather than an array, so React's shallow compare
 * settles it in one string comparison. It earns its place on ordinary text: the
 * font is five rows in a nine-row panel, so four rows are permanently blank and
 * never re-render at all.
 */
const Row = memo(function Row({ row, levels }: { row: number; levels: string }) {
  return (
    <View style={styles.row}>
      {ALIVE[row].map((alive, col) => (
        <View key={col} style={skin(alive, Number(levels[col]))} />
      ))}
    </View>
  )
})

const digits = (values: number[] | undefined): string => {
  let out = ''
  for (let c = 0; c < display.COLS; c++) out += values?.[c] ?? 0
  return out
}

/** One frame at panel coordinates. No time, no state. */
export const Panel = memo(function Panel({ frame }: { frame: number[][] }) {
  return (
    <View style={styles.panel}>
      {ORDER.map((row) => (
        <Row key={row} row={row} levels={digits(frame[row])} />
      ))}
    </View>
  )
})

/**
 * The panel, walking the content the way `MODE 02` will.
 *
 * `intervalMs` is how long the **device** holds each column, from `speed.ts`, so
 * this is a simulation rather than an impression. The clock rounds it to a whole
 * number of display frames, which is a percent or two of rate error and the price
 * of motion that does not beat against the refresh.
 *
 * `bitmap` has to be referentially stable across renders or the clock restarts on
 * every one of them - memoise it in the caller. A static message runs no timer at
 * all.
 */
export const Preview = memo(function Preview({
  bitmap,
  scroll,
  dir,
  intervalMs,
}: {
  bitmap: number[][]
  scroll: boolean
  dir: 0 | 1
  intervalMs: number
}) {
  const [step, setStep] = useState(0)
  const offsets = useMemo(
    () => viewport.scrollOffsets(content.width(bitmap), dir),
    [bitmap, dir],
  )

  // `dir` is deliberately not a dependency: flipping direction reverses the walk
  // through `offsets` without restarting it, which is what the device does too.
  useEffect(() => {
    setStep(0)
    if (!scroll) return
    return stepClock({ intervalMs, onStep: setStep })
  }, [scroll, bitmap, intervalMs])

  const frame = useMemo(
    () =>
      viewport.windowAt(bitmap, scroll ? offsets[step % offsets.length] : 0, {
        wrap: scroll,
      }),
    [bitmap, offsets, step, scroll],
  )

  return <Panel frame={frame} />
})
