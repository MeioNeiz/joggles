/**
 * What a pair turned out to be, and what that lets the app offer.
 *
 * `packages/core/src/jgx.ts` ("Talking to a mixed fleet") sets the rule: at a festival
 * the app meets stock units, crew units at v1 and later crew units at v2, so it
 * **probes rather than assumes**. `notes/firmware-design.md` says the same in four
 * words, "the app must probe, never assume". This is the phone's side of it, and three
 * separate things live here because each of them was invented at a call site once.
 *
 *  - **The record**, `Carried`. The shell gets it from one `Glasses.probe()` per
 *    connection and `settings.ts` remembers it per advert name.
 *  - **The gate**, `can()`. A feature asks whether this pair does the thing.
 *    **Nothing asks the version.** A v1 app meets a v2 unit by ignoring bits it has no
 *    name for; a v2 app meets a v1 unit by finding the bit clear. A version comparison
 *    gets both directions wrong, which is why `version` is only ever printed.
 *  - **The words**, because the common answer is "stock" and it must never read as a
 *    failure. Silence in reply to HELLO *is* the answer: the stock dispatcher has no
 *    match for our opcode and sends nothing back, so a timeout here is a result. Same
 *    pattern as `ble-words.ts` and `deliver.ts`'s `costOf()` - the sentence lives here
 *    and the screen prints it verbatim, so no call site invents wording of its own.
 *
 * **Probing opens no route to writing firmware.** `CAP.UPDATE` is a real bit a crew unit
 * can report, and this app refuses it unconditionally: `never` below, and `can()` answers
 * false however the bitmap reads. `notes/app-plan.md` safety item 1 is not "later" - the
 * app never links `ota`/`dfu` at all - and learning that a unit *could* be re-patched
 * changes nothing about that. What the dashboard does with the bit is say so out loud,
 * which is better than a silence a reader could mistake for an oversight.
 *
 * **A remembered answer is not evidence.** `Remembered` is deliberately not assignable to
 * `Carried` (`remembered?: never` on the live record), so last session's answer cannot
 * reach the gate: a unit can be reflashed between sittings, and gating on a stale record
 * is exactly the assuming this module exists to stop. It is display only, and only while
 * the probe is still out.
 *
 * **Nothing here has met a crew unit, and none of it has been rendered on a handset.**
 * No pair carries the extension: `firmware/joggles-v2.bin` is unflashed and barred
 * (`CLAUDE.md`, "Our firmware"). So every crew branch below is exercised by
 * `carried.test.ts` and by nothing else, and the stock branch - the one a real pair
 * produces today - has never been seen on a screen either. Both looks are owed.
 *
 * Pure: no `Glasses`, no BLE, no react-native, so every branch runs under `bun test`.
 */
import { jgx } from '@joggles/core'
import type { Identity } from '@joggles/core'

/** A u16 field off the wire, or off a file this phone wrote earlier. */
const word = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.max(0, Math.min(0xffff, Math.trunc(v)))
    : 0

/** What this connection's own probe answered. */
export interface Carried {
  /** `stock` is an answer, not a failure. See the docblock. */
  kind: 'stock' | 'crew'
  /** The extension version, for printing. Never compared. 0 on a stock pair. */
  version: number
  /** The capability bitmap. Read it through `can()`/`reports()`, never by hand. */
  capabilities: number
  /** When the answer landed, so a remembered one can be said to be old. */
  at: number
  /**
   * Never set on a live answer.
   *
   * Its only job is to make `Remembered` unassignable to `Carried`, so the gate cannot
   * be handed a record read off the phone's own store.
   */
  remembered?: never
}

/** The same facts, read back off this phone. Display only: it may be out of date. */
export interface Remembered {
  readonly remembered: true
  kind: 'stock' | 'crew'
  version: number
  capabilities: number
  at: number
}

/** Core's probe result, normalised: a stock pair reports no version and no bits. */
export function fromIdentity(id: Identity, at: number = Date.now()): Carried {
  if (id.kind === 'crew') {
    return {
      kind: 'crew',
      version: word(id.version),
      capabilities: word(id.capabilities),
      at,
    }
  }
  return { kind: 'stock', version: 0, capabilities: 0, at }
}

/** For the store, on the way to disk and back. */
export const remember = (c: Carried): Remembered => ({
  remembered: true,
  kind: c.kind,
  version: c.version,
  capabilities: c.capabilities,
  at: c.at,
})

/**
 * A stored record, or null if it is not one.
 *
 * `settings.ts` calls this rather than restating the shape, so a file written by a
 * different version of the app cannot put a string where a bitmap belongs and have the
 * dashboard print it.
 */
