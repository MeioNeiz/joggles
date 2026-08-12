/**
 * Frame animations from outside: the model, and what this panel can honestly do with one.
 *
 * Everything else in this package renders content we compute. This module is the way in
 * for content nobody here drew - a GIF, a sprite sheet row, an animation bank from some
 * other project - and its job is to say what happens to it, because the answer is not the
 * one a person expects and every screen above it has to state the same thing.
 *
 * ## The one fact this module exists to make unavoidable
 *
 * **The device cannot store a frame animation.** `DATS` has exactly two payload types
 * (`dats.ts`): type 1 is a wide 2-level strip the panel *pans* sideways one column per
 * step, and type 2 is a single static 24-column image that lives in RAM until the next
 * `MODE`. The 19 built-in animations play frame-by-frame with no phone attached because
 * they are frame data compiled into the firmware, read-only, reachable only as `ANIM n`
 * (`app/src/builtins.ts`). There is no third store and no opcode that uploads frames.
 *
 * So an imported animation reaches the panel exactly three ways, and this module prices
 * all three rather than letting a screen pick the flattering one:
 *
 *  - `livePlan()` - real frame playback, driven column by column from the phone over
 *    `LiveSender`. Frame-accurate, no flash, and the phone must stay connected and hold
 *    the panel. This is the only route that shows the frames as frames.
 *  - `filmstrip()` - the frames laid side by side into one type 1 save. Persists, plays
 *    with the phone in a pocket, writes flash, and **is a pan, not a cut**: at any moment
 *    the 24-column window straddles two frames, so a walk cycle reads as a smear. The
 *    function returns it anyway, because for some content a pan is what you wanted.
 *  - a frame mode in our own firmware, which is `notes/firmware-design.md`'s roadmap and
 *    is barred behind the `--ldrom-verified` gate. Nothing here can do it today.
 *
 * `routeWords()` is those trade-offs as sentences a screen prints verbatim, the same
 * contract `app/src/deliver.ts` uses for its own costs, so the honesty cannot drift from
 * the arithmetic by being re-worded upstream.
 *
 * ## Why the source frames stop at this file's edge
 *
 * `RgbaFrame` is straight sRGB at whatever size the source was, and `Animation` is
 * panel-shaped `Bitmap`s. Decoding into the first is `gif.ts`; getting from the first to
 * the second is `quantise.ts`. Neither knows about the panel's stores and neither should:
 * this file is where the two meet something with dead LEDs and one flash buffer.
 *
 * Delays are the part every GIF gets wrong, so `normalise()` owns it: a frame declaring
 * 0 ms means "as fast as you can" and every browser silently reads it as 100 ms, and a
 * source that repeats a frame byte-for-byte should be one longer frame rather than two
 * writes of the same columns. Both are done once, here, so a player and a cost estimate
 * cannot disagree about how long an animation runs.
 */
import { COLS, MAX_LEVEL, ROWS, alive } from './display.js'
import { type Bitmap, type Content, MAX_SAVED_COLUMNS, hasGrey } from './content.js'
import { PACING_MS } from './protocol.js'

/**
 * A decoded source frame, before anything panel-shaped happens to it.
 *
 * Non-premultiplied sRGB, four bytes per pixel, row 0 at the **top** because that is what
 * every image format means by row 0. The flip to this panel's row 0 at the bottom happens
 * in `quantise.ts`, once, and `content.Bitmap` is always already flipped.
 */
export interface RgbaFrame {
  width: number
  height: number
  /** `width * height * 4` bytes, RGBA. */
  data: Uint8Array
  /** How long the source said to hold this frame, in ms, unclamped and possibly 0. */
  delayMs: number
}

/**
 * A panel-shaped animation: the frames as this device would light them.
 *
 * Every frame is `ROWS` by `COLS` with levels 0 to `MAX_LEVEL`, already masked for dead
 * LEDs, and `frameMs` is the same length as `frames`. The **pixels** are final - nothing
 * downstream re-masks or re-scales them.
 *
 * The **timing is not**, and the difference matters. `quantise.toAnimation()` carries
 * source delays through raw, 0 included, so a freshly decoded `Animation` is legal and not
 * yet playable: `normalise()` is what applies the 0 ms rule and merges repeated frames.
 * Everything that prices or plays one (`livePlan`, `FramePlayer`, the app's `animationOf`)
 * expects a normalised value, and passing a raw one gets a wrong duration rather than an
 * error. Flagged by track 43 while implementing against this type, because the first
 * version of this docblock claimed the timing was final too.
 */
export interface Animation {
  frames: Bitmap[]
  frameMs: number[]
}

