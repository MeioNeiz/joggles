/**
 * What a `ledger.json` is allowed to contain, and the save log read back out of it.
 *
 * Split from `ledger.ts` so it runs under bun: that file imports expo-file-system and
 * so cannot be tested, and this is the half where being wrong costs something. Two
 * jobs, both about trusting a file: `reviveAll` decides what of it survives, and
 * `saveLog` is what the screen shows from what survived.
 *
 * **The parse is a trust boundary and it used to not be one.** `ledger.ts` accepted any
 * object `JSON.parse` produced as the whole ledger, which puts arbitrary values inside
 * the flash guard: `budget.counts()` does `ledger.window.filter(...)`, so a `window`
 * that is not an array throws from inside `FlashBudget.allow()`, and `count()` does
 * `lifetime += 1`, so a string lifetime becomes `"121"` and the count is finished. A
 * half-finished write leaves plausible JSON as easily as garbage, and this is read
 * before every save.
 *
 * **Damage is repaired upwards, never downwards.** This is a wear counter, so the
 * dangerous direction is a count that reads lower than the truth: it hands back an
 * allowance nobody earned. So an unreadable `lifetime` falls back to how many saves the
 * file still carries evidence of rather than to zero, and an unreadable `last` falls
 * back to the newest timestamp anywhere in the entry. Both can only make the guard
 * stricter.
 *
 * **`window` is rebuilt from the records rather than merely cleaned**, which is
 * review-12's fix and the one place this file did not do what the paragraph above says.
 * The hour and day rules read only `window`, so a torn `window` with `recent` intact
 * behind it used to drop both of them: a file holding 35 records inside the last hour
 * threw `hour` when clean and allowed the save when its `window` was damaged, which is
 * a corrupt file permitting more saves than a good one. Both fields are written by the
 * same `budget.count()` call from the same `now`, so the records are evidence of
 * exactly the saves `window` is supposed to hold, and the union of the two is deduped
 * by value for that reason: a value in both is one save, and the three-second interval
 * rule makes two genuine saves at one millisecond impossible.
 *
 * The one exception is a timestamp in the future, which is dropped rather than kept: a
 * corrupt `last` far ahead of now makes every interval check read as negative, so the
 * budget would refuse every save for as long as the file existed, with no way for a
 * user to clear it. A guard that cannot be recovered from is worse than one that
 * forgets an evening.
 */
import { budget } from '@joggles/core'

/** Every device this phone has saved to, keyed the way `SessionOptions.device` is. */
export type All = Record<string, budget.DeviceLedger>

/** How many records are kept, matching `budget.LIMITS.recent`. */
const KEEP = 50

/**
 * Clock skew allowed on a stored timestamp before it is treated as damage.
 *
 * Not zero: a save written seconds ago on a phone whose clock has since stepped back
 * is ordinary, and discarding it would forgive the interval rule.
 */