export function cleanCarried(raw: unknown): Remembered | null {
  if (typeof raw !== 'object' || raw === null) return null
  const got = raw as Record<string, unknown>
  if (got.kind !== 'stock' && got.kind !== 'crew') return null
  if (typeof got.at !== 'number' || !Number.isFinite(got.at)) return null
  return {
    remembered: true,
    kind: got.kind,
    version: word(got.version),
    capabilities: word(got.capabilities),
    at: Math.trunc(got.at),
  }
}

export type FeatureId = 'button' | 'battery' | 'sync' | 'deviceContent' | 'firmwareUpdate'

export interface Feature {
  id: FeatureId
  /** What a person would call it. */
  label: string
  /** The `jgx.CAP` bit it needs, by name, so core owns the number. */
  needs: jgx.Capability
  /** Whether this app has a control for it at all. */
  here: boolean
  /** The app refuses it whatever the pair reports. */
  never: boolean
  /** Why it is not on offer, in the words a screen prints. */
  absent: string
}

/**
 * The app's side of the capabilities `jgx.CAP` declares.
 *
 * `here` is false on every entry, and that is the honest state rather than an oversight:
 * every feature this app has runs on a stock pair, which is what safety item 1 in
 * `notes/app-plan.md` means by "this costs zero". The list exists so that the day one of
 * them grows a control, the control asks `can()` instead of reading a version - and so
 * the dashboard can say what a pair reports rather than leaving a person guessing.
 *
 * A `jgx.CAP` bit with no entry here is simply never offered, which is the correct answer
 * and needs no code. It is counted by `unnamedBits()` and named to nobody, along with
 * bits outside `jgx.CAP` entirely: a build of the app has nothing true to say about a
 * capability it has no name for beyond its existence, and `jgx.CAP` grows faster than
 * this list does. Six bits were added to it while this file was being written.
 */
export const FEATURES: readonly Feature[] = [
  {
    id: 'button',
    label: 'the on-board button reaching the phone',
    // The specific bit rather than the `INPUT` family, deliberately: gating on the
    // narrower claim means the control appears only when the unit says button edges
    // actually arrive, where the family bit would be this app assuming what is in it.
    needs: 'BUTTON',
    here: false,
    never: false,
    absent:
      'The button cycles the built-in modes on the glasses themselves. It cannot tell ' +
      'this phone anything, so nothing here can react to a press.',
  },
  {
    id: 'battery',
    label: 'how much battery it has left',
    needs: 'BATTERY',
    here: false,
    never: false,
    absent:
      'The glasses do not report their charge, so the only warning is the panel going ' +
      'out. The red light on the case is the charger, and it says nothing about level.',
  },
  {
    id: 'sync',
    label: 'several pairs kept in step',
    needs: 'SYNC',
    here: false,
    never: false,
    absent:
      'Each pair keeps its own time, so two pairs showing one animation drift apart ' +
      'and there is nothing to line them back up with.',
  },
  {
    id: 'deviceContent',
    label: 'content the glasses build themselves',
    needs: 'CONTENT',
    here: false,
    never: false,
    absent:
      'Everything is drawn on the phone and uploaded, which is what every pair does.',
  },
  {
    id: 'firmwareUpdate',
    label: 'replacing its own firmware over the air',
    needs: 'UPDATE',
    here: false,
    never: true,
    absent:
      'This app never writes firmware, whatever a pair reports it can take. That is a ' +
      'probe and a bench, not a phone in a field.',
  },
]

const featureBy = (id: FeatureId): Feature | undefined =>
  FEATURES.find((f) => f.id === id)

/** Every bit some feature above maps to. Derived, so a new entry needs no second edit. */
const FEATURE_BITS = FEATURES.reduce((all, f) => all | jgx.CAP[f.needs], 0)

/**
 * The bit that needs no feature of its own: it is the probe that just answered.
 *
 * Counting `SESSION` among the things this app cannot do would be false, and it would
 * be false on every crew pair, which is the worst place for a wrong sentence to live.
 */
const ANSWERED_BITS = jgx.CAP.SESSION

/**
 * What the pair says it can do. The wire fact, and only the wire fact.
 *
 * Separate from `can()` because the two questions have different answers and conflating
 * them is how a refusal reads as a missing feature: a unit can report `UPDATE` perfectly
 * truthfully while this app will never use it.
 */
export function reports(c: Carried | null, id: FeatureId): boolean {
  const f = featureBy(id)
  if (f === undefined || c === null || c.kind !== 'crew') return false
  return jgx.supports(c.capabilities, jgx.CAP[f.needs])
}

/**
 * Whether the app offers this feature on this pair. The one gate a control may ask.
 *
 * False for an unprobed pair, which is what makes "probe, never assume" the default
 * rather than a discipline: until the answer lands, nothing is on offer.
 */
