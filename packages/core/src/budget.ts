/**
 * The flash-wear budget, and the per-device ledger it is enforced from.
 *
 * `DATCP` is the only thing this codebase does that writes flash: five hardcoded
 * 512-byte page erases at `abs 0x218cc`, the same five pages whatever the payload
 * size, so there is no wear levelling and no benefit to saving less. The lever is
 * saving less often. Nothing can read the remaining cycles back off the device, so
 * the ledger here is the only count we will ever have.
 *
 * The numbers below sit far above any human pattern and far below any loop. A
 * person saving a message every few seconds for a minute is fine; a render loop
 * hits the interval rule on its second iteration and dies loudly. Reasoning and
 * the ranked list of runaway causes: "Flash wear" in `notes/app-plan.md`.
 *
 * **It throws rather than queues.** A queue turns a runaway into a slower runaway
 * and hides the bug that caused it.
 *
 * This lives in `packages/core` so the CLI obeys it too. The laptop is where the
 * loops actually get written: our own `uploadbench.ts` spent roughly 50 to 90
 * saves in one evening before anyone was counting.
 *
 * **The ledger is also the only record of what the device is holding**, which is a
 * second job and it is not an accident: the cheapest save is the one that is skipped,
 * so the guard has to answer "is this already there?" anyway. The device has two
 * stores and the answer differs per store, so every record says which one it hit
 * (`SaveRecord.type`) and the two questions worth asking are `holds()` and
 * `storedHash()`. Both are documented on the walk they share.
 */

/** One `DATCP` that was sent. `ok` is the device's answer, not whether flash moved. */
export interface SaveRecord {
  at: number
  hash: string
  columns: number
  /** `DATCPOK`. A failed save still spent the erases, so it is still counted. */
  ok: boolean
  /**
   * Which store this save aimed at: the DATS type it announced, not one inferred
   * from the payload. `session.save()` writes it and nothing else may.
   *
   * **Optional because it did not exist**, and the ledgers on this Mac and on the
   * Pixel are full of records from before it did. A record with no type is not a type
   * 1 record, it is a save to a store nobody can name any more, and `storedHash()`
   * refuses to answer over one for exactly that reason. `holds()` can still answer,
   * because `fingerprint` mixes the type into the hash, so a hash that matches a type
   * 1 payload could only have been written by a type 1 save.
   *
   * A stored type this codebase does not recognise must arrive here as `undefined`
   * rather than as a number, because the walk below reads any other type as "a save
   * to the other store, which left this one alone". That is a job for whoever parses
   * a ledger off disk, and on the phone it is `app/src/ledger-shape.ts`.
   */
  type?: number
}

/**
 * The DATS type that writes flash, which is the only one with a durable residency.
 *
 * `dats.TYPE_TEXT`. Not imported: this file is the guard the whole codebase depends
 * on and it has no imports at all, which is what lets it be read in one sitting. The
 * asymmetry it buys is real, though, and both residency rules below turn on it: a
 * type 1 store survives later saves to the other store, and a type 2 image does not
 * survive anything (*verified*: it is destroyed by the next `DATS` of either type,
 * `dats.ts`).
 */
export const FLASH_TYPE = 1

export interface DeviceLedger {
  device: string
  lifetime: number
  first: number | null
  last: number | null
  /** Save times inside the last 24h, pruned on write. Feeds the hour and day rules. */
  window: number[]
  /** The last 50, newest last. Duplicate hashes in a row are the runaway signature. */
  recent: SaveRecord[]
}

/**
 * Where a ledger persists. Async because the phone's storage is, and a lost
 * ledger is a lost count rather than a lost device.
 */
export interface LedgerStore {
  load(device: string): Promise<DeviceLedger | null>
  save(ledger: DeviceLedger): Promise<void>
}

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

export const LIMITS = {
  /** Minimum gap between saves to one device. */
  intervalMs: 3_000,
  /** Past this many in a rolling hour, each save needs an explicit `confirm`. */
  perHour: 30,
  /** Past this many in a rolling day, each save needs a developer `override`. */
  perDay: 200,
  /** How many save records are kept for after-the-fact diagnosis. */
  recent: 50,
} as const

