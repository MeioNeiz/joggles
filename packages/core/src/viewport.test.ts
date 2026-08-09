import { expect, test } from 'bun:test'
import { text, width } from './content.js'
import { alive } from './display.js'
import { WIDTH, frames, gridAt, hidden, scrollOffsets, windowAt } from './viewport.js'

const solid = (cols: number) =>
  Array.from({ length: 9 }, () => new Array(cols).fill(3))

test('a window is always the panel, whatever the content is', () => {
  expect(windowAt(solid(740)).length).toBe(9)
  expect(windowAt(solid(740))[0].length).toBe(WIDTH)
  expect(windowAt(solid(3))[0].length).toBe(WIDTH)
  expect(windowAt([])[0].length).toBe(WIDTH)
})

/**
 * The trap this whole module exists for. Masking a wide bitmap with `alive()`
 * puts the hole in content coordinates, so it slides along with the glyph; the
 * hardware does the opposite. Same holes, every offset, or the preview is lying.
 */
test('the dead pixels stay at panel coordinates as content scrolls', () => {
  const content = solid(200)
  const holes = (off: number) => {
    const w = windowAt(content, off, { wrap: true })
    const out: string[] = []
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < WIDTH; c++) if (!w[r][c]) out.push(`${r},${c}`)
    }
    return out
  }
  const expected = holes(0)
  expect(expected.length).toBeGreaterThan(0)
  for (const off of [1, 7, 13, 99, 199]) expect(holes(off)).toEqual(expected)
})

test('the blanked cells are exactly the ones with no LED', () => {
  const w = windowAt(solid(24))
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < WIDTH; c++) {
      expect(w[r][c] === 0).toBe(!alive(r, c))
    }
  }
})

test('greyscale survives the window', () => {
  const content = Array.from({ length: 9 }, () => new Array(24).fill(2))
  expect(windowAt(content)[4][4]).toBe(2)
})

test('without wrap the window runs off into darkness', () => {
  const w = windowAt(solid(10), 6)
  expect(w[4][3]).toBe(3) // content column 9, the last one
  expect(w[4][4]).toBe(0) // past the end
})

test('with wrap the window comes back round', () => {
  const content = Array.from({ length: 9 }, () => new Array(10).fill(0))
  content[4][0] = 3
  expect(windowAt(content, 6, { wrap: true })[4][4]).toBe(3)
})

test('a negative offset wraps rather than reading before the start', () => {
  const content = Array.from({ length: 9 }, () => new Array(10).fill(0))
  content[4][9] = 3
  expect(windowAt(content, -1, { wrap: true })[4][0]).toBe(3)
})

test('content shorter than the panel is left-aligned', () => {
  const content = Array.from({ length: 9 }, () => new Array(3).fill(3))
  const w = windowAt(content)
  expect(w[4][0]).toBe(3)
  expect(w[4][2]).toBe(3)
  expect(w[4][3]).toBe(0)
})

test('a scroll visits every content column once, and direction reverses it', () => {
  expect(scrollOffsets(5, 0)).toEqual([0, 1, 2, 3, 4])
  expect(scrollOffsets(5, 1)).toEqual([0, 4, 3, 2, 1])
  expect(new Set(scrollOffsets(200, 1)).size).toBe(200)
})

test('static content is one frame, a scroll is one per column', () => {
  const still = text('HI')
  expect(frames(still.bitmap, still.motion).length).toBe(1)
  const moving = text('HELLO', { kind: 'scroll', dir: 0, speed: 50 })
  expect(frames(moving.bitmap, moving.motion).length).toBe(width(moving.bitmap))
})

test('a scrolled frame differs from the one before it', () => {
  const c = text('HELLO THERE', { kind: 'scroll', dir: 0, speed: 50 })
  const f = frames(c.bitmap, c.motion)
  expect(f[0]).not.toEqual(f[1])
})

test('gridAt renders the same pixels the window holds', () => {
  const c = text('HI')
  const g = gridAt(c.bitmap)
  const w = windowAt(c.bitmap)
  for (let r = 0; r < 9; r++) {
    for (let col = 0; col < WIDTH; col++) expect(g.get(r, col)).toBe(w[r][col])
  }
  expect(g.render().split('\n').length).toBe(9)
})

test('hidden counts what the user drew into a hole', () => {
  expect(hidden(solid(24))).toBe(9 * 24 - alivePixels())
  const clean = text('HI')
  expect(hidden(clean.bitmap)).toBe(0)
})

function alivePixels(): number {
  let n = 0
  for (let r = 0; r < 9; r++) for (let c = 0; c < WIDTH; c++) if (alive(r, c)) n++
  return n
}
