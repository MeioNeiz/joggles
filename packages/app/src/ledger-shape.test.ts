/**
 * The ledger file as an untrusted input, which is what review-10 found it was not.
 *
 * Every case here is something a real phone produces: a write cut off by the process
 * dying, a file written by an older shape, a clock that stepped. The property under
 * test is never "it parses" - it is **that a damaged file can only make the flash guard
 * stricter**, because the failure that costs hardware is an allowance handed back to a
 * loop.
 */
import { budget, dats } from '@joggles/core'
import { describe, expect, test } from 'bun:test'
import { reviveAll, reviveLedger, saveLog, wearWords } from './ledger-shape.js'

const NOW = 1_700_000_000_000
const rec = (at: number, hash = 'aa', ok = true) => ({ at, hash, columns: 24, ok })

test('a ledger written by this app survives unchanged', () => {
  const before: budget.DeviceLedger = {
    device: 'GLASSES-125B37',
    lifetime: 12,
    first: NOW - 5000,
    last: NOW - 1000,
    window: [NOW - 5000, NOW - 1000],
    recent: [rec(NOW - 5000, 'aa'), rec(NOW - 1000, 'bb')],
  }
  expect(reviveLedger(before, before.device, NOW)).toEqual(before)
})

test('garbage in the whole file degrades to empty rather than throwing', () => {
  for (const raw of [null, undefined, 7, 'text', [], [1, 2]]) {
    expect(reviveAll(raw, NOW)).toEqual({})
  }
})

test('a window that is not an array cannot throw from inside the budget guard', () => {
  // The concrete defect: `counts()` calls `ledger.window.filter`, so this shape used to
  // reach `FlashBudget.allow()` and take the save down with a TypeError.
  const revived = reviveLedger({ lifetime: 3, window: 'nope', recent: null }, 'G', NOW)
  expect(revived.window).toEqual([])
  expect(revived.recent).toEqual([])
  expect(() => budget.counts(revived, NOW)).not.toThrow()
})

test('the guard runs against a revived ledger from a half-written file', async () => {
  const damaged = reviveLedger({ lifetime: '4', last: {}, window: [NOW - 1] }, 'G', NOW)
  const store = budget.memoryStore()
  await store.save(damaged)
  const guard = new budget.FlashBudget(store, () => NOW)

  // One second since the recovered `last`, so the interval rule bites rather than
  // crashing: the damaged file still refuses a save that a lost file would allow.
  await expect(guard.allow('G', 'hash')).rejects.toThrow(budget.BudgetError)
})

test('an unreadable lifetime falls back to the record count, never to zero', () => {
  const revived = reviveLedger(
    { lifetime: 'lots', recent: [rec(NOW - 3), rec(NOW - 2), rec(NOW - 1)] },
    'G',
    NOW,
  )
  expect(revived.lifetime).toBe(3)
})

test('a stored lifetime lower than the records it holds is raised, not trusted', () => {
  const revived = reviveLedger({ lifetime: 1, recent: [rec(NOW - 2), rec(NOW - 1)] }, 'G', NOW)
  expect(revived.lifetime).toBe(2)
})

test('a damaged window cannot permit a save a clean one refuses', async () => {
  // review-12's probe, and the defect it found: the hour and day rules read only
  // `window`, so a torn one used to drop both while `recent` sat behind it holding the
  // evidence. 35 saves in the last half hour is past the limit of 30.
  const ats = Array.from({ length: 35 }, (_, i) => NOW - (i + 1) * 30_000).reverse()
  const entry = {
    lifetime: 35,
    first: ats[0],
    last: ats[ats.length - 1],
    window: ats,
    recent: ats.map((at, i) => rec(at, `h${i}`)),
  }
  const allows = async (raw: unknown): Promise<string> => {
    const store = budget.memoryStore()
    await store.save(reviveLedger(raw, 'G', NOW))
    const guard = new budget.FlashBudget(store, () => NOW + 10_000)
    try {
      return `allowed ${await guard.allow('G', 'fresh')}`
    } catch (e) {
      return `threw ${(e as budget.BudgetError).rule}`
    }
  }

  expect(await allows(entry)).toBe('threw hour')
  for (const damage of ['nope', null, undefined, [], [{}, 'x']]) {
    expect(await allows({ ...entry, window: damage })).toBe('threw hour')
  }
})

