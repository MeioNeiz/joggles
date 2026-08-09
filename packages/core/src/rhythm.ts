/**
 * The rhythm channel: all 24 columns in a single 16-byte write.
 *
 * Every other path to the panel costs one BLE write per column, which is why
 * streaming a full frame sweeps visibly left to right. This one does not sweep at
 * all. The cost is that it draws only vertical bars, from a table of ten ready-made
 * column words the firmware carries, so a bar is a height 0-9 and nothing else.
 *
 * Handler at `abs 0x21b04`, reached from the `...960b` write path at `abs 0x186fc`.
 *
 * ## The wire frame, which is not what the notes said
 *
 * The frame is a **plain command frame**, built by `protocol.frame` like every other
 * one, and there is no mystery byte in it:
 *
 *     [0d][style][12 payload bytes]      13 body bytes, padded to 16, on 960b
 *
 * *derived*, from the disassembly, and it corrects two documents at once.
 * `research/firmware-internals.md` records the frame as `[len][?][style][12]` and
 * `research/vendor-app-protocol.md` as `[15][subchannel][12 bytes]`; the second byte
 * is neither a subchannel nor unknown, and there is no fourth field. Both readings
 * come from counting the handler's own offsets as wire offsets. They are not: the
 * handler is passed a struct whose frame data starts one byte in, so its
 * `[frame+2]` is wire index 1 and its `[frame+3..14]` are wire indices 2 to 13.
 * That is the same `[r4 + n + 1]` relationship `firmware-internals.md` already
 * establishes for the command dispatcher, applied to the handler it did not apply
 * it to. Reasoning and the byte-level walk: `research/rhythm-channel.md`.
 *
 * ## Two conditions, and one of them can corrupt the panel
 *
 * The 960b handler routes by **wire length**, then by state:
 *
 *  - length 4 to 5, which is every live column write, always goes to the single
 *    column store. `LiveSender` is untouched by any of this.
 *  - length 6 to 20 goes to the rhythm handler, but **only if the unit is not in
 *    DIY** (`SMVEW 01`/`03`) and the panel's own power flag is set. In DIY the
 *    same frame is handed to the single column store instead, where the style byte
 *    is read as a column index and three payload bytes as pixels: it writes a
 *    garbage column rather than being ignored.
 *
 * So: **leave DIY before sending rhythm frames, and never interleave these with
 * `LiveSender`**. `protocol.exitDIY()` is the way out, `protocol.exitRhythm()` is
 * the way back to saved content.
 *
 * ## What is still unknown
 *
 * Nothing has been sent to hardware. The frame layout, the two conditions and both
 * bar tables are read off the image and the tables are `4^n - 1` shaped exactly as
 * nine rows at one level should be, but the whole file is *derived* until a session
 * with the glasses runs `packages/cli/src/rhythm.ts` and someone looks at the panel.
 */
import type { Bitmap } from './content.js'
import { COLS, MAX_LEVEL, ROWS } from './display.js'
import { frame } from './protocol.js'

/** Payload bytes in every frame, whatever the style reads of them. */
export const PAYLOAD_BYTES = 12

/** Bar heights run 0 to 9, one per table entry. */
export const MAX_HEIGHT = 9

/**
 * Column words for each height, straight out of the image.
 *
 * A word is the same 2-bits-per-pixel column the live path uses, so `0x3ffff` is
 * eighteen bits: nine rows at level 3. The tapered table is the same nine rows in
 * three bands of brightness, which is the only greyscale the firmware ever draws
 * by itself.
 */
export const SOLID_BARS: readonly number[] = [
  0x0, 0x3, 0xf, 0x3f, 0xff, 0x3ff, 0xfff, 0x3fff, 0xffff, 0x3ffff,
]

/** Rows 0-2 at level 3, rows 3-5 at level 2, rows 6-8 at level 1. `abs 0x22dd0`. */
export const TAPERED_BARS: readonly number[] = [
  0x0, 0x3, 0xf, 0x3f, 0xbf, 0x2bf, 0xabf, 0x1abf, 0x5abf, 0x15abf,
]

/** The four styles the handler accepts. Anything else draws nothing. */
export type Style = 0 | 1 | 2 | 3

export interface StyleSpec {
  /** Bars across the panel, which is also how many heights `encode` wants. */
  bars: number
  /** Columns each bar occupies. */
  barWidth: number
  /** Blank columns after each bar. */
  gap: number
  table: readonly number[]
  /** Payload bytes the handler actually reads. The rest are sent and ignored. */
  bytesUsed: number
}

/**
 * What each style does, read off its arm of the handler.
 *
 * They differ in bar width, not in animation: style 0 is the only one that uses the
 * solid table, and 2 and 3 read fewer payload bytes because their bars are wider.
 * Every one of them fills exactly 24 columns.
 */
