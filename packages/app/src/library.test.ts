import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { content, display, font } from '@joggles/core'
import { Library, revive, search } from './library.js'
import type { LibraryStore, SavedItem, SavedText } from './library.js'

/**
 * A store that round-trips every save through JSON, so what a test reads back is
 * what a file would have kept and not an object the Library still holds by
 * reference. That difference is exactly what the copy-on-the-way-in tests probe.
 */
function memory(initial: unknown = null) {
  let data = initial
  let reads = 0
  const writes: string[] = []
  const store: LibraryStore = {
    async load() {
      reads++
      return data
    },
    async save(items: SavedItem[]) {
      writes.push(JSON.stringify(items))
      data = JSON.parse(writes[writes.length - 1])
    },
  }
  return { store, writes, reads: () => reads, peek: () => data }
}

/** A clock the test controls, one tick per call, so "newest" is unambiguous. */
function ticking(start = 1000) {
  let t = start
  return () => t++
}

const blank = (): content.Bitmap =>
  Array.from({ length: display.ROWS }, () => Array<number>(display.COLS).fill(0))

const dot = (row: number, col: number, level = 3): content.Bitmap => {
  const b = blank()
  b[row][col] = level
  return b
}

const SCROLL: content.Motion = { kind: 'scroll', dir: 1, speed: 50 }

const rawDrawing = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'drawing',
  id: 'd1',
  name: 'x',
  at: 5,
  levels: blank(),
  ...over,
})

const rawText = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'text',
  id: 't1',
  name: 'x',
  at: 6,
  text: 'HI',
  motion: { kind: 'scroll', dir: 0, speed: 50 },
  ...over,
})

