/**
 * One wide loop, priced and checked, before anything is uploaded.
 *
 * Everything the Effects screen needs to decide is here rather than in the `.tsx`, for
 * the reason `deliver.ts` gives: the interesting part of a save is a sequence, and a
 * sequence inside an `onPress` can only be checked by a person watching a 9x24 panel.
 * Here it is `bun test`.
 *
 * **Nothing in this file writes words about cost.** `deliver.costOf()` owns those, five
 * page erases and all, and `plan.cost` is that object unmodified: the screen prints
 * `cost.words` verbatim so the flash sentence a person reads on Compose and the one they
 * read here are the same sentence. Inventing a second wording is how two screens end up
 * disagreeing about what a save costs. Same for `problems`, which is `deliver.problems`
 * and therefore `content.check` plus the one rule core cannot know.
 *
 * **Two levels, always, and it is not a preference.** A wide loop with grey in it has no
 * good delivery: `content.savedType` wants type 2 for it, which the device shows 24
 * columns of and forgets at the next power cycle, and the saved path's other answer is to
 * flatten it, which lights every dim pixel at full brightness. **The second one is the
 * default and it is not an error**, so a four-level loop is not refused - it is uploaded
 * as a near-solid block, because ordered dither at four levels lights about 90% of the
 * cells and flattening keeps all of them. Nothing at the device end would say so. Every
 * width here is wider than the panel, so `LEVELS` is fixed at 2 and `notes` carries both
 * halves in `deliver`'s own words when something asks for 4. `levels` stays a parameter
 * for that test alone: a constant nobody can vary is a constant nobody can check.
 *
 * **`fieldGap` is the closure check, and `seam` is carried only as the weaker one.**
 * **There is no width ladder, and the default is the ceiling.** This file used to export
 * `WIDTHS`, five widths a chip row offered, and `planLoop` defaulted to the second of
 * them. Both are gone (track 28, and the argument is `notes/library.md`, "Width is not a
 * question worth asking"): **every `DATCP` erases the same five hardcoded pages whatever
 * the payload**, so a 120-column loop and a 736-column one cost identical flash and the
 * only thing width ever bought was upload seconds. A control whose answer is always the
 * same is a question not worth asking, so a loop renders at `fx.MAX_COLUMNS` unless a
 * caller says otherwise. `columns` stays a parameter because one caller still says
 * otherwise: `one-tap.pieceFor` hands back a stored recipe's own width, and an item
 * saved while the ladder existed must still re-render as what its owner saved.
 *
 * `seam` reads the quantised bitmap and cannot see a loop built against `col` instead of
 * `u`, which is the mistake that matters; `fieldGap` asks the field, in float, one column
 * either side of the join. Both are reported because a screen that showed only the
 * reassuring number would be reassuring about nothing.
 *
 * **An open loop is reported, a dark one is refused, and the difference is what a person
 * can see before they spend anything.** A join that does not close is visible in the
 * preview and arguable - the device puts its own screen of blank at exactly that point -
 * so it is said in red and the upload stays available. A loop with nothing lit in it is
 * not arguable: it is five page erases for a dark panel, `content.check` has no rule
 * against it because a blank bitmap is a legal one, and `offered.test.ts` found a
 * combination of the screen's own buttons that reaches it. So `problems` gains that one
 * rule of its own, the same way `deliver.problems` adds the rule core cannot know.
 */
import { content, dats, effects as fx, viewport } from '@joggles/core'
import type { Bitmap, Content, Seam } from '@joggles/core'
import {
  type Cost,
  ERASES_PER_SAVE,
  type GreyChoice,
  costOf,
  greyChoice,
  problems as pathProblems,
  typeFor,
} from '../deliver.js'
import { columnsPerSecond } from '../speed.js'
import { type KnobValue, specFor, tuning } from './catalogue.js'

/**
 * Levels every loop on this screen is rendered at. Two, monochrome, type 1.
 *
 * See the file note: this is the difference between a save that survives the night and
 * one the device shows 24 columns of and forgets.
 */
export const LEVELS = 2

/**
 * How far from closing a field may be and still count as closed.
 *
 * Measured rather than chosen: across all seven generators at `LEVELS`, from the
 * narrowest width the deleted ladder offered up to the ceiling, the worst `fieldGap` is
 * 1.9e-14, which is float noise from summing sines.
 * A generator whose loop is genuinely open misses by a fraction of a cycle, so it lands
 * orders of magnitude above this. `plan.test.ts` pins both ends.
 */
export const CLOSES_WITHIN = 1e-9

