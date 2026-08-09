import { expect, test } from 'bun:test'
import {
  IMAGE_BYTES,
  IMAGE_COLUMN_BYTES,
  TYPE_IMAGE,
  chunkPayload,
  datsStart,
  decodeBitmap,
  decodeImage,
  encodeBitmap,
  encodeImage,
} from './dats.js'
import { Grid } from './display.js'
import { panelBitmap } from './font.js'
import { body } from './protocol.js'

test('DATS start frame matches the vendor layout', () => {
  const f = datsStart(178)
  // [07]["DATS"][01][hi][lo]
  expect(String.fromCharCode(...body(f).subarray(0, 4))).toBe('DATS')
  expect([...body(f).subarray(4)]).toEqual([1, 0, 178])
})

test('16-bit length is big-endian across the byte boundary', () => {
  const f = datsStart(300) // 300 = 0x012C
  expect([...body(f).subarray(4)]).toEqual([1, 1, 44])
})

// The mapping these assert is *derived* from two firmware paths, not confirmed on
// hardware. The settling test is the "row 8" case below, uploaded for real: if row
// 8 does not light, this file and dats.ts are what change.
test('the bottom row is bit 15, not bit 0', () => {
  const bmp = Array.from({ length: 9 }, () => [0])
  bmp[0][0] = 1
  const enc = encodeBitmap(bmp)
  expect(enc[0] | (enc[1] << 8)).toBe(0b1000_0000_0000_0000)
})

test('rows 1-7 occupy bits 0-6', () => {
  const bmp = Array.from({ length: 9 }, () => [0])
  bmp[1][0] = 1
  bmp[7][0] = 1
  const enc = encodeBitmap(bmp)
  expect(enc[0] | (enc[1] << 8)).toBe(0b0100_0001)
})

test('row 8 is bit 7, the bit the old 7+7 reading called unused', () => {
  const bmp = Array.from({ length: 9 }, () => [0])
  bmp[8][0] = 1
  const enc = encodeBitmap(bmp)
  expect(enc[0] | (enc[1] << 8)).toBe(0b1000_0000)
})

test('no row lands in bits 8-14, which reach nothing', () => {
  const bmp = Array.from({ length: 9 }, () => [1])
  const enc = encodeBitmap(bmp)
  const word = enc[0] | (enc[1] << 8)
  expect(word & 0b0111_1111_0000_0000).toBe(0)
  expect(word).toBe(0b1000_0000_1111_1111)
})

test('encode/decode round-trips', () => {
  const bmp = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (_, c) => (r + c) % 3 === 0 ? 1 : 0),
  )
  expect(decodeBitmap(encodeBitmap(bmp))).toEqual(bmp)
})

test('chunking prefixes each block with its own length', () => {
  const payload = new Uint8Array(38).fill(0xaa)
  const blocks = chunkPayload(payload)
  expect(blocks.length).toBe(3) // 15 + 15 + 8
  expect(blocks[0][0]).toBe(15)
  expect(blocks[2][0]).toBe(8)
  expect(blocks.every((b) => b.length === 16)).toBe(true)
  // Reassembly must strip the prefix.
  const back = blocks.flatMap((b) => [...b.subarray(1, 1 + b[0])])
  expect(back.length).toBe(38)
})

test('rejects more rows than the panel has', () => {
  expect(() => encodeBitmap(Array.from({ length: 10 }, () => [0]))).toThrow()
})

// --- type 2, the DIY image ---

test('the type byte reaches the frame', () => {
  expect([...body(datsStart(72, TYPE_IMAGE)).subarray(4)]).toEqual([2, 0, 72])
})

test('a full screen of type 2 is exactly the vendor 72 bytes', () => {
  const bmp = Array.from({ length: 9 }, () => new Array(24).fill(3))
  expect(encodeImage(bmp).length).toBe(IMAGE_BYTES)
})

test('type 2 puts row r at bit 2r of a big-endian 24-bit word', () => {
  for (const r of [0, 4, 8]) {
    const bmp = Array.from({ length: 9 }, () => [0])
    bmp[r][0] = 3
    const enc = encodeImage(bmp)
    const word = (enc[0] << 16) | (enc[1] << 8) | enc[2]
    expect(word).toBe(0b11 << (2 * r))
  }
})

// The odd bit is brightness, so the four levels have to survive a format whose
// whole point is that it is the one that carries them.
test('type 2 keeps intermediate levels', () => {
  const bmp = Array.from({ length: 9 }, () => [0])
  bmp[0][0] = 1
  bmp[1][0] = 2
  bmp[2][0] = 3
  expect(decodeImage(encodeImage(bmp))[0][0]).toBe(1)
  expect(decodeImage(encodeImage(bmp))[1][0]).toBe(2)
  expect(decodeImage(encodeImage(bmp))[2][0]).toBe(3)
})

test('type 2 round-trips a greyscale bitmap', () => {
  const bmp = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 24 }, (_, c) => (r * 7 + c * 5) % 4),
  )
  expect(decodeImage(encodeImage(bmp))).toEqual(bmp)
})

/**
 * The claim the encoder is built on: type 2 is the live column format with the
 * `[04][index]` header removed. If this ever fails, one of the two paths has
 * drifted and a saved drawing will not match the drawing that was shown.
 */
test('type 2 columns are the live column frames, header stripped', () => {
  const g = new Grid()
  g.set(0, 0, 1).set(3, 0, 2).set(8, 0, 3).set(4, 7, 3).set(2, 23, 1)
  const bmp = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 24 }, (_, c) => g.get(r, c)),
  )
  const live = g.toFrames().flatMap((f) => [...body(f).subarray(1)])
  expect([...encodeImage(bmp)]).toEqual(live)
})

/**
 * The type 2 receive loop steps by 3 and reloads the block length each pass, so a
 * block whose payload does not divide by 3 mis-frames every column after it. Type 1
 * would not notice, which is what makes this worth pinning.
 */
test('every block of a type 2 payload holds whole columns', () => {
  for (const cols of [1, 5, 24, 383]) {
    const bmp = Array.from({ length: 9 }, () => new Array(cols).fill(3))
    const blocks = chunkPayload(encodeImage(bmp))
    expect(blocks.every((b) => b[0] % IMAGE_COLUMN_BYTES === 0)).toBe(true)
  }
})

test('type 2 rejects more rows than the panel has', () => {
  expect(() => encodeImage(Array.from({ length: 10 }, () => [0]))).toThrow()
})

test('placed text clears the nose notch rows', () => {
  const bmp = panelBitmap('A')
  expect(bmp.length).toBe(9)
  expect(bmp[0].every((v) => v === 0)).toBe(true)
  expect(bmp[1].every((v) => v === 0)).toBe(true)
  expect(bmp[8].every((v) => v === 0)).toBe(true)
  expect(bmp.slice(2, 7).some((row) => row.some(Boolean))).toBe(true)
})
