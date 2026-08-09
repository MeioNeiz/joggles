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
