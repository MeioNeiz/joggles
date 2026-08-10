/**
 * What a finger on the pad puts on the wire.
 *
 * `canvas.test.ts` checks the arithmetic and the sender has its own suite; this is
 * the join between them, which is the part the screen would otherwise be the only
 * evidence for. It runs the chain the `Pad` runs - touch coordinates, `cellAt`,
 * `Canvas.drag`, `LiveSender.set` - and asserts the columns that come out, because
 * a drawing that is one column off still looks like a drawing.
 *
 * The React half is deliberately absent. Everything below `onCell` is here.
 */
import { LiveSender, display, protocol as p } from '@joggles/core'
import { MockTransport } from '@joggles/core/src/mock-transport.js'
import { expect, test } from 'bun:test'
import { Canvas, type Cell, cellAt } from './canvas.js'

/** A pad ten units to the cell, as `Pad` measures it after layout. */
const BOX = { width: display.COLS * 10, height: display.ROWS * 10 }

/** The middle of cell (row, col), which is where a finger would be. */
const touchOn = (row: number, col: number): [number, number] => [
  col * 10 + 5,
  (display.ROWS - 1 - row) * 10 + 5,
]

/** Columns written to the live channel, in order. */
const indices = (t: MockTransport): number[] =>
  t.to(p.CHAR_BULK_B).map((f) => p.body(f)[0])

/** The 24-bit word of the last write to a column, as the panel would read it. */
const wordFor = (t: MockTransport, col: number): number => {
  const frames = t.to(p.CHAR_BULK_B).filter((f) => p.body(f)[0] === col)
  const body = p.body(frames.at(-1)!)
  return (body[1] << 16) | (body[2] << 8) | body[3]
}

/** One screen's worth of the loop the `Pad` drives, with no React in it. */
function stroke(canvas: Canvas, sender: LiveSender, path: Cell[], level: number): void {
  for (const cell of path) {
    const [x, y] = touchOn(cell.row, cell.col)
    const hit = cellAt(x, y, BOX)
    if (!hit) continue
    if (!canvas.drag(hit, level)) continue
    sender.set(canvas.snapshot())
  }
  canvas.lift()
}

test('a stroke writes one column per column it touched, and acks the last', async () => {
  const t = new MockTransport()
  const canvas = new Canvas()
  const sender = new LiveSender(t, { pacing: 0 })

  stroke(canvas, sender, [
    { row: 4, col: 2 },
    { row: 4, col: 5 },
  ], 3)
  await sender.idle()

  // Columns 3 and 4 were never touched: the sampler skipped them and `Canvas.drag`
  // filled them in, which is the whole reason a stroke is not a dotted line.
  expect(indices(t)).toEqual([2, 3, 4, 5])
  expect(t.writes.at(-1)?.withResponse).toBe(true)
  expect(wordFor(t, 3)).toBe(display.PIXEL_ON << (display.STRIDE * 4))
})

test('the brush level reaches the wire as the panel two-bit value', async () => {
  const t = new MockTransport()
  const canvas = new Canvas()
  const sender = new LiveSender(t, { pacing: 0 })

  stroke(canvas, sender, [{ row: 6, col: 8 }], display.PIXEL_DIM)
  await sender.idle()
  expect(wordFor(t, 8)).toBe(display.PIXEL_DIM << (display.STRIDE * 6))
})

test('a stroke over the nose bridge writes the columns beside it and nothing else', async () => {
  const t = new MockTransport()
  const canvas = new Canvas()
  const sender = new LiveSender(t, { pacing: 0 })

  stroke(canvas, sender, [
    { row: 0, col: 7 },
    { row: 0, col: 17 },
  ], 3)
  await sender.idle()

  // Row 0 has LEDs only outside columns 9 to 14. The dead ones are not written at
  // all, rather than written blank: nothing changed in them, so nothing is owed.
  expect(indices(t)).toEqual([7, 8, 15, 16, 17])
})

test('erasing sends the column again, now empty', async () => {
  const t = new MockTransport()
  const canvas = new Canvas()
  const sender = new LiveSender(t, { pacing: 0 })

  stroke(canvas, sender, [{ row: 4, col: 12 }], 3)
  await sender.idle()
  stroke(canvas, sender, [{ row: 4, col: 12 }], 0)
  await sender.idle()

  expect(indices(t)).toEqual([12, 12])
  expect(wordFor(t, 12)).toBe(0)
})

test('a touch outside the pad is not a cell, so nothing is drawn or sent', async () => {
  const t = new MockTransport()
  const canvas = new Canvas()
  const sender = new LiveSender(t, { pacing: 0 })

  expect(cellAt(-5, 5, BOX)).toBeNull()
  expect(cellAt(BOX.width + 5, 5, BOX)).toBeNull()
  await sender.idle()
  expect(t.writes).toHaveLength(0)
  expect(canvas.empty).toBe(true)
})

test('clear is one write, and the canvas and the device agree afterwards', async () => {
  const t = new MockTransport()
  const canvas = new Canvas()
  const sender = new LiveSender(t, { pacing: 0 })

  stroke(canvas, sender, [
    { row: 3, col: 1 },
    { row: 3, col: 4 },
  ], 3)
  await sender.idle()
  const drawn = t.writes.length

  canvas.clear()
  sender.clear()
  await sender.idle()

  expect(t.writes).toHaveLength(drawn + 1)
  expect(t.commands).toEqual(['CLRL'])
  expect(canvas.empty).toBe(true)
})

test('loading a saved drawing writes its lit columns and nothing else', async () => {
  const t = new MockTransport()
  const canvas = new Canvas()
  const sender = new LiveSender(t, { pacing: 0 })

  // What the Load button runs: replace the canvas, hand the sender the new state.
  // The drawing lights columns 3 and 20; the erased column 5 was never lit on the
  // device, so nothing is owed there and nothing is written.
  const levels = canvas.levels()
  levels[4][3] = display.PIXEL_ON
  levels[6][20] = display.PIXEL_DIM
  expect(canvas.load(levels)).toBe(true)
  sender.set(canvas.snapshot())
  await sender.idle()

  expect(indices(t)).toEqual([3, 20])
  expect(wordFor(t, 3)).toBe(display.PIXEL_ON << (display.STRIDE * 4))
  expect(wordFor(t, 20)).toBe(display.PIXEL_DIM << (display.STRIDE * 6))
  expect(t.writes.at(-1)?.withResponse).toBe(true)
})

test('a dead link tells the screen once, and the sender stays dead', async () => {
  const t = new MockTransport()
  const seen: unknown[] = []
  t.write = () => Promise.reject(new Error('device disconnected'))
  const canvas = new Canvas()
  const sender = new LiveSender(t, { pacing: 0, onError: (e) => seen.push(e) })

  stroke(canvas, sender, [{ row: 4, col: 4 }], 3)
  await expect(sender.idle()).rejects.toThrow('device disconnected')

  // What the screen renders its banner from, and what disables the pad. Touches
  // await nothing, so without the callback a dropped link is invisible.
  expect(seen).toHaveLength(1)
  expect(sender.stopped).toBe(true)

  stroke(canvas, sender, [{ row: 4, col: 9 }], 3)
  await expect(sender.idle()).rejects.toThrow('device disconnected')
  expect(seen).toHaveLength(1)
})
