/**
 * The line between what to send and how to send it.
 *
 * Everything above this interface is pure TS and testable against a mock; below it
 * is one adapter per platform, noble on the laptop and ble-plx on the phone. The
 * split exists so the phone does not grow a second DATS handshake that then drifts
 * from this one.
 *
 * Characteristic UUIDs cross the boundary in their dashed form, as `protocol.ts`
 * declares them. Each adapter normalises: noble strips the dashes, ble-plx does not.
 */
import { CHAR_BULK_A, CHAR_BULK_B, CHAR_COMMAND, CHAR_NOTIFY } from './protocol.js'

export interface Transport {
  write(char: string, block: Uint8Array, withResponse: boolean): Promise<void>
  subscribe(char: string, on: (block: Uint8Array) => void): Promise<void>
  disconnect(): Promise<void>
}

/** A unit seen advertising. `id` is the platform's own handle, not a MAC. */
export interface Discovered {
  id: string
  /** Advert name, which picks the cipher before the connection is open. */
  name: string
  /**
   * dBm, and **anything at or above 0 means no reading**: this is a plain number so an
   * absent measurement cannot be absent, and both adapters have a case with none in it
   * (ble-plx reports `null`, Android reports `127`). Taken as dBm either one outranks a
   * pair in your hand. `app/src/proximity.ts` holds the filter that refuses them.
   */
  rssi: number
}

/**
 * Discovery is platform code too, and separate from `Transport` because a Scan
 * screen needs a list rather than the first hit: the old `findGlasses()` resolved
 * the first matching advert and threw the rest away.
 */
export interface Scanner {
  scan(onFound: (unit: Discovered) => void): Promise<void>
  stop(): Promise<void>
  connect(id: string): Promise<Transport>
}

/**
 * The only characteristics an adapter may address.
 *
 * This is the second of the three layers that keep a client away from the
 * flash-writing service, and it is the one that sits where every byte passes
 * through rather than at each call site. The first layer is that the code to
 * speak that service is not in this barrel at all; the third is
 * `safe-surface.test.ts`.
 */
export const CHANNELS: readonly string[] = Object.freeze([
  CHAR_COMMAND,
  CHAR_NOTIFY,
  CHAR_BULK_A,
  CHAR_BULK_B,
])

/** Throw unless `uuid` is one of the four. Adapters call this before every write. */
export function assertChannel(uuid: string): void {
  if (!CHANNELS.includes(uuid.toLowerCase())) {
    throw new Error(`refusing to address ${uuid}: not one of the four glasses channels`)
  }
}
