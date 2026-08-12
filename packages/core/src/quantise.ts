/**
 * An arbitrary RGBA frame down to this panel's 24x9 four-level reality.
 *
 * `anim.ts` names the division of labour: decoding a source into `RgbaFrame`s is the
 * decoder's job, what the panel's stores can honestly do with the result is `anim.ts`'s,
 * and the drop from full-colour pixels to 216 LEDs at four levels happens here, once, so
 * a preview and an upload cannot disagree about what a picture became.
 *
 * The pipeline is a fixed order, because most steps only work on one side of another:
 *
 *  1. **Alpha composites over black.** A transparent pixel is an unlit pixel: there is
 *     no white page behind an LED panel, so black is the physical truth rather than a
 *     convention. It follows that `invert` lights a transparent background - flatten
 *     line art onto white upstream if the strokes are what should end up lit.
 *  2. **Luminance is taken in linear light.** Each sRGB channel is gamma-decoded before
 *     the Rec. 709 weighting, because averaging gamma-encoded channels is the classic
 *     mistake that lands saturated colours a level too dark and makes everything muddy
 *     at low bit depth. The value stays linear through the resize for the same reason.
 *  3. **Resize is a box average, never point sampling.** Sources are typically 32-128px,
 *     so a nearest-neighbour sample keeps one pixel in tens and throws the rest away,
 *     and on an animation it makes small pixel art flicker as features fall on and off
 *     the sample points; the box average keeps every source pixel's light, weighted by
 *     how much of the target cell it covers. `contain` letterboxes, `cover` fills and
 *     crops centred, `stretch` distorts. `contain` snaps its fitted rectangle to whole
 *     target pixels: at 24x9 a half-covered boundary column reads as a dim artefact
 *     stripe down the picture's edge, so up to half a pixel of aspect error is the
 *     better trade.
 *  4. **Rows flip here, once.** Image row 0 is the top; this panel's row 0 is the
 *     BOTTOM, and `content.Bitmap` is always already flipped, so this is the one place
 *     in the repo where the two conventions meet.
 *  5. **Quantise**, after a single perceptual re-encode. The encode back to sRGB happens
 *     only now, downstream of all the averaging, so the levels spread by how bright
 *     things look rather than by photon count. `gain` multiplies this perceptual value,
 *     after `invert`, so it always brightens what will actually be lit. `levels: 4` is
 *     0..`display.MAX_LEVEL`; `levels: 2` is 0 and 3 and never 0 and 1, because `LIGHT`
 *     floors at level 1 and a "lit" pixel on this panel means fully lit. At levels 2,
 *     `threshold` is the perceptual grey at which a pixel lights; a dither spreads
 *     pixels either side of it instead of cutting at it.
 *  6. **Dead LEDs are masked last**, with `display.alive()`, after the dither has made
 *     every decision, so a masked pixel cannot bleed into a dither decision about its
 *     neighbours: they are shaded for the picture, and the hole is the panel's.
 *
 * **The ordered dither is `effects.ts`'s dither**, imported rather than copied, because
 * two dithers for one panel is drift waiting to happen: the tile, its `threshold()`
 * arithmetic and the levels-2-means-0-or-3 rule are shared, so an effect and an imported
 * image shade a gradient identically. Ordered is the default for an honesty reason, not
 * a taste one: its thresholds are fixed to panel coordinates, so a still image dithers
 * the same way every frame and stays still. Floyd-Steinberg buys smoother tone on a
 * still and cannot hold that promise on an animation - the diffused error re-routes
 * around every changed pixel, so texture crawls even where the source did not move.
 * That is why `floyd` is offered for stills and is never the default.
 *
 * `toAnimation` maps `toBitmap` over the frames and carries each `delayMs` through
 * **unchanged, including 0**: `anim.normalise()` owns the zero-delay convention and the
 * merging of repeated frames, and doing half of that here would put the rule in two
 * places. Callers are expected to normalise.
 *
 * `packBitmap`/`unpackBitmap` exist so hundreds of animations can be checked in without
 * bloating the repo: 2 bits per pixel, 216 pixels in 54 bytes, 72 base64 characters per
 * frame, against 216 characters a frame for the digit strings `builtins-data.ts` uses -
 * fine for 30 built-ins, megabytes for a library. The base64 is hand-rolled because
 * core has zero dependencies and React Native ships none of Node's byte helpers
 * (`safe-surface.test.ts` scans for them by name), and the app's `base64.ts` sits on
 * the wrong side of the package boundary to import.
 */
