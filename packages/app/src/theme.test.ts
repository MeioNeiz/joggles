/**
 * The palette's own invariants, plus a source crawl over the three grids that draw
 * panel pixels.
 *
 * `theme.ts` imports only `react`, so the palette itself is testable here; what a
 * screen renders is not, which is why the second half reads source. The property it
 * holds is the one the 2026-08-12 ask created ("theme colour should be preview colour
 * as well"): before it, the three grids each wrote out the same three greens, and a
 * pair themed amber stayed green in the preview, the draw pad and every thumbnail. A
 * grid that names a lit colour of its own is that defect coming back.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DEFAULT_THEME, THEMES, themeById } from './theme.js'

const HERE = dirname(new URL(import.meta.url).pathname)

/** Comments stripped, so a hex quoted in a docblock cannot fail a code assertion. */
const code = (rel: string): string =>
  readFileSync(resolve(HERE, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

/** Every grid that paints a device pixel at some size of its own. */
const GRIDS = ['Preview.tsx', 'draw/Pad.tsx', 'screens/Library.tsx']

const LEVEL_HEXES = THEMES.flatMap((t) => t.levels).map((h) => h.toLowerCase())

test('every entry is a full family of hexes', () => {
  for (const t of THEMES) {
    for (const colour of [t.accent, t.dim, t.fill, ...t.levels]) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(t.levels).toHaveLength(3)
    expect(t.id).not.toBe('')
    expect(t.label).not.toBe('')
  }
})

test('ids are unique, and green stays the default a stored null means', () => {
  expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length)
  expect(DEFAULT_THEME.id).toBe('green')
  expect(themeById(null)).toBe(DEFAULT_THEME)
  expect(themeById('no such theme')).toBe(DEFAULT_THEME)
})

test('level 3 is the accent, so a full pixel and a chip are one colour', () => {
  for (const t of THEMES) expect(t.levels[2]).toBe(t.accent)
})

test('the three levels are separable from each other and from an unlit pixel', () => {
  for (const t of THEMES) {
    expect(new Set(t.levels).size).toBe(3)
    // The unlit pixels the grids own: #1e1e1e, #191919 and the fringe's #141414.
    for (const level of t.levels) expect(['#1e1e1e', '#191919', '#141414']).not.toContain(level)
  }
})

test('no grid names a lit colour of its own: all three read the palette', () => {
  for (const grid of GRIDS) {
    const src = code(grid)
    for (const hex of LEVEL_HEXES) expect(src.toLowerCase()).not.toContain(hex)
    expect(src).toMatch(/\.levels\b/)
    expect(src).toMatch(/from '\.{1,2}(\/\.\.)?\/theme\.js'/)
  }
})
