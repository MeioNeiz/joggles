/**
 * The catalogue against the registry it describes, and against the generators it tunes.
 *
 * Two failures this is here to catch, both silent on a handset:
 *
 *   - **a generator added to `effects.ts` and not to the catalogue**, which would appear
 *     on the screen with no description and no knobs, or not appear at all. Walked from
 *     `EFFECT_NAMES` in both directions rather than from a list here
 *   - **a knob whose key is not an option the generator reads.** `render` ignores unknown
 *     keys, so the button highlights and the picture does not move. Nothing at runtime
 *     would say so
 */
import { effects as fx } from '@joggles/core'
import { expect, test } from 'bun:test'
import { AUTO, CATALOGUE, defaultsFor, specFor, tuning } from './catalogue.js'
import { LEVELS } from './plan.js'

/** The width every render below uses. Wide enough to be a loop, cheap enough to repeat. */
const COLUMNS = 240

const shot = (name: string, opts: Record<string, unknown>): string =>
  JSON.stringify(fx.EFFECTS[name]({ columns: COLUMNS, levels: LEVELS, ...opts } as never))

test('the catalogue and the registry describe the same set of effects', () => {
  expect(CATALOGUE.map((s) => s.name).sort()).toEqual([...fx.EFFECT_NAMES].sort())
})

test('every knob opens on one of its own values, and its labels line up', () => {
  for (const spec of CATALOGUE) {
    for (const knob of spec.knobs) {
      expect(knob.values, `${spec.name}.${knob.key} offers nothing`).not.toHaveLength(0)
      expect(
        knob.values,
        `${spec.name}.${knob.key} opens on ${String(knob.start)}, which it does not offer`,
      ).toContain(knob.start)
      if (knob.labels) expect(knob.labels).toHaveLength(knob.values.length)
    }
  }
})

test('no two knobs on one effect share a key', () => {
  for (const spec of CATALOGUE) {
    const keys = spec.knobs.map((k) => k.key)
    expect(new Set(keys).size, `${spec.name} repeats a knob key`).toBe(keys.length)
  }
})

/**
 * The one with teeth: a knob has to reach the generator.
 *
 * "At least one other value renders differently" rather than "the next value does",
 * because that is the actual property. A key the generator never reads renders the
 * same bitmap at every value it offers, and that is what fails here.
 */
test('every knob is an option its generator actually reads', () => {
  for (const spec of CATALOGUE) {
    const base = tuning(defaultsFor(spec.name))
    const opening = shot(spec.name, { ...base, dither: spec.dither })
    for (const knob of spec.knobs) {
      const moved = knob.values
        .filter((v) => v !== knob.start)
        .map((v) => shot(spec.name, { ...tuning({ ...base, [knob.key]: v }), dither: spec.dither }))
      expect(
        moved.some((s) => s !== opening),
        `${spec.name}.${knob.key} renders the same bitmap at every value: `
          + 'the generator does not read that option',
      ).toBe(true)
    }
  }
})

test('mirror reflects the other effects and never itself', () => {
  const inner = CATALOGUE.find((s) => s.name === 'mirror')?.knobs.find((k) => k.key === 'inner')
  expect(inner?.values).toEqual(fx.EFFECT_NAMES.filter((n) => n !== 'mirror'))
  // The reason the list is filtered: the generator refuses, and a button that throws is
  // worse than a button that is absent.
  expect(() => fx.mirror({ inner: 'mirror' })).toThrow('mirror cannot mirror itself')
})

/**
 * The two effects whose own default this screen must not contradict.
 *
 * `starfield` and `mirror` default to `'none'` for reasons in their docblocks - ordered
 * dither turns isolated stars off, and its column-tied thresholds cannot be mirrored -
 * and a screen that opened them on `'ordered'` would be showing something the generator
 * has already ruled out.
 */
