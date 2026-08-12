/**
 * The spray, against a mock field of pairs.
 *
 * Three properties carry the feature and none of them is checked by eye:
 *
 *  1. **It cannot write flash.** The mock pair has a `save` and a `live` that fail the
 *     test if anything reaches for them, and the bottom of this file crawls `spray.ts`
 *     for every identifier that could open a save or import a module that can. A comment
 *     saying "no flash" is not a safety property; this is.
 *  2. **Consent is the default.** Your own pairs are left alone unless marked, an
 *     explicit refusal outranks every other rule, and a pair that has shown the picture
 *     is not pushed again.
 *  3. **No platform handle leaves the module.** Every event is crawled for an `id`,
 *     because a MAC on a screen is the one privacy rule this app has.
 *
 * React is absent as everywhere else in this package: react-native does not import under
 * bun, so what the screen renders is checked on the handset and the policy, the pass
 * structure and the wording are checked here.
 */
import { Grid, display, protocol as p } from '@joggles/core'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { BUILTINS } from './builtins.js'
import {
  type Advert,
  type SprayDeps,
  type SprayEvent,
  type SprayPolicy,
  type SprayRun,
  TIMING,
  builtinPayload,
  createSprayMemory,
  decide,
  gridFor,
  reviveSpray,
  runSpray,
  skipWords,
  stillPayload,
} from './spray.js'

const STRANGER = 'GLASSES-AABBCC'
const OTHER = 'GLASSES-DDEEFF'
const CREW = `${p.CREW_NAME_PREFIX}112233`

const policy = (over: Partial<SprayPolicy> = {}): SprayPolicy => ({
  never: new Set(),
  always: new Set(),
  ours: new Set(),
  done: new Map(),
  ...over,
})

/** A 9x24 bitmap at one level, so a still is easy to reason about. */
const solid = (level = 3, cols = display.COLS): number[][] =>
  Array.from({ length: display.ROWS }, () => Array.from({ length: cols }, () => level))

const dark = (): number[][] =>
  Array.from({ length: display.ROWS }, () => Array.from({ length: display.COLS }, () => 0))

const still = (bitmap = solid(), label = 'a picture') => {
  const payload = stillPayload(bitmap, label)
  if (payload === null) throw new Error('the fixture is not lit')
  return payload
}

/**
 * A pair that records what it was told, and fails loudly on what it must never be told.
 *
 * `save` and `live` are not on `SprayPair` at all, so this is belt and braces: if the
 * driver ever grew a cast, the throw is what turns a silent flash write into a red test.
 */
class MockPair {
  began = 0

  frames: Grid[] = []

  full: boolean[] = []

  commands: Uint8Array[] = []

  ended: string[] = []

  async begin(): Promise<void> {
    this.began += 1
  }

  async show(grid: Grid, full = false): Promise<number> {
    this.frames.push(grid)
    this.full.push(full)
    return display.COLS
  }

  async command(frame: Uint8Array): Promise<void> {
    this.commands.push(frame)
  }

  async end(mode = 'keep'): Promise<void> {
    this.ended.push(mode)
  }

  async save(): Promise<never> {
    throw new Error('a spray opened a save')
  }

  live(): never {
    throw new Error('a spray built a LiveSender')
  }
}

/** Everything in range, and a record of what the driver did about it. */
class Field {
  adverts: Advert[] = []

  opened: string[] = []

  pairs = new Map<string, MockPair>()

  refuse = new Set<string>()

  stops = 0

  slept: number[] = []

  scans = 0

  deps(): SprayDeps {
    return {
      scan: async (onFound) => {
        this.scans += 1
        for (const advert of this.adverts) onFound(advert)
      },
      stop: async () => {
        this.stops += 1
      },
      open: async (advert) => {
        this.opened.push(advert.name)
        if (this.refuse.has(advert.name)) throw new Error('held by another app')
        const pair = new MockPair()
        this.pairs.set(advert.name, pair)
        return pair
      },
      // Immediate, so a test drives whole passes without waiting for one.
      sleep: async (ms) => {
        this.slept.push(ms)
      },
    }
  }
}

const advert = (name: string): Advert => ({ id: `handle:${name}`, name })

/**
 * Run until the start of pass `until`, then stop. Resolves with the events and the tally.
 *
 * The stop is asked for from inside the event callback rather than on a timer: the pass
 * counter is the only clock this driver has, and a wall-clock stop would race the drain.
 */
