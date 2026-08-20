/**
 * The playlist, and the one thing it exists to get right: cycling costs no flash.
 *
 * Two properties nothing else would notice breaking, and they are the reason this
 * file is longer than the module:
 *
 *  1. **The reel hash is the ledger's hash.** Residency is a string comparison
 *     against what `session.save()` recorded, so if `compile` fingerprints anything
 *     other than the exact bytes the save will send, every visit re-erases.
 *  2. **A save of another type between two visits changes nothing.** That is the
 *     defect in `notes/playlist.md`. *Corrected 2026-08-12: this said the budget alone
 *     would clear a redundant reel save as new content, which was true of a
 *     `SaveRecord` with no DATS type on it. Track 32 added one, so the guard and this
 *     module now agree; what the module still buys is not issuing the `DATS`.*
 *
 * `Driver` is a structural slice of `Glasses`, so most of these run against a
 * recording driver whose `save` is the real thing over a mock device. What that
 * buys is the real budget, the real ledger and the real payload bytes, without
 * `Glasses.command`'s 120ms settle in every transition. One test at the end drives
 * a whole `Glasses` and asserts the wire, sleeps included.
 */
import { expect, test } from 'bun:test'
import { BudgetError, FlashBudget, fingerprint, memoryStore } from './budget.js'
import * as content from './content.js'
import * as dats from './dats.js'
import { COLS, Grid, ROWS } from './display.js'
import { MockTransport, datsDevice, reply } from './mock-transport.js'
import * as pl from './playlist.js'
import * as p from './protocol.js'
import { Glasses } from './session.js'

const DEVICE = 'GLASSES-TEST'

const block = (cols: number, level = 3): content.Bitmap =>
  Array.from({ length: ROWS }, () => new Array(cols).fill(level))

const scroll = (speed = 50, dir: 0 | 1 = 0): content.Motion => ({
  kind: 'scroll',
  dir,
  speed,
})

/** A steppable clock, so the budget's 3s interval is a decision and not a race. */
function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, step: (ms: number) => (t += ms) }
}

/** A raw entry, for the layout tests that care about exact widths. */
const entry = (
  label: string,
  bitmap: content.Bitmap,
  motion: content.Motion,
  gap?: number,
): pl.Entry => ({ label, bitmap, motion, ...(gap === undefined ? {} : { gap }) })

/**
 * Opcode plus arguments, as a string.
 *
 * Not `mock-transport.opcodeOf`, which splits on the first non-uppercase byte and
 * so reads `SPEED 70` as the opcode `SPEEDF`: 70 is `F`. Every opcode a `Cycler`
 * sends is in this list, so matching against it cannot be fooled by an argument.
 */
const OPCODES = ['SPEED', 'MODE', 'SMVEW', 'LEDON', 'CLRL', 'DATS', 'DATCP']

const describeFrame = (frame: Uint8Array): string => {
  const body = [...p.body(frame)]
  const text = String.fromCharCode(...body)
  const op = OPCODES.find((o) => text.startsWith(o)) ?? text
  return [op, ...body.slice(op.length)].join(' ')
}

/**
 * A driver that records, whose `save` is `Glasses.save` over a mock device.
 *
 * `refuse` answers ERROR to the opening `DATS`, which is the reply a real device
 * gives to an over-long payload: the handshake stops before `DATCP`, so no erases
 * are spent and nothing is resident afterwards.
 */
async function harness(opts: { refuse?: boolean; fail?: boolean } = {}) {
  const transport = opts.refuse ? new MockTransport() : datsDevice({ fail: opts.fail })
  if (opts.refuse) transport.answer = () => [reply('ERROR')]
  const tick = clock()
  const store = memoryStore()
  const budget = new FlashBudget(store, tick.now)
  const glasses = await Glasses.attach(transport, DEVICE, { pacing: 0, budget })

  const log: string[] = []
  const grids: Grid[] = []
  const driver: pl.Driver = {
    begin: async () => {
      log.push('begin')
    },
    show: async (grid) => {
      grids.push(grid.clone())
      log.push('show')
      return COLS
    },
    command: async (frame) => {
      log.push(describeFrame(frame))
    },
    save: async (bitmap, saveOpts) => {
      const result = await glasses.save(bitmap, { ...saveOpts, blockSleep: 0 })
      log.push(`save:${result.status}`)
      return result
    },
  }
  const datsCount = () => transport.commands.filter((c) => c === 'DATS').length
  return { transport, glasses, driver, log, grids, tick, store, datsCount }
}

