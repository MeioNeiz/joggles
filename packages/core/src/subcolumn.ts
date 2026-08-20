/**
 * Sub-column scroll interpolation, host side: what the panel would show mid-step.
 *
 * A device-side scroll advances **one whole column** every `protocol.speedDivisor`
 * ticks of the 50 Hz animation clock, so between 3.8 and 12.5 columns a second, and at
 * the fast end that is visibly a picture jumping sideways rather than moving.
 * `notes/what-to-build.md` ranks the fix: blend the two columns either side of the
 * boundary through the four levels the panel already has. `jgx.SUB.SMOOTH` is the
 * setting, 1 to 4 sub-steps, and 1 is stock behaviour.
 *
 * This module is the preview. The point of it is to let a screen show what smoothing
 * buys **without promising anything the panel has not been seen to do**, so most of
 * what follows is about what it deliberately does not model.
 *
 * ## What the preview models: levels, not light
 *
 * Each output pixel is the weighted mean of the same pixel in the two neighbouring
 * content columns, rounded to a whole level. That is *the level our firmware would ask
 * the panel for*, and nothing more.
 *
 * **It is not a brightness model and cannot be made into one.** The greyscale depth and
 * the level-to-brightness curve belong to the panel module on UART1, not to the MCU, so
 * no firmware patch reaches them and nothing here knows them (`CLAUDE.md`, "The MCU does
 * not drive the LEDs"). Three consequences a caller must not paper over:
 *
 *  - **Half way is not half brightness.** Level 2 of 3 could be anywhere from a third
 *    to nine tenths of the light of level 3. The four levels were established by
 *    alternating `0b01` against `0b11` on hardware, which proved they *differ*, not by
 *    how much.
 *  - **A moving edge does not conserve light.** One lit column at the midpoint of a
 *    two-step blend becomes two columns at level 2, so whether the picture pulses as it
 *    travels depends entirely on that unmeasured curve. Smoothing could read as
 *    smoother motion or as a shimmer, and no offline render can tell you which.
 *  - **Only the sequence is modelled, never the timing.** Same rule as
 *    `viewport.frames`. `timing()` below says what the device's own intervals would be,
 *    and the preview loop's interval is the caller's business.
 *
 * ## Rounding up, because a dim feature must not vanish
 *
 * The blend rounds halves up: `Math.round` of the weighted mean. Truncating instead
 * would take a level-1 pixel blended towards a dark neighbour to 0 at every sub-step
 * but the first, so the faintest content would flicker at exactly the levels smoothing
 * exists to use; rounding up keeps it lit for three sub-steps of four and drops it on
 * the last, which is a fade rather than a flicker. `blendTable` is the same
 * arithmetic as a table indexed by the numerator, at most 13 entries per `steps` value,
 * which is how the slot can implement this with no divide: **ARMv6-M has no `udiv`**,
 * and `steps` of 3 is otherwise a division by three in the frame path.
 *
 * That table is a **contract, not an observation**: the firmware is not written, so
 * whatever this module rounds is what the slot has to round, and the tests here are the
 * only thing holding the two together.
 *
 * ## Dead LEDs, and the mask discipline this inherits
 *
 * The blend runs on content and the mask goes on the **window**, in panel coordinates,
 * exactly as `viewport.windowAt` and for the reason its docblock gives: masking content
 * draws a hole that travels with the glyph. So no blended pixel can light an LED that
 * is not there, and a blend cannot invent light either, since the mean of two dark
 * columns is dark. Rows 2-7 is the band alive in every column, and content living there
 * is content whose smoothing is unaffected by the notch.
 *
 * ## The loop is `viewport`'s loop, not a second copy of it
 *
 * Offsets come from `viewport.scrollOffsets`/`marqueeOffsets` and the wrap width from
 * `viewport.marqueeWidth`, so the device's ~24 trailing blank columns are modelled in
 * one place and this file cannot disagree with `Preview.tsx` about the loop gap. Each
 * blend runs between an offset and **the next offset in display order**, which is why
 * both scroll directions come out right with no direction arithmetic here: under `dir`
 * 1 the walk runs backwards, so the incoming column is the one before rather than the
 * one after.
 *
 * At `steps` 1 this delegates to `viewport.frames` outright rather than reproducing it.
 *
 * ## The trap that would make a preview of a saved scroll a lie
 *
 * A scroll of the saved store is **DATS type 1, which is one bit per pixel**
 * (`dats.encodeBitmap`), so the store holds lit-or-not and the panel draws lit at full
 * level, the same as every frame the vendor's firmware builds. Blending the caller's
 * original bitmap would therefore preview grey the device never had: `scrollFrames`
 * flattens first and re-expands to `MAX_LEVEL`, which is what the device is actually
 * scrolling.
 *
 * It also refuses grey content outright. Grey saves as type 2, and type 2 is a still
 * 24-column image displayed by `set_mode(26)`; there is no scroll there to smooth, so
 * previewing one would be inventing a device behaviour rather than showing it.
 *
 * ## The other route to the same look, and why it is not this one
 *
 * A host can blend and send the blended frames itself, atomically and with no firmware
 * at all, by feeding these bitmaps to `tiles.plan`: no flash, no sweep. What bounds it
 * is sixteen palette entries for every distinct masked column in the whole pass, which
 * a blend multiplies. So the two features overlap deliberately: tiles for short loops
 * on a crew unit, `SUB.SMOOTH` for a saved scroll of any width.
 *
 * **Nothing here has run.** No unit carries the extension, the slot that would answer
 * `SUB.SMOOTH` is not written, and no smoothed column has been watched on a panel.
 * Everything above is *derived*.
 */
