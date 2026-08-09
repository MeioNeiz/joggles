/**
 * The coalescing sender, against a mock device.
 *
 * What is being asserted is the wire and the arithmetic on it: how many writes,
 * which channel, which one is acked, and - the property the whole file exists for
 * - that updates arriving during a write replace each other instead of piling up.
 * A `Gated` transport holds each write open so that "during a write" is a state a
 * test can actually be in.
 */
import { expect, test } from 'bun:test'
import { COLS, Grid, ROWS } from './display.js'
import { MockTransport } from './mock-transport.js'
import * as p from './protocol.js'
import { LiveSender } from './sender.js'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Every write blocks until `release()`, so "mid-batch" is reachable from a test. */
class Gated extends MockTransport {
  private gates: Array<() => void> = []

  override async write(
    char: string,
    block: Uint8Array,
    withResponse: boolean,
  ): Promise<void> {
    await super.write(char, block, withResponse)
    await new Promise<void>((r) => this.gates.push(r))
  }

  release(): void {
    for (const r of this.gates.splice(0)) r()
  }
}

/** Let a gated sender run to the end of its batch. */
async function drain(t: Gated, s: LiveSender): Promise<void> {
  let done = false
  const idle = s.idle().then(() => {
    done = true
  })
  for (let i = 0; i < 200 && !done; i++) {
    t.release()
    await tick()
  }
  await idle
}

const lit = (...cols: number[]): Grid => {
  const g = new Grid()
  for (const c of cols) g.set(4, c)
  return g
}

const indices = (t: MockTransport): number[] =>
  t.to(p.CHAR_BULK_B).map((f) => p.body(f)[0])

test('an untouched sender writes nothing and is already idle', async () => {
  const t = new MockTransport()
  const s = new LiveSender(t, { pacing: 0 })
  await s.idle()
  expect(t.writes).toHaveLength(0)
  expect(s.pending).toBe(0)
})

test('only the columns that changed are written, on the live channel', async () => {
  const t = new MockTransport()
  const s = new LiveSender(t, { pacing: 0 })

  s.set(lit(3, 7))
  await s.idle()
  expect(indices(t)).toEqual([3, 7])

  s.set(lit(3, 7, 20))
  await s.idle()
  // The two already-lit columns are not resent.
  expect(indices(t)).toEqual([3, 7, 20])
  expect(t.writes.every((w) => w.char === p.CHAR_BULK_B)).toBe(true)
})

test('setting the same state again writes nothing', async () => {
  const t = new MockTransport()
  const s = new LiveSender(t, { pacing: 0 })
  s.set(lit(5))
  await s.idle()

  s.set(lit(5))
  s.draw(4, 5, true)
  await s.idle()
  expect(t.writes).toHaveLength(1)
})

test('the last write of a batch is acked and the rest are not', async () => {
  const t = new MockTransport()
  const s = new LiveSender(t, { pacing: 0 })
  s.set(lit(1, 2, 3))
  await s.idle()

  expect(t.writes.map((w) => w.withResponse)).toEqual([false, false, true])
})

test('a batch cut short by a retraction still ends acked', async () => {
  const t = new Gated()
  const s = new LiveSender(t, { pacing: 0 })

  s.set(lit(0, 7)) // two columns owed, so the first goes out unacked
  await tick()
  s.set(lit(0)) // column 7 taken back while column 0 is still open

  await drain(t, s)
  // Column 0's write was committed to as "not the last one" and then became the
  // last one, so the pump owes itself an ack or column 0 can be lost to a
  // disconnect arriving right behind it.
  expect(t.writes.map((w) => w.withResponse)).toEqual([false, true])
  expect(t.commands).toEqual(['STYPE'])
})

test('the column bytes are the ones display.ts would have built', async () => {
  const t = new MockTransport()
  const s = new LiveSender(t, { pacing: 0 })
  const g = new Grid()
  for (let r = 0; r < ROWS; r++) g.set(r, r * 2, (r % 3) as number)

  s.set(g)
  await s.idle()
  s.refresh()
  await s.idle()

  const written = t.to(p.CHAR_BULK_B).map((f) => [...f])
  expect(written.slice(-COLS)).toEqual(g.toFrames().map((f) => [...f]))
})

