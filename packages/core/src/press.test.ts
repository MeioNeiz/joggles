/**
 * The button drives the playlist, and the four properties nothing else would notice
 * breaking.
 *
 *  1. **A press cannot spend an erase.** Two tests drive real `Glasses` saves over a
 *     mock device and assert zero `DATS` frames: one with the reel resident, one with
 *     it not resident at all, where the press has to step over the costed reel and
 *     walk the statics instead.
 *  2. **The panel is forgotten whenever the firmware may have moved it.** Suppression
 *     unconfirmed, suppression refused, or an event carrying a real cycle index: each
 *     has to produce a full redraw rather than a delta aimed at a built-in.
 *  3. **Presses are dropped, never queued.** Inside an advance, inside a host upload,
 *     or while the host says no.
 *  4. **Nothing can reach the 2 s hold.** Every flag combination the module can
 *     produce goes through `jgx.buttonSet`, and the module builds no frame itself.
 *
 * Events are built by feeding real bytes through `jgx.parseNotification`, so a test
 * cannot fabricate a field layout the wire does not have.
 */
import { expect, test } from 'bun:test'
import { FlashBudget, memoryStore } from './budget.js'
import * as content from './content.js'
import { COLS, Grid, ROWS } from './display.js'
import * as jgx from './jgx.js'
import { datsDevice } from './mock-transport.js'
import * as pl from './playlist.js'
import * as press from './press.js'
import * as p from './protocol.js'
import { Glasses } from './session.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const CREW = jgx.CAP.SESSION | jgx.CAP.INPUT | jgx.CAP.BUTTON

/** A decrypted notification block, refused by the parser if it is malformed. */
function notify(...bytes: number[]): jgx.Notification {
  const plain = new Uint8Array(p.BLOCK_SIZE)
  plain[0] = bytes.length
  plain.set(bytes, 1)
  const msg = jgx.parseNotification(plain)
  if (!msg) throw new Error('the test built a notification the parser refuses')
  return msg
}

const edge = (
  kind: number,
  count: number,
  opts: { index?: number; ticks?: number } = {},
): jgx.Notification => {
  const { index = jgx.INDEX_NONE, ticks = 0 } = opts
  return notify(
    jgx.MARKER,
    jgx.MSG.BUTTON,
    kind,
    count,
    index,
    ticks & 0xff,
    (ticks >>> 8) & 0xff,
    (ticks >>> 16) & 0xff,
    (ticks >>> 24) & 0xff,
  )
}

const pressed = (count: number, opts: { index?: number; ticks?: number } = {}) =>
  edge(jgx.EDGE.PRESS, count, opts)

const ack = (flags: number, code: number = jgx.STATUS.OK): jgx.Notification =>
  notify(jgx.MARKER, jgx.MSG.ACK, jgx.SUB.BUTTON, code, flags)

/** A link that records, and can be told to refuse its writes now or from the start. */
function fakeLink(opts: { refuse?: boolean } = {}) {
  const sent: Uint8Array[] = []
  const order: string[] = []
  const state = { dead: opts.refuse === true }
  const held: { fn: ((m: jgx.Notification) => void) | null } = { fn: null }
  const link: press.PressLink = {
    command: async (frame) => {
      order.push('command')
      if (state.dead) throw new Error('link is gone')
      sent.push(frame)
    },
    onEvent: (fn) => {
      order.push('listen')
      held.fn = fn
      return () => {
        order.push('unlisten')
        held.fn = null
      }
    },
  }
  return {
    link,
    sent,
    order,
    feed: (msg: jgx.Notification) => held.fn?.(msg),
    get listening() {
      return held.fn !== null
    },
    subs: () => sent.map((f) => jgx.parseCommand(f)),
    die: () => {
      state.dead = true
    },
  }
}

