/**
 * Motifs are pictures, so what they must satisfy is geometry rather than bytes: the
 * right shape lands in the right half of the panel, nothing is drawn into a hole, and
 * a motif added later cannot be invisible or unreachable.
 */
import { expect, test } from 'bun:test'
import { width } from './content.js'
import { COLS, ROWS, alive } from './display.js'
import * as m from './motifs.js'

const litCells = (bitmap: number[][]) =>
  bitmap.reduce((n, row) => n + row.filter((v) => v > 0).length, 0)

const litIn = (bitmap: number[][], from: number, to: number) => {
  let n = 0
  for (const row of bitmap) for (let c = from; c < to; c++) if (row[c] > 0) n++
  return n
}

test('every motif is panel-shaped, lit, and inside the alive pixels', () => {
  for (const motif of m.MOTIFS) {
    const bitmap = motif.make()
    expect(bitmap.length).toBe(ROWS)
    expect(litCells(bitmap)).toBeGreaterThan(0)
    // The whole reason motifs stay in rows 2-7: a lit cell on a dead LED is a limb the
    // wearer never sees, and it looks like a rendering bug rather than a hole.
    expect(m.hidden(bitmap)).toBe(0)
    if (motif.wide) expect(width(bitmap)).toBeGreaterThan(COLS)
    else expect(width(bitmap)).toBe(COLS)
  }
})

test('the W W is one W per lens, and neither crosses the bridge', () => {
  const bitmap = m.ww()
  const left = litIn(bitmap, 0, m.LENS_COLS)
  const right = litIn(bitmap, m.LENS_COLS, COLS)
  expect(left).toBeGreaterThan(0)
  // Identical, because it is one glyph drawn twice rather than a mirror: the panel is
  // one 24-column surface, so nothing reflects it for us.
  expect(right).toBe(left)
  for (let r = 0; r < ROWS; r++) {
    // The two columns either side of the join stay clear, so each W reads as its own.
    expect(bitmap[r][m.LENS_COLS - 1]).toBe(0)
    expect(bitmap[r][m.LENS_COLS]).toBe(0)
  }
})

test('a W is a W at any width, with four vertices and no dead columns', () => {
  for (const w of [5, 7, 9, 12]) {
    const glyph = m.wGlyph(w)
    expect(glyph[0].length).toBe(w)
    // Every column carries ink: a W whose strokes miss a column has a gap in it, which
    // is what happens when the vertices are floored instead of rounded.
    for (let c = 0; c < w; c++) {
      expect(glyph.some((row) => row[c] > 0)).toBe(true)
    }
    // Both outer columns reach the top row, which is what makes it a W and not a V.
    const top = glyph.length - 1
    expect(glyph[top][0]).toBeGreaterThan(0)
    expect(glyph[top][w - 1]).toBeGreaterThan(0)
  }
})

test('the wide loop closes on a whole glyph, so the wrap is not a stutter', () => {
  const loop = m.wLoop(240, 7, 3)
  expect(width(loop) % 10).toBe(0)
  // Asked for 240 and 24 pitches of 10 is exactly that, but the property that matters
  // is the snap, so it is asserted at a width that does not divide evenly too.
  const odd = m.wLoop(237, 7, 3)
  expect(width(odd) % 10).toBe(0)
  expect(m.hidden(odd)).toBe(0)
})

test('the registry and the motifs agree in both directions', () => {
  for (const motif of m.MOTIFS) {
    expect(m.motifByName(motif.name)).toBe(motif)
    expect(motif.label.length).toBeGreaterThan(0)
  }
  expect(m.motifByName('nope')).toBeNull()
  // Distinct names, or `motifByName` silently answers with the first of a pair.
  expect(new Set(m.MOTIFS.map((x) => x.name)).size).toBe(m.MOTIFS.length)
})

test('the zigzag spans the bridge, which is the one motif that should', () => {
  const bitmap = m.zigzag()
  expect(litIn(bitmap, 0, m.LENS_COLS)).toBeGreaterThan(0)
  expect(litIn(bitmap, m.LENS_COLS, COLS)).toBeGreaterThan(0)
  // Continuous across the join: a chevron that stops at the nose reads as two ticks.
  const nearJoin = litIn(bitmap, m.LENS_COLS - 2, m.LENS_COLS + 2)
  expect(nearJoin).toBeGreaterThan(0)
})

test('every lit cell of every motif is on a live LED, checked against display', () => {
  // `hidden` is the motif module's own arithmetic, so this asserts the same property
  // against `display.alive` directly rather than trusting one function twice.
  for (const motif of m.MOTIFS) {
    const bitmap = motif.make()
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < Math.min(COLS, bitmap[r].length); c++) {
        if (bitmap[r][c] > 0) expect(alive(r, c)).toBe(true)
      }
    }
  }
})

test('a W is mirror-symmetric at odd widths, which is what makes it read as a W', () => {
  // Asymmetry here is not cosmetic: at seven columns one extra pixel on one arm is the
  // difference between a W and a smudge, and it is exactly what a single continuous
  // Bresenham path produces, because it breaks its ties one way going out and the other
  // coming back. Even widths are excluded on purpose: there is no centre column to put
  // the peak on, the same problem `content.centre` answers by choosing a side.
  for (const w of [5, 7, 9, 11]) {
    const glyph = m.wGlyph(w)
    for (const row of glyph) {
      for (let c = 0; c < w; c++) expect(row[c]).toBe(row[w - 1 - c])
    }
  }
})

test('the W W is symmetric about the bridge as well as within each lens', () => {
  // The two lenses are the same content at the same offset, which is what "a W for each
  // eye" means and what the per-lens pairing in the geometry gives for free.
  const bitmap = m.ww()
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < m.LENS_COLS; c++) {
      expect(bitmap[r][c]).toBe(bitmap[r][c + m.LENS_COLS])
    }
  }
})
