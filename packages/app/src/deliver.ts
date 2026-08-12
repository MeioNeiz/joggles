/**
 * The three ways content reaches the panel, what each one costs, and the words for it.
 *
 * This is out of the screen and in plain functions for one reason - one of these paths
 * is the app's only flash write, and a sequence buried in an `onPress` can only be
 * checked by a person looking at a 9x24 LED panel. Here it runs against `core`'s mock
 * transport, so "the phone sends DATS, then the blocks, then DATCP, then SPEED, then
 * MODE" is a test, and so is "Show now never sends any of them". See `deliver.test.ts`.
 *
 * **Three paths, and only one of them writes flash:**
 *
 *     showNow()          960b, 24 columns, greys kept, 0 erases, gone when anything
 *                        else takes the panel
 *     deliver() type 1   960a + DATCP, 740 columns, monochrome, 5 page erases,
 *                        survives the power going off
 *     deliver() type 2   960a + DATCP, 24 columns, greys kept, 0 erases, gone at
 *                        power off and no way back once a MODE has been sent
 *
 * The screen has to make that difference visible without anyone reading this file,
 * which is what `costOf()` is for: cost first, in one sentence, before the press.
 * `notes/app-plan.md`, "What that means for the UI".
 *
 * **Type 2 is the odd one and the reason `greyChoice()` exists.** `savedType()` picks
 * the type from whether the content has grey in it, so one dim pixel decides whether a
 * save survives a power cycle, and nothing at the device end reports which happened.
 * This module never lets that be implicit: grey content is a question with two answers
 * and both are costed. It used to be a bare refusal.
 *
 * Type 2's whole behaviour is *verified* on hardware, by track 5 on 2026-08-09: it is
 * accepted to 383 columns, displays only the first 24, writes no flash, shows itself on
 * `DATCPOK`, and any later `MODE` discards it for good. That is why withholding `MODE`
 * here is a rule rather than a precaution. The one *derived* claim this module leans on
 * is the level flattening returns at, in `greyChoice()` below.
 *
 * Nothing here retries. `ERROR` is a legitimate reply to an over-long payload, so a
 * retry loop would be a save loop, which is fourth on the runaway list in
 * `notes/app-plan.md`.
 *
 * **`MODE` goes out only when the device is holding this content**, which for two
 * months it did not. `session.save()` answers `saved` for any `DATCP` it managed to
 * send, because the five erases happen at the device's end whatever it replies and
 * the wear count has to include them; this file withheld `MODE` on `refused` alone,
 * so a commit answered `ERROR` switched the panel to the saved store, displayed
 * whatever had survived in it, and came back `showing: true` - the exact outcome the
 * guard's own comment said it existed to prevent (found by track 13, fixed by 32).
 *
 * The fix is here and not in the status union, deliberately. `saved` meaning "the
 * erases were spent" is load-bearing: `budget.count()` is called on it, and splitting
 * it would move every `status !== 'saved' || reply !== 'DATCPOK'` in the CLI onto a
 * name that means something else, which is a rename dressed as a fix. What was
 * missing was a second question, so `SaveResult` gained one additive boolean
 * (`committed`) exactly the way `SaveOpts` gained `cancel`, and the two questions are
 * now asked separately: `status` is what it cost, `committed` is what it achieved.
 */
import { Glasses, LiveSender, content, dats, protocol as p } from '@joggles/core'
import type { SaveOpts, SaveResult } from '@joggles/core'

/**
 * Page erases one `DATCP` spends, whatever the payload length.
 *
 * *derived*: five hardcoded 512-byte erases at `abs 0x218cc`, hand-decoded, and there is
 * no cycle counter to read back. The screen prints this number and `lifetime * 5`, so it
 * is the app's only wear figure and it is an inference.
 */
export const ERASES_PER_SAVE = 5

/** How grey content is sent when it has grey in it. `greyChoice()` costs both. */
export type Grey = 'flatten' | 'keep'

/** Which delivery path, as the UI names them. */
export type Path = 'live' | 'saved'

export interface Cost {
  /** Flash page erases. Five or none; there is nothing in between. */
  erases: number
  /** Whether what lands survives the power going off. */
  persists: boolean
  columns: number
  /** The DATS type, or null for the live route, which has no DATS at all. */
  type: number | null
  /** Cost first, one sentence, for someone with a finger over the button. */
  words: string
}