/** A `playlist.Cycler` slice that records, with a `show` the test can hold open. */
function fakeList(costs: pl.Cost[], opts: { hold?: boolean; fail?: boolean } = {}) {
  const log: string[] = []
  const state = { index: -1 }
  const gates: Array<() => void> = []
  const wrap = (i: number) => ((i % costs.length) + costs.length) % costs.length
  const list: press.Advancing = {
    get length() {
      return costs.length
    },
    get index() {
      return state.index
    },
    costOf: (i) => costs[wrap(i)],
    show: async (i) => {
      const at = wrap(i)
      log.push(`show ${at}`)
      if (opts.hold) await new Promise<void>((r) => gates.push(r))
      if (opts.fail) throw new Error('the panel refused')
      state.index = at
      const step = { kind: 'live', label: `${at}` } as unknown as pl.Step
      return { index: at, step, cost: 'free' as pl.Cost, showing: true, writes: 0 }
    },
    forget: () => {
      log.push('forget')
    },
  }
  return { list, log, state, release: () => gates.splice(0).forEach((r) => r()) }
}

// --- a stock unit, which is every unit today -------------------------------------

test('a stock pair is inert: nothing is sent, nothing is subscribed', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const c = new press.PressCycle(link.link, list.list, 0)

  const started = await c.start()

  expect(started.started).toBe(false)
  expect(started.reason).toContain('still cycles the built-ins')
  expect(link.sent).toHaveLength(0)
  expect(link.order).toEqual([])
  expect(link.listening).toBe(false)
  expect(c.available).toBe(false)
  expect(c.listening).toBe(false)
  // Nothing subscribed means no press exists, but even a fabricated one is inert.
  link.feed(pressed(1))
  await c.settled()
  expect(list.log).toEqual([])
})

test('the INPUT family bit licenses nothing: the BUTTON bit is the gate', () => {
  expect(press.PressCycle.available(jgx.CAP.INPUT)).toBe(false)
  expect(press.PressCycle.available(jgx.CAP.BUTTON)).toBe(true)
  expect(press.PressCycle.available(CREW)).toBe(true)
})

// --- taking and giving back the short press --------------------------------------

test('the subscription goes on before the command, so no ACK can be missed', async () => {
  const link = fakeLink()
  const c = new press.PressCycle(link.link, fakeList(['free']).list, CREW)

  await c.start()

  expect(link.order).toEqual(['listen', 'command'])
  expect(c.listening).toBe(true)
})

test('the flags are PRESS, HOLD and SUPPRESS_CYCLE, and RELEASE is opt-in', async () => {
  const link = fakeLink()
  const c = new press.PressCycle(link.link, fakeList(['free']).list, CREW)
  await c.start()

  const [sub] = link.subs()
  expect(sub).not.toBeNull()
  expect(sub!.sub).toBe(jgx.SUB.BUTTON)
  expect(sub!.args[0]).toBe(jgx.SET)
  expect(sub!.args[1]).toBe(press.DEFAULT_FLAGS)
  expect(c.flags).toBe(jgx.BTN.PRESS | jgx.BTN.HOLD | jgx.BTN.SUPPRESS_CYCLE)

  expect(press.flagsFor({ release: true }) & jgx.BTN.RELEASE).toBe(jgx.BTN.RELEASE)
  expect(press.flagsFor({ suppress: false }) & jgx.BTN.SUPPRESS_CYCLE).toBe(0)
})

test('starting twice subscribes once: two listeners would double every press', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const c = new press.PressCycle(link.link, list.list, CREW)

  await c.start()
  const again = await c.start()

  expect(again).toEqual({ started: true, flags: press.DEFAULT_FLAGS })
  expect(link.sent).toHaveLength(1)
  expect(link.order).toEqual(['listen', 'command'])

  link.feed(pressed(1))
  await c.settled()
  expect(list.log.filter((l) => l.startsWith('show'))).toEqual(['show 0'])
})

