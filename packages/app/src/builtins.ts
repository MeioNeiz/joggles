/**
 * The content the glasses already have: 11 built-in images and 19 built-in animations.
 *
 * These are the only things a pair of glasses can show with nothing connected, and until
 * now this app could not offer them at all. They are not content in the sense the rest of
 * the app means it: there is nothing to upload, nothing to store and nothing to delete,
 * because the frames are data inside the firmware. Showing one is a single command that
 * writes no flash (`notes/what-to-build.md`, "One library to pick from").
 *
 * **The frames come from the firmware image, offline.** `research/tools/bankdump.ts`
 * resolves each bank by walking the firmware's own dispatch table, renders a
 * representative frame and writes `builtins-data.ts`, which is checked in because
 * `firmware/` is gitignored and the phone can never read the image itself. That tool's
 * header carries the decode, the two frame formats and the provenance;
 * `bun research/tools/bankdump.ts check` fails if the generated file has drifted from the
 * image. This file is the hand-written half: what the rows are called, what a tap costs
 * and what it can throw away.
 *
 * **What is addressed, and the one thing to check before trusting a tap.** `ANIM n`
 * selects display mode n + 5 and `IMAG n` selects frame n of the one image bank, both
 * hand-decoded from the handlers (`bankdump.ts`, "How a command reaches a bank"). The
 * vendor app instead sends `ANIM 20` to `ANIM 29`, which under that mapping are not these
 * banks at all, so one of the two readings is wrong and no hardware session has settled
 * it. Everything here is therefore *derived*: a thumbnail is what the firmware holds, not
 * what anyone has seen on a panel. The thumbnails are what make it one look to settle -
 * send `Animation 1` and compare - and `bankdump.ts show anim-0` prints the same frame as
 * ASCII for exactly that comparison.
 *
 * **Rows are numbered, not named.** A name read off an offline render is a guess about
 * content nobody has watched, and a confident wrong name is worse than a number beside a
 * real picture: the tile is the label. The two `note`s below come from
 * `research/firmware-internals.md` rather than from this file's own guessing.
 */
import { content, display, protocol } from '@joggles/core'
import { BUILTIN_ROWS } from './builtins-data.js'

export type BuiltinKind = 'image' | 'animation'

/** One row of `builtins-data.ts`. The generated file is typed by this. */
export interface BuiltinRow {
  id: string
  kind: BuiltinKind
  /** The command's argument: `IMAG arg` or `ANIM arg`. */
  arg: number
  /** The display mode it selects, for provenance. */
  mode: number
  /** Frames it cycles. 1 for an image. */
  frames: number
  /** Which frame of the bank the thumbnail is. */
  thumbFrame: number
  /** Where the bank sits in the firmware image. */
  bank: number
  /** Whether any frame uses level 1 or 2, which a type 1 save could not keep. */
  grey: boolean
  /** 216 digits, 9 rows of 24 levels, row 0 the bottom of the panel. */
  thumb: string
}

export interface Builtin extends Omit<BuiltinRow, 'thumb'> {
  /** What the row is called. Numbered from 1, because nobody counts from 0. */
  label: string
  /** The thumbnail as a bitmap, at panel coordinates. */
  thumb: content.Bitmap
  /** One cycle in milliseconds. 0 for a still. */
  loopMs: number
  /** Only where a research file describes the content; never a guess made here. */
  note?: string
}

/**
 * Milliseconds a built-in holds one frame.
 *
 * *verified* in `research/firmware-internals.md`: built-in banks advance every 6 ticks of
 * the 50 Hz animation clock, so 8.3 fps rather than the tick rate. It is here so a row can
 * say how long a loop runs, which is the difference between "32 frames" and "4 seconds".
 */
export const FRAME_MS = 120

/** From `research/firmware-internals.md`, "Bank inventory". Not read off the render. */
const NOTES: Record<string, string> = {
  'anim-1': 'opens on a small block and resolves into lettering',
  'anim-6': 'the "I love you" frame, and its only one',
}

/**
 * Unpack a thumbnail.
 *
 * The format is one digit per pixel, rows bottom-first, because the generated file is
 * read by people diffing it and 30 nested arrays would be 60 KB of noise. Malformed input
 * is not a case worth handling: the only writer is `bankdump.ts` and the file is checked
 * in beside this one, so a wrong length is a build-time mistake rather than something a
 * phone can encounter. `builtins.test.ts` pins the format from this side.
 */
export function unpackThumb(packed: string): content.Bitmap {
  if (packed.length !== display.ROWS * display.COLS) {
    throw new Error(
      `a thumbnail is ${display.ROWS * display.COLS} digits, got ${packed.length}`,
    )
  }
  return Array.from({ length: display.ROWS }, (_, r) =>
    Array.from({ length: display.COLS }, (_, c) => {
      const level = Number(packed[r * display.COLS + c])
      if (!Number.isInteger(level) || level < 0 || level > display.MAX_LEVEL) {
        throw new Error(`thumbnail level ${packed[r * display.COLS + c]} is not a level`)
      }
      return level
    }),
  )
}