test("starfield and mirror open on the generator's own dither", () => {
  for (const name of ['starfield', 'mirror']) {
    const spec = specFor(name)
    expect(spec.dither).toBe('none')
    // Rendered with no dither option at all is the generator's own answer.
    expect(shot(name, { ...tuning(defaultsFor(name)), dither: spec.dither })).toBe(
      shot(name, tuning(defaultsFor(name))),
    )
  }
})

/**
 * `fire` is the one that deliberately disagrees, and this is the measurement.
 *
 * `effects.ts` records that two levels plus ordered dither puts 93 dark cells below the
 * flame tip across 240 columns. Counting cells that are dark with a lit cell above them
 * in the same column reproduces exactly that figure, so the catalogue's `'none'` rests on
 * a number rather than on taste. At four levels the same count is small, which is why
 * the generator's own default is the other way round.
 */
test('fire opens flat because ordered dither at two levels eats the silhouette', () => {
  const spec = specFor('fire')
  expect(spec.dither).toBe('none')

  const holes = (bitmap: number[][]): number => {
    let n = 0
    for (let col = 0; col < COLUMNS; col++) {
      let top = -1
      for (let row = bitmap.length - 1; row >= 0; row--) {
        if (bitmap[row][col] > 0) {
          top = row
          break
        }
      }
      for (let row = 0; row < top; row++) if (bitmap[row][col] === 0) n++
    }
    return n
  }
  const at = (levels: 2 | 4, dither: 'ordered' | 'none') =>
    holes(fx.fire({ columns: COLUMNS, levels, dither }))

  expect(at(2, 'ordered')).toBe(93)
  expect(at(2, 'none')).toBe(0)
  expect(at(4, 'ordered')).toBeLessThan(10)
})

test('every effect carrying a caveat has something to say in it', () => {
  for (const spec of CATALOGUE) {
    expect(spec.about.length, `${spec.name} has no description`).toBeGreaterThan(10)
    if (spec.caveat !== null) expect(spec.caveat.length).toBeGreaterThan(30)
  }
})

test('specFor refuses a name off Object.prototype rather than handing back a function', () => {
  // The registry reason, one layer up: every name here arrives from a tap or from stored
  // state, and a plain object would answer `constructor` with something truthy.
  expect(() => specFor('constructor')).toThrow('no effect called constructor')
  expect(() => specFor('toString')).toThrow('One of: plasma')
})

test('AUTO is dropped by tuning and everything else survives it', () => {
  expect(tuning({ folds: AUTO, inner: 'wave', cycles: 3, soft: false })).toEqual({
    inner: 'wave',
    cycles: 3,
    soft: false,
  })
  // False and zero are values, not absences: filtering on truthiness would lose both,
  // and `stripes` opens on `soft: false`.
  expect(tuning({ soft: false, lean: 0 })).toEqual({ soft: false, lean: 0 })
})

test('defaultsFor covers every knob the effect offers', () => {
  for (const spec of CATALOGUE) {
    expect(Object.keys(defaultsFor(spec.name)).sort()).toEqual(spec.knobs.map((k) => k.key).sort())
  }
  expect(() => defaultsFor('nope')).toThrow('no effect called nope')
})

/**
 * The identity, not the values, and it is load-bearing rather than an optimisation.
 *
 * The screen feeds this bag into the memo that renders the loop, and `Preview` restarts
 * its clock whenever the bitmap it is handed is a new object. A fresh bag per call means a
 * fresh bitmap on every render, so the preview would snap back to column 0 whenever
 * anything else on the screen changed - a status line, a ledger read.
 */
test('defaultsFor hands back one shared frozen bag per effect', () => {
  for (const spec of CATALOGUE) {
    expect(defaultsFor(spec.name)).toBe(defaultsFor(spec.name))
    expect(Object.isFrozen(defaultsFor(spec.name)), spec.name).toBe(true)
  }
  // Two effects must not share one bag, or tuning one would move the other.
  expect(defaultsFor('plasma')).not.toBe(defaultsFor('wave'))
})
