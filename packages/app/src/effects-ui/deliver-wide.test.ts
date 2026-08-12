/**
 * A wide loop going out through the existing delivery path, against the mock device.
 *
 * `plan.test.ts` checks what a loop *is*; this checks that the thing it hands `deliver()`
 * survives the whole handshake, because the widest loop this screen offers is by a long
 * way the biggest payload the app can produce and every ceiling it passes was measured
 * rather than derived. 736 columns is 1472 bytes at type 1's two-per-column, 3 columns
 * under the 1480 that `DATCPOK` was bisected at, and it goes out as 99 writes of one
 * 16-byte block each: the block is `[length][15 bytes]`, and packing a second into one ATT
 * write is the trap that reads as corruption because the panel decodes the first and drops
 * the rest with no error.
 *
 * `blockSleep: 0` throughout. The default is 50ms, which is right on a real link and is
 * five seconds of test time for one loop.
 *
 * `deliver.test.ts` owns this path for text and belongs to another track, so nothing here
 * duplicates its assertions about grey, cancel or the type 2 route. What is here is width.
 */
import { Glasses, content, dats, effects as fx, protocol as p } from '@joggles/core'
import { MockTransport, datsDevice } from '@joggles/core/src/mock-transport.js'
import { expect, test } from 'bun:test'
import { deliver } from '../deliver.js'
import { planLoop } from './plan.js'

const attach = (t: MockTransport) => Glasses.attach(t, 'GLASSES-TEST', { pacing: 0 })

const send = (g: Glasses, plan: ReturnType<typeof planLoop>) =>
  deliver(g, plan.piece, { blockSleep: 0 })

test('the widest loop reaches the device as one type 1 save and then scrolls', async () => {
  const t = datsDevice()
  const g = await attach(t)
  const plan = planLoop({ name: 'stripes', columns: fx.MAX_COLUMNS, dir: 0, speed: 95 })

  const out = await send(g, plan)

  expect(out.status).toBe('saved')
  expect(out.reply).toBe('DATCPOK')
  expect(out.showing).toBe(true)
  expect(out.cancelled).toBe(false)
  // The same cost object the screen printed before the press.
  expect(out.cost).toEqual(plan.cost)
  expect(out.cost.persists).toBe(true)

  // `SPEED` before `MODE`, which is the order the run that scrolled unattended used, and
  // `MODE` after `DATCP` rather than instead of it.
  expect(t.commands).toEqual(['DATS', 'DATCP', 'SPEED', 'MODE'])
})

test('the DATS header declares the type and the exact byte length that follows', async () => {
  const t = datsDevice()
  const g = await attach(t)
  const plan = planLoop({ name: 'plasma', columns: fx.MAX_COLUMNS })
  await send(g, plan)

  const payload = content.encodeSaved(plan.piece).payload
  expect(payload.length).toBe(fx.MAX_COLUMNS * 2)
  expect(payload.length).toBeLessThanOrEqual(content.MAX_SAVED_BYTES)
  // The type byte decides whether this survives a power cycle, so it is asserted on the
  // wire and not only on the plan. `DATCP` answers `DATCPOK` only when its running counter
  // matches what this frame predicted, so a wrong length here is an `ERROR` at the end of
  // a 1472-byte upload.
  expect(t.to(p.CHAR_COMMAND)[0]).toEqual(dats.datsStart(payload.length, dats.TYPE_TEXT))
})

test('one block per write, because the panel decodes the first and drops the rest', async () => {
  const t = datsDevice()
  const g = await attach(t)
  const plan = planLoop({ name: 'wave', columns: fx.MAX_COLUMNS })
  await send(g, plan)

  const payload = content.encodeSaved(plan.piece).payload
  const blocks = t.to(p.CHAR_BULK_A)
  expect(blocks).toHaveLength(Math.ceil(payload.length / dats.CHUNK_PAYLOAD))
  expect(blocks).toHaveLength(99)
  // Every write is exactly one block: `[length][15 bytes]`, zero-padded at the tail.
  for (const block of blocks) expect(block.length).toBe(16)
  // And the lengths add up to the payload, so nothing was dropped or sent twice.
  expect(blocks.reduce((n, b) => n + b[0], 0)).toBe(payload.length)
})

/**
 * The commit failing, and the hole that used to be here.
 *
 * **`save()` reports `saved` for an `ERROR` reply**, deliberately: the erases happen at the
 * device's end, so a rejected commit has still spent them and the ledger must count it.
 * `deliver()` used to withhold `MODE` on `refused` alone, so an `ERROR` commit still got a
 * `MODE` - which switches the panel to the saved store and displays whatever was there
 * before, the exact outcome `deliver`'s own comment said that guard existed to prevent.
 *
 * This test pinned that behaviour for track 13, which found it without owning the file.
 * Track 32 fixed it, and the assertion is inverted rather than deleted: the wire is where
 * the fix is visible, and a `MODE` reappearing after a failed commit is the regression.
 */
test('an ERROR commit is counted but never displayed, so no MODE goes out', async () => {
  const t = datsDevice({ fail: true })
  const g = await attach(t)
  const out = await send(g, planLoop({ name: 'fire', columns: 480 }))

  // The erases were spent at the device's end, which is what `saved` means and what the
  // wear count is counted from. `committed` is the other question, and it is the one the
  // panel cares about.
  expect(out.reply).toBe('ERROR')
  expect(out.status).toBe('saved')
  expect(out.committed).toBe(false)
  expect(out.saves).toBe(1)

  expect(t.commands).toEqual(['DATS', 'DATCP'])
  expect(t.commands).not.toContain('MODE')
  expect(out.showing).toBe(false)
})

test('the same loop twice is skipped, so a second tap spends no flash', async () => {
  const t = datsDevice()
  const g = await attach(t)
  const plan = planLoop({ name: 'ripple', columns: 240 })
  await send(g, plan)

  // The three-second interval rule would throw on a second save, but the duplicate check
  // runs before it: a skip writes no flash, which makes it the safest of the three
  // outcomes and the first one the guard looks for.
  const again = await send(g, plan)
  expect(again.status).toBe('skipped')
  // Still switched to it, so the panel and the reported state agree.
  expect(again.showing).toBe(true)
  expect(t.commands.filter((c) => c === 'DATCP')).toHaveLength(1)
})
