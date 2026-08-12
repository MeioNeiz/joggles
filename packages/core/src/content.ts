/**
 * One representation of "what should be on the glasses", and both encoders.
 *
 * The bug this exists to prevent: a screen that knows which delivery route it is
 * on and hardcodes an encoding to match. Renderers - text, the draw canvas, any
 * future generator - produce a `Bitmap` and nothing else. Everything downstream
 * of that decides 2bpp versus 1bpp, which characteristic, which handshake.
 *
 * The two routes are not interchangeable and the difference is not cosmetic:
 *
 *     live      960b, 24 columns, 4 grey levels, no flash, gone at power off
 *     saved 1   960a + DATCP, 740 columns, monochrome, five page erases, survives
 *     saved 2   960a + DATCP, 24 columns, greyscale, no flash, gone at power off
 *
 * Type 2 is the odd one: it looks like the saved route and behaves like the live
 * one, except that its whole 24-column frame lands in a single handshake instead of
 * 24 paced writes, so it is the only path that puts arbitrary greyscale pixels on
 * the panel with no left-to-right sweep. It costs a full DATS round trip to do it.
 *
 * **The route does not decide persistence, the DATS type does**, and `savedType`
 * picks the type from the content. Only type 1 reaches the flash writer at
 * `abs 0x218cc`; type 2 lands in the same RAM buffer `SMVEW 02` uses, so it survives
 * a disconnect and not a power cycle. One grey pixel is therefore the difference
 * between a save that lasts and one that does not, and nothing at the device end
 * reports which happened. *verified* on hardware 2026-08-09; both replies and both
 * panel states are in `research/firmware-internals.md`.
 *
 * A type 2 image also displays the moment `DATCP` is acknowledged, and **any `MODE`
 * sent afterwards discards it for good**, so a caller that saves type 2 must not
 * follow it with `modeArgs`.
 *
 * `notes/app-plan.md` has the reasoning and the flash-wear numbers. Nothing in
 * this file writes anything; it builds bytes and answers questions about them.
 */
import * as dats from './dats.js'
import { COLS, Grid, MAX_LEVEL, ROWS } from './display.js'
import { type Font, panelBitmap, panelFor } from './font.js'

/** `[row][col]`, values 0-3, row 0 is the BOTTOM row. Same as everywhere here. */
export type Bitmap = number[][]

export type Route = 'live' | 'saved'

export type Motion =
  | { kind: 'static' }
  | { kind: 'scroll'; dir: 0 | 1; speed: number }

export interface Content {
  /** `ROWS` rows, and as many columns as `check` will allow for the route. */
  bitmap: Bitmap
  route: Route
  motion: Motion
}

/**
 * Largest **type 1** payload the device accepts: 1480 bytes returns `DATCPOK`,
 * 1490 returns `ERROR`. *verified*, bisected from both directions on
 * `GLASSES-125B37` (`research/vendor-app-protocol.md`).
 *
 * The firmware's own bound is 1486 and this sits 3 columns under it. `DATCP` at
 * `abs 0x182e0` answers `DATCPOK` only when a running counter exactly equals what
 * `DATS` predicted; type 1 starts that counter at 48, adds 2 per column, and resets
 * it to 0 on reaching 1536, so 1490 cannot ever match. The measured figure is kept
 * rather than the derived one, which costs 3 columns.
 *
 * **Do not divide this by a wire stride to get another type's ceiling.** It was
 * measured at type 1's stride against a buffer type 2 fills at a different rate;
 * `MAX_IMAGE_COLUMNS` is that ceiling.
 */
export const MAX_SAVED_BYTES = 1480

