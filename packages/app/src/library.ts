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
import { content, display, effects, font } from '@joggles/core'

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
  /**
   * The face it was written in, by `Font.name`. Absent means `band5`, for ever.
   *
   * **Not `font.DEFAULT_FONT`**, deliberately: an item saved before this field existed
   * was drawn in band5, and resolving it through whatever the default happens to be
   * would resize every old message the day someone changes that default. The motion is
   * still not stored, because `font.textWidth` against the panel derives it (track 29).
   */
  font?: string
}

/**
 * An effect recipe: the generator's name and knobs, never the rendered columns.
 *
 * A rendered 736-column loop is ~6.6 KB of digits per item and it is derivable, so
 * storing it would be a cache that can silently disagree with the generator that made
 * it. The recipe re-renders identically because the generators are pure; if one ever
 * changes, the item follows it, which is the right answer for a library of "things I
 * like" rather than byte-exact archives.
 */
export interface SavedEffect {
  kind: 'effect'
  id: string
  name: string
  at: number
  /** A name in `effects.EFFECT_NAMES`. Unknown generators are dropped on revive. */
  effect: string
  /** The knobs as the catalogue shapes them. Only primitives survive revive. */
  opts: Record<string, number | boolean | string>
  columns: number
  dither: 'ordered' | 'none'
  motion: content.Motion
}

export type SavedItem = SavedDrawing | SavedText | SavedEffect

/**
 * Where the items live between runs. `library-store.ts` is the real one, over
 * expo-file-system; tests hand in memory. `load` answers with whatever the file
 * parsed to and `revive()` decides what of it survives, so the glue never needs a
 * copy of the rules.
 *
 * Neither method should throw: the real store warns and degrades to memory, as
 * `ledger.ts` does. A `save` that rejects anyway leaves the item in memory and the
 * rejection with the caller, so the screen's message and the next listing disagree
 * until the file is read again.
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

/**
 * Rounded as well as clamped: `SPEED` carries one byte, so the device truncates a
 * fractional speed while `speed.ts` buckets it as given, and the two would then
 * disagree about how fast the preview should run.
 */
const clampSpeed = (s: number): number =>
  Math.max(0, Math.min(content.MAX_SPEED, Math.round(s)))

/** Rebuilt, not passed through, so stray JSON fields never ride into memory. */
function cleanMotion(raw: unknown): content.Motion | null {
  if (!isRecord(raw)) return null
  if (raw.kind === 'static') return { kind: 'static' }
  if (raw.kind !== 'scroll') return null
  if (raw.dir !== 0 && raw.dir !== 1) return null
  if (typeof raw.speed !== 'number' || !Number.isFinite(raw.speed)) return null
  return { kind: 'scroll', dir: raw.dir, speed: clampSpeed(raw.speed) }
}

/**
 * Only own, primitive entries survive, rebuilt onto a fresh object. Hostile keys
 * (`__proto__` and kin) are dropped rather than escaped, because no generator reads
 * them and a knob bag is not a place to be clever.
 */
