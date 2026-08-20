/**
 * The proximity count, against a mock scanner.
 *
 * Two properties carry the feature and both are asserted on behaviour rather than by
 * eye. **Advert-only**: the mock has a `connect` that fails the test if anything reaches
 * for it, and the bottom of this file crawls `proximity.ts` for every identifier that
 * could open a link or start a save, so the claim cannot rot into a comment. **Live**:
 * the count falls when a pair stops advertising, which is the whole difference between
 * this and `units.length` in the scan list.
 *
 * React is absent as everywhere else in this package: react-native does not import under
 * bun, so what the screen renders is checked on the handset and the arithmetic is checked
 * here. The wording functions exist so that half is testable too.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  FRESH_MS,
  type Nearby,
  type Sighting,
  bandLine,
  bandOf,
  createPresence,
  feed,
  friendLine,
  headline,
  rows,
  signalText,
} from './proximity.js'

/** A `Discovered`, so the mock hands over exactly what `ble.ts` does. */
const seen = (name: string, rssi: number, id = `id:${name}`) => ({ id, name, rssi })

/**
 * Everything a real `Scanner` has, including the one thing this module must never use.
 *
 * `connect` counts and throws rather than merely counting: a module that reached for it
 * would otherwise get a resolved promise and carry on looking correct.
 */
class MockScanner {
  connects = 0

  stops = 0

  tuning: { duplicates?: boolean } | undefined

  fail: Error | null = null

  private on: ((unit: ReturnType<typeof seen>) => void) | null = null

  async scan(
    onFound: (unit: ReturnType<typeof seen>) => void,
    tuning?: { duplicates?: boolean },
  ): Promise<void> {
    if (this.fail) throw this.fail
    this.tuning = tuning
    this.on = onFound
  }

  async stop(): Promise<void> {
    this.stops += 1
    this.on = null
  }

  async connect(_id: string): Promise<never> {
    this.connects += 1
    throw new Error('proximity opened a connection')
  }

  advertise(unit: ReturnType<typeof seen>): void {
    this.on?.(unit)
  }

  get scanning(): boolean {
    return this.on !== null
  }
}

/** A clock the test drives, since the count is a function of time as well as adverts. */
function fakeClock(start = 1_000_000) {
  let at = start
  return {
    now: () => at,
    set: (t: number) => {
      at = t
    },
    advance: (ms: number) => {
      at += ms
    },
    get at() {
      return at
    },
  }
}

test('a count of the pairs nearby comes off the adverts alone, with no connection', () => {
  const scanner = new MockScanner()
  const clock = fakeClock()
  const presence = createPresence()
  const stop = feed(scanner, presence, { now: clock.now })

  scanner.advertise(seen('GLASSES-125B37', -55))
  scanner.advertise(seen('GLASSES-12C3EF', -72))
  scanner.advertise(seen('JOGGLES-1A2B3C', -91))

  expect(presence.nearby(clock.at).count).toBe(3)
  expect(scanner.connects).toBe(0)

  stop()
  expect(scanner.stops).toBe(1)
  expect(scanner.scanning).toBe(false)
})

test('one pair under two platform handles counts once: the key is the advert name', () => {
  // A handle is per host and can be reissued between rounds. Counting it would report
  // two pairs where a festival has one, which is the wrong direction to be wrong in.
  const clock = fakeClock()
  const presence = createPresence()
  presence.saw(seen('GLASSES-125B37', -60, 'handle-a'), clock.at)
  presence.saw(seen('GLASSES-125B37', -60, 'handle-b'), clock.at)

  expect(presence.nearby(clock.at).count).toBe(1)
})

test('a pair that stops advertising leaves the count, at the window edge', () => {
  const presence = createPresence({ freshMs: 12_000 })
  presence.saw(seen('GLASSES-125B37', -55), 0)

  expect(presence.nearby(12_000).count).toBe(1)
  expect(presence.nearby(12_001).count).toBe(0)
})

test('the window survives one missed low-power report and not two', () => {
  // The window is only as defensible as this arithmetic. ble-plx leaves Android on
  // SCAN_MODE_LOW_POWER, which listens 512ms every 5.12s, so deliveries are 5.12s apart
  // and each consecutive miss adds another 5.12s to the gap.
  const CYCLE = 5_120
  const survives = (missed: number) => {
    const presence = createPresence()
    presence.saw(seen('GLASSES-125B37', -55), 0)
    return presence.nearby((missed + 1) * CYCLE).count === 1
  }

  expect(survives(0)).toBe(true)
  expect(survives(1)).toBe(true)
  expect(survives(2)).toBe(false)
  // Which is the honest reading of FRESH_MS, and pins it: one miss, not two.
  expect(FRESH_MS).toBeGreaterThan(2 * CYCLE)
  expect(FRESH_MS).toBeLessThan(3 * CYCLE)
})