test('updates during a write are coalesced, not queued', async () => {
  const t = new Gated()
  const s = new LiveSender(t, { pacing: 0 })

  s.draw(4, 0)
  await tick()
  expect(t.writes).toHaveLength(1) // in flight, and blocking

  // Fifty touches arrive while that single write is open. A queueing sender would
  // owe fifty frames; this one owes the difference between two grids.
  for (let i = 0; i < 50; i++) s.set(lit(0, 1 + (i % 3)))
  const final = lit(0, 3)
  s.set(final)

  await drain(t, s)
  expect(indices(t)).toEqual([0, 3])
  expect(s.pending).toBe(0)
})

test('a column touched and untouched again during a write is never sent', async () => {
  const t = new Gated()
  const s = new LiveSender(t, { pacing: 0 })

  s.draw(4, 0)
  await tick()
  s.draw(4, 11) // wanted...
  s.draw(4, 11, false) // ...and taken back before the pump got to it

  await drain(t, s)
  expect(indices(t)).toEqual([0])
})

test('clear is one atomic write on the command channel', async () => {
  const t = new MockTransport()
  const s = new LiveSender(t, { pacing: 0 })
  s.set(lit(2, 9, 15))
  await s.idle()
  const drawn = t.writes.length

  s.clear()
  await s.idle()
  expect(t.writes).toHaveLength(drawn + 1)
  expect(t.commands).toEqual(['CLRL'])
  expect(t.writes.at(-1)?.withResponse).toBe(true)
})

test('a non-atomic clear blanks the same columns one at a time', async () => {
  const t = new MockTransport()
  const s = new LiveSender(t, { pacing: 0 })
  s.set(lit(2, 9))
  await s.idle()

  s.clear({ atomic: false })
  await s.idle()
  expect(t.commands).toEqual([])
  expect(indices(t)).toEqual([2, 9, 2, 9])
  // Blank columns, so three zero bytes after the index.
  expect([...p.body(t.to(p.CHAR_BULK_B)[3])]).toEqual([9, 0, 0, 0])
})

test('after an atomic clear the device is known blank, so redrawing is one write', async () => {
  const t = new MockTransport()
  const s = new LiveSender(t, { pacing: 0 })
  s.set(lit(2, 9, 15))
  await s.idle()
  s.clear()
  await s.idle()
  const before = t.writes.length

  s.draw(4, 9)
  await s.idle()
  expect(t.writes).toHaveLength(before + 1)
  expect(indices(t).at(-1)).toBe(9)
})

test('a clear supersedes the columns still owed to the device', async () => {
  const t = new Gated()
  const s = new LiveSender(t, { pacing: 0 })

  s.set(lit(0, 5, 10, 20))
  await tick()
  s.clear()

  await drain(t, s)
  // Column 0 was already in flight; the rest were dropped in favour of CLRL.
  expect(indices(t)).toEqual([0])
  expect(t.commands).toEqual(['CLRL'])
})

test('a refresh arriving during the clear write is not swallowed by it', async () => {
  const t = new Gated()
  const s = new LiveSender(t, { pacing: 0 })
  s.set(lit(3))
  await drain(t, s)

  s.clear()
  await tick() // CLRL in flight
  s.refresh() // something moved the panel, possibly after the CLRL landed
  await drain(t, s)

  expect(t.commands).toEqual(['CLRL'])
  // Blank columns, but all 24 of them: a clear is no longer proof of what is shown.
  expect(indices(t)).toEqual([3, ...Array.from({ length: COLS }, (_, i) => i)])
})