/**
 * What a frame declaring 0 ms actually means.
 *
 * The GIF spec allows 0 and says nothing useful about it; every browser since Netscape
 * has read it as 100 ms, so a decoder that passes 0 through produces animations that a
 * player either runs at its own tick rate or spins on. 100 ms is the de facto standard
 * rather than a choice of ours.
 */
export const ZERO_DELAY_MS = 100

/** Below this, no route can keep up, so clamping here beats lying in a cost estimate. */
export const MIN_FRAME_MS = 10

/**
 * Are two frames the same lit picture?
 *
 * Used to merge repeats, so it compares levels and nothing else: two frames that differ
 * only where `alive()` is false are the same picture on this panel, and a source that
 * animates the nose notch is animating nothing.
 */
export function sameFrame(a: Bitmap, b: Bitmap): boolean {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!alive(r, c)) continue
      if (a[r][c] !== b[r][c]) return false
    }
  }
  return true
}

/**
 * Clamp the delays and merge repeated frames.
 *
 * Merging is not an optimisation, it is the difference between a correct duration and a
 * wrong one: a source holding a pose for five frames should be one frame held five times
 * as long, or `livePlan()` prices five identical writes and a player sends columns that
 * are already on the panel. The merged frame keeps the sum of what it replaced.
 */
export function normalise(anim: Animation): Animation {
  const frames: Bitmap[] = []
  const frameMs: number[] = []
  for (let i = 0; i < anim.frames.length; i++) {
    const ms = Math.max(MIN_FRAME_MS, anim.frameMs[i] === 0 ? ZERO_DELAY_MS : anim.frameMs[i])
    const last = frames.length - 1
    if (last >= 0 && sameFrame(frames[last], anim.frames[i])) {
      frameMs[last] += ms
      continue
    }
    frames.push(anim.frames[i])
    frameMs.push(ms)
  }
  return { frames, frameMs }
}

/** One cycle in ms. Read off `frameMs`, so it is right only after `normalise()`. */
export const durationMs = (anim: Animation): number =>
  anim.frameMs.reduce((sum, ms) => sum + ms, 0)

/**
 * Columns that differ between two frames, which is what a live write actually costs.
 *
 * `LiveSender` holds a desired grid and a believed-sent grid and writes only the columns
 * that changed, so the cost of a frame is not 24 writes but the size of its difference
 * from the frame before it. That is the whole reason live playback of small pixel art is
 * viable on a channel the docs warn sweeps visibly: a 3-column change is 3 writes, and
 * the sweep those warnings describe is a full 24-column rewrite.
 *
 * Dead columns are skipped for the same reason `sameFrame` skips them.
 */
export function changedColumns(from: Bitmap, to: Bitmap): number {
  let n = 0
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (!alive(r, c)) continue
      if (from[r][c] !== to[r][c]) {
        n++
        break
      }
    }
  }
  return n
}

/** What live playback of one animation costs, and whether it can hold its own timing. */
export interface LivePlan {
  /** Writes per cycle: every frame's difference from the one before, wrapping. */
  writes: number
  /** Wall clock the writes alone need, at `protocol.PACING_MS` each. */
  wireMs: number
  /** What the source asked for. */
  wantedMs: number
  /**
   * True when the wire cannot keep up, so the animation will run slow rather than wrong.
   * A player must never drop frames to catch up: the panel keeps whatever it was last
   * given, so a dropped frame is a stale column and not a skipped one.
   */
  slow: boolean
  /** Frames per second actually achievable, for a screen that wants to say it. */
  fps: number
}

/**
 * Price live playback.
 *
 * Wrapping matters: the last frame's difference from the first is a real cost every
 * cycle, and an animation whose first and last frames are far apart pays for it forever.
 * A one-frame animation is a still, costs one write of whatever is lit, and is never slow.
 */
export function livePlan(anim: Animation): LivePlan {
  const n = anim.frames.length
  if (n === 0) return { writes: 0, wireMs: 0, wantedMs: 0, slow: false, fps: 0 }
  let writes = 0
  if (n === 1) {
    writes = changedColumns(blankFrame(), anim.frames[0])
  } else {
    for (let i = 0; i < n; i++) {
      writes += changedColumns(anim.frames[(i + n - 1) % n], anim.frames[i])
    }
  }
  const wireMs = writes * PACING_MS
  const wantedMs = durationMs(anim)
  const runMs = Math.max(wireMs, wantedMs)
  return {
    writes,
    wireMs,
    wantedMs,
    slow: n > 1 && wireMs > wantedMs,
    fps: runMs === 0 ? 0 : (n * 1000) / runMs,
  }
}

const blankFrame = (): Bitmap =>
  Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 0))

