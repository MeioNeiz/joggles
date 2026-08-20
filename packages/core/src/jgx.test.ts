import { describe, expect, test } from 'bun:test'
import * as jgx from './jgx.js'
import * as p from './protocol.js'

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

describe('the HELLO request', () => {
  test('is a normal command frame with our opcode', () => {
    // [len][J][sub][ver_lo][ver_hi], padded to one AES block.
    expect(hex(jgx.hello(1))).toBe('044a0001000000000000000000000000')
  })

  test('satisfies the dispatcher length gate, which rejects under 4', () => {
    expect(jgx.hello()[0]).toBeGreaterThanOrEqual(4)
    expect(jgx.hello()[0]).toBeLessThanOrEqual(20)
  })

  test('carries the sub-command where the trampoline reads it', () => {
    // The handler does ldrb r0, [r4, #3], and the struct's frame starts at r4+1,
    // so the sub-command is wire index 2.
    expect(jgx.hello()[2]).toBe(jgx.SUB.HELLO)
  })

  test('the opcode is not one the stock dispatcher already matches', () => {
    expect('DSLAMCI').not.toContain(jgx.OPCODE)
  })
})

describe('parsing notifications', () => {
  const reply = (...payload: number[]) => {
    const block = new Uint8Array(16)
    block[0] = payload.length
    block.set(payload, 1)
    return block
  }

  test('a HELLO reply yields version and capabilities', () => {
    const msg = jgx.parseNotification(reply(jgx.MARKER, jgx.MSG.HELLO_REPLY, 2, 0, 5, 0))
    expect(msg).toEqual({ type: 'hello', version: 2, capabilities: 5 })
  })

  test('16-bit fields are little-endian', () => {
    const msg = jgx.parseNotification(reply(jgx.MARKER, 0x00, 0x34, 0x12, 0x02, 0x01))
    expect(msg).toMatchObject({ version: 0x1234, capabilities: 0x0102 })
  })

  test("the vendor's own replies are not mistaken for ours", () => {
    const datsok = new Uint8Array(16)
    const text = 'DATSOK'
    datsok[0] = text.length
    for (let i = 0; i < text.length; i++) datsok[i + 1] = text.charCodeAt(i)
    expect(jgx.parseNotification(datsok)).toBeNull()
  })

  test('an unknown message type is ignored rather than guessed at', () => {
    expect(jgx.parseNotification(reply(jgx.MARKER, 0x7f, 1, 2, 3, 4))).toBeNull()
  })

  test('a truncated HELLO reply is refused', () => {
    expect(jgx.parseNotification(reply(jgx.MARKER, jgx.MSG.HELLO_REPLY, 1))).toBeNull()
  })

  test('a length past the 15-byte ceiling is refused', () => {
    const block = new Uint8Array(16)
    block[0] = 16
    block[1] = jgx.MARKER
    expect(jgx.parseNotification(block)).toBeNull()
  })

  test('an empty frame is refused', () => {
    expect(jgx.parseNotification(new Uint8Array(16))).toBeNull()
  })
})

describe('capabilities', () => {
  test('a v1 unit declares only the session family', () => {
    expect(jgx.capabilityNames(jgx.CAP.SESSION)).toEqual(['SESSION'])
  })

  test('a bitmap decomposes into every family it sets', () => {
    const bits = jgx.CAP.SESSION | jgx.CAP.INPUT
    expect(jgx.capabilityNames(bits)).toEqual(['SESSION', 'INPUT'])
    expect(jgx.supports(bits, jgx.CAP.INPUT)).toBe(true)
    expect(jgx.supports(bits, jgx.CAP.SYNC)).toBe(false)
  })

  test('an unknown future family does not break the known ones', () => {
    expect(jgx.capabilityNames(jgx.CAP.SESSION | 0x8000)).toEqual(['SESSION'])
  })
})

