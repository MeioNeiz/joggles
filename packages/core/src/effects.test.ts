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
import { COLS, MAX_LEVEL, ROWS, alive } from './display.js'
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
  //
  // The axes sit half a column off the segment boundaries, in the gaps between
  // columns: that is what lets one land on the nose bridge, which is a gap and
  // not a column. So the pairs either side of an axis are whole columns.
  const wrap = (col: number) => ((col % 64) + 64) % 64
  for (const folds of [1, 2]) {
    const bmp = fx.mirror({ columns: 64, folds, dither: 'none' })
    for (let k = 0; k <= 2 * folds; k++) {
      const axis = (k * 64) / (2 * folds) - 0.5
      for (let d = 0; d < 8; d++) {
        const a = wrap(axis - d - 0.5)
        const b = wrap(axis + d + 0.5)
        for (let r = 0; r < ROWS; r++) expect(bmp[r][a]).toBe(bmp[r][b])
      }
    }
  }
})

/**
 * Live mirror-pair mismatches in the 24-column window at one scroll offset.
 *
 * The panel is the arbiter here, not the loop: `windowAt` has already blanked
 * the dead LEDs, and the dead map is itself symmetric about the bridge (rows 0
 * and 8 dead 9 to 14, row 1 dead 10 to 13), so column c against column 23 - c
 * over the whole window is exactly "do the two lenses show mirror images".
 */
const bridgeMismatch = (bitmap: content.Bitmap, off: number): number => {
  const win = viewport.windowAt(bitmap, off, { wrap: true })
  let bad = 0
  for (let c = 0; c < COLS / 2; c++) {
    for (let r = 0; r < ROWS; r++) if (win[r][c] !== win[r][COLS - 1 - c]) bad++
  }
  return bad
}

/** Every scroll offset at which the two lenses are exact mirrors. */
const mirrorOffsets = (bitmap: content.Bitmap): number[] => {
  const out: number[] = []
  for (let off = 0; off < content.width(bitmap); off++) {
    if (bridgeMismatch(bitmap, off) === 0) out.push(off)
  }
  return out
}

test('mirror lands an exact reflection on the nose bridge, at every width', () => {
  // The property the effect exists for, and the one the axis test above cannot
  // see: symmetry about the *loop's* axes says nothing about whether any of them
  // ever coincides with the *panel's* own axis, which is the half-column gap
  // between columns 11 and 12. Folding on whole columns passes the test above
  // and never mirrors the lenses: 22 of 100 live pairs differ at the kindest
  // offset, 71 at the worst width.
  for (const columns of [8, 64, 240, 736]) {
    const bmp = fx.mirror({ columns })
    const offs = mirrorOffsets(bmp)
    expect(`${columns}: ${offs.length > 0}`).toBe(`${columns}: true`)
    // And not because the window is blank or flat, which would make equality
    // free. Three levels of a plasma, reflected.
    const win = viewport.windowAt(bmp, offs[0], { wrap: true })
    expect(new Set(win.flat()).size).toBeGreaterThan(2)
  }

  // Teeth. Nothing unfolded should ever have such an offset, or the measurement
  // above proves nothing. ripple is left out on purpose: its rings are radially
  // symmetric about each source column, so it genuinely does mirror at 90 of the
  // 240 offsets without any help from this wrapper.
  for (const name of ['plasma', 'stripes', 'wave', 'starfield', 'fire']) {
    const bmp = fx.EFFECTS[name]({ columns: 240, dither: 'none' })
    expect(`${name}: ${mirrorOffsets(bmp).length}`).toBe(`${name}: 0`)
  }
})

