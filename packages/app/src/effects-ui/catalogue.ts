/**
 * What a phone offers for each generator in `core/src/effects.ts`: a sentence, an
 * opening dither, and the handful of its own numbers worth a tap.
 *
 * **Why a catalogue at all, when `effects.EFFECTS` is already a registry.** The
 * registry answers "what generators exist"; it cannot answer "what should a thumb
 * change". Every generator takes half a dozen options, several of them floats, and a
 * screen that exposed all of them as text fields would be a worse `bun run effects`.
 * So each effect gets a short list of discrete values, which is what a row of buttons
 * can be, and `catalogue.test.ts` walks `EFFECT_NAMES` so a generator added later
 * fails a test rather than appearing on the screen with no description and no knobs.
 *
 * **A knob's key has to be an option the generator actually reads.** A typo is silent:
 * `render` ignores unknown keys, so the button would highlight and the picture would
 * not move. The CLI hit the same trap from the other side and guards it in `num()`;
 * here `catalogue.test.ts` renders each knob at two of its values and fails if the
 * bitmap does not change.
 *
 * **The opening `dither` is a UI choice and it is allowed to disagree with the
 * generator's own default.** Two of them already do their own thing (`starfield` and
 * `mirror` default to `'none'`, for reasons in their docblocks) and this screen is
 * pinned to `levels: 2`, which changes the answer again: at two levels ordered dither
 * eats holes in `fire`'s silhouette, 93 dark cells below the tip across 240 columns,
 * measured and matching the figure in `effects.ts`. So `dither` here is the value the
 * screen starts on, the test pins the two that must match the generator, and `caveat`
 * carries the sentence for the ones that must not.
 */
import { effects as fx } from '@joggles/core'

/**
 * A knob value the screen can put on a button.
 *
 * Strings are here for `mirror`'s `inner`, booleans for `stripes`'s `soft`. Neither
 * is a number and both are the difference between the effect's two real looks.
 */
export type KnobValue = number | boolean | string

/**
 * "Leave this one to the generator", as a knob value.
 *
 * `mirror`'s fold count defaults to something width-dependent and then snaps to a
 * divisor of the width, so there is no single number that means "the default". A
 * sentinel the plan strips before the options reach `effects` is the honest way to
 * offer it, and it must not be a number: 0 would arrive as `Math.max(1, 0)`, which is
 * a fold count of 1 rather than the default.
 */
export const AUTO = 'auto'

export interface Knob {
  /** The option name on the generator. Must be one it reads; see the file note. */
  key: string
  label: string
  /** Discrete values, in order, because a row of buttons is what a thumb gets. */
  values: KnobValue[]
  /** Which of `values` the screen opens on. Has to be one of them. */
  start: KnobValue
  /** Button captions, parallel to `values`. Defaults to `String`. */
  labels?: string[]
}

export interface EffectSpec {
  name: string
  /** One line, because a name on its own does not say what you would see. */
  about: string
  /** The dither this screen opens on. May differ from the generator's own default. */
  dither: 'ordered' | 'none'
  knobs: Knob[]
  /** The thing about this effect a person would otherwise learn by being surprised. */
  caveat: string | null
}

/**
 * Every generator, in the order `EFFECT_NAMES` lists them.
 *
 * The `about` and `caveat` lines are this screen's own words and not the CLI's. They
 * say the same things because they come from the same docblocks, and neither file
 * reads the other: a phone and a terminal have different amounts of room, and sharing
 * the strings would mean one of them wrapping badly.
 */