async function sprayFor(
  field: Field,
  payload: ReturnType<typeof still> | ReturnType<typeof builtinPayload>,
  live: () => SprayPolicy,
  until = 2,
  timing = {},
) {
  const events: SprayEvent[] = []
  const holder: { run: SprayRun | null } = { run: null }
  holder.run = runSpray(
    field.deps(),
    payload,
    live,
    (event) => {
      events.push(event)
      if (event.kind === 'pass' && event.n >= until) holder.run?.stop()
    },
    timing,
  )
  const tally = await holder.run.done
  return { events, tally }
}

const named = (events: SprayEvent[], kind: SprayEvent['kind']): string[] =>
  events.filter((e) => e.kind === kind).map((e) => ('name' in e ? e.name : ''))

test('a stranger with no history is sprayed', () => {
  expect(decide(STRANGER, 'abcd', policy())).toBe('send')
})

test('a pair this phone knows is left alone', () => {
  expect(decide(STRANGER, 'abcd', policy({ ours: new Set([STRANGER]) }))).toBe('ours')
})

test('marking one of yours makes it fair game', () => {
  const marked = policy({ ours: new Set([STRANGER]), always: new Set([STRANGER]) })
  expect(decide(STRANGER, 'abcd', marked)).toBe('send')
})

test('an explicit refusal outranks the mark that would allow it', () => {
  const both = policy({ never: new Set([STRANGER]), always: new Set([STRANGER]) })
  expect(decide(STRANGER, 'abcd', both)).toBe('never')
})

test('a crew pair is skipped, because this app holds no crew key', () => {
  expect(decide(CREW, 'abcd', policy())).toBe('crew')
})

test('a pair already showing this picture is not pushed again', () => {
  const done = policy({ done: new Map([[STRANGER, 'abcd']]) })
  expect(decide(STRANGER, 'abcd', done)).toBe('already')
})

test('changing the picture makes a sprayed pair eligible again', () => {
  const done = policy({ done: new Map([[STRANGER, 'abcd']]) })
  expect(decide(STRANGER, 'ef01', done)).toBe('send')
})

test('a marked pair still gets one push per picture, not one per pass', () => {
  const marked = policy({
    ours: new Set([STRANGER]),
    always: new Set([STRANGER]),
    done: new Map([[STRANGER, 'abcd']]),
  })
  expect(decide(STRANGER, 'abcd', marked)).toBe('already')
})

test('every skip reason has words for a row', () => {
  for (const why of ['never', 'crew', 'already', 'ours'] as const) {
    expect(skipWords[why].length).toBeGreaterThan(0)
  }
})

test('a picture with nothing lit is refused rather than sprayed dark', () => {
  expect(stillPayload(dark(), 'empty')).toBeNull()
})

test('a still is clipped to the panel and masked at the window', () => {
  const payload = still(solid(3, 96))
  expect(payload.kind).toBe('still')
  if (payload.kind !== 'still') return
  expect(payload.frame[0].length).toBe(display.COLS)
  // Row 8 columns 9-14 have no LEDs behind them. A fully lit source must come back with
  // a hole there, or a spray would be drawing pixels that cannot exist.
  expect(payload.frame[8][10]).toBe(0)
  expect(payload.frame[8][0]).toBe(3)
})

test('the same picture hashes the same way and two pictures do not', () => {
  expect(still(solid(3)).hash).toBe(still(solid(3)).hash)
  expect(still(solid(3)).hash).not.toBe(still(solid(1)).hash)
  expect(builtinPayload(BUILTINS[0]).hash).not.toBe(builtinPayload(BUILTINS[1]).hash)
})

test('greys survive the trip to a stranger, because grey costs nothing here', () => {
  const grid = gridFor(solid(2))
  expect(grid.get(2, 0)).toBe(2)
})

test('one pass lights the strangers and leaves your own pairs alone', async () => {
  const field = new Field()
  field.adverts = [advert(STRANGER), advert(OTHER)]
  const { events, tally } = await sprayFor(field, still(), () =>
    policy({ ours: new Set([OTHER]) }),
  )

  expect(named(events, 'lit')).toEqual([STRANGER])
  expect(named(events, 'skipped')).toEqual([OTHER])
  expect(tally.lit).toBe(1)
  expect(tally.skipped).toBe(1)
  expect(field.opened).toEqual([STRANGER])
})

test('a still is one full frame, then the panel is left holding it', async () => {
  const field = new Field()
  field.adverts = [advert(STRANGER)]
  const payload = still(solid(2))
  await sprayFor(field, payload, () => policy())

  const pair = field.pairs.get(STRANGER)
  expect(pair?.began).toBe(1)
  expect(pair?.frames.length).toBe(1)
  expect(pair?.full).toEqual([true])
  expect(pair?.commands).toEqual([])
  // The picture itself, not just that a frame went out: the grid the pair was handed is
  // the payload's own pixels, greys included, and a dead position is dark.
  if (payload.kind !== 'still') throw new Error('the fixture changed shape')
  expect(pair?.frames[0].equals(gridFor(payload.frame))).toBe(true)
  expect(pair?.frames[0].get(2, 0)).toBe(2)
  expect(pair?.frames[0].get(8, 10)).toBe(0)
  // 'keep' and nothing else: leaving DIY would restore whatever the wearer had saved,
  // which is the one outcome that would make a spray look like a fault.
  expect(pair?.ended).toEqual(['keep'])
})

