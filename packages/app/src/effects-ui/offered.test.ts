/**
 * Every loop the buttons on the screen can actually produce, not just the defaults.
 *
 * **`plan.test.ts` walks `defaultsFor`, which is one combination per effect out of the 333
 * the knob rows offer.** That gap is where review 13 found both of this screen's real
 * defects, and neither was reachable from a default: a completely dark 736-column loop
 * that the Upload button offered to spend five page erases on, and a mirrored starfield
 * whose loop does not close. So this file is the cross product - every knob at every one
 * of its values, at the narrowest and widest widths, under both dithers - asserting the
 * four properties that decide whether a save is worth making.
 *
 * It is a characterisation test as much as a rule: the mirrored starfield is named here as
 * the one known open loop, so a *second* combination going open fails rather than joining
 * a tolerated set. That is the assertion a future generator, or one new knob value, has to
 * get past.
 *
 * 1332 combinations at up to 736 columns, which is about a third of a second. Two widths
 * rather than one because the properties here are set by the knobs and the dither, and a
 * stored recipe can still carry a narrow width even though the screen only offers the
 * ceiling now: see `ENDS` below, and `plan.test.ts` for why any width but the ceiling is
 * still reachable at all.
 */
import { content, dats, effects as fx } from '@joggles/core'
import { expect, test } from 'bun:test'
import { problems as pathProblems } from '../deliver.js'
import { CATALOGUE, type KnobValue } from './catalogue.js'
import { CLOSES_WITHIN, NOTHING_LIT, planLoop } from './plan.js'

const DITHERS = ['ordered', 'none'] as const
/**
 * The ceiling, which is the only width the screen now renders, and one narrow width.
 *
 * The width control and its `WIDTHS` ladder are deleted (`notes/library.md`, "Width is
 * not a question worth asking"), so the buttons reach the ceiling and nothing else. 120
 * stays in the cross product because it is not unreachable: it is the narrowest rung the
 * ladder ever offered, `library.ts` keeps whatever width an item was saved at, and
 * `one-tap.pieceFor` re-renders that item through `planLoop`. A blank or open loop at a
 * stored width would be as bad as one at the ceiling.
 */
const ENDS = [120, fx.MAX_COLUMNS]

/** Every value of every knob against every value of every other. */
const combos = (knobs: { key: string; values: KnobValue[] }[]): Record<string, KnobValue>[] => {
  let out: Record<string, KnobValue>[] = [{}]
  for (const knob of knobs) {
    const next: Record<string, KnobValue>[] = []
    for (const base of out) for (const v of knob.values) next.push({ ...base, [knob.key]: v })
    out = next
  }
  return out
}

interface Offered {
  name: string
  where: string
  plan: ReturnType<typeof planLoop>
}

const offered = (): Offered[] => {
  const out: Offered[] = []
  for (const spec of CATALOGUE) {
    for (const opts of combos(spec.knobs)) {
      for (const columns of ENDS) {
        for (const dither of DITHERS) {
          out.push({
            name: spec.name,
            where: `${spec.name} ${JSON.stringify(opts)} @${columns} ${dither}`,
            plan: planLoop({ name: spec.name, opts, columns, dither }),
          })
        }
      }
    }
  }
  return out
}

const ALL = offered()

test('the cross product is the whole of what the buttons can reach', () => {
  // A count, so a knob row losing its values silently cannot leave this file asserting
  // four properties about nothing.
  expect(ALL.length).toBe(
    CATALOGUE.reduce((n, s) => n + combos(s.knobs).length, 0) * ENDS.length * DITHERS.length,
  )
  expect(ALL.length).toBe(1332)
})

test('every combination the screen offers is monochrome type 1 and persists', () => {
  for (const { where, plan } of ALL) {
    expect(content.hasGrey(plan.bitmap), `${where} has grey in it`).toBe(false)
    expect(plan.type, where).toBe(dats.TYPE_TEXT)
    expect(plan.cost.persists, where).toBe(true)
    expect(plan.grey, where).toBeNull()
  }
})

/**
 * The defect this file was written for.
 *
 * `mirror` reflecting `ripple` at 10 folds with no dither renders **nothing at all** at
 * every width: the rings fade with distance, the folds put every sample in the faded part,
 * and with no dither to lift a cell over the threshold the whole 736 columns come out 0.
 * `content.check` passes it - a blank bitmap is structurally legal and answers `DATCPOK`
 * like any other - so before `plan.NOTHING_LIT` the screen's Upload button was bright green
 * and offering five page erases for a dark panel. *Verified on the Pixel*, 2026-08-11:
 * "0% of the loop is lit" above an enabled button.
 */