/**
 * The widest type 2 upload the device will **accept**, which is not the widest one
 * it will **show**. For content, want `MAX_IMAGE_COLUMNS`.
 *
 * The device buffers an image column as a **32-bit word**, not as the 3 bytes it
 * costs on the wire, and wraps that column counter at 384 (`abs 0x18634`). Storing
 * column 384 resets it to 0, so `DATCP` compares 0 against the 384 it expected and
 * answers `ERROR` once the whole upload has been sent. *verified* on hardware
 * 2026-08-09, and **read off the wire**: 383 columns answers `DATCPOK`, 384 answers
 * `ERROR`. Device replies, not an interpretation, so this number is as solid as
 * anything here gets.
 *
 * *Corrected: this was 493, from dividing 1480 by three bytes per column. That
 * model is wrong twice over - the budget was measured at type 1's stride, and type
 * 2 spends four buffer bytes per column rather than three.*
 */
export const IMAGE_ACCEPT_CEILING = 383

/**
 * Type 2 columns that actually reach the panel, which is the panel itself.
 *
 * **A type 2 upload wider than the panel is accepted and then 94% invisible.**
 * `set_mode(26)` copies 96 bytes, 24 columns, out of the staging buffer
 * (`abs 0x21f26`) and the frame the `DATCP` arm builds is 24 wide too. Tested on
 * hardware 2026-08-09: 383 columns whose first 24 were lit and whose other 359 were
 * black left the panel lit and unchanging for two minutes.
 *
 * **Weigh this one before building on it.** Unlike `IMAGE_ACCEPT_CEILING`, which is
 * a device reply, this was *read off the panel by a person*, and it is a **null
 * observation**: "nothing changed for two minutes" and "nobody was watching closely
 * enough" look identical. The disassembly says the same thing, which is why it is
 * believed, but a scroll slower than the `SPEED` ladder implies, or one that pauses
 * between passes the way type 1 does, would also produce this report. An earlier
 * pass of the same test using a *dim* rather than black tail came back "not certain".
 *
 * So this is the number `check` enforces, and that is the conservative direction: if
 * it is wrong, we decline to send width that turns out to have worked, rather than
 * shipping content that silently vanishes. Raise it here if anyone overturns the
 * finding. `IMAGE_ACCEPT_CEILING` stays separate because "the device says `ERROR` at
 * 384" and "the device shows nothing past 24" are different facts, held to different
 * standards of proof, and conflating them is how the 493 mistake happened.
 */
export const MAX_IMAGE_COLUMNS = COLS

/** Columns worth sending, per DATS type. 740 for text, 24 for an image. */
export const maxColumns = (type: number): number =>
  type === dats.TYPE_IMAGE ? MAX_IMAGE_COLUMNS : Math.floor(MAX_SAVED_BYTES / 2)

/** The text ceiling, kept as a name because every note and screen quotes it. */
export const MAX_SAVED_COLUMNS = maxColumns(dats.TYPE_TEXT)

/** The live buffer is the panel and nothing more. Index 24 is dropped, not wrapped. */
export const MAX_LIVE_COLUMNS = COLS

/** `SPEED` takes 0-100 and buckets it to 3.8-12.5 columns/second. */
export const MAX_SPEED = 100

export const width = (bitmap: Bitmap): number => bitmap[0]?.length ?? 0

export const blank = (cols: number): Bitmap =>
  Array.from({ length: ROWS }, () => new Array(cols).fill(0))

/**
 * Force a bitmap into the shape the rest of this module assumes: `ROWS` rows,
 * every row the same length, every value an integer 0 to 3.
 *
 * Renderers are allowed to be sloppy about this - `font.textBitmap` returns five
 * rows, a canvas may hand back ragged arrays - and one normaliser is cheaper than
 * every consumer defending itself.
 */
export function normalise(bitmap: Bitmap): Bitmap {
  const cols = bitmap.reduce((n, row) => Math.max(n, row?.length ?? 0), 0)
  const out = blank(cols)
  for (let r = 0; r < Math.min(bitmap.length, ROWS); r++) {
    for (let c = 0; c < cols; c++) {
      const v = Math.round(bitmap[r]?.[c] ?? 0)
      out[r][c] = Math.max(0, Math.min(MAX_LEVEL, Number.isFinite(v) ? v : 0))
    }
  }
  return out
}

/** Right-pad with blank columns. Never truncates; use it to reach a minimum width. */
export function pad(bitmap: Bitmap, to: number): Bitmap {
  const cols = width(bitmap)
  if (cols >= to) return bitmap.map((row) => [...row])
  return bitmap.map((row) => [...row, ...new Array(to - cols).fill(0)])
}