test('a built-in is one command and no DIY at all', async () => {
  const field = new Field()
  field.adverts = [advert(STRANGER)]
  await sprayFor(field, builtinPayload(BUILTINS[0]), () => policy())

  const pair = field.pairs.get(STRANGER)
  expect(pair?.began).toBe(0)
  expect(pair?.commands.length).toBe(1)
  expect(pair?.frames).toEqual([])
})

test('a pair that cannot be reached is reported and not hammered', async () => {
  const field = new Field()
  field.adverts = [advert(STRANGER)]
  field.refuse.add(STRANGER)
  const { events, tally } = await sprayFor(field, still(), () => policy(), 3)

  expect(named(events, 'failed')).toEqual([STRANGER])
  expect(tally.failed).toBe(1)
  // Three passes, one attempt: `handled` is what stops a pair held by its owner's phone
  // being reconnected to every few seconds.
  expect(field.opened).toEqual([STRANGER])
})

test('a lit pair is not pushed again on the next pass, with nothing persisted', async () => {
  const field = new Field()
  field.adverts = [advert(STRANGER)]
  await sprayFor(field, still(), () => policy(), 4)

  expect(field.opened).toEqual([STRANGER])
})

test('the radio rests between passes and is stopped before every connection', async () => {
  const field = new Field()
  field.adverts = [advert(STRANGER)]
  const { events } = await sprayFor(field, still(), () => policy(), 2, { restMs: 4_000 })

  const resting = events.filter((e) => e.kind === 'resting')
  expect(resting).toEqual([{ kind: 'resting', ms: 4_000 }])
  expect(field.slept).toContain(4_000)
  // Two passes scanned, and the scan is stopped at least once per pass plus once on the
  // way out: connecting while scanning is what CoreBluetooth dislikes.
  expect(field.scans).toBe(2)
  expect(field.stops).toBeGreaterThanOrEqual(3)
})

test('the run stops after the pair in flight rather than mid-frame', async () => {
  const field = new Field()
  field.adverts = [advert(STRANGER)]
  const { tally } = await sprayFor(field, still(), () => policy())

  expect(tally.passes).toBe(2)
  expect(field.pairs.get(STRANGER)?.ended).toEqual(['keep'])
})

test('a mark made mid-run is honoured on the next pass', async () => {
  const field = new Field()
  field.adverts = [advert(STRANGER), advert(OTHER)]
  const never = new Set<string>()
  const events: SprayEvent[] = []
  const holder: { run: SprayRun | null } = { run: null }
  holder.run = runSpray(
    field.deps(),
    still(),
    () => policy({ never }),
    (event) => {
      events.push(event)
      // Between pass 1 and pass 2, somebody asks to be left alone.
      if (event.kind === 'pass' && event.n === 1) never.add(OTHER)
      if (event.kind === 'pass' && event.n >= 2) holder.run?.stop()
    },
  )
  await holder.run.done

  // OTHER was heard on pass 1 before the mark, so it was lit; the mark is what stops the
  // second push, and nothing here re-pushes a pair anyway. What this proves is that the
  // policy is re-read: a snapshot would never see the new name at all.
  expect(named(events, 'skipped')).toContain(OTHER)
})

test('no event carries a platform handle', async () => {
  const field = new Field()
  field.adverts = [advert(STRANGER), advert(OTHER)]
  field.refuse.add(OTHER)
  const { events } = await sprayFor(field, still(), () => policy())

  expect(events.length).toBeGreaterThan(0)
  for (const event of events) {
    const keys = Object.keys(event)
    expect(keys).not.toContain('id')
    expect(JSON.stringify(event)).not.toContain('handle:')
  }
})

test('the defaults gather for longer than one report interval and rest between passes', () => {
  // ble-plx reports a stationary pair about every 5.12s on Android low power
  // (`proximity.ts`), so a window under that hears nothing at all.
  expect(TIMING.windowMs).toBeGreaterThan(5_120 * 2)
  expect(TIMING.restMs).toBeGreaterThan(0)
})

/** A file that lives in this test, so the store's rules run without a phone. */
function memFile(initial: string | null = null) {
  let held = initial
  return {
    file: { read: () => held, write: (text: string) => void (held = text) },
    text: () => held,
  }
}