function cleanOpts(raw: unknown): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {}
  if (!isRecord(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (typeof value === 'string' || typeof value === 'boolean') out[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

/** Clamped to what the generators accept: the panel's width up to the dither ceiling. */
const clampColumns = (raw: unknown): number | null =>
  typeof raw === 'number' && Number.isFinite(raw)
    ? Math.max(display.COLS, Math.min(effects.MAX_COLUMNS, Math.round(raw)))
    : null

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
    if (!motion) return null
    // An unknown or misspelt face is not fatal the way an unknown generator is: the
    // text still renders, just in the legacy face, so `fontByName`'s own fallback is
    // the whole rule and a name we do not recognise is dropped rather than kept.
    const named = typeof raw.font === 'string' ? font.fontByName(raw.font) : null
    const kept = named && named.name === raw.font ? { font: named.name } : {}
    return { kind: 'text', ...base, text: raw.text, motion, ...kept }
  }
  if (raw.kind === 'effect') {
    // An unknown generator is a different app's item, not a survivable one: rendering
    // it would throw inside a screen, so it is dropped the way a wrong-shaped drawing is.
    if (typeof raw.effect !== 'string' || !effects.EFFECT_NAMES.includes(raw.effect)) {
      return null
    }
    const motion = cleanMotion(raw.motion)
    const columns = clampColumns(raw.columns)
    const dither = raw.dither === 'none' || raw.dither === 'ordered' ? raw.dither : null
    if (motion === null || columns === null || dither === null) return null
    return {
      kind: 'effect',
      ...base,
      effect: raw.effect,
      opts: cleanOpts(raw.opts),
      columns,
      dither,
      motion,
    }
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

/**
 * Search the phone's own items: the name, and what a text item actually says.
 *
 * **The 30 built-ins are browsed and never reach here, and that is a decision rather
 * than an omission** (`notes/library.md`, "Search reaches our things and cannot reach
 * the built-ins"). Track 20 numbered them instead of naming them, because a name read
 * off an offline render is a guess about content nobody has watched. So there is no
 * text to match on, and inventing some would be worse than having none: a user would
 * search for the word we made up, and the tile behind it might be playing something
 * else entirely. Naming them is a hardware sitting, not a code change, and the screen
 * says so rather than silently returning nothing.
 *
 * **Nothing else is a matching surface, deliberately.** A kind and a date are filters,
 * not search terms, and the generator is already in the name a recipe gets by default
 * ("Plasma 3", "Drawing 2"), so matching on the kind as well would return items whose
 * visible label contains nothing of what was typed. What a person sees on a tile is
 * what they can search for.
 *
 * Terms are ANDed and order does not matter, so "party time" finds "Time to party". A
 * blank query is search switched off rather than a search that matched nothing, which
 * is the difference between an empty field showing everything and showing an empty
 * screen.
 */
export function search(items: SavedItem[], query: string): SavedItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== '')
  if (terms.length === 0) return items
  return items.filter((item) => {
    const hay = (item.kind === 'text' ? `${item.name} ${item.text}` : item.name).toLowerCase()
    return terms.every((term) => hay.includes(term))
  })
}

/**
 * The next unused `<prefix> N`, taken from the highest number already there rather
 * than from a count: deleting one of three drawings would make a count hand out a
 * name that is already taken, and two identical rows in a list cannot be told apart
 * even though their ids differ.
 */
function nextName(items: SavedItem[], prefix: string): string {
  const numbered = new RegExp(`^${prefix} (\\d+)$`)
  let top = 0
  for (const item of items) {
    const n = Number(numbered.exec(item.name)?.[1])
    // Only numbers this function could have written itself, so `+ 1` is exact. A
    // hand-edited `Drawing 9007199254740993` parses to the same double as one more
    // than itself, and would be handed out twice.
    if (Number.isSafeInteger(n) && n < Number.MAX_SAFE_INTEGER && n > top) top = n
  }
  return `${prefix} ${top + 1}`
}

function copy(item: SavedItem): SavedItem {
  if (item.kind === 'drawing') return { ...item, levels: item.levels.map((row) => row.slice()) }
  if (item.kind === 'effect') {
    return { ...item, opts: { ...item.opts }, motion: { ...item.motion } }
  }
  return { ...item, motion: { ...item.motion } }
}

export class Library {
  private loading: Promise<SavedItem[]> | null = null
  private seq = 0

  constructor(
    private readonly store: LibraryStore,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The one read, shared by everything.
   *
   * The **promise** is what is remembered, not the array it settles to. Caching the
   * array means every caller that arrives while the first read is in flight starts
   * its own, and the last to finish replaces the list the others are holding: a
   * delete or a rename that raced the read is then undone in memory and written
   * back by the next save. One `library` singleton and several screens over it is
   * exactly that shape.
   *
   * A failed read is not remembered, so storage that becomes readable later still
   * loads rather than leaving the library dead for the session.
   */
  private held(): Promise<SavedItem[]> {
    this.loading ??= this.store.load().then(revive, (e) => {
      this.loading = null
      throw e
    })
    return this.loading
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
   *
   * Unnamed drawings are numbered here rather than by the screen, because only this
   * class can see every item and so only it can pick a name nothing else holds.
   */
  async saveDrawing(levels: content.Bitmap, name = ''): Promise<SavedDrawing> {
    const clean = cleanLevels(levels)
    if (clean === null) {
      throw new Error(`a drawing is ${display.ROWS} rows of ${display.COLS} levels`)
    }
    const kept = name.trim() || nextName(await this.held(), 'Drawing')
    const item = { kind: 'drawing' as const, name: kept, levels: clean }
    return (await this.add(item)) as SavedDrawing
  }

  /** Save what Compose holds: the text, the motion derived from it, and the face. */
  async saveText(
    text: string,
    motion: content.Motion,
    name = '',
    face?: string,
  ): Promise<SavedText> {
    if (text.trim() === '') throw new Error('nothing to save: the text is empty')
    const clean = cleanMotion(motion)
    if (clean === null) throw new Error('malformed motion')
    // Stored only when it is a face we know AND not the legacy one, so an item written
    // in band5 keeps looking like every item written before the field existed.
    const named = face ? font.fontByName(face) : null
    const kept =
      named && named.name === face && named !== font.LEGACY_FONT ? { font: named.name } : {}
    const item = {
      kind: 'text' as const,
      name: name.trim() || text.trim(),
      text,
      motion: clean,
      ...kept,
    }
    return (await this.add(item)) as SavedText
  }

  /**
   * Save an effect recipe. Validated through the same `cleanItem` rules a revive
   * applies, so a screen cannot store what a restart would then drop.
   */
  async saveEffect(
    spec: Pick<SavedEffect, 'effect' | 'opts' | 'columns' | 'dither' | 'motion'>,
    name = '',
  ): Promise<SavedEffect> {
    if (!effects.EFFECT_NAMES.includes(spec.effect)) {
      throw new Error(`no generator called "${spec.effect}"`)
    }
    const motion = cleanMotion(spec.motion)
    const columns = clampColumns(spec.columns)
    if (motion === null || columns === null) throw new Error('malformed effect')
    const label = spec.effect.charAt(0).toUpperCase() + spec.effect.slice(1)
    const item = {
      kind: 'effect' as const,
      name: name.trim() || nextName(await this.held(), label),
      effect: spec.effect,
      opts: cleanOpts(spec.opts),
      columns,
      dither: spec.dither,
      motion,
    }
    return (await this.add(item)) as SavedEffect
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

  private async add(
    partial:
      | Omit<SavedDrawing, 'id' | 'at'>
      | Omit<SavedText, 'id' | 'at'>
      | Omit<SavedEffect, 'id' | 'at'>,
  ) {
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