describe('Library', () => {
  test('saves a drawing and a text preset, newest first', async () => {
    const lib = new Library(memory().store, ticking())
    await lib.saveDrawing(dot(2, 3))
    const preset = await lib.saveText('JOGGLES', SCROLL)

    const all = await lib.all()
    expect(all.map((i) => i.kind)).toEqual(['text', 'drawing'])
    expect(all[0].id).toBe(preset.id)
    expect(all[0].name).toBe('JOGGLES')
    expect(all[0]).toMatchObject({ text: 'JOGGLES', motion: SCROLL })
    expect((all[1] as { levels: content.Bitmap }).levels[2][3]).toBe(3)
  })

  test('copies the canvas on the way in', async () => {
    const lib = new Library(memory().store, ticking())
    const canvas = dot(4, 4)
    const saved = await lib.saveDrawing(canvas)
    canvas[4][4] = 0

    const kept = (await lib.get(saved.id)) as { levels: content.Bitmap }
    expect(kept.levels[4][4]).toBe(3)
  })

  test('hands back copies, so a screen cannot edit what is held', async () => {
    const lib = new Library(memory().store, ticking())
    const saved = await lib.saveDrawing(dot(3, 7))

    const first = (await lib.get(saved.id)) as { levels: content.Bitmap }
    first.levels[3][7] = 0
    const again = (await lib.get(saved.id)) as { levels: content.Bitmap }
    expect(again.levels[3][7]).toBe(3)
  })

  test('clamps drawing levels on the way in', async () => {
    const lib = new Library(memory().store, ticking())
    const saved = await lib.saveDrawing(dot(5, 5, 9))
    const kept = (await lib.get(saved.id)) as { levels: content.Bitmap }
    expect(kept.levels[5][5]).toBe(display.MAX_LEVEL)
  })

  test('refuses a drawing that is not the panel', async () => {
    const lib = new Library(memory().store, ticking())
    expect(lib.saveDrawing(blank().slice(1))).rejects.toThrow('9 rows')
  })

  test('refuses empty text and a malformed motion', async () => {
    const lib = new Library(memory().store, ticking())
    expect(lib.saveText('   ', SCROLL)).rejects.toThrow('empty')
    expect(
      lib.saveText('HI', { kind: 'scroll', dir: 2, speed: 50 } as never),
    ).rejects.toThrow('motion')
  })

  test('names default to the text, and a given name wins', async () => {
    const lib = new Library(memory().store, ticking())
    const plain = await lib.saveText('BASS', { kind: 'static' })
    const named = await lib.saveText('EMMA / SHE', SCROLL, 'badge')
    expect(plain.name).toBe('BASS')
    expect(named.name).toBe('badge')
  })

  test('unnamed drawings number upwards, and a reload keeps counting', async () => {
    const { store } = memory()
    const first = new Library(store, ticking())
    expect((await first.saveDrawing(dot(1, 1))).name).toBe('Drawing 1')
    expect((await first.saveDrawing(dot(2, 2))).name).toBe('Drawing 2')

    const second = new Library(store, ticking(2000))
    expect((await second.saveDrawing(dot(3, 3))).name).toBe('Drawing 3')
  })

  test('a deleted drawing does not hand its number back out', async () => {
    const { store } = memory()
    const lib = new Library(store, ticking())
    const one = await lib.saveDrawing(dot(1, 1))
    await lib.saveDrawing(dot(2, 2))
    await lib.saveDrawing(dot(3, 3))

    // Numbering from a count would call the next save "Drawing 3", which is taken:
    // two rows reading the same in the Draw list cannot be told apart.
    expect(await lib.remove(one.id)).toBe(true)
    expect((await lib.saveDrawing(dot(4, 4))).name).toBe('Drawing 4')
  })

  test('numbering wants the whole name, and counts text presets too', async () => {
    const { store } = memory()
    const lib = new Library(store, ticking())
    await lib.saveDrawing(dot(1, 1), 'Drawing 7 of 9')
    await lib.saveText('HI', SCROLL, 'Drawing 12')
    // "Drawing 7 of 9" is a title, not number 7. The preset counts because one list
    // shows both kinds, so a duplicate there is as confusing as one between drawings.
    expect((await lib.saveDrawing(dot(2, 2))).name).toBe('Drawing 13')
  })

  test('survives a restart through the store', async () => {
    const { store } = memory()
    const first = new Library(store, ticking())
    const drawing = await first.saveDrawing(dot(2, 2), 'smile')
    const preset = await first.saveText('JOGGLES', SCROLL)

    const second = new Library(store, ticking(9999))
    const all = await second.all()
    expect(all.map((i) => i.id)).toEqual([preset.id, drawing.id])
    expect(all.map((i) => i.name)).toEqual(['JOGGLES', 'smile'])
  })

  test('ids stay unique after a reload resets the counter', async () => {
    const { store } = memory()
    const first = new Library(store, ticking())
    const a = await first.saveDrawing(dot(1, 1))
    const b = await first.saveDrawing(dot(2, 2))

    const second = new Library(store, ticking(2000))
    const c = await second.saveDrawing(dot(3, 3))
    expect(new Set([a.id, b.id, c.id]).size).toBe(3)
  })

  test('rename persists and says when it did nothing', async () => {
    const { store, writes } = memory()
    const lib = new Library(store, ticking())
    const saved = await lib.saveText('HI', SCROLL)

    expect(await lib.rename(saved.id, ' wave ')).toBe(true)
    expect(await lib.rename(saved.id, 'wave')).toBe(false)
    expect(await lib.rename(saved.id, '   ')).toBe(false)
    expect(await lib.rename('nope', 'x')).toBe(false)

    const fresh = new Library(store, ticking(9999))
    expect((await fresh.get(saved.id))?.name).toBe('wave')
    // One write for the save, one for the rename that changed something.
    expect(writes.length).toBe(2)
  })

  test('numbering ignores a number it could not have written itself', async () => {
    const { store } = memory([
      { kind: 'drawing', id: 'h', name: 'Drawing 9007199254740993', at: 1, levels: blank() },
    ])
    const lib = new Library(store, ticking())
    // One more than that parses to the same double, so counting it would name two
    // drawings identically. Anything past the safe range is not a number this
    // function wrote, so it is not one it counts.
    const a = await lib.saveDrawing(dot(1, 1))
    const b = await lib.saveDrawing(dot(2, 2))
    expect(a.name).not.toBe(b.name)
    expect([a.name, b.name]).toEqual(['Drawing 1', 'Drawing 2'])
  })

  /**
   * One `library` singleton, several screens over it, and the file not yet read: the
   * load has to be shared or the second caller's revive replaces the list the first
   * is mutating. Caching the array rather than the promise lost a delete in memory
   * and wrote it back on the next save.
   */
  test('a delete that races the first read is not undone', async () => {
    const { store, reads, peek } = memory([
      { kind: 'text', id: 'z', name: 'old', at: 1, text: 'HI', motion: { kind: 'static' } },
    ])
    const lib = new Library(store, ticking())

    const [removed] = await Promise.all([lib.remove('z'), lib.all()])

    expect(removed).toBe(true)
    expect(await lib.all()).toEqual([])
    expect(reads()).toBe(1)

    // The resurrection is the part that outlives the session: the next save writes
    // whatever the library holds, so a stale list puts the deleted item back.
    await lib.saveDrawing(dot(3, 3), 'after')
    expect((peek() as SavedItem[]).map((i) => i.name)).toEqual(['after'])
  })

  test('a rename that races the first read survives in memory too', async () => {
    const { store } = memory([
      { kind: 'text', id: 'z', name: 'old', at: 1, text: 'HI', motion: { kind: 'static' } },
    ])
    const lib = new Library(store, ticking())

    await Promise.all([lib.rename('z', 'wave'), lib.all(), lib.get('z')])
    expect((await lib.get('z'))?.name).toBe('wave')
  })

  test('remove persists and misses quietly', async () => {
    const { store } = memory()
    const lib = new Library(store, ticking())
    const keep = await lib.saveDrawing(dot(1, 1), 'keep')
    const gone = await lib.saveDrawing(dot(2, 2), 'gone')

    expect(await lib.remove(gone.id)).toBe(true)
    expect(await lib.remove(gone.id)).toBe(false)

    const fresh = new Library(store, ticking(9999))
    expect((await fresh.all()).map((i) => i.id)).toEqual([keep.id])
  })
})

