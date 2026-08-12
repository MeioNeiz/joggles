import { expect, test } from 'bun:test'
import { text, width } from './content.js'
import { TYPE1_BRACKET } from './dats.js'
import { alive } from './display.js'
import {
  WIDTH,
  frames,
  gridAt,
  hidden,
  marqueeAt,
  marqueeOffsets,
  marqueeWidth,
  scrollOffsets,
  windowAt,
} from './viewport.js'

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

/**
 * The panel's loop is 24 columns longer than the bitmap, which is track 16's finding
 * and the mismatch Jacob reported: preview with not one pixel of gap, panel with a
 * full screen width of it, on a save whose 27 columns carried no client gap at all.
 *
 * The magnitude comes from the record `DATCP` writes, `ncols = N + 48` with the
 * content at store column 24, so a scroll resuming at the content meets only the
 * trailing 24 (*derived*). One observation still contradicts it - a solid block
 * looped seamlessly in the session that saved - which is why `frames` defaults to
 * `uploaded` and only a preview asks for `panel`.
 */
test("the panel's loop is the bitmap plus the device's trailing blanks", () => {
  expect(TYPE1_BRACKET).toBe(24)
  expect(marqueeWidth(27)).toBe(51)
  expect(marqueeOffsets(27, 0).length).toBe(51)
  expect(new Set(marqueeOffsets(27, 0)).size).toBe(51)
  expect(new Set(marqueeOffsets(27, 1)).size).toBe(51)
})

test('the walk starts on the content and reverses with dir', () => {
  expect(marqueeOffsets(27, 0).slice(0, 2)).toEqual([0, 1])
  expect(marqueeOffsets(27, 1).slice(0, 2)).toEqual([0, 50])
  expect(marqueeAt(solid(32), 0)).toEqual(windowAt(solid(32), 0))
})

/**
 * The assertion that would have caught the mismatch, in the exact shape of the
 * observation: one full screen width of dark per pass, and the word completely gone
 * before it returns. A wrapped window over the same bitmap never goes dark at all.
 */
test('a panel walk shows exactly one fully dark frame per pass; the bitmap walk shows none', () => {
  const dark = (f: number[][]) => f.every((row) => row.every((v) => v === 0))
  const word = solid(27)
  const panel = marqueeOffsets(27, 0).map((off) => marqueeAt(word, off))
  // A 24-column blank run in a 24-column window is dark for exactly one step, which
  // is the threshold at which the content does clear the panel completely.
  expect(panel.filter(dark).length).toBe(TYPE1_BRACKET - WIDTH + 1)
  expect(panel.filter(dark).length).toBe(1)
  expect(scrollOffsets(27, 0).map((o) => windowAt(word, o, { wrap: true })).filter(dark))
    .toEqual([])
})

/**
 * The direction half of the same finding, and the assertion that holds the model to it:
 * both directions gap and one shows it at the *beginning* of the pass
 * (`research/vendor-app-protocol.md`, 2026-08-11, by eye). So the count must not move
 * with `dir` and the position must.
 */
test('direction moves where the dark frame falls, never how many there are', () => {
  const dark = (f: number[][]) => f.every((row) => row.every((v) => v === 0))
  const walk = (dir: 0 | 1) =>
    marqueeOffsets(240, dir).map((off) => marqueeAt(solid(240), off))
  expect(walk(0).findIndex(dark)).toBe(240) // last of 264 steps: the end of a pass
  expect(walk(1).findIndex(dark)).toBe(TYPE1_BRACKET) // 24 in: it reads as the start
  expect(walk(0).filter(dark).length).toBe(1)
  expect(walk(1).filter(dark).length).toBe(1)
})

test('one dark frame at every width, including content narrower than the panel', () => {
  const dark = (f: number[][]) => f.every((row) => row.every((v) => v === 0))
  for (const n of [1, 5, 23, 24, 25, 200]) {
    const walk = marqueeOffsets(n, 0).map((off) => marqueeAt(solid(n), off))
    expect([n, walk.filter(dark).length]).toEqual([n, 1])
  }
})

/** Trailing all-zero columns of a bitmap: the client gap, whoever supplied it. */
const trailingBlank = (b: number[][]) => {
  let n = 0
  for (let c = b[0].length - 1; c >= 0 && b.every((row) => row[c] === 0); c--) n++
  return n
}

/**
 * `SCROLL_GAP` is 0, but `content.text` pads to the panel unconditionally, so a scroll
 * of a word narrower than 24 columns still carries a client gap and gaps for longer
 * than the one screen `SCROLL_GAP`'s table promises. Asserted against the padding the
 * bitmap actually has rather than a column count, so a new font cannot break it.
 */
test('text() pads to the panel, so a short scroll gaps by more than one screen', () => {
  const dark = (f: number[][]) => f.every((row) => row.every((v) => v === 0))
  const short = text('HI', { kind: 'scroll', dir: 0, speed: 50 })
  const pad = trailingBlank(short.bitmap)
  expect(width(short.bitmap)).toBe(WIDTH)
  expect(pad).toBeGreaterThan(0)
  const walk = frames(short.bitmap, short.motion, { loop: 'panel' })
  expect(walk.filter(dark).length).toBe(pad + TYPE1_BRACKET - WIDTH + 1)
  expect(walk.filter(dark).length).toBeGreaterThan(1)
})

test('a client gap adds to the device gap rather than replacing it', () => {
  const dark = (f: number[][]) => f.every((row) => row.every((v) => v === 0))
  // 27 columns of content plus a 24-column client gap: 48 blank in a 51+24 loop, so
  // 25 dark frames rather than 1. This is the doubling the original complaint was.
  const padded = [...Array(9)].map(() => [...new Array(27).fill(3), ...new Array(24).fill(0)])
  const frames51 = marqueeOffsets(51, 0).map((off) => marqueeAt(padded, off))
  expect(frames51.filter(dark).length).toBe(2 * TYPE1_BRACKET - WIDTH + 1)
})

test('the dead pixels stay at panel coordinates through a marquee too', () => {
  const content = solid(200)
  const holes = (off: number) => {
    const w = marqueeAt(content, off)
    const out: string[] = []
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < WIDTH; c++) if (!w[r][c]) out.push(`${r},${c}`)
    }
    return out
  }
  const expected = holes(0)
  expect(expected.length).toBeGreaterThan(0)
  // Offsets whose whole window is still on content, so the only dark cells are holes.
  for (const off of [1, 7, 176]) expect(holes(off)).toEqual(expected)
})

test('frames walks the bitmap unless asked for the panel', () => {
  const c = text('HELLO THERE', { kind: 'scroll', dir: 0, speed: 50 })
  const cols = width(c.bitmap)
  expect(frames(c.bitmap, c.motion).length).toBe(cols)
  expect(frames(c.bitmap, c.motion, { loop: 'uploaded' }).length).toBe(cols)
  expect(frames(c.bitmap, c.motion, { loop: 'panel' }).length).toBe(cols + TYPE1_BRACKET)
  // Static is one frame either way: what MODE 01 shows out of the record is its own
  // open question and must not be guessed at here.
  expect(frames(c.bitmap, { kind: 'static' }, { loop: 'panel' }).length).toBe(1)
})

test('marqueeAt tolerates the shapes windowAt does', () => {
  expect(marqueeAt([])[0].length).toBe(WIDTH)
  expect(marqueeAt(solid(3), -1)[0].length).toBe(WIDTH)
  expect(marqueeWidth(0)).toBe(TYPE1_BRACKET)
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