test('a re-sighting keeps a pair in the count, which is why duplicates are asked for', () => {
  const presence = createPresence({ freshMs: 12_000 })
  presence.saw(seen('GLASSES-125B37', -55), 0)
  presence.saw(seen('GLASSES-125B37', -55), 10_000)

  expect(presence.nearby(20_000).count).toBe(1)
  expect(presence.nearby(22_001).count).toBe(0)
})

test('feed asks for duplicates by default, because iOS reports each peripheral once', () => {
  const scanner = new MockScanner()
  feed(scanner, createPresence())
  expect(scanner.tuning).toEqual({ duplicates: true })

  const quiet = new MockScanner()
  feed(quiet, createPresence(), { duplicates: false })
  expect(quiet.tuning).toEqual({ duplicates: false })
})

test('the advert is folded in before onSighting, so a summary taken there includes it', () => {
  const scanner = new MockScanner()
  const clock = fakeClock()
  const presence = createPresence()
  const counts: number[] = []
  feed(scanner, presence, {
    now: clock.now,
    onSighting: () => counts.push(presence.nearby(clock.at).count),
  })

  scanner.advertise(seen('GLASSES-125B37', -55))
  scanner.advertise(seen('GLASSES-12C3EF', -55))

  expect(counts).toEqual([1, 2])
})

test('every advert reaches onSighting unchanged, re-sightings included', () => {
  // *Corrected by track 66: this said the scan list keeps its own model of the rows and
  // needs the raw sighting to replace one in place. That list was the defect. What still
  // needs every advert is acting on an arrival - the Glasses screen opens the remembered
  // pair on first sight - and deduplicating here would hide the second pair's arrival
  // behind the first pair's re-sighting.*
  const scanner = new MockScanner()
  const got: Sighting[] = []
  feed(scanner, createPresence(), { onSighting: (unit) => got.push(unit) })

  scanner.advertise(seen('GLASSES-125B37', -55))
  scanner.advertise(seen('GLASSES-125B37', -70))

  expect(got).toEqual([seen('GLASSES-125B37', -55), seen('GLASSES-125B37', -70)])
})

test('an advert after teardown is ignored', () => {
  const scanner = new MockScanner()
  const clock = fakeClock()
  const presence = createPresence()
  const stop = feed(scanner, presence, { now: clock.now })
  scanner.advertise(seen('GLASSES-125B37', -55))
  stop()
  // The platform can deliver one more callback before stopDeviceScan takes effect.
  scanner.advertise(seen('GLASSES-12C3EF', -55))
  expect(presence.nearby(clock.at).count).toBe(1)
})

test('a scan that never starts reaches onError, and stopping still works', () => {
  const scanner = new MockScanner()
  scanner.fail = new Error('bluetooth permission refused')
  const errors: string[] = []
  const stop = feed(scanner, createPresence(), { onError: (e) => errors.push(e.message) })

  return Promise.resolve().then(() => {
    expect(errors).toEqual(['bluetooth permission refused'])
    stop()
    expect(scanner.stops).toBe(1)
  })
})

test('a non-Error rejection still arrives as an Error', () => {
  const scanner = new MockScanner()
  scanner.scan = () => Promise.reject('adapter off')
  const errors: Error[] = []
  feed(scanner, createPresence(), { onError: (e) => errors.push(e) })

  return Promise.resolve().then(() => {
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect(errors[0].message).toBe('adapter off')
  })
})

test('a missing signal is unknown, never the strongest thing in the room', () => {
  // ble.ts reads `device.rssi ?? 0` and Android reports 127 when it has none, so an
  // unfiltered reading puts a pair we cannot hear at all in your hand.
  for (const rssi of [0, 127, Number.NaN, -200, Number.POSITIVE_INFINITY]) {
    const presence = createPresence()
    presence.saw(seen('GLASSES-125B37', rssi), 0)
    const near = presence.nearby(0)
    expect(near.count, `rssi ${rssi} should still be counted`).toBe(1)
    expect(near.units[0].band, `rssi ${rssi} should not read as a signal`).toBe('unknown')
    expect(near.units[0].rssi).toBeNull()
  }
})

