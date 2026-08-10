/**
 * What these assert, and why in this order.
 *
 * The property the whole module exists for is "the loop closes", and it is
 * established three ways rather than one, because each way alone is weak:
 *
 *   1. structurally, that a fractional cycle count is unreachable through any
 *      generator's parameters, so no caller can build an open loop
 *   2. structurally, that the dither phase is periodic with the width
 *   3. empirically, `seam()` over the whole registry, with two known-broken
 *      fields to prove the measurement has teeth
 *
 * Point 3 on its own would be the trap this repo keeps falling into: a metric
 * that passes everything, asserted as if it had checked something.
 */
import { expect, test } from 'bun:test'
import * as content from './content.js'
import * as dats from './dats.js'
import { MAX_LEVEL, ROWS, alive } from './display.js'
import * as fx from './effects.js'
import * as viewport from './viewport.js'

const WIDTHS = [64, 240, 736]
const LEVELS = [2, 4] as const

test('the registry is not empty and every entry has both halves', () => {
  // Guards every table-driven test below: an empty registry would make them vacuous.
  expect(fx.EFFECT_NAMES.length).toBeGreaterThanOrEqual(5)
  expect(fx.EFFECT_NAMES).toContain('plasma')
  expect(fx.EFFECT_NAMES).toContain('fire')
  expect(fx.EFFECT_NAMES).toContain('mirror')
  expect(Object.keys(fx.FIELDS)).toEqual(fx.EFFECT_NAMES)
  for (const name of fx.EFFECT_NAMES) {
    expect(typeof fx.EFFECTS[name]).toBe('function')
    expect(typeof fx.FIELDS[name]).toBe('function')
  }
})

test('every shipped field closes, at every width', () => {
  // The strong form of the property, measured before quantising throws the
  // evidence away. seam() below is the weak form and cannot replace this.
  for (const name of fx.EFFECT_NAMES) {
    for (const columns of WIDTHS) {
      const gap = fx.fieldGap(fx.FIELDS[name]({ columns }), { columns })
      expect(`${name} at ${columns}: ${gap < 1e-9}`).toBe(`${name} at ${columns}: true`)
    }
  }
})

test('fieldGap catches the two faults seam() reports clean', () => {
  // Both of these were found by probing seam() rather than by reading it, and
  // both are the reason fieldGap exists. Without this test the module would
  // still claim a guarantee it does not have.
  const columns = 240

  // 1. A field written against `col` with a period that does not divide the
  //    width: 100 into 240 is 2.4 cycles, plainly open, and seam() passes it
  //    because quantising put both ends of the join in the same level.
  const byColumn: fx.Field = ({ col }) => 0.5 + 0.5 * Math.sin((2 * Math.PI * col) / 100)
  expect(fx.seam(fx.render(byColumn, { columns, dither: 'none' })).seamless).toBe(true)
  expect(fx.fieldGap(byColumn, { columns })).toBeGreaterThan(0.1)

  // 2. A fold: half a cycle out returns to the same value travelling the other
  //    way, so it closes on value and reverses on slope.
  const fold: fx.Field = ({ u }) => 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.5 * u)
  expect(fx.seam(fx.render(fold, { columns, dither: 'none' })).seamless).toBe(true)
  expect(fx.fieldGap(fold, { columns })).toBeGreaterThan(0.05)

  // And it does not cry wolf on a whole number of cycles.
  const closed: fx.Field = ({ u }) => 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * u)
  expect(fx.fieldGap(closed, { columns })).toBeLessThan(1e-9)
})

test('every effect closes on itself, at every width and both level counts', () => {
  for (const name of fx.EFFECT_NAMES) {
    for (const columns of WIDTHS) {
      for (const levels of LEVELS) {
        const s = fx.seam(fx.EFFECTS[name]({ columns, levels }))
        const where = `${name} at ${columns}x${levels}`
        expect(`${where} wrap ${s.wrap.toFixed(3)} vs worst ${s.worst.toFixed(3)}`).toBe(
          `${where} wrap ${Math.min(s.wrap, s.worst).toFixed(3)} vs worst ` +
            `${s.worst.toFixed(3)}`,
        )
      }
    }
  }
})