import type { Animation, RgbaFrame } from './anim.js'
import { type Bitmap, blank, centreOffset } from './content.js'
import { COLS, MAX_LEVEL, ROWS, alive } from './display.js'
import { threshold as bayer } from './effects.js'

export interface QuantiseOptions {
  fit?: 'contain' | 'cover' | 'stretch'
  levels?: 2 | 4
  dither?: 'none' | 'ordered' | 'floyd'
  /** Multiply luminance before quantising, for sources that land too dark. Default 1. */
  gain?: number
  invert?: boolean
  /** Only used at levels 2. Default is a mid threshold. */
  threshold?: number
}

type Fit = NonNullable<QuantiseOptions['fit']>
type Dither = NonNullable<QuantiseOptions['dither']>

/** sRGB byte to linear light, as a table because every pixel of every frame reads it. */
const LINEAR = new Float64Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Linear light back to perceptual sRGB, applied once, after all the averaging. */
const perceptual = (v: number): number =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055

/** One panel-shaped `Bitmap` from one source frame. The pipeline in the module note. */
export function toBitmap(frame: RgbaFrame, opts: QuantiseOptions = {}): Bitmap {
  const fit = opts.fit ?? 'contain'
  const levels = opts.levels ?? 4
  const dither = opts.dither ?? 'ordered'
  const gain = opts.gain ?? 1
  const invert = opts.invert ?? false
  const cut = opts.threshold ?? 0.5
  checkOptions(fit, levels, dither, gain, cut)
  checkFrame(frame)
  const grid = flip(resample(luminance(frame), frame.width, frame.height, fit))
  const out = quantiseGrid(grid, levels, dither, cut, gain, invert)
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!alive(r, c)) out[r][c] = 0
    }
  }
  return out
}

/**
 * `toBitmap` over every frame, delays carried through raw.
 *
 * Raw means raw: a source delay of 0 arrives in `frameMs` as 0. Clamping it and merging
 * frames the quantisation made identical are `anim.normalise()`'s job, and a caller that
 * skips it gets the source's own timing lies played back at face value.
 */
export function toAnimation(frames: RgbaFrame[], opts: QuantiseOptions = {}): Animation {
  return {
    frames: frames.map((f) => toBitmap(f, opts)),
    frameMs: frames.map((f) => f.delayMs),
  }
}

/**
 * The untyped callers are the CLI and anything rebuilding an import from a stored
 * recipe, and a typo'd option otherwise fails far away or, worse, silently: an unknown
 * `fit` would quietly mean `contain`, and a NaN gain is a black bitmap with no clue
 * where it came from (`effects.render` takes the same stance on `levels`).
 */
function checkOptions(
  fit: string,
  levels: number,
  dither: string,
  gain: number,
  cut: number,
): void {
  if (fit !== 'contain' && fit !== 'cover' && fit !== 'stretch') {
    throw new Error(`fit must be contain, cover or stretch, got ${fit}`)
  }
  if (levels !== 2 && levels !== 4) throw new Error(`levels must be 2 or 4, got ${levels}`)
  if (dither !== 'none' && dither !== 'ordered' && dither !== 'floyd') {
    throw new Error(`dither must be none, ordered or floyd, got ${dither}`)
  }
  if (!Number.isFinite(gain) || gain < 0) {
    throw new Error(`gain must be a non-negative number, got ${gain}`)
  }
  if (!Number.isFinite(cut)) throw new Error(`threshold must be a number, got ${cut}`)
}

/**
 * A short `data` otherwise reads as `undefined` bytes, whose arithmetic is NaN, which
 * walks through every clamp and lands in the bitmap as a level. Caught here by name.
 */
function checkFrame(frame: RgbaFrame): void {
  const { width, height, data } = frame
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error(`frame must have positive integer dimensions, got ${width}x${height}`)
  }
  if (data.length !== width * height * 4) {
    throw new Error(
      `frame data is ${data.length} bytes, not the ${width * height * 4} that ` +
        `${width}x${height} RGBA needs`,
    )
  }
}

