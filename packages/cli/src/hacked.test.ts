/**
 * What has to stay true about the HACKED face, and none of it needs a unit.
 *
 * Two of these are the whole reason the file exists rather than a one-off script.
 * `no treatment lights a dead LED` is the claim the design rests on: the letters
 * are placed by arithmetic off `display.alive()`, so a change to the geometry
 * constants moves them, and this is what notices if the arithmetic stops agreeing
 * with the panel. `refuses a lock it did not take` is the one that protects a
 * physical pair, and it runs against a temporary file so that exercising it can
 * never touch the real `.claude/locks/glasses`.
 */
import { describe, expect, test } from 'bun:test'
import { content, display, motifs } from '@joggles/core'
import {
  GLYPH_COLS,
  LETTERS,
  PER_LENS,
  SOFT,
  TREATMENTS,
  WORD,
  glyph,
  layout,
  levels,
  render,
  soften,
  takeLock,
  treatmentByName,
  upTo,
} from './hacked.js'

const { COLS, MAX_LEVEL, ROWS, alive } = display

const nonEmpty = (bitmap: number[][]): number =>
  bitmap.reduce((n, row) => n + row.filter((v) => v > 0).length, 0)

describe('the six letters', () => {
  test('the face draws exactly the word and nothing else', () => {
    expect([...LETTERS].sort().join('')).toBe([...new Set(WORD)].sort().join(''))
  })

  test('an unknown character is a refusal, not a blank box', () => {
    expect(() => glyph('Z', 6)).toThrow(/no Z/)
  })

  for (const ch of new Set(WORD)) {
    test(`${ch} rescales between five rows and six`, () => {
      for (const height of [5, 6]) {
        const art = glyph(ch, height)
        expect(art.length).toBe(height)
        expect(art.every((row) => row.length === GLYPH_COLS)).toBe(true)
        // Every letter has to reach both the baseline and the cap line, or the word
        // sits at mixed heights and reads as a ransom note.
        expect(art[0].some((v) => v > 0)).toBe(true)
        expect(art[height - 1].some((v) => v > 0)).toBe(true)
        const solid = art.every((row) => row.every((v) => v === 0 || v === MAX_LEVEL))
        expect(solid).toBe(true)
      }
    })
  }

  test('no two letters render the same shape', () => {
    const seen = new Map<string, string>()
    for (const ch of new Set(WORD)) {
      const key = glyph(ch, 6).map((row) => row.join('')).join('/')
      expect(seen.get(key)).toBeUndefined()
      seen.set(key, ch)
    }
  })
})

describe('soften', () => {
  test('only ever adds level 1, and never over a core stroke', () => {
    const before = layout(motifs.BAND_ROWS, motifs.BAND_LOW)
    const after = soften(before)
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (before[r][c] > 0) expect(after[r][c]).toBe(before[r][c])
        else expect(after[r][c] === 0 || after[r][c] === SOFT).toBe(true)
      }
    }
  })

  test('leaves a T junction crisp and softens a staircase corner', () => {
    // H's crossbar meets its stems at a T, which has three lit neighbours and must
    // stay sharp. A's apex is a staircase and is the whole reason grey is here.
    const h = soften(glyph('H', 6))
    expect(nonEmpty(h)).toBe(nonEmpty(glyph('H', 6)))
    const a = soften(glyph('A', 6))
    expect(a[5][0]).toBe(SOFT)
    expect(a[5][2]).toBe(SOFT)
  })
})