test('a day of saves does not read as fifty when the lifetime is unreadable', () => {
  // `window` reaches back a rolling day, `recent` keeps only 50, so the records alone
  // are not the best floor available: 60 saves used to come back as 50.
  const ats = Array.from({ length: 60 }, (_, i) => NOW - (60 - i) * 60_000)
  const revived = reviveLedger(
    { lifetime: 'lost', window: ats, recent: ats.slice(-50).map((at, i) => rec(at, `h${i}`)) },
    'G',
    NOW,
  )
  expect(revived.lifetime).toBe(60)
  // Deduped by value: `count()` writes the same instant to both, so a save recorded in
  // each place is one save and must not be counted twice.
  expect(revived.window).toHaveLength(60)
})

test('a record older than the rolling day is not rebuilt into the window', () => {
  // The other side of repairing upwards: recovering the window from the records must
  // not invent saves inside a day that has already rolled past them.
  const old = NOW - 5 * budget.DAY_MS
  const revived = reviveLedger({ lifetime: 3, window: [], recent: [rec(old, 'aa')] }, 'G', NOW)
  expect(revived.window).toEqual([])
  expect(budget.counts(revived, NOW).day).toBe(0)
  // Still evidence of a save, so the lifetime floor keeps it.
  expect(revived.lifetime).toBe(3)
})

test('a lost last is recovered from the newest timestamp in the entry', () => {
  const revived = reviveLedger(
    { lifetime: 9, first: null, last: null, window: [NOW - 900], recent: [rec(NOW - 400)] },
    'G',
    NOW,
  )
  expect(revived.last).toBe(NOW - 400)
  expect(revived.first).toBe(NOW - 900)
})

test('a timestamp in the future is dropped, or the guard could never be recovered from', () => {
  // A corrupt `last` ahead of now makes every `since` negative, so the interval rule
  // would refuse every save for the life of the file with nothing a user could do.
  const revived = reviveLedger({ lifetime: 2, last: NOW + 86_400_000 }, 'G', NOW)
  expect(revived.last).toBeNull()
  expect(revived.window).toEqual([])
})

test('a clock that stepped back by seconds is tolerated rather than treated as damage', () => {
  const revived = reviveLedger({ lifetime: 1, last: NOW + 5_000 }, 'G', NOW)
  expect(revived.last).toBe(NOW + 5_000)
})

test('a record missing its hash is dropped, and one missing ok reads as not acknowledged', () => {
  const revived = reviveLedger(
    { recent: [{ at: NOW - 2, columns: 24 }, { at: NOW - 1, hash: 'bb', columns: 24 }] },
    'G',
    NOW,
  )
  expect(revived.recent).toEqual([{ at: NOW - 1, hash: 'bb', columns: 24, ok: false }])
})

test('an unacknowledged record cannot be mistaken for content the device holds', async () => {
  // `allow()` reads back the last `ok` record to answer "already on the glasses". A
  // record whose `ok` was lost must not skip a save the user asked for.
  const revived = reviveLedger({ recent: [{ at: NOW - 9000, hash: 'aa', columns: 24 }] }, 'G', NOW)
  const store = budget.memoryStore()
  await store.save(revived)
  const guard = new budget.FlashBudget(store, () => NOW)

  expect(await guard.allow('G', 'aa')).toBe(true)
})

test('records are capped at fifty and sorted oldest first, whatever the file said', () => {
  const many = Array.from({ length: 70 }, (_, i) => rec(NOW - i, `h${i}`))
  const revived = reviveLedger({ recent: many }, 'G', NOW)
  expect(revived.recent).toHaveLength(50)
  // Newest kept: the file's newest is `NOW - 0`, and the oldest survivor is NOW - 49.
  expect(revived.recent[0].at).toBe(NOW - 49)
  expect(revived.recent[49].at).toBe(NOW)
})

test('one damaged device does not take the readable ones with it', () => {
  const all = reviveAll(
    {
      'GLASSES-AAA': { lifetime: 4, window: [NOW - 10], recent: [rec(NOW - 10)] },
      'GLASSES-BBB': 'not an object',
      '': { lifetime: 99 },
    },
    NOW,
  )
  expect(Object.keys(all)).toEqual(['GLASSES-AAA'])
  expect(all['GLASSES-AAA'].lifetime).toBe(4)
})