/**
 * The sentence every wide loop needs and no generator can fix.
 *
 * Exported as a constant because it is the one honest thing about "seamless" on this
 * device, and `wiring.test.ts` asserts the screen prints it. The device appends about a
 * screen's width of blank to a scrolling type 1 save, so the loop an audience sees is
 * `panelColumns` and it has a dark pass in it however exactly the field closes. Whether
 * that happens before the save has been restored from flash is still open, which is why
 * this says "once the glasses have been switched off and on" rather than "always":
 * `research/loop-gap-2026-08-10.md` has the two observations and the experiment.
 *
 * *Corrected 2026-08-11 by review 13, off a screenshot of the screen saying both things
 * at once:* this used to assert "the field itself closes exactly", which is not this
 * constant's to promise. `mirror` reflecting `starfield` does not close, and the report
 * block printed the red "the loop does NOT close" line directly above this sentence
 * claiming it did. The closure line above says which it is; this says only whose the gap
 * is.
 */
export const PANEL_GAP_NOTE =
  'The glasses add about a screen of blank after the content, so a pass is 24 columns '
  + 'longer than the loop and there is a dark gap between repeats. That gap is the '
  + 'device rather than the loop, and whether it appears before the glasses have been '
  + 'switched off and on again is still unsettled.'

/**
 * Why there is no brightness control, in the words the screen prints.
 *
 * The rule is at the top of this file and `plan.test.ts` measures both halves of it; this
 * is the half a person holding the phone needs, because "monochrome" is otherwise
 * something they find out by rendering something with shading in it and watching the
 * shading not arrive. A constant rather than a line in the `.tsx` for the same reason
 * `PANEL_GAP_NOTE` is one: the rule and its wording belong together, and the screen must
 * not be able to drift from it.
 *
 * Added by review 13: the reasoning existed in three docblocks and a test, and nowhere a
 * user could read it.
 */
export const MONO_NOTE =
  'Two levels, monochrome, and there is no control for it: a wide loop with grey in it '
  + 'has no good delivery. Keeping the grey makes it a type 2, which the glasses show 24 '
  + 'columns of and forget at the next power cycle; the alternative flattens it, and '
  + 'every dim pixel comes back at full brightness. Rendering flat from the start is the '
  + 'only one of the three with nothing hidden in it.'

/**
 * The one thing this screen refuses rather than reports. See the file note.
 *
 * Its own rule, not `content.check`'s: a bitmap with nothing lit is structurally legal,
 * the same length on the wire, and answers `DATCPOK` exactly like any other.
 *
 * The count is interpolated rather than written out, for the reason `wiring.test.ts` gives
 * about the screen: five erases is a hand-decode at `abs 0x218cc` with no cycle counter to
 * read back, so there is one place to change if that reading is ever overturned.
 */
export const NOTHING_LIT =
  `nothing in this loop is lit, so the ${ERASES_PER_SAVE} page erases would buy a dark `
  + 'panel. A different dither, width or set of numbers for this effect will fill it.'

export interface LoopInput {
  /** A name from the catalogue. Anything else throws rather than rendering nothing. */
  name: string
  /** The knobs, as `catalogue.defaultsFor` shapes them. `AUTO` values are dropped. */
  opts?: Record<string, KnobValue>
  /** The ceiling unless a stored recipe carries its own width. See the file note. */
  columns?: number
  dither?: 'ordered' | 'none'
  /** Only `plan.test.ts` passes anything but `LEVELS`. See the file note. */
  levels?: 2 | 4
  dir?: 0 | 1
  /** `SPEED`, 0 to 100, used for the durations and carried on the motion. */
  speed?: number
}

export interface Plan {
  name: string
  /** The width asked for, and the width `seamlessWidth` gave. */
  asked: number
  columns: number
  snapped: boolean
  levels: 2 | 4
  dither: 'ordered' | 'none'
  bitmap: Bitmap
  /** Ready for `deliver()`. Always a scroll; see `secondsFor` on why static is absent. */
  piece: Content
  /** What it would actually be sent as, which for grey content is the flattened type 1. */
  type: number
  /** `deliver.costOf()`, unmodified. The screen prints `cost.words` verbatim. */
  cost: Cost
  /** `deliver.problems()`. Non-empty disables the save and says why. */
  problems: string[]
  /**
   * `deliver.greyChoice()`: null at `LEVELS`, which is the only state the screen offers.
   *
   * Non-null means the loop has grey in it and both answers are bad at this width, which
   * is why there is no levels control. It is here so a test can read the two costs
   * rather than trust the prose above.
   */
  grey: GreyChoice | null
  /** The check with teeth: the field, in float, either side of the join. */
  closes: boolean
  gap: number
  /** The backstop, on the quantised bitmap. Cannot prove a loop closes. */
  seam: Seam
  /** Columns the panel walks, which is the uploaded ones plus the device's blanks. */
  panelColumns: number
  /** Seconds a pass takes at `speed`: the buffer's, then the one an audience sees. */
  uploadedSeconds: number
  panelSeconds: number
  /** Mirror only: the snapped fold count and the columns between mirror axes. */
  folds: number | null
  axisEvery: number | null
  lit: number
  litFraction: number
  /** Only what is wrong. Empty is the normal state; `PANEL_GAP_NOTE` is separate. */
  notes: string[]
}

