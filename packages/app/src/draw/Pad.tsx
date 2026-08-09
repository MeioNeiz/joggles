/**
 * The 9x24 surface you draw on with a finger.
 *
 * It reports cells and nothing else: no `Canvas`, no sender, no idea that a device
 * exists. That is what keeps the arithmetic in `canvas.ts` where it can be tested,
 * and it is the only defence this screen has, because the sole way to check a React
 * file on this project is a person looking at a phone.
 *
 * Three things here are load-bearing rather than styling:
 *
 *  1. **The pixel grid does not receive touches.** `locationX`/`locationY` are
 *     relative to whichever view the touch landed on, so with 216 touchable
 *     children the coordinates would be per-pixel and the hit test would resolve
 *     every touch to cell 0. `pointerEvents="none"` on the grid makes this view the
 *     only responder, and the coordinates the whole pad's.
 *  2. **The holes are drawn as absent, not as unlit.** Users must not be able to
 *     paint into the void and wonder where the stroke went; `Canvas.paint` refuses
 *     them, and this is the half of that promise the user can see.
 *  3. **Rows outside the full band are drawn dimmer**, because they pass behind the
 *     nose bridge and get chewed. `notes/app-plan.md`, "The draw canvas".
 *
 * Cheapness matters for the same reason it does in `Preview`: a stroke is a touch
 * event per frame, and each one re-renders whatever this does not skip. Rows compare
 * on a 24-character string, so a horizontal stroke updates one row of 24 views and
 * leaves the other eight alone.
 */
import { display } from '@joggles/core'
import { memo, useMemo, useState } from 'react'
import {
  type GestureResponderEvent,
  type LayoutChangeEvent,
  StyleSheet,
  View,
} from 'react-native'
import { type Box, type Cell, cellAt, full } from './canvas.js'

/** Rows top-first, because row 0 is the bottom of the panel. */
const ORDER = Array.from({ length: display.ROWS }, (_, i) => display.ROWS - 1 - i)

/** Fixed geometry, so there is no reason to ask twice. */
const ALIVE = Array.from({ length: display.ROWS }, (_, r) =>
  Array.from({ length: display.COLS }, (_, c) => display.alive(r, c)),
)

const GAP = 2

const styles = StyleSheet.create({
  pad: {
    backgroundColor: '#000',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  row: { flexDirection: 'row' },
  hole: { backgroundColor: 'transparent' },
  /** Unlit, inside the band that has an LED in every column. */
  off: { backgroundColor: '#1e1e1e' },
  /** Unlit, and liable to be chewed by the nose bridge. */
  fringe: { backgroundColor: '#141414' },
  // The same three greens as the compose preview. The panel's own steps are far
  // subtler (*verified*: adjacent bands at different levels were not separable), so
  // these say "there is grey here" rather than rendering it.
  level1: { backgroundColor: '#14532d' },
  level2: { backgroundColor: '#22c55e' },
  level3: { backgroundColor: '#4ade80' },
})

/**
 * Every appearance a pixel can have, built once per size.
 *
 * A `style={[a, b]}` literal is a fresh array on each render, so the prop is unequal
 * every frame and all 216 views take a native update even when nothing about them
 * changed. Building the table means an unchanged pixel diffs to the same reference.
 */
function skins(size: number) {
  const box = { width: size, height: size, margin: GAP / 2, borderRadius: 2 }
  return {
    hole: [box, styles.hole],
    off: [box, styles.off],
    fringe: [box, styles.fringe],
    lit: [
      [box, styles.off],
      [box, styles.level1],
      [box, styles.level2],
      [box, styles.level3],
    ],
  }
}

type Skins = ReturnType<typeof skins>

const skin = (look: Skins, row: number, col: number, level: number) => {
  if (!ALIVE[row][col]) return look.hole
  if (level > 0) return look.lit[level] ?? look.lit[display.MAX_LEVEL]
  return full(row) ? look.off : look.fringe
}

/** One row, redrawn only when its own 24 values change. */
const Row = memo(function Row({
  row,
  levels,
  look,
}: {
  row: number
  levels: string
  look: Skins
}) {
  return (
    <View style={styles.row}>
      {ALIVE[row].map((_, col) => (
        <View key={col} style={skin(look, row, col, Number(levels[col]))} />
      ))}
    </View>
  )
})

const digits = (values: number[] | undefined): string => {
  let out = ''
  for (let c = 0; c < display.COLS; c++) out += values?.[c] ?? 0
  return out
}

export interface PadProps {
  /** `[row][col]` levels, row 0 at the bottom. `Canvas.levels()`. */
  bitmap: number[][]
  /** A touch landed on this cell. Holes included: refusing them is the model's job. */
  onCell: (cell: Cell) => void
  /** The finger left the pad, so the next touch starts a new stroke. */
  onLift: () => void
  disabled?: boolean
}

export const Pad = memo(function Pad({ bitmap, onCell, onLift, disabled }: PadProps) {
  const [box, setBox] = useState<Box | null>(null)

  /**
   * Where the pixels actually are inside the measured view.
   *
   * The hit test has to run against the grid rather than against the view, and the
   * two are not the same rectangle: cells are square, so whichever of the two
   * dimensions is tighter decides the pitch and the other one gets a centred
   * margin. Computing the margin here rather than trusting the layout to have
   * centred it by exactly this much is what keeps a touch on the pixel under it.
   */
  const grid = useMemo(() => {
    const pitch = box
      ? Math.max(1, Math.min(box.width / display.COLS, box.height / display.ROWS))
      : 1
    const width = pitch * display.COLS
    const height = pitch * display.ROWS
    return {
      width,
      height,
      left: box ? (box.width - width) / 2 : 0,
      top: box ? (box.height - height) / 2 : 0,
      // The pixel is the pitch minus its own margins, so each cell occupies exactly
      // one pitch and the row is exactly `width` wide.
      size: Math.max(1, pitch - GAP),
    }
  }, [box])

  const look = useMemo(() => skins(grid.size), [grid.size])

  const measure = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout
    setBox((prev) =>
      prev?.width === width && prev?.height === height ? prev : { width, height },
    )
  }

  const touch = (e: GestureResponderEvent) => {
    if (!box || disabled) return
    const cell = cellAt(
      e.nativeEvent.locationX - grid.left,
      e.nativeEvent.locationY - grid.top,
      grid,
    )
    if (cell) onCell(cell)
  }

  return (
    <View
      style={[styles.pad, { aspectRatio: display.COLS / display.ROWS }]}
      onLayout={measure}
      onStartShouldSetResponder={() => !disabled}
      onMoveShouldSetResponder={() => !disabled}
      onResponderGrant={touch}
      onResponderMove={touch}
      onResponderRelease={onLift}
      onResponderTerminate={onLift}
    >
      <View pointerEvents="none">
        {ORDER.map((row) => (
          <Row key={row} row={row} levels={digits(bitmap[row])} look={look} />
        ))}
      </View>
    </View>
  )
})