test('a subscription whose write failed leaves no listener behind', async () => {
  const link = fakeLink({ refuse: true })
  const c = new press.PressCycle(link.link, fakeList(['free']).list, CREW)

  const started = await c.start()

  expect(started.started).toBe(false)
  expect(started.reason).toContain('subscription failed')
  expect(link.listening).toBe(false)
  expect(c.flags).toBe(0)
})

test('stop unsubscribes before BTN_OFF, so a press in between cannot advance', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const c = new press.PressCycle(link.link, list.list, CREW)
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))

  const stopped = await c.stop()

  expect(stopped).toEqual({ stopped: true, cleared: true })
  expect(link.order).toEqual(['listen', 'command', 'unlisten', 'command'])
  expect(link.subs()[1]!.args[1]).toBe(jgx.BTN_OFF)
  expect(c.suppressed).toBe('no')
  expect(c.listening).toBe(false)

  link.feed(pressed(1))
  await c.settled()
  expect(list.log).toEqual([])
})

test('stop on a dead link says the unit is suppressed until a hold', async () => {
  // The link has to die *after* the subscription landed: a start that failed left
  // nothing at the unit to clear.
  const link = fakeLink()
  const c = new press.PressCycle(link.link, fakeList(['free', 'free']).list, CREW)
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))
  expect(c.suppressed).toBe('yes')
  link.die()

  const stopped = await c.stop()

  expect(stopped).toMatchObject({ stopped: true, cleared: false })
  expect(stopped.reason).toContain('2 second hold')
  expect(link.sent).toHaveLength(1)
  expect(c.listening).toBe(false)
  // Still 'yes': the unit is doing what it was told and this driver has stopped
  // being able to change it. A power cycle is what clears it, and the wearer's own
  // 2 second hold is that power cycle.
  expect(c.suppressed).toBe('yes')
})

test('a stop that never sent BTN_OFF, with nothing ever confirmed, is unknown', async () => {
  const link = fakeLink()
  const c = new press.PressCycle(link.link, fakeList(['free', 'free']).list, CREW)
  await c.start()
  link.die()

  expect(await c.stop()).toMatchObject({ cleared: false })
  expect(c.suppressed).toBe('unknown')
})

test('stopping when nothing was started sends nothing', async () => {
  const link = fakeLink()
  const c = new press.PressCycle(link.link, fakeList(['free']).list, CREW)
  expect(await c.stop()).toEqual({ stopped: true, cleared: true })
  expect(link.sent).toHaveLength(0)
})

test('ask sends the BUTTON question, and only while subscribed', async () => {
  const link = fakeLink()
  const c = new press.PressCycle(link.link, fakeList(['free']).list, CREW)

  expect(await c.ask()).toBe(false)
  await c.start()
  expect(await c.ask()).toBe(true)

  const asked = link.subs()[1]!
  expect(asked.sub).toBe(jgx.SUB.BUTTON)
  expect(asked.args[0]).toBe(jgx.ASK)
})

// --- what the ACK is for --------------------------------------------------------

test('the ACK is what says suppression took; until one arrives it is unknown', async () => {
  const link = fakeLink()
  const c = new press.PressCycle(link.link, fakeList(['free']).list, CREW)

  expect(c.suppressed).toBe('no')
  await c.start()
  expect(c.suppressed).toBe('unknown')
  link.feed(ack(press.DEFAULT_FLAGS))
  expect(c.suppressed).toBe('yes')
})

test('an ACK echoing no SUPPRESS_CYCLE means the firmware still cycles', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const c = new press.PressCycle(link.link, list.list, CREW)
  await c.start()
  link.feed(ack(jgx.BTN.PRESS | jgx.BTN.HOLD))

  expect(c.suppressed).toBe('no')
  link.feed(pressed(1))
  await c.settled()

  // Forgotten first, because a built-in has the panel and a delta would be aimed at it.
  expect(list.log).toEqual(['forget', 'show 0'])
})

