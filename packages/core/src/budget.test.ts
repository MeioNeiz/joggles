/**
 * The flash-wear guard.
 *
 * Every case here is a shape a real bug takes: a duplicate save from a re-render,
 * two effects firing at once under StrictMode, a retry loop with no ceiling. The
 * numbers are far above any human pattern, so a test that fails here is a loop.
 */
import { expect, test } from 'bun:test'
import {
  BudgetError,
  FLASH_TYPE,
  FlashBudget,
  LIMITS,
  counts,
  emptyLedger,
  fingerprint,
  holds,
  memoryStore,
  storedHash,
} from './budget.js'

const DEVICE = 'GLASSES-12C3EF'
const A = 'hash-a'
const B = 'hash-b'

/** A budget whose clock the test drives, in ms. */
function budgetAt(start = 0) {
  let now = start
  const store = memoryStore()
  return {
    budget: new FlashBudget(store, () => now),
    advance: (ms: number) => {
      now += ms
    },
    at: () => now,
  }
}

const saved = async (b: FlashBudget, hash: string, ok = true) =>
  b.count(DEVICE, { hash, columns: 24, ok })

test('a fingerprint changes with the bytes and with the type', () => {
  const bytes = new Uint8Array([1, 2, 3])
  expect(fingerprint(bytes, 1)).toBe(fingerprint(new Uint8Array([1, 2, 3]), 1))
  expect(fingerprint(bytes, 1)).not.toBe(fingerprint(bytes, 2))
  expect(fingerprint(bytes, 1)).not.toBe(fingerprint(new Uint8Array([1, 2, 4]), 1))
})

test('what the device already holds is skipped, not thrown', async () => {
  const { budget, advance } = budgetAt()
  expect(await budget.allow(DEVICE, A)).toBe(true)
  await saved(budget, A)
  advance(60_000)
  // Skipped even though the interval is satisfied: it writes flash for nothing.
  expect(await budget.allow(DEVICE, A)).toBe(false)
  expect(await budget.allow(DEVICE, B)).toBe(true)
})

test('a save the device rejected is not "already on the glasses"', async () => {
  const { budget, advance } = budgetAt()
  await saved(budget, A, false)
  advance(60_000)
  // The content is not there, so retrying it is legitimate and must not be skipped.
  expect(await budget.allow(DEVICE, A)).toBe(true)
})

// --- which store, and what it is holding ---

/**
 * The device has two stores and a record now says which one it hit.
 *
 * Both directions of this were wrong before, and both cost something real. A type 2
 * save from the drawing screen made a resident scroller look like new content, so the
 * next tap on it spent five page erases putting back what was already there; and a
 * failed commit was walked straight past to an older matching record, so a retry of
 * the content that commit destroyed was skipped as a duplicate and never went out.
 */
const savedAs = async (b: FlashBudget, hash: string, type: number, ok = true) =>
  b.count(DEVICE, { hash, columns: 24, ok, type })

test('a type 2 save leaves the flash store exactly where it was', async () => {
  const { budget, advance } = budgetAt()
  await savedAs(budget, A, 1)
  advance(60_000)
  await savedAs(budget, B, 2)
  advance(60_000)

  expect(storedHash(await budget.ledger(DEVICE), 1)).toBe(A)
  expect(await budget.allow(DEVICE, A, { type: 1 })).toBe(false)
  // And the other way round: a type 2 image does not survive a later save of any
  // type, so the RAM store stops being knowable the moment the reel goes over it.
  expect(storedHash(await budget.ledger(DEVICE), 2)).toBe(B)
  await savedAs(budget, A, 1)
  advance(60_000)
  expect(storedHash(await budget.ledger(DEVICE), 2)).toBeNull()
  expect(await budget.allow(DEVICE, B, { type: 2 })).toBe(true)
})

test('a failed commit is where the walk stops, in both stores', async () => {
  const { budget, advance } = budgetAt()
  await savedAs(budget, A, 1)
  advance(60_000)
  await savedAs(budget, B, 1, false)
  advance(60_000)

  // The erases were spent, so whatever is in the flash store now, it is not A.
  expect(storedHash(await budget.ledger(DEVICE), 1)).toBeNull()
  expect(await budget.allow(DEVICE, A, { type: 1 })).toBe(true)
})

test('a record with no type is unknown to name, and still sound to compare', async () => {
  const { budget, advance } = budgetAt()
  // What every ledger on disk looked like before 2026-08-12.
  await saved(budget, A)
  advance(60_000)

  // Nobody can say which store it hit, so nothing may claim it as residency.
  expect(storedHash(await budget.ledger(DEVICE), 1)).toBeNull()
  expect(storedHash(await budget.ledger(DEVICE), 2)).toBeNull()
  // But the duplicate check still holds, and that is not a contradiction: the hash
  // carries the type (`fingerprint` mixes it in), so a record matching this payload
  // could only have been a save of this type. Old ledgers keep their protection.
  expect(holds(await budget.ledger(DEVICE), 1, A)).toBe(true)
  expect(await budget.allow(DEVICE, A, { type: 1 })).toBe(false)

  // Under a typed one it is still the last word, because it may itself have been a
  // type 1 save and there is no longer any way to ask.
  await savedAs(budget, B, 1)
  advance(60_000)
  await saved(budget, 'hash-c')
  advance(60_000)
  expect(storedHash(await budget.ledger(DEVICE), 1)).toBeNull()
  expect(await budget.allow(DEVICE, B, { type: 1 })).toBe(true)
})

