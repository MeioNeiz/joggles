/**
 * How many pairs are around you, from adverts alone.
 *
 * The idea is `notes/what-to-build.md`, "Proximity greeting": a count of the other
 * `GLASSES-` pairs in the field, and a name when one of them is a friend's. It is the
 * cheapest social feature this project has, because **an advert is already being
 * broadcast**: hearing one costs the sender nothing, needs no connection, and cannot
 * write flash. The one-connection-per-device cap does not apply either, so this works in
 * a crowd where actually talking to those pairs never could.
 *
 * **Advert-only is structural here, not a promise.** This module holds an
 * `AdvertSource`, which is `scan` and `stop` and nothing else, so `Scanner.connect` is
 * not reachable through the type it is handed - and `proximity.test.ts` crawls this file
 * for the identifiers that could open a link or start a save, so the property fails the
 * build rather than drifting.
 *
 * ## The count has to expire, and the window is the platform's, not the advert's
 *
 * Nothing tells you a pair has left: it simply stops advertising, and a list that only
 * ever grows reads "8 pairs nearby" in an empty field. So a unit counts only while its
 * last advert is inside `FRESH_MS`, which makes the count a function of the clock as well
 * as of the adverts, and is why the screen recomputes on a tick instead of on a sighting.
 *
 * The window is set by how often the *scanner* reports, which is far slower than how
 * often the glasses advertise. ble-plx defaults Android to `SCAN_MODE_LOW_POWER`
 * (`DEFAULT_SCAN_MODE_LOW_POWER = 0` in its `BlePlxModule.java`, *verified* in the
 * bundled source, and `scan()` in `ble.ts` passes no `scanMode`), a 512ms listen every
 * 5.12s, so a pair sitting still on a table is reported about every 5s however fast it
 * shouts.
 *
 * **12s buys exactly one missed report.** Deliveries are 5.12s apart, so one miss puts
 * the next at 10.24s and two puts it at 15.36s: under ~11s a stationary unit blinks out
 * on a single miss, and at 12s it blinks out on two in a row. *Corrected: this said 12s
 * was "two missed reports plus slack", which would need 16s.* The number stays at 12s
 * anyway, because the count falling is the feature and a 16s window would take that long
 * to notice a pair leaving; the way to a genuinely twitchy count is
 * `scanMode: ScanMode.LowLatency`, which is a battery decision nobody has taken.
 *
 * A consequence worth knowing before trying to witness the count falling: `Scan.tsx`
 * runs a round for 20s, so a pair has to leave in roughly the first 8 seconds of a round
 * for the drop to happen before the number freezes.
 *
 * iOS is the other half of the same problem: CoreBluetooth reports each peripheral
 * **once per scan** unless duplicates are asked for (ble-plx's `allowDuplicates`, iOS
 * only), so without them every unit falls out of the window and the count decays to zero
 * while the scan list still shows four rows. `feed` asks for duplicates by default for
 * exactly that reason.
 *
 * ## Keyed on the advert name
 *
 * The same key the nickname map and the ledger use, and for the same reason: the advert
 * name carries the last three bytes of the MAC, where `Discovered.id` is a per-host
 * handle. A count keyed on the handle double-counts a unit the platform re-identifies
 * between rounds; keyed on the name it cannot. Our own firmware keeps that property -
 * `build-firmware.ts` refuses a prefix that is not exactly 8 bytes, because the boot code
 * writes the MAC suffix at a fixed `name + 8` and a short prefix would make every crew
 * unit advertise the same string, which would collapse this count to 1.
 *
 * The scan list keys its rows on `Discovered.id`, so the two can disagree: two rows, one
 * pair. That is the honest direction to be wrong in for a count.
 *
 * ## RSSI is a hint, and 0 is not a strong signal
 *
 * `ble.ts` reads `device.rssi ?? 0` and Android reports `127` when it has no reading, so
 * a missing signal arrives as a number **stronger than any real one**: unfiltered, a pair
 * we cannot hear at all reads as the one in your hand. Anything at or above 0 is
 * therefore `'unknown'` here, never `'reach'`.
 *
 * That check alone only covers the first sample. A unit that is still being reported but
 * with nothing usable in it keeps refreshing its freshness while its last believable
 * reading stands still, so the band has its own clock: a reading older than the window is
 * `'unknown'` however recently the advert arrived. Without it a pair heard once at -45 and
 * then reported with `127` for a minute still counted as `within reach`, which is the same
 * lie one sample later.
 *
 * Real readings jitter by around 10 dB between adverts from a device that has not moved,
 * so a band taken from the latest sample flickers between two labels while nothing
 * happens. Hence the EWMA. The thresholds themselves are *unverified*: no calibration
 * against a tape measure has been done, and "Discovery in dense RF" in
 * `notes/what-to-build.md` is the standing warning that RSSI cannot identify a specific
 * pair, only rank the ones you can already hear.
 *
 * ## What it deliberately is not
 *
 * The other half of the idea, "a matching symbol when a friend's pair is nearby", is read
 * here as a symbol **on the phone**: putting one on the panel needs a connection and a
 * write, which is the opposite of advert-only. Since track 10 landed, a nickname is a
 * better answer than a symbol anyway, so `friendLine` names them.
 *
 * Nothing here holds React state. `Presence` is a plain object the screen keeps in a ref
 * and publishes on a tick, so a festival's worth of adverts costs one map write each and
 * cannot reorder the scan rows - review-10's defect, which this feature is otherwise in a
 * good position to reintroduce.
 */

