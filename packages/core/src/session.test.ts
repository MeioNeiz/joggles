/**
 * The sequencer, against a mock device.
 *
 * These assertions are the reason the transport split exists: they run on the
 * laptop with no hardware, and the phone passes or fails them for the same reasons
 * the CLI does. What they check is the wire, not the API - which characteristic,
 * how many blocks, which write is acked - because those are what the hardware
 * silently punishes.
 */
import { expect, test } from 'bun:test'
import { BudgetError, FlashBudget } from './budget.js'
import * as dats from './dats.js'
import { Grid } from './display.js'
import { panelBitmap } from './font.js'
import * as jgx from './jgx.js'
import { MockTransport, datsDevice, opcodeOf, reply } from './mock-transport.js'
import * as p from './protocol.js'
import { Glasses } from './session.js'

const attach = (t: MockTransport, opts = {}) =>
  Glasses.attach(t, 'GLASSES-TEST', { pacing: 0, ...opts })

test('attach subscribes to the notify channel and nothing else', async () => {
  const t = new MockTransport()
  await attach(t)
  expect(t.subscribed).toEqual([p.CHAR_NOTIFY])
  expect(t.writes).toHaveLength(0)
})

test('the cipher can be chosen from the advert name', async () => {
  const crew = p.cipher(new Uint8Array(16).fill(7))
  const t = new MockTransport(crew)
  const g = await Glasses.attach(t, 'JOGGLES-1234', {
    cipher: (name) => (name.startsWith('JOGGLES-') ? crew : p.vendor),
  })
  await g.command(p.clear())
  // The mock decrypts with the crew key, so a vendor-keyed write would be garbage.
  expect(t.commands).toEqual(['CLRL'])
})

test('save does the whole DATS handshake, in order, one block per write', async () => {
  const t = datsDevice()
  const g = await attach(t)
  const bitmap = panelBitmap('HI')

  const result = await g.save(bitmap, { blockSleep: 0 })

  expect(result).toMatchObject({ status: 'saved', reply: 'DATCPOK', saves: 1 })
  expect(t.commands).toEqual(['DATS', 'DATCP'])

  const payload = dats.encodeBitmap(bitmap)
  const start = t.to(p.CHAR_COMMAND)[0]
  const len = payload.length
  expect([...p.body(start).subarray(4)]).toEqual([1, len >> 8, len & 0xff])

  const blocks = t.to(p.CHAR_BULK_A)
  expect(blocks).toHaveLength(Math.ceil(payload.length / dats.CHUNK_PAYLOAD))
  // The stream is 960a, not 960b: the two are not interchangeable.
  expect(blocks.every((b) => b.length === p.BLOCK_SIZE)).toBe(true)
  const rebuilt = blocks.flatMap((b) => [...b.subarray(1, 1 + b[0])])
  expect(rebuilt).toEqual([...payload])
})

// The wire difference between the two types is the announced type byte and three
// bytes per column instead of two. Nothing else in the handshake moves.
test('save type 2 announces type 2 and sends the image encoding', async () => {
  const t = datsDevice()
  const g = await attach(t)
  const bitmap = Array.from({ length: 9 }, () => [3, 1, 0, 2])

  const result = await g.save(bitmap, { blockSleep: 0, type: dats.TYPE_IMAGE })

  expect(result).toMatchObject({ status: 'saved', reply: 'DATCPOK' })
  const payload = dats.encodeImage(bitmap)
  expect(payload.length).toBe(4 * 3)
  const start = t.to(p.CHAR_COMMAND)[0]
  expect([...p.body(start).subarray(4)]).toEqual([2, 0, payload.length])
  const rebuilt = t.to(p.CHAR_BULK_A).flatMap((b) => [...b.subarray(1, 1 + b[0])])
  expect(rebuilt).toEqual([...payload])
})

test('an unacknowledged DATS never reaches DATCP, so no flash is spent', async () => {
  const t = new MockTransport()
  t.answer = () => [reply('ERROR')]
  const g = await attach(t)

  const result = await g.save(panelBitmap('HI'), { blockSleep: 0 })

  expect(result.status).toBe('refused')
  expect(result.saves).toBe(0)
  expect(t.commands).toEqual(['DATS'])
  expect(t.to(p.CHAR_BULK_A)).toHaveLength(0)
})