export const STYLES: readonly StyleSpec[] = [
  { bars: 24, barWidth: 1, gap: 0, table: SOLID_BARS, bytesUsed: 12 },
  { bars: 24, barWidth: 1, gap: 0, table: TAPERED_BARS, bytesUsed: 12 },
  { bars: 12, barWidth: 2, gap: 0, table: TAPERED_BARS, bytesUsed: 6 },
  { bars: 8, barWidth: 2, gap: 1, table: TAPERED_BARS, bytesUsed: 4 },
]

export const spec = (style: Style): StyleSpec => STYLES[style]

/** Heights this style expects. 24, 24, 12 and 8. */
export const barCount = (style: Style): number => STYLES[style].bars

const clampHeight = (v: number): number =>
  Math.max(0, Math.min(MAX_HEIGHT, Math.round(Number.isFinite(v) ? v : 0)))

/**
 * Resample a run of heights to `n` of them, by averaging each source window.
 *
 * For handing 24-bar analyser output to a style that draws 12 or 8 bars. Averaging
 * rather than dropping, so a peak in a discarded bin still moves its bar.
 */
export function toBars(heights: readonly number[], n: number): number[] {
  if (n <= 0) return []
  if (heights.length === 0) return new Array(n).fill(0)
  return Array.from({ length: n }, (_, i) => {
    const lo = Math.floor((i * heights.length) / n)
    const hi = Math.max(lo + 1, Math.floor(((i + 1) * heights.length) / n))
    let sum = 0
    for (let j = lo; j < hi; j++) sum += clampHeight(heights[j])
    return clampHeight(sum / (hi - lo))
  })
}

/**
 * One rhythm frame, ready to encrypt and write to `CHAR_BULK_B`.
 *
 * `heights` must be exactly `barCount(style)` long. It is a throw rather than a
 * pad because a caller that hands 24 heights to style 3 has not resampled, and
 * silently keeping the first eight of them is a wrong picture rather than an error.
 * `toBars` is the resampler.
 *
 * Heights outside 0-9 are clamped here, and that matters: the firmware's own
 * out-of-range check replaces a height of 10 or more with **0**, not with 9, so an
 * unclamped loud bar would blank its column instead of topping out.
 */
export function encode(heights: readonly number[], style: Style = 0): Uint8Array {
  const want = barCount(style)
  if (heights.length !== want) {
    throw new Error(`style ${style} takes ${want} heights, got ${heights.length}`)
  }
  const payload = new Array(PAYLOAD_BYTES).fill(0)
  heights.forEach((h, i) => {
    const nibble = clampHeight(h)
    // Two heights per byte, low nibble first: the handler reads bar 2n from
    // `byte & 0xf` and bar 2n+1 from `byte >> 4`.
    if (i % 2 === 0) payload[i >> 1] |= nibble
    else payload[i >> 1] |= nibble << 4
  })
  return frame('', style, ...payload)
}

/** The heights carried by a frame `encode` built. For decoding captured traffic. */
export function decode(f: Uint8Array): { style: Style; heights: number[] } | null {
  const len = f[0]
  if (len !== 1 + PAYLOAD_BYTES || f.length < 2 + PAYLOAD_BYTES) return null
  const style = f[1]
  if (style < 0 || style > 3) return null
  const all: number[] = []
  for (let i = 0; i < PAYLOAD_BYTES; i++) {
    all.push(f[2 + i] & 0xf, (f[2 + i] >> 4) & 0xf)
  }
  return { style: style as Style, heights: all.slice(0, barCount(style as Style)) }
}

/**
 * The panel the firmware would build from these heights, as a `Bitmap`.
 *
 * Exact, not an approximation: it indexes the same two tables and unpacks the same
 * column words, so a preview showing a gap means the panel shows a gap. It does not
 * mask the dead pixels, because the firmware does not either; a full-height bar in
 * the nose notch is drawn and simply has no LEDs under part of it.
 */
export function render(heights: readonly number[], style: Style = 0): Bitmap {
  const { barWidth, gap, table } = spec(style)
  const out: Bitmap = Array.from({ length: ROWS }, () => new Array(COLS).fill(0))
  let col = 0
  for (const h of heights) {
    const word = table[clampHeight(h)]
    for (let w = 0; w < barWidth && col < COLS; w++, col++) {
      for (let r = 0; r < ROWS; r++) out[r][col] = (word >> (2 * r)) & MAX_LEVEL
    }
    col += gap
  }
  return out
}

export interface SpectrumOptions {
  /** Bars to produce. Defaults to the panel's 24; pass `barCount(style)` for 2 or 3. */
  bars?: number
  /**
   * Sample rate of the audio the bins came from. Given it, bands are spaced
   * logarithmically in **hertz**, which is what an ear hears as even. Without it
   * they are spaced logarithmically in bin index, which is the same shape and the
   * wrong scale, and is only there so band data of unknown provenance still works.
   */
  sampleRate?: number
  /** Lowest band edge. Below ~60 Hz the panel is showing rumble. */
  minHz?: number
  /** Highest band edge. */
  maxHz?: number
  /** Level mapping to height 0. Anything quieter is a dark column. */
  floorDb?: number
  /** Level mapping to height 9. Anything louder tops out. */
  ceilingDb?: number
  /** What the numbers are. Amplitude by default; `power` squares it, `db` is used as is. */
  input?: 'magnitude' | 'power' | 'db'
}