/**
 * Where a piece of `cols` starts when it is centred in `to`. **Ties go left.**
 *
 * The panel is symmetric about column **11.5**, not about a column: `display.DEAD`
 * puts its holes at cols 9-14 of the top and bottom rows and 10-13 of row 1, all
 * centred on 11.5, and `effects.mirrorFolds` snaps its fold axis to the same place. So
 * a piece of odd width cannot sit on the centre line and one of the two neighbouring
 * columns has to be picked. Left, for two reasons worth keeping: it is the smaller
 * change from the left alignment it replaces, and text reads left to right, so the
 * spare column belongs after the words rather than before them.
 */
export const centreOffset = (cols: number, to: number): number =>
  Math.max(0, Math.floor((to - cols) / 2))

/**
 * Centre a bitmap horizontally in `to` columns. Never truncates, exactly as `pad`.
 *
 * Static text used to be right-padded to the panel, so a short word sat hard against
 * the left lens and read as a rendering fault rather than as a choice (Jacob, during
 * the 2026-08-12 sitting: "text should be centered if its static, like centered
 * horizontally"). **Scrollers keep the pad**, because a scroller's left edge is where
 * the pass begins and `viewport`'s whole account of the loop gap is written against a
 * trailing pad.
 */
export function centre(bitmap: Bitmap, to: number): Bitmap {
  const cols = width(bitmap)
  if (cols >= to) return bitmap.map((row) => [...row])
  const left = centreOffset(cols, to)
  const right = to - cols - left
  return bitmap.map((row) => [
    ...new Array(left).fill(0),
    ...row,
    ...new Array(right).fill(0),
  ])
}

/** Does any pixel sit at an intermediate level, so type 1 would lose something? */
export const hasGrey = (bitmap: Bitmap): boolean =>
  bitmap.some((row) => row.some((v) => v > 0 && v < MAX_LEVEL))

/**
 * Collapse levels 0-3 to 0/1, for the type 1 text encoding.
 *
 * `threshold` is the lowest level that still lights. The default is 1, so
 * anything the user drew survives; raising it turns the flattening into a
 * brightness cut instead, which is what a dithered image wants.
 *
 * **Say so in the UI when this happens.** A drawing with grey in it saved as text
 * comes back flat, and there is nothing at the device end that could tell them.
 */
export function flatten(bitmap: Bitmap, threshold = 1): Bitmap {
  return bitmap.map((row) => row.map((v) => (v >= threshold ? 1 : 0)))
}

/** A 9x24 window as a `Grid`, which is what the live path and the previews want. */
export function toGrid(bitmap: Bitmap): Grid {
  const g = new Grid()
  for (let r = 0; r < Math.min(bitmap.length, ROWS); r++) {
    for (let c = 0; c < Math.min(bitmap[r].length, COLS); c++) {
      g.set(r, c, bitmap[r][c])
    }
  }
  return g
}

export function fromGrid(grid: Grid): Bitmap {
  return Array.from({ length: ROWS }, (_, r) => [...grid.px[r]])
}

