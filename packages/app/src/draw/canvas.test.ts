/**
 * The canvas arithmetic, which is the whole of what can be tested without a phone.
 *
 * Two properties carry most of the weight. **The vertical flip**, because a canvas
 * drawn upside down still looks like a canvas and only the glasses would say
 * otherwise; and **the holes**, because painting into one is silent at every layer
 * below this - the packing drops it, the panel has no LED there, and the user is
 * left wondering where their stroke went.
 */
import { expect, test } from 'bun:test'
import { display } from '@joggles/core'
import { Canvas, FULL_ROWS, type Cell, cellAt, full, line } from './canvas.js'

/** A pad 10 units per cell, so a coordinate reads as "cell 3, a bit past the middle". */
const BOX = { width: display.COLS * 10, height: display.ROWS * 10 }

const at = (x: number, y: number): Cell | null => cellAt(x, y, BOX)

/** Lit cells of a canvas, as `row,col` strings, so a diff is readable. */
const drawn = (c: Canvas): string[] => {
  const levels = c.levels()
  const out: string[] = []
  for (let r = 0; r < display.ROWS; r++) {
    for (let col = 0; col < display.COLS; col++) {
      if (levels[r][col] > 0) out.push(`${r},${col}`)
    }
  }
  return out
}

test('the top-left of the pad is the top row, which is row 8 and not row 0', () => {
  expect(at(0, 0)).toEqual({ row: display.ROWS - 1, col: 0 })
  expect(at(BOX.width - 1, BOX.height - 1)).toEqual({ row: 0, col: display.COLS - 1 })
})

test('a touch lands in the cell it is over, not the one after it', () => {
  // Cell 3 spans x 30 to 39 inclusive; 40 is cell 4.
  expect(at(30, 0)?.col).toBe(3)
  expect(at(39, 0)?.col).toBe(3)
  expect(at(40, 0)?.col).toBe(4)
})

test('a touch outside the pad, or before it has been measured, is not a cell', () => {
  expect(at(-1, 5)).toBeNull()
  expect(at(5, -1)).toBeNull()
  expect(at(BOX.width, 5)).toBeNull()
  expect(at(5, BOX.height)).toBeNull()
  expect(cellAt(5, 5, { width: 0, height: 0 })).toBeNull()
})

test('a touch over a hole still reports its cell, so a drag can cross the bridge', () => {
  const cell = at(120, 85) // column 12, bottom row: the nose notch
  expect(cell).toEqual({ row: 0, col: 12 })
  expect(display.alive(0, 12)).toBe(false)
})

test('the band alive in every column is rows 2 to 7', () => {
  expect([...FULL_ROWS]).toEqual([2, 3, 4, 5, 6, 7])
  expect(full(4)).toBe(true)
  expect(full(8)).toBe(false)
})

test('a line covers every cell between its ends, with no gaps', () => {
  const path = line({ row: 2, col: 0 }, { row: 7, col: 11 })
  expect(path[0]).toEqual({ row: 2, col: 0 })
  expect(path.at(-1)).toEqual({ row: 7, col: 11 })
  for (let i = 1; i < path.length; i++) {
    const step =
      Math.abs(path[i].row - path[i - 1].row) + Math.abs(path[i].col - path[i - 1].col)
    expect(step).toBeLessThanOrEqual(2)
  }
})

test('a line to where it started is one cell', () => {
  expect(line({ row: 3, col: 3 }, { row: 3, col: 3 })).toEqual([{ row: 3, col: 3 }])
})

test('painting a hole does nothing and says so', () => {
  const c = new Canvas()
  expect(c.paint({ row: 0, col: 12 }, 3)).toBe(false)
  expect(c.paint({ row: 8, col: 12 }, 3)).toBe(false)
  expect(c.empty).toBe(true)
})

test('painting the same pixel twice reports no change the second time', () => {
  const c = new Canvas()
  expect(c.paint({ row: 4, col: 4 }, 2)).toBe(true)
  expect(c.paint({ row: 4, col: 4 }, 2)).toBe(false)
  expect(c.paint({ row: 4, col: 4 }, 3)).toBe(true)
})

test('level 0 erases, and levels above the maximum are clamped rather than refused', () => {
  const c = new Canvas()
  c.paint({ row: 4, col: 4 }, 9)
  expect(c.levels()[4][4]).toBe(display.MAX_LEVEL)
  expect(c.paint({ row: 4, col: 4 }, 0)).toBe(true)
  expect(c.empty).toBe(true)
})

test('a drag paints the cells the sampler skipped between two touch events', () => {
  const c = new Canvas()
  c.drag({ row: 4, col: 0 }, 3)
  c.drag({ row: 4, col: 5 }, 3) // one frame later, five columns along
  expect(drawn(c)).toEqual(['4,0', '4,1', '4,2', '4,3', '4,4', '4,5'])
})