export interface Delivered {
  /** `saved` wrote flash. `skipped` and `refused` did not. */
  status: SaveResult['status']
  /** The device's own word, or why nothing was sent. */
  reply: string
  /**
   * The device acknowledged the commit, so it is holding this content.
   *
   * Not the same question as `status`, and the gap between them was a defect: a
   * `DATCP` answered `ERROR` is `saved` (the erases were spent) and `committed:
   * false` (nothing arrived). A caller wanting "did it work" wants this one.
   */
  committed: SaveResult['committed']
  /** Lifetime saves counted against this unit, this one included. */
  saves: number
  /** Whether the panel is showing what was just committed. */
  showing: boolean
  /** True when `cancel` stopped the upload, which is a `refused` that cost nothing. */
  cancelled: boolean
  /** What it cost, so the screen reports the same numbers it promised. */
  cost: Cost
}

/**
 * `grey` is the only option this module owns.
 *
 * Everything else is `SaveOpts` and goes straight through to `session.save()`,
 * `cancel` and `progress` included, so a bar wanting blocks-against-total passes
 * `progress` here and nothing on this path counts blocks a second time.
 */
export interface DeliverOpts extends SaveOpts {
  /** What to do about grey. Ignored for content that has none. */
  grey?: Grey
}

/**
 * The DATS type this content will actually be sent as.
 *
 * `content.savedType` answers what the content *wants*; this answers what it *gets*,
 * which for grey content is whatever the user chose. Everything else here asks this
 * rather than `savedType`, so a check and a send can never resolve differently.
 */
export const typeFor = (piece: content.Content, grey: Grey = 'flatten'): number =>
  content.hasGrey(piece.bitmap) && grey === 'keep' ? dats.TYPE_IMAGE : dats.TYPE_TEXT

/**
 * What a delivery costs, before it costs it.
 *
 * The erase count is the honest part and the only part the device cannot tell us
 * afterwards: endurance for this flash is *unverified* (10,000 to 100,000 cycles is
 * typical for the class) and no cycle counter can be read back, so "five erases" plus
 * the ledger's lifetime count is the whole of what a person has to go on.
 */
export function costOf(
  piece: content.Content,
  path: Path = 'saved',
  grey: Grey = 'flatten',
): Cost {
  const columns = content.width(piece.bitmap)
  if (path === 'live') {
    return {
      erases: 0,
      persists: false,
      type: null,
      columns,
      words:
        'No flash, nothing stored: it goes straight to the panel and is gone the ' +
        'moment a save, a power cycle or the on-board button takes it away.',
    }
  }
  const type = typeFor(piece, grey)
  if (type === dats.TYPE_IMAGE) {
    return {
      erases: 0,
      persists: false,
      type,
      columns,
      words:
        'No flash: a type 2 image lands in RAM and shows itself. It keeps the grey, ' +
        'holds 24 columns, dies at the next power cycle, and the first Save ' +
        'afterwards switches away from it for good.',
    }
  }
  return {
    erases: ERASES_PER_SAVE,
    persists: true,
    type,
    columns,
    words:
      `Writes flash: ${ERASES_PER_SAVE} page erases, the same ${ERASES_PER_SAVE} ` +
      'whatever the length. It stays on the glasses with the phone off and the ' +
      'radio down.',
  }
}

/**
 * Everything that makes this content unsendable down `path`, as sentences.
 *
 * A list rather than a throw because Compose disables a button and says why, and more
 * than one thing can be wrong at once. Type-pinned, because the two DATS types have
 * unrelated ceilings and the check has to be against what will actually be sent.
 */
export function problems(
  piece: content.Content,
  path: Path = 'saved',
  grey: Grey = 'flatten',
): string[] {
  if (path === 'live') return content.check({ ...piece, route: 'live' })
  const type = typeFor(piece, grey)
  const out = content.check(piece, { type })
  // Not core's rule, because core has no idea that this module withholds `MODE` from a
  // type 2 delivery. It is the same trap one layer up: `MODE 02` is the only thing that
  // scrolls and it is also what discards the image, so a scrolling type 2 can only ever
  // be a still one.
  if (type === dats.TYPE_IMAGE && piece.motion.kind === 'scroll') {
    out.push('a type 2 image cannot scroll: MODE 02 is what discards it')
  }
  return out
}

export interface GreyChoice {
  /** Send it as type 1: monochrome, five erases, survives a power cycle. */
  flatten: Cost
  /** Send it as type 2: greys kept, no flash, gone at power off. */
  keep: Cost
  /** Why each answer cannot be sent for this content. Empty means it can. */
  blocked: { flatten: string[]; keep: string[] }
  /** What flattening does to these pixels, in the UI's words. */
  loses: string
}