test('a mark persists, and a pair is never in both lists', () => {
  const disk = memFile()
  const memory = createSprayMemory(disk.file)

  memory.mark(STRANGER, 'never')
  memory.mark(STRANGER, 'always')
  expect(memory.markOf(STRANGER)).toBe('always')
  expect(memory.marks().never).toEqual([])

  const reopened = createSprayMemory(memFile(disk.text()).file)
  expect(reopened.markOf(STRANGER)).toBe('always')

  memory.mark(STRANGER, null)
  expect(memory.markOf(STRANGER)).toBeNull()
})

test('what has been shown is remembered per payload, and can be forgotten', () => {
  const disk = memFile()
  const memory = createSprayMemory(disk.file)
  memory.mark(OTHER, 'never')
  memory.lit(STRANGER, 'abcd')

  expect(memory.policy(new Set()).done.get(STRANGER)).toBe('abcd')
  expect(decide(STRANGER, 'abcd', memory.policy(new Set()))).toBe('already')
  expect(memory.sprayed()).toBe(1)

  memory.forget()
  expect(memory.sprayed()).toBe(0)
  // The marks are not history: forgetting who has seen a picture must not un-refuse a
  // pair somebody asked to be left out of.
  expect(memory.markOf(OTHER)).toBe('never')
})

test('the sprayed record is bounded, oldest first', () => {
  const disk = memFile()
  let clock = 1
  const memory = createSprayMemory(disk.file, () => clock++)
  for (let i = 0; i < 450; i++) memory.lit(`GLASSES-${i}`, 'abcd')

  expect(memory.sprayed()).toBe(400)
  const done = memory.policy(new Set()).done
  expect(done.has('GLASSES-0')).toBe(false)
  expect(done.has('GLASSES-449')).toBe(true)
})

test('a corrupt or hostile file degrades to empty rather than throwing', () => {
  expect(reviveSpray(null)).toEqual({ never: [], always: [], done: new Map() })
  expect(reviveSpray('nonsense').done.size).toBe(0)
  expect(reviveSpray({ never: [1, '', 'GLASSES-1', 'GLASSES-1'] }).never).toEqual(['GLASSES-1'])
  expect(reviveSpray({ done: { 'GLASSES-1': { hash: 7 } } }).done.size).toBe(0)

  // A pair advertising as `__proto__` writes an entry, never the prototype: review-10's
  // lesson, and the reason `done` is a Map. Through `JSON.parse`, because that is the
  // only path this reaches by and an object literal here would set the prototype rather
  // than the own property the parser produces.
  const hostile = reviveSpray(JSON.parse('{"done":{"__proto__":{"hash":"abcd","at":1}}}'))
  expect(hostile.done.get('__proto__')?.hash).toBe('abcd')
  expect(({} as Record<string, unknown>).hash).toBeUndefined()

  const memory = createSprayMemory({
    read: () => '{ this is not json',
    write: () => {},
  })
  expect(memory.sprayed()).toBe(0)
})

test('a store that cannot write still holds the mark for this sitting', () => {
  const memory = createSprayMemory({
    read: () => null,
    write: () => {
      throw new Error('no writable storage')
    },
  })
  memory.mark(STRANGER, 'never')
  expect(memory.markOf(STRANGER)).toBe('never')
})

const source = readFileSync(resolve(dirname(import.meta.path), 'spray.ts'), 'utf8')

/**
 * The source with its comments stripped, which is what the crawls below read.
 *
 * The docblock has to be free to name what the code must not do - "no `DATCP` here" is
 * exactly the sentence a future reader needs - so a crawl over the raw text would make
 * the file's own explanation fail the build.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('the spray names nothing that could write flash', () => {
  // The save path, by every name it goes by. A spray that grew any of these would be
  // spending somebody else's hardware, which is the one thing this feature must not do.
  for (const forbidden of [
    'datsComplete',
    'DATCP',
    'deliver',
    'dats.',
    '.save(',
    'savedType',
    'FlashBudget',
    'flashBudget',
  ]) {
    expect(code).not.toContain(forbidden)
  }
})

test('the spray builds no LiveSender, because the shell owns the only one', () => {
  for (const forbidden of ['LiveSender', 'PanelSession', '.live(']) {
    expect(code).not.toContain(forbidden)
  }
})

test('the spray imports nothing that can reach the save path', () => {
  const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1])
  // `builtins.js` is protocol and generated data; `nicknames.js` is a type only. Both are
  // flash-free, and `one-tap.js`/`deliver.js` are exactly what must not appear here.
  expect(new Set(imports)).toEqual(new Set(['@joggles/core', './builtins.js', './nicknames.js']))
})