/** What one advert tells us. Core's `Discovered` satisfies it. */
export interface Sighting {
  name: string
  rssi: number
}

export type Band = 'reach' | 'room' | 'far' | 'unknown'

export interface NearUnit {
  /** Advert name, which is the identity and the nickname key. */
  name: string
  /** Smoothed dBm, rounded, or null when no believable reading has ever arrived. */
  rssi: number | null
  band: Band
  /** Milliseconds since the last advert, at the moment asked. Never negative. */
  age: number
}

export interface Nearby {
  count: number
  /** Strongest first, then by name. Deterministic, so two ticks cannot reshuffle it. */
  units: readonly NearUnit[]
  bands: Readonly<Record<Band, number>>
}

/** How long a pair counts as nearby after its last advert. See the docblock. */
export const FRESH_MS = 12_000

/** Weight of a new reading in the smoothed one. Two samples get within 3 dB. */
const SMOOTHING = 0.5

/** Band edges in dBm, *unverified*: nothing has been calibrated against a distance. */
const REACH_DBM = -60
const ROOM_DBM = -80

/** Sorts below any real reading, so a unit with none never ranks as the strongest. */
const NO_READING = -1000

/**
 * A reading worth believing.
 *
 * Both ends matter. At or above 0 is the missing-signal case above; below -127 is off the
 * end of the 8-bit scale RSSI is reported on and so is not a measurement either.
 */
const usable = (rssi: number): boolean => Number.isFinite(rssi) && rssi < 0 && rssi >= -127

export function bandOf(rssi: number | null): Band {
  if (rssi === null) return 'unknown'
  if (rssi >= REACH_DBM) return 'reach'
  if (rssi >= ROOM_DBM) return 'room'
  return 'far'
}

/** One unit's signal for a row: the number, or the honest absence of one. */
export function signalText(rssi: number): string {
  return usable(rssi) ? `${Math.round(rssi)} dBm` : 'no reading'
}

export interface Presence {
  /** Fold in one advert, heard at `at`. */
  saw(unit: Sighting, at: number): void
  /** The summary at `now`. A read: computed, never stored. */
  nearby(now: number): Nearby
  /** Units held, fresh or not. Exists so the memory bound is a test, not a hope. */
  tracked(): number
}

export interface PresenceOptions {
  freshMs?: number
  /** EWMA weight of a new reading, 0 to 1. 1 is no smoothing at all. */
  smoothing?: number
}

export function createPresence(opts: PresenceOptions = {}): Presence {
  const freshMs = opts.freshMs ?? FRESH_MS
  const alpha = opts.smoothing ?? SMOOTHING

  /**
   * Keyed on the advert name, in a `Map` rather than an object: review-10 found that a
   * plain-object map answers for every member of `Object.prototype`, and an advert named
   * `__proto__` writes the prototype instead of an entry. A `Map` cannot do either.
   *
   * `read` is when the last believable reading arrived and is not `seen`: an advert with
   * no usable RSSI in it moves `seen` and leaves `read` where it was.
   */
  const held = new Map<string, { seen: number; read: number; rssi: number | null }>()

  /**
   * Drop what can never be fresh again, so the map is bounded by the units actually
   * around rather than by everything ever heard. Only the mutator prunes, which leaves
   * `nearby()` a pure read whatever order it is asked in.
   */
  function prune(at: number): void {
    for (const [name, unit] of held) {
      if (at - unit.seen > freshMs) held.delete(name)
    }
  }

  return {
    saw(unit, at) {
      // An advert with no name is neither countable nor nameable, and `ble.ts` filters
      // to the two prefixes before this, so one arriving here means something changed.
      if (!unit.name) return
      const prev = held.get(unit.name)
      const believable = usable(unit.rssi)
      const rssi = believable
        ? prev?.rssi == null
          ? unit.rssi
          : prev.rssi + alpha * (unit.rssi - prev.rssi)
        : // An unusable sample says nothing, so it must not drag the average towards
          // zero, which is where the `?? 0` in ble.ts would send it. It does not renew
          // `read` either, or a run of them would preserve a band for ever.
          (prev?.rssi ?? null)
      held.set(unit.name, { seen: at, read: believable ? at : (prev?.read ?? at), rssi })
      prune(at)
    },

    nearby(now) {
      const units: NearUnit[] = []
      const bands: Record<Band, number> = { reach: 0, room: 0, far: 0, unknown: 0 }
      for (const [name, unit] of held) {
        // Clamped, because `Date.now()` can step backwards over a clock correction and a
        // negative age would otherwise read as a sighting from the future. The cost is
        // that a jump back keeps everything nearby until the clock catches up, which
        // beats the whole field vanishing.
        const age = Math.max(0, now - unit.seen)
        if (age > freshMs) continue
        // The reading expires on its own clock, so a pair still being reported with
        // nothing usable in it stops claiming the band it had. Same window: one bad
        // sample says nothing, a window of them says the old number describes nothing.
        const stale = Math.max(0, now - unit.read) > freshMs
        const rssi = unit.rssi === null || stale ? null : Math.round(unit.rssi)
        const band = bandOf(rssi)
        bands[band] += 1
        units.push({ name, rssi, band, age })
      }
      const strength = (u: NearUnit) => u.rssi ?? NO_READING
      units.sort((a, b) => strength(b) - strength(a) || (a.name < b.name ? -1 : 1))
      return { count: units.length, units, bands }
    },

    tracked() {
      return held.size
    },
  }
}