// --- entries ---

test('a text entry leaves the gap to compile, whatever content.text defaults to', () => {
  const motion = scroll()
  const made = pl.textEntry('msg', 'HELLO THERE', motion)
  const bare = content.text('HELLO THERE', motion, { gap: 0 })

  expect(content.width(made.bitmap)).toBe(content.width(bare.bitmap))
  // Undefined rather than 0: the compiler's default applies, and a gap the entry
  // carried would be a second one on top of content.text's.
  expect(made.gap).toBeUndefined()
  expect(made.bitmap).toHaveLength(ROWS)
})

test('a static text entry is padded to the panel and stays static', () => {
  const made = pl.textEntry('hi', 'HI')
  expect(content.width(made.bitmap)).toBe(COLS)
  expect(made.motion).toEqual({ kind: 'static' })
  expect(pl.isScroll(made)).toBe(false)
})

test('an image entry keeps its grey: the live route shows all four levels', () => {
  const grid = new Grid()
  grid.set(3, 5, 1)
  grid.set(4, 6, 2)
  const made = pl.imageEntry('face', grid)

  expect(content.width(made.bitmap)).toBe(COLS)
  expect(made.bitmap[3][5]).toBe(1)
  expect(made.bitmap[4][6]).toBe(2)
  expect(pl.routeFor(made.motion)).toBe('live')
})

test('a loop entry asks for no gap, so its seam is not turned into a dark pass', () => {
  const made = pl.loopEntry('bars', block(64), { speed: 40, dir: 1 })
  expect(made.gap).toBe(0)
  expect(made.motion).toEqual({ kind: 'scroll', dir: 1, speed: 40 })
  expect(content.width(made.bitmap)).toBe(64)
})

// --- check ---

const okPlaylist = (): pl.Entry[] => [
  pl.textEntry('hi', 'HI'),
  pl.textEntry('msg', 'HELLO', scroll()),
]

test('a valid playlist has nothing wrong with it', () => {
  expect(pl.check(okPlaylist())).toEqual([])
})

test('the count is bounded at both ends', () => {
  const one = [pl.textEntry('hi', 'HI')]
  expect(pl.check(one)[0]).toContain('2 to 10 items')

  const eleven = Array.from({ length: 11 }, (_, i) => pl.textEntry(`i${i}`, 'HI'))
  expect(pl.check(eleven)[0]).toContain('2 to 10 items')
  expect(pl.check(eleven.slice(0, 10))).toEqual([])
})

test('a static wider than the panel is refused, because live drops column 24', () => {
  const wide = entry('wide', block(30), { kind: 'static' })
  const problems = pl.check([wide, pl.textEntry('hi', 'HI')])
  expect(problems).toHaveLength(1)
  expect(problems[0]).toContain('item 1 (wide)')
  expect(problems[0]).toContain('24 columns')
})

test('a speed outside the SPEED ladder is refused', () => {
  const bad = entry('fast', block(40), scroll(101))
  expect(pl.check([bad, pl.textEntry('hi', 'HI')])[0]).toContain('speed must be 0 to 100')
})

test('a bitmap that is not the panel shape is named with its item', () => {
  const short = entry('short', [[1], [1], [1], [1], [1]], { kind: 'static' })
  expect(pl.check([short, pl.textEntry('hi', 'HI')])[0]).toContain('item 1 (short): ')
})

test('a reel past the type 1 ceiling is refused; individual mode is the way out', () => {
  const items = [
    pl.loopEntry('a', block(300)),
    pl.loopEntry('b', block(300)),
    pl.loopEntry('c', block(300)),
  ]
  const problems = pl.check(items)
  expect(problems).toHaveLength(1)
  expect(problems[0]).toContain('900 columns')
  expect(problems[0]).toContain(`${content.MAX_SAVED_COLUMNS}`)
  // Each member fits on its own; it is only the packing that does not.
  expect(pl.check(items, { mode: 'individual' })).toEqual([])
})

test('a gap counts against the ceiling in individual mode too', () => {
  // The member itself fits; it is the gap saved alongside it that does not.
  const items = [
    entry('long', block(content.MAX_SAVED_COLUMNS), scroll()),
    pl.textEntry('hi', 'HI'),
  ]
  expect(pl.check(items, { mode: 'individual' })).toHaveLength(1)
  expect(pl.check(items, { mode: 'individual' })[0]).toContain('764 columns')
  // With no gap of its own it is exactly the ceiling, and it passes.
  items[0] = entry('long', block(content.MAX_SAVED_COLUMNS), scroll(), 0)
  expect(pl.check(items, { mode: 'individual' })).toEqual([])
})