test('a refused ACK reads as nothing in force', async () => {
  const link = fakeLink()
  const c = new press.PressCycle(link.link, fakeList(['free']).list, CREW)
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS, jgx.STATUS.UNSUPPORTED))

  expect(c.suppressed).toBe('no')
})

test('an ACK for another sub-command is not this feature answering', async () => {
  const link = fakeLink()
  const c = new press.PressCycle(link.link, fakeList(['free']).list, CREW)
  await c.start()
  link.feed(notify(jgx.MARKER, jgx.MSG.ACK, jgx.SUB.SMOOTH, jgx.STATUS.OK, 4))

  expect(c.suppressed).toBe('unknown')
})

test('an unconfirmed subscription forgets the panel on every press', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const c = new press.PressCycle(link.link, list.list, CREW)
  await c.start()

  link.feed(pressed(1))
  await c.settled()

  expect(list.log).toEqual(['forget', 'show 0'])
})

test('with suppression confirmed and INDEX_NONE, the panel is left alone', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const c = new press.PressCycle(link.link, list.list, CREW)
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))

  link.feed(pressed(1))
  await c.settled()
  link.feed(pressed(2, { ticks: 100 }))
  await c.settled()

  expect(list.log).toEqual(['show 0', 'show 1'])
})

test('a press carrying a real index says the built-in cycle moved anyway', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const c = new press.PressCycle(link.link, list.list, CREW)
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))

  link.feed(pressed(1, { index: 4 }))
  await c.settled()

  expect(list.log).toEqual(['forget', 'show 0'])
})

// --- what a press does ----------------------------------------------------------

test('one press, one step, and it wraps', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const seen: press.PressOutcome[] = []
  const c = new press.PressCycle(link.link, list.list, CREW, {
    onPress: (o) => seen.push(o),
  })
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))

  for (const n of [1, 2, 3]) {
    link.feed(pressed(n, { ticks: n * 100 }))
    await c.settled()
  }

  expect(list.log).toEqual(['show 0', 'show 1', 'show 0'])
  expect(seen.map((o) => o.action)).toEqual(['advanced', 'advanced', 'advanced'])
  expect(seen[0].step!.showing).toBe(true)
  expect(c.tally).toEqual({ presses: 3, advanced: 3, dropped: 0, missed: 0 })
})

test('a press steps over anything that would need a save', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'save', 'free'])
  const c = new press.PressCycle(link.link, list.list, CREW)
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))

  for (const n of [1, 2, 3]) {
    link.feed(pressed(n, { ticks: n * 100 }))
    await c.settled()
  }

  expect(list.log).toEqual(['show 0', 'show 2', 'show 0'])
})

test('a lap of nothing but costed steps leaves the press with nothing to do', async () => {
  const link = fakeLink()
  const list = fakeList(['save', 'save'])
  const seen: press.PressOutcome[] = []
  const c = new press.PressCycle(link.link, list.list, CREW, {
    onPress: (o) => seen.push(o),
  })
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))

  link.feed(pressed(1))
  await c.settled()

  expect(list.log).toEqual([])
  expect(seen[0].action).toBe('costed')
  expect(seen[0].reason).toContain('never spends flash')
  expect(c.tally.dropped).toBe(1)
})

// --- the races ------------------------------------------------------------------

test('a press inside an advance is dropped, not queued', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'], { hold: true })
  const seen: press.PressOutcome[] = []
  const c = new press.PressCycle(link.link, list.list, CREW, {
    onPress: (o) => seen.push(o),
  })
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))

  link.feed(pressed(1))
  expect(c.busy).toBe(true)
  link.feed(pressed(2, { ticks: 10 }))
  link.feed(pressed(3, { ticks: 20 }))
  expect(list.log).toEqual(['show 0'])
  expect(seen.map((o) => o.action)).toEqual(['busy', 'busy'])

  list.release()
  await c.settled()

  // Nothing banked: the two dropped presses did not become advances afterwards.
  expect(list.log).toEqual(['show 0'])
  expect(c.tally).toEqual({ presses: 3, advanced: 1, dropped: 2, missed: 0 })
  expect(seen[0].reason).toContain('dropped')
})

