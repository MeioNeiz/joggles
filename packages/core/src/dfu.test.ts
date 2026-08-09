import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import * as dfu from './dfu.js'
import * as ota from './ota.js'

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

/** The stock header, so the expected bytes below are the real ones. */
const HEAD = { codeSize: 66084, crc32: 0x04acebff, appVer: 3, devVer: 10, proVer: 10, type: 1 }

describe('control packets match the vendor app byte for byte', () => {
  // FileInfo.createSizePacket is {2, type} ++ file[0..4], and file[0..4] is codeSize
  // little-endian, so the whole packet is 6 bytes.
  test('size is opcode, type, then codeSize little-endian', () => {
    expect(hex(dfu.sizePacket(HEAD))).toBe('0201' + '24020100')
    expect(dfu.sizePacket(HEAD)).toHaveLength(6)
  })

  // createCrcPacket is {3} ++ file[4..8], the stored CRC verbatim.
  test('crc is opcode then crc32 little-endian', () => {
    expect(hex(dfu.crcPacket(HEAD))).toBe('03' + 'ffebac04')
    expect(dfu.crcPacket(HEAD)).toHaveLength(5)
  })

  // The handler reads three u16s from wire offsets 1, 3 and 5.
  test('version is opcode then three little-endian words', () => {
    expect(hex(dfu.versionPacket(HEAD))).toBe('01' + '0300' + '0a00' + '0a00')
    expect(dfu.versionPacket(HEAD)).toHaveLength(7)
  })

  test('type reaches the wire unaltered, because it is not this layer to judge', () => {
    // ota.check is the gate that refuses type 2; encoding it must still be faithful,
    // or the check would be validating something other than what gets sent.
    expect(dfu.sizePacket({ ...HEAD, type: 2 })[1]).toBe(2)
  })
})

describe('data packets', () => {
  const file = ota.encode(new Uint8Array(1000), { appVer: 3, devVer: 10, proVer: 10, type: 1 })

  test('carry two header bytes the device discards', () => {
    const packets = dfu.dataPackets(file, 20)
    expect(packets[0]).toHaveLength(20)
    expect(packets[0].subarray(dfu.PACKET_HEADER)).toHaveLength(18)
  })

  test('the header is a little-endian index counting from zero', () => {
    const packets = dfu.dataPackets(file, 20)
    expect([...packets.slice(0, 3)].map((p) => p[0] | (p[1] << 8))).toEqual([0, 1, 2])
  })

  test('reassembled payloads are exactly the obfuscated body', () => {
    for (const size of [4, 20, 183, dfu.MAX_PACKET]) {
      const joined = dfu
        .dataPackets(file, size)
        .flatMap((p) => [...p.subarray(dfu.PACKET_HEADER)])
      expect(new Uint8Array(joined)).toEqual(ota.rawBody(file))
    }
  })

  test('the stream is the obfuscated body, not the plaintext', () => {
    // The device descrambles each page itself. Sending plaintext would stage
    // scrambled bytes and fail the CRC only at the very end of the transfer.
    const first = dfu.dataPackets(file, 20)[0].subarray(dfu.PACKET_HEADER)
    expect(first).toEqual(ota.rawBody(file).subarray(0, 18))
    expect(first).not.toEqual(ota.plaintext(file).subarray(0, 18))
  })

  test('the file header is never transmitted', () => {
    const total = dfu.dataPackets(file, 20).reduce((n, p) => n + p.length - dfu.PACKET_HEADER, 0)
    expect(total).toBe(file.length - ota.HEADER_SIZE)
    expect(total).toBe(ota.parseHeader(file).codeSize)
  })

  test('the last packet is short rather than padded', () => {
    // Padding would stage bytes past codeSize. The device stops at codeSize, but the
    // page buffer would carry them, so a short final write is the honest encoding.
    const packets = dfu.dataPackets(file, 20)
    const last = packets[packets.length - 1]
    expect(last.length - dfu.PACKET_HEADER).toBe(1000 % 18)
  })

  test('a packet size outside the device bounds is refused', () => {
    expect(() => dfu.dataPackets(file, dfu.PACKET_HEADER)).toThrow()
    expect(() => dfu.dataPackets(file, dfu.MAX_PACKET + 1)).toThrow()
    expect(() => dfu.dataPackets(file, 20.5)).toThrow()
  })
})