test('reel members must agree on speed and dir: one MODE covers them all', () => {
  const items = [
    pl.loopEntry('a', block(64), { speed: 40 }),
    pl.loopEntry('b', block(64), { speed: 90 }),
    pl.loopEntry('c', block(64), { speed: 40, dir: 1 }),
  ]
  const problems = pl.check(items)
  expect(problems).toHaveLength(2)
  expect(problems[0]).toContain('item 2 (b)')
  expect(problems[1]).toContain('item 3 (c)')
  expect(problems[0]).toContain("mode 'individual'")
  expect(pl.check(items, { mode: 'individual' })).toEqual([])
})

test('a negative gap is refused wherever it came from', () => {
  const items = okPlaylist()
  expect(pl.check(items, { gap: -1 })[0]).toContain('whole number of columns')
  const own = entry('a', block(40), scroll(), -2)
  expect(pl.check([own, items[0]])[0]).toContain('item 1 (a): gap must be')
})

/**
 * A `Mode` that is neither, which is what a persisted playlist can hand back.
 *
 * Every rule in `check` is per mode, so an unrecognised one used to skip the reel's
 * ceiling and its one-SPEED rule, report nothing wrong, and then compile into a
 * scrolling step with no reel behind it: `null is not an object`, three frames deep.
 */
test('a mode that is neither reel nor individual is named, not crashed into', () => {
  const items = [
    pl.textEntry('a', 'HI'),
    pl.loopEntry('b', block(400)),
    pl.loopEntry('c', block(400)),
  ]
  const bogus = { mode: 'Individual' as pl.Mode }

  expect(pl.check(items, bogus)[0]).toContain("mode must be 'reel' or 'individual'")
  expect(() => pl.compile(items, bogus)).toThrow("mode must be 'reel' or 'individual'")
  // The same items in a real mode: 800 columns of reel is the refusal that was skipped.
  expect(pl.check(items)[0]).toContain('800 columns')
})

// --- compile ---

test('scrollers collapse into one reel step, where the first of them sat', () => {
  const items = [
    pl.textEntry('face', 'HI'),
    pl.textEntry('one', 'ONE', scroll()),
    pl.imageEntry('dot', new Grid().set(4, 4, 3)),
    pl.textEntry('two', 'TWO', scroll()),
  ]
  const plan = pl.compile(items)

  expect(plan.steps.map((s) => s.kind)).toEqual(['live', 'reel', 'live'])
  expect(plan.steps[1].entries).toEqual([1, 3])
  expect(plan.steps[1].label).toBe('one / two')
  expect(plan.steps[0].reel).toBeNull()
  expect(plan.steps[1].reel).toBe(plan.reel)
  expect(plan.reel!.members).toEqual([1, 3])
})

test('individual mode is one step per entry, each with its own save', () => {
  const items = [
    pl.textEntry('face', 'HI'),
    pl.textEntry('one', 'ONE', scroll()),
    pl.textEntry('two', 'TWO', scroll()),
  ]
  const plan = pl.compile(items, { mode: 'individual' })

  expect(plan.steps.map((s) => s.kind)).toEqual(['live', 'saved', 'saved'])
  expect(plan.reel).toBeNull()
  const hashes = plan.steps.slice(1).map((s) => s.reel!.hash)
  expect(hashes[0]).not.toBe(hashes[1])
})

test('a playlist with nothing scrolling has no reel at all', () => {
  const plan = pl.compile([pl.textEntry('a', 'HI'), pl.textEntry('b', 'YO')])
  expect(plan.reel).toBeNull()
  expect(plan.steps.map((s) => s.kind)).toEqual(['live', 'live'])
})

test('the reel packs members in order with a gap after each', () => {
  const plan = pl.compile([
    entry('a', block(10), scroll(), 4),
    entry('b', block(6), scroll(), 4),
  ])
  const reel = plan.reel!

  expect(reel.columns).toBe(24)
  expect(content.width(reel.bitmap)).toBe(reel.columns)
  expect(reel.offsets).toEqual([0, 14])
  const row = reel.bitmap[4]
  expect(row.slice(0, 10)).toEqual(new Array(10).fill(1))
  expect(row.slice(10, 14)).toEqual(new Array(4).fill(0))
  expect(row.slice(14, 20)).toEqual(new Array(6).fill(1))
  expect(row.slice(20, 24)).toEqual(new Array(4).fill(0))
})

