/**
 * Platform BLE failures, said in terms of the pair a person can see.
 *
 * From handset feedback (2026-08-12): the Glasses screen printed "Device
 * 3C:A3:08:12:C3:EF was disconnected", which is ble-plx's own wording carrying the
 * platform handle. That handle is a MAC on Android and a per-install UUID on iOS, and
 * it appears **nowhere else in this app**: the scan list, the nicknames, the ledger and
 * the settings are all keyed on the advert name, so the one string a person cannot
 * match to anything they have seen is the one the failure path chose to show them.
 *
 * Pure, and its own file rather than a corner of `ble.ts`, for the reason `nicknames.ts`
 * is split from `nicknames-store.ts`: react-native does not import under bun, and
 * wording is exactly the sort of thing that wants a test.
 *
 * `faultOf` classifies and `pairWords` renders, split because the wording lives where
 * the **display** name is known, which is not always where the error is caught: the
 * Glasses screen has the nickname, `App.tsx` has it for the connected pair, and the
 * leaves below them have neither. Nothing calls this twice on the same error: the
 * fallback preserves text it does not recognise, so a second pass with a different name
 * would leave the first name in place.
 *
 * Only faults whose ble-plx text carries a handle get their own sentence. "Operation
 * timed out" and "Operation was cancelled" name no device, so they fall through
 * unchanged rather than earning an invented sentence about the pair.
 */

/** A device handle: `AA:BB:...` on Android, a UUID on iOS, and anything else id-shaped. */
const HANDLE = String.raw`[0-9A-Fa-f](?:[0-9A-Fa-f:.\-]{6,})[0-9A-Fa-f]`

/** "Device <handle>", the phrase ble-plx opens its device errors with. */
const NAMED = String.raw`\bdevice\s+(?:id\s+)?['"]?(?:${HANDLE})['"]?`

// Built per use rather than held as module-scope literals: a `/g` regex keeps its
// `lastIndex` between `test()` calls, which makes every other call answer false.
const names = (text: string): boolean => new RegExp(NAMED, 'i').test(text)

const rename = (text: string, who: string): string =>
  text.replace(new RegExp(NAMED, 'gi'), who)

export type PairFault =
  /** The link is gone: it dropped, or it was never up by the time we wrote. */
  | 'dropped'
  /** The pair was not there to connect to. */
  | 'missing'
  /** Something already holds it. One connection per device. */
  | 'held'
  /** Anything else, including failures that are not about a pair at all. */
  | 'other'

/** The message of an error, or whatever a thrown non-error stringifies to. */
export function messageOf(raw: unknown): string {
  const message = (raw as { message?: unknown } | null)?.message
  const text = typeof message === 'string' && message !== '' ? message : String(raw)
  return text.replace(/^Error:\s*/, '').trim()
}

/**
 * Which pair-level fault a platform error is, by what ble-plx writes:
 *
 *   Device <handle> was disconnected     -> dropped
 *   Device <handle> is not connected     -> dropped
 *   Device <handle> not found            -> missing
 *   Device <handle> is already connected -> held
 *
 * The `^device` guard is what keeps "Service <uuid> for device <handle> not found" out
 * of `missing`: discovery failing against a pair that answered is a different fault
 * from a pair that was never there, and only the second one is worth a sentence about
 * range.
 */
export function faultOf(raw: unknown): PairFault {
  const text = messageOf(raw)
  if (!names(text) || !/^device\b/i.test(text)) return 'other'
  if (/disconnected|not connected/i.test(text)) return 'dropped'
  if (/not found/i.test(text)) return 'missing'
  if (/already connected/i.test(text)) return 'held'
  return 'other'
}

/** What to call the pair when the caller has no name for it. */
const whoIs = (pair: string | null | undefined): string => {
  const name = (pair ?? '').trim()
  return name === '' ? 'The glasses' : name
}

/**
 * One sentence about `pair`, given whatever the platform threw.
 *
 * `pair` is the name the person is looking at: the nickname if there is one, the advert
 * name otherwise. Unrecognised text is kept as it stands, with any device handle in it
 * swapped for the name, so a fault this file has never seen still never shows a MAC.
 */
export function pairWords(raw: unknown, pair: string | null | undefined): string {
  const who = whoIs(pair)
  switch (faultOf(raw)) {
    case 'dropped':
      return `${who} disconnected.`
    case 'missing':
      return `${who} did not answer. It may be off, or out of range.`
    case 'held':
      return `${who} is already connected. Another app on this phone may be holding it.`
    default:
      return rename(messageOf(raw), who)
  }
}
