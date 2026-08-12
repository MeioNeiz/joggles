/**
 * What the phone puts on the wire down each of the three paths.
 *
 * The panel is the only real output this system has and no agent can see it, so the
 * alternative to these assertions is a person squinting at LEDs. They run on the
 * laptop against `core`'s mock device and check the wire - which opcodes, in which
 * order, with which argument bytes - because that is what the hardware silently
 * punishes.
 *
 * Three properties are worth more than the rest and each has its own test below:
 * **Show now sends no DATS at all**, **a cancelled upload never reaches DATCP**, and
 * **a type 2 delivery never sends MODE**. Those are the three ways this file could
 * spend flash or destroy content while reporting success.
 */
import {
  Glasses,
  LiveSender,
  budget,
  content,
  dats,
  protocol as p,
  playlist,
} from '@joggles/core'
import { MockTransport, datsDevice, reply } from '@joggles/core/src/mock-transport.js'
import { expect, test } from 'bun:test'
import {
  ERASES_PER_SAVE,
  costOf,
  deliver,
  greyChoice,
  problems,
  showNow,
  typeFor,
} from './deliver.js'

const attach = (t: MockTransport) =>
  Glasses.attach(t, 'GLASSES-TEST', { pacing: 0, budget: undefined })

/** Every opcode this file sends. Longest first, so `DATS` cannot shadow `DATSOK`. */
const OPCODES = ['DATCP', 'DATS', 'SPEED', 'MODE', 'SMVEW', 'LEDON', 'CLRL', 'STYPE']

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

const grey = (): content.Content =>
  content.text('HI', { kind: 'static' }, { level: 2 })

test('a scrolling message is committed, then SPEED, then MODE 02', async () => {
  const t = datsDevice()
  const g = await attach(t)
  const piece = content.text('HELLO WORLD', { kind: 'scroll', dir: 1, speed: 85 })

  const out = await deliver(g, piece, { blockSleep: 0 })

  expect(out).toMatchObject({ status: 'saved', reply: 'DATCPOK', showing: true })
  expect(out.cost).toMatchObject({ erases: ERASES_PER_SAVE, persists: true, type: 1 })
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
  // Type 1, because that is what a message with no grey in it resolves to.
  expect(start[4]).toBe(dats.TYPE_TEXT)
})

test('an unacknowledged DATS never reaches MODE, so nothing stale is displayed', async () => {
  const t = new MockTransport()
  t.answer = () => [reply('ERROR')]
  const g = await attach(t)

  const out = await deliver(g, content.text('HI'), { blockSleep: 0 })

  expect(out).toMatchObject({ status: 'refused', showing: false, cancelled: false })
  expect(opsOf(t)).toEqual(['DATS'])
  expect(t.to(p.CHAR_BULK_A)).toHaveLength(0)
})

/**
 * The commit the device threw away, which used to be displayed anyway.
 *
 * `DATS` is acknowledged, every block goes out, and `DATCP` comes back `ERROR`: a
 * dropped block or a payload the device would not take. The five erases were spent at
 * its end, so the ledger counts them - and the store now holds whatever survived that,
 * which is not this text. A `MODE` here switches the panel to that store and reads,
 * to anyone watching, as this save having worked.
 *
 * Found by track 13 and pinned in `effects-ui/deliver-wide.test.ts` for the wide-loop
 * path; this is the same fix from the text path, where `SPEED` is in the sequence too
 * and must be no more sent than the `MODE` it precedes.
 */
test('a commit the device answered ERROR to sends neither SPEED nor MODE', async () => {
  const t = datsDevice({ fail: true })
  const g = await attach(t)
  const piece = content.text('HELLO WORLD', { kind: 'scroll', dir: 0, speed: 50 })

  const out = await deliver(g, piece, { blockSleep: 0 })

  expect(out).toMatchObject({
    status: 'saved',
    reply: 'ERROR',
    committed: false,
    showing: false,
    cancelled: false,
  })
  // Counted, because the erases happened whatever the panel is showing.
  expect(out.saves).toBe(1)
  expect(out.cost.erases).toBe(ERASES_PER_SAVE)
  expect(opsOf(t)).toEqual(['DATS', 'DATCP'])
})

