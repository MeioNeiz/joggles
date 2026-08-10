/**
 * The wire facts Connected.tsx leans on, asserted against the mock device.
 *
 * The React half is deliberately absent, as in `draw.test.ts`: react-native does
 * not import under bun, so what a screen renders is checked on the handset and
 * what it must never put on the wire is checked here.
 *
 * Both tests exist because of the header rule in Connected.tsx - every control
 * that touches the wire is disabled while a save is in flight. These pin the two
 * facts that rule rests on, so loosening either shows up as a red test rather
 * than as a corrupted upload on a festival evening.
 */
import { Glasses, content, protocol as p } from '@joggles/core'
import { MockTransport, datsDevice, opcodeOf } from '@joggles/core/src/mock-transport.js'
import { expect, test } from 'bun:test'

const attach = (t: MockTransport) =>
  Glasses.attach(t, 'GLASSES-TEST', { pacing: 0, budget: undefined })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('a command mid-save lands inside the DATS handshake, which is why busy gates it', async () => {
  const t = datsDevice()
  const g = await attach(t)
  // Long enough that the block stream is still going when the command fires.
  const piece = content.text('HELLO WORLD HELLO WORLD')

  const saving = g.save(piece.bitmap, { blockSleep: 10 })
  await sleep(30)
  await g.command(p.brightness(3))
  await saving

  // `Glasses` has no mutex between command() and save(): the LIGHT frame goes out
  // between the bulk blocks, before DATCP closes the handshake. Nobody has sent
  // that interleaving to hardware, so the screen must not be able to produce it.
  expect(t.to(p.CHAR_COMMAND).map(opcodeOf)).toEqual(['DATS', 'LIGHT', 'DATCP'])
})

test('probe() on a dead link rejects rather than answering, so the screen must catch', async () => {
  const t = new MockTransport()
  const g = await attach(t)
  t.write = () => Promise.reject(new Error('device disconnected'))

  // Silence is probe()'s answer for a stock unit, but a failed WRITE is a
  // rejection: with a bare .then() in the mount effect that is an unhandled
  // rejection every time a link drops before the screen settles.
  await expect(g.probe()).rejects.toThrow('device disconnected')
})