describe('two keys, because the fleet is mixed', () => {
  test('the vendor cipher is what the module-level helpers use', () => {
    const f = p.enterDIY()
    expect(p.encrypt(f)).toEqual(p.cipher(p.VENDOR_KEY).encrypt(f))
  })

  test('a crew key round-trips independently of the vendor key', () => {
    const crew = p.cipher(new Uint8Array(16).fill(0x5a))
    const f = jgx.hello()
    expect(crew.decrypt(crew.encrypt(f))).toEqual(f)
    expect(crew.encrypt(f)).not.toEqual(p.encrypt(f))
  })

  test('the wrong key makes a unit look like it never answered', () => {
    // This is the failure mode `bun cli probe` warns about: a crew unit read with
    // the vendor key decrypts to noise, which parses as nothing at all.
    const crew = p.cipher(new Uint8Array(16).fill(0x5a))
    const block = new Uint8Array(16)
    block[0] = 6
    block.set([jgx.MARKER, jgx.MSG.HELLO_REPLY, 1, 0, 1, 0], 1)
    expect(jgx.parseNotification(p.decrypt(crew.encrypt(block)))).toBeNull()
  })
})

// --- The contract the slot features have to hit ------------------------------------
//
// Nothing below has been answered by a unit: these are tests of the client half of a
// wire format, and of the four rules a new sub-command can break silently.

/** Every command frame this module builds, so a rule can be asserted over all of them. */
const EVERY_COMMAND: ReadonlyArray<[string, Uint8Array]> = [
  ['hello', jgx.hello()],
  ['updBegin', jgx.updBegin(64, 0xdeadbeef)],
  ['updData', jgx.updData(3, new Uint8Array(8).fill(7))],
  ['updEnd', jgx.updEnd()],
  ['updAbort', jgx.updAbort()],
  ['updStatus', jgx.updStatus()],
  ['tickAsk', jgx.tickAsk()],
  ['tickSet', jgx.tickSet(100)],
  ['seedAsk', jgx.seedAsk()],
  ['seedSet', jgx.seedSet(0x12345678)],
  ['tileDefine', jgx.tileDefine(12, [0, 1, 2, 3])],
  ['tileFrame', jgx.tileFrame(new Array(24).fill(15))],
  ['smoothAsk', jgx.smoothAsk()],
  ['smoothSet', jgx.smoothSet(4)],
  ['buttonAsk', jgx.buttonAsk()],
  ['buttonSet', jgx.buttonSet(jgx.BTN_FLAGS)],
  ['batteryAsk', jgx.batteryAsk()],
]

describe('the dispatcher gate, which drops a short frame in silence', () => {
  test('every command sits inside the 4-to-20 window, and inside one AES block', () => {
    for (const [name, f] of EVERY_COMMAND) {
      expect(f.length, name).toBe(p.BLOCK_SIZE)
      expect(f[0], name).toBeGreaterThanOrEqual(jgx.MIN_BODY)
      expect(f[0], name).toBeLessThanOrEqual(jgx.MAX_BODY)
    }
  })

  test('the three no-argument update commands are padded, not two bytes long', () => {
    // Built with `protocol.frame` these are 2-byte bodies, which the gate at
    // `abs 0x18268` drops before the `J` compare is reached, so an update would hang
    // on its commit with nothing on the wire to say why.
    for (const f of [jgx.updEnd(), jgx.updAbort(), jgx.updStatus()]) {
      expect(f[0]).toBe(4)
      expect([...f.subarray(3, 5)]).toEqual([0, 0])
    }
  })

  test('a frame under the lower bound is refused by our own decoder too', () => {
    const short = p.frame(jgx.OPCODE, jgx.SUB.UPD_END)
    expect(short[0]).toBe(2)
    expect(jgx.parseCommand(short)).toBeNull()
  })

  test('padding is invisible to a handler that reads its own arguments', () => {
    expect(jgx.parseCommand(jgx.tickSet(50))).toEqual({
      sub: jgx.SUB.TICK,
      args: new Uint8Array([jgx.SET, 50]),
    })
  })
})