describe('revive', () => {
  test('anything but an array is an empty library', () => {
    expect(revive(null)).toEqual([])
    expect(revive('[]')).toEqual([])
    expect(revive({ items: [] })).toEqual([])
  })

  test('drops garbage entries and keeps the good ones', () => {
    const kept = revive([
      42,
      null,
      rawText(),
      { kind: 'sticker', id: 's1', name: 'x', at: 1 },
      rawDrawing({ id: '' }),
      rawDrawing({ at: 'yesterday' }),
      rawText({ text: '   ' }),
    ])
    expect(kept.map((i) => i.id)).toEqual(['t1'])
  })

  test('clamps drawing levels and rejects a wrong shape', () => {
    const nine = rawDrawing({ levels: dot(0, 0, 9) })
    const negative = rawDrawing({ id: 'd2', levels: dot(0, 1, -2) })
    const short = rawDrawing({ id: 'd3', levels: blank().slice(1) })
    const ragged = rawDrawing({
      id: 'd4',
      levels: blank().map((row, r) => (r === 4 ? row.slice(1) : row)),
    })

    const kept = revive([nine, negative, short, ragged]) as { levels: content.Bitmap }[]
    expect(kept.length).toBe(2)
    expect(kept[0].levels[0][0]).toBe(display.MAX_LEVEL)
    expect(kept[1].levels[0][1]).toBe(0)
  })

  test('rebuilds motion and drops what it cannot', () => {
    const kept = revive([
      rawText({ motion: { kind: 'static', stray: true } }),
      rawText({ id: 't2', motion: { kind: 'scroll', dir: 1, speed: 400 } }),
      rawText({ id: 't3', motion: { kind: 'scroll', dir: 2, speed: 50 } }),
      rawText({ id: 't4', motion: { kind: 'scroll', dir: 0, speed: 'fast' } }),
      rawText({ id: 't5', motion: 'scroll' }),
    ]) as { id: string; motion: content.Motion }[]

    expect(kept.map((i) => i.id)).toEqual(['t1', 't2'])
    expect(kept[0].motion).toEqual({ kind: 'static' })
    expect(kept[1].motion).toEqual({ kind: 'scroll', dir: 1, speed: content.MAX_SPEED })
  })

  test('a fractional speed is rounded to what the device can be told', () => {
    // `SPEED` is one byte, so the device truncates what the file held while
    // `speed.ts` buckets it as given: 50.5 would preview a bucket faster than it runs.
    const kept = revive([rawText({ motion: { kind: 'scroll', dir: 1, speed: 50.5 } })]) as {
      motion: content.Motion
    }[]
    expect(kept[0].motion).toEqual({ kind: 'scroll', dir: 1, speed: 51 })
  })

  test('first entry wins a duplicated id', () => {
    const kept = revive([rawText({ name: 'first' }), rawText({ name: 'second' })])
    expect(kept.length).toBe(1)
    expect(kept[0].name).toBe('first')
  })

  test('sorts newest first whatever order the file has', () => {
    const kept = revive([
      rawText({ id: 'old', at: 1 }),
      rawText({ id: 'new', at: 9 }),
      rawText({ id: 'mid', at: 5 }),
    ])
    expect(kept.map((i) => i.id)).toEqual(['new', 'mid', 'old'])
  })
})

