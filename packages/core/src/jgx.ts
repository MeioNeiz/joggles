/**
 * The `JGX1` firmware extension, client side.
 *
 * Stock firmware handles eleven opcodes and can say exactly three things back:
 * `DATSOK`, `DATCPOK`, `ERROR`. Our firmware adds one opcode, `J`, whose first
 * payload byte is a sub-command id, and one structured notification frame. Every
 * feature after that is a new sub-command and a new message type, which is what
 * lets the firmware grow without touching the vendor's code again.
 *
 * This module is the wire format and nothing else, so it stays in `core` with no
 * dependencies. The firmware that answers it is built by `research/tools/ext.ts`,
 * which imports the constants below rather than restating them, so the two cannot
 * drift apart.
 *
 * ## Talking to a mixed fleet
 *
 * At a festival the app meets stock units, crew units at v1 and, later, crew units
 * at v2. So it probes rather than assumes. A stock unit does not recognise `J`, the
 * dispatcher falls through to no-match, and nothing is sent back at all: silence is
 * how stock is identified. A crew unit answers HELLO with its version and a
 * capability bitmap, so a v1 app can talk safely to a v2 unit and the reverse.
 */
import { frame } from './protocol.js'

/** Marks a valid extension in the firmware image. Not seen on the wire. */
export const MAGIC = 'JGX1'

/**
 * Our opcode. The stock dispatcher tests D, S, L, A, M, C and I before reaching
 * the hook, so `J` cannot be shadowed by a vendor command.
 */
export const OPCODE = 'J'

/**
 * Sub-command ids. The ranges are reserved as a whole so later work slots in
 * without renumbering: 0x00-0x0f session and control, 0x10-0x1f sync, 0x20-0x2f
 * content, 0x30-0x3f input and sensors, 0x40 and up unallocated.
 */
export const SUB = {
  HELLO: 0x00,
} as const

/** One bit per sub-command family, reported by HELLO. */
export const CAP = {
  SESSION: 1 << 0,
  SYNC: 1 << 1,
  CONTENT: 1 << 2,
  INPUT: 1 << 3,
} as const

export type Capability = keyof typeof CAP

/**
 * First byte of every notification we send.
 *
 * The vendor's three replies are ASCII, so a high byte cannot collide with one.
 * `DATSOK` begins 0x44.
 */
export const MARKER = 0xf0

/** Notification types, additive. Only the HELLO reply exists in v1. */
export const MSG = {
  HELLO_REPLY: 0x00,
} as const

/**
 * The device's notify sender pads to one AES block and frames it as
 * `[len][payload]`, so a payload cannot exceed 15 bytes. Anything longer needs a
 * second notification, not a longer frame.
 */
export const MAX_NOTIFY_PAYLOAD = 15

/** Version this client speaks, sent with HELLO so firmware can adapt later. */
export const APP_VERSION = 1

// --- Requests ---------------------------------------------------------------------

/**
 * Ask a unit what it is.
 *
 * Four payload bytes, which is also the shortest frame the dispatcher's length gate
 * accepts. A stock unit ignores it in silence.
 */
export function hello(appVersion = APP_VERSION): Uint8Array {
  return frame(OPCODE, SUB.HELLO, appVersion & 0xff, (appVersion >> 8) & 0xff)
}

// --- Replies ----------------------------------------------------------------------

export interface HelloReply {
  type: 'hello'
  /** Extension version the unit reports, not the vendor's firmware version. */
  version: number
  capabilities: number
}

export type Notification = HelloReply

/**
 * Parse a decrypted notification block.
 *
 * Returns null for anything that is not ours, including the vendor's `DATSOK` and
 * `DATCPOK`, so a caller can hand every notification to both parsers.
 */
export function parseNotification(plain: Uint8Array): Notification | null {
  const len = plain[0]
  if (!len || len > MAX_NOTIFY_PAYLOAD || len + 1 > plain.length) return null
  if (plain[1] !== MARKER) return null

  switch (plain[2]) {
    case MSG.HELLO_REPLY:
      if (len < 6) return null
      return {
        type: 'hello',
        version: plain[3] | (plain[4] << 8),
        capabilities: plain[5] | (plain[6] << 8),
      }
    default:
      return null
  }
}

/** Does a capability bitmap include this family? */
export const supports = (capabilities: number, cap: number): boolean =>
  (capabilities & cap) === cap

/** Capability names present in a bitmap, for logging and diagnostics. */
export function capabilityNames(capabilities: number): Capability[] {
  return (Object.keys(CAP) as Capability[]).filter((k) => supports(capabilities, CAP[k]))
}
