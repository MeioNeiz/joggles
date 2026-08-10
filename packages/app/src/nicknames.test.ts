/**
 * The pure half of the nickname store, with persistence injected as a `TextFile`.
 * The properties that matter: a broken file degrades to an empty map instead of
 * throwing into a render, and a failed write still renames for the session.
 * The expo-file-system half (`nicknames-store.ts`) does not import under bun,
 * per draw.test.ts; what it must get right - its own file, never the ledger's -
 * is one constant, checked by eye.
 */
import { expect, spyOn, test } from 'bun:test'
import { MAX_NICKNAME, clean, createStore, type TextFile } from './nicknames.js'

function memFile(initial: string | null = null) {
  const calls = { reads: 0, writes: 0 }
  let text = initial
  const file: TextFile = {
    read: () => {
      calls.reads += 1
      return text
    },
    write: (t) => {
      calls.writes += 1
      text = t
    },
  }
  return {
    file,
    calls,
    get text() {
      return text
    },
  }
}

/** Degrade paths warn on purpose; keep them out of the test output and count them. */
function quietly<T>(run: () => T): { out: T; warns: number } {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    return { out: run(), warns: warn.mock.calls.length }
  } finally {
    warn.mockRestore()
  }
}

test('a nickname set is a nickname got, keyed on the device string', () => {
  const m = memFile()
  const store = createStore(m.file)
  store.set('GLASSES-125B37', 'Left Lens Larry')

  expect(store.get('GLASSES-125B37')).toBe('Left Lens Larry')
  expect(JSON.parse(m.text!)).toEqual({ 'GLASSES-125B37': 'Left Lens Larry' })
})

test('a nickname survives a restart: a second store over the same file reads it', () => {
  const m = memFile()
  createStore(m.file).set('GLASSES-12C3EF', 'Bricked Betty')

  expect(createStore(m.file).get('GLASSES-12C3EF')).toBe('Bricked Betty')
})

test('unknown devices have no nickname', () => {
  const store = createStore(memFile().file)
  expect(store.get('GLASSES-000000')).toBeNull()
})

test('names are trimmed and capped at MAX_NICKNAME', () => {
  expect(clean('  Larry  ')).toBe('Larry')
  expect(clean('x'.repeat(MAX_NICKNAME + 20))).toHaveLength(MAX_NICKNAME)

  const store = createStore(memFile().file)
  store.set('GLASSES-125B37', '  Larry  ')
  expect(store.get('GLASSES-125B37')).toBe('Larry')
})

test('setting an empty or all-space name clears the nickname, on disk too', () => {
  const m = memFile()
  const store = createStore(m.file)
  store.set('GLASSES-125B37', 'Larry')
  store.set('GLASSES-125B37', '   ')

  expect(store.get('GLASSES-125B37')).toBeNull()
  expect(JSON.parse(m.text!)).toEqual({})
})

test('corrupt JSON degrades to an empty map, and the next set writes a clean file', () => {
  const m = memFile('{"GLASSES-125B37": "Lar')
  const store = createStore(m.file)

  const { out, warns } = quietly(() => store.get('GLASSES-125B37'))
  expect(out).toBeNull()
  expect(warns).toBe(1)

  store.set('GLASSES-12C3EF', 'Betty')
  expect(JSON.parse(m.text!)).toEqual({ 'GLASSES-12C3EF': 'Betty' })
})

test('JSON of the wrong shape degrades to an empty map', () => {
  for (const bad of ['null', '"a string"', '[1,2]', '7']) {
    const store = createStore(memFile(bad).file)
    expect(store.all()).toEqual({})
  }
})

test('non-string and empty values are dropped, readable ones kept', () => {
  const m = memFile('{"GLASSES-1": 5, "GLASSES-2": "Ok", "GLASSES-3": "", "GLASSES-4": null}')
  const store = createStore(m.file)

  expect(store.all()).toEqual({ 'GLASSES-2': 'Ok' })
})

test('a read that throws degrades to an empty map with one complaint', () => {
  const file: TextFile = {
    read: () => {
      throw new Error('no storage')
    },
    write: () => {},
  }
  const store = createStore(file)
  const { out, warns } = quietly(() => store.get('GLASSES-125B37'))

  expect(out).toBeNull()
  expect(warns).toBe(1)
})

test('a write that throws still renames for the rest of the session', () => {
  const file: TextFile = {
    read: () => null,
    write: () => {
      throw new Error('disk full')
    },
  }
  const store = createStore(file)
  const { warns } = quietly(() => store.set('GLASSES-125B37', 'Larry'))

  expect(warns).toBe(1)
  expect(store.get('GLASSES-125B37')).toBe('Larry')
})

test('the file is read once, not on every get', () => {
  const m = memFile('{"GLASSES-125B37": "Larry"}')
  const store = createStore(m.file)
  store.get('GLASSES-125B37')
  store.get('GLASSES-12C3EF')
  store.all()

  expect(m.calls.reads).toBe(1)
})

test('all() hands out a copy, not the map itself', () => {
  const store = createStore(memFile().file)
  store.set('GLASSES-125B37', 'Larry')

  const copy = store.all()
  copy['GLASSES-125B37'] = 'Tampered'
  delete copy['GLASSES-125B37']

  expect(store.get('GLASSES-125B37')).toBe('Larry')
})