test('bands split on the documented edges', () => {
  expect(bandOf(-60)).toBe('reach')
  expect(bandOf(-61)).toBe('room')
  expect(bandOf(-80)).toBe('room')
  expect(bandOf(-81)).toBe('far')
  expect(bandOf(null)).toBe('unknown')

  const presence = createPresence({ smoothing: 1 })
  for (const [name, rssi] of [
    ['GLASSES-A', -40],
    ['GLASSES-B', -70],
    ['GLASSES-C', -75],
    ['GLASSES-D', -95],
    ['GLASSES-E', 0],
  ] as const) {
    presence.saw(seen(name, rssi), 0)
  }

  expect(presence.nearby(0).bands).toEqual({ reach: 1, room: 2, far: 1, unknown: 1 })
})

test('jitter does not flip the band, a trend does', () => {
  const presence = createPresence()
  presence.saw(seen('GLASSES-125B37', -52), 0)
  presence.saw(seen('GLASSES-125B37', -66), 100)

  // 14 dB is ordinary jitter from a device that has not moved, and taken raw it crosses
  // the edge on its own: the label would flicker while the pair sat on a table.
  expect(bandOf(-66)).toBe('room')
  expect(presence.nearby(100).units[0].rssi).toBe(-59)
  expect(presence.nearby(100).units[0].band).toBe('reach')

  presence.saw(seen('GLASSES-125B37', -66), 200)
  expect(presence.nearby(200).units[0].rssi).toBe(-62)
  expect(presence.nearby(200).units[0].band).toBe('room')
})

test('an unusable sample does not drag the smoothed reading towards zero', () => {
  const presence = createPresence()
  presence.saw(seen('GLASSES-125B37', -70), 0)
  presence.saw(seen('GLASSES-125B37', 0), 100)

  expect(presence.nearby(100).units[0].rssi).toBe(-70)
  expect(presence.nearby(100).units[0].band).toBe('room')
})

test('a pair reported with no usable reading loses its band, not just its number', () => {
  // The other half of the 127 defect, one sample later: an unusable advert refreshes
  // freshness, because we did hear it, so holding the last believable reading alongside
  // put a pair we can no longer hear back inside `within reach` indefinitely.
  const presence = createPresence({ freshMs: 12_000 })
  presence.saw(seen('GLASSES-125B37', -45), 0)
  expect(presence.nearby(0).units[0].band).toBe('reach')

  for (let t = 5_000; t <= 60_000; t += 5_000) presence.saw(seen('GLASSES-125B37', 127), t)

  const near = presence.nearby(60_000)
  expect(near.count, 'it is still being heard, so it is still nearby').toBe(1)
  expect(near.units[0].rssi).toBeNull()
  expect(near.units[0].band).toBe('unknown')
  expect(bandLine(near)).toBe('1 with no reading')
})

test('a reading outlives one unusable sample but not a window of them', () => {
  const presence = createPresence({ freshMs: 12_000 })
  presence.saw(seen('GLASSES-125B37', -70), 0)

  presence.saw(seen('GLASSES-125B37', 127), 11_000)
  expect(presence.nearby(11_000).units[0].rssi).toBe(-70)

  presence.saw(seen('GLASSES-125B37', 127), 13_000)
  expect(presence.nearby(13_000).units[0].rssi).toBeNull()
  // Freshness and the reading are separate clocks: it is still in the count.
  expect(presence.nearby(13_000).count).toBe(1)
})

test('the order is strongest first, unknown last, and stable between ticks', () => {
  // The scan rows are ordered by the list; this one is ordered by signal, and it has to
  // be deterministic for the same reason review-10 fixed the rows: a list that
  // reshuffles under a finger is unusable.
  const presence = createPresence({ smoothing: 1 })
  presence.saw(seen('GLASSES-QUIET', 0), 0)
  presence.saw(seen('GLASSES-MID', -70), 0)
  presence.saw(seen('GLASSES-NEAR', -45), 0)
  presence.saw(seen('GLASSES-TIED', -70), 0)

  const names = (n: Nearby) => n.units.map((u) => u.name)
  expect(names(presence.nearby(0))).toEqual([
    'GLASSES-NEAR',
    'GLASSES-MID',
    'GLASSES-TIED',
    'GLASSES-QUIET',
  ])
  expect(names(presence.nearby(1_000))).toEqual(names(presence.nearby(0)))
})