test('the reflection comes back round, rather than happening twice a pass', () => {
  // The half-column shift alone lands one exact reflection at any width; it is
  // the fold snap that makes it recur. Unsnapped, 736 columns over 15 folds puts
  // the axes 24.53 columns apart and only 2 of the 736 offsets reflect, which at
  // the device's scroll rate is once every 30 to 97 seconds: not a kaleidoscope.
  expect(fx.mirrorFolds(736)).toBe(16)
  expect(fx.mirrorFolds(240)).toBe(5)
  expect(736 % fx.mirrorFolds(736)).toBe(0)
  for (const columns of [64, 240, 736]) {
    const offs = mirrorOffsets(fx.mirror({ columns }))
    let worst = columns - offs[offs.length - 1] + offs[0]
    for (let i = 1; i < offs.length; i++) worst = Math.max(worst, offs[i] - offs[i - 1])
    // 89 columns is the worst any reachable width does (712, whose divisors all
    // sit far from the folds it asks for). 24 seconds at the slowest SPEED.
    expect(`${columns}: ${worst <= 89}`).toBe(`${columns}: true`)
    expect(worst / fx.SLOWEST_SCROLL).toBeLessThan(24)
  }
  // An asked-for count is snapped to a divisor, the way cycles are rounded and
  // widths snapped to a tile: near what you asked for, and it closes.
  expect(fx.mirrorFolds(240, 7)).toBe(6)
  expect(fx.mirrorFolds(240, 1)).toBe(1)
  const asked = { columns: 240, folds: 7 }
  expect(fx.mirror(asked)).toEqual(fx.mirror({ columns: 240, folds: 6 }))
})

test('mirror does not dither by default, because ordered dither cannot mirror', () => {
  // The Bayer threshold is a function of the panel column and is not symmetric
  // about the bridge, so it shades the two sides of an axis differently: 47 of
  // the 100 live pairs differ under it however well the axis is placed. Every
  // other effect wants the texture; this one wants the symmetry.
  expect(fx.threshold(0, 3)).not.toBe(fx.threshold(0, COLS - 1 - 3))
  expect(mirrorOffsets(fx.mirror({ columns: 240, dither: 'ordered' })).length).toBe(0)
  expect(fx.mirror({ columns: 240 })).toEqual(fx.mirror({ columns: 240, dither: 'none' }))
  // And an explicit undefined means this effect's default, not render's: the
  // same trap starfield fell into.
  const undef = { columns: 240, dither: undefined }
  expect(fx.mirror(undef)).toEqual(fx.mirror({ columns: 240 }))
})

test('a name off Object.prototype is a miss, not a call into Object', () => {
  // Every name reaching these registries comes from outside: an argv word, a
  // stored preset, a tap on a list. On a plain object EFFECTS.constructor is
  // Object, which passes an `if (!make)` guard and then fails far away - the
  // preview died inside its ASCII printer with "bitmap[r].slice(...).map is not
  // a function", naming neither the registry nor the name.
  expect(Object.getPrototypeOf(fx.EFFECTS)).toBe(null)
  expect(Object.getPrototypeOf(fx.FIELDS)).toBe(null)
  const inherited = ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']
  for (const name of inherited) {
    expect(fx.EFFECTS[name]).toBeUndefined()
    expect(fx.FIELDS[name]).toBeUndefined()
    expect(() => fx.mirrorField({ inner: name })).toThrow(/no field called/)
  }
})