test('a rejected save is still counted: the erases happened anyway', async () => {
  const t = datsDevice({ fail: true })
  const g = await attach(t)
  const result = await g.save(panelBitmap('HI'), { blockSleep: 0 })
  expect(result).toMatchObject({ status: 'saved', reply: 'ERROR', saves: 1 })
})

test('re-saving what the device already holds writes nothing at all', async () => {
  // No clock games: the duplicate rule is checked before the interval rule, so the
  // second save skips rather than throwing even though it lands immediately after.
  const t = datsDevice()
  const g = await attach(t)
  const bitmap = panelBitmap('HI')

  await g.save(bitmap, { blockSleep: 0 })
  const before = t.writes.length
  const again = await g.save(bitmap, { blockSleep: 0 })

  expect(again.status).toBe('skipped')
  expect(t.writes.length).toBe(before)
})

test('a save loop dies on the second iteration rather than wearing the flash', async () => {
  const t = datsDevice()
  const g = await attach(t)
  await g.save(panelBitmap('one'), { blockSleep: 0 })
  const before = t.writes.length

  // Different content, so this is the runaway case and not the duplicate one.
  const err = await g.save(panelBitmap('two'), { blockSleep: 0 }).catch((e) => e)
  expect(err).toBeInstanceOf(BudgetError)
  expect((err as BudgetError).rule).toBe('interval')
  expect(t.writes.length).toBe(before)
})

test('show sends only changed columns, and acks the last write of the frame', async () => {
  const t = new MockTransport()
  const g = await attach(t)

  const first = new Grid()
  first.set(4, 0)
  first.set(4, 1)
  await g.show(first, true)
  expect(t.to(p.CHAR_BULK_B)).toHaveLength(24)
  expect(t.writes.at(-1)!.withResponse).toBe(true)
  expect(t.writes.slice(0, -1).every((w) => !w.withResponse)).toBe(true)

  const second = first.clone()
  second.set(4, 5)
  const sent = await g.show(second)
  expect(sent).toBe(1)
  expect(t.to(p.CHAR_BULK_B)).toHaveLength(25)
})

test('probe reads stock as silence and crew as a HELLO reply', async () => {
  const stock = new MockTransport()
  const gStock = await attach(stock)
  expect(await gStock.probe(5)).toEqual({ kind: 'stock', name: 'GLASSES-TEST' })
  expect(opcodeOf(stock.to(p.CHAR_COMMAND)[0])).toBe('J')

  const crew = new MockTransport()
  crew.answer = () => [helloReply(2, 5)]
  const gCrew = await attach(crew)
  expect(await gCrew.probe(5)).toEqual({
    kind: 'crew',
    name: 'GLASSES-TEST',
    version: 2,
    capabilities: 5,
  })
})

test('end disconnects, and flushes with an acked write first', async () => {
  const t = new MockTransport()
  const g = await attach(t)
  await g.end('keep')
  expect(t.disconnected).toBe(true)
  expect(t.writes.at(-1)!.withResponse).toBe(true)
  // Teardown must not commit an upload: DATCP is a flash write, and it would put a
  // second caller on the choke point.
  expect(t.commands).not.toContain('DATCP')
})

/** What our firmware answers HELLO with: `[len][marker][type][ver16][caps16]`. */
function helloReply(version: number, capabilities: number): Uint8Array {
  const block = new Uint8Array(p.BLOCK_SIZE)
  const payload = [
    jgx.MARKER,
    jgx.MSG.HELLO_REPLY,
    version & 0xff,
    version >> 8,
    capabilities & 0xff,
    capabilities >> 8,
  ]
  block[0] = payload.length
  block.set(payload, 1)
  return block
}


test('live() hands out a sender on this connection, with the session cipher', async () => {
  const crew = p.cipher(new Uint8Array(16).fill(7))
  const t = new MockTransport(crew)
  const g = await Glasses.attach(t, 'JOGGLES-1234', { pacing: 0, cipher: crew })

  const sender = g.live({ pacing: 0 })
  sender.draw(4, 12)
  await sender.idle()

  // Decrypted with the crew key, so a sender that had defaulted to the vendor one
  // would write a frame whose column index is not 12 - which is how a mixed fleet
  // fails: no error anywhere, and a panel that simply does not change.
  const written = t.to(p.CHAR_BULK_B)
  expect(written).toHaveLength(1)
  expect(p.body(written[0])[0]).toBe(12)
})
