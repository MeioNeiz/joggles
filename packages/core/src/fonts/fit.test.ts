import { expect, test } from 'bun:test'
import { COLS } from '../display.js'
import * as font from '../font.js'
import { BAND5 } from './band5.js'
import { BAND6 } from './band6.js'
import { FONTS, FREE_COLUMNS, bestFree, fit, fitAll, fontByName } from './fit.js'
import { SLIM5 } from './slim5.js'
import { TALL7 } from './tall7.js'

/**
 * Real messages rather than pangrams, because the claims these fonts are offered
 * on ("narrower", "easier to read, fewer characters free") are claims about the
 * things people actually put on the glasses, and the numbers in the docblocks
 * are measured over exactly this list.
 */
const CORPUS = [
  'Hello there',
  'FUNKY GLASSES',
  'jaguar 42%',
  'Wavey, mate!',
  'GLASSES-125B37',
  "it's 3:45 & i'm (still) here",
  'follow me',
  'lost? call me',
  'JOGGLES',
  'happy birthday',
  'all night long',
  'ask me about the glasses',
  'Mind the gap',
  'we are over here',
  'BILLY',
  'no signal',
]

const width = (text: string, f: font.Font) => font.textWidth(text, { font: f })
const total = (f: font.Font) => CORPUS.reduce((n, s) => n + width(s, f), 0)

/** Characters of `text` that fit inside the free 24 columns, in this font. */
function freeChars(text: string, f: font.Font): number {
  let n = 0
  while (n < text.length && width(text.slice(0, n + 1), f) <= FREE_COLUMNS) n++
  return n
}

test('the free line is the panel and nothing more', () => {
  expect(FREE_COLUMNS).toBe(COLS)
  expect(FREE_COLUMNS).toBe(24)
})

// The whole contract of the module: free means no flash, and it is decided by
// the rendered width in *this* font rather than by a number a screen remembers.
test('a scrolling font is free up to the panel width and scrolls one column past it', () => {
  for (const f of FONTS.filter((x) => x.scrolls)) {
    for (const s of [...CORPUS, '', ' ', 'a']) {
      const v = fit(s, f)
      expect(v.columns).toBe(width(s, f))
      expect(v.free).toBe(v.columns <= FREE_COLUMNS)
      expect(v.scrolls).toBe(!v.free)
      expect(v.dropped).toBe('')
      expect(v.usable).toBe(true)
    }
  }
})

// Found by walking a string one character at a time: the boundary is a single
// column, it falls mid-word, and either side of it is a different price.
test('the boundary is exactly one column wide, in every scrolling font', () => {
  for (const f of FONTS.filter((x) => x.scrolls)) {
    let text = ''
    while (fit(text, f).free) text += 'a'
    const over = fit(text, f)
    const under = fit(text.slice(0, -1), f)
    expect(`${f.name} under ${under.free} over ${over.free}`).toBe(`${f.name} under true over false`)
    expect(under.columns).toBeLessThanOrEqual(FREE_COLUMNS)
    expect(over.columns).toBeGreaterThan(FREE_COLUMNS)
    expect(under.scrolls).toBe(false)
    expect(over.scrolls).toBe(true)
  }
})

// The example this repo has quoted since the price boundary was found, now with
// four answers instead of one. It is also the concrete case for the picker: the
// same word is five page erases in one face and free in another.
test('JOGGLES lands on a different side of the line in each face', () => {
  expect(fit('JOGGLE', BAND5).free).toBe(true)
  expect(fit('JOGGLES', BAND5)).toMatchObject({ columns: 27, free: false, scrolls: true })
  expect(fit('JOGGLES', BAND6).free).toBe(false)
  expect(fit('JOGGLES', SLIM5)).toMatchObject({ columns: 24, free: true, scrolls: false })
  // tall7 fits four or five characters and says which ones it could not place.
  expect(fit('JOGGLES', TALL7)).toMatchObject({ scrolls: false, usable: false })
  expect('JOGGLES'.endsWith(fit('JOGGLES', TALL7).dropped)).toBe(true)
})

