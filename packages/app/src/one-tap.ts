/**
 * One tap on anything showable: what it will do, what it will cost, then doing it.
 *
 * The redesign's centre (`notes/app-plan.md`, "The redesign"). The library is the front
 * door and a tap has to just work, so the routing that used to be spread across three
 * screens' `onPress` handlers is one pure planner a test can walk:
 *
 *     built-in                       one command, free
 *     still, fits or clipped to 24   live columns, free, greys kept
 *     scroller already in flash      SPEED + MODE via deliver's duplicate skip, free
 *     any other scroller             the one flash save, behind a sheet that states cost
 *
 * `planTap` decides; `runTap` executes exactly what was planned. The split is the
 * repo's law that cost is stated before it is spent: a screen shows `plan` (the sheet
 * for a flash plan, nothing for a free one) and hands the same object back, so what
 * was promised and what is sent cannot resolve differently.
 *
 * **Free means free by construction, not by luck.** The live route writes no flash
 * ever. The return route goes through `deliver()`, whose budget guard skips an
 * identical payload before the interval rule, so predicting `return` wrongly costs a
 * sheet-less save only when the ledger's last record is not what the device holds -
 * and the prediction reads the same last-acknowledged record the guard compares
 * against (`playlist.residentHash`'s rule).
 *
 * **Wide still content is clipped, not refused** (first feedback table: "Text thats
 * too long should still show, just go off the screen"). The clip is `viewport.windowAt`
 * at offset 0, which applies `alive()` at the window, so a dead-pixel hole cannot
 * travel with a glyph. Emptiness is still refused, because windowing a blank bitmap
 * yields 24 legal dark columns and five erases for nothing is the thing the planner
 * exists to prevent.
 *
 * Nothing here retries, and the only route to flash is `deliver()`: the choke point
 * and the runaway rules are untouched.
 */
import { budget, content, dats, display, effects, font, viewport } from '@joggles/core'
import type { Glasses, LiveSender } from '@joggles/core'
import { type Builtin, commandFor } from './builtins.js'
import {
  type Cost,
  type Delivered,
  type Grey,
  type GreyChoice,
  costOf,
  deliver,
  greyChoice,
  problems,
} from './deliver.js'
import { tuning } from './effects-ui/catalogue.js'
import { planLoop } from './effects-ui/plan.js'
import type { SavedItem } from './library.js'

/** Anything a tap can show: a built-in by reference, or content by value. */
export type Showable =
  | { kind: 'builtin'; builtin: Builtin }
  | { kind: 'piece'; piece: content.Content; grey?: Grey }

/**
 * A library item as a `Showable`.
 *
 * Effects re-render from their recipe, which for a wide loop is real work (~7k field
 * samples), so results are cached by identity: `id` plus `at` names one immutable
 * saved content, and a rename changes neither.
 */
export function showable(item: SavedItem): Showable {
  return { kind: 'piece', piece: pieceFor(item) }
}

const pieces = new Map<string, content.Content>()

export function pieceFor(item: SavedItem): content.Content {
  const key = `${item.id}:${item.at}`
  const held = pieces.get(key)
  if (held) return held
  const piece = build(item)
  pieces.set(key, piece)
  return piece
}

const thumbs = new Map<string, content.Bitmap>()

/**
 * One panel's worth of an item, for a tile, at tile cost.
 *
 * Its own path because `pieceFor` on an effect renders the full loop - ~7k field
 * samples plus a seam scan - and the 2026-08-12 session found the Show tab paying
 * that per effect item just to draw 24 columns ("ui feels a bit laggy"). An effect
 * tile renders one panel of the field directly; everything else windows the piece
 * it already has. Null when the content cannot draw itself (user text the font
 * refuses), which a row survives and a screen must not die of.
 */
export function thumbFor(item: SavedItem): content.Bitmap | null {
  const key = `${item.id}:${item.at}`
  const held = thumbs.get(key)
  if (held) return held
  try {
    const frame =
      item.kind === 'effect'
        ? viewport.windowAt(
            effects.EFFECTS[item.effect]({
              // `tuning` strips the AUTO sentinel, exactly as planLoop does before
              // handing a knob bag to a generator.
              ...tuning(item.opts),
              columns: display.COLS,
              levels: 2,
              dither: item.dither,
            }),
            0,
          )
        : viewport.windowAt(pieceFor(item).bitmap, 0)
    thumbs.set(key, frame)
    return frame
  } catch {
    return null
  }
}