/**
 * The frames laid side by side, as one wide bitmap for a type 1 save.
 *
 * **This is a pan and not an animation**, and the arithmetic is why: the device advances
 * a saved scroll one column per step, so the 24-column window sits astride two frames for
 * 23 of every 24 steps. Content drawn to survive that - a repeating pattern, a banner, a
 * creature that reads at any offset - pans well. A walk cycle does not.
 *
 * Two limits bite before taste does. Only 2 levels survive a type 1 save, so every frame
 * is collapsed here, unconditionally, and `filmstripLosesGrey()` is how a screen says what
 * that cost before it happens. And `MAX_SAVED_COLUMNS` caps the strip, which at 24 columns
 * a frame is `maxFilmstripFrames()` frames; the device appends its own `TYPE1_BRACKET`
 * blank columns on top of whatever is sent, which is a gap in the pan and not an overflow.
 *
 * **Lit means `MAX_LEVEL`, not 1, and that is not cosmetic.** `content.flatten()` collapses
 * to 0/1 for `dats.encodeBitmap`, which lights any non-zero value - but `content.hasGrey()`
 * reads level 1 as grey, so `content.savedType()` would route a 0/1 strip to type **2**,
 * which does not persist and shows only its first 24 columns. A strip that used
 * `flatten()` therefore silently became the one store it must not be in. `content.text()`
 * lands on 0/3 for the same reason; this matches it.
 */
export function filmstrip(anim: Animation): Bitmap {
  const strip: Bitmap = Array.from({ length: ROWS }, () => [] as number[])
  for (const frame of anim.frames.slice(0, maxFilmstripFrames())) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) strip[r].push(frame[r][c] > 0 ? MAX_LEVEL : 0)
    }
  }
  return strip
}

/**
 * The strip as saveable content: wide, scrolling, and bound for flash.
 *
 * Built here rather than in a screen so the one route that persists cannot be assembled
 * two ways. `route: 'saved'` with `kind: 'scroll'` is the same literal shape a wide effect
 * loop uses (`app/src/effects-ui/plan.ts`), which is the closest existing thing to a
 * filmstrip and the reason this needs no new store or opcode.
 */
export function filmstripPiece(anim: Animation, speed: number, dir: 0 | 1 = 0): Content {
  return { bitmap: filmstrip(anim), route: 'saved', motion: { kind: 'scroll', dir, speed } }
}

/** How many 24-column frames fit one type 1 save. */
export const maxFilmstripFrames = (): number => Math.floor(MAX_SAVED_COLUMNS / COLS)

/** Whether every frame of an animation would survive a type 1 save unchanged. */
export const filmstripLosesGrey = (anim: Animation): boolean => anim.frames.some(hasGrey)

/** How many lit pixels of an animation land where this panel has no LED. */
export function hiddenPixels(anim: Animation): number {
  let n = 0
  for (const frame of anim.frames) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (frame[r][c] > 0 && !alive(r, c)) n++
      }
    }
  }
  return n
}

export type PlayRoute = 'live' | 'filmstrip'

/**
 * Each route's cost as a sentence, in the shape `deliver.costOf()` states its own.
 *
 * The screens print these verbatim. The live one has to say the phone stays connected,
 * because that is the whole difference from a built-in animation and the thing a person
 * discovers by walking away. The filmstrip one has to say "pans", because "saved
 * animation" is what a person will otherwise read it as, and it is not that.
 */
export function routeWords(anim: Animation, route: PlayRoute): string {
  if (route === 'live') {
    const plan = livePlan(anim)
    const rate = `${plan.fps.toFixed(1)} frames a second`
    const slow = plan.slow
      ? ` Slower than it was drawn: the wire needs ${(plan.wireMs / 1000).toFixed(1)}s a `
        + `cycle and it wanted ${(plan.wantedMs / 1000).toFixed(1)}s, so it runs at `
        + `${rate} instead.`
      : ` It runs at ${rate}, as drawn.`
    return (
      'No flash and nothing stored: the phone plays this frame by frame down the wire.'
      + slow
      + ' It stops when the phone disconnects or anything else takes the panel.'
    )
  }
  const frames = Math.min(anim.frames.length, maxFilmstripFrames())
  const dropped = anim.frames.length - frames
  const grey = filmstripLosesGrey(anim) ? ' Grey goes: a saved strip is black or lit.' : ''
  const cut = dropped > 0 ? ` The last ${dropped} frames do not fit and are dropped.` : ''
  return (
    `One flash save, ${frames * COLS} columns, and it keeps playing with the phone away. `
    + 'The glasses pan across the frames rather than cutting between them, so this reads '
    + 'as one long picture sliding past and not as the animation you previewed.'
    + grey
    + cut
  )
}