export type Rule = 'interval' | 'hour' | 'day'

export class BudgetError extends Error {
  constructor(
    readonly rule: Rule,
    message: string,
  ) {
    super(message)
    this.name = 'BudgetError'
  }
}

export interface SaveOptions {
  /** Acknowledge the hourly limit for this one save. */
  confirm?: boolean
  /** Developer override for the daily limit. Not a user-facing control. */
  override?: boolean
  /**
   * Which store this save is aimed at, so the duplicate check knows what to compare
   * against. `FLASH_TYPE` when the caller does not say, which is what every caller
   * that predates the field meant.
   *
   * `session.SaveOpts` declares the same field with the wire detail on it; it is here
   * because the guard needs it, and passing it twice would let the two disagree.
   */
  type?: number
}

/** In-memory store. The default, and what automated tests should use. */
export function memoryStore(): LedgerStore {
  const held = new Map<string, DeviceLedger>()
  return {
    async load(device) {
      return held.get(device) ?? null
    },
    async save(ledger) {
      held.set(ledger.device, ledger)
    },
  }
}

export function emptyLedger(device: string): DeviceLedger {
  return { device, lifetime: 0, first: null, last: null, window: [], recent: [] }
}

/**
 * FNV-1a over the payload, with the DATS type mixed in.
 *
 * Only ever compared for equality against the previous save, so a 32-bit
 * non-cryptographic hash is the right size of hammer, and it keeps this package
 * free of a crypto dependency it would otherwise need on React Native.
 */