test('an entry filed under the wrong key is re-keyed, not dropped', () => {
  // Dropping it would forgive a wear count, which is the one direction that costs
  // hardware. The key is what `load(device)` will ask for, so the key wins.
  const all = reviveAll({ 'GLASSES-AAA': { device: 'GLASSES-ZZZ', lifetime: 6 } }, NOW)
  expect(all['GLASSES-AAA'].device).toBe('GLASSES-AAA')
  expect(all['GLASSES-AAA'].lifetime).toBe(6)
})

test('a __proto__ device key is stored as a key, not assigned into the prototype', () => {
  // JSON.parse makes `__proto__` an ordinary own property, unlike an object literal, so
  // this is the shape a file actually arrives in. Assigning it into a plain `{}` would
  // set the map's prototype and `Object.keys` would come back empty.
  const all = reviveAll(JSON.parse('{"__proto__":{"lifetime":5},"real":{"lifetime":1}}'), NOW)

  expect(Object.keys(all).sort()).toEqual(['__proto__', 'real'])
  expect(all['__proto__'].lifetime).toBe(5)
})

test('a device named after a method reads as absent rather than as a function', () => {
  // `fileStore().load` answers `load()[device] ?? null`, so on a plain object a unit
  // advertising as `toString` would hand `FlashBudget` a function to add 1 to.
  const all = reviveAll(JSON.parse('{"GLASSES-AAA":{"lifetime":2}}'), NOW)
  expect(all['toString']).toBeUndefined()
})

test('the save log is newest first and marks a repeated hash', () => {
  const ledger = reviveLedger(
    {
      lifetime: 4,
      recent: [rec(NOW - 40, 'aa'), rec(NOW - 30, 'bb'), rec(NOW - 20, 'bb'), rec(NOW - 10, 'cc')],
    },
    'G',
    NOW,
  )
  const rows = saveLog(ledger)

  expect(rows.map((r) => r.at)).toEqual([NOW - 10, NOW - 20, NOW - 30, NOW - 40])
  // The later of the duplicate pair is the one flagged, whichever way the list reads.
  expect(rows.map((r) => r.repeat)).toEqual([false, true, false, false])
})

test('the log of a device never saved to is empty rather than absent', () => {
  expect(saveLog(budget.emptyLedger('G'))).toEqual([])
})

describe('wearWords', () => {
  const base = { device: 'GLASSES-TEST', first: null, last: null, window: [], recent: [] }

  test('owns the count instead of claiming a total', () => {
    const words = wearWords({ ...base, lifetime: 11 })
    expect(words).toMatch(/11 saves from this phone/)
    expect(words).not.toMatch(/ever/i)
    // No lifetime claim either: endurance is unverified and there is no feedback.
    expect(words).not.toMatch(/%|remain/i)
  })

  test('handles one and none without lying about either', () => {
    expect(wearWords({ ...base, lifetime: 1 })).toMatch(/1 save from this phone/)
    expect(wearWords({ ...base, lifetime: 0 })).toBe('No saves from this phone yet.')
  })
})

test('a reloaded record keeps its DATS type, and only 1 or 2 survive', () => {
  const now = 5_000_000
  const rec = (over: Record<string, unknown>) => ({
    at: now - 1000,
    hash: 'h',
    columns: 24,
    ok: true,
    ...over,
  })
  const out = reviveLedger(
    {
      device: 'GLASSES-TEST',
      lifetime: 4,
      first: now - 9000,
      last: now - 1000,
      window: [],
      recent: [rec({ type: 1 }), rec({ type: 2 }), rec({ type: 9 }), rec({}), rec({ type: 'x' })],
    },
    'GLASSES-TEST',
    now,
  )
  expect(out?.recent.map((r) => r.type)).toEqual([1, 2, undefined, undefined, undefined])
})

test('residency survives a restart, which is the whole point of storing the type', () => {
  // The defect this replaces: `cleanRecord` dropped `type`, so a ledger read back off
  // the phone came home typeless and `storedHash` answered "unknown" after every app
  // restart. Never wrong, but it cost one redundant five-erase save each time.
  const now = 5_000_000
  const ledger = reviveLedger(
    {
      device: 'GLASSES-TEST',
      lifetime: 1,
      first: now - 2000,
      last: now - 2000,
      window: [],
      recent: [{ at: now - 2000, hash: 'the-loop', columns: 240, ok: true, type: 1 }],
    },
    'GLASSES-TEST',
    now,
  )
  expect(ledger).not.toBeNull()
  expect(budget.storedHash(ledger as budget.DeviceLedger, dats.TYPE_TEXT)).toBe('the-loop')
})