describe('one channel, because 960b would make a stock unit react', () => {
  test('every J frame goes to the command characteristic', () => {
    expect(jgx.CHANNEL).toBe(p.CHAR_COMMAND)
    expect(jgx.CHANNEL).not.toBe(p.CHAR_BULK_B)
  })

  test('every frame is a length a stock 960b handler would act on', () => {
    // Not a hypothetical: on 960b, 6 to 20 bytes reaches the rhythm arm and draws
    // bars, and 4 to 5 reaches the single column store and writes a garbage column.
    // There is no length that a stock unit would ignore, which is why the channel is
    // a constant here rather than a caller's choice.
    for (const [name, f] of EVERY_COMMAND) {
      expect(f[0], name).toBeGreaterThanOrEqual(4) //   4-5: the column store
      expect(f[0], name).toBeLessThanOrEqual(20) //     6-20: the rhythm arm
    }
  })
})

describe('the sub-command families', () => {
  const ALL = Object.entries(jgx.SUB) as Array<[string, number]>

  test('every id is inside a reserved family, and none has reached 0x40', () => {
    for (const [name, sub] of ALL) {
      expect(jgx.familyOf(sub), name).not.toBeNull()
      expect(sub, name).toBeLessThan(0x40)
    }
    expect(jgx.familyOf(0x40)).toBeNull()
  })

  test('each feature sits in the family its behaviour belongs to', () => {
    expect(jgx.familyOf(jgx.SUB.TICK)).toBe(jgx.CAP.SESSION)
    expect(jgx.familyOf(jgx.SUB.SEED)).toBe(jgx.CAP.SYNC)
    expect(jgx.familyOf(jgx.SUB.TILE_DEF)).toBe(jgx.CAP.CONTENT)
    expect(jgx.familyOf(jgx.SUB.TILE_FRAME)).toBe(jgx.CAP.CONTENT)
    expect(jgx.familyOf(jgx.SUB.SMOOTH)).toBe(jgx.CAP.CONTENT)
    expect(jgx.familyOf(jgx.SUB.BUTTON)).toBe(jgx.CAP.INPUT)
    expect(jgx.familyOf(jgx.SUB.BATTERY)).toBe(jgx.CAP.INPUT)
  })

  test('nothing that already exists has been renumbered', () => {
    // These six are resident, i.e. rewritable by probe only, so a renumbering here
    // would be undoable over the air.
    expect(jgx.SUB.HELLO).toBe(0x00)
    expect(jgx.SUB.UPD_BEGIN).toBe(0x01)
    expect(jgx.SUB.UPD_DATA).toBe(0x02)
    expect(jgx.SUB.UPD_END).toBe(0x03)
    expect(jgx.SUB.UPD_ABORT).toBe(0x04)
    expect(jgx.SUB.UPD_STATUS).toBe(0x05)
    expect(jgx.MSG.HELLO_REPLY).toBe(0x00)
    expect(jgx.MSG.UPD_REPLY).toBe(0x01)
  })

  test('no two sub-commands share an id, and every one is licensed by a bit', () => {
    const ids = ALL.map(([, sub]) => sub)
    expect(new Set(ids).size).toBe(ids.length)
    for (const [name, sub] of ALL) {
      expect(jgx.SUB_CAP[sub], name).toBeGreaterThan(0)
    }
  })
})