test('a press inside a host upload is dropped: exclusive covers it', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const seen: press.PressOutcome[] = []
  const c = new press.PressCycle(link.link, list.list, CREW, {
    onPress: (o) => seen.push(o),
  })
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))

  let finish = () => {}
  const upload = c.exclusive(
    () => new Promise<string>((r) => (finish = () => r('saved'))),
  )
  expect(c.busy).toBe(true)
  link.feed(pressed(1))
  expect(list.log).toEqual([])
  expect(seen[0].action).toBe('busy')

  finish()
  expect(await upload).toBe('saved')
  await c.settled()

  link.feed(pressed(2, { ticks: 50 }))
  await c.settled()
  expect(list.log).toEqual(['show 0'])
})

test('a failing host operation still hands the button back', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const c = new press.PressCycle(link.link, list.list, CREW)
  await c.start()

  const failed = c.exclusive(async () => {
    throw new Error('the upload died')
  })
  await expect(failed).rejects.toThrow('the upload died')
  await c.settled()
  expect(c.busy).toBe(false)

  link.feed(pressed(1))
  await c.settled()
  expect(list.log).toContain('show 0')
})

test('blocked is host state this cannot see, and its sentence is the report', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const seen: press.PressOutcome[] = []
  let why: string | null = 'the drawing screen has the panel'
  const c = new press.PressCycle(link.link, list.list, CREW, {
    blocked: () => why,
    onPress: (o) => seen.push(o),
  })
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))

  link.feed(pressed(1))
  await c.settled()
  expect(list.log).toEqual([])
  expect(seen[0]).toMatchObject({
    action: 'blocked',
    reason: 'the drawing screen has the panel',
  })

  why = null
  link.feed(pressed(2, { ticks: 90 }))
  await c.settled()
  expect(list.log).toEqual(['show 0'])
})

test('a throw from blocked reads as blocked, because the host state is unknown', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const seen: press.PressOutcome[] = []
  const c = new press.PressCycle(link.link, list.list, CREW, {
    blocked: () => {
      throw new Error('no idea')
    },
    onPress: (o) => seen.push(o),
  })
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))

  link.feed(pressed(1))
  await c.settled()

  expect(list.log).toEqual([])
  expect(seen[0].action).toBe('blocked')
  expect(seen[0].reason).toContain('no idea')
})

test('a throw from show is reported, never thrown into the notify handler', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'], { fail: true })
  const seen: press.PressOutcome[] = []
  const c = new press.PressCycle(link.link, list.list, CREW, {
    onPress: (o) => seen.push(o),
  })
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))

  expect(() => link.feed(pressed(1))).not.toThrow()
  await c.settled()

  expect(seen[0].action).toBe('failed')
  expect(String(seen[0].error)).toContain('the panel refused')
  // Still usable: one failure does not end the subscription.
  expect(c.busy).toBe(false)
  expect(c.listening).toBe(true)
})

test('a throw from onPress cannot take the driver down with it', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const c = new press.PressCycle(link.link, list.list, CREW, {
    onPress: () => {
      throw new Error('the screen blew up')
    },
  })
  await c.start()

  expect(() => link.feed(pressed(1))).not.toThrow()
  await c.settled()
  expect(list.log).toContain('show 0')
})

// --- edges that are not presses -------------------------------------------------