test('refresh rewrites every column, whatever the device was believed to hold', async () => {
  const t = new MockTransport()
  const s = new LiveSender(t, { pacing: 0 })
  s.set(lit(4))
  await s.idle()

  s.refresh()
  expect(s.pending).toBe(COLS)
  await s.idle()
  expect(indices(t)).toEqual([4, ...Array.from({ length: COLS }, (_, i) => i)])
  expect(t.writes.at(-1)?.withResponse).toBe(true)
})

test('the grid handed in is copied, not held', async () => {
  const t = new MockTransport()
  const s = new LiveSender(t, { pacing: 0 })
  const g = lit(6)
  s.set(g)
  await s.idle()

  g.set(4, 7) // the caller keeps drawing into its own grid
  await s.idle()
  expect(indices(t)).toEqual([6])
})

test('writes are paced, and the batch does not sleep after its last write', async () => {
  const t = new MockTransport()
  const naps: number[] = []
  const s = new LiveSender(t, {
    pacing: 18,
    sleep: async (ms) => {
      naps.push(ms)
    },
  })

  s.set(lit(1, 2, 3))
  await s.idle()
  expect(naps).toEqual([18, 18])
})

test('the write after a clear is paced like any other', async () => {
  const t = new MockTransport()
  const naps: number[] = []
  const s = new LiveSender(t, {
    pacing: 18,
    sleep: async (ms) => {
      naps.push(ms)
    },
  })

  s.clear()
  s.set(lit(5, 6))
  await s.idle()
  // CLRL, gap, column 5, gap, column 6. The clear costs the module a frame too.
  expect(t.writes).toHaveLength(3)
  expect(naps).toEqual([18, 18])
})

test('a failed write stops the sender, and idle reports why', async () => {
  const t = new MockTransport()
  const boom = new Error('disconnected')
  t.write = () => Promise.reject(boom)
  const s = new LiveSender(t, { pacing: 0 })

  s.set(lit(3))
  await expect(s.idle()).rejects.toThrow('disconnected')
  expect(s.stopped).toBe(true)
  expect(s.error).toBe(boom)

  // Dead for good: a later touch must not quietly look like it was delivered.
  s.draw(4, 8)
  await expect(s.idle()).rejects.toThrow('disconnected')
})

test('stop leaves the batch where it was, and flush acks what got out', async () => {
  const t = new Gated()
  const s = new LiveSender(t, { pacing: 0 })

  s.set(lit(1, 2, 3, 4))
  await tick()
  const stopped = s.stop()
  t.release()
  await stopped
  await tick()

  expect(t.writes).toHaveLength(1)
  expect(t.writes[0].withResponse).toBe(false)
  expect(s.pending).toBeGreaterThan(0)

  const flushed = s.flush()
  await tick()
  t.release()
  await flushed
  const last = t.writes.at(-1)!
  expect(last.withResponse).toBe(true)
  expect(t.commands).toEqual(['STYPE'])
})

test('flush is a no-op once a batch has drained, because that batch was acked', async () => {
  const t = new MockTransport()
  const s = new LiveSender(t, { pacing: 0 })
  s.set(lit(1, 2))
  await s.flush()
  expect(t.writes).toHaveLength(2)
  expect(t.commands).toEqual([])
})

test('frames are encrypted with the cipher the session chose', async () => {
  const crew = p.cipher(new Uint8Array(16).fill(7))
  const t = new MockTransport(crew)
  const s = new LiveSender(t, { pacing: 0, cipher: crew })

  s.draw(4, 12)
  await s.idle()
  // The mock decrypts with the crew key, so a vendor-keyed frame would be garbage.
  expect(indices(t)).toEqual([12])
})

test('pending counts what is still owed', async () => {
  const t = new Gated()
  const s = new LiveSender(t, { pacing: 0 })

  s.set(lit(0, 1, 2))
  expect(s.pending).toBe(3)
  await tick()
  // Still three: the first write is open and an open write is not a delivered one.
  expect(s.pending).toBe(3)
  t.release()
  await tick()
  expect(s.pending).toBe(2)

  await drain(t, s)
  expect(s.pending).toBe(0)
})