/**
 * The two answers for grey content, both costed. Null when there is no grey.
 *
 * `flatten` is not a brightness cut. The host half is *verified*: nothing calls
 * `content.flatten` on this path, `dats.encodeBitmap` sets the bit on any level at all,
 * and `deliver.test.ts` pins it - so a level 1 pixel and a level 3 pixel leave the phone
 * as the same bytes. The device half is ***derived*** and is what the sentence below tells a
 * user: the 2-entry LUT at `abs 0x22da4` reads `00 03 00 00`, which makes the
 * 1-bit-to-2-bit expander map "on" to level 3, so dim pixels come back at **full**
 * brightness rather than as the dim ones the preview showed. Nobody has looked at a
 * flattened grey message on the panel, and the device will never report which happened,
 * so this is a hand-decode two documents deep (`research/firmware-internals.md`, "the
 * separate 2-entry LUT") and not an observation. What is certain either way is that the
 * grey is gone; only "at what level it returns" rests on the LUT.
 */
export function greyChoice(piece: content.Content): GreyChoice | null {
  if (!content.hasGrey(piece.bitmap)) return null
  return {
    flatten: costOf(piece, 'saved', 'flatten'),
    keep: costOf(piece, 'saved', 'keep'),
    blocked: {
      flatten: problems(piece, 'saved', 'flatten'),
      keep: problems(piece, 'saved', 'keep'),
    },
    loses:
      'Flattening drops the grey: every dim pixel comes back at full brightness, ' +
      'because the device expands one bit to its top level.',
  }
}

/**
 * Put content on the panel for free, through the live buffer.
 *
 * The sender belongs to the caller, and it must already be over a connection in DIY
 * mode - `Glasses.begin()` sends `SMVEW 01`, which is both what stops the animation
 * engine and what `LiveSender` assumes cleared the buffer. Handing the sender in
 * rather than building one here is what lets a screen press this button repeatedly
 * and have only the changed columns go out.
 *
 * It never sends `MODE`, and that is the point rather than an omission: `MODE`
 * switches to the saved store and discards this buffer, so a live path that ended in
 * one would throw away what it just drew.
 */
export async function showNow(
  sender: LiveSender,
  piece: content.Content,
): Promise<Cost> {
  const bad = problems(piece, 'live')
  if (bad.length > 0) throw new Error(bad.join('; '))
  sender.set(piece.bitmap)
  await sender.flush()
  return costOf(piece, 'live')
}

/**
 * Commit content to the device, then tell it to display it.
 *
 * Two steps and only the first costs anything, at type 1: `save()` streams into SRAM
 * and commits with `DATCP`, five page erases whatever the length, and `MODE` then
 * switches the device to its saved store, which is free and unlimited. So re-sending
 * the same text with a different direction spends nothing: the budget guard skips the
 * identical payload and the `MODE` still goes out.
 *
 * **Type 2 gets no `MODE`.** It displays itself the moment `DATCP` is acknowledged,
 * and any `MODE` after that discards it with no way back.
 */
export async function deliver(
  glasses: Glasses,
  piece: content.Content,
  opts: DeliverOpts = {},
): Promise<Delivered> {
  const { grey = 'flatten', ...saveOpts } = opts
  const bad = problems(piece, 'saved', grey)
  if (bad.length > 0) throw new Error(bad.join('; '))

  const type = typeFor(piece, grey)
  const cost = costOf(piece, 'saved', grey)
  const result = await glasses.save(piece.bitmap, { ...saveOpts, type })
  // Asked after the fact rather than remembered from before it: the callback is the
  // caller's and it is the caller's tap that flips it, so only the callback knows.
  const cancelled = result.status === 'refused' && (saveOpts.cancel?.() ?? false)
  const out = { ...result, cancelled, cost }

  // The one question `MODE` may be sent on: is the device holding this content?
  // `skipped` says it already was, `committed` says the commit was acknowledged, and
  // there is no third way to be sure. Anything else - a refused `DATS`, a cancel, or
  // a `DATCP` answered `ERROR` or `TIMEOUT` - would switch the panel to a saved store
  // holding whatever survived, and report it as this content arriving.
  if (result.status !== 'skipped' && !result.committed) {
    return { ...out, showing: false }
  }

  if (type === dats.TYPE_IMAGE) {
    // A skipped type 2 sent nothing at all, so nothing displayed itself either: the
    // budget recognised the payload from a previous save, which may since have been
    // discarded by a MODE. Claiming the panel shows it would be a guess.
    return { ...out, showing: result.committed }
  }

  // SPEED before MODE, which is the order `packages/cli/src/upload.ts` used on the run
  // that scrolled unattended. Whether the scroll timer re-reads the value afterwards is
  // untested, so nothing here relies on it.
  if (piece.motion.kind === 'scroll') await glasses.command(p.speed(piece.motion.speed))
  const args = content.modeArgs(piece.motion)
  await glasses.command(p.mode(args.kind, args.dir))
  return { ...out, showing: true }
}
