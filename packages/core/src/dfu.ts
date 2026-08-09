/**
 * The `fd00` OTA transport: control opcodes, data packets and replies.
 *
 * `ota.ts` is the container and the safety gate; this is the wire protocol that
 * carries a checked container to the device. Kept apart because they fail in
 * different ways: a mistake here wastes a transfer, a mistake there costs a device.
 *
 * Every field below was read off the disassembly of the handler at `abs 0x1ea00` and
 * then confirmed against the vendor's own `PanchipOtaManager` and `FileInfo` in the
 * decompiled app. Where the two agree they are marked *verified*; nothing here rests
 * on one source alone.
 *
 * ## The exchange
 *
 *     ctrl fd02   01 <appVer16> <devVer16> <proVer16>   -> 80 01 <6 bytes>
 *     ctrl fd02   02 <type8> <codeSize32>               -> 80 02 <status>
 *     data fd01   <index16> <payload...>                -> 80 04            xN
 *     ctrl fd02   03 <crc32>                            -> 80 03 <status>
 *
 * All multi-byte fields are little-endian, and `status` 0 means success. Nothing is
 * committed until ctrl `03` matches, so an abandoned transfer costs nothing: the
 * staging bank is scratch and the running application is never erased.
 *
 * ## Two traps
 *
 *  1. **Every `fd01` write begins with two bytes the device discards.** The handler
 *     copies from `value + 2` for `length - 2` bytes, and the vendor app accounts for
 *     its payload as `packetSize - 2`. It is a packet index, and nothing reads it, so
 *     its only job is to occupy those two bytes. Omit it and the first two bytes of
 *     every packet are eaten, which the CRC catches at the end of a long transfer
 *     rather than the start.
 *  2. **The stream is the container body, still obfuscated.** The device descrambles
 *     each 512-byte page itself, from the top of the pad every time. Since 512 is a
 *     whole number of 128-byte pads the phase never drifts, but it does mean the
 *     stream must begin exactly at body offset 0. Send the plaintext, or include the
 *     16-byte file header, and every byte lands scrambled.
 */
import { HEADER_SIZE, rawBody, type Header } from './ota.js'

// --- GATT ---------------------------------------------------------------------------

export const SERVICE = '0000fd00-0000-1000-8000-00805f9b34fb'

/** Write-without-response, no CCCD. Property byte `0x04` in the GATT table. */
export const CHAR_DATA = '0000fd01-0000-1000-8000-00805f9b34fb'

/** Write plus notify, with a CCCD. Property byte `0x18`. Carries every reply. */
export const CHAR_CTRL = '0000fd02-0000-1000-8000-00805f9b34fb'

// --- Opcodes and replies ------------------------------------------------------------

/**
 * Control opcodes. The dispatcher at `abs 0x1ebc2` tests 1, 2 and 3 and nothing else,
 * so the vendor app's `opcode_reset = 4` is a no-op on this firmware.
 */
export const OP = { VERSION: 1, SIZE: 2, CRC: 3 } as const

/** First byte of every reply. */
export const RSP = 0x80

export const REPLY = { VERSION: 1, SIZE: 2, CRC: 3, ACK: 4 } as const

/** Bytes at the head of an `fd01` write that the device skips. */
export const PACKET_HEADER = 2

/**
 * Largest `fd01` write we will emit.
 *
 * The device accumulates into a page buffer, flushes at 512 bytes and then moves a
 * fixed 512 bytes of remainder down, so a payload past ~513 would run off the end of
 * the buffer. No real MTU comes close; this is a guard rail, not a negotiation.
 */
export const MAX_PACKET = 512

/** The smallest write that carries any payload at all. */
export const MIN_PACKET = PACKET_HEADER + 1

const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff]
const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]

// --- Control packets ----------------------------------------------------------------

/**
 * Announce the image's version words.
 *
 * These are recorded and end up in the handoff record the bootloader reads, so the
 * words sent here should be the ones from the image about to be flashed rather than
 * anything convenient. The device replies with its own.
 */
export function versionPacket(h: Pick<Header, 'appVer' | 'devVer' | 'proVer'>): Uint8Array {
  return new Uint8Array([OP.VERSION, ...u16(h.appVer), ...u16(h.devVer), ...u16(h.proVer)])
}

/**
 * Begin a transfer. Zeroes the counters and selects the destination section.
 *
 * `type` is the one field here that can destroy a device: 1 flags the application,
 * 2 flags the BLE stack and anything else leaves whatever flag was last in SRAM.
 * `ota.check` refuses all but 1 before an image gets this far.
 */
export function sizePacket(h: Pick<Header, 'type' | 'codeSize'>): Uint8Array {
  return new Uint8Array([OP.SIZE, h.type & 0xff, ...u32(h.codeSize)])
}

/** Commit. The device CRCs the staged bank, and on a match only, reboots into it. */
export function crcPacket(h: Pick<Header, 'crc32'>): Uint8Array {
  return new Uint8Array([OP.CRC, ...u32(h.crc32)])
}

// --- Data packets -------------------------------------------------------------------

/**
 * Slice a container's body into `fd01` writes.
 *
 * `packetSize` is the whole ATT write including the two header bytes, which is how
 * the vendor app counts it and how an MTU limit applies. The index wraps at 16 bits;
 * the device never looks at it, and a 76,800-byte ceiling cannot reach 65,536 packets
 * at any payload above 2 bytes anyway.
 */
export function dataPackets(file: Uint8Array, packetSize: number): Uint8Array[] {
  if (!Number.isInteger(packetSize) || packetSize < MIN_PACKET || packetSize > MAX_PACKET) {
    throw new Error(`packet size ${packetSize} outside ${MIN_PACKET}..${MAX_PACKET}`)
  }
  if (file.length <= HEADER_SIZE) throw new Error('file is too short to hold a body')

  const body = rawBody(file)
  const payload = packetSize - PACKET_HEADER
  const out: Uint8Array[] = []
  for (let at = 0; at < body.length; at += payload) {
    const chunk = body.subarray(at, Math.min(at + payload, body.length))
    const packet = new Uint8Array(PACKET_HEADER + chunk.length)
    packet[0] = out.length & 0xff
    packet[1] = (out.length >> 8) & 0xff
    packet.set(chunk, PACKET_HEADER)
    out.push(packet)
  }
  return out
}

// --- Replies ------------------------------------------------------------------------

export type Reply =
  | { kind: 'version'; appVer: number; devVer: number; proVer: number }
  | { kind: 'size'; ok: boolean; status: number }
  | { kind: 'crc'; ok: boolean; status: number }
  | { kind: 'ack' }

/** Parse a notification from `fd02`. Returns null for anything malformed. */
export function parseReply(b: Uint8Array): Reply | null {
  if (b.length < 2 || b[0] !== RSP) return null
  switch (b[1]) {
    case REPLY.VERSION:
      if (b.length < 8) return null
      return {
        kind: 'version',
        appVer: b[2] | (b[3] << 8),
        devVer: b[4] | (b[5] << 8),
        proVer: b[6] | (b[7] << 8),
      }
    case REPLY.SIZE:
      if (b.length < 3) return null
      return { kind: 'size', ok: b[2] === 0, status: b[2] }
    case REPLY.CRC:
      if (b.length < 3) return null
      return { kind: 'crc', ok: b[2] === 0, status: b[2] }
    case REPLY.ACK:
      return { kind: 'ack' }
    default:
      return null
  }
}