test('a loop with nothing lit is refused, and it is the plan that refuses it', () => {
  const blank = planLoop({
    name: 'mirror',
    opts: { inner: 'ripple', folds: 10 },
    columns: fx.MAX_COLUMNS,
    dither: 'none',
  })
  expect(blank.lit).toBe(0)
  expect(blank.problems).toContain(NOTHING_LIT)
  // The screen's `blocked` reads `problems.length`, so a non-empty list is the disabled
  // button.
  //
  // *Corrected 2026-08-12 by track 27, and the correction is the point of that track.*
  // This asserted that core sees nothing wrong with a dark bitmap, which pinned the
  // defect rather than a property: the rule lived in this module, and the screen it
  // guarded was rewritten out of existence a day later. It is core's now, so a dark
  // save is refused wherever it is assembled, and `content.BLANK_SAVE` is the sentence.
  expect(pathProblems(blank.piece, 'saved')).toContain(content.BLANK_SAVE)
})

test('nothing else the screen offers is blank, and nothing is a solid block', () => {
  for (const { where, plan } of ALL) {
    if (plan.lit === 0) {
      // Allowed only because it is refused: an unsendable dark loop is a disabled button
      // rather than a wasted erase.
      expect(plan.problems, `${where} is blank and NOT refused`).toContain(NOTHING_LIT)
      continue
    }
    expect(plan.problems, where).toEqual([])
    // The other end. A loop that lights nearly every cell is the four-level flatten this
    // screen exists to avoid, so at two levels nothing should come close to it.
    expect(plan.litFraction, `${where} is a near-solid block`).toBeLessThan(0.97)
  }
})

/**
 * Closure, and the one exception, by name.
 *
 * `mirror` samples its inner field at a **fractional** column, and `starfieldField` is a
 * hash of the truncated integer column - a step function - so the two sides of the join
 * disagree about which star is there. Traced 2026-08-11: at 736 columns and 16 folds the
 * folded position either side of the wrap is 15.999999999999 and 16.000000000002, which
 * truncate to different stars and read 0.7604 against 0.
 *
 * This contradicts `effects.ts`'s own claim that "the mirrored loop closes whether or not
 * the inner field does... this is the one generator that can take a field built against
 * raw `col` and make it seamless", in exactly the case that sentence names. `effects.ts`
 * belongs to another track, so this is pinned rather than fixed, and the screen reports it
 * in red. If the generator is ever fixed, this test names what to delete.
 */
test('every offered loop closes except the mirrored starfield, which says so', () => {
  const open = ALL.filter(({ plan }) => !plan.closes)
  expect(open.length).toBeGreaterThan(0)
  for (const { where, plan } of open) {
    expect(where).toContain('mirror')
    expect(where).toContain('starfield')
    expect(plan.gap, where).toBeGreaterThan(0.1)
    // Reported, in the plan the screen reads, rather than left to the preview.
    expect(plan.notes.join(' '), where).toContain('does not close')
  }
  for (const { where, plan } of ALL) {
    if (plan.closes) expect(plan.gap, where).toBeLessThanOrEqual(CLOSES_WITHIN)
  }
  // And it is not the whole of mirror: reflecting anything continuous closes at float
  // noise, so this is one inner field's property and not the generator's.
  for (const inner of fx.EFFECT_NAMES.filter((n) => n !== 'mirror' && n !== 'starfield')) {
    const plan = planLoop({ name: 'mirror', opts: { inner }, columns: fx.MAX_COLUMNS })
    expect(plan.closes, `mirror of ${inner}`).toBe(true)
  }
})

test('no offered combination throws, whatever the knob values', () => {
  // `render` ignores an option it does not know, so a knob key that drifted from its
  // generator fails `catalogue.test.ts`; this is the other half, that no *value* on offer
  // reaches a throw deep inside a generator. `mirrorFolds` and `ripple`'s source count
  // are the two that do arithmetic on what they are handed.
  for (const spec of CATALOGUE) {
    for (const opts of combos(spec.knobs)) {
      expect(() =>
        planLoop({ name: spec.name, opts, columns: fx.MAX_COLUMNS }),
      ).not.toThrow()
    }
  }
})
