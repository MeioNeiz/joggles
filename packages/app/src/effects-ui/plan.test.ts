/**
 * Every loop the screen can offer, against the rules that decide whether it survives.
 *
 * The property that matters is one pixel wide: `content.savedType` reads the bitmap for
 * grey, so a single grey cell out of 6624 decides whether a 736-column loop persists or
 * becomes a type 2 the device shows 24 columns of and forgets at power off. Nothing at the
 * device end reports either outcome, and nobody would notice on a preview. So the whole
 * catalogue is walked at every width and asserted monochrome, type 1, persistent and
 * unrefused - and then the same loop is asked for at four levels, which is what a screen
 * offering a levels control would let through, and which turns out not to be refused at
 * all.
 *
 * **What this cannot reach**: `closes: false` through `planLoop`. Every shipped generator
 * rounds its cycle counts to whole numbers, so none of them can be made open from the
 * outside, which is exactly the guarantee `effects.ts` is built on. The threshold is
 * therefore pinned directly against a deliberately open field, and the wiring from that
 * threshold to `plan.notes` is covered only by the type 2 case below.
 */
import { content, dats, effects as fx, viewport } from '@joggles/core'
import { expect, test } from 'bun:test'
import { ERASES_PER_SAVE, type GreyChoice, costOf } from '../deliver.js'
import { columnsPerSecond } from '../speed.js'
import { CATALOGUE, defaultsFor } from './catalogue.js'
import * as planExports from './plan.js'
import { CLOSES_WITHIN, LEVELS, PANEL_GAP_NOTE, planLoop, secondsFor } from './plan.js'

/**
 * The ceiling, plus the two widths a stored recipe can still carry into `planLoop`.
 *
 * The screen renders at the ceiling and nothing else: the `WIDTHS` ladder was deleted
 * with the control it fed (`notes/library.md`, "Width is not a question worth asking",
 * because every `DATCP` erases the same five pages whatever the payload). But
 * `library.ts` clamps a saved `columns` to anything between the panel and the ceiling
 * and `one-tap.pieceFor` hands it straight back here, so an item saved while the ladder
 * existed still plans through this file and must still come out monochrome, closed and
 * type 1. 120 and 240 are two of the five it could be holding.
 */
const REACHABLE = [120, 240, fx.MAX_COLUMNS]

const every = (columns: number) =>
  CATALOGUE.map((spec) => planLoop({ name: spec.name, opts: defaultsFor(spec.name), columns }))

test('the ladder is deleted rather than merely unused, and the default is the ceiling', () => {
  // Both halves matter: an export nothing imports is a control one screen away from
  // growing back, and a default of `WIDTHS[1]` was the ladder still deciding for
  // every caller that named no width.
  expect(Object.keys(planExports)).not.toContain('WIDTHS')
  expect(planLoop({ name: 'stripes' }).columns).toBe(fx.MAX_COLUMNS)
  expect(planLoop({ name: 'stripes' }).snapped).toBe(false)
})

test('the ceiling is a real width, snapped already, and wider than the panel', () => {
  expect(fx.MAX_COLUMNS % fx.TILE).toBe(0)
  expect(fx.seamlessWidth(fx.MAX_COLUMNS)).toBe(fx.MAX_COLUMNS)
  // A loop no wider than the panel is a still picture, which is Message's job.
  expect(fx.MAX_COLUMNS).toBeGreaterThan(viewport.WIDTH)
  for (const columns of REACHABLE) {
    expect(fx.seamlessWidth(columns), `${columns}`).toBe(columns)
    expect(columns).toBeGreaterThan(viewport.WIDTH)
  }
})

test('every effect at every reachable width is monochrome type 1 and the device takes it', () => {
  for (const columns of REACHABLE) {
    for (const plan of every(columns)) {
      const where = `${plan.name} at ${columns}`
      expect(content.hasGrey(plan.bitmap), `${where} has grey in it`).toBe(false)
      expect(plan.type, where).toBe(dats.TYPE_TEXT)
      expect(plan.cost.persists, where).toBe(true)
      expect(plan.cost.erases, where).toBe(ERASES_PER_SAVE)
      expect(plan.problems, where).toEqual([])
      expect(plan.notes, where).toEqual([])
      expect(plan.columns, where).toBe(columns)
      expect(plan.snapped, where).toBe(false)
      expect(plan.levels, where).toBe(LEVELS)
    }
  }
})

