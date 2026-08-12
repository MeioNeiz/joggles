/**
 * The planner's routing table and the executor's wire, against the mock device.
 *
 * The property that matters: a tap the plan called free NEVER produces a `DATS`, and a
 * tap the plan called a save produces exactly the sequence `deliver.test.ts` already
 * pins. The screens show `plan` and hand the same object back, so these tests are the
 * whole audit of what a library tap can do.
 */
import { Glasses, content, protocol as p } from '@joggles/core'
import { MockTransport, datsDevice, opcodeOf } from '@joggles/core/src/mock-transport.js'
import { describe, expect, test } from 'bun:test'
import { ANIMATIONS } from './builtins.js'
import type { SavedText } from './library.js'
import {
  type TapContext,
  type TapDeps,
  fingerprintOf,
  pieceFor,
  planTap,
  residentItem,
  runTap,
  showable,
} from './one-tap.js'
import { PanelSession } from './panel-session.js'

const attach = (t: MockTransport) =>
  Glasses.attach(t, 'GLASSES-TEST', { pacing: 0, budget: undefined })

const commands = (t: MockTransport): string[] => t.to(p.CHAR_COMMAND).map(opcodeOf)

async function rig(t: MockTransport = datsDevice()) {
  const glasses = await attach(t)
  const session = new PanelSession(glasses, () => {})
  let drops = 0
  const deps: TapDeps = {
    glasses,
    live: () => session.live(),
    dropped: () => {
      drops++
      session.dropped()
    },
  }
  return { t, glasses, deps, drops: () => drops }
}

const ctx = (over: Partial<TapContext> = {}): TapContext => ({
  connected: true,
  resident: null,
  liveWork: false,
  ...over,
})

const still = (text: string) =>
  ({ kind: 'piece', piece: content.text(text, { kind: 'static' }) }) as const

const scroller = (text: string) =>
  ({
    kind: 'piece',
    piece: content.text(text, { kind: 'scroll', dir: 0, speed: 65 }),
  }) as const

describe('planTap', () => {
  test('nothing connected blocks everything, and says where to go', () => {
    const plan = planTap(still('HI'), ctx({ connected: false }))
    expect(plan.kind).toBe('blocked')
    if (plan.kind === 'blocked') expect(plan.why.join(' ')).toMatch(/Glasses tab/)
  })

  test('a still that fits goes live, free, no warning to give', () => {
    const plan = planTap(still('HI'), ctx({ liveWork: true }))
    expect(plan).toEqual({ kind: 'live', free: true, replaces: false, clipped: false })
  })

  test('a wide still is clipped rather than refused', () => {
    // "Text thats too long should still show, just go off the screen".
    const wide = still('JOGGLES AT A FESTIVAL')
    expect(content.width(wide.piece.bitmap)).toBeGreaterThan(content.MAX_LIVE_COLUMNS)
    const plan = planTap(wide, ctx())
    expect(plan.kind).toBe('live')
    if (plan.kind === 'live') expect(plan.clipped).toBe(true)
  })

  test('nothing lit is refused: five erases for a dark panel is the one hard no', () => {
    const blank = {
      kind: 'piece',
      piece: {
        bitmap: content.blank(48),
        route: 'saved',
        motion: { kind: 'scroll', dir: 0, speed: 65 },
      },
    } as const
    expect(planTap(blank, ctx()).kind).toBe('blocked')
  })

  test('an unsaved scroller is a save, with deliver’s own cost words', () => {
    const plan = planTap(scroller('JOGGLES'), ctx({ liveWork: true }))
    expect(plan.kind).toBe('save')
    if (plan.kind !== 'save') return
    expect(plan.free).toBe(false)
    expect(plan.cost.erases).toBe(5)
    expect(plan.cost.words).toMatch(/flash/i)
    expect(plan.grey).toBeNull()
    expect(plan.replaces).toBe(true)
  })

  test('the resident scroller is a free return, and the fingerprint is the ledger’s kind', () => {
    const what = scroller('JOGGLES')
    const print = fingerprintOf(what.piece)
    expect(print).not.toBeNull()
    const plan = planTap(what, ctx({ resident: print }))
    expect(plan).toEqual({ kind: 'return', free: true, replaces: false })
    // One dim pixel makes it grey content, which kept would be type 2: no residency.
    const grey = what.piece.bitmap.map((row) => row.slice())
    grey[4][0] = 1
    expect(
      fingerprintOf({ ...what.piece, bitmap: grey }, 'keep'),
    ).toBeNull()
  })

  test('a built-in warns exactly when there is live work to lose', () => {
    const what = { kind: 'builtin', builtin: ANIMATIONS[0] } as const
    expect(planTap(what, ctx())).toEqual({ kind: 'builtin', free: true, replaces: false })
    expect(planTap(what, ctx({ liveWork: true }))).toEqual({
      kind: 'builtin',
      free: true,
      replaces: true,
    })
  })
})