function build(item: SavedItem): content.Content {
  if (item.kind === 'text') {
    return content.text(item.text, item.motion, { font: font.fontByName(item.font) })
  }
  if (item.kind === 'drawing') {
    return { bitmap: item.levels, route: 'live', motion: { kind: 'static' } }
  }
  return planLoop({
    name: item.effect,
    opts: item.opts,
    columns: item.columns,
    dither: item.dither,
    dir: item.motion.kind === 'scroll' ? item.motion.dir : 0,
    speed: item.motion.kind === 'scroll' ? item.motion.speed : 65,
  }).piece
}

/** What the planner needs to know about the world. All three are the caller's state. */
export interface TapContext {
  connected: boolean
  /** The last type 1 hash this pair acknowledged, or null. `playlist.residentHash`. */
  resident: string | null
  /** Whether the panel holds unsaved live work a switch would discard. */
  liveWork: boolean
}

export type Tap =
  | { kind: 'blocked'; free: true; why: string[] }
  | { kind: 'builtin'; free: true; replaces: boolean }
  | { kind: 'live'; free: true; replaces: boolean; clipped: boolean }
  | { kind: 'return'; free: true; replaces: boolean }
  | {
      kind: 'save'
      free: false
      cost: Cost
      /** Non-null when the content has grey: the sheet offers both answers, costed. */
      grey: GreyChoice | null
      replaces: boolean
    }

/**
 * The fingerprint a type 1 save of this piece would leave in the ledger.
 *
 * Null for anything that would not be a type 1 save, because only type 1 has a
 * residency worth predicting: type 2 dies at power off and the live route stores
 * nothing.
 */
const prints = new WeakMap<content.Content, string | null>()

export function fingerprintOf(piece: content.Content, grey: Grey = 'flatten'): string | null {
  if (content.hasGrey(piece.bitmap) && grey === 'keep') return null
  // Keyed on the piece object: `pieceFor` hands back one object per saved item, so a
  // library pass encodes and hashes each 740-column payload once, not per render.
  const held = prints.get(piece)
  if (held !== undefined) return held
  let print: string | null
  try {
    print = budget.fingerprint(dats.encodeBitmap(piece.bitmap), dats.TYPE_TEXT)
  } catch {
    print = null
  }
  prints.set(piece, print)
  return print
}

const lit = (bitmap: content.Bitmap): boolean => bitmap.some((row) => row.some((v) => v > 0))

export function planTap(what: Showable, ctx: TapContext): Tap {
  if (!ctx.connected) {
    return {
      kind: 'blocked',
      free: true,
      why: ['Nothing connected. Find your pair on the Glasses tab.'],
    }
  }
  if (what.kind === 'builtin') return { kind: 'builtin', free: true, replaces: ctx.liveWork }

  const { piece, grey = 'flatten' } = what
  if (!lit(piece.bitmap)) {
    return { kind: 'blocked', free: true, why: ['Nothing is lit in this one yet.'] }
  }

  if (piece.motion.kind === 'static') {
    const clipped = content.width(piece.bitmap) > content.MAX_LIVE_COLUMNS
    const view = clipped ? clip(piece) : { ...piece, route: 'live' as const }
    const why = problems(view, 'live')
    if (why.length > 0) return { kind: 'blocked', free: true, why }
    // Anything a MODE would discard is equally discarded by overwriting the live
    // buffer, but nothing is *lost*: the buffer is rewritten, not switched away from,
    // so a still never warns and never asks.
    return { kind: 'live', free: true, replaces: false, clipped }
  }

  const why = problems(piece, 'saved', grey)
  if (why.length > 0) return { kind: 'blocked', free: true, why }
  const print = fingerprintOf(piece, grey)
  if (print !== null && print === ctx.resident) {
    return { kind: 'return', free: true, replaces: ctx.liveWork }
  }
  return {
    kind: 'save',
    free: false,
    cost: costOf(piece, 'saved', grey),
    grey: greyChoice(piece),
    replaces: ctx.liveWork,
  }
}

/** The first screenful, masked at the window, still at panel width. */
function clip(piece: content.Content): content.Content {
  return {
    bitmap: viewport.windowAt(piece.bitmap, 0),
    route: 'live',
    motion: { kind: 'static' },
  }
}