describe('mixed-fleet capability negotiation, both directions', () => {
  const V1 = jgx.CAP.SESSION | jgx.CAP.UPDATE
  const V2 = V1 | jgx.CAP.SYNC | jgx.CAP.CONTENT | jgx.CAP.INPUT
    | jgx.CAP.BUTTON | jgx.CAP.BATTERY | jgx.CAP.SEED | jgx.CAP.TILES
    | jgx.CAP.SMOOTH | jgx.CAP.TICK

  const reply = (...payload: number[]) => {
    const block = new Uint8Array(16)
    block[0] = payload.length
    block.set(payload, 1)
    return block
  }

  test('a new app meeting a v1 unit sends only what that unit answers', () => {
    expect(jgx.permits(V1, jgx.SUB.HELLO)).toBe(true)
    expect(jgx.permits(V1, jgx.SUB.UPD_BEGIN)).toBe(true)
    for (const sub of [jgx.SUB.TICK, jgx.SUB.SEED, jgx.SUB.TILE_DEF,
      jgx.SUB.TILE_FRAME, jgx.SUB.SMOOTH, jgx.SUB.BUTTON, jgx.SUB.BATTERY]) {
      expect(jgx.permits(V1, sub)).toBe(false)
    }
  })

  test('and on a v2 unit every one of them is licensed', () => {
    for (const sub of Object.values(jgx.SUB)) {
      expect(jgx.permits(V2, sub)).toBe(true)
    }
  })

  test('a family bit alone licenses nothing, and is malformed as well', () => {
    // The rule, stated once: a family bit summarises its members and never stands
    // for one. So `permits` reads the feature bit, and the coarse bit on its own is
    // a unit claiming a family with nothing in it.
    expect(jgx.permits(jgx.CAP.INPUT, jgx.SUB.BUTTON)).toBe(false)
    expect(jgx.permits(jgx.CAP.INPUT, jgx.SUB.BATTERY)).toBe(false)
    expect(jgx.capabilityProblems(jgx.CAP.SESSION | jgx.CAP.INPUT))
      .toEqual(['INPUT is set with no member: it summarises BUTTON, BATTERY'])
  })

  test('and a feature bit is trusted even when its family bit is missing', () => {
    // Deliberate: a build that advertises BUTTON without INPUT does answer the
    // sub-command, and refusing to speak to it would turn a firmware build error
    // into a dead feature in a field. The problem is named, not enforced.
    const malformed = jgx.CAP.SESSION | jgx.CAP.BUTTON
    expect(jgx.permits(malformed, jgx.SUB.BUTTON)).toBe(true)
    expect(jgx.capabilityProblems(malformed))
      .toEqual(['BUTTON without INPUT: a feature bit obliges its family bit'])
  })

  test('a well-formed bitmap has nothing to say, in either fleet direction', () => {
    expect(jgx.capabilityProblems(V1)).toEqual([])
    expect(jgx.capabilityProblems(V2)).toEqual([])
    expect(jgx.capabilityProblems(0)).toEqual([])
    for (const sub of Object.values(jgx.SUB)) {
      const one = jgx.CAP.SESSION | jgx.SUB_CAP[sub]! | jgx.familyOf(sub)!
      expect(jgx.capabilityProblems(one), sub.toString(16)).toEqual([])
      expect(jgx.permits(one, sub)).toBe(true)
    }
  })

  test('the family bits a unit owes are computable from its features', () => {
    expect(jgx.familyBitsFor(jgx.CAP.SEED)).toBe(jgx.CAP.SYNC)
    expect(jgx.familyBitsFor(jgx.CAP.TILES | jgx.CAP.BATTERY))
      .toBe(jgx.CAP.CONTENT | jgx.CAP.INPUT)
    expect(jgx.familyBitsFor(jgx.CAP.UPDATE)).toBe(jgx.CAP.SESSION)
    expect(jgx.familyBitsFor(V2) & V2).toBe(jgx.familyBitsFor(V2))
  })

  test('no capability bit is orphaned, and no family is empty', () => {
    // What fails the build if a bit and its members get out of step: a CAP entry
    // that licenses nothing and is not a family, or a family with no sub-command in
    // its range. Either one is a bitmap nobody can act on.
    const licences = new Set(Object.values(jgx.SUB).map((sub) => jgx.SUB_CAP[sub]))
    const families = new Set(jgx.FAMILIES.map((f) => f.cap))
    for (const [name, bit] of Object.entries(jgx.CAP)) {
      expect(licences.has(bit) || families.has(bit), name).toBe(true)
    }
    for (const f of jgx.FAMILIES) {
      const members = Object.values(jgx.SUB).filter((sub) => jgx.familyOf(sub) === f.cap)
      expect(members.length, f.cap.toString(2)).toBeGreaterThan(0)
    }
  })

  test('a licence bit belongs to one family, so a stray id shows up here', () => {
    const seen = new Map<number, number>()
    for (const sub of Object.values(jgx.SUB)) {
      const bit = jgx.SUB_CAP[sub]!
      const family = jgx.familyOf(sub)!
      expect(seen.get(bit) ?? family).toBe(family)
      seen.set(bit, family)
    }
  })

  test('an old gate on the coarse bit is exactly the trap this avoids', () => {
    // A unit with the input family but only the battery reading: an app that read
    // CAP.INPUT as "the button works" would subscribe to edges that never arrive.
    const partial = jgx.CAP.SESSION | jgx.CAP.INPUT | jgx.CAP.BATTERY
    expect(jgx.permits(partial, jgx.SUB.BATTERY)).toBe(true)
    expect(jgx.permits(partial, jgx.SUB.BUTTON)).toBe(false)
  })

  test('an old app is not broken by a new unit: unknown bits filter out', () => {
    expect(jgx.capabilityNames(V2)).toContain('SESSION')
    expect(jgx.capabilityNames(V2)).toContain('UPDATE')
    expect(jgx.capabilityNames(V2 | 0x8000)).not.toContain('8000')
    expect(jgx.supports(V2 | 0x8000, jgx.CAP.UPDATE)).toBe(true)
  })

  test('nor by a HELLO reply that grew fields it does not know', () => {
    const grown = jgx.parseNotification(
      reply(jgx.MARKER, jgx.MSG.HELLO_REPLY, 2, 0, V1 & 0xff, V1 >> 8, 0xaa, 0xbb, 0xcc),
    )
    expect(grown).toEqual({ type: 'hello', version: 2, capabilities: V1 })
  })

  test('a sub-command this client does not know is never sent', () => {
    expect(jgx.permits(0xffff, 0x3f)).toBe(false)
  })

  test('a stock unit is still identified by silence, not by a capability of zero', () => {
    // Nothing here can be built that reaches a stock unit: it has no J opcode, so the
    // only observation is a timeout. The assertion that matters is that a bitmap of
    // zero licenses nothing, so a caller that mistook one for the other still sends
    // nothing.
    for (const sub of Object.values(jgx.SUB)) expect(jgx.permits(0, sub)).toBe(false)
  })
})

