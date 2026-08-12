/**
 * The reel's whole claim is that switching between a chosen set costs no flash after
 * the first save, so that is what these assert: the DATS count across a full cycle,
 * and that a reel already on the pair is free to resume.
 *
 * Driven against `MockTransport` through the real `Glasses`, so the budget guard, the
 * choke point and the wire sequence are all in the loop rather than mocked out.
 */
import { Glasses, budget as bg, content, playlist as pl } from '@joggles/core'
import { MockTransport, datsDevice } from '@joggles/core/src/mock-transport.js'
import { expect, test } from 'bun:test'
import type { SavedItem } from './library.js'
import { PanelSession } from './panel-session.js'
import { cyclerFor, entriesFor, planReel, reelResident } from './reel.js'
import { residentItem } from './one-tap.js'

const DEVICE = 'GLASSES-TEST'

const memoryLedger = () => {
  let held: budgetLedger | null = null
  return {
    store: {
      load: async () => held,
      save: async (l: budgetLedger) => {
        held = l
      },
    },
    read: () => held,
  }
}
type budgetLedger = bg.DeviceLedger

let seq = 0

/**
 * Unique ids per call, deliberately. `one-tap.pieceFor` caches renders in a
 * module-level map keyed on `id:at`, so two tests both using `'a'` would silently
 * share one bitmap and the second would assert against the first's content. That is
 * fine in the app, where ids are unique for the life of a library, and a trap here.
 */
const textItem = (id: string, text: string, scroll: boolean): SavedItem => ({
  kind: 'text',
  id: `${id}-${seq++}`,
  name: text,
  at: 1,
  text,
  motion: scroll ? { kind: 'scroll', dir: 0, speed: 50 } : { kind: 'static' },
})

async function rig(t: MockTransport = datsDevice()) {
  const led = memoryLedger()
  // Time far apart, so the three-second interval rule never fires: this is testing the
  // reel's own arithmetic, not the rate limiter, which has its own tests.
  let clock = 1_000_000
  const budget = new bg.FlashBudget(led.store, () => (clock += 60_000))
  const glasses = await Glasses.attach(t, DEVICE, { pacing: 0, budget })
  const session = new PanelSession(glasses, () => {})
  return { t, glasses, session, led, budget }
}

const datsCount = (t: MockTransport) => t.commands.filter((c) => c === 'DATS').length

test('a reel of scrollers is one save, and every later press is free', async () => {
  const r = await rig()
  const items = [
    textItem('a', 'FIRST MESSAGE HERE', true),
    textItem('b', 'SECOND MESSAGE HERE', true),
    textItem('c', 'THIRD MESSAGE HERE', true),
  ]
  const plan = planReel(items, null)
  expect(plan.problems).toEqual([])
  // Three scrollers share one step, because they are one payload the panel scrolls.
  expect(plan.steps).toBe(1)

  const cycler = cyclerFor(r.glasses, r.session, plan, null)
  await cycler.next()
  expect(datsCount(r.t)).toBe(1)
  for (let i = 0; i < 6; i++) await cycler.next()
  // The whole point: six more presses, still one DATS on the wire for the session.
  expect(datsCount(r.t)).toBe(1)
})

test('stills ride the live buffer, so a mixed set still saves once', async () => {
  const r = await rig()
  const items = [
    textItem('a', 'HI', false),
    textItem('b', 'A MESSAGE LONG ENOUGH TO SCROLL', true),
    textItem('c', 'YO', false),
  ]
  const plan = planReel(items, null)
  expect(plan.problems).toEqual([])
  // Two stills plus the shared reel step.
  expect(plan.steps).toBe(3)

  const cycler = cyclerFor(r.glasses, r.session, plan, null)
  const costs: string[] = []
  for (let i = 0; i < plan.steps * 2; i++) {
    costs.push(cycler.costOf(i))
    await cycler.next()
  }
  expect(datsCount(r.t)).toBe(1)
  // Only the first visit to the reel step costs anything, and the second lap is free.
  expect(costs.filter((c) => c === 'save').length).toBe(1)
})

test('a reel the pair already holds is free to resume, and says so before the tap', async () => {
  const r = await rig()
  const items = [
    textItem('a', 'FIRST MESSAGE HERE', true),
    textItem('b', 'SECOND MESSAGE HERE', true),
  ]

  // First commit, from nothing.
  const cold = planReel(items, null)
  expect(cold.resident).toBe(false)
  const cycler = cyclerFor(r.glasses, r.session, cold, null)
  await cycler.next()
  expect(datsCount(r.t)).toBe(1)

  // Now the ledger knows, and the same set plans as resident.
  const ledger = await r.budget.ledger(DEVICE)
  const warm = planReel(items, ledger)
  expect(warm.resident).toBe(true)
  const resumed = cyclerFor(r.glasses, r.session, warm, ledger)
  expect(resumed.costOf(0)).toBe('free')
  await resumed.next()
  expect(datsCount(r.t)).toBe(1)
})

