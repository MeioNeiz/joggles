/**
 * What the panel will show, and the marquee that walks it.
 *
 * Two components: `Panel` draws one frame and knows nothing about time; `Preview`
 * owns the clock and the offset. The mask is applied **at the window** through
 * `viewport` - the dead LEDs sit at fixed panel positions and content scrolls
 * THROUGH them, so masking the content would draw a hole that travels with the
 * glyph (safety item 4 in `notes/app-plan.md`).
 *
 * **Every frame is computed once, when the bitmap changes, not per step.** The
 * 2026-08-12 handset session found the marquee "way slower than the actual speed"
 * and speeding up "the less pixels are showing": per-step work made the render cost
 * vary with the content, and the old frame-counting clock stretched time to match.
 * The clock now holds wall-time (`clock.ts`), and this file's half of the fix is to
 * shrink the per-step work to a lookup: all offsets are pre-rendered into row
 * strings, a step indexes into them, and each `Row` bails out unless its own 24
 * digits changed. A 736-column loop is ~7k cells per offset walked once at plan
 * time, milliseconds, against the same work previously done eleven times a second.
 *
 * Which loop the marquee walks is `LOOP`: the device brackets a scrolling type 1
 * save with ~24 blank columns, so the panel's loop is a screen longer than the
 * bitmap, and previewing the bitmap alone is the mismatch that opened track 16.
 */
import { display, viewport } from '@joggles/core'
import { memo, useEffect, useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { stepClock } from './clock.js'

/** Rows top-first, because row 0 is the bottom of the panel. */
const ORDER = Array.from({ length: display.ROWS }, (_, i) => display.ROWS - 1 - i)

/** See the loop-gap research; `uploaded` walks the bitmap alone. */
const LOOP = 'panel' as viewport.LoopModel

/** The physical holes. Fixed geometry, so there is no reason to ask twice. */
const ALIVE = Array.from({ length: display.ROWS }, (_, r) =>
  Array.from({ length: display.COLS }, (_, c) => display.alive(r, c)),
)

const styles = StyleSheet.create({
  panel: { backgroundColor: '#000', padding: 8, borderRadius: 6, alignSelf: 'center' },
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
 * Every appearance a pixel can have, built once: a fresh `[a, b]` style array per
 * render makes all 216 views take a native update even when nothing changed.
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
 * One row, redrawn only when its own values change: `levels` is 24 digits, so
 * React's shallow compare settles it in one string comparison.
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

/** A frame as 9 row strings, top-first, ready for `Row`'s one-comparison bail-out. */
function strings(frame: number[][]): string[] {
  return ORDER.map((row) => {
    let out = ''
    for (let c = 0; c < display.COLS; c++) out += frame[row]?.[c] ?? 0
    return out
  })
}

const Strip = memo(function Strip({ rows }: { rows: string[] }) {
  return (
    <View style={styles.panel}>
      {rows.map((levels, i) => (
        <Row key={ORDER[i]} row={ORDER[i]} levels={levels} />
      ))}
    </View>
  )
})

/** One frame at panel coordinates. No time, no state. */
export const Panel = memo(function Panel({ frame }: { frame: number[][] }) {
  return <Strip rows={strings(frame)} />
})

/**
 * The panel, walking the content the way `MODE 02` will, at the device's own rate.
 *
 * `bitmap` has to be referentially stable across renders or the pre-render and the
 * clock restart on every one of them - memoise it in the caller. A static frame
 * runs no timer at all.
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

  /**
   * Every offset's frame, rendered once. The per-step cost is indexing this.
   *
   * **Through `viewport.frames`, not around it** (track 36). This walk used to be
   * written out here, which left the model in `viewport.ts` with no production caller
   * at all: the one switch that decides whether a preview shows the device's ~24 blank
   * columns existed in two places, and a preview quietly disagreeing with the panel is
   * the exact bug this whole area was built to fix.
   *
   * The pre-render is unchanged and must stay that way: every offset is rendered once
   * here, so a step is a lookup rather than a render. That is the fix for "it seems to
   * speed up the less pixels are showing on the screen", where render cost stretched a
   * frame-counted clock. The only new cost is that `frames()` materialises its bitmaps
   * before `strings` runs, one extra array of ~760 nine-row frames at the widest loop,
   * once, at plan time.
   */
  const frames = useMemo(() => {
    const motion = scroll ? ({ kind: 'scroll', dir } as const) : ({ kind: 'static' } as const)
    return viewport.frames(bitmap, motion, { loop: LOOP }).map(strings)
  }, [bitmap, scroll, dir])

  useEffect(() => {
    setStep(0)
    if (!scroll) return
    return stepClock({ intervalMs, onStep: setStep })
  }, [scroll, bitmap, intervalMs])

  return <Strip rows={frames[step % frames.length]} />
})