import {
  type Bitmap,
  type Content,
  blank,
  flatten,
  normalise,
  savedType,
  width,
} from './content.js'
import { TYPE_IMAGE } from './dats.js'
import { COLS, MAX_LEVEL, ROWS, alive } from './display.js'
import { SMOOTH_MAX, SMOOTH_OFF, TICK_STOCK_HZ, tickMs } from './jgx.js'
import { speedDivisor } from './protocol.js'
import {
  type LoopModel,
  frames as viewportFrames,
  marqueeOffsets,
  marqueeWidth,
  scrollOffsets,
} from './viewport.js'

/** One sub-step per column, i.e. stock stepping. Re-exported so there is one name. */
export const OFF = SMOOTH_OFF

/** Four, because the panel has four levels and a fifth phase has nothing to draw with. */
export const MAX_STEPS = SMOOTH_MAX

/**
 * One 74-byte frame on the panel module's UART at 115200 8N1: 740 bit times.
 *
 * The floor every frame rate here is measured against. It lives as a comment beside
 * `protocol.PACING_MS` and is not exported from there, so it is restated rather than
 * imported; if the two ever disagree, that comment is the older of the two.
 */
export const PANEL_FRAME_MS = (74 * 10 * 1000) / 115200

const assertSteps = (steps: number): number => {
  if (!Number.isInteger(steps) || steps < SMOOTH_OFF || steps > SMOOTH_MAX) {
    throw new RangeError(`sub-steps ${steps} is outside ${SMOOTH_OFF}-${SMOOTH_MAX}`)
  }
  return steps
}

const assertLevel = (v: number, what: string): number => {
  if (!Number.isInteger(v) || v < 0 || v > MAX_LEVEL) {
    throw new RangeError(`${what} level ${v} is outside 0-${MAX_LEVEL}`)
  }
  return v
}

/**
 * The level shown `sub` of `steps` of the way from level `a` to level `b`.
 *
 * `sub` 0 is exactly `a`, which is what makes a smoothed walk start on the same frame
 * the unsmoothed one shows. There is no `sub === steps`: that is `sub` 0 of the next
 * column step, and offering both would draw one frame twice.
 */
export function blendLevel(a: number, b: number, sub: number, steps: number): number {
  assertSteps(steps)
  assertLevel(a, 'from')
  assertLevel(b, 'to')
  if (!Number.isInteger(sub) || sub < 0 || sub >= steps) {
    throw new RangeError(`sub-step ${sub} is outside 0-${steps - 1}`)
  }
  return Math.round((a * (steps - sub) + b * sub) / steps)
}

/**
 * `blendLevel` as the table the firmware can carry instead of a divide.
 *
 * Indexed by `a * (steps - sub) + b * sub`, so 13 entries at `steps` 4 and fewer below
 * that. ARMv6-M has no divide instruction, and this is the whole reason the numerator
 * form is the one written down.
 */