test('a hold is never an advance: it is the unit switching itself off', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const holds: press.PressEvent[] = []
  const seen: press.PressOutcome[] = []
  const c = new press.PressCycle(link.link, list.list, CREW, {
    onHold: (e) => holds.push(e),
    onPress: (o) => seen.push(o),
  })
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))

  link.feed(pressed(1, { ticks: 1000 }))
  await c.settled()
  link.feed(edge(jgx.EDGE.HOLD, 1, { ticks: 1100 }))
  await c.settled()

  expect(list.log).toEqual(['show 0'])
  expect(holds).toHaveLength(1)
  // The hold's stamp against the press's is how long it was held, in device time.
  expect(holds[0].sinceMs).toBe(2000)
  expect(seen.map((o) => o.action)).toEqual(['advanced'])
  expect(c.tally.presses).toBe(1)
})

test('a release reaches onEdge and is not an advance', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const edges: number[] = []
  const c = new press.PressCycle(link.link, list.list, CREW, { release: true })
  await c.start()
  c.onEdge((e) => edges.push(e.edge))

  link.feed(edge(jgx.EDGE.RELEASE, 1, { ticks: 5 }))
  await c.settled()

  expect(edges).toEqual([jgx.EDGE.RELEASE])
  expect(list.log).toEqual([])
  expect(c.tally.presses).toBe(0)
})

test('onEdge gives a second consumer the edges with no second subscription', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const taps: Array<number | null> = []
  const c = new press.PressCycle(link.link, list.list, CREW)
  await c.start()
  const off = c.onEdge((e) => taps.push(e.sinceMs))

  link.feed(pressed(1, { ticks: 0 }))
  await c.settled()
  link.feed(pressed(2, { ticks: 25 }))
  await c.settled()
  off()
  link.feed(pressed(3, { ticks: 50 }))
  await c.settled()

  expect(taps).toEqual([null, 500])
  expect(link.sent).toHaveLength(1)
})

test('notifications that are not ours are ignored', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const c = new press.PressCycle(link.link, list.list, CREW)
  await c.start()

  link.feed(notify(jgx.MARKER, jgx.MSG.HELLO_REPLY, 2, 0, CREW & 0xff, CREW >> 8))
  link.feed(notify(jgx.MARKER, jgx.MSG.BATTERY, 0x0e, 0x10))
  await c.settled()

  expect(list.log).toEqual([])
  expect(c.suppressed).toBe('unknown')
})

// --- the counter and the tick stamp ---------------------------------------------

test('the first press of a connection reports no missed presses', async () => {
  const link = fakeLink()
  const seen: press.PressOutcome[] = []
  const c = new press.PressCycle(link.link, fakeList(['free', 'free']).list, CREW, {
    onPress: (o) => seen.push(o),
  })
  await c.start()

  // A unit that rebooted starts its counter again, and a wrap is indistinguishable
  // from that, so the question is not asked.
  link.feed(pressed(1, { ticks: 4 }))
  await c.settled()

  expect(seen[0].event.missed).toBe(0)
  expect(seen[0].event.sinceMs).toBeNull()
  expect(c.tally.missed).toBe(0)
})

test('a gap in the counter is reported as presses that never arrived', async () => {
  const link = fakeLink()
  const seen: press.PressOutcome[] = []
  const c = new press.PressCycle(link.link, fakeList(['free', 'free']).list, CREW, {
    onPress: (o) => seen.push(o),
  })
  await c.start()

  link.feed(pressed(7))
  await c.settled()
  link.feed(pressed(10, { ticks: 300 }))
  await c.settled()

  expect(seen[1].event.missed).toBe(2)
  expect(c.tally.missed).toBe(2)
  // The counter wraps at 256, and the interval does not care.
  link.feed(pressed(1, { ticks: 400 }))
  await c.settled()
  expect(seen[2].event.missed).toBe(246)
})

test('the same edge twice advances once', async () => {
  const link = fakeLink()
  const list = fakeList(['free', 'free'])
  const seen: press.PressOutcome[] = []
  const c = new press.PressCycle(link.link, list.list, CREW, {
    onPress: (o) => seen.push(o),
  })
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))

  link.feed(pressed(4, { ticks: 77 }))
  await c.settled()
  link.feed(pressed(4, { ticks: 77 }))
  await c.settled()

  expect(list.log).toEqual(['show 0'])
  expect(seen.map((o) => o.action)).toEqual(['advanced', 'repeat'])
  // Counted once: a duplicate delivery is not a second press.
  expect(c.tally).toEqual({ presses: 1, advanced: 1, dropped: 0, missed: 0 })
})