describe('the composition', () => {
  test('half the word to a lens, with the break straddling the axis', () => {
    const half = PER_LENS * GLYPH_COLS + (PER_LENS - 1)
    const bitmap = layout(motifs.BAND_ROWS, motifs.BAND_LOW)
    for (let r = 0; r < ROWS; r++) {
      for (const c of [COLS / 2 - 1, COLS / 2]) expect(bitmap[r][c]).toBe(0)
    }
    // The two halves are the same width and sit the same distance from their own
    // edge, which is what makes the panel's axis of symmetry the word's too.
    expect(COLS - half - half).toBe(2)
  })

  test('every stroke stays inside the band that has an LED in every column', () => {
    const bitmap = layout(motifs.BAND_ROWS, motifs.BAND_LOW)
    for (let r = 0; r < ROWS; r++) {
      const inBand = r >= motifs.BAND_LOW && r <= motifs.BAND_HIGH
      if (!inBand) expect(bitmap[r].every((v) => v === 0)).toBe(true)
    }
  })
})

describe('every treatment', () => {
  test('the names are unique and resolve', () => {
    const names = TREATMENTS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(treatmentByName(name)?.name).toBe(name)
    expect(treatmentByName('nope')).toBeNull()
  })

  for (const t of TREATMENTS) {
    test(`${t.name} is a panel-sized frame the live route accepts`, () => {
      const bitmap = t.make()
      expect(bitmap.length).toBe(ROWS)
      expect(content.width(bitmap)).toBe(COLS)
      expect(content.check(content.drawing(bitmap, 'live'))).toEqual([])
    })

    test(`${t.name} lights no dead LED`, () => {
      // The mask belongs at the window, so this is the other half of the promise:
      // nothing is drawn where `viewport` would have to swallow it.
      expect(motifs.hidden(t.make())).toBe(0)
    })

    test(`${t.name} uses only level 0, 1 and 3`, () => {
      // Level 2 is deliberately unused. The panel's own steps are subtle enough
      // (notes/protocol.md) that a third value buys nothing and only makes the
      // composition harder to reason about.
      expect(levels(t.make())[2]).toBe(0)
    })
  }

  test('flat is the one with no grey in it', () => {
    for (const t of TREATMENTS) {
      const grey = content.hasGrey(t.make())
      expect(grey).toBe(t.name !== 'flat')
    }
  })
})

describe('render', () => {
  test('prints the panel, with a blank wherever there is no LED', () => {
    const lines = render(TREATMENTS[0].make()).split('\n')
    expect(lines.length).toBe(ROWS)
    expect(lines.every((line) => line.length === COLS)).toBe(true)
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        // Top row first, so the line index counts down from the top of the panel.
        expect(lines[ROWS - 1 - r][c] === ' ').toBe(!alive(r, c))
      }
    }
  })
})

describe('the reveal', () => {
  test('brings the letters in one at a time and ends on the whole word', () => {
    const bitmap = TREATMENTS[0].make()
    let previous = -1
    for (let n = 1; n <= WORD.length; n++) {
      const lit = upTo(bitmap, n).px.reduce(
        (acc, row) => acc + [...row].filter((v) => v > 0).length,
        0,
      )
      expect(lit).toBeGreaterThan(previous)
      previous = lit
    }
    expect(upTo(bitmap, WORD.length).equals(content.toGrid(bitmap))).toBe(true)
  })
})

describe('the glasses lock', () => {
  const tmp = (): string =>
    `${import.meta.dir}/.hacked-lock-test-${Math.random().toString(36).slice(2)}`

  test('refuses a lock it did not take', async () => {
    const path = tmp()
    await Bun.write(path, 'somebody else\n')
    try {
      const held = takeLock(false, path, () => {})
      await expect(held).rejects.toThrow(/locked by someone else/)
    } finally {
      await Bun.file(path).delete()
    }
  })

  test('proceeds on --lock-is-mine and leaves the holder their file', async () => {
    const path = tmp()
    await Bun.write(path, 'me\n')
    try {
      const release = await takeLock(true, path, () => {})
      await release()
      expect(await Bun.file(path).exists()).toBe(true)
    } finally {
      await Bun.file(path).delete()
    }
  })

  test('takes a free lock and gives it back', async () => {
    const path = tmp()
    const release = await takeLock(false, path, () => {})
    expect(await Bun.file(path).exists()).toBe(true)
    await release()
    expect(await Bun.file(path).exists()).toBe(false)
  })
})
