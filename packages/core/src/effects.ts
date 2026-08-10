/**
 * Wide seamless loops, computed here in floating point and uploaded once.
 *
 * This is the battery-friendly way to have good visuals: render up to 736
 * columns on the host, `DATS` them across in one handshake, drop the connection
 * and let the device scroll them all night with the radio off. Nothing in this
 * file talks to a device or knows a wire format; it produces `content.Bitmap`
 * and stops, which is what makes it previewable with no hardware attached.
 *
 * Three constraints shape every generator here, and they are not obvious:
 *
 * **The only motion a saved loop has is horizontal travel.** `MODE 02` slides
 * the stored buffer one column per step and that is the whole of its vocabulary.
 * So an effect is a *still image* whose left-to-right traverse reads as
 * animation, and anything that should appear to move up or down has to be baked
 * in as diagonal structure. A bouncing disc cannot come from here at all
 * (`notes/what-to-build.md`, "Bouncing disc"), and neither can a twinkle: a star
 * drawn at one brightness simply travels past at that brightness.
 *
 * **Seamless means periodic in x with period exactly the width**, because the
 * device wraps the buffer and the join is as visible as any other column. It is
 * a property of construction here, not something checked after the fact: every
 * generator rounds its cycle counts to whole numbers, so a caller cannot ask for
 * a field that fails to close. `seam()` is only the backstop, and it has two
 * blind spots worth knowing before trusting it (see its own note).
 *
 * The dither has to close too. Its 8-column tile phase jumps at the join unless
 * the width is a multiple of `TILE`, which is what `seamlessWidth` is for and why
 * every width reaching `render` goes through it. That the phase then continues
 * exactly is *verified* structurally by `effects.test.ts`; whether an unsnapped
 * width would actually be *visible* is *unverified*, because `seam()` cannot tell
 * the two apart - ordered dither already changes every column enough to bury a
 * tile shear. The snap costs at most 7 columns, so it is kept as cheap insurance
 * rather than because the artefact has been seen.
 *
 * **Quantisation is the look, not a compromise.** Two or three summed sines cut
 * to 4 levels give moving contour bands, which is the classic plasma. Ordered
 * dither is the default because it is what turns a gradient into texture rather
 * than into stripes, but `dither: 'none'` is a legitimate choice and the sharper
 * one for anything already high-contrast.
 *
 * **A loop wider than the panel has to be monochrome.** One grey pixel sends
 * `content.savedType` to type 2, which the device shows 24 columns of and
 * forgets at power off, so a 736-column greyscale loop is 97% invisible and does
 * not survive the night. Render with `levels: 2` for anything going to the saved
 * route wide; `levels: 4` is for the 24-column type 2 and live paths. See
 * `content.ts` and the "Type 1 saves 740 columns" entry in `CLAUDE.md`.
 *
 * Dead pixels are *not* masked here. `alive()` maps fixed panel positions, and
 * the content moves past them, so masking wide content draws a hole that travels
 * with the picture. `viewport.windowAt` applies it at the window, where it
 * belongs.
 */
import { type Bitmap, blank, maxColumns, width } from './content.js'
import * as dats from './dats.js'
import { MAX_LEVEL, ROWS } from './display.js'

/** Ordered-dither tile, and therefore the granularity every loop width snaps to. */
export const TILE = 8

/** Widest loop that both fits type 1 and lands on a tile boundary: 736. */
export const MAX_COLUMNS = Math.floor(maxColumns(dats.TYPE_TEXT) / TILE) * TILE

/** ~27 seconds at the device's middle scroll rate. Wide enough to read as a loop. */
export const DEFAULT_COLUMNS = 240

/**
 * Columns per second at `SPEED` 0 and `SPEED` 100, from `content.ts`. Here so
 * that "how long is this loop" can be answered without a device.
 */
export const SLOWEST_SCROLL = 3.8
export const FASTEST_SCROLL = 12.5

/** How long one pass takes at the device's two extremes, in seconds. */
export const loopSeconds = (columns: number): { slowest: number; fastest: number } => ({
  slowest: columns / SLOWEST_SCROLL,
  fastest: columns / FASTEST_SCROLL,
})