test('a caller that does not name a store is asking about the flash one', async () => {
  const { budget, advance } = budgetAt()
  await savedAs(budget, A, 2)
  advance(60_000)
  // Type 1 by default, which is what every caller written before the field meant and
  // what `session.save()` defaults to. A type 2 record cannot answer for it.
  expect(await budget.allow(DEVICE, A)).toBe(true)
  expect(FLASH_TYPE).toBe(1)
})

test('two saves inside the interval: the second throws and nothing queues', async () => {
  const { budget, advance } = budgetAt()
  await budget.allow(DEVICE, A)
  await saved(budget, A)

  advance(LIMITS.intervalMs - 1)
  const err = await budget.allow(DEVICE, B).catch((e) => e)
  expect(err).toBeInstanceOf(BudgetError)
  expect((err as BudgetError).rule).toBe('interval')

  advance(1)
  expect(await budget.allow(DEVICE, B)).toBe(true)
})

test('two saves at once, neither recorded yet, still trips the interval', async () => {
  // The StrictMode case: an effect double-invokes, both calls check before either
  // records. Reading only the ledger would let both through.
  const { budget } = budgetAt()
  const [first, second] = await Promise.allSettled([
    budget.allow(DEVICE, A),
    budget.allow(DEVICE, B),
  ])
  expect(first.status).toBe('fulfilled')
  expect(second.status).toBe('rejected')
})

test('the interval is per device: a second unit is not blocked by the first', async () => {
  const { budget } = budgetAt()
  await budget.allow(DEVICE, A)
  expect(await budget.allow('GLASSES-OTHER', A)).toBe(true)
})

test('past 30 in an hour, each save needs an explicit confirmation', async () => {
  const { budget, advance } = budgetAt()
  for (let i = 0; i < LIMITS.perHour; i++) {
    advance(LIMITS.intervalMs)
    await saved(budget, `h${i}`)
  }
  advance(LIMITS.intervalMs)

  const err = await budget.allow(DEVICE, A).catch((e) => e)
  expect((err as BudgetError).rule).toBe('hour')
  expect(await budget.allow(DEVICE, A, { confirm: true })).toBe(true)

  // The window rolls: an hour later the count is back to zero.
  advance(LIMITS.intervalMs + 3_600_000)
  expect(await budget.allow(DEVICE, A)).toBe(true)
})

test('past 200 in a day, a confirmation is not enough', async () => {
  const { budget, advance } = budgetAt()
  for (let i = 0; i < LIMITS.perDay; i++) {
    advance(LIMITS.intervalMs)
    await saved(budget, `d${i}`)
  }
  advance(LIMITS.intervalMs)

  const err = await budget.allow(DEVICE, A, { confirm: true }).catch((e) => e)
  expect((err as BudgetError).rule).toBe('day')
  expect(await budget.allow(DEVICE, A, { confirm: true, override: true })).toBe(true)
})

test('the ledger counts lifetime saves, and keeps the last 50 for diagnosis', async () => {
  const { budget, advance } = budgetAt(1000)
  for (let i = 0; i < 60; i++) {
    advance(LIMITS.intervalMs)
    await saved(budget, `n${i}`)
  }
  const ledger = await budget.ledger(DEVICE)

  expect(ledger.lifetime).toBe(60)
  expect(ledger.first).toBe(1000 + LIMITS.intervalMs)
  expect(ledger.last).toBe(1000 + 60 * LIMITS.intervalMs)
  expect(ledger.recent).toHaveLength(LIMITS.recent)
  expect(ledger.recent.at(-1)!.hash).toBe('n59')
  expect(ledger.recent[0].hash).toBe('n10')
})

test('the rolling windows forget, the lifetime count does not', async () => {
  const { budget, advance } = budgetAt()
  await saved(budget, A)
  advance(2 * 3_600_000)
  await saved(budget, B)

  const ledger = await budget.ledger(DEVICE)
  expect(counts(ledger, ledger.last!)).toEqual({ hour: 1, day: 2 })
  advance(25 * 3_600_000)
  expect(counts(ledger, ledger.last! + 25 * 3_600_000)).toEqual({ hour: 0, day: 0 })
  expect(ledger.lifetime).toBe(2)
})

test('a persisted ledger is what the limits are read from', async () => {
  // Rate limits that reset on every invocation would not have caught the bench loop
  // that prompted them, so the store is where the count has to live.
  const store = memoryStore()
  await store.save({ ...emptyLedger(DEVICE), lifetime: 9, last: 1000, window: [1000] })

  const budget = new FlashBudget(store, () => 2000)
  const err = await budget.allow(DEVICE, A).catch((e) => e)
  expect((err as BudgetError).rule).toBe('interval')
  expect((await budget.ledger(DEVICE)).lifetime).toBe(9)
})
