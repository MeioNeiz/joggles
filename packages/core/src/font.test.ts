import { expect, test } from 'bun:test'
import { COLS, ROWS, alive } from './display.js'
import * as font from './font.js'
import { BAND5 } from './fonts/band5.js'
import * as kern from './fonts/kern.js'
import { staticText } from './fonts/place.js'
import { TALL7 } from './fonts/tall7.js'
import type { Font } from './fonts/types.js'

const FONTS: Font[] = [BAND5, TALL7]
const CORPUS = [
  'Hello there',
  'FUNKY GLASSES',
  'jaguar 42%',
  'Wavey, mate!',
  'GLASSES-125B37',
  "it's 3:45 & i'm (still) here",
  'IWiwl1i0O',
  ' ',
  'a',
  '',
]

/** Lit columns of one glyph, at its placed position, for one row of the font. */
function inkAt(piece: kern.Piece, x: number, top: number): number[] {
  const row = piece.rows[top] ?? ''
  const out: number[] = []
  for (let c = 0; c < row.length; c++) if (row[c] === '#') out.push(x + c)
  return out
}

// ---------------------------------------------------------------- glyph tables

test('every glyph is rectangular and the height the font claims', () => {
  for (const f of FONTS) {
    for (const [ch, rows] of Object.entries(f.glyphs)) {
      expect(`${f.name} ${ch}: ${rows.length} rows`).toBe(`${f.name} ${ch}: ${f.height} rows`)
      expect(new Set(rows.map((r) => r.length)).size).toBe(1)
      expect(rows.every((r) => /^[.#]+$/.test(r))).toBe(true)
    }
    expect(f.fallback.length).toBe(f.height)
  }
})

// Two letters that render the same bitmap are a silent bug: the text is legible,
// says the wrong thing, and no test that only checks widths can see it. This
// found `0` identical to `O` in both fonts, which matters because every unit is
// called something like GLASSES-125B37.
test('no two glyphs in a font render identically', () => {
  for (const f of FONTS) {
    const seen = new Map<string, string>()
    for (const [ch, rows] of Object.entries(f.glyphs)) {
      if (kern.isBlank(rows)) continue
      const key = rows.join('/')
      const first = seen.get(key)
      expect(first ? `${f.name}: ${first} and ${ch} are the same glyph` : 'ok').toBe('ok')
      seen.set(key, ch)
    }
  }
})

test('glyphs are stored top row first and come back bottom row first', () => {
  expect(BAND5.glyphs.F).toEqual(['###', '#..', '##.', '#..', '#..'])
  expect(font.glyph('F')[0]).toEqual([1, 0, 0])
  expect(font.glyph('F')[4]).toEqual([1, 1, 1])
})

test('an unknown character falls back, and a missing case folds', () => {
  expect(font.width('é')).toBe(kern.glyphWidth(BAND5.fallback))
  // tall7 carries no lowercase at all, so folding is the only reason 'ok' renders.
  expect(font.textBitmap('ok', { font: TALL7 })).toEqual(
    font.textBitmap('OK', { font: TALL7 }),
  )
})

// ---------------------------------------------------------------- measurement

// The contract that makes kerning safe to add: a caller that measures and then
// renders is told one number. Before kerning the gap was a constant and this was
// arithmetic; now it is a property of each pair, so it is worth asserting.
test('textWidth is the width of the bitmap textBitmap returns, always', () => {
  const strings = [...CORPUS, ...Object.keys(BAND5.glyphs), ...Object.keys(BAND5.glyphs).map((c) => `A${c}A`)]
  for (const f of FONTS) {
    for (const s of strings) {
      const bitmap = font.textBitmap(s, { font: f })
      expect(font.textWidth(s, { font: f })).toBe(bitmap[0]?.length ?? 0)
      expect(bitmap.length).toBe(f.height)
    }
  }
})

test('the spacing argument is still a bare number, as every caller passes it', () => {
  expect(font.textWidth('HI', 3)).toBe(font.textWidth('HI', { spacing: 3 }))
  expect(font.textWidth('HI', 3)).toBeGreaterThan(font.textWidth('HI', 1))
  expect(font.textWidth('F')).toBe(3)
})

test('measuring a single glyph is its own width, kerned or not', () => {
  for (const ch of Object.keys(BAND5.glyphs)) {
    expect(font.textWidth(ch)).toBe(font.width(ch))
  }
})

// ---------------------------------------------------------------- kerning

// The property, and it holds by arithmetic rather than by tuning: `tuckLimit` is
// measured from the facing ink, so no pair can be pulled into a collision however
// the tables or `maxTuck` change. Every ordered pair is checked because the one
// that breaks it will be some pair nobody thought to sample.
test('no kerned pair puts two glyphs closer than the base spacing', () => {
  for (const f of FONTS) {
    const chars = Object.keys(f.glyphs)
    for (const a of chars) {
      for (const b of chars) {
        const list = kern.pieces(a + b, f)
        const xs = kern.positions(list)
        expect(xs[1]).toBeGreaterThanOrEqual(xs[0] + list[0].width)
        for (let t = 0; t < f.height; t++) {
          const left = inkAt(list[0], xs[0], t)
          const right = inkAt(list[1], xs[1], t)
          if (!left.length || !right.length) continue
          // Blank columns between the two inks, so touching scores 0 rather than 1.
          const clear = Math.min(...right) - Math.max(...left) - 1
          expect(`${f.name} "${a}${b}" row ${t} clear ${clear}`).toBe(
            `${f.name} "${a}${b}" row ${t} clear ${Math.max(clear, f.spacing)}`,
          )
        }
      }
    }
  }
})

test('kerning closes an open pair and leaves a closed one alone', () => {
  // T's arm overhangs three empty columns; H and I face each other with stems.
  expect(font.textWidth('To')).toBeLessThan(font.textWidth('To', { kern: false }))
  expect(font.textWidth('HI')).toBe(font.textWidth('HI', { kern: false }))
})

test('kerning never widens anything', () => {
  for (const s of CORPUS) {
    expect(font.textWidth(s)).toBeLessThanOrEqual(font.textWidth(s, { kern: false }))
  }
})

// A blank glyph shares no row with its neighbours, so the profile rule would let
// `maxTuck` eat the word gap from both sides and run the words together.
test('a space is never kerned away', () => {
  // One more glyph and one more gap than "aa", both at their full width.
  expect(font.textWidth('a a')).toBe(font.textWidth('aa') + font.width(' ') + BAND5.spacing)
  expect(kern.tuckLimit(BAND5.glyphs.T, BAND5.glyphs[' '])).toBe(0)
})

// ---------------------------------------------------------------- placement

// What "safe to scroll" means: the glyph is inside the band that has an LED in
// every column, so no position of the message can take a stroke away. Asserted
// against `alive` over the whole panel width rather than against row numbers,
// because the row numbers are the thing that would be wrong.
test('scrolling text only occupies rows that are alive across the whole panel', () => {
  for (const s of CORPUS) {
    const bitmap = font.panelBitmap(s)
    expect(bitmap.length).toBe(ROWS)
    for (let r = 0; r < ROWS; r++) {
      if (!bitmap[r].some(Boolean)) continue
      for (let c = 0; c < COLS; c++) expect(alive(r, c)).toBe(true)
    }
  }
  expect(font.panelBitmap('Hg!').some((row) => row.some(Boolean))).toBe(true)
})

test('panelBitmap still takes an explicit baseline as its third argument', () => {
  const at = font.panelBitmap('A', 1, 0)
  expect(at[0]).toEqual([1, 0, 1]) // A's feet, on panel row 0
  expect(at[4]).toEqual([0, 1, 0]) // its apex, five rows up
  expect(at[5].every((v) => v === 0)).toBe(true)
})

// The tall font's whole contract. A pixel on a dead LED is not dim, it is gone,
// so a clipped glyph reads as a different letter.
test('the tall font never lights a dead LED', () => {
  for (const s of [...CORPUS, 'OK', 'HI', '42', 'YES', '3:45', '0', 'W']) {
    const placed = staticText(s)
    expect(placed.bitmap.length).toBe(ROWS)
    for (let r = 0; r < ROWS; r++) {
      expect(placed.bitmap[r].length).toBe(COLS)
      for (let c = 0; c < COLS; c++) {
        if (placed.bitmap[r][c]) expect(alive(r, c)).toBe(true)
      }
    }
  }
})

// The other half of "reported, never drawn": a glyph is placed whole or not at
// all. "No dead LED lit" and "dropped is a suffix" both still pass if draw()
// quietly clips a row, so count the ink: every pixel the kept prefix carries is
// on the panel, no more and no fewer.
test('staticText draws every pixel of what it kept, whole glyphs only', () => {
  const ink = (text: string) =>
    kern
      .pieces(text, TALL7)
      .reduce((n, p) => n + p.rows.join('').split('#').length - 1, 0)
  for (const s of ['JOGGLES', 'WWWWWWWW', 'Jog 42!', 'T.T.T.', '3:45 OK', 'IIIIIIIIII']) {
    const placed = staticText(s)
    expect(s.endsWith(placed.dropped)).toBe(true)
    const kept = s.slice(0, s.length - placed.dropped.length)
    const lit = placed.bitmap.reduce(
      (n, row) => n + row.reduce((m, v) => m + (v ? 1 : 0), 0),
      0,
    )
    expect(`"${s}" lit ${lit}`).toBe(`"${s}" lit ${ink(kept)}`)
  }
})

test('what does not fit is dropped from the end and reported', () => {
  const placed = staticText('JOGGLES')
  expect(placed.dropped.length).toBeGreaterThan(0)
  expect(`JOGGLES`.endsWith(placed.dropped)).toBe(true)
  // What was kept is drawn, and only what was kept.
  expect(placed.ink).not.toBeNull()
  expect(staticText('OK').dropped).toBe('')
  expect(staticText('').ink).toBeNull()
})

test('a short string is placed away from the edge rather than at column 0', () => {
  for (const s of ['OK', 'HI', '42']) {
    const ink = staticText(s).ink
    expect(ink).not.toBeNull()
    if (!ink) continue
    expect(ink[0]).toBeGreaterThan(0)
    // Centred: the two margins differ by less than a glyph.
    expect(Math.abs(ink[0] - (COLS - 1 - ink[1]))).toBeLessThan(4)
  }
})

// The scrolling font placed through the tall path is the control case: it fits
// inside the safe band, so no glyph should ever need moving.
test('a band5 glyph placed statically never has to step around anything', () => {
  const placed = staticText('HI', { font: BAND5 })
  expect(placed.dropped).toBe('')
  const direct = kern.measure(kern.pieces('HI', BAND5))
  expect(placed.ink).toEqual([placed.ink?.[0] ?? 0, (placed.ink?.[0] ?? 0) + direct - 1])
})