/**
 * A width that closes: a multiple of `TILE`, at least one tile, never past the
 * type 1 ceiling.
 *
 * Rounds **down** rather than to nearest, so asking for the maximum cannot hand
 * back something the device refuses. Asking for 740 gives 736 and that is the
 * real ceiling for a dithered loop.
 */
export function seamlessWidth(columns: number): number {
  // NaN would survive every clamp below and reach `blank()` as an array length,
  // where it fails with a message about safe magnitudes and no clue where it
  // came from. Infinity is rejected with it rather than quietly meaning "widest".
  if (!Number.isFinite(columns)) throw new Error(`columns must be a number, got ${columns}`)
  const capped = Math.min(Math.max(columns, TILE), MAX_COLUMNS)
  return Math.max(TILE, Math.floor(capped / TILE) * TILE)
}

/** Where a sample sits, in both the units a field might want. */
export interface Sample {
  /** Position round the loop, `0 <= u < 1`. Use whole cycles of this and it closes. */
  u: number
  /** 0 at the bottom row, 1 at the top. The panel does not wrap vertically. */
  v: number
  col: number
  row: number
  columns: number
}

/** Brightness at a point, 0 to 1. Values outside that are clamped, not wrapped. */
export type Field = (s: Sample) => number

export interface RenderOptions {
  /** Requested width. Snapped by `seamlessWidth`, so ask for what you want. */
  columns?: number
  /** 4 for the live and type 2 paths, 2 for anything saved wider than the panel. */
  levels?: 2 | 4
  dither?: 'ordered' | 'none'
}

// Bayer 8x8. Values 0-63, each appearing once, so the thresholds spread evenly
// across the interval instead of clustering.
const BAYER = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
]

/**
 * The dither threshold at a panel coordinate, in `[0, 1)`.
 *
 * Exported because the loop's seam depends on it being periodic in `col` with
 * period `TILE`, and that is a property worth asserting directly rather than
 * inferring from how a rendered picture looks.
 */
export const threshold = (row: number, col: number): number =>
  (BAYER[((row % TILE) + TILE) % TILE][((col % TILE) + TILE) % TILE] + 0.5) / 64

/**
 * A value in 0-1 to a panel level, with `t` the dither threshold for the cell.
 *
 * `NaN` is a level, not an error, once it is in the array: every comparison
 * against it is false, so it walks straight through a clamp written as
 * `Math.min(Math.max(...))` and lands in the bitmap. It gets caught eventually by
 * `content.check`, several files away, as "levels must be integers 0 to 3", which
 * says nothing about the field that produced it. One `Number.isFinite` here is
 * the difference between that and a black pixel.
 */
function quantise(value: number, t: number, levels: 2 | 4): number {
  const steps = levels - 1
  const v = !Number.isFinite(value) ? 0 : value <= 0 ? 0 : value >= 1 ? 1 : value
  const q = Math.min(steps, Math.max(0, Math.floor(v * steps + t)))
  return q * (MAX_LEVEL / steps)
}

/** One turn of a sine, `-1` to `1`. Whole `t` cycles round the loop close it. */
const turn = (t: number): number => Math.sin(2 * Math.PI * t)

/**
 * Sample a field into a bitmap. Every generator below is one call to this.
 *
 * The width is snapped before anything is sampled, so `u` divides the width the
 * caller actually gets and the join is exact rather than nearly right.
 */
export function render(field: Field, opts: RenderOptions = {}): Bitmap {
  const columns = seamlessWidth(opts.columns ?? DEFAULT_COLUMNS)
  const levels = opts.levels ?? 4
  // Only 2 and 4 divide MAX_LEVEL, and anything else would put a fractional level
  // in the bitmap: legal-looking, and rejected much later by content.check with a
  // message about integers that says nothing about where it came from. The type
  // already rules it out, so this is here for the untyped caller, meaning the CLI.
  if (levels !== 2 && levels !== 4) throw new Error(`levels must be 2 or 4, got ${levels}`)
  const ordered = (opts.dither ?? 'ordered') === 'ordered'
  const out = blank(columns)
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < columns; col++) {
      const value = field({ u: col / columns, v: row / (ROWS - 1), col, row, columns })
      out[row][col] = quantise(value, ordered ? threshold(row, col) : 0.5, levels)
    }
  }
  return out
}

