import { expect, test } from 'bun:test'
import { COLS, ROWS, alive } from './display.js'
import * as font from './font.js'
import { BAND5 } from './fonts/band5.js'
import { CAPS5 } from './fonts/caps5.js'
import { FONTS } from './fonts/fit.js'
import * as kern from './fonts/kern.js'
import { staticText } from './fonts/place.js'
import { TALL7 } from './fonts/tall7.js'

/**
 * Every face a picker offers, so adding one to the registry is what subjects it
 * to the whole of this file. A font that is not offered is not a font anybody
 * can reach, and one that is offered has to hold every property below.
 */
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

// band5 is named throughout this test rather than left to the default. What it
// asserts is the row order, and `F`'s bitmap is band5's; reading it through the
// bare API tied a statement about flipping to whichever face was default.
test('glyphs are stored top row first and come back bottom row first', () => {
  expect(BAND5.glyphs.F).toEqual(['###', '#..', '##.', '#..', '#..'])
  expect(font.glyph('F', BAND5)[0]).toEqual([1, 0, 0])
  expect(font.glyph('F', BAND5)[4]).toEqual([1, 1, 1])
})

test('an unknown character falls back, and a missing case folds', () => {
  expect(font.width('é', BAND5)).toBe(kern.glyphWidth(BAND5.fallback))
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
  // 3 is band5's F. Named, because this test is about the argument form.
  expect(font.textWidth('F', { font: BAND5 })).toBe(3)
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
        // And the same for ink one row apart. Checking rows independently passes a
        // pair whose ink ends up diagonally adjacent, which on round LEDs closes
        // the gap just as completely: "JACOB" read as JAC0B with C and O fused,
        // and every per-row assertion above was satisfied while it did.
        for (let t = 0; t + 1 < f.height; t++) {
          const upper = inkAt(list[0], xs[0], t)
          const lower = inkAt(list[1], xs[1], t + 1)
          if (upper.length && lower.length) {
            const clear = Math.min(...lower) - Math.max(...upper) - 1
            expect(`${f.name} "${a}${b}" rows ${t}/${t + 1} clear ${clear}`).toBe(
              `${f.name} "${a}${b}" rows ${t}/${t + 1} clear ${Math.max(clear, 0)}`,
            )
          }
          const above = inkAt(list[1], xs[1], t)
          const below = inkAt(list[0], xs[0], t + 1)
          if (above.length && below.length) {
            const clear = Math.min(...above) - Math.max(...below) - 1
            expect(`${f.name} "${a}${b}" rows ${t + 1}/${t} clear ${clear}`).toBe(
              `${f.name} "${a}${b}" rows ${t + 1}/${t} clear ${Math.max(clear, 0)}`,
            )
          }
        }
      }
    }
  }
})

test('kerning closes an open pair and leaves a closed one alone', () => {
  // T's arm overhangs three empty columns; H and I face each other with stems.
  // band5 is NAMED because the pair this asserts is a lowercase one: caps5 became the
  // default and folds `o` onto `O`, so `To` is `TO` there and has nothing to tuck under.
  // The behaviour under test is kerning, not whichever face is currently default.
  expect(font.textWidth('To', { font: BAND5 })).toBeLessThan(
    font.textWidth('To', { font: BAND5, kern: false }),
  )
  expect(font.textWidth('HI', { font: BAND5 })).toBe(
    font.textWidth('HI', { font: BAND5, kern: false }),
  )
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
  const scrollers = FONTS.filter((f) => f.scrolls)
  expect(scrollers.length).toBeGreaterThan(1)
  for (const f of scrollers) {
    for (const s of [...CORPUS, ...Object.keys(f.glyphs)]) {
      const bitmap = font.panelBitmap(s, { font: f })
      expect(bitmap.length).toBe(ROWS)
      for (let r = 0; r < ROWS; r++) {
        if (!bitmap[r].some(Boolean)) continue
        for (let c = 0; c < COLS; c++) {
          expect(`${f.name} row ${r} col ${c} alive ${alive(r, c)}`).toBe(
            `${f.name} row ${r} col ${c} alive true`,
          )
        }
      }
    }
    expect(font.panelBitmap('Hg!', { font: f }).some((row) => row.some(Boolean))).toBe(true)
  }
})