test('seam() fails a loop that genuinely does not close', () => {
  // A ramp is the honest worst case: continuous everywhere inside, one full-scale
  // step at the join. Without this the test above proves nothing.
  const ramp = fx.render(({ u }) => u, { columns: 64 })
  const s = fx.seam(ramp)
  expect(s.seamless).toBe(false)
  expect(s.wrap).toBeGreaterThan(s.worst)

  // And a field written with a fractional cycle count, which is the mistake a
  // generator would actually make.
  const open = fx.render(({ u }) => 0.5 + 0.5 * Math.sin(2 * Math.PI * 2.3 * u), {
    columns: 64,
  })
  expect(fx.seam(open).seamless).toBe(false)
})

test('a fractional cycle count is unreachable through any generator', () => {
  // This, not seam(), is what actually guarantees the field closes: seam() reports
  // a half-cycle fold as clean, so rounding at the door is the real defence.
  const same = (a: content.Bitmap, b: content.Bitmap) =>
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  same(fx.plasma({ cycles: 3.4, columns: 64 }), fx.plasma({ cycles: 3, columns: 64 }))
  same(fx.stripes({ cycles: 11.6, columns: 64 }), fx.stripes({ cycles: 12, columns: 64 }))
  same(fx.wave({ harmonic: 7.5, columns: 64 }), fx.wave({ harmonic: 8, columns: 64 }))
  same(fx.ripple({ sources: 2.6, columns: 64 }), fx.ripple({ sources: 3, columns: 64 }))
  same(fx.mirror({ folds: 4.7, columns: 64 }), fx.mirror({ folds: 5, columns: 64 }))
  // fire's cycle count is derived, columns over tongue, and rounds the same way:
  // 64 over 12 and over 12.8 are both 5 whole cycles.
  same(fx.fire({ tongue: 12, columns: 64 }), fx.fire({ tongue: 12.8, columns: 64 }))

  // Zero and negative cycle counts would divide the loop into nothing.
  expect(fx.seam(fx.plasma({ cycles: 0, columns: 64 })).seamless).toBe(true)
  expect(fx.seam(fx.stripes({ cycles: -4, columns: 64 })).seamless).toBe(true)
})

test('the dither tile repeats every TILE columns, so a snapped width continues it', () => {
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < 40; col++) {
      expect(fx.threshold(row, col + fx.TILE)).toBe(fx.threshold(row, col))
    }
  }
  // Every threshold is inside the interval, or quantise would clip a level away.
  const all = []
  for (let r = 0; r < fx.TILE; r++) {
    for (let c = 0; c < fx.TILE; c++) all.push(fx.threshold(r, c))
  }
  expect(Math.min(...all)).toBeGreaterThan(0)
  expect(Math.max(...all)).toBeLessThan(1)
  expect(new Set(all).size).toBe(fx.TILE * fx.TILE)
})

test('a field that returns nothing usable draws nothing, rather than NaN levels', () => {
  // NaN survives Math.min(Math.max(...)) untouched, so before this it reached the
  // bitmap and surfaced two files away as content.check's "levels must be
  // integers", which points at neither the field nor the parameter that did it.
  // Dark rather than lit, and Infinity goes the same way as NaN: that is what
  // content.normalise already does with a non-finite level, and a runaway that
  // lights the whole panel is the worse of the two failures to point at a crowd.
  expect(new Set(fx.render(() => NaN, { columns: 8 }).flat())).toEqual(new Set([0]))
  expect(new Set(fx.render(() => Infinity, { columns: 8 }).flat())).toEqual(new Set([0]))
  expect(new Set(fx.wave({ columns: 8, thickness: NaN }).flat())).toEqual(new Set([0]))
  expect(new Set(fx.plasma({ columns: 8, rise: NaN }).flat())).toEqual(new Set([0]))
})

test('a width that is not a number is refused where it is readable', () => {
  // It used to reach blank() as an array length and fail with a message about
  // safe magnitudes, naming neither the option nor the caller.
  for (const bad of [NaN, Infinity, -Infinity]) {
    expect(() => fx.seamlessWidth(bad)).toThrow(/columns must be a number/)
    expect(() => fx.wave({ columns: bad })).toThrow(/columns must be a number/)
  }
})

