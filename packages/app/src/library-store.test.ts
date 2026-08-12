/**
 * The real store's write, driven over a filesystem small enough to break on purpose.
 *
 * The case worth the file is the second test and the third: a save that fails part-way
 * through must leave the previous library on disk whether or not the app survives it,
 * because the Draw screen's delete alert tells the user this phone holds the only copy.
 * Against the unfixed store the same probe left
 * `library.json` holding `[{"kind":"te` - not the new library, not the old one, and
 * unparseable, so the next launch dropped it and showed an empty library while the
 * console said "keeping items in memory only".
 *
 * **This drives the real closures, not a copy of them.** `library-store.ts` imports
 * expo-file-system, which does not resolve into anything usable under bun, so
 * `mock.module` puts an in-memory filesystem behind it before the module is evaluated.
 * The fake follows expo-file-system 57.0.2 where it matters: `moveSync` repoints the
 * instance's own `uri` at the destination, so a `stranded()` that re-asked the mover
 * would answer about `library.json` and every quiet no-op below would read as success.
 * `library.test.ts`'s source crawl answers which files this path *names*; the fake's own
 * log answers which it *touches*, below.
 *
 * `mock.module` replaces the module for the whole `bun test` process, not for this file,
 * so any future test that reaches expo-file-system through a screen would get this fake
 * or not depending on file order. Nothing else imports it today.
 *
 * Death is modelled as death: once the app is killed nothing else touches the disk, so
 * the fake refuses every later operation without mutating anything.
 *
 * **A tear the app lives through is a separate mode, and it is the one that mattered.**
 * *Corrected by review-21: this file said modelling a tear as a plain throw "would let
 * the in-place fallback run and truncate the real file after all", and used death to
 * avoid it. That was not a modelling nicety, it was the defect: on storage that refuses
 * the bytes without killing the app - a full disk - the fallback did truncate the real
 * file, and the probe left `library.json` holding a 20-character prefix where a whole
 * library had been. `tearKills: false` is that case, `reached` in `library-store.ts` is
 * the fix, and the assertion about the previous library now holds without needing the
 * app to die.*
 *
 * **The fake honours `overwrite` on both calls that take it**, because neither shows up
 * in the outcome of a save and both are load-bearing on a device: without it on
 * `create` the first stranded scratch file disables the rename for ever, and without it
 * on `moveSync` every save after the very first silently takes the fallback. While the
 * options were ignored, dropping either from the store left all nine tests green.
 */
import { expect, mock, test } from 'bun:test'
import type { SavedItem } from './library.js'

const DOC = 'doc'
const TARGET = `${DOC}/library.json`
const SCRATCH = `${TARGET}.writing`

type Move = 'ok' | 'throw' | 'quiet-noop'

interface Fake {
  files: Map<string, string>
  /** Every value `library.json` has held, in order, so no state can hide. */
  states: string[]
  /** Every operation with the uri it was aimed at, which is how `stranded` is caught. */
  log: string[]
  move: Move
  /** Characters of the payload that reach the disk before the write fails. */
  tearAt: number | null
  /**
   * Whether the app dies with the tear. Death is what the rename exists for; living
   * through it is what the in-place fallback has to be stopped from making worse,
   * since a throw the app survives is the only way to reach the fallback mid-tear.
   */
  tearKills: boolean
  /** No writable storage at all: both branches of the policy fail. */
  readonly: boolean
  dead: boolean
}

let fs: Fake

function fresh(opts: Partial<Fake> = {}): void {
  fs = {
    files: new Map(),
    states: [],
    log: [],
    move: 'ok',
    tearAt: null,
    tearKills: true,
    readonly: false,
    dead: false,
    ...opts,
  }
}

fresh()

const noted = (op: string, uri: string) => {
  fs.log.push(`${op} ${uri}`)
}

/** Sampled after every operation, and only recorded when it changed. */
const snap = () => {
  const now = fs.files.get(TARGET) ?? '(absent)'
  if (fs.states[fs.states.length - 1] !== now) fs.states.push(now)
}

class FakeFile {
  uri: string