/** Steps 1 and 2: linear luminance per source pixel, composited over black. */
function luminance(frame: RgbaFrame): Float64Array {
  const { width, height, data } = frame
  const out = new Float64Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const y =
      0.2126 * LINEAR[data[p]] + 0.7152 * LINEAR[data[p + 1]] + 0.0722 * LINEAR[data[p + 2]]
    out[i] = y * (data[p + 3] / 255)
  }
  return out
}

/**
 * Step 3: the source box-averaged onto the 24x9 target, still in image orientation
 * (index `ty * COLS + tx`, row 0 the top) and still linear. Letterbox cells stay 0.
 */
function resample(lum: Float64Array, w: number, h: number, fit: Fit): Float64Array {
  // Source pixels per target pixel, and where target cell (0,0) starts in the source.
  let kx = w / COLS
  let ky = h / ROWS
  let sx = 0
  let sy = 0
  // Where the picture sits on the target. All of it, except under `contain`.
  let x0 = 0
  let y0 = 0
  let tw = COLS
  let th = ROWS
  if (fit === 'cover') {
    const k = Math.min(kx, ky)
    sx = (w - COLS * k) / 2
    sy = (h - ROWS * k) / 2
    kx = k
    ky = k
  } else if (fit === 'contain') {
    const k = Math.max(kx, ky)
    tw = Math.min(COLS, Math.max(1, Math.round(w / k)))
    th = Math.min(ROWS, Math.max(1, Math.round(h / k)))
    x0 = centreOffset(tw, COLS)
    y0 = centreOffset(th, ROWS)
    kx = w / tw
    ky = h / th
  }
  const out = new Float64Array(ROWS * COLS)
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      out[(y0 + ty) * COLS + x0 + tx] = boxMean(
        lum,
        w,
        h,
        sx + tx * kx,
        sx + (tx + 1) * kx,
        sy + ty * ky,
        sy + (ty + 1) * ky,
      )
    }
  }
  return out
}

/** Mean over a fractional source rectangle, each pixel weighted by its overlap. */
function boxMean(
  lum: Float64Array,
  w: number,
  h: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): number {
  // Clipped to the source for float-error safety; every fit maps inside it by design.
  const xa = Math.max(0, x0)
  const xb = Math.min(w, x1)
  const ya = Math.max(0, y0)
  const yb = Math.min(h, y1)
  if (xb <= xa || yb <= ya) return 0
  let sum = 0
  for (let y = Math.floor(ya); y < yb; y++) {
    const wy = Math.min(y + 1, yb) - Math.max(y, ya)
    for (let x = Math.floor(xa); x < xb; x++) {
      const wx = Math.min(x + 1, xb) - Math.max(x, xa)
      sum += lum[y * w + x] * wx * wy
    }
  }
  return sum / ((xb - xa) * (yb - ya))
}

/** Step 4: image row order to panel row order. The one flip in the repo. */
function flip(grid: Float64Array): Float64Array {
  const out = new Float64Array(ROWS * COLS)
  for (let ty = 0; ty < ROWS; ty++) {
    for (let tx = 0; tx < COLS; tx++) {
      out[(ROWS - 1 - ty) * COLS + tx] = grid[ty * COLS + tx]
    }
  }
  return out
}

/**
 * Step 5: perceptual encode, tone, then levels. `linear` is panel-orientated, which
 * matters twice: the Bayer thresholds are meant to be fixed to panel coordinates, and
 * Floyd-Steinberg's scan runs bottom row first here, which only mirrors the direction
 * its error travels and changes nothing a viewer could name.
 *
 * The ordered/none arithmetic is `effects.ts`'s `quantise` exactly - `floor(v * steps
 * + t)` against the shared Bayer tile, `t = 0.5` when flat - so the two files cannot
 * shade the same gradient differently. The levels-2 threshold rides in as a bias on
 * `v`, which keeps the knob meaningful under all three dithers: under `floyd` a moved
 * hard cut alone would be corrected away by the error it creates.
 */