test('an advert named __proto__ is counted like any other and poisons nothing', () => {
  // review-10 found this one layer up, in a plain-object nickname map. A Map cannot be
  // read through to Object.prototype and cannot have its prototype written.
  const presence = createPresence()
  presence.saw({ name: '__proto__', rssi: -55 }, 0)
  presence.saw({ name: 'toString', rssi: -55 }, 0)

  expect(presence.nearby(0).count).toBe(2)
  expect(({} as Record<string, unknown>).rssi).toBeUndefined()
})

test('an advert with no name is ignored rather than counted as a pair', () => {
  const presence = createPresence()
  presence.saw({ name: '', rssi: -55 }, 0)
  expect(presence.nearby(0).count).toBe(0)
  expect(presence.tracked()).toBe(0)
})

test('the map is bounded by what is nearby, not by everything ever heard', () => {
  const presence = createPresence({ freshMs: 12_000 })
  for (let i = 0; i < 200; i++) {
    presence.saw(seen(`GLASSES-${i}`, -60), i * 1_000)
  }

  // A whole night in a dense field must not accumulate: only the last window survives.
  // 200 distinct names went in one second apart, so pruning holds ~12 plus the newest.
  expect(presence.tracked()).toBeLessThanOrEqual(13)
  // Pruning is the mutator's job, so silence leaves those last entries in the map; the
  // count is filtered on the way out, which is what makes `nearby` safe to ask twice.
  expect(presence.nearby(400_000).count).toBe(0)
  expect(presence.tracked()).toBeLessThanOrEqual(13)
})

test('a clock that steps backwards keeps the field rather than emptying it', () => {
  const presence = createPresence({ freshMs: 12_000 })
  presence.saw(seen('GLASSES-125B37', -55), 1_000_000)

  const near = presence.nearby(1_000_000 - 3_600_000)
  expect(near.count).toBe(1)
  expect(near.units[0].age).toBe(0)
})

test('age is what the summary was asked for, not when the advert arrived', () => {
  const presence = createPresence({ freshMs: 12_000 })
  presence.saw(seen('GLASSES-125B37', -55), 5_000)
  expect(presence.nearby(9_000).units[0].age).toBe(4_000)
})

test('the headline counts pairs, and says so in the past tense once the scan ends', () => {
  const near = (count: number): Nearby => ({
    count,
    units: [],
    bands: { reach: 0, room: 0, far: 0, unknown: 0 },
  })

  expect(headline(near(0))).toBe('Listening for pairs nearby')
  expect(headline(near(1))).toBe('1 pair advertising')
  expect(headline(near(4))).toBe('4 pairs advertising')
  // Not "No pairs heard": a pair switched off mid-round keeps its row, so a headline
  // saying nothing was ever heard sits above a row proving otherwise.
  expect(headline(near(0), false)).toBe('Nothing advertising when the scan ended')
  expect(headline(near(1), false)).toBe('1 pair when the scan ended')
  expect(headline(near(4), false)).toBe('4 pairs when the scan ended')
})

test('the band line skips empty bands and reads strongest first', () => {
  const line = (bands: Nearby['bands']) => bandLine({ count: 0, units: [], bands })

  expect(line({ reach: 1, room: 2, far: 0, unknown: 1 })).toBe(
    '1 within reach · 2 in the room · 1 with no reading',
  )
  expect(line({ reach: 0, room: 0, far: 3, unknown: 0 })).toBe('3 further off')
  expect(line({ reach: 0, room: 0, far: 0, unknown: 0 })).toBe('')
})

test('friends are named, and the sentence agrees with how many', () => {
  expect(friendLine([])).toBe('')
  expect(friendLine(['Larry'])).toBe('Larry is one of them')
  expect(friendLine(['Larry', 'Betty'])).toBe('Larry and Betty are among them')
  expect(friendLine(['Larry', 'Betty', 'Cec'])).toBe('Larry, Betty and Cec are among them')
  expect(friendLine(['Larry', 'Betty', 'Cec', 'Dot', 'Eve'])).toBe(
    'Larry, Betty, Cec and 2 more are among them',
  )
  // Two pairs can carry one nickname, and the caller maps units to names without
  // deduplicating: "Larry and Larry are among them" is a bug the user can read.
  expect(friendLine(['Larry', 'Larry'])).toBe('Larry is one of them')
  expect(friendLine(['Larry', 'Betty', 'Larry', 'Cec', 'Dot'])).toBe(
    'Larry, Betty, Cec and 1 more are among them',
  )
  expect(friendLine([''])).toBe('')
})