describe('the notification types, round-tripped', () => {
  const block = (payload: number[]) => {
    const b = new Uint8Array(16)
    b[0] = payload.length
    b.set(payload, 1)
    return b
  }

  const CASES: ReadonlyArray<[string, number[], jgx.Notification]> = [
    ['hello', [jgx.MARKER, jgx.MSG.HELLO_REPLY, 2, 0, 0x11, 0x04],
      { type: 'hello', version: 2, capabilities: 0x0411 }],
    ['update', [jgx.MARKER, jgx.MSG.UPD_REPLY, jgx.UPD.OK, 1, 3, 0],
      { type: 'update', code: jgx.UPD.OK, status: { liveIsB: true, generation: 3 } }],
    ['button', [jgx.MARKER, jgx.MSG.BUTTON, jgx.EDGE.PRESS, 7, 4, 0x40, 0x9c, 0x00, 0x00],
      { type: 'button', edge: jgx.EDGE.PRESS, count: 7, index: 4, ticks: 0x9c40 }],
    ['ack', [jgx.MARKER, jgx.MSG.ACK, jgx.SUB.SMOOTH, jgx.STATUS.OK, 4],
      { type: 'ack', sub: jgx.SUB.SMOOTH, code: jgx.STATUS.OK,
        detail: new Uint8Array([4]) }],
    ['battery', [jgx.MARKER, jgx.MSG.BATTERY, 0x0e, 0x10],
      { type: 'battery', millivolts: 4110 }],
    ['tick', [jgx.MARKER, jgx.MSG.TICK, 100, 200, 0],
      { type: 'tick', hz: 100, holdTicks: 200 }],
  ]

  test.each(CASES)('%s parses to exactly its fields', (_name, payload, want) => {
    expect(jgx.parseNotification(block(payload))).toEqual(want)
  })

  test.each(CASES)('%s fits the 15-byte ceiling', (_name, payload) => {
    expect(payload.length).toBeLessThanOrEqual(jgx.MAX_NOTIFY_PAYLOAD)
  })

  // `update` and `ack` carry an optional tail, so one byte less is a shorter valid
  // reply rather than a broken one. That tolerance is deliberate and is what lets an
  // app older than a unit keep working; the other four are fixed shapes.
  const FIXED = CASES.filter(([name]) => name !== 'update' && name !== 'ack')

  test.each(FIXED)('%s truncated by one byte is refused rather than guessed', (
    _name, payload,
  ) => {
    expect(jgx.parseNotification(block(payload.slice(0, -1)))).toBeNull()
  })

  test('a shortened update or ack degrades to its own smaller form, then to null', () => {
    expect(jgx.parseNotification(
      block([jgx.MARKER, jgx.MSG.UPD_REPLY, jgx.UPD.BAD_CRC]),
    )).toEqual({ type: 'update', code: jgx.UPD.BAD_CRC })
    expect(jgx.parseNotification(block([jgx.MARKER, jgx.MSG.UPD_REPLY]))).toBeNull()
    expect(jgx.parseNotification(
      block([jgx.MARKER, jgx.MSG.ACK, jgx.SUB.TICK, jgx.STATUS.REFUSED]),
    )).toEqual({ type: 'ack', sub: jgx.SUB.TICK, code: jgx.STATUS.REFUSED })
    expect(jgx.parseNotification(block([jgx.MARKER, jgx.MSG.ACK, jgx.SUB.TICK])))
      .toBeNull()
  })

  test('an ACK with nothing to echo carries no detail field', () => {
    expect(jgx.parseNotification(
      block([jgx.MARKER, jgx.MSG.ACK, jgx.SUB.BUTTON, jgx.STATUS.UNSUPPORTED]),
    )).toEqual({ type: 'ack', sub: jgx.SUB.BUTTON, code: jgx.STATUS.UNSUPPORTED })
  })

  test('an ACK names the sub-command it answers, so it cannot be misattributed', () => {
    const seeded = jgx.parseNotification(block([jgx.MARKER, jgx.MSG.ACK, jgx.SUB.SEED,
      jgx.STATUS.OK, 0x78, 0x56, 0x34, 0x12]))
    expect(seeded).toMatchObject({ sub: jgx.SUB.SEED })
    expect([...(seeded as jgx.Ack).detail!]).toEqual([0x78, 0x56, 0x34, 0x12])
  })

  test('a button event is not mistaken for the reply to whatever was in flight', () => {
    // It is the only unsolicited message, so a client that routes by arrival order
    // will hand it to whoever is waiting. `type` is the only safe discriminator, and
    // this is the assertion that says so.
    const msg = jgx.parseNotification(
      block([jgx.MARKER, jgx.MSG.BUTTON, jgx.EDGE.HOLD, 1, jgx.INDEX_NONE, 0, 0, 0, 0]),
    )
    expect(msg?.type).toBe('button')
    expect(msg?.type).not.toBe('hello')
  })
})