/**
 * Blank columns `text()` appends after the content. Zero, and the reason is the
 * device: **it supplies a screen's worth of gap by itself**, so a client gap is
 * added to that one rather than instead of it.
 *
 * Measured, on wire-verified payloads (`research/loop-gap-2026-08-10.md`):
 *
 *     uploaded 27 columns, no client gap   panel showed ~24 blank, one screen width
 *                                          (Jacob, by eye, 2026-08-11, *verified*
 *                                          against the decoded save at 07:48)
 *     uploaded 51 = 27 + a 24 client gap   the original "huge gap" complaint
 *
 * So what a viewer gets is `client gap + the device's own`, and the table that
 * matters is what to ask for:
 *
 *     gap 0   the message clears the panel and comes straight back: one screen
 *     gap 24  two screen widths of dark, which is what the complaint was
 *
 * Zero is therefore the default because it produces the *one screen width* that was
 * asked for, not because a gap is unwanted. Anything wider is a per-call `gap`.
 *
 * **That table holds for content at least a panel wide, and `text()` below is the
 * reason it has to say so**: it pads to `COLS` unconditionally, so a scroll of a word
 * narrower than 24 columns carries `24 - width` blank columns inside its own bitmap
 * and the panel is dark for that many steps plus one. Scrolling `HI` is 24 uploaded
 * columns and 18 fully dark frames, not one. The padding is deliberate - whether
 * `MODE` handles content narrower than the panel is verify item 5 and unrun - and it
 * is `core/src/playlist.ts` that first wrote the consequence down. Nothing reaches it
 * from the app, which picks scroll only past 24 columns, and a CLI caller can.
 *
 * **There is no client value that buys less than one screen** once the device has
 * restored the save, so the seamless loops `effects.ts` builds are seamless only
 * while the session that saved them lasts. Whether the device's contribution is
 * conditional on that restore is the open question in the research file, and it is
 * the only thing that would move this line: if the 24 turns out to be unconditional
 * and `viewport` should stop modelling it, this stays 0 either way.
 */
export const SCROLL_GAP = 0

export interface TextOptions {
  spacing?: number
  /**
   * Blank columns appended after the content, defaulting to `SCROLL_GAP` (0).
   *
   * This is **added to** the gap the device inserts, not instead of it: pass 24 for
   * two screen widths of dark between repeats, not for one. `viewport.frames` with
   * `loop: 'panel'` previews the sum, which is what a viewer sees.
   *
   * **Scroll only, since track 35.** A static piece has no repeat to separate, so a
   * gap there would only push the word off centre; it is ignored rather than obeyed.
   */
  gap?: number
  /** Level to draw the glyphs at. Grey text is legal and saves as type 2. */
  level?: number
  /**
   * Which face to draw with. Defaults to `font.DEFAULT_FONT`.
   *
   * Routed through `font.panelFor`, so a face that cannot scroll (`tall7`, which steps
   * its glyphs around the nose notch) is placed rather than baselined. **A stored item
   * must pass the font it was saved with rather than relying on this default**, or
   * every old message changes shape the day the default does.
   */
  font?: Font
  /** Live only reaches 24 columns, so anything longer must be saved. */
  route?: Route
}

/**
 * Text placed at the panel's baseline, ready for either route.
 *
 * `font.panelBitmap` rather than `textBitmap`, always: the glyphs are five rows
 * and the bitmap is nine, and getting that placement wrong puts text across the
 * nose notch where rows 0 and 1 have no LEDs.
 */
export function text(
  body: string,
  motion: Motion = { kind: 'static' },
  opts: TextOptions = {},
): Content {
  const { spacing = 1, gap = SCROLL_GAP, level = MAX_LEVEL, route = 'saved', font } = opts
  // `panelFor` routes a non-scrolling face through `staticText`, which steps glyphs
  // around the notch; the default path keeps `spacing`, which `panelFor` has no seat
  // for and which nothing passes alongside a font.
  const drawn = font ? panelFor(body, font) : panelBitmap(body, spacing)
  const lit = drawn.map((row) => row.map((v) => (v ? level : 0)))
  // Widened to a full screen either way: whether MODE handles content narrower than
  // the panel is verify item 5 in notes/app-plan.md, still unrun, and doing it here is
  // free where retrofitting it through the content model is not.
  //
  // Where the slack goes differs, and that is track 35: a static word is CENTRED, and
  // a scroller keeps its trailing pad because its left edge is where the pass begins.
  const bitmap =
    motion.kind === 'scroll' ? pad(pad(lit, width(lit) + gap), COLS) : centre(lit, COLS)
  return { bitmap: normalise(bitmap), route, motion }
}

/** A 24-column drawing, live by default because that is what costs no flash. */
export function drawing(source: Bitmap | Grid, route: Route = 'live'): Content {
  const bitmap = source instanceof Grid ? fromGrid(source) : normalise(source)
  return { bitmap: pad(bitmap, COLS), route, motion: { kind: 'static' } }
}