export function blendTable(steps: number): number[] {
  assertSteps(steps)
  return Array.from({ length: MAX_LEVEL * steps + 1 }, (_, n) => Math.round(n / steps))
}

export interface BlendOptions {
  /** 1 to 4. One is stock stepping and this module then delegates to `viewport`. */
  steps?: number
  /** `uploaded` (default) or `panel`, as `viewport.LoopModel` defines them. */
  loop?: LoopModel
  /** The byte `MODE 02` carries. Reverses the walk exactly as `viewport` does. */
  dir?: 0 | 1
}

const sampler = (bitmap: Bitmap, loop: LoopModel) => {
  const cols = width(bitmap)
  const total = loop === 'panel' ? marqueeWidth(cols) : cols
  return (row: number, at: number): number => {
    if (total === 0) return 0
    const from = ((at % total) + total) % total
    // Under `panel` the strip is [content][TYPE1_BRACKET blank], so past the content is
    // dark rather than wrapped. Under `uploaded` `total === cols` and this cannot fire.
    return from < cols ? (bitmap[row]?.[from] ?? 0) : 0
  }
}

/**
 * One panel frame `sub` of `steps` of the way from window offset `from` to `to`.
 *
 * `from` and `to` are content columns and must be two **consecutive** offsets of the
 * walk being previewed, which is what makes this direction-agnostic: `frames` below
 * pairs them off `viewport`'s own offset list.
 *
 * Levels must already be integers 0 to `MAX_LEVEL` and a stray one throws rather than
 * being rounded quietly. `content.normalise` is the normaliser renderers are allowed to
 * be sloppy against, and `frames` calls it once for you rather than per frame.
 */
export function blendAt(
  bitmap: Bitmap,
  from: number,
  to: number,
  sub: number,
  opts: BlendOptions = {},
): Bitmap {
  const steps = assertSteps(opts.steps ?? OFF)
  const out = blank(COLS)
  const cols = width(bitmap)
  if (cols === 0) return out
  const at = sampler(bitmap, opts.loop ?? 'uploaded')
  const rows = Math.min(bitmap.length, ROWS)

  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < rows; r++) {
      // Blend the content, then mask at the window: the holes are the panel's and stay
      // put while the content moves past them.
      if (!alive(r, c)) continue
      out[r][c] = blendLevel(at(r, from + c), at(r, to + c), sub, steps)
    }
  }
  return out
}

/**
 * Every frame a smoothed scroll of `bitmap` passes through, in display order.
 *
 * `steps` times as many frames as the unsmoothed walk, covering the same content in the
 * same order: smoothing does not change how fast the picture crosses the panel, only
 * how many frames it takes to get there. **A preview loop must divide its interval by
 * `steps` or the pass runs `steps` times too slow**, and `timing()` is the honest
 * version of that, since the device's sub-steps are not equal at most speeds.
 */
export function frames(bitmap: Bitmap, opts: BlendOptions = {}): Bitmap[] {
  const steps = assertSteps(opts.steps ?? OFF)
  const loop = opts.loop ?? 'uploaded'
  const dir = opts.dir ?? 0
  const cols = width(bitmap)
  if (steps === OFF || cols === 0) {
    return viewportFrames(bitmap, { kind: 'scroll', dir }, { loop })
  }
  const px = normalise(bitmap)
  const offsets = loop === 'panel' ? marqueeOffsets(cols, dir) : scrollOffsets(cols, dir)
  const out: Bitmap[] = []
  offsets.forEach((from, i) => {
    const to = offsets[(i + 1) % offsets.length]
    for (let sub = 0; sub < steps; sub++) {
      out.push(blendAt(px, from, to, sub, { steps, loop }))
    }
  })
  return out
}

export interface PreviewOptions extends BlendOptions {
  /** Force a DATS type instead of taking it from the content, as `content` does. */
  type?: number
  /** Lowest level that survives the flatten to type 1. */
  threshold?: number
}

/**
 * Why this content's scroll cannot honestly be previewed smoothed, as sentences.
 *
 * One entry today, and it is the one that would otherwise be a lie: grey content is a
 * type 2 image, and the device displays type 2 as a still 24 columns wide rather than
 * scrolling it.
 */