describe('the tick rate, and the power switch riding on it', () => {
  test('stock is two seconds and the arithmetic agrees', () => {
    expect(jgx.holdSeconds(jgx.TICK_STOCK_HZ, jgx.HOLD_TICKS_STOCK)).toBe(2)
    expect(jgx.powerOffIntact(jgx.TICK_STOCK_HZ, jgx.HOLD_TICKS_STOCK)).toBe(true)
    expect(jgx.tickMs(50)).toBe(20)
    expect(jgx.tickMs(100)).toBe(10)
  })

  test('an uncompensated hold count at 100 Hz is caught, not trusted', () => {
    // The trap `research/firmware-internals.md` records: doubling the tick halves
    // every tick-counted timeout, so the only power switch becomes one second.
    expect(jgx.holdSeconds(100, jgx.HOLD_TICKS_STOCK)).toBe(1)
    expect(jgx.powerOffIntact(100, jgx.HOLD_TICKS_STOCK)).toBe(false)
    expect(jgx.powerOffIntact(100, 200)).toBe(true)
  })

  test('only the rates the firmware carries compensation for are offered', () => {
    expect(jgx.parseCommand(jgx.tickSet(100))!.args[1]).toBe(100)
    expect(() => jgx.tickSet(60)).toThrow()
    expect(() => jgx.tickSet(0)).toThrow()
  })

  test('asking and setting are one sub-command told apart by one byte', () => {
    expect(jgx.parseCommand(jgx.tickAsk())).toMatchObject({ sub: jgx.SUB.TICK })
    expect(jgx.parseCommand(jgx.tickAsk())!.args[0]).toBe(jgx.ASK)
    expect(jgx.parseCommand(jgx.tickSet(50))!.args[0]).toBe(jgx.SET)
  })
})