/** Seconds for `columns` at `SPEED` `speed`, off the firmware's own divisor ladder. */
export const secondsFor = (columns: number, speed: number): number =>
  columns / columnsPerSecond(speed)

/**
 * Build one loop and answer everything about it.
 *
 * The bitmap comes from `effects.EFFECTS[name]`, never from `render(FIELDS[name](...))`,
 * because two generators carry a dither default of their own and only the `EFFECTS` entry
 * applies it. The field is fetched separately, for `fieldGap` alone, which is the split
 * `effects.ts` intends: the quantised picture is what ships, the field is what can be
 * proved to close.
 */
export function planLoop(input: LoopInput): Plan {
  const { name, dir = 0, speed = 65 } = input
  const spec = specFor(name)
  const levels = input.levels ?? LEVELS
  const dither = input.dither ?? spec.dither
  const asked = input.columns ?? fx.MAX_COLUMNS
  const columns = fx.seamlessWidth(asked)
  const opts = { ...tuning(input.opts ?? {}), columns, levels, dither }

  const bitmap = fx.EFFECTS[name](opts)
  // A wide save can only be a scroll: `MODE 01` would show the first 24 columns of a
  // 736-column loop and nothing else, so there is no static option to carry.
  const piece: Content = { bitmap, route: 'saved', motion: { kind: 'scroll', dir, speed } }
  const type = typeFor(piece)
  const gap = fx.fieldGap(fx.FIELDS[name](opts), opts)
  const closes = gap <= CLOSES_WITHIN
  const panelColumns = viewport.marqueeWidth(columns)
  const lit = bitmap.reduce((n, row) => n + row.reduce((m, v) => m + (v > 0 ? 1 : 0), 0), 0)
  // Core refuses a dark type 1 save since track 27, so pushing this too would print two
  // sentences saying the same thing. It stays as the one worth reading, because core's
  // says a dark save is refused and this one says which knob fills the panel.
  const problems = pathProblems(piece, 'saved').filter((p) => p !== content.BLANK_SAVE)
  if (lit === 0) problems.push(NOTHING_LIT)
  const folds = name === 'mirror' ? fx.mirrorFolds(columns, foldsAsked(input)) : null

  // Deliver's own words for both halves of the grey trap, because a second wording of
  // "what flattening loses" is how two screens end up disagreeing about it.
  const grey = greyChoice(piece)
  const notes: string[] = []
  if (grey !== null) {
    notes.push(grey.loses)
    if (grey.blocked.keep.length > 0) {
      notes.push(`Keeping the grey instead: ${grey.blocked.keep.join('; ')}.`)
    }
    notes.push(
      `So this width is only worth uploading at ${LEVELS} levels, where there is no grey `
      + 'to lose and nothing to decide.',
    )
  }
  if (!closes) {
    notes.push(
      `The loop does not close: the field is ${gap.toFixed(3)} out between the last `
      + 'column and the first, which shows as a hard join going past.',
    )
  }

  return {
    name,
    asked,
    columns,
    snapped: columns !== asked,
    levels,
    dither,
    bitmap,
    piece,
    type,
    cost: costOf(piece, 'saved'),
    problems,
    grey,
    closes,
    gap,
    seam: fx.seam(bitmap),
    panelColumns,
    uploadedSeconds: secondsFor(columns, speed),
    panelSeconds: secondsFor(panelColumns, speed),
    folds,
    axisEvery: folds === null ? null : columns / (2 * folds),
    lit,
    litFraction: lit / (columns * 9),
    notes,
  }
}

/**
 * The fold count the caller asked for, or `undefined` for the generator's own default.
 *
 * `tuning` has already dropped an `AUTO`, so an absent key is the sentinel arriving
 * here, and `mirrorFolds` reads `undefined` as "space the axes a panel apart".
 */
function foldsAsked(input: LoopInput): number | undefined {
  const raw = tuning(input.opts ?? {}).folds
  return typeof raw === 'number' ? raw : undefined
}