/**
 * The first thing this feature's contract asks for, asserted on source because the
 * expo-file-system half cannot be imported under bun. *Corrected by track 21: it
 * imports fine with the module mocked, and `library-store.test.ts` drives the real
 * write that way. What a mock cannot answer is which files the path reaches at all,
 * which is what the crawl below is for.* Same pair as
 * `nicknames.test.ts`: losing a wear count matters and losing a preset does not, and
 * a preset is written on a whim where the ledger is written once per `DATCP`, so the
 * two must not share a file, a write, a parse or a failure.
 */
const HERE = dirname(new URL(import.meta.url).pathname)

const libraryPath = (): string[] => {
  const seen = new Set<string>()
  const queue = [resolve(HERE, 'library-store.ts')]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const m of readFileSync(file, 'utf8').matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      queue.push(resolve(dirname(file), m[1].replace(/\.js$/, '.ts')))
    }
  }
  return [...seen]
}

/**
 * *Narrowed by track 21, which put the shared write policy on this path.* This banned
 * the word `ledger` anywhere on the crawl, and `ledger-write.ts` is now imported here
 * on purpose: two stores hardening the same weakness two ways is how they drift apart
 * (review-12). The word is not the property. That module is pure, decides between a
 * rename and an in-place write over closures handed in, and opens no file, so what is
 * asserted instead is the thing the ban was after: every JSON file this path can open
 * is the library's, and no module on it may name the ledger any other way.
 *
 * *review-21 probed the narrowing rather than reading it, by injecting eight real
 * violations into the real files and watching this test.* The direct four all go red: a
 * `'ledger.json'` in the store, a static import of `ledger.ts`, a dynamic one, and a
 * mention in `library.ts` rather than the store. So the word ban still catches anything
 * that spells the ledger out, minus one import statement, and only that statement:
 * whitelisting the import rather than the bare string keeps
 * `'./ledger-write.js'.replace('-write', '')` from laundering a path past it.
 *
 * The four that escaped were **indirection through a module the crawl cannot follow**,
 * and three of them are now closed here: `await import()`, `require()` and a
 * double-quoted static import each reached a planted third module that opened the wear
 * count's file, while every module the crawl did read stayed clean. Same escape
 * review-14 found in `proximity.test.ts` the same evening, and the same fix: ban what
 * cannot be followed. `nicknames.test.ts` still has all three holes - it is review-10's
 * file and no track owns it - and every crawl in this repo shares the fourth, a
 * computed name (`'led' + 'ger' + '.json'`), which nothing line-anchored can see.
 */