test('an entry gap of its own beats the default, which is how a loop butts on', () => {
  const plan = pl.compile([
    pl.loopEntry('loop', block(16)),
    entry('text', block(8), scroll()),
  ])
  expect(plan.reel!.columns).toBe(16 + 0 + 8 + pl.REEL_GAP)
  expect(plan.reel!.offsets).toEqual([0, 16])
  expect(pl.reelColumns(plan.entries, [0, 1])).toBe(plan.reel!.columns)
})

test('statics take no room in the reel', () => {
  const plan = pl.compile([
    pl.imageEntry('dot', new Grid().set(0, 0, 3)),
    entry('a', block(10), scroll(), 0),
  ])
  expect(plan.reel!.columns).toBe(10)
  expect(plan.reel!.members).toEqual([1])
})

test('the reel is flattened to monochrome and says so', () => {
  const grey = pl.compile([
    entry('grey', block(32, 2), scroll(), 0),
    entry('lit', block(8), scroll(), 0),
  ])
  expect(grey.reel!.flattened).toBe(true)
  const mono = grey.reel!.bitmap.every((row) => row.every((v) => v === 0 || v === 1))
  expect(mono).toBe(true)
  expect(grey.steps[0].flattened).toBe(true)

  const lit = pl.compile([
    entry('a', block(8), scroll(), 0),
    entry('b', block(8), scroll(), 0),
  ])
  expect(lit.reel!.flattened).toBe(false)
})

test('a live step is never marked flattened, because the live route keeps grey', () => {
  const plan = pl.compile([
    pl.imageEntry('grey', new Grid().set(4, 4, 1)),
    pl.textEntry('msg', 'HELLO', scroll()),
  ])
  expect(plan.steps[0].flattened).toBe(false)
})

test('compile throws what check reports', () => {
  expect(() => pl.compile([pl.textEntry('only', 'HI')])).toThrow('2 to 10 items')
})

test('the reel hash is exactly what the ledger records for that save', async () => {
  const h = await harness()
  const plan = pl.compile([
    pl.textEntry('msg', 'HELLO THERE', scroll()),
    pl.loopEntry('bars', block(64)),
  ])
  const reel = plan.reel!

  const result = await h.glasses.save(reel.bitmap, {
    blockSleep: 0,
    type: dats.TYPE_TEXT,
  })
  expect(result.status).toBe('saved')

  const ledger = await h.glasses.ledger()
  expect(ledger.recent.at(-1)!.hash).toBe(reel.hash)
  expect(pl.residentHash(ledger)).toBe(reel.hash)
})

// --- cycler ---

/** Statics only differ in one column, so a diffing show has something to skip. */
const twoStatics = (): pl.Entry[] => [
  pl.imageEntry('a', new Grid().set(4, 4, 3)),
  pl.imageEntry('b', new Grid().set(4, 4, 3).set(4, 5, 3)),
]

/** A static then a scroller: the smallest playlist that uses both routes. */
const staticThenScroll = (speed = 50): pl.Entry[] => [
  pl.textEntry('a', 'HI'),
  pl.textEntry('msg', 'HELLO', scroll(speed)),
]

test('the first live step begins, and a second one does not', async () => {
  const h = await harness()
  const c = new pl.Cycler(h.driver, pl.compile(twoStatics()))

  await c.next()
  await c.next()

  expect(h.log).toEqual(['begin', 'show', 'show'])
  expect(c.panel).toBe('live')
  expect(c.index).toBe(1)
})

test('a live step is masked at the window, so no write aims at a dead LED', async () => {
  const h = await harness()
  const lit = entry('all', block(COLS), { kind: 'static' })
  const c = new pl.Cycler(h.driver, pl.compile([lit, pl.textEntry('b', 'HI')]))

  await c.next()

  const grid = h.grids[0]
  // The middle six of the top row have no LEDs behind them, and neither has the
  // nose notch. alive() maps both, and viewport applies it at the window.
  expect(grid.get(8, 12)).toBe(0)
  expect(grid.get(1, 12)).toBe(0)
  expect(grid.get(4, 12)).toBe(3)
})

test('a scrolling step saves once, then SPEED and MODE in that order', async () => {
  const h = await harness()
  const plan = pl.compile(staticThenScroll(70))
  const c = new pl.Cycler(h.driver, plan)

  await c.next()
  const result = await c.next()

  expect(h.log).toEqual(['begin', 'show', 'save:saved', 'SPEED 70', 'MODE 2 0'])
  expect(result.cost).toBe('save')
  expect(c.resident).toBe(plan.reel!.hash)
  expect(c.panel).toBe('mode')
})