function quantiseGrid(
  linear: Float64Array,
  levels: 2 | 4,
  dither: Dither,
  cut: number,
  gain: number,
  invert: boolean,
): Bitmap {
  const steps = levels - 1
  const scale = MAX_LEVEL / steps
  const shift = levels === 2 ? 0.5 - cut : 0
  const value = new Float64Array(ROWS * COLS)
  for (let i = 0; i < value.length; i++) {
    const v = linear[i]
    const p = perceptual(v < 0 ? 0 : v > 1 ? 1 : v)
    const toned = (invert ? 1 - p : p) * gain
    value[i] = Number.isFinite(toned) ? toned + shift : 0
  }
  const out = blank(COLS)
  if (dither === 'floyd') {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c
        const old = Math.min(1, Math.max(0, value[i]))
        const q = Math.min(steps, Math.max(0, Math.round(old * steps)))
        const err = old - q / steps
        out[r][c] = q * scale
        if (c + 1 < COLS) value[i + 1] += err * (7 / 16)
        if (r + 1 < ROWS) {
          if (c > 0) value[i + COLS - 1] += err * (3 / 16)
          value[i + COLS] += err * (5 / 16)
          if (c + 1 < COLS) value[i + COLS + 1] += err * (1 / 16)
        }
      }
    }
    return out
  }
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const t = dither === 'ordered' ? bayer(r, c) : 0.5
      const q = Math.min(steps, Math.max(0, Math.floor(value[r * COLS + c] * steps + t)))
      out[r][c] = q * scale
    }
  }
  return out
}

const PACKED_BYTES = (ROWS * COLS) / 4

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const REVERSE = new Int16Array(128).fill(-1)
for (let i = 0; i < ALPHABET.length; i++) REVERSE[ALPHABET.charCodeAt(i)] = i

/**
 * One panel frame as 72 base64 characters: 216 pixels, 2 bits each, 54 bytes.
 *
 * Throws on anything it cannot represent exactly, because these strings get committed:
 * masking a level 4 to fit, or truncating a wide bitmap, would corrupt a checked-in
 * animation silently and for ever. Pack panel-shaped frames or nothing.
 */
export function packBitmap(b: Bitmap): string {
  if (b.length !== ROWS) throw new Error(`bitmap has ${b.length} rows, not ${ROWS}`)
  const bytes = new Uint8Array(PACKED_BYTES)
  for (let r = 0; r < ROWS; r++) {
    if (b[r].length !== COLS) {
      throw new Error(`row ${r} has ${b[r].length} columns, not ${COLS}`)
    }
    for (let c = 0; c < COLS; c++) {
      const v = b[r][c]
      if (!Number.isInteger(v) || v < 0 || v > MAX_LEVEL) {
        throw new Error(`level at ${r},${c} is ${v}, not an integer 0 to ${MAX_LEVEL}`)
      }
      const i = r * COLS + c
      bytes[i >> 2] |= v << ((i & 3) * 2)
    }
  }
  return toBase64(bytes)
}

/** The exact bitmap `packBitmap` was given. Throws on corruption, never guesses. */
export function unpackBitmap(s: string): Bitmap {
  const bytes = fromBase64(s)
  if (bytes.length !== PACKED_BYTES) {
    throw new Error(`packed bitmap is ${bytes.length} bytes, not ${PACKED_BYTES}`)
  }
  const out = blank(COLS)
  for (let i = 0; i < ROWS * COLS; i++) {
    out[Math.floor(i / COLS)][i % COLS] = (bytes[i >> 2] >> ((i & 3) * 2)) & 3
  }
  return out
}

// 54 bytes is a multiple of 3, so padding never arises for our own strings; the
// general form is kept because a truncated or hand-edited string must still decode
// deterministically far enough to be refused by the length check above.
function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += ALPHABET[a >> 2]
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : ALPHABET[c & 63]
  }
  return out
}

// Strict where the app's decoder is lenient: a bad character in a committed string is
// corruption, and skipping it would shift every pixel after it rather than say so.
function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let acc = 0
  let bits = 0
  let n = 0
  for (let i = 0; i < clean.length; i++) {
    const v = REVERSE[clean.charCodeAt(i)] ?? -1
    if (v < 0) throw new Error(`not base64 at position ${i}: ${clean[i]}`)
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, n)
}