test('nothing the library path reaches can open the ledger', () => {
  const modules = libraryPath()
  // Guards the crawl itself: an assertion over an empty list proves nothing.
  expect(modules.map((f) => f.split('/').pop()).sort()).toEqual([
    'ledger-write.ts',
    'library-store.ts',
    'library.ts',
  ])
  for (const file of modules) {
    const name = file.split('/').pop()
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const opens = [...src.matchAll(/["']([\w.-]+\.json)["']/g)].map((m) => m[1])
    expect(opens, `${name} opens a JSON file that is not the library's`).toEqual(
      name === 'library-store.ts' ? ['library.json'] : [],
    )
    // Anything the crawl cannot follow is a module this test never reads, so a third
    // module reached that way could open whatever it liked. Nothing on this path needs
    // either, and the list above is what proves the static ones are followed.
    expect(src, `${name} reaches a module by a route the crawl cannot follow`).not.toMatch(
      /\bimport\s*\(|\brequire\(/,
    )
    const rest = src.replace(/import\s+\{[^}]*\}\s+from\s+'\.\/ledger-write\.js'/g, '')
    expect(rest, `${name} names the ledger outside a comment`).not.toMatch(/ledger/i)
  }
})

test('the library file, the nickname file and the ledger file are three files', () => {
  const named = (f: string) => {
    const src = readFileSync(resolve(HERE, f), 'utf8')
    return [...src.matchAll(/'([\w.-]+\.json)'/g)].map((m) => m[1])
  }

  expect(named('library-store.ts')).toEqual(['library.json'])
  expect(named('nicknames-store.ts')).toEqual(['nicknames.json'])
  expect(named('ledger.ts')).toEqual(['ledger.json'])
})

describe('saved effects', () => {
  const spec = {
    effect: 'plasma',
    opts: { cycles: 3, warp: 0.35 },
    columns: 240,
    dither: 'ordered' as const,
    motion: { kind: 'scroll' as const, dir: 0 as const, speed: 65 },
  }

  test('a recipe round-trips through the file', async () => {
    const a = memory()
    const lib = new Library(a.store, ticking())
    const kept = await lib.saveEffect(spec)
    expect(kept.kind).toBe('effect')
    expect(kept.name).toBe('Plasma 1')

    const back = await new Library(a.store).all()
    expect(back).toHaveLength(1)
    const item = back[0]
    if (item.kind !== 'effect') throw new Error('expected an effect')
    expect(item.effect).toBe('plasma')
    expect(item.opts).toEqual({ cycles: 3, warp: 0.35 })
    expect(item.columns).toBe(240)
    expect(item.dither).toBe('ordered')
    expect(item.motion).toEqual({ kind: 'scroll', dir: 0, speed: 65 })
  })

  test('names number per generator, and skip nothing that is taken', async () => {
    const lib = new Library(memory().store, ticking())
    await lib.saveEffect(spec)
    await lib.saveEffect({ ...spec, effect: 'fire' })
    const second = await lib.saveEffect(spec)
    expect(second.name).toBe('Plasma 2')
    expect((await lib.all()).map((i) => i.name)).toContain('Fire 1')
  })

  test('an unknown generator is refused on save and dropped on revive', async () => {
    const lib = new Library(memory().store, ticking())
    await expect(lib.saveEffect({ ...spec, effect: 'lava' })).rejects.toThrow(/lava/)
    // A different app's item, or a generator later renamed: rendering it would throw
    // inside a screen, so it must not survive the read.
    const got = revive([
      { kind: 'effect', id: 'a', name: 'x', at: 1, ...spec, effect: 'lava' },
      { kind: 'effect', id: 'b', name: 'y', at: 2, ...spec },
    ])
    expect(got.map((i) => i.id)).toEqual(['b'])
  })

  test('revive keeps only primitive knobs and clamps the width', () => {
    const got = revive([
      {
        kind: 'effect',
        id: 'a',
        name: 'x',
        at: 1,
        ...spec,
        columns: 9000,
        opts: { cycles: 2, bad: { deep: true }, worse: [1], nan: NaN, soft: true },
      },
    ])
    expect(got).toHaveLength(1)
    const item = got[0]
    if (item.kind !== 'effect') throw new Error('expected an effect')
    expect(item.opts).toEqual({ cycles: 2, soft: true })
    expect(item.columns).toBeLessThanOrEqual(736)
  })

  test('a hostile knob key cannot reach the prototype', () => {
    const got = revive(
      JSON.parse(
        '[{"kind":"effect","id":"a","name":"x","at":1,"effect":"plasma",'
          + '"opts":{"__proto__":{"polluted":true},"cycles":2},"columns":120,'
          + '"dither":"none","motion":{"kind":"scroll","dir":0,"speed":50}}]',
      ),
    )
    expect(got).toHaveLength(1)
    const item = got[0]
    if (item.kind !== 'effect') throw new Error('expected an effect')
    expect(item.opts).toEqual({ cycles: 2 })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('mutating a returned recipe changes nothing held', async () => {
    const lib = new Library(memory().store, ticking())
    const kept = await lib.saveEffect(spec)
    kept.opts.cycles = 99
    const back = await lib.get(kept.id)
    if (back?.kind !== 'effect') throw new Error('expected an effect')
    expect(back.opts.cycles).toBe(3)
  })
})

/**
 * Search, which reaches the phone's own items and nothing else.
 *
 * The built-ins are absent by construction rather than by a filter: they are not
 * `SavedItem`s at all and never enter this function, which is the shape
 * `notes/library.md` argues for. What is asserted here is the matching itself, and
 * the one property a screen would otherwise get wrong: a blank query is search
 * switched off, not a search that matched nothing.
 */
describe('search', () => {
  const items = (): SavedItem[] => [
    { kind: 'text', id: 't1', name: 'Anthem', at: 3, text: 'RAVE ON', motion: SCROLL },
    { kind: 'text', id: 't2', name: 'Time to party', at: 2, text: 'LATER', motion: SCROLL },
    { kind: 'drawing', id: 'd1', name: 'Drawing 2', at: 1, levels: blank() },
    { kind: 'effect', id: 'e1', name: 'Plasma 3', at: 0, effect: 'plasma', opts: {},
      columns: 240, dither: 'ordered', motion: SCROLL },
  ]

  const found = (query: string): string[] => search(items(), query).map((i) => i.id)

  test('matches the name whatever kind the item is', () => {
    expect(found('anthem')).toEqual(['t1'])
    expect(found('drawing')).toEqual(['d1'])
    expect(found('plasma')).toEqual(['e1'])
  })

  test('matches what a text item says, not only what it is called', () => {
    // The name defaults to the text, so this only bites on a renamed preset - which
    // is exactly the item whose words are the thing a person remembers.
    expect(found('rave')).toEqual(['t1'])
    expect(found('later')).toEqual(['t2'])
  })

  test('a drawing and a recipe have no body to reach into', () => {
    // `opts` and `levels` are not a matching surface: nobody types "cycles".
    expect(found('cycles')).toEqual([])
    expect(found('ordered')).toEqual([])
  })

  test('terms are ANDed and order does not matter', () => {
    expect(found('party time')).toEqual(['t2'])
    expect(found('time party')).toEqual(['t2'])
    expect(found('party anthem')).toEqual([])
  })

  test('case and stray spaces do not decide whether something is found', () => {
    expect(found('  ANTHEM  ')).toEqual(['t1'])
    expect(found('rAvE oN')).toEqual(['t1'])
  })

  test('a blank query is search switched off, not a search that found nothing', () => {
    // The difference between an empty field showing everything and showing an empty
    // screen, which is the whole behaviour of the front door when nobody is typing.
    expect(found('')).toEqual(['t1', 't2', 'd1', 'e1'])
    expect(found('   ')).toEqual(['t1', 't2', 'd1', 'e1'])
  })

  test('keeps the order it was given, so newest-first survives a search', () => {
    // `all()` sorts; this must not re-order, or the grid would reshuffle as a person
    // typed and the tile under their thumb would change.
    expect(found('p')).toEqual(['t2', 'e1'])
  })

  test('hands back the same objects, so a tile keeps its identity while typing', () => {
    // `one-tap` caches renders on `id:at`, and the screen keys tiles the same way: a
    // copy per keystroke would be a fresh 736-column render per keystroke.
    const list = items()
    expect(search(list, 'anthem')[0]).toBe(list[0])
  })

  test('no match is an empty list rather than a throw', () => {
    expect(search([], 'anything')).toEqual([])
    expect(found('nothing here')).toEqual([])
  })
})

test('a text item remembers its face, and an old one is band5 for ever', async () => {
  const lib = new Library(memory().store, ticking())
  const slim = await lib.saveText('JOGGLES', { kind: 'static' }, '', 'slim5')
  expect(slim.font).toBe('slim5')
  // band5 is stored as absence, so an item written in the legacy face is byte-identical
  // to every item written before the field existed.
  const legacy = await lib.saveText('HI', { kind: 'static' }, '', 'band5')
  expect(legacy.font).toBeUndefined()
  // A face we do not know is dropped rather than kept: it renders as band5 anyway, and
  // keeping the name would promise a face that is not there.
  const bogus = await lib.saveText('HI', { kind: 'static' }, '', 'comic-sans')
  expect(bogus.font).toBeUndefined()
})

test('the face survives a revive, and an unknown one does not', () => {
  const at = 1
  const rows = [
    { kind: 'text', id: 'a', name: 'a', at, text: 'x', motion: { kind: 'static' }, font: 'band6' },
    { kind: 'text', id: 'b', name: 'b', at, text: 'x', motion: { kind: 'static' }, font: 'nope' },
    { kind: 'text', id: 'c', name: 'c', at, text: 'x', motion: { kind: 'static' } },
  ]
  const out = revive(rows) as SavedText[]
  expect(out.length).toBe(3)
  expect(out[0].font).toBe('band6')
  expect(out[1].font).toBeUndefined()
  expect(out[2].font).toBeUndefined()
  // What every one of them renders as, which is the property that actually matters.
  expect(font.fontByName(out[1].font)).toBe(font.LEGACY_FONT)
  expect(font.fontByName(out[2].font)).toBe(font.LEGACY_FONT)
})
