import { Glasses, protocol as p } from '@joggles/core'
import { MockTransport, opcodeOf } from '@joggles/core/src/mock-transport.js'
import { expect, test } from 'bun:test'
import { PanelSession } from './panel-session.js'

const attach = (t: MockTransport) =>
  Glasses.attach(t, 'GLASSES-TEST', { pacing: 0, budget: undefined })

const commands = (t: MockTransport): string[] => t.to(p.CHAR_COMMAND).map(opcodeOf)

test('two racing callers share one begin: SMVEW 01 goes out once, one sender exists', async () => {
  const t = new MockTransport()
  const g = await attach(t)
  const session = new PanelSession(g, () => {})

  const [a, b] = await Promise.all([session.live(), session.live()])
  expect(a).toBe(b)
  expect(commands(t).filter((op) => op === 'SMVEW').length).toBe(1)
})

test('a later caller gets the same sender, not a second one', async () => {
  const t = new MockTransport()
  const g = await attach(t)
  const session = new PanelSession(g, () => {})

  const first = await session.live()
  const second = await session.live()
  expect(second).toBe(first)
  expect(commands(t).filter((op) => op === 'SMVEW').length).toBe(1)
})

test('dropped() forgets the sender, and the next live() begins DIY afresh', async () => {
  const t = new MockTransport()
  const g = await attach(t)
  const session = new PanelSession(g, () => {})

  const first = await session.live()
  expect(session.holding).toBe(true)
  session.dropped()
  expect(session.holding).toBe(false)

  const second = await session.live()
  expect(second).not.toBe(first)
  // A MODE discarded the buffer on the device, so the fresh sender must start from a
  // fresh SMVEW 01: repairing against the old believed-sent grid is the forbidden state.
  expect(commands(t).filter((op) => op === 'SMVEW').length).toBe(2)
})

test('end() stops the pump and survives being called twice', async () => {
  const t = new MockTransport()
  const g = await attach(t)
  const session = new PanelSession(g, () => {})

  const sender = await session.live()
  await session.end()
  expect(sender.stopped).toBe(true)
  expect(session.holding).toBe(false)
  await session.end()
})

test('a failed begin() does not wedge the session: the next live() retries', async () => {
  const t = new MockTransport()
  const g = await attach(t)
  const session = new PanelSession(g, () => {})

  const write = t.write.bind(t)
  t.write = () => Promise.reject(new Error('link died'))
  await expect(session.live()).rejects.toThrow('link died')

  t.write = write
  const sender = await session.live()
  expect(sender.stopped).toBe(false)
})