test('an explicit undefined option means that effect default, not render default', () => {
  // `{ dither: 'none', ...opts }` lets an explicit undefined overwrite the
  // default with nothing, and starfield then dithers when it should not.
  expect(fx.starfield({ columns: 64, dither: undefined })).toEqual(
    fx.starfield({ columns: 64 }),
  )
  expect(fx.starfield({ columns: 64, dither: 'ordered' })).not.toEqual(
    fx.starfield({ columns: 64 }),
  )
})

test('seam() on a ragged bitmap reports numbers, not NaN', () => {
  // seam is exported, so it will meet bitmaps render did not produce. NaN
  // compares false against everything and comes back as `seamless: false` with
  // no number that explains why.
  const ragged = [[1, 2, 3], [1], [1], [1], [1], [1], [1], [1], [1]]
  const s = fx.seam(ragged)
  for (const v of [s.wrap, s.worst, s.mean]) expect(Number.isFinite(v)).toBe(true)
  expect(fx.seam([]).seamless).toBe(true)
  expect(fx.seam([[3]]).seamless).toBe(true)
})

test('every width a caller can reach is a whole number of tiles', () => {
  for (const asked of [0, -3, 1, 7, 8, 9, 100, 239, 240, 736, 740, 9999]) {
    const got = fx.seamlessWidth(asked)
    expect(got % fx.TILE).toBe(0)
    expect(got).toBeGreaterThanOrEqual(fx.TILE)
    expect(got).toBeLessThanOrEqual(fx.MAX_COLUMNS)
    if (asked >= fx.TILE && asked <= fx.MAX_COLUMNS) expect(got).toBeLessThanOrEqual(asked)
  }
  expect(fx.seamlessWidth(740)).toBe(736)
  expect(fx.seamlessWidth(9999)).toBe(fx.MAX_COLUMNS)
})

test('the ceiling is the type 1 ceiling, rounded down to a tile', () => {
  expect(fx.MAX_COLUMNS).toBe(736)
  expect(fx.MAX_COLUMNS).toBeLessThanOrEqual(content.maxColumns(dats.TYPE_TEXT))
  // The widest loop still has to survive content.check on the saved route.
  const widest = {
    bitmap: fx.stripes({ columns: fx.MAX_COLUMNS, levels: 2 }),
    route: 'saved' as const,
    motion: { kind: 'scroll' as const, dir: 0 as const, speed: 50 },
  }
  expect(content.check(widest)).toEqual([])
})