test('the interval is device time, and MSG.TICK changes its rate', async () => {
  const link = fakeLink()
  const seen: press.PressOutcome[] = []
  const c = new press.PressCycle(link.link, fakeList(['free', 'free']).list, CREW, {
    onPress: (o) => seen.push(o),
  })
  await c.start()

  expect(c.tickHz).toBe(jgx.TICK_STOCK_HZ)
  link.feed(pressed(1, { ticks: 0 }))
  await c.settled()
  link.feed(pressed(2, { ticks: 25 }))
  await c.settled()
  expect(seen[1].event.sinceMs).toBe(500)
  expect(seen[1].event.hz).toBe(50)

  // Whoever asked for the rate, this is the timebase every interval is read at.
  link.feed(notify(jgx.MARKER, jgx.MSG.TICK, 100, jgx.HOLD_TICKS_STOCK * 2, 0))
  expect(c.tickHz).toBe(100)
  link.feed(pressed(3, { ticks: 50 }))
  await c.settled()
  expect(seen[2].event.sinceMs).toBe(250)
  expect(seen[2].event.hz).toBe(100)
})

test('an interval reads across the tick counter wrap', async () => {
  const link = fakeLink()
  const seen: press.PressOutcome[] = []
  const c = new press.PressCycle(link.link, fakeList(['free', 'free']).list, CREW, {
    onPress: (o) => seen.push(o),
  })
  await c.start()

  link.feed(pressed(1, { ticks: 0xfffffff0 }))
  await c.settled()
  link.feed(pressed(2, { ticks: 9 }))
  await c.settled()

  expect(seen[1].event.sinceMs).toBe(jgx.tapIntervalMs(0xfffffff0, 9, 50))
  expect(seen[1].event.sinceMs).toBeGreaterThan(0)
})

// --- the hold, and what this module is allowed to send --------------------------

test('no flag this module can produce goes near the 2 second hold', () => {
  for (const release of [false, true]) {
    for (const suppress of [false, true]) {
      const flags = press.flagsFor({ release, suppress })
      // buttonSet is the gate: it throws on any bit that is not defined, and there
      // is no defined bit for the hold to be suppressed by.
      expect(() => jgx.buttonSet(flags)).not.toThrow()
      expect(flags & ~jgx.BTN_FLAGS).toBe(0)
      expect(flags & jgx.BTN.HOLD).toBe(jgx.BTN.HOLD)
    }
  }
})