  constructor(dir: string, name: string) {
    this.uri = `${dir}/${name}`
  }

  get exists(): boolean {
    noted('exists', this.uri)
    return fs.files.has(this.uri)
  }

  textSync(): string {
    const text = fs.files.get(this.uri)
    if (text === undefined) throw new Error(`no such file: ${this.uri}`)
    return text
  }

  create(opts?: { intermediates?: boolean; overwrite?: boolean }): void {
    noted('create', this.uri)
    if (fs.dead) throw new Error('the app is gone')
    if (fs.readonly) throw new Error('no writable storage')
    // `File.create`'s own `@throws` clause: the path being taken is an error unless
    // `overwrite` is asked for. The scratch path is taken whenever a rename left a file
    // stranded there, which is a state the policy expects to recover from.
    if (fs.files.has(this.uri) && !opts?.overwrite) {
      throw new Error(`create: ${this.uri} already exists`)
    }
    fs.files.set(this.uri, '')
    snap()
  }

  write(text: string): void {
    noted('write', this.uri)
    if (fs.dead) throw new Error('the app is gone')
    if (fs.readonly) throw new Error('no writable storage')
    if (fs.tearAt !== null) {
      fs.files.set(this.uri, text.slice(0, fs.tearAt))
      if (fs.tearKills) fs.dead = true
      snap()
      throw new Error(fs.tearKills ? 'app killed mid-write' : 'no space left on device')
    }
    fs.files.set(this.uri, text)
    snap()
  }

  moveSync(dest: FakeFile, opts?: { overwrite?: boolean }): void {
    noted('move', `${this.uri} -> ${dest.uri}`)
    if (fs.dead) throw new Error('the app is gone')
    if (fs.move === 'throw') throw new Error('moveSync is not a function')
    // *derived* from `RelocationOptions.overwrite`'s documented `@default false`: an
    // unasked-for overwrite does not happen. Modelled as a throw because the second
    // save a phone ever makes is a rename over an existing library, and whether that
    // throws or silently declines, the new library does not land.
    if (fs.files.has(dest.uri) && !opts?.overwrite) {
      throw new Error(`move: ${dest.uri} exists`)
    }
    const from = this.uri
    // Faithful to expo-file-system: the instance follows the file to its destination,
    // whether or not the file went anywhere.
    this.uri = dest.uri
    if (fs.move === 'quiet-noop') return
    fs.files.set(dest.uri, fs.files.get(from) ?? '')
    fs.files.delete(from)
    snap()
  }
}

await mock.module('expo-file-system', () => ({
  File: FakeFile,
  Paths: { document: DOC },
}))

const { fileStore } = await import('./library-store.js')

const item = (id: string, text: string): SavedItem => ({
  kind: 'text',
  id,
  name: id,
  at: 1,
  text,
  motion: { kind: 'static' },
})

const OLD = [item('a', 'keep me')]
const NEW = [item('a', 'keep me'), item('b', 'and this')]

const quiet = () => {
  const said: string[] = []
  const warn = console.warn
  console.warn = (line: string) => said.push(String(line))
  return {
    said,
    restore: () => {
      console.warn = warn
    },
  }
}

test('a save goes whole to a temp file, then over the real one', async () => {
  fresh()
  await fileStore().save(NEW)

  expect(JSON.parse(fs.files.get(TARGET) ?? '')).toEqual(NEW)
  // Nothing left behind, and the scratch path is not the library's own file.
  expect([...fs.files.keys()]).toEqual([TARGET])
  expect(fs.log.slice(0, 3)).toEqual([
    `create ${SCRATCH}`,
    `write ${SCRATCH}`,
    `move ${SCRATCH} -> ${TARGET}`,
  ])
  // The real file goes straight from absent to the whole library: no empty state.
  expect(fs.states).toEqual(['(absent)', JSON.stringify(NEW)])
})

