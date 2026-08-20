/**
 * Several things on one pair, for one flash write. The phone's side of `playlist.ts`.
 *
 * The complaint this answers is Jacob's, twice over on 2026-08-12: *"it seems to keep
 * having to send the animation to the device? Surely its saved and can just be switched
 * to?"* and *"can we really not have more than one saved slot?"*. On stock the literal
 * answer to the second is no: one DATS buffer per type at fixed flash pages, no slot
 * index anywhere in the protocol, so A then B then A re-uploads A because B evicted it.
 *
 * **But a reel dodges the whole problem.** `core/src/playlist.ts` packs every scrolling
 * member into ONE type 1 payload laid end to end, so a chosen set costs one `DATCP`,
 * and moving between members afterwards is `SPEED` then `MODE` with no flash at all.
 * Stills do not even need that: 24 columns fit the live buffer and go free. So the
 * favourites grid, which is already "the handful of things I switch between in a
 * field", becomes exactly the set worth committing.
 *
 * **What this module is not.** It is not a second route to the wire: `commit()` and the
 * steps go through the same `Glasses` the rest of the app uses, and the flash guard is
 * still `budget.ts` at the choke point. It is not the device's own button playlist
 * either, though they are the same bytes: the button cycles whatever is in the store,
 * which after a commit is this reel, so the pair keeps cycling with the phone away.
 * That is worth saying on the screen rather than hiding, and `notes/playlist.md` has
 * why the two must not be blurred.
 *
 * **Residency is per pair and read from the ledger**, the same `residentHash` reading
 * `one-tap` uses for its free `MODE` return, so a reel already on this pair costs
 * nothing to resume and the UI can say so before the tap.
 */
import { budget, content, dats, display, playlist as pl } from '@joggles/core'
import type { Glasses } from '@joggles/core'
import { pieceFor } from './one-tap.js'
import type { PanelSession } from './panel-session.js'
import type { SavedItem } from './library.js'

/** How many library items a reel can hold, straight from core's own bounds. */
export const MIN_ITEMS = pl.MIN_ENTRIES
export const MAX_ITEMS = pl.MAX_ENTRIES

/**
 * Library items as playlist entries, in the order given.
 *
 * A drawing is a still at panel width and rides the live buffer; text and effects
 * carry whatever motion they were saved with. `pieceFor` is reused rather than
 * re-rendering, so an effect recipe is rendered once for the whole app and a reel of
 * ten wide loops does not re-run ten generators.
 */
export function entriesFor(items: SavedItem[]): pl.Entry[] {
  return items.map((item) => {
    const piece = pieceFor(item)
    return {
      label: item.name,
      bitmap: piece.bitmap,
      motion: piece.motion,
      // A wide effect loop is built to close on itself, so a gap after it turns its
      // seam into a dark pass. Core's `loopEntry` makes the same choice for the same
      // reason; text and drawings take the default separation.
      ...(item.kind === 'effect' ? { gap: 0 } : {}),
    }
  })
}

export interface ReelPlan {
  compiled: pl.Compiled
  /** Empty when it can be committed. Sentences, as `content.check` returns. */
  problems: string[]
  /** True when this exact reel is what the pair last acknowledged: resuming is free. */
  resident: boolean
  /** Presses in the cycle. Fewer than the item count, because scrollers share one. */
  steps: number
  /** Columns the packed reel occupies, for the upload-length estimate. */
  columns: number
}

/**
 * Whether this exact set is the reel the pair is already holding.
 *
 * Separate from `planReel` because a screen has the resident hash as a prop and no
 * ledger to hand: `App.tsx` reads the ledger once on connect and passes the hash down.
 *
 * **`one-tap.residentItem` cannot answer this and must not be asked to.** It matches ONE
 * item's fingerprint, and a reel's hash is the packed payload's, so after a commit it
 * returns null for every member and the pair looks as though it is holding nothing
 * (found by review-30, 2026-08-12). This is the reel-shaped question, kept beside the
 * reel.
 */
export function reelResident(items: SavedItem[], resident: string | null): boolean {
  if (resident === null || items.length < MIN_ITEMS) return false
  const entries = entriesFor(items)
  if (pl.check(entries).length > 0) return false
  return pl.compile(entries).reel?.hash === resident
}

/**
 * Price and check a reel before anything is sent.
 *
 * `resident` is the whole reason this is worth showing: the same set committed twice
 * is one save and then nothing, and a user who has been told that stops worrying about
 * the cost of switching.
 */
export function planReel(items: SavedItem[], ledger: budget.DeviceLedger | null): ReelPlan {
  const entries = entriesFor(items)
  const problems = pl.check(entries)
  const compiled = problems.length === 0 ? pl.compile(entries) : null
  const reel = compiled?.reel ?? null
  const held = ledger ? pl.residentHash(ledger) : null
  return {
    compiled: compiled ?? { mode: 'reel', steps: [], reel: null, entries },
    problems,
    resident: reel !== null && held !== null && reel.hash === held,
    steps: compiled?.steps.length ?? 0,
    columns: reel?.columns ?? 0,
  }
}

/**
 * A `playlist.Driver` over the app's own session plumbing.
 *
 * The live half must go through `PanelSession`, not through `Glasses.show`: the app is
 * allowed exactly one `LiveSender` per connection and a second one would fight the
 * first over what the panel holds. Anything that takes the panel away from the live
 * buffer (`MODE`, and the `DATCP` that precedes it) is followed by `dropped()`, because
 * a taken buffer must be forgotten rather than repaired.
 */
export function reelDriver(glasses: Glasses, session: PanelSession): pl.Driver {
  return {
    begin: async () => {
      await session.live()
    },
    show: async (grid: display.Grid, full = false) => {
      const sender = await session.live()
      sender.set(content.fromGrid(grid))
      await sender.flush()
      return full ? display.COLS : 0
    },
    command: async (frame: Uint8Array) => {
      await glasses.command(frame)
      // Every command a reel sends is a MODE or a SPEED, and MODE is the one-way door
      // out of the live buffer.
      session.dropped()
    },
    save: async (bitmap, opts) => {
      const out = await glasses.save(bitmap, { ...opts, type: dats.TYPE_TEXT })
      session.dropped()
      return out
    },
  }
}

/**
 * A cycler over the app's session, seeded with what the pair is believed to hold.
 *
 * Seeding matters: `Cycler` tracks type 1 residency itself rather than asking the
 * budget, so a press can be priced before it happens and a revisit issues no `DATS` at
 * all. Handing it the ledger's hash is what makes the first press of an
 * already-committed reel free instead of a re-upload.
 *
 * *Corrected by review-32: this said the cycler tracks residency itself "because the
 * budget's duplicate check compares the last save of ANY type and would re-erase".
 * That stopped being true the day track 32 gave `SaveRecord` a DATS type. The check is
 * per store now, the two agree, and what the cycler still buys is the prediction and
 * the skipped `DATS` (`notes/playlist.md`, "residency is not what the budget tracks").*
 */
export function cyclerFor(
  glasses: Glasses,
  session: PanelSession,
  plan: ReelPlan,
  ledger: budget.DeviceLedger | null,
): pl.Cycler {
  return new pl.Cycler(reelDriver(glasses, session), plan.compiled, {
    resident: ledger ? pl.residentHash(ledger) : null,
  })
}
