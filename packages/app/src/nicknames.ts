/**
 * Per-device nicknames, held on the phone.
 *
 * Two pairs in a scan list read GLASSES-125B37 and GLASSES-12C3EF, unusable at arm's
 * length in a field. A map on the phone fixes that with no device involvement: no
 * flash write, no round trip, works on stock units. Rationale: notes/what-to-build.md,
 * "Name your glasses, on the host".
 *
 * Keyed the way `SessionOptions.device` is: the advert name by default, which carries
 * the last three bytes of the MAC. So a nickname follows the unit across a reinstall
 * and across phones, not the platform handle, which is per-host - and the key lines up
 * with the ledger's without sharing its file. What the key does not survive is a rename
 * of the advert itself: flashing our own firmware makes the unit `JOGGLES-xxxxxx`, which
 * orphans its nickname exactly as it orphans its ledger row.
 *
 * Storage is the ledger's shape (one JSON object, read once, memory first) but its own
 * file on disk, wired in `nicknames-store.ts`. A separate file on purpose: losing a
 * wear count matters and losing a nickname does not, so they must not share a failure.
 * The same thinking drives the resilience here: a corrupt or half-written file
 * degrades to an empty map rather than throwing into a render, and a failed write
 * still renames for the rest of the session.
 *
 * Pure on purpose: persistence arrives as a `TextFile`, so every branch runs under bun
 * (`nicknames.test.ts`). The expo-file-system half cannot, per draw.test.ts.
 */

export interface TextFile {
  /** The whole file, or null when it does not exist. May throw; the store degrades. */
  read(): string | null
  /** Replace the whole file, creating it if needed. May throw; memory still holds. */
  write(text: string): void
}

/** Row-readable ceiling. The scan list's TextInput enforces it at entry, set() here. */
export const MAX_NICKNAME = 40

/**
 * What set() actually stores: trimmed and capped. Empty means "no nickname".
 *
 * Trimmed again after the cut, and a high surrogate the cut left dangling is dropped:
 * the cap counts UTF-16 units, so it can land on a space or inside an emoji, and a lone
 * surrogate survives a JSON round trip to render as a tofu box for good.
 */
export function clean(name: string): string {
  return name.trim().slice(0, MAX_NICKNAME).replace(/[\uD800-\uDBFF]$/, '').trim()
}

/**
 * The nickname for a device in a map copy, or null.
 *
 * Typed rather than truthy, because a plain-object map answers for every member of
 * `Object.prototype`: an advert named `__proto__` reads back an object and one named
 * `toString` a function, and either handed to a React `Text` child takes the row down
 * rather than falling through to the advert name. `ble.ts` only surfaces adverts
 * starting `GLASSES-`/`JOGGLES-`, so nothing reaches that today; this is what keeps the
 * declared `string | null` true for whatever keys the map next.
 */
export function nicknameIn(names: Record<string, string>, device: string): string | null {
  const name = names[device]
  return typeof name === 'string' && name.length > 0 ? name : null
}

export interface NicknameStore {
  /** The nickname for a device key, or null when none is set. */
  get(device: string): string | null
  /** Set, or clear when the cleaned name is empty. Memory first, then disk. */
  set(device: string, name: string): void
  /** A fresh copy each call, safe to hand to React state. */
  all(): Record<string, string>
}

export function createStore(file: TextFile): NicknameStore {
  let held: Record<string, string> | null = null

  const complain = (what: string, e: unknown) =>
    console.warn(`nicknames ${what} failed, holding in memory only: ${String(e)}`)

  function load(): Record<string, string> {
    if (held) return held
    held = {}
    try {
      const text = file.read()
      if (text !== null) {
        const parsed: unknown = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [device, name] of Object.entries(parsed)) {
            // Only non-empty strings survive: anything else is a foreign or damaged
            // file, and one bad value must not take the readable ones with it.
            if (typeof name === 'string' && name.length > 0) held[device] = name
          }
        }
      }
    } catch (e) {
      complain('read', e)
    }
    return held
  }

  function persist(map: Record<string, string>): void {
    try {
      file.write(JSON.stringify(map))
    } catch (e) {
      complain('write', e)
    }
  }

  return {
    get(device) {
      return nicknameIn(load(), device)
    },
    set(device, name) {
      const map = load()
      const cleaned = clean(name)
      if (cleaned) map[device] = cleaned
      else delete map[device]
      persist(map)
    },
    all() {
      return { ...load() }
    },
  }
}