/**
 * Which DATS type this content wants.
 *
 * Grey needs type 2, and monochrome takes type 1 because it is two thirds the
 * size and the only encoding whose ceiling anyone has measured. One function so
 * that `check` and `encodeSaved` cannot answer differently and let content
 * through a check it then fails.
 *
 * **This also decides whether the save survives a power cycle**, because only type
 * 1 writes flash. A caller that must persist should force `type: TYPE_TEXT` and
 * show the `flattened` flag, rather than let a grey pixel choose for it.
 */
export const savedType = (content: Content): number =>
  hasGrey(content.bitmap) ? dats.TYPE_IMAGE : dats.TYPE_TEXT

/** Whether anything at all is lit. Beside `hasGrey`, and read by the blank-save rule. */
export const anyLit = (bitmap: Bitmap): boolean =>
  bitmap.some((row) => row.some((v) => v > 0))

/**
 * Why a save of nothing is refused here rather than on a screen.
 *
 * review-13 found a **736-column loop with no lit cell in it offered for five page
 * erases**, under the words "0% of the loop is lit" and a bright green Upload button:
 * `mirror` with inner `ripple`, folds 10 and no dither renders nothing at any width,
 * and `check` passed it. *verified* on the Pixel, 2026-08-11. The screen was fixed and
 * then deleted by the redesign, which is the whole argument for the rule living here: a
 * guard in a screen lasts exactly as long as the screen.
 *
 * **It is scoped to the one path that spends flash**, which falls straight out of
 * `savedType`. Live costs nothing. A dark type 2 lands in RAM and is a legitimate way
 * to blank the panel. Only type 1 on the saved route erases pages.
 *
 * **And it keeps a door, because a blanket refusal would remove a real capability.**
 * There is no erase-store command anywhere in this protocol, so writing something dark
 * over the store is the only way to clear it, and without that the phone's free `MODE`
 * return is stuck showing the last save for ever. `EncodeOptions.blank: 'clear'` is how
 * a caller says the dark panel is the point. It reads as intent at the call site rather
 * than as a bypass flag, which is why it is not a boolean.
 */
export const BLANK_SAVE =
  'nothing here is lit, so this save spends flash to leave the panel dark. Clearing ' +
  'the saved store is the one good reason to do that, and it has to be asked for.'

/**
 * Everything wrong with a `Content`, as sentences. Empty means it is sendable.
 *
 * A list rather than a throw because the Compose screen wants to disable a button
 * and say why, and because more than one thing can be wrong at once.
 */
export function check(content: Content, opts: EncodeOptions = {}): string[] {
  const { bitmap, route, motion } = content
  const cols = width(bitmap)
  const out: string[] = []

  if (bitmap.length !== ROWS) out.push(`bitmap has ${bitmap.length} rows, not ${ROWS}`)
  if (bitmap.some((row) => row.length !== cols)) out.push('bitmap rows differ in length')
  if (cols === 0) out.push('bitmap has no columns')
  const bad = (v: number) => v < 0 || v > MAX_LEVEL || !Number.isInteger(v)
  if (bitmap.some((row) => row.some(bad))) {
    out.push(`levels must be integers 0 to ${MAX_LEVEL}`)
  }

  if (route === 'live' && cols > MAX_LIVE_COLUMNS) {
    // Not a truncation: the firmware drops a column index >= 24 outright.
    out.push(`live route holds ${MAX_LIVE_COLUMNS} columns, got ${cols}`)
  }
  if (route === 'saved') {
    // Per type, because the two limits are unrelated and reached differently: type 1
    // runs out of bytes, and type 2 is accepted far past the point it stops being
    // displayed, so its limit is what the panel shows rather than what DATCP allows.
    const type = opts.type ?? savedType(content)
    const limit = maxColumns(type)
    if (cols > limit) {
      out.push(
        type === dats.TYPE_IMAGE
          ? `type 2 shows only ${limit} columns, got ${cols}; the device accepts up ` +
            `to ${IMAGE_ACCEPT_CEILING} and displays none of the rest. Send it as ` +
            `type 1 to keep the width, which drops the grey`
          : `saved route holds ${limit} columns at type ${type}, got ${cols}`,
      )
    }
    // `cols > 0` because a zero-column bitmap already gets its own sentence above, and
    // two messages for one situation is noise.
    //
    // Flattened, because that is what type 1 actually puts on the panel: a threshold
    // above every level in the content leaves nothing lit, and reading the raw bitmap
    // here passed the very save this rule exists to refuse. With no threshold the two
    // agree, `flatten` defaulting to 1 and levels being integers.
    if (
      type === dats.TYPE_TEXT &&
      cols > 0 &&
      opts.blank !== 'clear' &&
      !anyLit(flatten(bitmap, opts.threshold))
    ) {
      out.push(BLANK_SAVE)
    }
  }
  if (route === 'live' && motion.kind === 'scroll') {
    // MODE displays the saved store and discards the live buffer, so asking the
    // device to scroll a live drawing throws that drawing away.
    out.push('scrolling is a saved-route mode; MODE discards the live buffer')
  }
  if (motion.kind === 'scroll' && (motion.speed < 0 || motion.speed > MAX_SPEED)) {
    out.push(`speed must be 0 to ${MAX_SPEED}, got ${motion.speed}`)
  }
  return out
}