/** What `runTap` needs from the app: the session's own plumbing, never rebuilt here. */
export interface TapDeps {
  glasses: Glasses
  /** `PanelSession.live`: the one sender, DIY entered if nobody has. */
  live(): Promise<LiveSender>
  /** Tell the session the panel was taken, so the sender is forgotten, not repaired. */
  dropped(): void
  /** Asked between blocks; a true stops an upload before `DATCP`, spending nothing. */
  cancel?: () => boolean
  /**
   * Blocks acknowledged out of blocks total, for a bar. Only a save calls it.
   *
   * Passed straight to `SaveOpts.progress`, so the numbers are the session's own and
   * this module invents nothing: a screen that renders `sent / total` is showing what
   * the radio has actually done.
   */
  progress?: (sent: number, total: number) => void
}

export interface TapResult {
  showing: boolean
  /** Whether flash was actually written. A skipped save comes back false. */
  spent: boolean
  message: string
  delivered?: Delivered
}

export async function runTap(deps: TapDeps, what: Showable, plan: Tap): Promise<TapResult> {
  if (plan.kind === 'blocked') {
    return { showing: false, spent: false, message: plan.why.join(' ') }
  }

  if (plan.kind === 'builtin') {
    if (what.kind !== 'builtin') throw new Error('plan and content disagree')
    await deps.glasses.command(commandFor(what.builtin))
    deps.dropped()
    return {
      showing: true,
      spent: false,
      message: 'On the glasses. It keeps playing with the phone away.',
    }
  }

  if (what.kind !== 'piece') throw new Error('plan and content disagree')

  if (plan.kind === 'live') {
    const view = plan.clipped ? clip(what.piece) : what.piece
    const sender = await deps.live()
    sender.set(view.bitmap)
    await sender.flush()
    return {
      showing: true,
      spent: false,
      message: plan.clipped
        ? 'On the glasses: the first screenful of it. Scroll it to show the rest.'
        : 'On the glasses.',
    }
  }

  // `return` and `save` are the same wire path on purpose: deliver() owns the
  // SPEED-then-MODE order and the budget guard skips the duplicate payload, so a
  // mispredicted `return` degrades to a real save rather than to a wrong sequence.
  const out = await deliver(deps.glasses, what.piece, {
    grey: what.grey ?? 'flatten',
    cancel: deps.cancel,
    progress: deps.progress,
  })
  if (out.showing) deps.dropped()

  if (out.cancelled) return { showing: false, spent: false, message: 'Stopped. Nothing was written.', delivered: out }
  if (!out.showing) {
    // A rejected commit still spent its erases: `status: 'saved'` means the pages were
    // written, and only `committed` says the device liked what it got (track 32). So
    // the wear has to be reported even though nothing reached the panel, or the count
    // the Glasses tab shows drifts below the truth in exactly the case a user would
    // ask about it.
    //
    // *The panel is UNCHANGED, not showing older content*: since track 32, a failed
    // commit sends no `MODE` at all, so the device keeps displaying whatever it was
    // displaying. The old wording described the bug rather than the behaviour.
    const spent = out.status === 'saved' && out.cost.erases > 0
    return {
      showing: false,
      spent,
      message: spent
        ? `The glasses replied ${out.reply}, so nothing changed on the panel.`
        : out.reply,
      delivered: out,
    }
  }
  const spent = out.status === 'saved' && out.cost.erases > 0
  return {
    showing: true,
    spent,
    message: spent
      ? out.cost.persists
        ? 'Saved to the glasses. It stays with the phone off.'
        : 'Showing, with its greys. Gone at the next power off.'
      : 'Already on this pair, so it switched over for free.',
    delivered: out,
  }
}

/**
 * Which library item a pair is holding in flash, by fingerprint.
 *
 * Reads the same last-acknowledged record `planTap` compares against, so the badge in
 * the library and the free `return` route can never disagree. Null when the pair holds
 * something this phone did not save, or nothing at all.
 */
export function residentItem(items: SavedItem[], resident: string | null): SavedItem | null {
  if (resident === null) return null
  for (const item of items) {
    // Only content whose tap would be a type 1 save can be resident.
    if (item.kind === 'drawing') continue
    const piece = pieceFor(item)
    if (piece.motion.kind !== 'scroll') continue
    if (fingerprintOf(piece) === resident) return item
  }
  return null
}
