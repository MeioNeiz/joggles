import { expect, test } from 'bun:test'
import { fromBase64, toBase64 } from './base64.js'

const bytes = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)))

test('RFC 4648 vectors, which are the padding cases', () => {
  const cases: [string, string][] = [
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='],
    ['fooba', 'Zm9vYmE='],
    ['foobar', 'Zm9vYmFy'],
  ]
  for (const [plain, encoded] of cases) {
    expect(toBase64(bytes(plain))).toBe(encoded)
    expect([...fromBase64(encoded)]).toEqual([...bytes(plain)])
  }
})

// Every frame the protocol sends is exactly 16 bytes, so this is the only length that
// really matters. 16 % 3 == 1, the two-pad case.
test('a 16-byte block round-trips and matches Buffer', () => {
  const block = new Uint8Array(16)
  for (let i = 0; i < 16; i++) block[i] = (i * 37 + 11) & 0xff
  const encoded = toBase64(block)
  expect(encoded).toBe(Buffer.from(block).toString('base64'))
  expect([...fromBase64(encoded)]).toEqual([...block])
})

test('agrees with Buffer across every length and all byte values', () => {
  for (let len = 0; len <= 64; len++) {
    const b = new Uint8Array(len)
    for (let i = 0; i < len; i++) b[i] = (i * 97 + len * 13) & 0xff
    const encoded = toBase64(b)
    expect(encoded).toBe(Buffer.from(b).toString('base64'))
    expect([...fromBase64(encoded)]).toEqual([...b])
  }
})

test('high bytes survive, so 0xff is not mangled into a sign', () => {
  const b = new Uint8Array([0xff, 0x00, 0xff, 0x80, 0x7f])
  expect([...fromBase64(toBase64(b))]).toEqual([...b])
})