test('the MODE direction comes from the reel members', async () => {
  const h = await harness()
  const plan = pl.compile([
    pl.loopEntry('a', block(64), { dir: 1 }),
    pl.textEntry('b', 'HI'),
  ])
  await new pl.Cycler(h.driver, plan).next()
  expect(h.log).toEqual(['save:saved', 'SPEED 50', 'MODE 2 1'])
})

test('back to a live step begins again, because MODE discarded the buffer', async () => {
  const h = await harness()
  const plan = pl.compile(staticThenScroll())
  const c = new pl.Cycler(h.driver, plan)

  await c.next()
  await c.next()
  await c.next()

  expect(h.log).toEqual([
    'begin',
    'show',
    'save:saved',
    'SPEED 50',
    'MODE 2 0',
    'begin',
    'show',
  ])
  expect(c.index).toBe(0)
})

/**
 * `forget()`, which exists because the panel can be taken without this class
 * sending anything: a built-in from a screen, a spray, or the firmware's own
 * short-press `set_mode` when `jgx.BTN.SUPPRESS_CYCLE` is not in force (`press.ts`).
 */
test('forget makes the next live step begin again, not diff at a built-in', async () => {
  const h = await harness()
  const c = new pl.Cycler(h.driver, pl.compile(twoStatics()))

  await c.next()
  expect(c.panel).toBe('live')
  c.forget()
  expect(c.panel).toBe('unknown')
  await c.next()

  expect(h.log).toEqual(['begin', 'show', 'begin', 'show'])
})

test('forget leaves residency alone: a built-in takes the panel, not flash', async () => {
  const h = await harness()
  const plan = pl.compile(staticThenScroll())
  const c = new pl.Cycler(h.driver, plan)

  await c.next()
  await c.next()
  c.forget()
  const again = await c.show(1)

  expect(c.resident).toBe(plan.reel!.hash)
  expect(again).toMatchObject({ cost: 'free', showing: true })
  expect(again.save).toBeUndefined()
  expect(h.datsCount()).toBe(1)
})

test('revisiting the resident reel writes nothing at all', async () => {
  const h = await harness()
  const plan = pl.compile(staticThenScroll())
  const c = new pl.Cycler(h.driver, plan)

  await c.next()
  await c.next()
  await c.next()
  const again = await c.next()

  expect(again.cost).toBe('free')
  expect(again.save).toBeUndefined()
  expect(h.datsCount()).toBe(1)
})

/**
 * The defect `notes/playlist.md` recorded, and the fix that outgrew this module.
 *
 * `budget.allow()` used to compare the last acknowledged save of ANY type, and the
 * device has two stores: one type 2 save from a drawing screen was enough to make the
 * reel look like new content, so a cycler leaning on the budget's duplicate check
 * would have spent five real page erases putting back what was already there. Track
 * 32 gave `SaveRecord` its DATS type, so the guard now looks straight through the
 * drawing to the reel underneath. The cycler's own bookkeeping is checked here as
 * before: what it still buys is never issuing the `DATS` at all.
 */
test('a type 2 save between reel visits does not make the reel look new', async () => {
  const h = await harness()
  const plan = pl.compile(staticThenScroll())
  const c = new pl.Cycler(h.driver, plan)

  await c.next()
  expect((await c.next()).cost).toBe('save')

  // The half that makes the interleave below mean anything: with the reel as the last
  // acknowledged save, the budget's own duplicate check is what would have caught a
  // second one, and it is checked before the interval rule so it answers on its own.
  const guarded = new FlashBudget(h.store, h.tick.now)
  expect(await guarded.allow(DEVICE, plan.reel!.hash)).toBe(false)

  // What a drawing screen does: greyscale, no flash, but the newest ledger record.
  h.tick.step(5000)
  await h.glasses.save(block(COLS, 2), { blockSleep: 0, type: dats.TYPE_IMAGE })

  await c.next()
  const again = await c.next()

  expect(again.cost).toBe('free')
  expect(again.save).toBeUndefined()
  expect(c.resident).toBe(plan.reel!.hash)
  // Two DATS on the wire: the reel once, and the drawing. Not the reel twice.
  expect(h.datsCount()).toBe(2)

  // And the budget on its own now agrees, where it used to clear that second reel save
  // as new content. It is the same ledger and the same hash: the difference is that
  // every record says which store it hit, so the type 2 one is looked through rather
  // than treated as the last word on the flash store.
  h.tick.step(5000)
  const informed = new FlashBudget(h.store, h.tick.now)
  expect(await informed.allow(DEVICE, plan.reel!.hash)).toBe(false)
})