test('a signal with no reading says so instead of printing 0 dBm', () => {
  expect(signalText(-63)).toBe('-63 dBm')
  expect(signalText(-63.4)).toBe('-63 dBm')
  expect(signalText(0)).toBe('no reading')
  expect(signalText(127)).toBe('no reading')
})

/**
 * Advert-only, asserted on the source.
 *
 * The type `feed` takes has no `connect`, so nothing in this module *can* open a link
 * today. This is what keeps that true after the next edit, and it is the same shape as
 * `nicknames.test.ts`'s ledger crawl and core's `safe-surface.test.ts`: read the file,
 * not the intention.
 */
const SOURCE = readFileSync(
  resolve(dirname(new URL(import.meta.url).pathname), 'proximity.ts'),
  'utf8',
)

/**
 * Comments explain what the code must not do, so they cannot be part of the evidence.
 *
 * Block comments and whole-line `//` comments only. A **trailing** comment on a line of
 * code survives and will fail the crawl below, which is deliberate: stripping from `//`
 * to end of line anywhere would also eat anything after a `//` inside a string literal,
 * and a strip that can hide code is worse than one that occasionally over-reports. If
 * this test fails on a comment, move the comment to its own line rather than weakening
 * the strip.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('nothing in proximity.ts can connect, upload, or write flash', () => {
  const forbidden: [RegExp, string][] = [
    [/connect/i, 'opening a link is what advert-only rules out'],
    [/\bGlasses\b|attach/, 'a session is the only thing that can command a device'],
    [/DATS|DATCP|save\(/i, 'a save is five page erases of the one working pair'],
    [/write/i, 'this module produces a number and touches nothing'],
    [/ledger|budget/i, 'the wear count is not this feature'],
  ]
  for (const [pattern, why] of forbidden) {
    expect(CODE, `proximity.ts names ${pattern}: ${why}`).not.toMatch(pattern)
  }
  // Guards the crawl: an assertion over an empty string proves nothing.
  expect(CODE).toContain('export function feed')
})

test('proximity.ts imports nothing at all, so there is nothing to reach through', () => {
  expect(CODE).not.toMatch(/^\s*import\b/m)
  // `const ble = await import('./ble.js')` is not a static import and the anchored
  // pattern above never sees it. Probed against the unfixed test: a dynamic import that
  // then called `scanner.scan()` escaped the whole crawl, because reaching a scanner
  // through the module graph names none of the forbidden identifiers.
  expect(CODE).not.toMatch(/\bimport\s*\(/)
  expect(CODE).not.toMatch(/\brequire\(/)
  // What no source crawl can catch is a computed name: `s["con" + "nect"](id)` escapes
  // this and `nicknames.test.ts`'s ledger crawl and core's `safe-surface.test.ts` alike.
  // The type `feed` takes is what actually makes a connection unreachable; this only
  // stops the type being widened quietly.
  expect(CODE).toContain('AdvertSource')
})

/**
 * The rows are the count, asserted as arithmetic rather than as agreement.
 *
 * Track 66. The Glasses screen kept its own array of sightings beside this map, so the
 * header counted one thing and the list showed another, and switching the app to the
 * simulated pairs left a real pair on screen at a frozen reading under a caption reading
 * "simulated pairs only". `rows()` is a re-ordering of `nearby().units` and never a
 * filter, which is the property these tests pin.
 */
test('the rows are exactly the counted pairs, whatever has been heard', () => {
  const presence = createPresence({ freshMs: 12_000 })
  presence.saw(seen('GLASSES-125B37', -55), 0)
  presence.saw(seen('GLASSES-12C3EF', -72), 1_000)
  presence.saw(seen('JOGGLES-1A2B3C', -91), 2_000)

  const near = presence.nearby(3_000)
  expect(rows(near)).toHaveLength(near.count)
  expect([...rows(near)].map((u) => u.name).sort()).toEqual(
    [...near.units].map((u) => u.name).sort(),
  )

  // And past the window, where the old list would still have had three rows.
  const gone = presence.nearby(20_000)
  expect(gone.count).toBe(0)
  expect(rows(gone)).toHaveLength(0)
})