test('every effect at every reachable width closes, on the field and not on the bitmap', () => {
  for (const columns of REACHABLE) {
    for (const plan of every(columns)) {
      expect(plan.closes, `${plan.name} at ${columns} is ${plan.gap} out`).toBe(true)
      expect(plan.gap).toBeLessThanOrEqual(CLOSES_WITHIN)
      // Carried too, and it agrees here. It is kept because it is the only check
      // available for a bitmap that arrived from somewhere else, not because it is
      // the stronger one.
      expect(plan.seam.seamless, `${plan.name} at ${columns}`).toBe(true)
    }
  }
})

/**
 * The threshold, against a loop that genuinely does not close.
 *
 * A sine of a whole cycle count closes at float noise; the same sine at 2.4 cycles is
 * the mistake `effects.ts` says `seam` cannot see - and it does not see it here either,
 * which is why `closes` reads `fieldGap` and the screen reports both.
 */
test('CLOSES_WITHIN separates float noise from a loop that is actually open', () => {
  const columns = 240
  const closed = fx.fieldGap(({ u }) => 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * u), { columns })
  const open = fx.fieldGap(({ col }) => 0.5 + 0.5 * Math.sin((2 * Math.PI * col) / 100), {
    columns,
  })
  expect(closed).toBeLessThanOrEqual(CLOSES_WITHIN)
  expect(open).toBeGreaterThan(CLOSES_WITHIN)
  expect(open).toBeGreaterThan(0.1)

  const bitmap = fx.render(({ col }) => 0.5 + 0.5 * Math.sin((2 * Math.PI * col) / 100), {
    columns,
    levels: LEVELS,
  })
  expect(fx.seam(bitmap).seamless).toBe(true)
})

/**
 * What a levels control would cost, which is why there is not one.
 *
 * **It is not refused, and that is the point.** The saved path's default answer to grey is
 * to flatten it, and flattening is legal: five erases, persists, no problems reported. So a
 * four-level loop uploads happily and arrives as a near-solid block, because ordered dither
 * at four levels lights about 90% of the cells and flattening keeps every one of them. The
 * type 2 alternative is the blocked one. Both halves come back in `deliver`'s words.
 */
test('four levels is accepted and quietly flattened, not refused', () => {
  let exercised = 0
  for (const spec of CATALOGUE) {
    const plan = planLoop({ name: spec.name, opts: defaultsFor(spec.name), columns: 240, levels: 4 })
    const two = planLoop({ name: spec.name, opts: defaultsFor(spec.name), columns: 240 })
    if (!content.hasGrey(plan.bitmap)) {
      // `stripes` opens on hard edges, whose field is only ever 0 or 1, so it is
      // monochrome at any level count and four levels costs it nothing. Worth asserting
      // rather than skipping: it is the one effect a levels control could not damage.
      expect(spec.name, 'only a hard-edged field should be grey-free at four levels').toBe(
        'stripes',
      )
      expect(plan.grey).toBeNull()
      expect(plan.notes).toEqual([])
      continue
    }
    exercised++
    expect(plan.grey, spec.name).not.toBeNull()
    // Flattened, so it still goes as type 1 and still costs five erases.
    expect(plan.type, spec.name).toBe(dats.TYPE_TEXT)
    expect(plan.problems, spec.name).toEqual([])
    expect(plan.cost.persists, spec.name).toBe(true)
    // Keeping the grey is the blocked answer, and the reason is the 24-column ceiling.
    expect((plan.grey as GreyChoice).blocked.keep.join('; '), spec.name).toContain(
      'type 2 shows only 24 columns',
    )
    expect(plan.notes.join(' '), spec.name).toContain('Flattening drops the grey')
    expect(plan.notes.join(' '), spec.name).toContain('type 2 shows only 24 columns')

    // And the damage, which is the thing no preview and no device reply would show: what
    // reaches the panel is `flatten` of this bitmap, and it lights far more of the loop
    // than the two-level render the screen actually sends.
    const asSent = content.flatten(plan.bitmap).flat().filter((v) => v > 0).length
    expect(asSent / (240 * 9), spec.name).toBeGreaterThan(two.litFraction)
  }
  // A loop that skipped every effect would have proved nothing.
  expect(exercised).toBe(CATALOGUE.length - 1)
})

