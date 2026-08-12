/**
 * The write policy under every way a rename can fail, including the quiet one.
 *
 * The case worth the file is the third test: a `moveSync` that neither moves the file
 * nor throws. The first version of `ledger.ts` fell back only on an exception, so that
 * rename read as a success, the ledger file was never updated, and the phone counted
 * wear in memory for the rest of the session and from zero after every restart - with
 * nothing on screen to say so, because the in-memory count is right the whole time.
 */
import { expect, test } from 'bun:test'
import { type AtomicWrite, writeThroughTemp } from './ledger-write.js'

/** A filesystem small enough to break on purpose. */
function fake(
  opts: { move?: 'ok' | 'throw' | 'quiet-noop'; inPlace?: 'ok' | 'throw' } = {},
): AtomicWrite & { log: string[]; temp: string | null; target: string | null } {
  const { move = 'ok', inPlace = 'ok' } = opts
  const state = {
    log: [] as string[],
    temp: null as string | null,
    target: null as string | null,
    rename() {
      state.log.push('rename')
      state.temp = 'json'
      if (move === 'throw') throw new Error('moveSync is not a function')
      if (move === 'quiet-noop') return
      state.target = state.temp
      state.temp = null
    },
    stranded() {
      return state.temp !== null
    },
    inPlace() {
      state.log.push('inPlace')
      if (inPlace === 'throw') throw new Error('no writable storage')
      state.target = 'json'
    },
  }
  return state
}

const quiet = () => {
  const said: string[] = []
  return { said, complain: (what: string) => said.push(what) }
}

test('a rename that works is the only thing that runs', () => {
  const fs = fake()
  const { said, complain } = quiet()

  expect(writeThroughTemp(fs, complain)).toBe('renamed')
  expect(fs.log).toEqual(['rename'])
  expect(fs.target).toBe('json')
  expect(said).toEqual([])
})

test('a rename that throws falls back to writing in place', () => {
  const fs = fake({ move: 'throw' })
  const { said, complain } = quiet()

  expect(writeThroughTemp(fs, complain)).toBe('in place')
  expect(fs.log).toEqual(['rename', 'inPlace'])
  // The count still reaches disk, which is the whole point of having a fallback.
  expect(fs.target).toBe('json')
  expect(said).toEqual(['atomic write'])
})

test('a rename that quietly does nothing also falls back, which is the defect', () => {
  // No exception, and without the `stranded()` check this returned success while the
  // ledger file kept whatever it held before. Wear counting stops and nothing says so.
  const fs = fake({ move: 'quiet-noop' })
  const { said, complain } = quiet()

  expect(writeThroughTemp(fs, complain)).toBe('in place')
  expect(fs.log).toEqual(['rename', 'inPlace'])
  expect(fs.target).toBe('json')
  expect(said).toEqual(['atomic write'])
})

test('both paths failing is reported rather than thrown', () => {
  // The caller has already updated its in-memory ledger, so throwing here would take
  // down the save that had already spent its erases. The session still counts.
  const fs = fake({ move: 'throw', inPlace: 'throw' })
  const { said, complain } = quiet()

  expect(writeThroughTemp(fs, complain)).toBe('lost')
  expect(fs.target).toBeNull()
  expect(said).toEqual(['atomic write', 'write'])
})

test('the target is never left empty by a failed rename', () => {
  // The ordering that matters: the scratch file carries the whole JSON before anything
  // touches the ledger, so no branch can truncate it and then fail.
  for (const move of ['ok', 'throw', 'quiet-noop'] as const) {
    const fs = fake({ move })
    writeThroughTemp(fs, () => {})
    expect(fs.target).toBe('json')
  }
})