export interface Seam {
  /** Mean absolute level change from the last column to the first. */
  wrap: number
  /** The sharpest join anywhere inside the loop. */
  worst: number
  /** The average join inside the loop. */
  mean: number
  /** The join is no sharper than the sharpest the picture already contains. */
  seamless: boolean
}

/**
 * How visible the join is, against the joins the picture already has.
 *
 * Absolute thresholds do not work here: a hard-edged barber pole has a mean
 * column-to-column change an order of magnitude above a plasma's, and both are
 * seamless. The question is only whether the wrap is an outlier, so it is
 * measured against the same picture's own worst interior join.
 *
 * **It is a coarse backstop and it is weaker than it looks.** It reads the
 * quantised bitmap, so a discontinuity smaller than one of the four levels is
 * not there to be measured. Rendering fields with deliberate faults on
 * 2026-08-09 found three things it reports clean:
 *
 *   - **a loop built against `col` instead of `u`**, which is the mistake that
 *     matters. A sine of period 100 laid across 240 columns is 2.4 cycles and
 *     visibly open, and this passes it, because quantising put both ends of the
 *     join in the same level. `fieldGap` is what actually catches that, and it
 *     is what the tests assert on
 *   - a *fold*, where the field arrives back at the same value travelling the
 *     other way. Whole cycle counts are what rule that out
 *   - the dither tile phase, buried by ordered dither's own column-to-column
 *     noise
 *
 * What it does catch is a level jump at the join, from roughly a fifth of a
 * cycle of error upwards. Useful on a bitmap that arrived from somewhere else,
 * which is the only case where the field is not available to check instead.
 */
export function seam(bitmap: Bitmap): Seam {
  const cols = width(bitmap)
  const rows = Math.min(bitmap.length, ROWS)
  // Missing cells read as dark rather than as NaN. A ragged bitmap otherwise
  // reports `wrap: NaN`, which compares false against everything and so comes
  // back as `seamless: false` with no number to explain it. `content.normalise`
  // is the way to get a rectangle if you have one to hand.
  const at = (r: number, c: number): number => bitmap[r]?.[c] ?? 0
  const join = (a: number, b: number): number => {
    let sum = 0
    for (let r = 0; r < rows; r++) sum += Math.abs(at(r, a) - at(r, b))
    return sum / (rows || 1)
  }
  if (cols < 2) return { wrap: 0, worst: 0, mean: 0, seamless: true }

  let worst = 0
  let total = 0
  for (let c = 0; c + 1 < cols; c++) {
    const g = join(c, c + 1)
    if (g > worst) worst = g
    total += g
  }
  const wrap = join(cols - 1, 0)
  return { wrap, worst, mean: total / (cols - 1), seamless: wrap <= worst }
}

/**
 * How far a field is from closing, measured before anything quantises it.
 *
 * This is the real check, and `seam` is only the fallback for when the field has
 * already been thrown away. It asks the physical question directly: is the
 * column *after* the last one the same as the first, and is the column *before*
 * the first the same as the last? Both are zero for a field that closes, at full
 * float precision, so an error a fifth the size of a level still shows up where
 * `seam` cannot see it at all.
 *
 * Sampling one column either side rather than only at `u = 0` is what catches a
 * fold: half a cycle out returns to the same value travelling the other way, so
 * the value matches and its neighbour does not.
 *
 * **It samples outside `0..columns-1`, so a field that indexes on `col` has to
 * wrap it.** `ripple` and `starfield` both do, and they would be seamless either
 * way, since one measures distance the short way round and the other is
 * uncorrelated everywhere. Wrapping is what makes the property measurable rather
 * than merely true, which is the difference between the two halves of this file.
 */