// A static face has no "wider than the panel" case at all: there is no route
// that scrolls it, so the only question is whether the placement dropped
// anything, and a drop is unusable rather than a save.
test('a static-only font never reports that it scrolls', () => {
  for (const s of [...CORPUS, 'OK', '3:45', '']) {
    const v = fit(s, TALL7)
    expect(v.scrolls).toBe(false)
    expect(v.free).toBe(v.dropped === '')
    expect(v.usable).toBe(v.dropped === '')
  }
  expect(fit('OK', TALL7)).toMatchObject({ free: true, usable: true, dropped: '' })
  expect(fit('', TALL7)).toMatchObject({ free: true, usable: true })
})

test('fitAll answers once per offered font, in the order a picker shows them', () => {
  const all = fitAll('Hello there')
  expect(all.map((v) => v.font.name)).toEqual(FONTS.map((f) => f.name))
  expect(all[0].font).toBe(BAND5)
})

// The condensed face's entire reason to exist, as a property rather than as a
// sentence in a docblock: for letters, digits and spaces it is never the wider
// choice. Punctuation is exempt and deliberately so - slim5 widens `[` and `]`
// to 3 columns because a 2-column bracket is pixel-identical to its own `C`.
test('slim5 is never wider than band5 on letters, digits and spaces', () => {
  const chars = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ']
  for (const a of chars) {
    for (const b of chars) {
      const pair = a + b
      expect(`slim5 "${pair}" ${width(pair, SLIM5) <= width(pair, BAND5)}`).toBe(
        `slim5 "${pair}" true`,
      )
    }
  }
  for (const s of CORPUS) expect(width(s, SLIM5)).toBeLessThanOrEqual(width(s, BAND5))
})

// The numbers the three docblocks quote, held to a band rather than to a digit:
// a glyph may be redrawn, but if either ratio walks out of these bounds the
// prose in band6.ts and slim5.ts has become a lie and should move with it.
test('the corpus measures what the fonts claim: slim5 ~95%, band6 ~122% of band5', () => {
  const base = total(BAND5)
  const slim = total(SLIM5) / base
  const large = total(BAND6) / base
  expect(slim).toBeGreaterThan(0.9)
  expect(slim).toBeLessThan(1)
  expect(large).toBeGreaterThan(1.15)
  expect(large).toBeLessThan(1.3)
})

test('the free line holds one more capital in slim5, and two fewer in band6', () => {
  const caps = 'THE QUICK BROWN FOX'
  const lower = 'the quick brown fox'
  expect(freeChars(caps, SLIM5)).toBe(freeChars(caps, BAND5) + 1)
  expect(freeChars(lower, BAND6)).toBe(freeChars(lower, BAND5) - 2)
})

// What a screen asks when a message has just crossed the line: is there a face
// that would keep this free? The user's own choice wins whenever it qualifies,
// because changing someone's font for a column is worse than a save.
test('bestFree prefers the font already chosen, then the list order', () => {
  expect(bestFree('OK', BAND6)?.font).toBe(BAND6)
  expect(bestFree('OK')?.font).toBe(BAND5)
  // 24 columns in slim5, 27 in band5, 33 in band6: only the narrow one is free.
  expect(bestFree('JOGGLES', BAND5)?.font).toBe(SLIM5)
  expect(bestFree('JOGGLES', BAND6)?.font).toBe(SLIM5)
  // Long enough that every face has to save, including the static one.
  expect(bestFree('ask me about the glasses', BAND5)).toBeNull()
})

test('a font is stored by name and comes back the same object', () => {
  for (const f of FONTS) expect(fontByName(f.name)).toBe(f)
  expect(fontByName('slim5')).toBe(SLIM5)
  expect(fontByName('band6')).toBe(BAND6)
})