const FUTURE_SLACK_MS = 60_000

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A stored instant, or null: finite, after the epoch, and not in the future. */
const cleanTime = (v: unknown, now: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= now + FUTURE_SLACK_MS
    ? v
    : null

const cleanCount = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0

function cleanRecord(raw: unknown, now: number): budget.SaveRecord | null {
  if (!isRecord(raw)) return null
  const at = cleanTime(raw.at, now)
  if (at === null) return null
  if (typeof raw.hash !== 'string' || raw.hash === '') return null
  // `ok` decides whether `allow()` treats this as "already on the glasses", so a
  // missing one must read as false: a save the device never acknowledged is not there,
  // and mistaking that for a duplicate skips a save the user asked for.
  // Only 1 or 2 survive, and anything else arrives as `undefined` rather than being
  // passed through. `budget.storedHash` reads an unrecognised type as "a save to some
  // other store, which left this one alone", so a stray number would answer residency
  // questions about a store that does not exist. Dropping the field entirely was the
  // bug this replaces: a ledger reloaded from disk came back typeless, and the phone
  // read residency as unknown after every restart, costing one redundant save.
  const type = raw.type === 1 || raw.type === 2 ? raw.type : undefined
  return {
    at,
    hash: raw.hash,
    columns: cleanCount(raw.columns),
    ok: raw.ok === true,
    ...(type === undefined ? {} : { type }),
  }
}

/**
 * One device's row, rebuilt field by field rather than passed through.
 *
 * `device` is taken from the map key, not from the entry: the two always agree when
 * this app wrote them, so a disagreement is damage, and re-keying it keeps a wear count
 * that dropping the row would throw away.
 */
export function reviveLedger(
  raw: unknown,
  device: string,
  now = Date.now(),
): budget.DeviceLedger {
  const it = isRecord(raw) ? raw : {}
  const stored = (Array.isArray(it.window) ? it.window : [])
    .map((t) => cleanTime(t, now))
    .filter((t): t is number => t !== null)
  const recent = (Array.isArray(it.recent) ? it.recent : [])
    .map((r) => cleanRecord(r, now))
    .filter((r): r is budget.SaveRecord => r !== null)
    .sort((a, b) => a.at - b.at)
    .slice(-KEEP)

  // Every instant the entry still knows a save happened at, so a lost `first`/`last`
  // and a lost `window` are all recovered from evidence rather than invented.
  const times = [...new Set([...stored, ...recent.map((r) => r.at)])].sort((a, b) => a - b)
  // Pruned to the rolling day the way `budget.count()` prunes it on write, so this
  // holds what a clean file would hold and `counts()` reads the same number either way.
  const window = times.filter((t) => t > now - budget.DAY_MS)
  const first = cleanTime(it.first, now)
  const last = cleanTime(it.last, now)
  return {
    device,
    // Every instant is one save, so the count of them is a floor on how many happened
    // and it wins over a smaller or unreadable stored count. `window` reaches further
    // back than `recent`, which keeps only 50, so counting the union rather than the
    // records alone is what stops a day of saves reading as fifty.
    lifetime: Math.max(cleanCount(it.lifetime), times.length),
    first: times.length ? Math.min(first ?? Number.POSITIVE_INFINITY, times[0]) : first,
    last: times.length ? Math.max(last ?? 0, times[times.length - 1]) : last,
    window,
    recent,
  }
}

/**
 * A map with no prototype, which is what stops a device key answering for a method.
 *
 * `JSON.parse` makes `__proto__` an ordinary own key, so a file carrying one would
 * otherwise be **assigned** into the prototype chain rather than stored, and a lookup
 * for a device named `toString` would hand `FlashBudget` a function to add 1 to. The
 * nickname store hit the same trap from the read side (`nicknameIn`); closing it on the
 * map itself covers both directions at once.
 */
const empty = (): All => Object.create(null) as All

/**
 * The whole file, one entry per device, with unreadable entries dropped.
 *
 * Degrades to empty rather than throwing, because this is read on the path into a save:
 * a ledger that cannot be parsed must cost the history and not the save.
 */
export function reviveAll(raw: unknown, now = Date.now()): All {
  if (!isRecord(raw)) return empty()
  const out = empty()
  for (const [device, entry] of Object.entries(raw)) {
    // A blank key cannot be looked up again, and an entry that is not an object holds
    // nothing to recover: those are the only two that are dropped outright.
    if (device === '' || !isRecord(entry)) continue
    out[device] = reviveLedger(entry, device, now)
  }
  return out
}

export interface LogRow extends budget.SaveRecord {
  /**
   * The save before this one had the same payload hash.
   *
   * The runaway signature from `notes/app-plan.md` "Visibility": the guard's duplicate
   * check only compares against the last **acknowledged** save, so a run of identical
   * hashes means something re-uploaded content the device already held, which is what
   * an effect, a timer or an unstable dependency looks like after the fact.
   */
  repeat: boolean
}

/**
 * The last 50 saves, newest first, which is the order a person reads them in.
 *
 * `repeat` is computed against the record **before** each one in time, so it survives
 * the reversal: a pair of duplicates marks the later of the two whichever way the list
 * is walked.
 */
export function saveLog(ledger: budget.DeviceLedger): LogRow[] {
  const rows = ledger.recent.map((rec, i) => ({
    ...rec,
    repeat: i > 0 && ledger.recent[i - 1].hash === rec.hash,
  }))
  return rows.reverse()
}

/**
 * The wear count in words that stop claiming a total nobody can know.
 *
 * Track 24's finding: the screen said "2 saves to this unit, ever" while another
 * client's ledger held 11 for the same unit. Every client counts only its own saves
 * and no cycle count can be read off the device, so reconciling across clients is
 * impossible without device support - the decision here is therefore **wording, not
 * reconciliation**: the number is owned by this phone and says so. Endurance stays
 * *unverified*, so no percentage or remaining-life claim may ever join this sentence;
 * the honest scale (a pessimistic 10,000 cycles is 500 days at 20 saves a day) lives
 * in `notes/app-plan.md`, "Flash wear".
 */
export function wearWords(ledger: budget.DeviceLedger): string {
  if (ledger.lifetime === 0) return 'No saves from this phone yet.'
  const s = ledger.lifetime === 1 ? '' : 's'
  return (
    `${ledger.lifetime} save${s} from this phone. Other phones and the laptop keep `
    + 'their own counts, and the glasses keep none.'
  )
}