export function fieldGap(field: Field, opts: RenderOptions = {}): number {
  const columns = seamlessWidth(opts.columns ?? DEFAULT_COLUMNS)
  const at = (col: number, row: number): number =>
    field({ u: col / columns, v: row / (ROWS - 1), col, row, columns })
  let worst = 0
  for (let row = 0; row < ROWS; row++) {
    worst = Math.max(
      worst,
      Math.abs(at(columns, row) - at(0, row)),
      Math.abs(at(-1, row) - at(columns - 1, row)),
    )
  }
  return worst
}

export interface PlasmaOptions extends RenderOptions {
  /** Sine cycles round the loop. Rounded to a whole number, or it would not close. */
  cycles?: number
  /** Cycles up the panel. Any number: nothing wraps vertically. */
  rise?: number
  /** How far the first sine bends the second's phase. 0 gives flat bands. */
  warp?: number
}

/**
 * Summed sines cut to 4 levels: moving contour bands, the classic plasma.
 *
 * The banding is the point. Raising `levels` is not an option the hardware
 * offers and smoothing it away with dither is usually the wrong call here, but
 * `dither: 'ordered'` stays the default because at 9 rows the bands are wide and
 * a little texture inside them reads better than flat slabs.
 */
export function plasmaField(opts: PlasmaOptions = {}): Field {
  const cycles = Math.max(1, Math.round(opts.cycles ?? 3))
  const rise = opts.rise ?? 1
  const warp = opts.warp ?? 0.35
  return ({ u, v }) => {
    const a = turn(cycles * u)
    const b = turn(rise * v + warp * a)
    const c = turn(2 * cycles * u + rise * v)
    return (a + b + c) / 6 + 0.5
  }
}

export const plasma = (opts: PlasmaOptions = {}): Bitmap =>
  render(plasmaField(opts), opts)

export interface StripesOptions extends RenderOptions {
  /** Bands round the loop. Rounded to a whole number. */
  cycles?: number
  /** Bands of shift between the bottom row and the top. 0 gives vertical bars. */
  shear?: number
  /** Sine gradient rather than hard edges. */
  soft?: boolean
  /** Lit fraction of each band when hard-edged. */
  duty?: number
}

/**
 * A barber pole. Hard-edged and monochrome it is the most legible thing on this
 * panel, and at 9 rows a shear of about half a band gives an unmistakable
 * direction of travel.
 */
export function stripesField(opts: StripesOptions = {}): Field {
  const cycles = Math.max(1, Math.round(opts.cycles ?? 12))
  const shear = opts.shear ?? 0.5
  const soft = opts.soft ?? true
  const duty = opts.duty ?? 0.5
  return ({ u, v }) => {
    const phase = cycles * u + shear * v
    return soft ? 0.5 + 0.5 * turn(phase) : phase - Math.floor(phase) < duty ? 1 : 0
  }
}

export const stripes = (opts: StripesOptions = {}): Bitmap =>
  render(stripesField(opts), opts)

export interface WaveOptions extends RenderOptions {
  /** Cycles of the fundamental round the loop. Rounded to a whole number. */
  cycles?: number
  /** A second whole cycle count summed in, which stops it looking like a sine. */
  harmonic?: number
  /** Peak excursion from the centre row, as a fraction of the panel height. */
  amplitude?: number
  /** Ribbon half-height, same units. Below about 0.12 it breaks up. */
  thickness?: number
}

/**
 * A travelling waveform: one bright ribbon, everything else dark.
 *
 * The most useful effect on a panel this short, because it spends its pixels on
 * a single readable shape rather than spreading them over the whole field. The
 * ribbon is anti-aliased across the levels, so at `levels: 2` set `thickness`
 * higher or it flickers between one row and two.
 */
export function waveField(opts: WaveOptions = {}): Field {
  const cycles = Math.max(1, Math.round(opts.cycles ?? 4))
  const harmonic = Math.max(1, Math.round(opts.harmonic ?? cycles * 2))
  const amplitude = opts.amplitude ?? 0.34
  const thickness = Math.max(0.05, opts.thickness ?? 0.22)
  return ({ u, v }) => {
    const h = 0.5 + amplitude * (0.7 * turn(cycles * u) + 0.3 * turn(harmonic * u + 0.25))
    return Math.max(0, 1 - Math.abs(v - h) / thickness)
  }
}

export const wave = (opts: WaveOptions = {}): Bitmap => render(waveField(opts), opts)