describe('replies', () => {
  const b = (...v: number[]) => new Uint8Array(v)

  test('a version reply yields three little-endian words', () => {
    expect(dfu.parseReply(b(0x80, 1, 3, 0, 0x0a, 0, 0x0a, 0))).toEqual({
      kind: 'version',
      appVer: 3,
      devVer: 10,
      proVer: 10,
    })
  })

  test('status zero is success, for both size and crc', () => {
    expect(dfu.parseReply(b(0x80, 2, 0))).toEqual({ kind: 'size', ok: true, status: 0 })
    expect(dfu.parseReply(b(0x80, 3, 0))).toEqual({ kind: 'crc', ok: true, status: 0 })
    expect(dfu.parseReply(b(0x80, 3, 1))).toEqual({ kind: 'crc', ok: false, status: 1 })
  })

  test('the per-packet ack is two bytes and carries nothing else', () => {
    expect(dfu.parseReply(b(0x80, 4))).toEqual({ kind: 'ack' })
  })

  test('anything not marked 0x80, truncated or unknown is rejected', () => {
    expect(dfu.parseReply(b(0x81, 4))).toBeNull()
    expect(dfu.parseReply(b(0x80))).toBeNull()
    expect(dfu.parseReply(b(0x80, 1, 3, 0, 0x0a))).toBeNull() // version needs 8
    expect(dfu.parseReply(b(0x80, 2))).toBeNull() //              size needs a status
    expect(dfu.parseReply(b(0x80, 9, 0))).toBeNull() //           opcode 4 has no handler
  })
})

// firmware/ is gitignored, so this only runs where the vendor image is present.
const STOCK = 'firmware/TR1906R04-10_OTA.bin'

describe.if(existsSync(STOCK))('against the real stock container', () => {
  test('the control packets carry the header the file actually holds', async () => {
    const file = new Uint8Array(await Bun.file(STOCK).arrayBuffer())
    const h = ota.parseHeader(file)
    // The vendor builds these by slicing the file, so ours must equal those slices.
    expect(dfu.sizePacket(h).subarray(2)).toEqual(file.subarray(0, 4))
    expect(dfu.crcPacket(h).subarray(1)).toEqual(file.subarray(4, 8))
    expect(dfu.versionPacket(h).subarray(1)).toEqual(file.subarray(8, 14))
  })

  test('a full transfer reassembles to the body the CRC was computed over', async () => {
    const file = new Uint8Array(await Bun.file(STOCK).arrayBuffer())
    const packets = dfu.dataPackets(file, 183)
    const joined = new Uint8Array(packets.flatMap((p) => [...p.subarray(dfu.PACKET_HEADER)]))
    expect(joined).toEqual(ota.rawBody(file))
    expect(ota.crc32(ota.deobfuscate(joined))).toBe(ota.parseHeader(file).crc32)
  })

  test('every full page descrambles at pad phase zero, as the device assumes', async () => {
    // The handler descrambles 512 bytes at a time, restarting the 128-byte pad each
    // page. That only agrees with a continuous deobfuscate() because 512 % 128 == 0,
    // which is worth asserting rather than remembering.
    const file = new Uint8Array(await Bun.file(STOCK).arrayBuffer())
    const body = ota.rawBody(file)
    const whole = ota.deobfuscate(body)
    for (let at = 0; at + 512 <= body.length; at += 512) {
      expect(ota.deobfuscate(body.subarray(at, at + 512))).toEqual(whole.subarray(at, at + 512))
    }
  })
})