export function fingerprint(payload: Uint8Array, type: number): string {
  let h = 0x811c9dc5
  const mix = (b: number) => {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  mix(type)
  for (const b of payload) mix(b)
  return `${h.toString(16).padStart(8, '0')}:${payload.length}`
}

/** Saves inside the rolling hour and day windows. What the About screen shows. */
export function counts(ledger: DeviceLedger, now: number): { hour: number; day: number } {
  const window = ledger.window.filter((t) => t > now - DAY_MS)
  return { hour: window.filter((t) => t > now - HOUR_MS).length, day: window.length }
}

/**
 * The last record that still describes what store `type` holds, or null.
 *
 * The walk is the whole of the residency reasoning in this file, and every step of it
 * is a claim about the device:
 *
 *  - **A `DATCP` the device did not acknowledge ends the walk.** The erases happened
 *    at its end whatever it replied, so the store it aimed at now holds nobody knows
 *    what, and without a type nobody can even say which store that was.
 *  - **An acknowledged save to the *other* store is looked straight through**, but
 *    only when this store is the flash one: type 2 stops in RAM and is destroyed by
 *    the next `DATS` of either type, so a type 2 residency cannot survive a later
 *    save the way a flash one does.
 *  - **A record with no type decides**, because it may have been a save to this very
 *    store and there is no way left to tell. What a caller may do with it differs,
 *    which is why `holds` and `storedHash` are two functions and not one.
 */
function decider(ledger: DeviceLedger, type: number): SaveRecord | null {
  for (let i = ledger.recent.length - 1; i >= 0; i--) {
    const rec = ledger.recent[i]
    if (!rec.ok) return null
    if (rec.type === undefined || rec.type === type) return rec
    if (type !== FLASH_TYPE) return null
  }
  return null
}

/**
 * Does store `type` already hold exactly this payload? The duplicate check.
 *
 * An untyped record can answer this one soundly even though it cannot answer
 * `storedHash`: `fingerprint` mixes the DATS type into the hash, so a record whose
 * hash equals a type 1 payload's fingerprint was necessarily a type 1 save of that
 * payload, whatever the record has since forgotten about itself.
 */
export function holds(ledger: DeviceLedger, type: number, hash: string): boolean {
  return decider(ledger, type)?.hash === hash
}

/**
 * What store `type` is believed to hold, by hash. Null means "unknown".
 *
 * Answers only over a record that says which store it hit, so a ledger written before
 * `SaveRecord.type` existed reads as unknown rather than as type 1. That is the safe
 * direction and the only honest one: the worst a null costs is one redundant save,
 * where a wrong hash shows the wrong content with no way for anyone to notice.
 *
 * `playlist.residentHash()` is this over the flash store, and it is what the app's
 * "on the glasses" badge and its free `MODE` return route both read.
 */
export function storedHash(ledger: DeviceLedger, type: number): string | null {
  const rec = decider(ledger, type)
  return rec?.type === type ? rec.hash : null
}

export class FlashBudget {
  /**
   * When each device was last cleared to save, held in memory rather than read
   * back from the ledger.
   *
   * Without it, two saves fired at once both pass the interval rule, because
   * neither has recorded anything yet when the other checks. That is not a corner
   * case: a React effect under StrictMode double-invokes, which is the single most
   * likely runaway in the app.
   */
  private attempts = new Map<string, number>()

  constructor(
    private store: LedgerStore = memoryStore(),
    private now: () => number = Date.now,
  ) {}

  async ledger(device: string): Promise<DeviceLedger> {
    return (await this.store.load(device)) ?? emptyLedger(device)
  }

  /**
   * Decide whether this save may proceed.
   *
   * Returns false for a payload the device already holds, which is a skip and not
   * an error: skipping writes no flash, so it is the safest of the three outcomes
   * and is checked first. Anything else that breaches a limit throws.
   */
  async allow(device: string, hash: string, opts: SaveOptions = {}): Promise<boolean> {
    const now = this.now()
    const ledger = await this.ledger(device)

    // "Already on the glasses" is a question about ONE of the device's two stores,
    // and it used to be asked of the last acknowledged save of any type. That was
    // wrong in both directions: a type 2 save from the drawing screen made a resident
    // reel look like new content and spent five real erases putting back what was
    // already there, and a failed save was walked straight past to an older match
    // whose content its erases had already destroyed. `decider` is where both live.
    if (holds(ledger, opts.type ?? FLASH_TYPE, hash)) return false

    // Absent is -Infinity, not 0: a device that has never been saved to must read
    // as "long ago" rather than "at the epoch".
    const never = Number.NEGATIVE_INFINITY
    const previous = Math.max(ledger.last ?? never, this.attempts.get(device) ?? never)
    const since = now - previous
    if (since < LIMITS.intervalMs) {
      throw new BudgetError(
        'interval',
        `${device}: ${(since / 1000).toFixed(1)}s since the last save, minimum is ` +
          `${LIMITS.intervalMs / 1000}s. Saves write flash; this rate is a loop, not ` +
          `a person. See "Flash wear" in notes/app-plan.md`,
      )
    }

    const { hour, day } = counts(ledger, now)
    if (hour >= LIMITS.perHour && !opts.confirm) {
      throw new BudgetError(
        'hour',
        `${device}: ${hour} saves in the last hour, limit is ${LIMITS.perHour}. ` +
          `Confirm explicitly to continue`,
      )
    }
    if (day >= LIMITS.perDay && !opts.override) {
      throw new BudgetError(
        'day',
        `${device}: ${day} saves in the last day, limit is ${LIMITS.perDay}. ` +
          `This needs a developer override, not a confirmation`,
      )
    }

    this.attempts.set(device, now)
    return true
  }

  /**
   * Count a `DATCP` that has been sent.
   *
   * Called whatever the device replied, because the erases happen at the device's
   * end and a rejected save has still spent them.
   */
  async count(device: string, rec: Omit<SaveRecord, 'at'>): Promise<DeviceLedger> {
    const now = this.now()
    const ledger = await this.ledger(device)
    ledger.lifetime += 1
    ledger.first ??= now
    ledger.last = now
    ledger.window = [...ledger.window, now].filter((t) => t > now - DAY_MS)
    ledger.recent = [...ledger.recent, { at: now, ...rec }].slice(-LIMITS.recent)
    await this.store.save(ledger)
    return ledger
  }
}