test('individual mode really does re-save, which is why it is opt-in', async () => {
  const h = await harness()
  const plan = pl.compile(
    [pl.loopEntry('a', block(64)), pl.loopEntry('b', block(32))],
    { mode: 'individual' },
  )
  const c = new pl.Cycler(h.driver, plan)

  await c.next()
  h.tick.step(5000)
  await c.next()
  h.tick.step(5000)
  const back = await c.next()

  expect(back.index).toBe(0)
  expect(back.cost).toBe('save')
  expect(h.datsCount()).toBe(3)
  expect(c.resident).toBe(plan.steps[0].reel!.hash)
})

test('a BudgetError propagates and the cycler does not move or retry', async () => {
  const h = await harness()
  const plan = pl.compile(
    [pl.loopEntry('a', block(64)), pl.loopEntry('b', block(32))],
    { mode: 'individual' },
  )
  const c = new pl.Cycler(h.driver, plan)

  await c.next()
  // No clock step: the second save is inside the 3s interval, which throws.
  await expect(c.next()).rejects.toThrow(BudgetError)

  expect(c.index).toBe(0)
  expect(c.resident).toBe(plan.steps[0].reel!.hash)
  expect(h.log.filter((l) => l.startsWith('SPEED'))).toHaveLength(1)
  expect(h.datsCount()).toBe(1)
})

test('a refused save shows nothing and leaves residency unknown', async () => {
  const h = await harness({ refuse: true })
  const plan = pl.compile(staticThenScroll())
  const c = new pl.Cycler(h.driver, plan)

  await c.next()
  const result = await c.next()

  expect(result.save?.status).toBe('refused')
  // DATCP never went out, so the erases were never spent.
  expect(result.cost).toBe('free')
  expect(result.showing).toBe(false)
  expect(c.resident).toBeNull()
  expect(h.log).toEqual(['begin', 'show', 'save:refused'])
  expect(c.index).toBe(1)
})

/**
 * The other half of `refused`, and the one that is not visible from the status.
 *
 * `session.save()` answers `saved` for any `DATCP` it managed to send, so a dropped
 * block or a lost notify comes back as `saved` with `ERROR` or `TIMEOUT`. The erases
 * were spent and `DATS` zeroed the store, so nothing is resident: a cycler that read
 * the status alone would call every later visit free and leave the panel blank with
 * no save left to repair it.
 */
test('a DATCP the device did not acknowledge leaves residency unknown', async () => {
  const h = await harness({ fail: true })
  const plan = pl.compile(staticThenScroll())
  const c = new pl.Cycler(h.driver, plan)

  await c.next()
  const result = await c.next()

  expect(result.save?.status).toBe('saved')
  expect(result.save?.reply).toBe('ERROR')
  // The erases went out, so the press did cost one.
  expect(result.cost).toBe('save')
  expect(c.resident).toBeNull()
  // Which is what the ledger says too, and the two must not disagree.
  expect(pl.residentHash(await h.glasses.ledger())).toBeNull()

  // So the next visit tries again rather than showing nothing for ever.
  h.tick.step(5000)
  await c.next()
  expect((await c.next()).cost).toBe('save')
  expect(h.datsCount()).toBe(2)
})

/**
 * The half of that defect the assertions above could not see, found by review-32.
 *
 * Residency was already right; the wire was not. `Cycler` withheld `MODE` on
 * `refused` alone, so an `ERROR` fell through to `SPEED` then `MODE` and switched
 * the panel to a store the same `DATS` had just zeroed - the identical defect track
 * 32 fixed in `app/src/deliver.ts`, left standing in the file the same track owned.
 * The test above passed throughout, because it never looked at the log.
 */
test('a commit answered ERROR sends neither SPEED nor MODE', async () => {
  const h = await harness({ fail: true })
  const c = new pl.Cycler(h.driver, pl.compile(staticThenScroll()))

  await c.next()
  const result = await c.next()

  expect(h.log).toEqual(['begin', 'show', 'save:saved'])
  expect(result.showing).toBe(false)
  // The live buffer was never taken, so the next still diffs against it rather than
  // beginning again over a panel it would have to redraw in full.
  expect(c.panel).toBe('live')
})