test('the cost is deliver.costOf unmodified, so both screens say the same sentence', () => {
  const plan = planLoop({ name: 'plasma', columns: 736 })
  expect(plan.cost).toEqual(costOf(plan.piece, 'saved'))
  expect(plan.cost.words).toContain(`${ERASES_PER_SAVE} page erases`)
  expect(plan.cost.columns).toBe(736)
})

test('a width past the ceiling snaps down rather than being refused', () => {
  const plan = planLoop({ name: 'plasma', columns: 740 })
  expect(plan.asked).toBe(740)
  expect(plan.columns).toBe(fx.MAX_COLUMNS)
  expect(plan.snapped).toBe(true)
  expect(plan.problems).toEqual([])
  // And the reason 740 is not the ceiling for a dithered loop: the tile.
  expect(fx.MAX_COLUMNS % fx.TILE).toBe(0)
})

test('the widest loop still fits the byte budget the column ceiling came from', () => {
  const plan = planLoop({ name: 'stripes', columns: fx.MAX_COLUMNS })
  const encoded = content.encodeSaved(plan.piece)
  expect(encoded.type).toBe(dats.TYPE_TEXT)
  expect(encoded.flattened).toBe(false)
  expect(encoded.payload.length).toBeLessThanOrEqual(content.MAX_SAVED_BYTES)
})

test('a pass is the uploaded columns plus the ones the device adds, and it is longer', () => {
  const plan = planLoop({ name: 'wave', columns: 240, speed: 65 })
  expect(plan.panelColumns).toBe(240 + dats.TYPE1_BRACKET)
  expect(plan.panelColumns).toBe(viewport.marqueeWidth(240))
  expect(plan.panelSeconds).toBeGreaterThan(plan.uploadedSeconds)
  expect(PANEL_GAP_NOTE).toContain('24 columns')
})

test('the durations come off the firmware ladder, not off a second copy of it', () => {
  // Agrees with core's own figure for the widest loop at the fastest bucket, which is
  // the number `effects.loopSeconds` publishes.
  expect(secondsFor(fx.MAX_COLUMNS, 95)).toBeCloseTo(fx.loopSeconds(fx.MAX_COLUMNS).fastest, 6)
  expect(secondsFor(columnsPerSecond(65), 65)).toBeCloseTo(1, 12)
})

test('mirror folds land on a divisor of the width, so the axes recur', () => {
  for (const columns of REACHABLE) {
    const plan = planLoop({ name: 'mirror', opts: defaultsFor('mirror'), columns })
    expect(plan.folds, `${columns}`).not.toBeNull()
    const folds = plan.folds as number
    // A fold count dividing the width is what makes the reflection line up with the
    // panel again and again rather than twice a pass.
    expect(columns % folds, `${columns} / ${folds}`).toBe(0)
    expect(plan.axisEvery).toBe(columns / (2 * folds))
  }
  // An explicit count is still snapped, and the plan reports what it got rather than
  // what was asked for.
  const asked = planLoop({ name: 'mirror', opts: { inner: 'plasma', folds: 15 }, columns: 736 })
  expect(asked.folds).toBe(fx.mirrorFolds(736, 15))
  expect(736 % (asked.folds as number)).toBe(0)
})

test('non-mirror effects have no fold count to report', () => {
  const plan = planLoop({ name: 'plasma', columns: 240 })
  expect(plan.folds).toBeNull()
  expect(plan.axisEvery).toBeNull()
})

test('the motion is always a scroll, because a static wide save shows 24 columns', () => {
  const plan = planLoop({ name: 'ripple', columns: 480, dir: 1, speed: 5 })
  expect(plan.piece.motion).toEqual({ kind: 'scroll', dir: 1, speed: 5 })
  expect(plan.piece.route).toBe('saved')
})

test('an unknown effect throws and names what there is', () => {
  expect(() => planLoop({ name: 'kaleidoscope' })).toThrow('no effect called kaleidoscope')
})

test('the lit fraction is reported, because a wide ripple is mostly dark', () => {
  const plan = planLoop({ name: 'ripple', opts: defaultsFor('ripple'), columns: fx.MAX_COLUMNS })
  expect(plan.lit).toBeGreaterThan(0)
  expect(plan.litFraction).toBeLessThan(0.1)
  expect(plan.litFraction).toBeCloseTo(plan.lit / (plan.columns * 9), 12)
})