export function can(c: Carried | null, id: FeatureId): boolean {
  const f = featureBy(id)
  if (f === undefined || f.never || !f.here) return false
  return reports(c, id)
}

/**
 * How many things the pair reports that this app cannot name at all.
 *
 * Two cases collapse into one honestly. A bit `jgx.CAP` declares but no feature above
 * maps to, and a bit `jgx.CAP` has never heard of, are the same fact to a person: this
 * version of the app has no name for it. The second is a v2 unit's news to a v1 app, and
 * it is why the count is a count rather than a list - any label would be invented.
 */
export function unnamedBits(c: Carried | null): number {
  if (c === null || c.kind !== 'crew') return 0
  let rest = c.capabilities & ~(FEATURE_BITS | ANSWERED_BITS) & 0xffff
  let count = 0
  while (rest !== 0) {
    rest &= rest - 1
    count++
  }
  return count
}

export interface Offer {
  feature: Feature
  /** The pair says it can. */
  reports: boolean
  /** The app offers it here. */
  offered: boolean
  /** Empty when offered; otherwise why not, for printing verbatim. */
  words: string
}

/** Every feature against one pair, for a screen that wants to list them. */
export function offers(c: Carried | null): Offer[] {
  return FEATURES.map((feature) => {
    const said = reports(c, feature.id)
    const offered = can(c, feature.id)
    return {
      feature,
      reports: said,
      offered,
      words: offered ? '' : feature.absent,
    }
  })
}

// --- Words -------------------------------------------------------------------------
//
// The only place the app describes a pair's firmware. A screen prints these; it does
// not compose them, and `carried.test.ts` fails the build if one starts to.

/** The short form, for the line under a pair's name. */
export const carriedLabel = (c: Carried | null): string =>
  c === null
    ? 'identifying...'
    : c.kind === 'crew'
      ? `crew firmware v${c.version}`
      : 'stock firmware'

/**
 * One sentence for what a pair is carrying.
 *
 * The stock sentence is the one that matters. Silence is how a stock unit answers, so
 * the wording has to carry "nothing went wrong" without a person having to infer it: a
 * pair that reads as broken on connect is worse than no line at all.
 */
export function carriedWords(c: Carried | null): string {
  if (c === null) return 'Asking this pair what firmware it carries.'
  if (c.kind === 'stock') {
    return (
      'Stock firmware, which is the ordinary answer and not a fault: a stock pair ' +
      'does everything this app offers.'
    )
  }
  return (
    `Crew firmware v${c.version}. Everything this app offers works exactly as it does ` +
    'on a stock pair; what is different is that this one answers when asked.'
  )
}

/**
 * What this pair answered last time, or null.
 *
 * Shown while the probe is still out, so a reconnect at a festival is not a blank line.
 * It decides nothing: `can()` cannot be handed one of these at all.
 */
export function rememberedWords(r: Remembered | null): string | null {
  if (r === null) return null
  return r.kind === 'crew'
    ? `Last time, this pair answered as crew firmware v${r.version}.`
    : 'Last time, this pair answered as stock.'
}

/** "a, b and c", for a list a person reads rather than counts. */
function prose(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * What the pair reports that this app has no control for, or null when there is
 * nothing to say.
 *
 * This is the honest half of a mixed fleet in both directions. What this build can name
 * is named; everything else is counted, because "two things I cannot name" is true and
 * any label would be invented. `jgx.CAP` grows faster than this app does, so most of
 * what a v2 unit reports lands in the count rather than the list, and that is correct.
 */
export function beyondWords(c: Carried | null): string | null {
  if (c === null || c.kind !== 'crew') return null
  const waiting = FEATURES.filter(
    (f) => !f.never && !f.here && reports(c, f.id),
  ).map((f) => f.label)
  const unnamed = unnamedBits(c)
  const said: string[] = []
  if (waiting.length > 0) {
    said.push(`It reports ${prose(waiting)}, which this app has no control for yet.`)
  }
  if (unnamed > 0) {
    said.push(
      `It reports ${unnamed} more ${unnamed === 1 ? 'thing' : 'things'} this version ` +
        'of the app has no name for, so a newer one would offer more than this.',
    )
  }
  return said.length === 0 ? null : said.join(' ')
}

/**
 * The refusal, printed only when the pair actually reports the bit.
 *
 * Said out loud rather than left silent: a unit that can take a firmware update and an
 * app that will not give it one is a gap someone would otherwise try to close.
 */
export function refusedWords(c: Carried | null): string | null {
  const refused = FEATURES.filter((f) => f.never && reports(c, f.id))
  return refused.length === 0 ? null : refused.map((f) => f.absent).join(' ')
}