export function assertValid(content: Content, opts: EncodeOptions = {}): Content {
  const problems = check(content, opts)
  if (problems.length) throw new Error(problems.join('; '))
  return content
}

export interface Encoded {
  /** `dats.TYPE_TEXT` or `dats.TYPE_IMAGE`, for `dats.datsStart`. */
  type: number
  payload: Uint8Array
  columns: number
  /** True when grey levels were thrown away to fit type 1. Tell the user. */
  flattened: boolean
}

export interface EncodeOptions {
  /** Force a type instead of picking one from the content. */
  type?: number
  /**
   * Lowest level that survives flattening to type 1.
   *
   * Ignored unless the type resolves to type 1, so dithering a grey drawing down
   * to monochrome means passing `type: TYPE_TEXT` as well; on its own this option
   * silently does nothing, because grey content picks type 2 and keeps its levels.
   */
  threshold?: number
  /**
   * What a type 1 save with nothing lit means. Defaults to `refuse`.
   *
   * `clear` is the caller saying the dark panel is the point, which is the only way to
   * empty the saved store on this protocol. See `BLANK_SAVE`.
   */
  blank?: 'refuse' | 'clear'
}

/**
 * Bytes for the saved route, and which type byte announces them.
 *
 * Type 2 beyond the vendor's own 72 bytes was `notes/app-plan.md` verify item 4 and
 * is now run: accepted to 383 columns, `ERROR` from 384, and never written to flash
 * at any width. *verified* 2026-08-09 on `GLASSES-125B37`.
 */
export function encodeSaved(content: Content, opts: EncodeOptions = {}): Encoded {
  assertValid(content, opts)
  const grey = hasGrey(content.bitmap)
  const type = opts.type ?? savedType(content)
  const flattened = type === dats.TYPE_TEXT && grey
  const payload =
    type === dats.TYPE_IMAGE
      ? dats.encodeImage(content.bitmap)
      : dats.encodeBitmap(flatten(content.bitmap, opts.threshold))
  return { type, payload, columns: width(content.bitmap), flattened }
}

/**
 * The `MODE` arguments this content's motion asks for, as `protocol.mode` takes
 * them. Kind 1 is static, 2 horizontal, 3 vertical, and `dir` is a boolean.
 *
 * A description rather than a frame, so nothing above the delivery layer holds a
 * `MODE` byte. It exists at all because "scroll is `MODE 02`" was worth deciding
 * once: `protocol.scrollLeft` used to build `MODE 03`, the vertical bounce.
 */
export function modeArgs(motion: Motion): { kind: 1 | 2 | 3; dir: 0 | 1 } {
  return motion.kind === 'scroll'
    ? { kind: 2, dir: motion.dir }
    : { kind: 1, dir: 0 }
}
