/**
 * What the app remembers between sittings: defaults, per-pair colours, the last pair.
 *
 * Exists because of one line of handset feedback (2026-08-11): "Why do i have to
 * select panel setting each time? Should be a default." Brightness was mount-scoped
 * React state, so every visit started from nothing. Everything here is the answer to
 * that shape of complaint: a setting is written when the user picks it and applied
 * without being asked for again.
 *
 * Three kinds of fact, and the split matters:
 *
 *  - **defaults** are app-wide: panel brightness, scroll speed, direction. Applied on
 *    connect and pre-selected in the creators.
 *  - **themes** are per pair, keyed on the advert name - the same key the ledger and
 *    the nicknames use, so a colour follows the unit, not the platform handle.
 *  - **lastPair** is the advert name of the last pair this phone opened, so the
 *    Glasses tab can reconnect without ceremony at a festival.
 *  - **carried** is what each pair answered when it was last probed, per pair, on the
 *    same key. Kept so a reconnect has something to show before the probe lands, and
 *    handed back as `Remembered` rather than `Carried` so it can never be gated on:
 *    `carried.ts` explains why a stale answer is not evidence.
 *
 * Same pure-store-plus-injected-file pattern as `nicknames.ts`, and its own file on
 * disk (`settings-store.ts`), never the ledger's: losing a default costs a tap,
 * losing a wear count costs hardware, and they must not share a failure.
 *
 * The pairs map is a `Map`, not an object, for the reason review-10 recorded against
 * the nickname store: an object read by key answers `Object.prototype` members for a
 * device that advertises as `__proto__`.
 */
import { type Carried, type Remembered, cleanCarried, remember } from './carried.js'
import type { TextFile } from './nicknames.js'

export interface Defaults {
  /** `LIGHT`, 1 to 5. The firmware floors at 1; there is no 0. */
  brightness: number
  /** `SPEED`, 0 to 100. */
  speed: number
  /** `MODE 02` direction. */
  dir: 0 | 1
}

export const FALLBACK: Defaults = { brightness: 3, speed: 65, dir: 0 }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

const clampBrightness = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.max(1, Math.min(5, Math.round(v)))
    : FALLBACK.brightness

const clampSpeed = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.max(0, Math.min(100, Math.round(v)))
    : FALLBACK.speed

const cleanDir = (v: unknown): 0 | 1 => (v === 1 ? 1 : 0)