/**
 * `ERROR` is one reply of several. A dropped link answers nothing at all and
 * `session.save()` turns that into `TIMEOUT`, which is the same situation and the
 * likelier one in a field. Driven through a stub rather than a silent mock so the
 * rule is pinned for every non-`DATCPOK` reply without a five-second wait.
 */
test('a commit that timed out sends neither SPEED nor MODE', async () => {
  const log: string[] = []
  const driver: pl.Driver = {
    begin: async () => {
      log.push('begin')
    },
    show: async () => {
      log.push('show')
      return COLS
    },
    command: async (frame) => {
      log.push(describeFrame(frame))
    },
    save: async () => {
      log.push('save')
      return { status: 'saved', reply: 'TIMEOUT', committed: false, saves: 1 }
    },
  }
  const c = new pl.Cycler(driver, pl.compile(staticThenScroll()))

  await c.next()
  const result = await c.next()

  expect(log).toEqual(['begin', 'show', 'save'])
  expect(result).toMatchObject({ cost: 'save', showing: false })
  expect(c.resident).toBeNull()
})

/** The three ways a press does reach the panel, so `showing` is not just always false. */
test('showing is true for a live step, a committed reel and a resident one', async () => {
  const h = await harness()
  const plan = pl.compile(staticThenScroll())
  const c = new pl.Cycler(h.driver, plan)

  expect((await c.next()).showing).toBe(true)
  const committed = await c.next()
  expect(committed).toMatchObject({ cost: 'save', showing: true })

  const back = new pl.Cycler(h.driver, plan, { resident: plan.reel!.hash })
  expect(await back.show(1)).toMatchObject({ cost: 'free', showing: true })
})

test('a seeded resident hash makes the first visit free', async () => {
  const h = await harness()
  const plan = pl.compile(staticThenScroll())
  const c = new pl.Cycler(h.driver, plan, { resident: plan.reel!.hash })

  expect(c.costOf(1)).toBe('free')
  const result = await c.show(1)

  expect(result.cost).toBe('free')
  expect(h.log).toEqual(['SPEED 50', 'MODE 2 0'])
  expect(h.datsCount()).toBe(0)
})

test('costOf states the cost before the press, and costs() lists them', async () => {
  const h = await harness()
  const plan = pl.compile(staticThenScroll())
  const c = new pl.Cycler(h.driver, plan)

  expect(c.costs()).toEqual(['free', 'save'])
  await c.next()
  await c.next()
  expect(c.costs()).toEqual(['free', 'free'])
})

test('cycling wraps both ways', async () => {
  const h = await harness()
  const c = new pl.Cycler(h.driver, pl.compile(twoStatics()))

  expect(c.index).toBe(-1)
  expect(c.current).toBeNull()
  expect((await c.prev()).index).toBe(1)
  expect((await c.next()).index).toBe(0)
  expect((await c.prev()).index).toBe(1)
  expect(c.current).toBe(c.plan.steps[1])
})

test('upcoming says where a press lands, so its cost can be stated first', async () => {
  const h = await harness()
  const plan = pl.compile(staticThenScroll())
  const c = new pl.Cycler(h.driver, plan)

  // Unstarted: forward is the first step, back is the last.
  expect(c.upcoming).toEqual({ next: 0, prev: 1 })
  expect(c.costOf(c.upcoming.prev)).toBe('save')
  await c.next()
  expect(c.upcoming).toEqual({ next: 1, prev: 1 })
  await c.next()
  expect(c.upcoming).toEqual({ next: 0, prev: 0 })
})

test('showing a step that does not exist wraps rather than throwing', async () => {
  const h = await harness()
  const c = new pl.Cycler(h.driver, pl.compile(twoStatics()))
  expect((await c.show(7)).index).toBe(1)
})

// --- residency across sessions ---

test('residentHash answers over the type 1 store, and only if it succeeded', () => {
  const base = { columns: 10, hash: 'aa:20', ok: true, type: dats.TYPE_TEXT }
  expect(pl.residentHash({ ...emptyLedger(), recent: [] })).toBeNull()
  expect(
    pl.residentHash({ ...emptyLedger(), recent: [{ at: 1, ...base }] }),
  ).toBe('aa:20')
  // A failed save still spent its erases, so the older match is not evidence that
  // anything is still there.
  expect(
    pl.residentHash({
      ...emptyLedger(),
      recent: [
        { at: 1, ...base },
        { at: 2, ...base, hash: 'bb:20', ok: false },
      ],
    }),
  ).toBeNull()
  // A type 2 save writes no flash, so the reel underneath it is still resident. This
  // is the whole of what the type on the record buys, and it used to read as unknown.
  expect(
    pl.residentHash({
      ...emptyLedger(),
      recent: [
        { at: 1, ...base },
        { at: 2, ...base, hash: 'cc:72', type: dats.TYPE_IMAGE },
      ],
    }),
  ).toBe('aa:20')
})