test('render produces exactly what the content model expects', () => {
  for (const name of fx.EFFECT_NAMES) {
    const bitmap = fx.EFFECTS[name]({ columns: 240 })
    expect(bitmap.length).toBe(ROWS)
    expect(content.width(bitmap)).toBe(240)
    for (const row of bitmap) {
      expect(row.length).toBe(240)
      for (const v of row) {
        expect(Number.isInteger(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(MAX_LEVEL)
      }
    }
  }
})

test('levels: 2 is monochrome, which is the only thing a wide save can be', () => {
  // The whole point: one grey pixel sends savedType to type 2, which shows 24
  // columns and forgets them at power off. A wide loop must not have one.
  for (const name of fx.EFFECT_NAMES) {
    const bitmap = fx.EFFECTS[name]({ columns: 240, levels: 2 })
    expect(content.hasGrey(bitmap)).toBe(false)
    expect(new Set(bitmap.flat()).size).toBeLessThanOrEqual(2)
    const saved = { bitmap, route: 'saved' as const, motion: { kind: 'static' as const } }
    expect(content.savedType(saved)).toBe(dats.TYPE_TEXT)
    expect(content.encodeSaved(saved).flattened).toBe(false)
  }
})

test('a level count that does not divide MAX_LEVEL is refused, not rounded', () => {
  // The CLI passes whatever was typed. 3 would put 1.5 in the bitmap, which reads
  // as a level and is not one.
  for (const levels of [3, 5, 0, 1]) {
    expect(() => fx.render(() => 0.5, { columns: 8, levels: levels as 2 | 4 })).toThrow(
      /levels must be 2 or 4/,
    )
  }
})

test('levels: 4 actually uses the intermediate levels', () => {
  // Otherwise "dithered to the 4 levels" would be a claim no test had checked.
  for (const name of fx.EFFECT_NAMES) {
    const bitmap = fx.EFFECTS[name]({ columns: 240, levels: 4 })
    const seen = new Set(bitmap.flat())
    expect(`${name}: ${[...seen].sort().join('')}`).toBe(`${name}: 0123`)
    expect(content.hasGrey(bitmap)).toBe(true)
  }
})

test('ordered dither shades a flat field, plain quantising does not', () => {
  // The difference between the two modes, stated as the thing you would see: a
  // field halfway between two levels comes out mixed under dither and uniform
  // without it.
  const flat = () => 1 / 6 // exactly halfway between level 0 and level 1
  const dithered = new Set(fx.render(flat, { columns: 64, dither: 'ordered' }).flat())
  const plain = new Set(fx.render(flat, { columns: 64, dither: 'none' }).flat())
  expect([...dithered].sort()).toEqual([0, 1])
  expect(plain.size).toBe(1)
})

test('generators are pure: same options, same pixels', () => {
  for (const name of fx.EFFECT_NAMES) {
    const a = fx.EFFECTS[name]({ columns: 64 })
    const b = fx.EFFECTS[name]({ columns: 64 })
    expect(a).toEqual(b)
  }
})

test('starfield density is honoured and its seed changes the field', () => {
  const lit = (b: content.Bitmap) => b.flat().filter((v) => v > 0).length
  const sparse = fx.starfield({ columns: 240, density: 0.02 })
  const dense = fx.starfield({ columns: 240, density: 0.4 })
  expect(lit(sparse)).toBeLessThan(lit(dense))
  expect(lit(fx.starfield({ columns: 240, density: 0 }))).toBe(0)
  expect(lit(fx.starfield({ columns: 240, density: 1 }))).toBe(ROWS * 240)
  expect(fx.starfield({ columns: 64, seed: 1 })).not.toEqual(
    fx.starfield({ columns: 64, seed: 2 }),
  )
})

test('a loop long enough to leave running is within reach of the ceiling', () => {
  // The feature is "upload once, radio off all night", and 40 to 60 seconds is the
  // figure notes/what-to-build.md quotes. Worth failing if the ceiling ever moves.
  const { slowest, fastest } = fx.loopSeconds(fx.MAX_COLUMNS)
  expect(fastest).toBeGreaterThan(50)
  expect(slowest).toBeGreaterThan(fastest)
  expect(fx.loopSeconds(fx.DEFAULT_COLUMNS).fastest).toBeGreaterThan(15)
})

test('effects leave the dead pixels to the window, and the window wraps the loop', () => {
  // Effects deliberately do not mask. viewport does, at the window, because the
  // holes stay put while the picture travels past them. If that ever swapped
  // over, a hole would travel with the picture instead.
  const full = fx.render(() => 1, { columns: 64 })
  expect(full[8].slice(9, 15).every((v) => v === MAX_LEVEL)).toBe(true)
  expect(viewport.windowAt(full, 0)[8].slice(9, 15).every((v) => v === 0)).toBe(true)

  // The join, seen the way the panel sees it: the last frame of a pass holds the
  // loop's end and its start side by side, with no gap between them.
  const loop = fx.stripes({ columns: 64, levels: 2, soft: false })
  const last = viewport.windowAt(loop, 63, { wrap: true })
  for (let r = 0; r < ROWS; r++) {
    if (!alive(r, 0) || !alive(r, 1)) continue
    expect(last[r][0]).toBe(loop[r][63])
    expect(last[r][1]).toBe(loop[r][0])
  }
  expect(viewport.frames(loop, { kind: 'scroll', dir: 0 }).length).toBe(64)
})

test('mirror closes a field that cannot close on its own', () => {
  // The wrapper's defining property: reflection replaces wrapping, so travelling
  // out and back arrives where it started whatever the inner does. This is the
  // same col-indexed sine fieldGap exists to catch, made seamless by folding.
  const open: fx.Field = ({ col }) => 0.5 + 0.5 * Math.sin((2 * Math.PI * col) / 100)
  expect(fx.fieldGap(open, { columns: 240 })).toBeGreaterThan(0.1)
  expect(fx.fieldGap(fx.mirrorField({ inner: open }), { columns: 240 })).toBeLessThan(1e-9)
})

test('mirror output is pixel-symmetric about every axis, which is the kaleidoscope', () => {
  // 64 columns and folds that divide it, so every position the axes imply is an
  // exact binary fraction and symmetry can be equality rather than tolerance.
  // dither: none, because the Bayer thresholds are position-tied and shade the
  // two sides of an axis differently on purpose.
  for (const folds of [1, 2]) {
    const bmp = fx.mirror({ columns: 64, folds, dither: 'none' })
    for (let k = 0; k <= 2 * folds; k++) {
      const axis = (k * 64) / (2 * folds)
      for (let d = 1; d < 8; d++) {
        const a = (((axis + d) % 64) + 64) % 64
        const b = (((axis - d) % 64) + 64) % 64
        for (let r = 0; r < ROWS; r++) expect(bmp[r][a]).toBe(bmp[r][b])
      }
    }
  }
})

test('the default mirror keeps an axis on screen, and folds is the variety trade', () => {
  // Axes sit every half-segment, so the default segment of two panel widths puts
  // one axis on the 24-column window at all times. The price, pinned here so it
  // is a stated property rather than a surprise: everything depends on u only
  // through the folded position, so the loop repeats every segment.
  expect(fx.mirror({ columns: 240 })).toEqual(fx.mirror({ columns: 240, folds: 5 }))
  const f = fx.mirrorField({ folds: 5 })
  const at = (col: number, row: number): number =>
    f({ u: col / 240, v: row / (ROWS - 1), col, row, columns: 240 })
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col + 48 < 240; col += 7) {
      expect(Math.abs(at(col, row) - at(col + 48, row))).toBeLessThan(1e-12)
    }
  }
})