test('a drag across the nose bridge comes out the other side', () => {
  const c = new Canvas()
  c.drag({ row: 1, col: 8 }, 3)
  c.drag({ row: 1, col: 16 }, 3)
  // Row 1's notch is columns 10 to 13; the stroke resumes at 14. The bounds in
  // `display.DEAD` are half-open, which is one place to get this wrong by one.
  expect(drawn(c)).toEqual(['1,8', '1,9', '1,14', '1,15', '1,16'])
})

test('lifting ends the stroke, so the next touch does not draw a line to it', () => {
  const c = new Canvas()
  c.drag({ row: 4, col: 0 }, 3)
  c.lift()
  c.drag({ row: 4, col: 20 }, 3)
  expect(drawn(c)).toEqual(['4,0', '4,20'])
})

test('a drag that stays in one cell reports no change, so nothing re-renders', () => {
  const c = new Canvas()
  expect(c.drag({ row: 4, col: 6 }, 3)).toBe(true)
  expect(c.drag({ row: 4, col: 6 }, 3)).toBe(false)
})

test('clear blanks the panel, and reports whether it had anything to do', () => {
  const c = new Canvas()
  expect(c.clear()).toBe(false)
  c.drag({ row: 5, col: 5 }, 3)
  expect(c.clear()).toBe(true)
  expect(c.empty).toBe(true)
})

test('clear ends the stroke, so the next drag does not repaint what was cleared', () => {
  const c = new Canvas()
  c.drag({ row: 4, col: 0 }, 3)
  c.clear()
  c.drag({ row: 4, col: 4 }, 3)
  expect(drawn(c)).toEqual(['4,4'])
})

test('a snapshot is a copy, so drawing on after taking one does not change it', () => {
  const c = new Canvas()
  c.drag({ row: 4, col: 2 }, 3)
  const taken = c.snapshot()
  c.drag({ row: 4, col: 3 }, 3)
  expect(taken.get(4, 3)).toBe(0)
  expect(taken.get(4, 2)).toBe(display.MAX_LEVEL)
})

test('levels are what the sender would send: the same grid, row 0 at the bottom', () => {
  const c = new Canvas()
  c.paint({ row: 8, col: 0 }, 3) // top-left, which is alive
  const grid = c.snapshot()
  expect(c.levels()[8][0]).toBe(display.MAX_LEVEL)
  expect(grid.columnWord(0)).toBe(grid.get(8, 0) << (display.STRIDE * 8))
})

/** A stored drawing, as the library holds one: 9 rows of 24 levels. */
const stored = (cells: Array<[number, number, number]>): number[][] => {
  const b = Array.from({ length: display.ROWS }, () => Array<number>(display.COLS).fill(0))
  for (const [row, col, level] of cells) b[row][col] = level
  return b
}

test('load replaces the canvas, refuses holes, and says whether anything changed', () => {
  const c = new Canvas()
  c.paint({ row: 3, col: 1 }, 2)
  // Cell (0, 12) is the nose notch: a hand-edited library file could hold it lit,
  // and the canvas must refuse it the same way it refuses a stroke there.
  expect(c.load(stored([[4, 6, 3], [0, 12, 3]]))).toBe(true)
  expect(drawn(c)).toEqual(['4,6'])
  expect(display.alive(0, 12)).toBe(false)
  // Loading what is already shown is not a change, so the screen sends nothing.
  expect(c.load(stored([[4, 6, 3]]))).toBe(false)
})

test('every hole is refused by load, at every level', () => {
  // `revive()` cannot catch these: the shape and the levels are both legal, so a
  // hand-edited file reaches `load` and this is the last refusal before the wire.
  // The whole mask rather than the one notch pixel, because the top-row gap and the
  // bridge row are three different runs of columns.
  for (let row = 0; row < display.ROWS; row++) {
    for (let col = 0; col < display.COLS; col++) {
      if (display.alive(row, col)) continue
      for (const level of [1, 2, 3]) {
        const c = new Canvas()
        expect(c.load(stored([[row, col, level]])), `${row},${col} at ${level}`).toBe(false)
        expect(c.empty, `${row},${col} at ${level} lit a hole`).toBe(true)
      }
    }
  }
})

test('a drawing that differs only in brightness is a change', () => {
  // `load` answers by comparing column words, and a word carries two bits per pixel,
  // so it can tell 1 from 3. If it could not, loading a drawing over one with the
  // same pixels lit would silently leave the old greys on the panel.
  const c = new Canvas()
  c.load(stored([[4, 6, display.PIXEL_ON]]))
  expect(c.load(stored([[4, 6, display.PIXEL_DIM]]))).toBe(true)
  expect(c.levels()[4][6]).toBe(display.PIXEL_DIM)
})

test('load ends the stroke, so the next drag does not draw a line into the drawing', () => {
  const c = new Canvas()
  c.drag({ row: 5, col: 2 }, 3)
  c.load(stored([[5, 20, 3]]))
  c.drag({ row: 5, col: 22 }, 3)
  expect(drawn(c)).toEqual(['5,20', '5,22'])
})