/**
 * The scanning surface this module is allowed to see: adverts, and the off switch.
 *
 * Narrower than core's `Scanner` on purpose. A `BleScanner` satisfies it, and passing one
 * in hands over no way to open a connection.
 */
export interface AdvertSource<S extends Sighting = Sighting> {
  scan(onFound: (unit: S) => void, tuning?: { duplicates?: boolean }): Promise<void>
  stop(): Promise<void>
}

export interface FeedOptions<S extends Sighting> {
  /** Every advert, unchanged, for the caller's own list. Called after `saw`. */
  onSighting?: (unit: S) => void
  /** A scan that never started: permission refused, adapter off. */
  onError?: (e: Error) => void
  now?: () => number
  /** Defaults on, because the count needs re-sightings. See the docblock. */
  duplicates?: boolean
}

/**
 * Pipe one scan into a `Presence`, and return the way to stop.
 *
 * One scan, two consumers: the screen's row list and the count come off the same
 * callback, because a second `startDeviceScan` would replace the first rather than run
 * beside it, and because a count is not worth a second radio duty cycle.
 *
 * `saw` runs before `onSighting`, so a summary taken from inside that handler already
 * includes the advert that triggered it.
 */
export function feed<S extends Sighting>(
  source: AdvertSource<S>,
  presence: Presence,
  opts: FeedOptions<S> = {},
): () => void {
  const { onSighting, onError, now = Date.now, duplicates = true } = opts
  let live = true

  source
    .scan((unit) => {
      // A callback after teardown is a scan the platform has not stopped yet. Counting
      // it would resurrect a screen that is gone.
      if (!live) return
      presence.saw(unit, now())
      onSighting?.(unit)
    }, { duplicates })
    .catch((e: unknown) => {
      if (live) onError?.(e instanceof Error ? e : new Error(String(e)))
    })

  return () => {
    live = false
    source.stop().catch(() => {})
  }
}

/**
 * The count as a sentence.
 *
 * `live` false is the frozen case: the scan has ended, so the number is what was around
 * when it did rather than what is around now, and saying so is the difference between a
 * stale number and a lie. Nothing here claims a pair is connected or reachable, only that
 * it was heard.
 */
export function headline(near: Nearby, live = true): string {
  if (near.count === 0) {
    // Not "No pairs heard" for the frozen case: a pair heard early and then switched off
    // leaves its row on screen, and a headline denying it was ever heard contradicts the
    // row underneath it. What is true either way is that nothing was advertising at the
    // end, and the empty case has "Nothing found. Scan again" to say the rest.
    return live ? 'Listening for pairs nearby' : 'Nothing advertising when the scan ended'
  }
  const pairs = near.count === 1 ? '1 pair' : `${near.count} pairs`
  return live ? `${pairs} advertising` : `${pairs} when the scan ended`
}

const BAND_LABEL: Record<Band, string> = {
  reach: 'within reach',
  room: 'in the room',
  far: 'further off',
  unknown: 'with no reading',
}

/** The split by signal, strongest band first, empty when nothing is nearby. */
export function bandLine(near: Nearby): string {
  const order: Band[] = ['reach', 'room', 'far', 'unknown']
  return order
    .filter((band) => near.bands[band] > 0)
    .map((band) => `${near.bands[band]} ${BAND_LABEL[band]}`)
    .join(' · ')
}

/** Names to show, most any caller should pass. Beyond this it is a crowd, not friends. */
const FRIENDS_SHOWN = 3

/**
 * Which of the nearby pairs you know, as a sentence. Empty for none.
 *
 * Takes nicknames rather than reading the store, so this file stays free of imports and
 * the caller keeps the one source of truth for names.
 */
export function friendLine(names: readonly string[]): string {
  // Distinct, in arrival order: nothing stops two pairs carrying one nickname, and
  // "Larry and Larry are among them" reads as a bug rather than as two friends.
  const distinct = [...new Set(names)].filter((name) => name.length > 0)
  if (distinct.length === 0) return ''
  const shown: string[] = distinct.slice(0, FRIENDS_SHOWN)
  const rest = distinct.length - shown.length
  if (rest > 0) shown.push(`${rest} more`)
  const joined =
    shown.length === 1
      ? shown[0]
      : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
  return distinct.length === 1 ? `${joined} is one of them` : `${joined} are among them`
}