/**
 * Spectrum bins to bar heights. Pure, so it is the testable half of the feature.
 *
 * `magnitudes[i]` is taken to cover the band centred at `(i + 0.5) * nyquist /
 * magnitudes.length`, which is what a real-valued FFT's magnitude array is. The
 * band value is the **loudest** bin in it rather than the mean: the high bands are
 * many bins wide, and averaging buries a hi-hat under the silence either side of it.
 *
 * Nothing here is stateful. Bar decay is `smooth`, which takes the previous frame
 * as an argument, so a caller holds the only state there is.
 */
export function fromSpectrum(
  magnitudes: readonly number[],
  opts: SpectrumOptions = {},
): number[] {
  const {
    bars = COLS,
    sampleRate,
    minHz = 60,
    maxHz = 8000,
    floorDb = -60,
    ceilingDb = -12,
    input = 'magnitude',
  } = opts
  if (bars <= 0) return []
  const n = magnitudes.length
  if (n === 0) return new Array(bars).fill(0)

  // Band edges in bin space. With a sample rate they are hertz mapped back to bins,
  // capped at the top bin so a maxHz above Nyquist degrades to "up to Nyquist"
  // rather than to empty bands.
  const nyquist = sampleRate ? sampleRate / 2 : 0
  const toBin = (hz: number) => (hz / nyquist) * n
  const highest = sampleRate ? Math.min(toBin(maxHz), n) : n
  // Held below `highest` whatever was asked for, so a minHz above Nyquist cannot
  // invert the band edges and turn every band into the empty-band fallback.
  const lowest = sampleRate ? Math.max(Math.min(toBin(minHz), highest / 2), 0.5) : 0.5
  const ratio = highest / lowest

  const span = ceilingDb - floorDb
  return Array.from({ length: bars }, (_, b) => {
    const lo = lowest * ratio ** (b / bars)
    const hi = lowest * ratio ** ((b + 1) / bars)
    // -Infinity rather than 0 for dB input, where 0 is a very loud bin and would
    // floor every band at full height.
    let peak = input === 'db' ? -Infinity : 0
    let seen = 0
    for (let i = 0; i < n; i++) {
      const centre = i + 0.5
      if (centre < lo || centre >= hi) continue
      seen++
      peak = Math.max(peak, level(magnitudes[i], input))
    }
    // Bands narrower than a bin are common at the bottom end, where log spacing
    // asks for more resolution than the transform has. Reuse the nearest bin
    // rather than drawing a hole.
    if (seen === 0) {
      const i = Math.min(n - 1, Math.max(0, Math.round((lo + hi) / 2 - 0.5)))
      peak = level(magnitudes[i], input)
    }
    const db = input === 'db' ? peak : peak > 0 ? 20 * Math.log10(peak) : -Infinity
    if (!Number.isFinite(db) || span <= 0) return db >= ceilingDb ? MAX_HEIGHT : 0
    return clampHeight(((db - floorDb) / span) * MAX_HEIGHT)
  })
}

/** Magnitude domain, before the dB conversion. `power` is amplitude squared. */
function level(v: number, input: SpectrumOptions['input']): number {
  if (!Number.isFinite(v)) return input === 'db' ? -Infinity : 0
  if (input === 'power') return Math.sqrt(Math.max(0, v))
  if (input === 'db') return v
  return Math.abs(v)
}

export interface SmoothOptions {
  /** Fraction of an increase taken immediately. 1 means bars jump straight up. */
  rise?: number
  /** Fraction of a decrease taken per frame. Low numbers make bars fall slowly. */
  fall?: number
}

/**
 * Ease this frame's heights towards the last frame's. Pure: state is the caller's.
 *
 * Bars that track the spectrum exactly look like noise, because a 20ms frame is
 * shorter than the eye integrates. Rising fast and falling slowly is what reads as
 * a level meter, and it is one line of arithmetic rather than a filter.
 */
export function smooth(
  previous: readonly number[],
  next: readonly number[],
  opts: SmoothOptions = {},
): number[] {
  const { rise = 1, fall = 0.34 } = opts
  return next.map((v, i) => {
    const was = clampHeight(previous[i] ?? 0)
    const want = clampHeight(v)
    if (want === was) return was
    // Rounding to nearest would strand a bar: 34% of a one-step drop rounds back
    // to where it started and the bar never reaches zero. Ceiling on the way up and
    // floor on the way down both move at least one step and neither overshoots,
    // because heights are integers and `eased` stays between the two.
    const eased = was + (want - was) * (want > was ? rise : fall)
    return clampHeight(want > was ? Math.ceil(eased) : Math.floor(eased))
  })
}
