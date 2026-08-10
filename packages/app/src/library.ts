/**
 * Saved-for-later content: drawings off the canvas and text presets off Compose.
 *
 * It lives on the phone because the glasses cannot hold "later". There is one DATS
 * buffer per type with no slot index, only type 1 survives a power cycle, and type 1
 * flattens grey to 1 bit, so a second saved thing always evicts the first and a
 * greyscale drawing cannot persist on the device at all (`notes/app-plan.md`, "The
 * two delivery routes"). The phone keeps the real content and the existing delivery
 * paths put it back on the panel when asked.
 *
 * Nothing here touches the radio, the glasses, or the flash budget. A library save
 * is a local file write: free, instant, unlimited. Recalling an item goes out
 * through the same guarded paths as fresh content - `deliver()` for text, the live
 * sender for a drawing - so recall cannot dodge the flash rules, and this module
 * never needs to know they exist.
 *
 * A separate file from the ledger, the nicknames reasoning from the board: losing a
 * wear count matters and losing a preset does not, so a bug here must not be able
 * to take `ledger.json` down with it.
 *
 * `revive()` is the trust boundary, in this file rather than the store glue so it
 * runs under bun. The store hands back whatever `JSON.parse` produced: an
 * interrupted write leaves plausible garbage as easily as broken syntax, and this
 * is read on the way into a screen, so a malformed entry is dropped, a survivable
 * one is clamped, and nothing throws. Same degrade-to-empty stance as `ledger.ts`.
 */
import { content, display } from '@joggles/core'

/** A drawing off the canvas: the 9x24 levels exactly as `Canvas.levels()` reports. */
export interface SavedDrawing {
  kind: 'drawing'
  id: string
  name: string
  /** ms since epoch, when it was saved. */
  at: number
  levels: content.Bitmap
}

/** A Compose preset: what the user typed plus the motion they chose. */
export interface SavedText {
  kind: 'text'
  id: string
  name: string
  at: number
  text: string
  motion: content.Motion
}

export type SavedItem = SavedDrawing | SavedText

/**
 * Where the items live between runs. `library-store.ts` is the real one, over
 * expo-file-system; tests hand in memory. `load` answers with whatever the file
 * parsed to and `revive()` decides what of it survives, so the glue never needs a
 * copy of the rules.
 */
export interface LibraryStore {
  load(): Promise<unknown>
  save(items: SavedItem[]): Promise<void>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

/**
 * Exactly the panel's shape or nothing. Values are clamped rather than refused so a
 * change to `MAX_LEVEL` cannot invalidate a library, but a wrong row or column
 * count is a different drawing and inventing pixels for it would lie to the user.
 */
function cleanLevels(raw: unknown): content.Bitmap | null {
  if (!Array.isArray(raw) || raw.length !== display.ROWS) return null
  const out: number[][] = []
  for (const row of raw) {
    if (!Array.isArray(row) || row.length !== display.COLS) return null
    const cells: number[] = []
    for (const cell of row) {
      if (typeof cell !== 'number' || !Number.isFinite(cell)) return null
      cells.push(Math.max(0, Math.min(display.MAX_LEVEL, Math.round(cell))))
    }
    out.push(cells)
  }
  return out
}

const clampSpeed = (s: number): number => Math.max(0, Math.min(content.MAX_SPEED, s))

/** Rebuilt, not passed through, so stray JSON fields never ride into memory. */
function cleanMotion(raw: unknown): content.Motion | null {
  if (!isRecord(raw)) return null
  if (raw.kind === 'static') return { kind: 'static' }
  if (raw.kind !== 'scroll') return null
  if (raw.dir !== 0 && raw.dir !== 1) return null
  if (typeof raw.speed !== 'number' || !Number.isFinite(raw.speed)) return null
  return { kind: 'scroll', dir: raw.dir, speed: clampSpeed(raw.speed) }
}

function cleanItem(raw: unknown): SavedItem | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || raw.id === '') return null
  if (typeof raw.name !== 'string') return null
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return null
  const base = { id: raw.id, name: raw.name, at: raw.at }
  if (raw.kind === 'drawing') {
    const levels = cleanLevels(raw.levels)
    return levels ? { kind: 'drawing', ...base, levels } : null
  }
  if (raw.kind === 'text') {
    if (typeof raw.text !== 'string' || raw.text.trim() === '') return null
    const motion = cleanMotion(raw.motion)
    return motion ? { kind: 'text', ...base, text: raw.text, motion } : null
  }
  return null
}

