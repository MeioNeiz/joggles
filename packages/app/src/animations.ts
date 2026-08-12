/**
 * The imported animation pack: hundreds of things nobody in this repo drew, searchable.
 *
 * `builtins.ts` is the firmware's own 30 items and it is deliberately **not** searchable:
 * those are numbered rather than named, because a name read off an offline render is a
 * guess, and a confident wrong name is something a person searches for and fails to find
 * (`notes/library.md`). This file is the opposite case and that is the whole point of it.
 * These animations arrive from outside with **real names, real authors and real tags**, so
 * searching them is not a guess - it is the only way to find one thing among hundreds.
 *
 * `research/tools/animpack.ts` harvests them offline and writes `animpack-data.ts`, the
 * same generated-file arrangement `bankdump.ts` and `builtins-data.ts` already use, and
 * for the same reason: the phone cannot fetch and convert a sprite sheet at a festival, so
 * the conversion happens once on a laptop and the result is checked in.
 *
 * ## What this file is not
 *
 * It holds no pixels and decodes nothing. A row carries its frames as packed strings and
 * `quantise.unpackBitmap` is what turns one into a `Bitmap`, called by whoever actually
 * needs to draw - which for hundreds of rows is a handful of visible tiles and not the
 * whole catalogue. Decoding every row on import would be hundreds of 24x9 allocations
 * before the first tile appeared, so the split is deliberate: **this module searches, the
 * screen decodes.**
 *
 * Nor does it know how anything reaches the panel. `core/src/anim.ts` owns that, including
 * the fact that a saved one pans rather than plays.
 */
import { type Bitmap, anim, quantise } from '@joggles/core'
import { PACK_ROWS } from './animpack-data.js'

/**
 * One harvested animation. `animpack-data.ts` is typed by this and generated against it.
 *
 * `licence` and `author` are not decoration: everything bundled is CC0 so nothing is
 * legally owed, but the pack a row came from is how a person checks that claim, and
 * dropping the provenance would make it uncheckable. `source` is where they go to look.
 */
export interface PackRow {
  id: string
  name: string
  tags: string[]
  pack: string
  licence: string
  author: string
  source: string
  /** Per frame, ms, raw from the source. `anim.normalise()` owns the 0 and the clamp. */
  frameMs: number[]
  /** `quantise.packBitmap()` output, one per frame, each 24x9 at four levels. */
  frames: string[]
  /** 0-1, how much survived the downscale. The catalogue is ordered by it. */
  score: number
}

/**
 * Everything harvested, best first.
 *
 * Ordered by score rather than by name because the failure mode of a big converted
 * library is a first screen full of grey mush: the harvest already rejects the worst, and
 * this puts the ones that read at 24x9 where a thumb lands. Name is the tie-break so the
 * order is stable across rebuilds of the pack.
 */
export const PACK: PackRow[] = [...PACK_ROWS].sort(
  (a, b) => b.score - a.score || a.name.localeCompare(b.name),
)

export const byId = (id: string): PackRow | null => PACK.find((r) => r.id === id) ?? null

/** Whether it is an animation at all: a one-frame row is a picture and says so. */
export const moves = (row: PackRow): boolean => row.frames.length > 1

/** One cycle in ms, from the source's own timing. */
export const durationMs = (row: PackRow): number =>
  row.frameMs.reduce((sum, ms) => sum + ms, 0)

/** How long a loop runs, for a tile with a few characters to say it in. */
export const loopWords = (row: PackRow): string =>
  moves(row)
    ? `${row.frames.length} frames, ${(durationMs(row) / 1000).toFixed(1)}s`
    : 'still'

/**
 * Match a query against a row.
 *
 * Every term must hit something, which is what makes two words useful ("walk skeleton"
 * rather than everything matching either). A term hits the name, any tag, the pack or the
 * author: the pack and author are in there because "kenney" is a real thing a person types
 * once they know a pack they like, and leaving it out would make the provenance
 * decorative.
 */
export function matches(row: PackRow, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0)
  if (terms.length === 0) return true
  const haystack = [row.name, row.pack, row.author, ...row.tags].join(' ').toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

export interface Filter {
  query?: string
  /** `true` animations only, `false` stills only, absent for both. */
  moving?: boolean
  /** Restrict to one source pack. */
  pack?: string
}

/**
 * The catalogue narrowed.
 *
 * Order is preserved rather than recomputed, so the default is best-first because `PACK`
 * already is. Re-sorting here would mean scoring hundreds of rows again on every keystroke
 * to arrive at the order they were already in.
 */
export function search(filter: Filter = {}, rows: PackRow[] = PACK): PackRow[] {
  return rows.filter((row) => {
    if (filter.moving !== undefined && moves(row) !== filter.moving) return false
    if (filter.pack !== undefined && row.pack !== filter.pack) return false
    return matches(row, filter.query ?? '')
  })
}

/** The source packs with a count each, for a filter row that names real things. */
export function packs(rows: PackRow[] = PACK): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.pack, (counts.get(row.pack) ?? 0) + 1)
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/**
 * A row's frames as an animation, decoded once and remembered.
 *
 * The cache is the point. A grid of tiles renders the same rows repeatedly as a list
 * recycles them, and decoding is 216 pixels a frame times however many frames: cheap once,
 * wasteful every scroll. Keyed on the row id, and the pack is immutable and generated, so
 * there is no invalidation case to get wrong.
 *
 * `anim.normalise()` is applied here rather than in the pack, which is why the generated
 * file carries raw source timings: the 0 ms rule and the merging of repeated frames are
 * one implementation, in core, and a pack baked with them already applied could not be
 * re-read if that rule ever changed.
 */
const decoded = new Map<string, anim.Animation>()

export function animationOf(row: PackRow): anim.Animation {
  const had = decoded.get(row.id)
  if (had !== undefined) return had
  const made = anim.normalise({
    frames: row.frames.map(quantise.unpackBitmap),
    frameMs: row.frameMs,
  })
  decoded.set(row.id, made)
  return made
}

/** The first frame alone, for a tile that must not decode a whole loop to draw itself. */
export function thumbOf(row: PackRow): Bitmap {
  return quantise.unpackBitmap(row.frames[0])
}

/**
 * What the empty state says, which depends on why it is empty.
 *
 * An unharvested pack and a query that matched nothing look identical on screen and are
 * completely different problems, so they get different sentences. The first is a build
 * step nobody ran; the second is a search.
 *
 * `total` is a parameter rather than a read of `PACK` so that the sentence for a given
 * state is a fact about its arguments: reading the module's own catalogue would make this
 * answer change when the pack is harvested, which is exactly what a test cannot pin.
 */
export function emptyWords(filter: Filter = {}, total: number = PACK.length): string {
  if (total === 0) {
    return 'No animations imported yet. Run `bun run animpack fetch` then `emit` on a '
      + 'laptop: the conversion happens once, off the phone, and ships checked in.'
  }
  const q = (filter.query ?? '').trim()
  if (q.length > 0) return `Nothing in the pack matches "${q}".`
  if (filter.moving === true) return 'Nothing in this pack moves.'
  if (filter.moving === false) return 'Everything in this pack moves.'
  return 'Nothing here.'
}