/** An ordered list of unique non-empty strings; anything else is dropped. */
function cleanKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const key of raw) {
    if (typeof key !== 'string' || key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/**
 * A named set of favourites, so a festival is not one long row.
 *
 * *"Maybe even groups of favourites"* (Jacob, 2026-08-12). An item may be in several,
 * because "Walk to the stage" and "Waluigi" are different reasons to keep a thing and
 * both are true at once. Groups do not own anything: the keys are the same key space as
 * `favourites`, and a key whose item is gone resolves to nothing rather than needing a
 * delete to reach in here.
 */
export interface Group {
  name: string
  keys: string[]
}

const MAX_GROUPS = 12
const MAX_NAME = 24

/** Trimmed, capped, and never empty, or a group is unnameable and unpickable. */
const cleanName = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const name = raw.trim().slice(0, MAX_NAME).trim()
  return name === '' ? null : name
}

function cleanGroups(raw: unknown): Group[] {
  if (!Array.isArray(raw)) return []
  const out: Group[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const name = cleanName(entry.name)
    // Case-insensitive uniqueness: two groups a person cannot tell apart are worse than
    // one, and the picker shows the name rather than any id.
    if (name === null || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push({ name, keys: cleanKeys(entry.keys) })
    if (out.length >= MAX_GROUPS) break
  }
  return out
}

/** What of a parsed file survives. Anything malformed falls back, never throws. */
export function revive(raw: unknown): {
  defaults: Defaults
  themes: Map<string, string>
  lastPair: string | null
  favourites: string[]
  hidden: string[]
  groups: Group[]
  carried: Map<string, Remembered>
} {
  const root = isRecord(raw) ? raw : {}
  const d = isRecord(root.defaults) ? root.defaults : {}
  const themes = new Map<string, string>()
  if (isRecord(root.themes)) {
    for (const [device, theme] of Object.entries(root.themes)) {
      if (typeof theme === 'string' && theme !== '' && device !== '') {
        themes.set(device, theme)
      }
    }
  }
  // Shape-checked by `carried.ts` rather than here, so the dashboard cannot be handed a
  // string where a bitmap belongs by a file an older or newer app wrote.
  const carried = new Map<string, Remembered>()
  if (isRecord(root.carried)) {
    for (const [device, entry] of Object.entries(root.carried)) {
      const kept = cleanCarried(entry)
      if (kept !== null && device !== '') carried.set(device, kept)
    }
  }
  return {
    defaults: {
      brightness: clampBrightness(d.brightness),
      speed: clampSpeed(d.speed),
      dir: cleanDir(d.dir),
    },
    themes,
    lastPair: typeof root.lastPair === 'string' && root.lastPair !== '' ? root.lastPair : null,
    favourites: cleanKeys(root.favourites),
    hidden: cleanKeys(root.hidden),
    groups: cleanGroups(root.groups),
    carried,
  }
}

export interface SettingsStore {
  defaults(): Defaults
  /** Clamped on the way in, so a slider bug cannot persist an illegal LIGHT level. */
  setDefaults(patch: Partial<Defaults>): Defaults
  /** The theme id this pair wears, or null for the default. */
  theme(device: string): string | null
  /** Null clears it. Unknown ids are stored as given; `themeById` falls back on read. */
  setTheme(device: string, theme: string | null): void
  lastPair(): string | null
  setLastPair(device: string | null): void
  /**
   * What this pair answered when it was last probed, or null.
   *
   * `Remembered`, not `Carried`: it is display only and the type stops it reaching
   * `can()`. A pair can be reflashed between sittings, so this is what it *was*.
   */
  carried(device: string): Remembered | null
  /** Record this connection's own probe answer. Null forgets it. */
  setCarried(device: string, carried: Carried | null): void
  /**
   * The pinned grid at the top of Show, in the order things were pinned. Keys are
   * built-in ids or `mine:<id>`; a key whose item is gone is simply never resolved,
   * so nothing here has to hear about deletes.
   */
  favourites(): string[]
  /** Returns the new state: true means it is now a favourite. */
  toggleFavourite(key: string): boolean
  /** Built-ins put away by long-press. Same key space. */
  hidden(): string[]
  toggleHidden(key: string): boolean
  /** Named subsets of the favourites, in the order they were made. */
  groups(): Group[]
  /** Makes it if it is new. Returns the name as stored, or null if unusable. */
  addGroup(name: string): string | null
  removeGroup(name: string): void
  /**
   * Put a key in a group or take it out. Returns the new state.
   *
   * Adding to a group also makes the key a favourite, because a group is a view of the
   * favourites and a member that is not one would be invisible everywhere.
   */
  toggleInGroup(name: string, key: string): boolean
}

export function createSettings(file: TextFile): SettingsStore {
  let state: ReturnType<typeof revive>
  try {
    const text = file.read()
    state = revive(text === null ? null : JSON.parse(text))
  } catch {
    state = revive(null)
  }

  const persist = () => {
    try {
      file.write(
        JSON.stringify({
          defaults: state.defaults,
          themes: Object.fromEntries(state.themes),
          lastPair: state.lastPair,
          favourites: state.favourites,
          hidden: state.hidden,
          groups: state.groups,
          // The `remembered` marker is a runtime brand, not data: it is put back by
          // `cleanCarried` on the way in, so nothing on disk depends on it.
          carried: Object.fromEntries(
            [...state.carried].map(([device, c]) => [
              device,
              { kind: c.kind, version: c.version, capabilities: c.capabilities, at: c.at },
            ]),
          ),
        }),
      )
    } catch {
      // A phone that will not write still keeps the choice for this session. The
      // stores this pattern comes from degrade the same way, and a default is the
      // cheapest thing in the app to lose.
    }
  }

  const toggle = (list: string[], key: string): [string[], boolean] => {
    if (key === '') return [list, false]
    if (list.includes(key)) return [list.filter((k) => k !== key), false]
    return [[...list, key], true]
  }

  return {
    defaults: () => ({ ...state.defaults }),
    setDefaults(patch) {
      state.defaults = {
        brightness:
          patch.brightness === undefined
            ? state.defaults.brightness
            : clampBrightness(patch.brightness),
        speed: patch.speed === undefined ? state.defaults.speed : clampSpeed(patch.speed),
        dir: patch.dir === undefined ? state.defaults.dir : cleanDir(patch.dir),
      }
      persist()
      return { ...state.defaults }
    },
    theme: (device) => state.themes.get(device) ?? null,
    setTheme(device, theme) {
      if (device === '') return
      if (theme === null) state.themes.delete(device)
      else state.themes.set(device, theme)
      persist()
    },
    lastPair: () => state.lastPair,
    setLastPair(device) {
      state.lastPair = device === '' ? null : device
      persist()
    },
    carried: (device) => state.carried.get(device) ?? null,
    setCarried(device, carried) {
      if (device === '') return
      if (carried === null) state.carried.delete(device)
      else state.carried.set(device, remember(carried))
      persist()
    },
    favourites: () => [...state.favourites],
    toggleFavourite(key) {
      const [next, on] = toggle(state.favourites, key)
      state.favourites = next
      persist()
      return on
    },
    hidden: () => [...state.hidden],
    toggleHidden(key) {
      const [next, on] = toggle(state.hidden, key)
      state.hidden = next
      persist()
      return on
    },
    groups: () => state.groups.map((g) => ({ name: g.name, keys: [...g.keys] })),
    addGroup(name) {
      const kept = cleanName(name)
      if (kept === null) return null
      const held = state.groups.find((g) => g.name.toLowerCase() === kept.toLowerCase())
      // Answering with the existing name rather than making a second one: a person
      // typing a name that already exists means that group, not a duplicate of it.
      if (held) return held.name
      if (state.groups.length >= MAX_GROUPS) return null
      state.groups = [...state.groups, { name: kept, keys: [] }]
      persist()
      return kept
    },
    removeGroup(name) {
      const before = state.groups.length
      state.groups = state.groups.filter((g) => g.name.toLowerCase() !== name.trim().toLowerCase())
      // The members stay favourites: deleting a way of organising things must not
      // silently delete the things.
      if (state.groups.length !== before) persist()
    },
    toggleInGroup(name, key) {
      const group = state.groups.find((g) => g.name.toLowerCase() === name.trim().toLowerCase())
      if (!group || key === '') return false
      const [keys, on] = toggle(group.keys, key)
      group.keys = keys
      if (on && !state.favourites.includes(key)) state.favourites = [...state.favourites, key]
      persist()
      return on
    },
  }
}