test('a type 2 image the device rejected is not reported as showing', async () => {
  // Type 2 displays itself on `DATCPOK` and gets no `MODE` at all, so the only thing
  // this path can get wrong is the claim. `ERROR` means nothing displayed itself.
  const t = datsDevice({ fail: true })
  const g = await attach(t)

  const out = await deliver(g, grey(), { blockSleep: 0, grey: 'keep' })

  expect(out).toMatchObject({ status: 'saved', committed: false, showing: false })
  expect(opsOf(t)).toEqual(['DATS', 'DATCP'])
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

/**
 * A drawing in the middle of an evening, which used to cost five page erases.
 *
 * The Draw screen's greyscale send is a type 2, which writes no flash and leaves the
 * type 1 store exactly where it was (*verified*, track 5). Until `SaveRecord` carried
 * its DATS type, the guard compared against the last acknowledged save of any type, so
 * the drawing made the resident text look like new content and going back to it
 * re-erased five pages to store what the glasses were already holding.
 *
 * The whole redesign's "on the glasses" badge and its free `MODE` return route read
 * the same records (`playlist.residentHash`), so before this they lost the pair's
 * residency to any drawing too.
 */
test('a type 2 drawing between two shows of one message costs no second save', async () => {
  const t = datsDevice()
  let now = 1_000_000
  const guard = new budget.FlashBudget(budget.memoryStore(), () => now)
  const g = await Glasses.attach(t, 'GLASSES-TEST', { pacing: 0, budget: guard })
  const piece = content.text('HELLO WORLD', { kind: 'scroll', dir: 0, speed: 50 })

  await deliver(g, piece, { blockSleep: 0 })
  now += 60_000
  await deliver(g, { ...grey(), route: 'saved' }, { blockSleep: 0, grey: 'keep' })
  now += 60_000
  const back = await deliver(g, piece, { blockSleep: 0 })

  expect(back.status).toBe('skipped')
  expect(back.showing).toBe(true)
  // Two DATCP on the wire, both of them content the device did not already have.
  expect(opsOf(t).filter((op) => op === 'DATCP')).toHaveLength(2)
  expect(playlist.residentHash(await g.ledger())).toBe(
    budget.fingerprint(content.encodeSaved(piece).payload, dats.TYPE_TEXT),
  )
})

test('over-long text is refused against the type 1 ceiling, in bytes', () => {
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

// --- Grey: a question with two answers, where it used to be a refusal ---

test('grey content offers both answers, each with its own cost', () => {
  const choice = greyChoice(grey())
  expect(choice).not.toBeNull()
  expect(choice?.flatten).toMatchObject({ erases: ERASES_PER_SAVE, persists: true })
  expect(choice?.keep).toMatchObject({ erases: 0, persists: false })
  expect(choice?.blocked).toEqual({ flatten: [], keep: [] })
  // The part the device will never report: dim comes back full, not dim.
  expect(choice?.loses).toMatch(/full brightness/)
})

test('content with no grey in it is not a question', () => {
  expect(greyChoice(content.text('HI'))).toBeNull()
  expect(typeFor(content.text('HI'), 'keep')).toBe(dats.TYPE_TEXT)
})

test('flattening grey sends type 1 and one bit per pixel', async () => {
  const t = datsDevice()
  const g = await attach(t)

  const out = await deliver(g, grey(), { blockSleep: 0, grey: 'flatten' })

  expect(out).toMatchObject({ status: 'saved', showing: true })
  expect(out.cost.persists).toBe(true)
  expect(p.body(t.to(p.CHAR_COMMAND)[0])[4]).toBe(dats.TYPE_TEXT)
  expect(opsOf(t)).toEqual(['DATS', 'DATCP', 'MODE'])
})

test('flattening loses the grey on the wire, whatever level it was', async () => {
  // The host half of `greyChoice().loses`, and the only half that can be checked here:
  // a dim message and a bright one become the same bytes, so the level a dim pixel comes
  // back at is entirely the device's LUT and nothing the phone can influence. Asserted
  // through `deliver()` rather than against `encodeBitmap`, because the claim is about
  // this path: nothing on it calls `content.flatten`, so its threshold is not the lever.
  const bytes = async (level: number): Promise<string> => {
    const t = datsDevice()
    const g = await attach(t)
    await deliver(g, content.text('HI', { kind: 'static' }, { level }), {
      blockSleep: 0,
      grey: 'flatten',
    })
    return t
      .to(p.CHAR_BULK_A)
      .map((b) => [...b].join(','))
      .join('|')
  }

  expect(await bytes(1)).toBe(await bytes(3))
  expect(await bytes(2)).toBe(await bytes(3))
})

test('a cancelled upload leaves the ledger with no record of a save', async () => {
  // The half `opsOf` cannot see. `DATCP` is what spends the erases and what the budget
  // counts, so an abandoned upload must move neither: a phantom record would inflate the
  // one wear number that exists, and `lifetime` is printed on the screen.
  const t = datsDevice()
  const guard = new budget.FlashBudget(budget.memoryStore())
  const g = await Glasses.attach(t, 'GLASSES-TEST', { pacing: 0, budget: guard })
  const piece = content.text('HELLO WORLD HELLO WORLD')

  const out = await deliver(g, piece, {
    blockSleep: 0,
    cancel: () => t.to(p.CHAR_BULK_A).length >= 2,
  })
  const after = await guard.ledger('GLASSES-TEST')

  expect(out).toMatchObject({ status: 'refused', cancelled: true, saves: 0 })
  expect(after).toMatchObject({ lifetime: 0, last: null, window: [], recent: [] })

  // The three-second interval IS spent, deliberately: `allow()` runs before the first
  // block, and a cancel that handed it back would let a loop cancel out of the limit.
  await expect(deliver(g, piece, { blockSleep: 0 })).rejects.toThrow(budget.BudgetError)
})

test('keeping grey sends type 2 and never sends MODE', async () => {
  const t = datsDevice()
  const g = await attach(t)

  const out = await deliver(g, grey(), { blockSleep: 0, grey: 'keep' })

  expect(out).toMatchObject({ status: 'saved', showing: true })
  expect(out.cost).toMatchObject({ erases: 0, persists: false, type: dats.TYPE_IMAGE })
  expect(p.body(t.to(p.CHAR_COMMAND)[0])[4]).toBe(dats.TYPE_IMAGE)
  // The whole point: MODE is what would discard the image it just displayed.
  expect(opsOf(t)).toEqual(['DATS', 'DATCP'])
})

test('a scrolling grey message cannot keep its grey, because MODE 02 discards it', () => {
  const piece = content.text('HI', { kind: 'scroll', dir: 0, speed: 50 }, { level: 2 })
  expect(problems(piece, 'saved', 'keep')).toContain(
    'a type 2 image cannot scroll: MODE 02 is what discards it',
  )
  expect(problems(piece, 'saved', 'flatten')).toEqual([])
  expect(greyChoice(piece)?.blocked.keep).toHaveLength(1)
})

// --- Cancel: free right up to the last write ---

test('cancelling mid-upload never sends DATCP, so it costs no erases', async () => {
  const t = datsDevice()
  const g = await attach(t)
  const piece = content.text('HELLO WORLD HELLO WORLD')
  const blocks = dats.chunkPayload(content.encodeSaved(piece).payload).length

  // The finger lands with two blocks out. The check runs before each write, so this
  // aborts before the third rather than after the stream has finished.
  const out = await deliver(g, piece, {
    blockSleep: 0,
    cancel: () => t.to(p.CHAR_BULK_A).length >= 2,
  })

  expect(out).toMatchObject({ status: 'refused', cancelled: true, showing: false })
  expect(out.reply).toMatch(/no flash was written/)
  expect(opsOf(t)).toEqual(['DATS'])
  expect(t.to(p.CHAR_BULK_A)).toHaveLength(2)
  expect(blocks).toBeGreaterThan(2)
})

test('a cancel that arrives after the last block still beats DATCP', async () => {
  const t = datsDevice()
  const g = await attach(t)
  const piece = content.text('HI')
  const blocks = dats.chunkPayload(content.encodeSaved(piece).payload).length

  // False before every block, true only on the check that runs once the stream is
  // done. That second check is the only thing standing between here and five erases.
  const out = await deliver(g, piece, {
    blockSleep: 0,
    cancel: () => t.to(p.CHAR_BULK_A).length === blocks,
  })

  expect(out).toMatchObject({ status: 'refused', cancelled: true })
  expect(opsOf(t)).toEqual(['DATS'])
  expect(t.to(p.CHAR_BULK_A)).toHaveLength(blocks)
})

test('a cancel nobody pressed changes nothing', async () => {
  const t = datsDevice()
  const g = await attach(t)

  const out = await deliver(g, content.text('HI'), { blockSleep: 0, cancel: () => false })

  expect(out).toMatchObject({ status: 'saved', cancelled: false })
  expect(opsOf(t)).toEqual(['DATS', 'DATCP', 'MODE'])
})

// --- Show now: the free path, and the wire proves it is free ---

test('Show now writes columns and no DATS, no DATCP, no MODE', async () => {
  const t = new MockTransport()
  const g = await attach(t)
  await g.begin()
  const sender = g.live({ sleep: async () => {} })

  const cost = await showNow(sender, { ...content.text('HI'), route: 'live' })
  await sender.stop()

  expect(cost).toMatchObject({ erases: 0, persists: false, type: null })
  // SMVEW and LEDON are begin()'s, STYPE is the sender's ack. Nothing that saves.
  expect(opsOf(t)).not.toContain('DATS')
  expect(opsOf(t)).not.toContain('DATCP')
  expect(opsOf(t)).not.toContain('MODE')
  expect(t.to(p.CHAR_BULK_A)).toHaveLength(0)
  // The live route is 24 columns on 960b, and only the lit ones need writing.
  expect(t.to(p.CHAR_BULK_B).length).toBeGreaterThan(0)
  expect(t.to(p.CHAR_BULK_B).length).toBeLessThanOrEqual(24)
})

test('Show now refuses a scroll rather than sending the MODE that would discard it', async () => {
  const t = new MockTransport()
  const g = await attach(t)
  const sender = g.live({ sleep: async () => {} })
  const piece = content.text('HI', { kind: 'scroll', dir: 0, speed: 50 })

  await expect(showNow(sender, piece)).rejects.toThrow(/discards the live buffer/)
  expect(t.writes).toHaveLength(0)
})

test('Show now refuses content wider than the panel, which the firmware would drop', async () => {
  const t = new MockTransport()
  const g = await attach(t)
  const sender = g.live({ sleep: async () => {} })

  await expect(showNow(sender, content.text('A LONG MESSAGE'))).rejects.toThrow(
    /live route holds 24 columns/,
  )
  expect(t.writes).toHaveLength(0)
})

test('the free path and the flash path do not describe themselves the same way', () => {
  const piece = content.text('HI')
  const free = costOf(piece, 'live')
  const flash = costOf(piece, 'saved')
  expect(free.words).not.toBe(flash.words)
  expect(free.erases).toBe(0)
  expect(flash.erases).toBe(ERASES_PER_SAVE)
  // Whatever the wording, the two facts a person needs are the erase count and
  // whether it survives the power going off, and they differ on both.
  expect(free.persists).toBe(false)
  expect(flash.persists).toBe(true)
})