// The rule the whole band argument rests on, stated as arithmetic rather than as
// prose: a face is `scrolls: true` only if its glyphs live inside rows 2 to 7,
// and a face outside that band must declare itself static. `tall7` is the one
// that fails the first half, which is why it declares the second.
test('a font may only claim it scrolls if its whole band has an LED in every column', () => {
  for (const f of FONTS) {
    const top = f.baseline + f.height - 1
    let clear = true
    for (let r = f.baseline; r <= top; r++) {
      for (let c = 0; c < COLS; c++) if (!alive(r, c)) clear = false
    }
    expect(`${f.name} rows ${f.baseline}-${top} clear ${clear}`).toBe(
      `${f.name} rows ${f.baseline}-${top} clear ${f.scrolls}`,
    )
  }
})

// band5 is named so the expected bitmap stays the one being described: these are
// band5's 3-wide A, and the point of the test is the third argument.
test('panelBitmap still takes an explicit baseline as its third argument', () => {
  const at = font.panelBitmap('A', { font: BAND5, spacing: 1 }, 0)
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

// ---------------------------------------------------------------- the registry

test('every offered font is pickable: a stable name, a label, and a note', () => {
  const names = new Set<string>()
  const labels = new Set<string>()
  for (const f of FONTS) {
    expect(f.name).toMatch(/^[a-z][a-z0-9]*$/)
    expect(f.label.length).toBeGreaterThan(0)
    expect(f.note.length).toBeGreaterThan(0)
    expect(names.has(f.name)).toBe(false)
    expect(labels.has(f.label)).toBe(false)
    names.add(f.name)
    labels.add(f.label)
    expect(font.fontByName(f.name)).toBe(f)
  }
  expect(names.size).toBeGreaterThanOrEqual(4)
})

// The rule track 33 stores items under, and the reason it is not `DEFAULT_FONT`:
// an item saved before the picker existed rendered in band5 and has to keep
// looking like itself, whatever a later default becomes. Asserted against BAND5
// by identity rather than against DEFAULT_FONT, or the test moves with the bug.
test('an item with no font stored, or an unknown one, reads as band5 for ever', () => {
  expect(font.LEGACY_FONT).toBe(BAND5)
  expect(font.fontByName(undefined)).toBe(BAND5)
  expect(font.fontByName(null)).toBe(BAND5)
  expect(font.fontByName('')).toBe(BAND5)
  expect(font.fontByName('band-5')).toBe(BAND5)
  expect(font.fontByName('helvetica')).toBe(BAND5)
})

// Separated from the legacy test above on purpose. Those two answer different
// questions - what an old item reads as, and what a new one starts as - and
// asserting both in one test is what made the default look load-bearing for
// stored content when it never was.
test('a new item starts in caps5, and old items are unaffected by that', () => {
  expect(font.DEFAULT_FONT).toBe(CAPS5)
  expect(font.LEGACY_FONT).toBe(BAND5)
  expect(font.DEFAULT_FONT).not.toBe(font.LEGACY_FONT)
})


/**
 * The property the default is chosen for, asserted so it cannot quietly regress.
 *
 * At 24 columns of one-bit ink on a panel that scrolls, two glyphs a single pixel
 * apart are a coin toss, and the source of a bitmap font looks equally fine
 * either way: this is exactly the class of bug that reading cannot catch. band5
 * has ten such pairs and slim5 fifteen, which is why neither is the default;
 * band6 has none.
 *
 * Deliberately only checked for `DEFAULT_FONT`, not for every face. band5's
 * glyphs are frozen because changing one re-renders and re-prices every item ever
 * saved, so its ten pairs are a fact to be routed around rather than a failure to
 * be fixed here.
 */
test('no two letters or digits in the default face are within one pixel', () => {
  const f = font.DEFAULT_FONT
  const chars = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789']
  const offenders: string[] = []
  for (let i = 0; i < chars.length; i++) {
    for (let j = i + 1; j < chars.length; j++) {
      const a = font.kern.glyphRows(f, chars[i])
      const b = font.kern.glyphRows(f, chars[j])
      // Only comparable in the same box; a different width is already a difference
      // a reader can see.
      if (a.length !== b.length || a[0].length !== b[0].length) continue
      let apart = 0
      for (let r = 0; r < a.length; r++) {
        for (let c = 0; c < a[0].length; c++) if (a[r][c] !== b[r][c]) apart++
      }
      if (apart > 0 && apart < 2) offenders.push(`${chars[i]}/${chars[j]}`)
    }
  }
  expect(offenders).toEqual([])
})

// band5's widths decide, for every text item ever saved, whether it is still and
// free or scrolling and five page erases. Changing a glyph in it silently
// re-renders and sometimes re-prices old content, which is why the new faces
// were added beside it. These numbers are that promise, written down.
//
// The face is named explicitly. This measured through the bare `textWidth(s)`
// until 2026-08-14, which reads `DEFAULT_FONT`, so a promise specifically about
// band5 was resting on band5 happening to be the default. It broke the moment the
// default moved to band6, correctly: the numbers below are band5's, and now the
// test asks band5 for them.
// Three of these grew by one to four columns on 2026-08-14, and that was a
// deliberate re-pricing rather than a drift: `kern.tuckLimit` now refuses a tuck
// that would leave two glyphs diagonally adjacent, which is what made `C` and `O`
// join in "JACOB" on the panel. 'Hello there' 37->38, 'FUNKY GLASSES' 49->50,
// 'GLASSES-125B37' 51->55. Across a 35-message corpus one message crossed the
// free-or-flash line in this face, "LOOK UP" at 24->25, so a saved item sitting
// exactly on 24 columns can now cost five page erases where it used to be free.
// That is the price of the fix and it is written down here rather than discovered.
test('band5 measures what it has always measured', () => {
  const frozen: Array<[string, number]> = [
    ['JOGGLE', 23],
    ['JOGGLES', 27],
    ['Hello there', 38],
    ['FUNKY GLASSES', 50],
    ['GLASSES-125B37', 55],
    ['F', 3],
  ]
  for (const [s, want] of frozen) {
    const got = font.textWidth(s, { font: BAND5 })
    expect(`band5 "${s}" ${got}`).toBe(`band5 "${s}" ${want}`)
  }
})

// The trap `panelFor` exists to close, checked against `alive` rather than
// against row numbers: the direct scrolling path applied to tall7 would sit its
// baseline on panel row 1 and draw into the nose notch, so a picked font has to
// route by what the font says about itself.
test('panelFor never lights a dead LED, whichever face was picked', () => {
  for (const f of FONTS) {
    for (const s of [...CORPUS, 'OK', '3:45', 'Hg!']) {
      const bitmap = font.panelFor(s, f)
      expect(bitmap.length).toBe(ROWS)
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < Math.min(bitmap[r].length, COLS); c++) {
          if (bitmap[r][c]) {
            expect(`${f.name} lit ${r},${c} alive ${alive(r, c)}`).toBe(
              `${f.name} lit ${r},${c} alive true`,
            )
          }
        }
      }
    }
  }
  // The direct call is still the wrong one for a static face, which is the whole
  // reason the router exists: it puts ink where there are no LEDs. Only for text
  // that reaches columns 10 to 14, which is why "OK" alone would not have shown
  // it and why this counts over strings long enough to cross the bridge.
  const onDead = (bitmap: number[][]) => {
    let n = 0
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < Math.min(bitmap[r].length, COLS); c++) {
        if (bitmap[r][c] && !alive(r, c)) n++
      }
    }
    return n
  }
  const crossers = ['HELLO', '3:45 OK', 'FUNKY']
  expect(crossers.some((s) => onDead(font.panelBitmap(s, { font: TALL7 })) > 0)).toBe(true)
  for (const s of crossers) expect(onDead(font.panelFor(s, TALL7))).toBe(0)
  expect(font.panelFor('OK', TALL7)).toEqual(font.staticText('OK', { font: TALL7 }).bitmap)
  expect(font.panelFor('OK')).toEqual(font.panelBitmap('OK'))
})
