import { describe, expect, test } from 'bun:test'
import { decryptBlock, encryptBlock, expandKey } from './aes.js'
import * as p from './protocol.js'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'))

describe('AES against the FIPS-197 reference vector', () => {
  // Independent of our device: proves the implementation itself is correct.
  test('encrypts the standard test vector', () => {
    const key = unhex('000102030405060708090a0b0c0d0e0f')
    const pt = unhex('00112233445566778899aabbccddeeff')
    const got = encryptBlock(expandKey(key), pt)
    expect(hex(got)).toBe('69c4e0d86a7b0430d8cdb78070b4c55a')
  })

  test('decrypts it back', () => {
    const key = unhex('000102030405060708090a0b0c0d0e0f')
    const ct = unhex('69c4e0d86a7b0430d8cdb78070b4c55a')
    expect(hex(decryptBlock(expandKey(key), ct))).toBe('00112233445566778899aabbccddeeff')
  })
})

describe('against traffic captured from the real glasses', () => {
  test('enter DIY matches the vendor app byte for byte', () => {
    expect(hex(p.encrypt(p.enterDIY()))).toBe('3b3eb0f5954bdabde610174b52bfcecb')
  })

  test('bulk column matches the capture', () => {
    const f = p.column(0, new Uint8Array([0x03, 0x00, 0x00]))
    expect(hex(p.encrypt(f))).toBe('dde2655d6e7a9923a30db0f1f9e97ce4')
  })

  test('decrypt round-trips', () => {
    const pt = p.decrypt(unhex('3b3eb0f5954bdabde610174b52bfcecb'))
    expect(String.fromCharCode(...p.body(pt))).toBe('SMVEW\x01')
  })
})

describe('frame layout', () => {
  const cases: [Uint8Array, string][] = [
    [p.queryType(), 'STYPE'],
    [p.brightness(5), 'LIGHT\x05'],
    [p.leds(false), 'LEDOFF'],
    [p.mode(2, 1), 'MODE\x02\x01'],
    [p.lens(2), 'LEDSECOND'],
  ]
  for (const [f, want] of cases) {
    test(`${want} is a well-formed 16-byte frame`, () => {
      expect(f.length).toBe(16)
      expect(String.fromCharCode(...p.body(f))).toBe(want)
    })
  }
})

test('parseType decodes panel dimensions', () => {
  expect(p.parseType(p.frame('STYPE14X56'))).toEqual({ rows: 14, cols: 56 })
  expect(p.parseType(p.frame('LEDON'))).toBeNull()
})