export function previewProblems(content: Content, opts: PreviewOptions = {}): string[] {
  const out: string[] = []
  const type = opts.type ?? savedType(content)
  if (content.motion.kind === 'scroll' && type === TYPE_IMAGE) {
    out.push(
      'this content has grey in it, so it saves as DATS type 2, which the device ' +
        'displays as a still 24-column image: there is no column step to interpolate. ' +
        'Force type 1 to scroll it, which flattens the grey',
    )
  }
  return out
}

/**
 * The frames a saved scroll of `content` would show, smoothed, as the device holds it.
 *
 * **Flattened and re-expanded**, because type 1 is one bit per pixel: what scrolls on
 * the panel is lit-or-not at full level, and blending the caller's grey would preview a
 * picture the store never held.
 *
 * Static content is one frame whatever `steps` says, which is the truth rather than a
 * shortcut: there are no column steps to interpolate.
 */
export function scrollFrames(content: Content, opts: PreviewOptions = {}): Bitmap[] {
  const problems = previewProblems(content, opts)
  if (problems.length) throw new Error(problems.join('; '))
  if (content.motion.kind !== 'scroll') {
    return viewportFrames(content.bitmap, content.motion, { loop: opts.loop })
  }
  // Always flattened: type 2 does not scroll, so `previewProblems` has already refused
  // every content that would reach here as anything but type 1.
  const lit = flatten(content.bitmap, opts.threshold).map((row) =>
    row.map((v) => (v ? MAX_LEVEL : 0)),
  )
  return frames(lit, { steps: opts.steps, loop: opts.loop, dir: content.motion.dir })
}

export interface Timing {
  /** Ticks of the animation clock the device holds each whole column for. */
  ticksPerColumn: number
  /** Ticks each sub-step lasts, in order. Sums to `ticksPerColumn`. */
  ticks: number[]
  /** Milliseconds each sub-step lasts, at this tick rate. */
  ms: number[]
  /** Are all the sub-steps the same length? At most speeds they are not. */
  even: boolean
  /** The shortest sub-step, which is what the UART has to keep up with. */
  shortestMs: number
  /** Does that shortest sub-step clear `PANEL_FRAME_MS`? */
  fits: boolean
}

/**
 * What the device's own sub-steps would cost, at a `SPEED` argument and a tick rate.
 *
 * The uneven result is the finding worth carrying: a column lasts `speedDivisor` ticks,
 * 13 down to 4, and only some of those divide by the sub-step count, so at most speeds
 * the sub-steps come out 3, 3, 3, 4 ticks rather than equal. The panel gets a frame at
 * an uneven rhythm, which is a smaller defect than whole-column stepping but is not
 * nothing, and it is invisible in any offline render. Whichever sub-step takes the extra
 * tick is pinned here so the slot and this preview agree; the accumulate-and-carry loop
 * a firmware would use produces the same lengths.
 *
 * `hz` is `jgx.SUB.TICK`: doubling the tick doubles the scroll rate rather than the
 * smoothness, since the divisor is counted in ticks, so 100 Hz with 4 sub-steps is where
 * the UART floor starts to matter at all.
 */
export function timing(speed: number, steps: number, hz = TICK_STOCK_HZ): Timing {
  assertSteps(steps)
  const ticksPerColumn = speedDivisor(speed)
  const ticks = Array.from(
    { length: steps },
    (_, k) =>
      Math.floor(((k + 1) * ticksPerColumn) / steps) -
      Math.floor((k * ticksPerColumn) / steps),
  )
  const ms = ticks.map((t) => t * tickMs(hz))
  const shortestMs = Math.min(...ms)
  return {
    ticksPerColumn,
    ticks,
    ms,
    even: ticks.every((t) => t === ticks[0]),
    shortestMs,
    fits: shortestMs >= PANEL_FRAME_MS,
  }
}

/**
 * The most sub-steps that divide this speed's column evenly, which is often just 1.
 *
 * Offered so a UI can prefer an even rhythm where one exists rather than always asking
 * for four. It is a preference and not a limit: `timing().fits` is what says whether a
 * setting is drawable at all.
 */
export function evenSteps(speed: number): number {
  const ticks = speedDivisor(speed)
  for (let steps = MAX_STEPS; steps > OFF; steps--) {
    if (ticks % steps === 0) return steps
  }
  return OFF
}
