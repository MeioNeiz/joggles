/**
 * Spraying one still picture at the pairs around you: temporary, no flash, one at a time.
 *
 * The design is `notes/what-to-build.md`, "At a festival: spraying a temporary image at
 * nearby pairs", which is Jacob's ask kept verbatim: *"update all the glasses around us
 * except the ones we have specifically connected to (Unless we mark as such) to show
 * whatever we want, it should keep scanning and doing this, although wary of battery
 * life"*. The CLI has had the text version since 2026-08-10 (`cli/src/broadcast.ts`);
 * this is the phone's, and it sends pictures.
 *
 * **What makes it fair is the delivery route, not the intent.** Every property below is
 * structural, not a promise in a comment:
 *
 *  - **No flash on anyone's unit, ever.** A still goes over the live buffer as 24
 *    columns and a built-in is one `IMAG`/`ANIM` command. Neither is a `DATS`, so no
 *    page is erased on a stranger's glasses and no stranger's advert name enters this
 *    phone's wear ledger. Nothing here names `save`, `deliver` or `DATCP`, and
 *    `spray.test.ts` crawls this file to keep it that way.
 *  - **The wearer undoes it in one action**: a power cycle, their own button, or their
 *    app reconnecting. Their saved message is in flash and is untouched.
 *  - **One still frame per pair, never a loop.** That is what keeps a spray out of the
 *    5 to 30 Hz band safety item 7 in `notes/app-plan.md` is about: the harm vector is
 *    the content, and a spray cannot animate what it sends. (A built-in *does* animate,
 *    on the device's own engine, at a rate no phone chooses.)
 *  - **Push once per newly-seen pair, never on a timer.** `done` is keyed on advert
 *    name and payload hash, so a pair that has already shown *this* picture is left
 *    alone however many times it is heard again. Change the picture and it is eligible
 *    again, which is the design's own rule.
 *  - **The radio rests between passes.** Scan, drain the batch, stop, wait. Connect,
 *    push, disconnect is far kinder than a held connection, and the rest is the answer
 *    to the battery worry in the ask.
 *
 * **No `LiveSender` is built here, and that is deliberate.** The app is allowed exactly
 * one per connection (`panel-session.ts`) and the shell owns it; a spray that made its
 * own would be the second. A one-shot frame is what `Glasses.show` is for, so a sprayed
 * pair gets a `Glasses` with no sender attached and the shell's rule is untouched.
 *
 * **The platform handle stops at `deps.open`.** `Discovered.id` is a MAC on Android and
 * a per-install UUID on iOS (`ble-words.ts`), and no event this module emits carries
 * one: rows are named by advert name, so there is nothing for a screen to print by
 * accident.
 *
 * **Crew pairs are skipped rather than sprayed.** This app holds no crew key, so every
 * frame it sent a `JOGGLES-` unit would be garbage the firmware silently drops, which
 * looks exactly like a pair that ignored us. Better to say so.
 *
 * **`done` is a nuisance record, not a consent record.** The consent half is `ours` and
 * `never` below. So, unlike the CLI, a pair is recorded only once it has actually shown
 * the picture: a pair whose push failed was not sprayed, and next time it is in range it
 * deserves the attempt rather than a silent skip. It stays in `handled` for the rest of
 * the run so a pair held by its owner's phone is not hammered.
 */
import { Grid, content, protocol as p, viewport } from '@joggles/core'
import { type Builtin, commandFor } from './builtins.js'

/** What one advert gives us. `Discovered` satisfies it; the id goes no further. */
export interface Advert {
  id: string
  name: string
}

/**
 * What a spray sends, priced at nothing and hashed once.
 *
 * Two kinds because both are free and they fail differently: a still is ours and holds
 * whatever we drew, a built-in is the device's own and keeps animating with the phone
 * away, which for a walk-by is the better trick.
 */
export type SprayPayload =
  | { kind: 'still'; label: string; hash: string; frame: content.Bitmap }
  | { kind: 'builtin'; label: string; hash: string; builtin: Builtin }

