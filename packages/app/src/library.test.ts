import { describe, expect, test } from 'bun:test'
import { content, display } from '@joggles/core'
import { Library, revive } from './library.js'
import type { LibraryStore, SavedItem } from './library.js'

/**
 * A store that round-trips every save through JSON, so what a test reads back is
 * what a file would have kept and not an object the Library still holds by
 * reference. That difference is exactly what the copy-on-the-way-in tests probe.
 */
function memory(initial: unknown = null) {
  let data = initial
  const writes: string[] = []
  const store: LibraryStore = {
    async load() {
      return data
    },
    async save(items: SavedItem[]) {
      writes.push(JSON.stringify(items))
      data = JSON.parse(writes[writes.length - 1])
    },
  }
  return { store, writes }
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
