/**
 * What the phone puts on the wire when someone taps Save.
 *
 * The panel is the only real output this system has and no agent can see it, so the
 * alternative to these assertions is a person squinting at LEDs. They run on the
 * laptop against `core`'s mock device and check the wire - which opcodes, in which
 * order, with which argument bytes - because that is what the hardware silently
 * punishes.
 */
import { Glasses, content, dats, protocol as p } from '@joggles/core'
import { MockTransport, datsDevice, reply } from '@joggles/core/src/mock-transport.js'
import { expect, test } from 'bun:test'
import { deliver, problems } from './deliver.js'

const attach = (t: MockTransport) =>
  Glasses.attach(t, 'GLASSES-TEST', { pacing: 0, budget: undefined })

/** Every opcode this file sends. Longest first, so `DATS` cannot shadow `DATSOK`. */
const OPCODES = ['DATCP', 'DATS', 'SPEED', 'MODE']

/**
 * Opcodes on the command channel, in order.
 *
 * Not `MockTransport.commands`, and the reason is a trap worth keeping: that helper
 * reads the leading run of capitals, so an argument byte that happens to be an
 * uppercase letter runs straight into the opcode. `SPEED 85` is `0x55`, which is
 * `U`, and it reads back as `SPEEDU`. Matching against a known list instead means
 * the arguments below can stay realistic.
 */
const opsOf = (t: MockTransport): string[] =>
  t.to(p.CHAR_COMMAND).map((f) => {
    const ascii = String.fromCharCode(...p.body(f))
    return OPCODES.find((op) => ascii.startsWith(op)) ?? ascii
  })

/** Argument bytes of the first frame carrying this opcode. */
const argsOf = (t: MockTransport, opcode: string): number[] => {
  const frame = t
    .to(p.CHAR_COMMAND)
    .find((f) => String.fromCharCode(...p.body(f)).startsWith(opcode))
  if (!frame) throw new Error(`no ${opcode} on the command channel`)
  return [...p.body(frame).subarray(opcode.length)]
}

test('a scrolling message is committed, then SPEED, then MODE 02', async () => {
  const t = datsDevice()
  const g = await attach(t)
  const piece = content.text('HELLO WORLD', { kind: 'scroll', dir: 1, speed: 85 })

  const out = await deliver(g, piece, { blockSleep: 0 })

  expect(out).toMatchObject({ status: 'saved', reply: 'DATCPOK', showing: true })
  expect(opsOf(t)).toEqual(['DATS', 'DATCP', 'SPEED', 'MODE'])
  expect(argsOf(t, 'SPEED')).toEqual([85])
  // Kind 2 is horizontal. `protocol.scrollLeft` used to build MODE 03, the vertical
  // bounce, which is why the mode bytes are asserted rather than trusted.
  expect(argsOf(t, 'MODE')).toEqual([2, 1])
})

test('a static message sends MODE 01 and no SPEED', async () => {
  const t = datsDevice()
  const g = await attach(t)

  await deliver(g, content.text('HI'), { blockSleep: 0 })

  expect(opsOf(t)).toEqual(['DATS', 'DATCP', 'MODE'])
  expect(argsOf(t, 'MODE')).toEqual([1, 0])
})

test('the announced length matches the bytes actually streamed', async () => {
  const t = datsDevice()
  const g = await attach(t)
  const piece = content.text('JOGGLES', { kind: 'scroll', dir: 0, speed: 50 })

  await deliver(g, piece, { blockSleep: 0 })

  const start = p.body(t.to(p.CHAR_COMMAND)[0])
  const announced = (start[5] << 8) | start[6]
  const streamed = t.to(p.CHAR_BULK_A).reduce((n, b) => n + b[0], 0)
  expect(announced).toBe(streamed)
  // Type 1, because that is what `session.save()` sends and what `problems` pins.
  expect(start[4]).toBe(dats.TYPE_TEXT)
})

test('an unacknowledged DATS never reaches MODE, so nothing stale is displayed', async () => {
  const t = new MockTransport()
  t.answer = () => [reply('ERROR')]
  const g = await attach(t)

  const out = await deliver(g, content.text('HI'), { blockSleep: 0 })

  expect(out).toMatchObject({ status: 'refused', showing: false })
  expect(opsOf(t)).toEqual(['DATS'])
  expect(t.to(p.CHAR_BULK_A)).toHaveLength(0)
})

test('re-sending the same text writes no flash but still re-sends MODE', async () => {
  const t = datsDevice()
  const g = await attach(t)
  const piece = content.text('HI', { kind: 'scroll', dir: 0, speed: 50 })
  await deliver(g, piece, { blockSleep: 0 })
  const streamed = t.to(p.CHAR_BULK_A).length

  // The interval rule would throw at this rate; a duplicate is checked first and
  // skips, because writing flash to store what is already stored is the thing worth
  // avoiding. Changing only the direction must therefore stay free.
  const again = await deliver(
    g,
    content.text('HI', { kind: 'scroll', dir: 1, speed: 50 }),
    { blockSleep: 0 },
  )

  expect(again).toMatchObject({ status: 'skipped', showing: true })
  expect(opsOf(t)).toEqual(['DATS', 'DATCP', 'SPEED', 'MODE', 'SPEED', 'MODE'])
  // No second DATS, no second block, no second DATCP: the whole of the flash cost.
  expect(t.to(p.CHAR_BULK_A)).toHaveLength(streamed)
  expect(argsOf(t, 'MODE')).toEqual([2, 0])
})

test('grey content is refused rather than silently flattened', async () => {
  const piece = content.text('HI', { kind: 'static' }, { level: 2 })
  expect(content.savedType(piece)).toBe(dats.TYPE_IMAGE)
  expect(problems(piece)[0]).toMatch(/type 2/)
})

test('over-long text is refused against the type 1 ceiling, in bytes', async () => {
  const piece = content.text('X'.repeat(400))
  const cols = content.width(piece.bitmap)
  expect(cols * 2).toBeGreaterThan(content.MAX_SAVED_BYTES)
  expect(problems(piece)[0]).toMatch(/saved route holds/)
})

test('refusing throws before anything is written', async () => {
  const t = datsDevice()
  const g = await attach(t)

  await expect(deliver(g, content.text('X'.repeat(400)))).rejects.toThrow(/saved route/)
  expect(t.writes).toHaveLength(0)
})