const labelFor = (row: BuiltinRow): string =>
  row.kind === 'image' ? `Image ${row.arg + 1}` : `Animation ${row.arg + 1}`

/** Everything the glasses can show without being sent any content. Images first. */
export const BUILTINS: Builtin[] = BUILTIN_ROWS.map((row) => ({
  ...row,
  label: labelFor(row),
  thumb: unpackThumb(row.thumb),
  loopMs: row.frames > 1 ? row.frames * FRAME_MS : 0,
  note: NOTES[row.id],
}))

export const IMAGES = BUILTINS.filter((b) => b.kind === 'image')
export const ANIMATIONS = BUILTINS.filter((b) => b.kind === 'animation')

export const builtinById = (id: string): Builtin | null =>
  BUILTINS.find((b) => b.id === id) ?? null

/**
 * The one command that shows a built-in.
 *
 * The addressing lives here and nowhere else, so a screen cannot get it wrong and there
 * is one place to correct if the hardware check goes the other way. Note that
 * `protocol.animation`'s own comment describes the vendor app's +20 offset as if it were
 * the firmware's rule; the mapping used here is the firmware's, per this file's header.
 */
export const commandFor = (b: Builtin): Uint8Array =>
  b.kind === 'image' ? protocol.image(b.arg) : protocol.animation(b.arg)

/**
 * What showing a built-in costs, in the shape the save path states its own cost in.
 *
 * Zero is the whole point of the row: this is the one delivery route in the app with
 * nothing to spend, because the content is already on the device. The last sentence is
 * the part a person cannot guess: the power-on path resets the mode index and shows the
 * glasses' own first mode, so a built-in is not a setting that sticks
 * (`research/firmware-internals.md`, the button section).
 */
export const showCost = (b: Builtin) => ({
  erases: 0,
  persists: false,
  words:
    'No flash and nothing stored: it is already in the glasses, so this is one ' +
    'command. It keeps playing with the phone away, and switching the glasses off ' +
    'puts them back to their own first mode.',
})

/**
 * What a tap can throw away, which is never flash and is sometimes work.
 *
 * A built-in is a display mode, so selecting one takes the panel away from anything the
 * phone has put there: a drawing in the live buffer, and a type 2 image that was sent
 * without saving. Both live in RAM the animation engine takes over, and nothing in this
 * app can put either back - the drawing exists only if it was saved to the library, and
 * the image has no route back at all (`research/firmware-internals.md`, "`DATCP` is an
 * exact-match gate"). The saved message in flash is untouched, because only `DATCP`
 * writes there.
 */
export const TAKES_THE_PANEL =
  'This takes the panel from whatever is on it now. A drawing you have not saved to ' +
  'the phone, and a picture sent without saving, both go, and nothing here can bring ' +
  'them back. The message saved on the glasses is untouched.'

/**
 * Whether a tap still needs that warning.
 *
 * Once one built-in is showing, the live buffer and any resident image are already gone,
 * so a second tap has nothing left to discard and asking again would be theatre. That is
 * why this is a property of the panel's state rather than a preference: browsing must
 * never silently discard work, and after the first confirmed tap there is no work left to
 * discard. Remounting the screen asks again, deliberately, because anything could have
 * happened to the panel while it was gone.
 *
 * **That premise is *derived*, and it is the whole reason the warning may be skipped.**
 * What is *verified* is the `MODE` version of it: `MODE` while in DIY discards the live
 * buffer (`notes/app-plan.md`, "The connection state machine" - every early test threw a
 * drawing away), and a `MODE` over a resident type 2 image loses it for good, watched on
 * hardware 2026-08-09 (`research/firmware-internals.md`, "`DATCP` is an exact-match
 * gate"). `ANIM`/`IMAG` reach the same `set_mode`, so they should behave the same, but
 * nobody has sent one with a drawing on the panel and looked. The failure that costs
 * something is the second tap being the unwarned one, so **a caller that can put fresh
 * work on the panel between two taps must go back to passing `false`** rather than
 * trusting that the first tap emptied it.
 */
export const warnBeforeShowing = (alreadyShowing: boolean): boolean => !alreadyShowing

/** How long a loop runs, for a row that has to say it in a few characters. */
export const loopWords = (b: Builtin): string => {
  if (b.frames <= 1) return 'still'
  return `${b.frames} frames, ${(b.loopMs / 1000).toFixed(1)}s loop`
}

/**
 * How many lit pixels of a thumbnail land where the panel has no LED.
 *
 * The built-ins were drawn for a panel without our dead LEDs, so some of their content
 * cannot arrive: `display.alive()` knows where. Worth stating rather than quietly masking,
 * because a person comparing the tile with the glasses would otherwise think the app had
 * drawn it wrong.
 */
export const hiddenPixels = (thumb: content.Bitmap): number => {
  let n = 0
  for (let r = 0; r < display.ROWS; r++) {
    for (let c = 0; c < display.COLS; c++) {
      if (thumb[r][c] > 0 && !display.alive(r, c)) n++
    }
  }
  return n
}