test('mirror reaches a named inner, and refuses the two names that cannot work', () => {
  // The options bag flows through to the inner, so the inner's own parameters
  // keep working under the wrapper. Unnamed, the inner is a one-cycle plasma.
  expect(fx.mirror({ columns: 64 })).toEqual(
    fx.mirror({ columns: 64, inner: 'plasma', cycles: 1 }),
  )
  expect(fx.mirror({ columns: 64, inner: 'stripes' })).not.toEqual(
    fx.mirror({ columns: 64 }),
  )
  expect(fx.mirror({ columns: 64, inner: 'stripes', cycles: 3 })).not.toEqual(
    fx.mirror({ columns: 64, inner: 'stripes', cycles: 9 }),
  )
  // Mirroring mirror would resolve itself forever, and a typo should say what
  // the registry holds rather than quietly falling back to plasma.
  expect(() => fx.mirrorField({ inner: 'mirror' })).toThrow(/itself/)
  expect(() => fx.mirrorField({ inner: 'lava' })).toThrow(/no field called lava/)
})

test('fire rises from the bottom: full base, dark top, thinning in between', () => {
  const bmp = fx.fire({ columns: 240 })
  expect(new Set(bmp[0])).toEqual(new Set([MAX_LEVEL]))
  expect(new Set(bmp[ROWS - 1])).toEqual(new Set([0]))
  // Shape asserted on the raw field, because dither noise can tie adjacent rows
  // in the bitmap: brightness never grows with height, and clearly falls.
  const f = fx.fireField()
  const mean = (row: number): number => {
    let sum = 0
    for (let col = 0; col < 240; col++) {
      sum += f({ u: col / 240, v: row / (ROWS - 1), col, row, columns: 240 })
    }
    return sum / 240
  }
  expect(mean(0)).toBe(1)
  for (let row = 1; row < ROWS; row++) expect(mean(row)).toBeLessThanOrEqual(mean(row - 1))
  expect(mean(4)).toBeLessThan(mean(0))
})

test('fire closes whatever it is leaning by, and the lean is really in the picture', () => {
  // lean shifts each row's profile by a constant, which cannot open a loop that
  // whole cycle counts close; it is diagonal structure, so it must change pixels.
  for (const opts of [{}, { lean: 7.3, tongue: 9.5 }, { lean: -4, height: 0.9 }]) {
    expect(fx.fieldGap(fx.fireField(opts), { columns: 240 })).toBeLessThan(1e-9)
  }
  expect(fx.fire({ columns: 64, lean: 0 })).not.toEqual(fx.fire({ columns: 64, lean: 4 }))
})