export interface RippleOptions extends RenderOptions {
  /** Ring centres, spread evenly round the loop. */
  sources?: number
  /** Columns between one ring and the next. */
  wavelength?: number
  /** Columns over which a ripple dies away to nothing. */
  falloff?: number
}

/**
 * Concentric rings from a few points, which read as pulses travelling past.
 *
 * Periodic because the distance to each centre is measured the short way round
 * the loop, so the field at column `columns` is the field at column 0 whatever
 * the spacing works out to.
 */
export function rippleField(opts: RippleOptions = {}): Field {
  const sources = Math.max(1, Math.round(opts.sources ?? 3))
  const wavelength = Math.max(2, opts.wavelength ?? 6)
  const falloff = Math.max(1, opts.falloff ?? 18)
  const mid = (ROWS - 1) / 2
  return ({ col, row, columns }) => {
    let best = 0
    for (let i = 0; i < sources; i++) {
      // Wrapped both ways, so a column one past the end is a column at the start.
      // `col` can sit outside 0..columns-1 when `fieldGap` probes the join.
      const gap = Math.abs(((col % columns) + columns) % columns - (i * columns) / sources)
      const dx = Math.min(gap, columns - gap)
      const d = Math.hypot(dx, row - mid)
      const ring = 0.5 + 0.5 * Math.cos((2 * Math.PI * d) / wavelength)
      best = Math.max(best, ring * Math.max(0, 1 - d / falloff))
    }
    return best
  }
}

export const ripple = (opts: RippleOptions = {}): Bitmap => render(rippleField(opts), opts)

export interface StarfieldOptions extends RenderOptions {
  /** Fraction of cells lit, 0 to 1. */
  density?: number
  seed?: number
}

/**
 * Fixed stars at mixed brightnesses, drifting past.
 *
 * **It cannot twinkle**, and no version of this file can make it: the content is
 * still and only the window moves, so a star's brightness is whatever it was
 * rendered at for the whole time it is on screen. Depth comes from the spread of
 * brightnesses instead, which is why this one defaults to no dither: ordered
 * dither on isolated single pixels turns half the field off rather than shading
 * it.
 */
export function starfieldField(opts: StarfieldOptions = {}): Field {
  const density = Math.min(1, Math.max(0, opts.density ?? 0.12))
  const seed = Math.round(opts.seed ?? 1)
  return ({ col, row, columns }) => {
    // Wrapped, so the lookup is a function of position round the loop rather than
    // of an unbounded index, which is what stops the join being a visible edge.
    const c = ((col % columns) + columns) % columns
    if (hash(c, row, seed) >= density) return 0
    return 0.34 + 0.66 * hash(c, row, seed + 977)
  }
}

export const starfield = (opts: StarfieldOptions = {}): Bitmap =>
  // Spread first, then re-apply the default, so an explicit `dither: undefined`
  // means "the default for this effect" rather than "whatever render's is".
  render(starfieldField(opts), { ...opts, dither: opts.dither ?? 'none' })

/** Stable per-cell noise. Integer in, `[0, 1)` out, same answer every run. */
function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/**
 * Every generator by name, so a preview or a screen can offer the list without
 * knowing what is in it.
 *
 * `effects.test.ts` walks this and `FIELDS` rather than naming effects one at a
 * time, so a generator added later is held to closure, level range and monochrome
 * at `levels: 2` without anyone remembering to write the tests.
 */
export const EFFECTS: Record<string, (opts?: RenderOptions) => Bitmap> = {
  plasma,
  stripes,
  wave,
  ripple,
  starfield,
}

/**
 * The same five as fields, before anything quantises them.
 *
 * Here so `fieldGap` can be run over every shipped generator rather than only
 * over fields written inside a test. That distinction is the whole point: the
 * check that has teeth has to reach the real thing.
 */
export const FIELDS: Record<string, (opts?: RenderOptions) => Field> = {
  plasma: plasmaField,
  stripes: stripesField,
  wave: waveField,
  ripple: rippleField,
  starfield: starfieldField,
}

export const EFFECT_NAMES: string[] = Object.keys(EFFECTS)