test('every frame sent is a BUTTON sub-command, and it builds none itself', async () => {
  const link = fakeLink()
  const c = new press.PressCycle(link.link, fakeList(['free', 'free']).list, CREW, {
    release: true,
  })
  await c.start()
  await c.ask()
  link.feed(pressed(1))
  await c.settled()
  await c.stop()

  expect(link.sent).toHaveLength(3)
  for (const frame of link.sent) {
    const parsed = jgx.parseCommand(frame)
    expect(parsed).not.toBeNull()
    expect(parsed!.sub).toBe(jgx.SUB.BUTTON)
  }

  // Nothing here assembles a frame or reaches the flash write, so neither the
  // dispatcher's length gate nor the erase path can be got at by accident.
  const here = dirname(new URL(import.meta.url).pathname)
  const source = readFileSync(join(here, 'press.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  for (const banned of ['subFrame', 'protocol.js', 'save', 'datsComplete']) {
    expect(source).not.toContain(banned)
  }
})

// --- against real saves: the button spends nothing ------------------------------

const scroll = (speed = 50): content.Motion => ({ kind: 'scroll', dir: 0, speed })

const filled = (level: number): content.Bitmap =>
  Array.from({ length: ROWS }, () => new Array(COLS).fill(level))

/** Two statics and one scroller, which in `reel` mode is three entries, two steps. */
const playlist = () => [
  pl.imageEntry('one', new Grid()),
  pl.imageEntry('two', filled(2)),
  pl.textEntry('msg', 'HELLO THERE', scroll()),
]

async function realCycler(opts: { resident?: boolean } = {}) {
  const transport = datsDevice()
  const glasses = await Glasses.attach(transport, 'GLASSES-PRESS', {
    pacing: 0,
    budget: new FlashBudget(memoryStore(), () => 1_000_000),
  })
  const plan = pl.compile(playlist())
  const cycler = new pl.Cycler(glasses, plan, {
    save: { blockSleep: 0 },
    ...(opts.resident ? { resident: plan.reel!.hash } : {}),
  })
  const datsCount = () => transport.commands.filter((c) => c === 'DATS').length
  return { transport, glasses, plan, cycler, datsCount }
}

test('a lap of presses over a resident reel spends no erases at all', async () => {
  const h = await realCycler({ resident: true })
  const link = fakeLink()
  const seen: press.PressOutcome[] = []
  const c = new press.PressCycle(link.link, h.cycler, CREW, {
    onPress: (o) => seen.push(o),
  })
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))

  for (const n of [1, 2, 3, 4]) {
    link.feed(pressed(n, { ticks: n * 100 }))
    await c.settled()
  }

  expect(seen.map((o) => o.action)).toEqual(Array(4).fill('advanced'))
  expect(seen.map((o) => o.step!.cost)).toEqual(['free', 'free', 'free', 'free'])
  expect(seen.map((o) => o.step!.index)).toEqual([0, 1, 2, 0])
  expect(h.datsCount()).toBe(0)
  expect((await h.glasses.ledger()).lifetime).toBe(0)
}, 15000)

test('with the reel not resident the button walks the statics, saving nothing', async () => {
  const h = await realCycler()
  const link = fakeLink()
  const seen: press.PressOutcome[] = []
  const c = new press.PressCycle(link.link, h.cycler, CREW, {
    onPress: (o) => seen.push(o),
  })
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))

  for (const n of [1, 2, 3, 4]) {
    link.feed(pressed(n, { ticks: n * 100 }))
    await c.settled()
  }

  // Step 2 is the reel, priced `save`, so it is stepped over every lap.
  expect(seen.map((o) => o.step!.index)).toEqual([0, 1, 0, 1])
  expect(h.datsCount()).toBe(0)
  expect((await h.glasses.ledger()).lifetime).toBe(0)
  // And the wire is only ever the live route.
  const opcodes = h.transport.commands
  expect(opcodes).not.toContain('DATS')
  expect(opcodes).not.toContain('DATCP')
  expect(opcodes).not.toContain('MODE')
}, 15000)

test('the phone commits the reel, and the button then shows it for free', async () => {
  const h = await realCycler()
  const link = fakeLink()
  const c = new press.PressCycle(link.link, h.cycler, CREW)
  await c.start()
  link.feed(ack(press.DEFAULT_FLAGS))

  // What the phone does, through the driver's own mutex so a press cannot land
  // inside the handshake.
  const saved = await c.exclusive(() => h.cycler.show(2))
  expect(saved).toMatchObject({ cost: 'save', showing: true })
  expect(h.datsCount()).toBe(1)

  link.feed(pressed(1, { ticks: 10 }))
  await c.settled()
  link.feed(pressed(2, { ticks: 200 }))
  await c.settled()
  link.feed(pressed(3, { ticks: 400 }))
  await c.settled()

  // The reel is resident now, so the press that lands on it is free.
  expect(h.datsCount()).toBe(1)
  expect(h.cycler.index).toBe(2)
}, 15000)