/** What of a parsed file survives. Anything malformed is dropped, never repaired. */
export function revive(raw: unknown): SavedItem[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: SavedItem[] = []
  for (const entry of raw) {
    const item = cleanItem(entry)
    if (item === null || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  // Sorted here rather than trusted from the file, so `all()` means what it says
  // whatever wrote the JSON. Stable, so same-instant items keep their file order.
  return out.sort((a, b) => b.at - a.at)
}

const copy = (item: SavedItem): SavedItem =>
  item.kind === 'drawing'
    ? { ...item, levels: item.levels.map((row) => row.slice()) }
    : { ...item, motion: { ...item.motion } }

export class Library {
  private items: SavedItem[] | null = null
  private seq = 0

  constructor(
    private readonly store: LibraryStore,
    private readonly now: () => number = Date.now,
  ) {}

  private async held(): Promise<SavedItem[]> {
    if (this.items === null) this.items = revive(await this.store.load())
    return this.items
  }

  /** Newest first. Copies: mutating what this returns changes nothing held. */
  async all(): Promise<SavedItem[]> {
    return (await this.held()).map(copy)
  }

  async get(id: string): Promise<SavedItem | null> {
    const found = (await this.held()).find((item) => item.id === id)
    return found ? copy(found) : null
  }

  /**
   * Save the canvas. `levels` is what `Canvas.levels()` reports, copied and clamped
   * on the way in, so drawing on after saving edits nothing here.
   */
  async saveDrawing(levels: content.Bitmap, name = ''): Promise<SavedDrawing> {
    const clean = cleanLevels(levels)
    if (clean === null) {
      throw new Error(`a drawing is ${display.ROWS} rows of ${display.COLS} levels`)
    }
    const item = { kind: 'drawing' as const, name: name.trim() || 'Drawing', levels: clean }
    return (await this.add(item)) as SavedDrawing
  }

  /** Save what Compose holds: the text and the motion the user chose. */
  async saveText(text: string, motion: content.Motion, name = ''): Promise<SavedText> {
    if (text.trim() === '') throw new Error('nothing to save: the text is empty')
    const clean = cleanMotion(motion)
    if (clean === null) throw new Error('malformed motion')
    const item = { kind: 'text' as const, name: name.trim() || text.trim(), text, motion: clean }
    return (await this.add(item)) as SavedText
  }

  /** False when there is nothing to do: unknown id, blank name, or already so. */
  async rename(id: string, name: string): Promise<boolean> {
    const items = await this.held()
    const found = items.find((item) => item.id === id)
    const kept = name.trim()
    if (!found || kept === '' || found.name === kept) return false
    found.name = kept
    await this.store.save(items)
    return true
  }

  async remove(id: string): Promise<boolean> {
    const items = await this.held()
    const at = items.findIndex((item) => item.id === id)
    if (at < 0) return false
    items.splice(at, 1)
    await this.store.save(items)
    return true
  }

  private async add(partial: Omit<SavedDrawing, 'id' | 'at'> | Omit<SavedText, 'id' | 'at'>) {
    const items = await this.held()
    const item: SavedItem = { ...partial, id: this.freshId(items), at: this.now() }
    items.unshift(item)
    await this.store.save(items)
    return copy(item)
  }

  /**
   * The counter alone would collide after a reload, since `seq` restarts at zero
   * while the file remembers, so it climbs past whatever is already taken.
   */
  private freshId(items: SavedItem[]): string {
    const taken = new Set(items.map((item) => item.id))
    for (;;) {
      const id = (this.seq++).toString(36)
      if (!taken.has(id)) return id
    }
  }
}