describe('runTap', () => {
  test('a built-in is one command and the sender is dropped, never repaired', async () => {
    const r = await rig()
    const what = { kind: 'builtin', builtin: ANIMATIONS[0] } as const
    const out = await runTap(r.deps, what, planTap(what, ctx()))
    expect(out.showing).toBe(true)
    expect(out.spent).toBe(false)
    expect(commands(r.t)).toEqual(['ANIM'])
    expect(r.drops()).toBe(1)
  })

  test('a free live tap touches 960b and never DATS, SPEED or MODE', async () => {
    const r = await rig()
    const what = still('HI')
    const out = await runTap(r.deps, what, planTap(what, ctx()))
    expect(out.showing).toBe(true)
    expect(out.spent).toBe(false)
    expect(r.t.to(p.CHAR_BULK_B).length).toBeGreaterThan(0)
    // begin() legitimately sends SMVEW and LEDON; the saved store must stay untouched.
    const sent = commands(r.t)
    expect(sent).not.toContain('DATS')
    expect(sent).not.toContain('DATCP')
    expect(sent).not.toContain('MODE')
    expect(sent).not.toContain('SPEED')
  })

  test('a clipped still sends exactly one screenful', async () => {
    const r = await rig()
    const what = still('JOGGLES AT A FESTIVAL')
    const plan = planTap(what, ctx())
    const out = await runTap(r.deps, what, plan)
    expect(out.message).toMatch(/first screenful/)
    expect(r.t.to(p.CHAR_BULK_B).length).toBeGreaterThan(0)
  })

  test('a save is the pinned sequence, and the sender is dropped after MODE', async () => {
    const r = await rig()
    const what = scroller('JOGGLES')
    // Put live work on the panel first, so the drop is observable.
    await runTap(r.deps, still('HI'), planTap(still('HI'), ctx()))
    const out = await runTap(r.deps, what, planTap(what, ctx({ liveWork: true })))
    expect(out.showing).toBe(true)
    expect(out.spent).toBe(true)
    expect(out.message).toMatch(/stays with the phone off/)
    const sent = commands(r.t)
    expect(sent.filter((op) => op === 'DATS')).toEqual(['DATS'])
    // `opcodeOf` mis-splits SPEED 65 as SPEEDA (65 is 'A'), the documented trap in
    // `mock-transport.ts`, so the middle opcode is matched by prefix.
    const tail = sent.slice(-3)
    expect(tail[0]).toBe('DATCP')
    expect(tail[1]).toStartWith('SPEED')
    expect(tail[2]).toBe('MODE')
    expect(r.drops()).toBe(1)
  })

  test('a blocked plan sends nothing at all', async () => {
    const r = await rig()
    const what = still('HI')
    const out = await runTap(r.deps, what, planTap(what, ctx({ connected: false })))
    expect(out.showing).toBe(false)
    expect(commands(r.t)).toEqual([])
    expect(r.t.to(p.CHAR_BULK_B)).toEqual([])
  })
})

describe('residentItem', () => {
  const text = (id: string, text: string): SavedText => ({
    kind: 'text',
    id,
    name: text,
    at: 1,
    text,
    motion: { kind: 'scroll', dir: 0, speed: 65 },
  })

  test('names the item whose type 1 payload the pair last acknowledged', () => {
    const items = [text('a', 'ONE'), text('b', 'TWO')]
    const print = fingerprintOf(pieceFor(items[1]))
    expect(residentItem(items, print)).toMatchObject({ id: 'b' })
    expect(residentItem(items, 'not-a-real-hash')).toBeNull()
    expect(residentItem(items, null)).toBeNull()
  })

  test('pieceFor caches by identity, so a library render is paid once', () => {
    const item = text('a', 'ONE')
    expect(pieceFor(item)).toBe(pieceFor({ ...item }))
  })

  test('showable wraps a library item as a piece', () => {
    expect(showable(text('a', 'ONE')).kind).toBe('piece')
  })
})

  test('a rejected commit sends no MODE, and still reports the wear it spent', async () => {
    // The device answers ERROR to DATCP after the five pages have already been erased,
    // which is the one outcome where "nothing happened on the panel" and "nothing was
    // spent" come apart. Before track 32 this sent MODE anyway, switching the panel to
    // whatever the store held and reporting success.
    const r = await rig(datsDevice({ fail: true }))
    const what = scroller('JOGGLES')
    const out = await runTap(r.deps, what, planTap(what, ctx()))

    expect(out.showing).toBe(false)
    expect(out.spent).toBe(true)
    expect(out.message).toContain('nothing changed on the panel')
    const sent = commands(r.t)
    expect(sent).toContain('DATCP')
    expect(sent).not.toContain('MODE')
    expect(sent).not.toContain('SPEED')
  })

  test('progress counts the blocks the session actually sent', async () => {
    // The bar's whole claim is that it shows what the radio has done, so the numbers
    // have to be the session's rather than a timer or an estimate. A wide loop is the
    // case that matters: it is the multi-second wait behind "it seems to keep having
    // to send the animation to the device".
    const r = await rig()
    const seen: Array<[number, number]> = []
    const deps: TapDeps = { ...r.deps, progress: (sent, total) => seen.push([sent, total]) }
    const what = scroller('JOGGLES AT A FESTIVAL, SCROLLING PAST')
    const out = await runTap(deps, what, planTap(what, ctx()))

    expect(out.showing).toBe(true)
    const total = seen[0][1]
    expect(total).toBeGreaterThan(1)
    // Opens at zero so a bar can appear before the first block lands, ends at the
    // total, and never goes backwards or past it.
    expect(seen[0][0]).toBe(0)
    expect(seen[seen.length - 1]).toEqual([total, total])
    expect(seen.every(([sent, t]) => sent <= t && t === total)).toBe(true)
    for (let i = 1; i < seen.length; i++) expect(seen[i][0]).toBeGreaterThanOrEqual(seen[i - 1][0])
    // One call per block plus the opening zero, so it is the stream being reported and
    // not a progress animation someone drove from a clock.
    expect(seen.length).toBe(total + 1)
  })