test('a save that dies part-way leaves the previous library intact', async () => {
  fresh({ tearAt: 12 })
  fs.files.set(TARGET, JSON.stringify(OLD))
  const heard = quiet()

  await fileStore().save(NEW)
  heard.restore()

  expect(JSON.parse(fs.files.get(TARGET) ?? '')).toEqual(OLD)
  // The torn prefix is on the scratch path, where nothing reads it.
  expect(fs.files.get(SCRATCH)).toBe(JSON.stringify(NEW).slice(0, 12))
  // The real file was never touched at all, not even opened for writing.
  expect(fs.states).toEqual([JSON.stringify(OLD)])
  // What a survivor of the kill would find in the log: the disk holds the old library
  // and this session's newest item exists in memory only.
  expect(heard.said.some((s) => s.includes('keeping items in memory only'))).toBe(true)
})

test('a write refused part-way leaves the previous library intact', async () => {
  // The same tear with the app alive, which is the only way to reach the fallback while
  // the storage is still refusing bytes. Without `reached` the fallback truncated
  // `library.json` to the same 12 characters and the whole library was gone.
  fresh({ tearAt: 12, tearKills: false })
  fs.files.set(TARGET, JSON.stringify(OLD))
  const heard = quiet()

  await fileStore().save(NEW)
  heard.restore()

  expect(JSON.parse(fs.files.get(TARGET) ?? '')).toEqual(OLD)
  expect(fs.states).toEqual([JSON.stringify(OLD)])
  // And it says so, which it can only do because the fallback declined rather than
  // half-writing: the items really are in memory only.
  expect(heard.said.some((s) => s.includes('keeping items in memory only'))).toBe(true)
})

test('a rename that quietly does nothing is caught, and the save lands', async () => {
  // Review-12's defect, in the other store: no exception, so without `stranded()` the
  // policy returned success and the file kept whatever it held before, for ever.
  fresh({ move: 'quiet-noop' })
  fs.files.set(TARGET, JSON.stringify(OLD))
  const heard = quiet()

  await fileStore().save(NEW)
  heard.restore()

  expect(JSON.parse(fs.files.get(TARGET) ?? '')).toEqual(NEW)
  expect(heard.said.some((s) => s.includes('atomic write'))).toBe(true)
  // The fallback wrote the file, so nothing may say the items were kept in memory only.
  expect(heard.said.some((s) => s.includes('memory only'))).toBe(false)
  // A stranded scratch file is left where it is: written whole, read by nothing, and
  // overwritten by the next save, so removing it would only add a failure path.
  expect(fs.files.has(SCRATCH)).toBe(true)
})

test('the stranded check asks a fresh handle, not the one that moved', async () => {
  // No file yet, which is the worst case for the wrong handle: the mover now points at
  // a `library.json` that does not exist, so re-asking it answers "moved fine" and the
  // first save a phone ever makes vanishes without a word.
  fresh({ move: 'quiet-noop' })
  const heard = quiet()

  await fileStore().save(NEW)
  heard.restore()

  expect(JSON.parse(fs.files.get(TARGET) ?? '')).toEqual(NEW)
  const moved = fs.log.findIndex((line) => line.startsWith('move '))
  const asked = fs.log.findIndex((line) => line === `exists ${SCRATCH}`)
  expect(moved).toBeGreaterThanOrEqual(0)
  // After the move, the mover's own uri is the target, so this question can only have
  // come from a handle built afresh at the scratch path.
  expect(asked).toBeGreaterThan(moved)
})

test('a save over an existing library renames rather than falling back', async () => {
  // The second save a phone ever makes, and the first one whose rename has to replace
  // something. Nothing in a save's outcome distinguishes a rename from the fallback, so
  // this is the only place a missing `overwrite` on either call would show up.
  fresh()
  fs.files.set(TARGET, JSON.stringify(OLD))
  const heard = quiet()

  await fileStore().save(NEW)
  heard.restore()

  expect(heard.said).toEqual([])
  expect(fs.states).toEqual([JSON.stringify(OLD), JSON.stringify(NEW)])
})