test('an inner that is not a field at all is refused where it is readable', () => {
  // Otherwise it surfaces as "field is not a function" from inside the sample
  // loop, which names neither the option nor the effect that carried it. Same
  // reason render checks levels: the untyped caller is the CLI, and anything
  // rebuilding an effect from stored options.
  for (const bad of [0, 1, true, {}, []]) {
    expect(() => fx.mirrorField({ inner: bad as never })).toThrow(/inner must be a field/)
  }
  // null and undefined both mean "this effect's default inner".
  expect(fx.mirror({ columns: 64, inner: undefined })).toEqual(fx.mirror({ columns: 64 }))
  const nulled = { columns: 64, inner: null as never }
  expect(fx.mirror(nulled)).toEqual(fx.mirror({ columns: 64 }))
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

test('fire draws a silhouette only without the dither, worst at levels 2', () => {
  // The docblock had this the wrong way round. At two levels one threshold band
  // covers most of the flame body, so the dither punches holes through it rather
  // than shading it, and levels 2 is exactly what the wide saved route forces.
  const holes = (bitmap: content.Bitmap): number => {
    let bad = 0
    for (let c = 0; c < content.width(bitmap); c++) {
      let top = -1
      for (let r = ROWS - 1; r >= 0; r--) {
        if (bitmap[r][c] > 0) {
          top = r
          break
        }
      }
      for (let r = 0; r < top; r++) if (bitmap[r][c] === 0) bad++
    }
    return bad
  }
  for (const levels of LEVELS) {
    const flat = fx.fire({ columns: 240, levels, dither: 'none' })
    expect(`${levels} undithered: ${holes(flat)}`).toBe(`${levels} undithered: 0`)
  }
  // And the numbers the docblock now quotes, so a change to either has to say so.
  expect(holes(fx.fire({ columns: 240, levels: 2 }))).toBe(93)
  expect(holes(fx.fire({ columns: 240, levels: 4 }))).toBe(6)
})

test('fire leans by shearing the whole profile sideways, which is what rises', () => {
  // "lean changes some pixels" would pass for any perturbation at all. The claim
  // is stronger and exact: the tip line at height v is the v = 0 line shifted
  // lean * v columns, which is the only way this panel can fake vertical motion.
  const columns = 240
  for (const lean of [3, 24, -12]) {
    const leaned = fx.fireField({ lean })
    const flat = fx.fireField({ lean: 0 })
    let worst = 0
    for (let row = 0; row < ROWS; row++) {
      const v = row / (ROWS - 1)
      for (let col = 0; col < columns; col++) {
        const shifted = col - lean * v
        worst = Math.max(
          worst,
          Math.abs(
            leaned({ u: col / columns, v, col, row, columns }) -
              flat({ u: shifted / columns, v, col: shifted, row, columns }),
          ),
        )
      }
    }
    expect(`lean ${lean}: ${worst < 1e-9}`).toBe(`lean ${lean}: true`)
  }
})

test('fire closes whatever it is leaning by, and the lean is really in the picture', () => {
  // lean shifts each row's profile by a constant, which cannot open a loop that
  // whole cycle counts close; it is diagonal structure, so it must change pixels.
  for (const opts of [{}, { lean: 7.3, tongue: 9.5 }, { lean: -4, height: 0.9 }]) {
    expect(fx.fieldGap(fx.fireField(opts), { columns: 240 })).toBeLessThan(1e-9)
  }
  expect(fx.fire({ columns: 64, lean: 0 })).not.toEqual(fx.fire({ columns: 64, lean: 4 }))
})

test('mirror closes for every continuous inner, and starfield is the one that does not', () => {
  // The hole review-15's closure walk left: it went through the FIELDS registry, so it
  // checked `mirror` with its default inner and each other generator alone. Nothing
  // walked mirror AGAINST each inner, which is where the one failure lives. Found by
  // review-13 while driving the app's own effect knobs, not by reading this file.
  const inners = Object.keys(fx.FIELDS).filter((n) => n !== 'mirror')
  const widths = [120, 240, 368, 480, fx.MAX_COLUMNS]
  const open: string[] = []

  for (const inner of inners) {
    for (const columns of widths) {
      for (const folds of [2, 4, 6, 10]) {
        const gap = fx.fieldGap(fx.mirrorField({ inner, columns, folds }), { columns })
        if (gap > 1e-9) open.push(`${inner} w=${columns} folds=${folds} gap=${gap.toFixed(3)}`)
      }
    }
  }

  // Named rather than counted, so a new generator that fails closure cannot hide inside
  // a tolerance. starfield fails because it hashes a truncated column and the fold phase
  // samples it between steps: a step function cannot be folded, and the phase that
  // causes it is what puts the folds on the bridge instead of a column centre.
  const failing = [...new Set(open.map((s) => s.split(' ')[0]))].sort()
  expect(failing).toEqual(['starfield'])

  // And the failure is gross, not marginal: this is a seam anyone would see in a loop
  // that costs five page erases, which is why a caller offering inner choices has to run
  // fieldGap per combination rather than once per generator.
  const worst = Math.max(
    ...widths.map((columns) =>
      fx.fieldGap(fx.mirrorField({ inner: 'starfield', columns, folds: 4 }), { columns }),
    ),
  )
  expect(worst).toBeGreaterThan(0.5)
})