describe('the seed, which is meant to make two of your pairs identical', () => {
  test('a word round-trips little-endian, so two pairs can be given the same one', () => {
    const cmd = jgx.parseCommand(jgx.seedSet(0x12345678))!
    expect(cmd.sub).toBe(jgx.SUB.SEED)
    expect([...cmd.args]).toEqual([jgx.SET, 0x78, 0x56, 0x34, 0x12])
  })

  test('the top bit of a seed survives, which a signed shift would have eaten', () => {
    expect([...jgx.parseCommand(jgx.seedSet(0xdeadbeef))!.args])
      .toEqual([jgx.SET, 0xef, 0xbe, 0xad, 0xde])
  })

  test('and asking is how two pairs are checked for agreement', () => {
    expect([...jgx.parseCommand(jgx.seedAsk())!.args.subarray(0, 1)]).toEqual([jgx.ASK])
  })
})

describe('the tile palette', () => {
  const solid = jgx.tileWord([3, 3, 3, 3, 3, 3, 3, 3, 3])

  test('a tile word is the same 18-bit column the rhythm bar table holds', () => {
    expect(solid).toBe(0x3ffff)
    expect(jgx.tileWord([3, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(0x3)
    expect(jgx.tileLevels(0x3)).toEqual([3, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(jgx.tileLevels(solid)).toEqual([3, 3, 3, 3, 3, 3, 3, 3, 3])
  })

  test('a level above the panel\'s four is refused, not masked into the next row', () => {
    expect(() => jgx.tileWord([4, 0, 0, 0, 0, 0, 0, 0, 0])).toThrow()
    expect(() => jgx.tileWord([0, 0, 0])).toThrow()
  })

  test('four entries a frame, and a whole palette is four frames', () => {
    const words = Array.from({ length: jgx.TILE_COUNT }, (_, i) => i * 0x101)
    const frames = jgx.tilePalette(words)
    expect(frames).toHaveLength(4)
    const seen: number[] = []
    frames.forEach((f, i) => {
      const cmd = jgx.parseCommand(f)!
      expect(cmd.sub).toBe(jgx.SUB.TILE_DEF)
      const read = jgx.readTileDefine(cmd.args)!
      expect(read.first).toBe(i * jgx.TILE_DEF_ENTRIES)
      seen.push(...read.words)
    })
    expect(seen).toEqual(words)
  })

  test('a define is exactly at the 15-byte ceiling, which is why it is four', () => {
    expect(jgx.tileDefine(0, [1, 2, 3, 4])[0]).toBe(jgx.MAX_BODY)
    expect(1 + jgx.TILE_DEF_ENTRIES * jgx.TILE_WORD_BYTES).toBe(jgx.MAX_PAYLOAD)
  })

  test('a define that would run past the last entry is refused', () => {
    expect(() => jgx.tileDefine(13, [0, 0, 0, 0])).toThrow()
    expect(() => jgx.tileDefine(0, [0, 0, 0])).toThrow()
    expect(() => jgx.tileDefine(0, [0, 0, 0, 0x40000])).toThrow()
    expect(() => jgx.tilePalette([1, 2, 3])).toThrow()
  })

  test('a frame is 24 columns in one write, with a byte to spare', () => {
    const ix = Array.from({ length: 24 }, (_, i) => i % jgx.TILE_COUNT)
    const cmd = jgx.parseCommand(jgx.tileFrame(ix))!
    expect(cmd.sub).toBe(jgx.SUB.TILE_FRAME)
    expect(jgx.readTileFrame(cmd.args)).toEqual(ix)
    expect(jgx.tileFrame(ix)[0]).toBe(jgx.MAX_BODY - 1)
  })

  test('the nibble order is the rhythm channel\'s own', () => {
    // So the same twelve bytes mean the same 24 columns if a build ever does
    // implement the palette by repointing the bar table at `abs 0x22da8`.
    const ix = new Array(24).fill(0)
    ix[0] = 1
    ix[1] = 2
    expect(jgx.parseCommand(jgx.tileFrame(ix))!.args[0]).toBe(0x21)
  })

  test('an index outside the palette is refused rather than blanking a column', () => {
    expect(() => jgx.tileFrame(new Array(24).fill(jgx.TILE_COUNT))).toThrow()
    expect(() => jgx.tileFrame(new Array(23).fill(0))).toThrow()
  })
})

describe('sub-column scroll interpolation', () => {
  test('the ceiling is four levels, because a fifth phase has no ink to draw', () => {
    expect(jgx.SMOOTH_MAX).toBe(4)
    expect(jgx.parseCommand(jgx.smoothSet(4))!.args[1]).toBe(4)
    expect(() => jgx.smoothSet(5)).toThrow()
    expect(() => jgx.smoothSet(0)).toThrow()
  })

  test('one step is stock behaviour, and it is settable rather than a refusal', () => {
    expect(jgx.SMOOTH_OFF).toBe(1)
    expect(jgx.parseCommand(jgx.smoothSet(jgx.SMOOTH_OFF))!.args[1]).toBe(1)
  })
})

describe('the button back-channel', () => {
  test('no flag can ask for the 2 second hold to stop powering the unit off', () => {
    // The only power switch. Every defined bit is either a report or the short-press
    // cycle, and `buttonSet` refuses anything else so a future firmware cannot be
    // handed a bit that means something we never agreed to.
    expect(jgx.BTN_FLAGS).toBe(0x0f)
    expect(jgx.BTN_FLAGS & ~(jgx.BTN.PRESS | jgx.BTN.RELEASE | jgx.BTN.HOLD
      | jgx.BTN.SUPPRESS_CYCLE)).toBe(0)
    expect(() => jgx.buttonSet(0x10)).toThrow()
    expect(() => jgx.buttonSet(-1)).toThrow()
  })

  test('the playlist can take the short press without touching the hold', () => {
    const flags = jgx.BTN.PRESS | jgx.BTN.SUPPRESS_CYCLE
    expect(jgx.parseCommand(jgx.buttonSet(flags))!.args[1]).toBe(flags)
    expect(flags & jgx.BTN.HOLD).toBe(0)
  })

  test('off is a value, so the built-in cycle can be given back', () => {
    expect(jgx.BTN_OFF).toBe(0)
    expect(jgx.parseCommand(jgx.buttonSet(jgx.BTN_OFF))!.args)
      .toEqual(new Uint8Array([jgx.SET, 0]))
  })

  test('an interval is measured in the device\'s own ticks, not in arrival times', () => {
    expect(jgx.tapIntervalMs(100, 150, 50)).toBe(1000)
    expect(jgx.tapIntervalMs(0, 47, 100)).toBe(470)
  })

  test('and it survives the tick counter wrapping', () => {
    expect(jgx.tapIntervalMs(0xfffffff0, 5, 100)).toBe(210)
  })

  test('a lost notification is countable, since nothing acknowledges one', () => {
    expect(jgx.missedPresses(5, 6)).toBe(0)
    expect(jgx.missedPresses(5, 8)).toBe(2)
    expect(jgx.missedPresses(254, 1)).toBe(2)
  })
})

describe('the battery reading', () => {
  test('it is asked for, never subscribed to', () => {
    const cmd = jgx.parseCommand(jgx.batteryAsk())!
    expect(cmd.sub).toBe(jgx.SUB.BATTERY)
    expect(cmd.args[0]).toBe(jgx.ASK)
  })

  test('a saturated reading says nothing about charge, and the constant says so', () => {
    expect(jgx.BATTERY_SATURATED_MV).toBe(4150)
    const msg = jgx.parseNotification(new Uint8Array([4, jgx.MARKER, jgx.MSG.BATTERY,
      0x2c, 0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    expect(msg).toEqual({ type: 'battery', millivolts: 4396 })
    expect((msg as jgx.BatteryReport).millivolts)
      .toBeGreaterThan(jgx.BATTERY_SATURATED_MV)
  })
})