test('the save after a stranded scratch file still renames', async () => {
  // Where the policy's "left where it is" lands: the quiet no-op strands a whole file at
  // the scratch path, and the next save has to write over it. `create` refuses a path
  // that is taken unless asked to overwrite, so without that option every save from here
  // on would take the fallback, silently, for the life of the install.
  fresh({ move: 'quiet-noop' })
  const heard = quiet()
  await fileStore().save(OLD)
  expect(fs.files.has(SCRATCH)).toBe(true)

  fs.move = 'ok'
  fs.states = []
  heard.said.length = 0
  await fileStore().save(NEW)
  heard.restore()

  expect(heard.said).toEqual([])
  expect(fs.states).toEqual([JSON.stringify(OLD), JSON.stringify(NEW)])
})

test('a rename that throws falls back to writing in place', async () => {
  fresh({ move: 'throw' })
  fs.files.set(TARGET, JSON.stringify(OLD))
  const heard = quiet()

  await fileStore().save(NEW)
  heard.restore()

  expect(JSON.parse(fs.files.get(TARGET) ?? '')).toEqual(NEW)
  expect(heard.said.some((s) => s.includes('atomic write'))).toBe(true)
  // The fallback wrote the file, so nothing may say the items were kept in memory only.
  expect(heard.said.some((s) => s.includes('memory only'))).toBe(false)
})

test('no fault mode leaves the real file empty or half a library', async () => {
  for (const move of ['ok', 'throw', 'quiet-noop'] as const) {
    fresh({ move })
    fs.files.set(TARGET, JSON.stringify(OLD))
    const heard = quiet()

    await fileStore().save(NEW)
    heard.restore()

    // Every value the file ever held is one whole library or the other, which is the
    // property, rather than merely ending up right.
    const whole = [JSON.stringify(OLD), JSON.stringify(NEW)]
    for (const state of fs.states) {
      expect(whole, `${move} left ${state}`).toContain(state)
    }
    expect(JSON.parse(fs.files.get(TARGET) ?? '')).toEqual(NEW)
  }
})

test('a save touches no path but the library and its scratch', async () => {
  // The runtime half of `library.test.ts`'s source crawl, and the half a crawl cannot
  // do: the shared write policy is handed three closures, and this is every path they
  // actually touch, over every branch the policy can take. A crawl can only say that
  // the wear count's file is not named anywhere.
  const paths = new Set<string>()
  const modes: Partial<Fake>[] = [
    {},
    { move: 'throw' },
    { move: 'quiet-noop' },
    { readonly: true },
    { tearAt: 12 },
    { tearAt: 12, tearKills: false },
  ]
  for (const mode of modes) {
    fresh(mode)
    fs.files.set(TARGET, JSON.stringify(OLD))
    const heard = quiet()
    await fileStore().save(NEW)
    await fileStore().load()
    heard.restore()
    for (const line of fs.log) {
      for (const uri of line.match(/doc\/\S+/g) ?? []) paths.add(uri)
    }
  }

  expect([...paths].sort()).toEqual([TARGET, SCRATCH])
})

test('a phone with no writable storage keeps its items and never throws', async () => {
  fresh({ readonly: true })
  fs.files.set(TARGET, JSON.stringify(OLD))
  const heard = quiet()

  await fileStore().save(NEW)
  heard.restore()

  // Both branches failed, so the session runs on memory alone, and what is on disk is
  // still a whole library rather than a truncated one.
  expect(JSON.parse(fs.files.get(TARGET) ?? '')).toEqual(OLD)
  expect(heard.said.some((s) => s.includes('keeping items in memory only'))).toBe(true)
})

test('a stranded temp file is never read back as the library', async () => {
  fresh()
  fs.files.set(TARGET, JSON.stringify(OLD))
  fs.files.set(SCRATCH, JSON.stringify(NEW))

  expect(await fileStore().load()).toEqual(OLD)
})

test('an unreadable file degrades to nothing rather than throwing', async () => {
  fresh()
  fs.files.set(TARGET, '[{"kind":"te')
  const heard = quiet()

  const loaded = await fileStore().load()
  heard.restore()

  expect(loaded).toBeNull()
  expect(heard.said.some((s) => s.includes('read'))).toBe(true)
})