/**
 * The ledgers that already exist, which is most of them.
 *
 * `SaveRecord.type` was added on 2026-08-12 and both real ledgers - this Mac's and the
 * Pixel's - are full of records written before it. Those records cannot say which
 * store they hit, and reading them as type 1 would put an "on the glasses" badge and a
 * free `MODE` route on content nobody can prove is there. Unknown is the answer, and
 * the cost of it is one redundant save at the start of a session.
 */
test('a record with no type reads as unknown, never as type 1', () => {
  const typeless = { at: 1, columns: 10, hash: 'aa:20', ok: true }
  expect(pl.residentHash({ ...emptyLedger(), recent: [typeless] })).toBeNull()
  // Even under one: what happened to the flash store after it is exactly as unknowable.
  expect(
    pl.residentHash({
      ...emptyLedger(),
      recent: [{ ...typeless, type: dats.TYPE_TEXT }, { ...typeless, at: 2, hash: 'bb' }],
    }),
  ).toBeNull()
})

test('a type 2 record cannot be mistaken for a reel', () => {
  const payload = dats.encodeBitmap(block(8))
  expect(fingerprint(payload, dats.TYPE_TEXT)).not.toBe(
    fingerprint(payload, dats.TYPE_IMAGE),
  )
})

function emptyLedger() {
  return { device: DEVICE, lifetime: 0, first: null, last: null, window: [], recent: [] }
}

// --- the whole thing over a real session ---

/**
 * One test that pays `Glasses.command`'s 120ms per command, because the recording
 * driver above cannot show what actually reaches the wire.
 *
 * What it proves that the others cannot: `begin()` is `SMVEW 01` then `LEDON`, a
 * second live step re-sends only the columns that changed, and the scrolling step's
 * `SPEED` and `MODE` land after `DATCP` rather than inside the handshake.
 */
test('the wire, end to end: two statics, a reel, and back to the first', async () => {
  const transport = datsDevice()
  const tick = clock()
  const glasses = await Glasses.attach(transport, DEVICE, {
    pacing: 0,
    budget: new FlashBudget(memoryStore(), tick.now),
  })
  const plan = pl.compile([
    ...twoStatics(),
    pl.textEntry('msg', 'HELLO THERE', scroll(70)),
  ])
  const c = new pl.Cycler(glasses, plan, { save: { blockSleep: 0 } })

  const first = await c.next()
  const second = await c.next()
  await c.next()
  const wrapped = await c.next()

  const opcodes = transport.to(p.CHAR_COMMAND).map((f) => describeFrame(f).split(' ')[0])
  expect(opcodes).toEqual([
    'SMVEW',
    'LEDON',
    'DATS',
    'DATCP',
    'SPEED',
    'MODE',
    'SMVEW',
    'LEDON',
  ])
  // A full frame on entry, one changed column on the second static, a full frame
  // again after MODE discarded the live buffer.
  expect(first.writes).toBe(COLS)
  expect(second.writes).toBe(1)
  expect(wrapped.writes).toBe(COLS)

  const columns = transport.to(p.CHAR_BULK_B)
  expect(columns).toHaveLength(COLS + 1 + COLS)
  expect(columns.every((frame) => frame.length === p.BLOCK_SIZE)).toBe(true)

  const sent = transport.to(p.CHAR_COMMAND)
  const speedFrame = sent.find((f) => describeFrame(f).startsWith('SPEED'))!
  expect([...p.body(speedFrame).subarray(5)]).toEqual([70])
  const modeFrame = sent.find((f) => describeFrame(f).startsWith('MODE'))!
  expect([...p.body(modeFrame).subarray(4)]).toEqual([2, 0])

  const payload = dats.encodeBitmap(plan.reel!.bitmap)
  const blocks = transport.to(p.CHAR_BULK_A)
  expect(blocks).toHaveLength(Math.ceil(payload.length / dats.CHUNK_PAYLOAD))
  const rebuilt = blocks.flatMap((b) => [...b.subarray(1, 1 + b[0])])
  expect(rebuilt).toEqual([...payload])
}, 15000)