test('a pair that stops advertising loses its row at the same edge it loses the count', () => {
  // The visible half of the freshness window. Before track 66 the row outlived the round
  // that found it, which is what made a stale reading look like a current one.
  const presence = createPresence({ freshMs: 12_000 })
  presence.saw(seen('GLASSES-125B37', -55), 0)
  presence.saw(seen('GLASSES-12C3EF', -60), 0)
  presence.saw(seen('GLASSES-12C3EF', -60), 10_000)

  const near = presence.nearby(12_001)
  expect(near.count).toBe(1)
  expect(rows(near).map((u) => u.name)).toEqual(['GLASSES-12C3EF'])
})

test('rows hold still while signals cross over, because they are ordered by arrival', () => {
  // review-10's defect, which is what a signal-ordered list of tappable rows would be:
  // a real reading jitters ~10 dB between adverts from a pair that has not moved, so the
  // top two rows would swap about once a second and a tap would land on the wrong pair.
  const presence = createPresence({ smoothing: 1 })
  presence.saw(seen('GLASSES-FIRST', -70), 0)
  presence.saw(seen('GLASSES-SECOND', -45), 1_000)

  const order = (at: number) => rows(presence.nearby(at)).map((u) => u.name)
  expect(order(1_000)).toEqual(['GLASSES-FIRST', 'GLASSES-SECOND'])
  // The second pair is the stronger one, so `nearby()` ranks it first. The rows do not.
  expect(presence.nearby(1_000).units[0].name).toBe('GLASSES-SECOND')

  // Now invert the readings. The ranking flips; the rows must not.
  presence.saw(seen('GLASSES-FIRST', -40), 2_000)
  presence.saw(seen('GLASSES-SECOND', -85), 2_000)
  expect(presence.nearby(2_000).units[0].name).toBe('GLASSES-FIRST')
  expect(order(2_000)).toEqual(['GLASSES-FIRST', 'GLASSES-SECOND'])
})

test('a pair that left and came back is a new arrival, and goes to the end', () => {
  const presence = createPresence({ freshMs: 12_000 })
  presence.saw(seen('GLASSES-EARLY', -55), 0)
  presence.saw(seen('GLASSES-LATER', -55), 1_000)
  // EARLY falls out of the window, then returns.
  presence.saw(seen('GLASSES-LATER', -55), 14_000)
  presence.saw(seen('GLASSES-EARLY', -55), 15_000)

  expect(rows(presence.nearby(15_000)).map((u) => u.name)).toEqual([
    'GLASSES-LATER',
    'GLASSES-EARLY',
  ])
})

test('the handle rides along so a row can be opened, latest sighting winning', () => {
  const presence = createPresence()
  presence.saw(seen('GLASSES-125B37', -60, 'handle-a'), 0)
  presence.saw(seen('GLASSES-125B37', -60, 'handle-b'), 1_000)

  // One pair, one row, one count, and the freshest handle: a handle is per host and can
  // be reissued between rounds, so the stale one is the one that would fail to open.
  const near = presence.nearby(1_000)
  expect(near.count).toBe(1)
  expect(rows(near)).toHaveLength(1)
  expect(rows(near)[0].id).toBe('handle-b')
})

test('an advert with no handle still counts, and its row says it has none', () => {
  // `Sighting.id` is optional because the count never needed it. A row without one is
  // not openable, which the screen shows by disabling the row rather than by dropping
  // it - dropping it is what would let the rows and the count disagree again.
  const presence = createPresence()
  presence.saw({ name: 'GLASSES-125B37', rssi: -60 }, 0)
  const near = presence.nearby(0)
  expect(near.count).toBe(1)
  expect(rows(near)[0].id).toBeNull()
})

test('a handle already known is kept when a later advert carries none', () => {
  const presence = createPresence()
  presence.saw(seen('GLASSES-125B37', -60, 'handle-a'), 0)
  presence.saw({ name: 'GLASSES-125B37', rssi: -60 }, 1_000)
  expect(rows(presence.nearby(1_000))[0].id).toBe('handle-a')
})

test('a row with no believable reading prints no dBm rather than a zero', () => {
  // `signalText` takes the null a row carries as well as a raw sample, so a caller
  // cannot forget to branch and print `0 dBm` for a pair it cannot hear.
  expect(signalText(null)).toBe('no reading')
})