/**
 * 32-bit FNV-1a, which is all the dedupe key needs to be.
 *
 * A collision means a pair is skipped that should have been sprayed: one missed picture,
 * never a double push. That is the direction to be wrong in, and the reason this is not
 * `budget.fingerprint` - that one wants the DATS encoding of a payload, and nothing here
 * may go near the save path.
 */
function fnv(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const lit = (frame: content.Bitmap): boolean => frame.some((row) => row.some((v) => v > 0))

/**
 * One panel's worth of any bitmap, ready to spray. Null when nothing in it is lit.
 *
 * Clipped through `viewport.windowAt`, so `alive()` is applied **at the window** and the
 * dead-pixel hole cannot travel with the picture. Wide content shows its first
 * screenful, which is the same answer `one-tap` gives a still too wide for the panel.
 *
 * The refusal is the planner's rule from `one-tap.ts`, for the same reason: 24 legal
 * dark columns are indistinguishable from the app doing nothing, and a spray that
 * silently lights nothing is the worst thing this feature could do to its own credibility.
 */
export function stillPayload(bitmap: content.Bitmap, label: string): SprayPayload | null {
  const frame = viewport.windowAt(bitmap, 0)
  if (!lit(frame)) return null
  return { kind: 'still', label, hash: fnv(`still:${frame.map((r) => r.join('')).join('')}`), frame }
}

/** A built-in as a payload. Always sendable: it is already in every unit's flash. */
export function builtinPayload(builtin: Builtin): SprayPayload {
  return {
    kind: 'builtin',
    label: builtin.label,
    hash: fnv(`builtin:${builtin.id}`),
    builtin,
  }
}

/**
 * The payload as a grid, greys and all.
 *
 * `Grid.blit` is not used on purpose: it sets every non-zero pixel to full brightness,
 * and the live buffer holds four levels. Grey costs nothing on this route - it is
 * `savedType()` that turns one grey pixel into a type 2 - so there is no reason to
 * flatten a drawing on its way to a stranger's panel.
 */
export function gridFor(frame: content.Bitmap): Grid {
  const grid = new Grid()
  frame.forEach((row, r) => row.forEach((v, c) => v > 0 && grid.set(r, c, v)))
  return grid
}

/** Which pairs are fair game. Every set is keyed on the advert name, as every store is. */
export interface SprayPolicy {
  /** Said to be left alone, in one tap on a row. Beats everything else here. */
  never: ReadonlySet<string>
  /** Fair game though this phone knows them: the "unless we mark as such" half. */
  always: ReadonlySet<string>
  /** Pairs this phone knows: named, remembered, or saved to. Skipped by default. */
  ours: ReadonlySet<string>
  /** Advert name to the payload hash it has already shown. */
  done: ReadonlyMap<string, string>
}

export type SkipWhy = 'never' | 'crew' | 'already' | 'ours'

export type Verdict = 'send' | SkipWhy

/**
 * Whether to spray this pair, and if not, which rule stopped it.
 *
 * Order is the point. An explicit "leave them alone" outranks everything, including a
 * mark that would otherwise make the pair fair game, because that mark is a convenience
 * and the refusal is a person's request. `already` sits above `ours` so that a pair
 * marked `always` still gets one push per picture rather than one per pass.
 */
export function decide(name: string, hash: string, policy: SprayPolicy): Verdict {
  if (policy.never.has(name)) return 'never'
  if (name.startsWith(p.CREW_NAME_PREFIX)) return 'crew'
  if (policy.done.get(name) === hash) return 'already'
  if (policy.ours.has(name) && !policy.always.has(name)) return 'ours'
  return 'send'
}

/** Why a pair was left alone, in the words a row prints. */
export const skipWords: Record<SkipWhy, string> = {
  never: 'left alone, as you asked',
  crew: 'a crew pair: this app has no crew key for it',
  already: 'already showing this one',
  ours: 'one of yours',
}

/**
 * The little of `Glasses` a spray is allowed to touch.
 *
 * Narrower than the real thing on purpose, the same trick `proximity.ts` plays with
 * `AdvertSource`: `save()` is not on this type, so the flash-writing path is not
 * reachable through the handle this module is given. A `Glasses` satisfies it.
 */
export interface SprayPair {
  begin(): Promise<void>
  show(grid: Grid, full?: boolean): Promise<number>
  command(frame: Uint8Array): Promise<void>
  end(mode?: 'keep' | 'off' | 'restore'): Promise<void>
}

export interface SprayDeps {
  scan(onFound: (advert: Advert) => void, tuning?: { duplicates?: boolean }): Promise<void>
  stop(): Promise<void>
  /** Connect and attach. The one place a platform handle is used, and it ends here. */
  open(advert: Advert): Promise<SprayPair>
  /** Injected so the pass structure runs under `bun test` without waiting for it. */
  sleep(ms: number): Promise<void>
}

export interface SprayTiming {
  /** How long to gather adverts when nothing eligible is around. */
  windowMs?: number
  /** Once one pair is queued, how much longer to wait for the cluster around it. */
  graceMs?: number
  /** Radio idle between passes. The battery half of the ask. */
  restMs?: number
  /** Hold each connection open after the frame lands, to watch it happen. */
  dwellMs?: number
}

/**
 * Defaults, and why they are these numbers.
 *
 * `windowMs` is three of ble-plx's Android low-power report intervals (512ms every
 * 5.12s, *verified* in its bundled source, see `proximity.ts`), so a stationary pair
 * gets two chances to be heard in one pass. `graceMs` is the CLI's, which is the
 * difference between draining a queue of one and draining the group somebody is standing
 * in. `restMs` is the rest the design rule asks for, and it is a floor on how often one
 * wearer can be re-sprayed with a *changed* picture as well as a battery figure.
 */
export const TIMING: Required<SprayTiming> = {
  windowMs: 15_000,
  graceMs: 800,
  restMs: 20_000,
  dwellMs: 0,
}

/** How often the gather loop looks at its own queue. Not a radio interval. */
const TICK_MS = 150

export type SprayEvent =
  | { kind: 'pass'; n: number }
  | { kind: 'lit'; name: string }
  | { kind: 'skipped'; name: string; why: SkipWhy }
  /** The raw failure: `pairWords(error, name)` is the screen's job, never this file's. */
  | { kind: 'failed'; name: string; error: unknown }
  | { kind: 'resting'; ms: number }

/** Distinct pairs, not events: a pair heard on ten passes is one row and one number. */
export interface SprayTally {
  passes: number
  lit: number
  skipped: number
  failed: number
}

export interface SprayRun {
  /** Finishes after the pair in flight. The wire is never left half-written. */
  stop(): void
  done: Promise<SprayTally>
}

/**
 * Scan, drain, rest, repeat, until `stop()`.
 *
 * `policy` is a function rather than a value so that marking a pair mid-run takes effect
 * on the next pass: at a festival the whole point of "leave them alone" is that it works
 * the moment somebody asks, and a snapshot taken at the start would not.
 *
 * The gather loop counts its own sleeps instead of reading a clock, which is what lets a
 * test drive whole passes deterministically with a sleep that resolves at once.
 */
export function runSpray(
  deps: SprayDeps,
  payload: SprayPayload,
  policy: () => SprayPolicy,
  onEvent: (event: SprayEvent) => void,
  timing: SprayTiming = {},
): SprayRun {
  const { windowMs, graceMs, restMs, dwellMs } = { ...TIMING, ...timing }
  let stopped = false
  /** Pairs this run has finished with: lit, or tried and failed. Never a skip. */
  const handled = new Set<string>()
  const litNames = new Set<string>()
  const skippedNames = new Set<string>()
  const failedNames = new Set<string>()
  let passes = 0

  const tally = (): SprayTally => ({
    passes,
    lit: litNames.size,
    skipped: skippedNames.size,
    failed: failedNames.size,
  })

  async function gather(): Promise<Advert[]> {
    const decided = policy()
    const queue = new Map<string, Advert>()
    // Skips are logged once per pass, not once per advert: a scan reports the same unit
    // every few seconds and a line each would bury the pairs actually being lit.
    const said = new Set<string>()

    await deps.scan((advert) => {
      const name = advert.name
      if (!name || queue.has(name) || handled.has(name) || said.has(name)) return
      const verdict = decide(name, payload.hash, decided)
      if (verdict === 'send') {
        queue.set(name, advert)
        return
      }
      said.add(name)
      skippedNames.add(name)
      onEvent({ kind: 'skipped', name, why: verdict })
    }, { duplicates: true })

    let waited = 0
    let firstAt = -1
    while (!stopped && waited < windowMs) {
      await deps.sleep(TICK_MS)
      waited += TICK_MS
      if (queue.size === 0) continue
      if (firstAt < 0) firstAt = waited
      if (waited - firstAt >= graceMs) break
    }
    // Stopped before every connection: CoreBluetooth dislikes scanning and connecting at
    // once, which is why `NobleScanner.first` does the same and why this alternates.
    await deps.stop().catch(() => {})
    return [...queue.values()]
  }

  async function push(advert: Advert): Promise<void> {
    // Before the wire, so a pair held by its owner's phone is tried once a run and not
    // once a pass. It is deliberately not persisted: see the docblock on `done`.
    handled.add(advert.name)
    let pair: SprayPair | null = null
    try {
      pair = await deps.open(advert)
      if (payload.kind === 'builtin') {
        // No `begin()`: `IMAG`/`ANIM` takes the panel anyway, so entering DIY first would
        // be two writes to undo one. Exactly what `one-tap.runTap` sends for a built-in.
        await pair.command(commandFor(payload.builtin))
      } else {
        await pair.begin()
        await pair.show(gridFor(payload.frame), true)
      }
      if (dwellMs > 0) await deps.sleep(dwellMs)
      litNames.add(advert.name)
      onEvent({ kind: 'lit', name: advert.name })
    } catch (error) {
      failedNames.add(advert.name)
      onEvent({ kind: 'failed', name: advert.name, error })
    } finally {
      // 'keep' leaves the picture up. Leaving DIY would restore whatever the wearer had
      // saved, which is the one thing that would make a spray look like a fault.
      await pair?.end('keep').catch(() => {})
    }
  }

  async function loop(): Promise<SprayTally> {
    try {
      while (!stopped) {
        passes += 1
        onEvent({ kind: 'pass', n: passes })
        const batch = await gather()
        for (const advert of batch) {
          if (stopped) break
          await push(advert)
        }
        if (stopped || restMs <= 0) continue
        onEvent({ kind: 'resting', ms: restMs })
        await deps.sleep(restMs)
      }
    } finally {
      await deps.stop().catch(() => {})
    }
    return tally()
  }

  return {
    stop() {
      stopped = true
    },
    done: loop(),
  }
}

/**
 * What a spray does to somebody else's glasses, in the words the screen prints.
 *
 * On the screen rather than in this docblock because the person pointing it at strangers
 * is the one who needs to be able to answer "what did you just do to my glasses", and
 * the honest answer is short.
 */
export const HARMLESS_NOTE =
  'A spray shows one still picture over what the pair is displaying now. It writes ' +
  'nothing to their memory, so a power cycle, their own button or their own app ' +
  'clears it, and the message they have saved is untouched.'

/** The radio cannot scan for strangers and hold your pair at the same time. */
export const RADIO_NOTE =
  'A spray needs the radio to itself: your own pair is let go while it runs, and the ' +
  'Glasses tab picks it up again afterwards.'

/** The one thing a person will ask that the tally cannot answer. */
export const REACH_NOTE =
  'A pair whose owner has their own app open cannot be reached at all, and nothing ' +
  'here can tell that apart from a pair that walked away.'