export const CATALOGUE: EffectSpec[] = [
  {
    name: 'plasma',
    about: 'summed sines cut to hard bands, drifting past',
    dither: 'ordered',
    caveat: null,
    knobs: [
      { key: 'cycles', label: 'Cycles', values: [1, 2, 3, 5, 8], start: 3 },
      { key: 'rise', label: 'Rise', values: [1, 2, 3], start: 1 },
      { key: 'warp', label: 'Warp', values: [0, 0.35, 0.8], start: 0.35 },
    ],
  },
  {
    name: 'stripes',
    about: 'a barber pole. Hard-edged it is the most legible thing here',
    dither: 'ordered',
    caveat: null,
    knobs: [
      // Hard rather than the generator's soft default: this screen is monochrome, and
      // a sine gradient with two levels to spend it in is a hard edge with dither
      // noise round it.
      {
        key: 'soft',
        label: 'Edge',
        values: [false, true],
        labels: ['Hard', 'Soft'],
        start: false,
      },
      { key: 'cycles', label: 'Bands', values: [4, 8, 12, 24], start: 12 },
      { key: 'shear', label: 'Shear', values: [0, 0.5, 1, 2], start: 0.5 },
      { key: 'duty', label: 'Duty', values: [0.25, 0.5, 0.75], start: 0.5 },
    ],
  },
  {
    name: 'wave',
    about: 'one bright ribbon on black, the clearest shape on 9 rows',
    dither: 'ordered',
    caveat:
      'The ribbon is anti-aliased across the levels, and there are two here, so a thin '
      + 'one flickers between one row and two. Thickness starts high for that reason.',
    knobs: [
      { key: 'cycles', label: 'Cycles', values: [2, 4, 8], start: 4 },
      // 0.34 rather than the generator's 0.22, for the reason in the caveat.
      { key: 'thickness', label: 'Thickness', values: [0.22, 0.34, 0.5], start: 0.34 },
      { key: 'amplitude', label: 'Swing', values: [0.2, 0.34, 0.45], start: 0.34 },
    ],
  },
  {
    name: 'ripple',
    about: 'concentric rings from a few centres, reading as pulses going past',
    dither: 'ordered',
    caveat:
      'Rings fade with distance, so a wide loop is mostly dark: at 736 columns about 3 '
      + 'pixels in 100 are lit. Raise Sources or Falloff to fill it.',
    knobs: [
      { key: 'sources', label: 'Sources', values: [1, 3, 6, 12], start: 3 },
      { key: 'wavelength', label: 'Spacing', values: [4, 6, 10], start: 6 },
      { key: 'falloff', label: 'Falloff', values: [10, 18, 30], start: 18 },
    ],
  },
  {
    name: 'starfield',
    about: 'fixed stars at mixed brightnesses, drifting past',
    dither: 'none',
    caveat:
      'It cannot twinkle, and nothing on this screen can make it: the content is still '
      + 'and only the window moves, so a star crosses the panel at the brightness it '
      + 'was rendered at. Monochrome takes the brightness spread away too, so what is '
      + 'left is drift.',
    knobs: [
      { key: 'density', label: 'Density', values: [0.06, 0.12, 0.25], start: 0.12 },
      { key: 'seed', label: 'Seed', values: [1, 2, 3, 4], start: 1 },
    ],
  },
  {
    name: 'fire',
    about: 'a flame silhouette, leaning so travel reads as rising',
    // The generator defaults to ordered, which is right at 4 levels and wrong here.
    dither: 'none',
    caveat:
      'Flat, not dithered, and deliberately: at two levels ordered dither puts 93 dark '
      + 'cells inside the flame across 240 columns, which reads as moth holes rather '
      + 'than embers.',
    knobs: [
      { key: 'tongue', label: 'Tongue', values: [8, 12, 20], start: 12 },
      { key: 'height', label: 'Height', values: [0.5, 0.62, 0.8], start: 0.62 },
      { key: 'flicker', label: 'Flicker', values: [0.15, 0.33, 0.5], start: 0.33 },
      { key: 'lean', label: 'Lean', values: [0, 3, 6], start: 3 },
    ],
  },
  {
    name: 'mirror',
    about: 'kaleidoscope of another effect, mirror axes crossing the nose bridge',
    dither: 'none',
    caveat:
      'Ordered dither cannot be mirrored, because its thresholds are tied to the panel '
      + 'column, so this one stays flat. Fold counts snap to a divisor of the width, '
      + 'and the snapped figure is the one reported below. Reflecting the starfield is '
      + 'the one combination whose loop may not close, and the report says which: its '
      + 'stars sit on whole columns and a reflected position lands between two.',
    knobs: [
      {
        key: 'inner',
        label: 'Reflect',
        // Not `mirror`: `namedField` refuses to mirror itself, and offering a button
        // that throws is worse than not offering it. `starfield` stays, unlike that
        // one: its mirrored loop fails to close at most fold counts, but the
        // kaleidoscope itself is correct and the screen says so in red, which is the
        // difference between a button that misbehaves and a button that lies. Review
        // 13's measurement and the mechanism are in the caveat and in `offered.test.ts`.
        values: fx.EFFECT_NAMES.filter((n) => n !== 'mirror'),
        start: 'plasma',
      },
      { key: 'folds', label: 'Folds', values: [AUTO, 1, 2, 5, 10, 16], start: AUTO },
    ],
  },
]

const BY_NAME: Record<string, EffectSpec> = Object.assign(
  // No prototype, for the reason `effects.ts` gives its own registries: every name
  // reaching here came from a tap or from stored state, and `BY_NAME['constructor']`
  // on a plain object hands back a function that passes an `if (!spec)` guard.
  Object.create(null) as Record<string, EffectSpec>,
  Object.fromEntries(CATALOGUE.map((spec) => [spec.name, spec])),
)

/** The spec for a name, or a throw naming what there is. */
export function specFor(name: string): EffectSpec {
  const spec = BY_NAME[name]
  if (!spec) {
    throw new Error(`no effect called ${name}. One of: ${CATALOGUE.map((s) => s.name).join(', ')}`)
  }
  return spec
}

/**
 * One shared, frozen bag per effect, built at module load rather than per call.
 *
 * **The identity matters, not just the values.** The screen reads
 * `tuned[name] ?? defaultsFor(name)` and feeds that straight into the memo that renders
 * the loop, so a fresh object per call makes a fresh bitmap on every render - and
 * `Preview` restarts its clock whenever the bitmap it is handed is a new object, which
 * means the preview would jump back to column 0 every time anything else on the screen
 * changed. Frozen because a shared default that anything mutated would poison every later
 * read of it; the screen spreads into a copy to tune.
 */
const DEFAULTS: Record<string, Record<string, KnobValue>> = Object.assign(
  Object.create(null) as Record<string, Record<string, KnobValue>>,
  Object.fromEntries(
    CATALOGUE.map((spec) => [
      spec.name,
      Object.freeze(Object.fromEntries(spec.knobs.map((k) => [k.key, k.start]))),
    ]),
  ),
)

/** Every knob at its opening value, which is what the screen starts a fresh effect on. */
export function defaultsFor(name: string): Record<string, KnobValue> {
  // For the "no effect called X" message, which is the same one every other miss gives.
  specFor(name)
  return DEFAULTS[name]
}

/**
 * A knob bag with the `AUTO` sentinels dropped, ready for `effects`.
 *
 * Dropping rather than mapping to `undefined`, because `mirror`'s `folds` reads
 * `opts.folds ?? columns / (2 * COLS)` and an explicit `undefined` and an absent key
 * are the same thing there. A key holding the string `'auto'` is not.
 */
export const tuning = (opts: Record<string, KnobValue>): Record<string, KnobValue> =>
  Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== AUTO))