test('changing one member changes the reel, so it is not resident any more', async () => {
  const r = await rig()
  const base = [textItem('a', 'FIRST MESSAGE HERE', true), textItem('b', 'SECOND ONE', true)]
  const cycler = cyclerFor(r.glasses, r.session, planReel(base, null), null)
  await cycler.next()
  const ledger = await r.budget.ledger(DEVICE)

  const swapped = [base[0], textItem('c', 'A DIFFERENT SECOND', true)]
  expect(planReel(swapped, ledger).resident).toBe(false)
  // And the order matters too, because the packed columns differ.
  expect(planReel([base[1], base[0]], ledger).resident).toBe(false)
  expect(planReel(base, ledger).resident).toBe(true)
})

test('entriesFor gives an effect no trailing gap, because its loop already closes', () => {
  const effect: SavedItem = {
    kind: 'effect',
    id: 'e',
    name: 'Plasma',
    at: 1,
    effect: 'plasma',
    opts: {},
    columns: 240,
    dither: 'ordered',
    motion: { kind: 'scroll', dir: 0, speed: 50 },
  }
  const [entry] = entriesFor([effect])
  expect(entry.gap).toBe(0)
  // Text takes the default separation instead, since two messages run together read as
  // one message.
  expect(entriesFor([textItem('a', 'HI THERE EVERYONE', true)])[0].gap).toBeUndefined()
})

test('too few or too many items is a sentence, not a throw', () => {
  const one = planReel([textItem('a', 'ONLY ONE HERE', true)], null)
  expect(one.problems.length).toBeGreaterThan(0)
  const many = planReel(
    Array.from({ length: pl.MAX_ENTRIES + 1 }, (_, i) => textItem(`i${i}`, `MESSAGE ${i}`, true)),
    null,
  )
  expect(many.problems.length).toBeGreaterThan(0)
  // And a plan with problems is still a shape a screen can render, rather than null.
  expect(one.compiled.steps).toEqual([])
  expect(one.steps).toBe(0)
})

test('the packed reel is what gets saved, at the width the plan reported', async () => {
  const r = await rig()
  const items = [
    textItem('a', 'FIRST MESSAGE HERE', true),
    textItem('b', 'SECOND MESSAGE HERE', true),
  ]
  const plan = planReel(items, null)
  expect(plan.columns).toBeGreaterThan(content.MAX_LIVE_COLUMNS)
  const cycler = cyclerFor(r.glasses, r.session, plan, null)
  await cycler.next()
  const ledger = await r.budget.ledger(DEVICE)
  expect(ledger.recent[ledger.recent.length - 1].columns).toBe(plan.columns)
})

/**
 * What the screen is allowed to say about a committed reel, and why it needs its own
 * answer to it.
 *
 * Found by review-30, 2026-08-12: the done-when says the app says which items the pair's
 * reel holds, and nothing could. `one-tap.residentItem` is what every other surface uses
 * for "what is this pair holding", and it matches ONE item's fingerprint against the
 * ledger hash. A reel's hash is the packed payload's, so after a commit it matches no
 * member and the pair reads as holding nothing at all.
 */
test('a committed reel can be named as a set, though no single member matches it', async () => {
  const r = await rig()
  const items = [
    textItem('a', 'ALPHA MESSAGE', true),
    textItem('b', 'BRAVO MESSAGE', true),
    textItem('c', 'CHARLIE MESSAGE', true),
  ]
  expect(reelResident(items, null)).toBe(false)

  const cycler = cyclerFor(r.glasses, r.session, planReel(items, null), null)
  await cycler.next()
  const held = pl.residentHash(await r.glasses.ledger())
  expect(held).not.toBeNull()

  expect(reelResident(items, held)).toBe(true)
  // The reason this helper exists rather than reusing the single-item one.
  expect(residentItem(items, held)).toBeNull()

  // A different set, and a different ORDER, are both a different payload.
  expect(reelResident([items[0], items[1]], held)).toBe(false)
  expect(reelResident([items[2], items[1], items[0]], held)).toBe(false)
  // Below core's minimum there is no reel to be holding.
  expect(reelResident([items[0]], held)).toBe(false)
})
