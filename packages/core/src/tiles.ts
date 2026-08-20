/**
 * The tile palette, host side: sixteen column patterns, and a whole panel per write.
 *
 * `notes/what-to-build.md` ranks this "best value" among the firmware patches, and the
 * reason is arithmetic rather than taste. Every other route to an arbitrary frame is
 * one BLE write per column, so it sweeps left to right at ~6.4 ms a column; the rhythm
 * channel is atomic and draws **bars only**; a type 2 image is atomic and costs a full
 * `DATS` round trip. A `TILE_FRAME` is 24 palette indices in one 16-byte write, so it
 * neither sweeps nor spends flash, and what it can draw is whatever sixteen columns we
 * chose to define. This module is the choosing, the encoding, and the one piece of
 * state that keeps the two halves honest.
 *
 * The wire format is `jgx.ts` (`SUB.TILE_DEF`, `SUB.TILE_FRAME`) and every frame here
 * is built by it rather than re-encoded, so there is one definition of the bytes.
 *
 * ## Nothing here has run
 *
 * **No unit carries the extension**, the slot that would answer `TILE_DEF` is not
 * written, and nobody has watched a tile frame land. Every claim below is *derived*
 * from the wire format and this panel's geometry. What that costs in practice: the
 * ordering rule and the mask rule are both testable offline and are tested, and the
 * only thing that can overturn them is a look at the panel.
 *
 * ## The palette is not atomic and a frame is, which is the whole design
 *
 * Sixteen entries of three bytes is 48, and a command body is 15, so a palette takes
 * **four** `TILE_DEF` frames while a `TILE_FRAME` is one. So there is a state a caller
 * can be in that the wire cannot express: half a palette. Draw from it and the columns
 * addressing the entries that have not landed show whatever the *previous* palette left
 * there, which is not a corruption anything reports.
 *
 * Two things make that unreachable rather than merely documented:
 *
 *  - **`Palette` is complete by construction.** Its constructor is private, `Palette.of`
 *    is the only way to one, and it pads to `TILE_COUNT` with the dark tile. There is no
 *    such value as a palette of five entries, so "half a palette" cannot be passed
 *    around as data.
 *  - **`Painter` holds a believed word per entry**, in the shape `sender.ts` uses for
 *    live columns: a desired palette and a believed-held one, never a queue of writes.
 *    `frame()` refuses, with the entry numbers in the message, until every entry the
 *    frame *uses* is believed held. Using rather than all sixteen, because a picture
 *    needing four tiles is genuinely safe to draw after one `TILE_DEF`, and refusing
 *    that would be inventing a constraint the hardware does not have.
 *
 * **Belief is per connection and cannot be re-synced.** There is no sub-command that
 * asks a unit what its palette holds, deliberately, so a lost belief can only be
 * rebuilt by defining again. `forget()` is what a new connection calls, and the
 * capability bitmap a `Painter` is constructed with must be this connection's HELLO
 * (`jgx.permits`, and the paragraph in its docblock about not caching one).
 *
 * ## Frequency ordering, because the order decides how early you can draw
 *
 * `plan` sorts the tiles by how many columns use them, most first, ties by first
 * appearance. That is not tidiness: entries land four at a time from entry 0, so a
 * picture whose tiles all sit in 0-3 is drawable after one `TILE_DEF` and one ACK
 * instead of four of each. `Plan.defines` is that number, and on real pictures the
 * common case is dark plus two or three patterns, which is one define.
 *
 * ## A tile cannot be masked, so the frame is
 *
 * `display.alive()` maps holes at fixed *panel* positions. A tile is a column pattern
 * with no position, so there is no such thing as masking one: the same nine pixels are
 * legal in column 3 and clipped in column 11. `columnWords` therefore masks at the
 * window, in panel coordinates, exactly as `viewport.windowAt` does and for the same
 * reason.
 *
 * The consequence is worth knowing before you count tiles: **the mask spends palette
 * entries.** Two columns of identical content either side of the nose notch mask to
 * different words and need two entries, so a symmetric picture can want more tiles than
 * its symmetry suggests, and rows 2-7 (the band alive in every column) is where a
 * design stays cheap.
 *
 * ## Sixteen is a hard ceiling and there is no fallback here
 *
 * `planProblems` refuses a set of panels needing more than sixteen distinct masked
 * columns, and says the number. Merging near-identical tiles to fit would work and is
 * **deliberately not here**: a merge changes pixels the caller chose, and since nothing
 * has ever seen a tile frame on the panel, a lossy reducer would be inventing a look
 * nobody has watched. The honest answer today is the sentence.
 *
 * ## `TILE_FRAME` answers nothing, so nothing may believe a frame landed
 *
 * `jgx.tileFrame`'s docblock settles the wire half: no reply, because a reply per frame
 * doubles the traffic for a value the next frame supersedes. The host-side consequences
 * are the reason this module keeps no frame state at all:
 *
 *  - **There is no believed frame**, so nothing here can answer "what is the panel
 *    showing". Only the palette has a believed state, because only `TILE_DEF` is
 *    acknowledged.
 *  - **No delta encoding, ever.** Sending only the columns that changed is what
 *    `Grid.deltaFrames` does for the live path, and it needs a believed previous frame.
 *    It would also buy nothing: a whole frame is already one write.
 *  - **A dropped frame is silent, and in a sequence the next frame repairs it.** The
 *    last frame of a sequence has no next, so a still picture left on the panel is the
 *    one case a drop is permanent. `still()` is that case: the frame plus
 *    `STILL_RESENDS` copies of it, which is 16 bytes and a pacing interval against a
 *    panel stuck on the previous picture. Two is the number because one resend covers a
 *    single dropped write and nothing can confirm any of them, so more is superstition.
 *  - Pace them. `protocol.PACING_MS` is the floor, and write-without-response has no
 *    flow control.
 */
import { type Bitmap, normalise, width } from './content.js'
import { COLS, ROWS, alive } from './display.js'
import {
  type Ack,
  STATUS,
  SUB,
  TILE_COUNT,
  TILE_DEF_ENTRIES,
  TILE_WORD_MASK,
  permits,
  tileDefine,
  tileFrame,
  tileLevels,
  tileWord,
} from './jgx.js'

/** A dark column, and what an unused palette entry is padded with. */
export const DARK_TILE = 0

/** Copies of a final frame `still()` sends. See the docblock's last section. */
export const STILL_RESENDS = 2

/** Either form of a tile: the packed word, or `ROWS` levels with row 0 first. */
export type Tile = number | readonly number[]

const wordOf = (tile: Tile): number => {
  if (typeof tile !== 'number') return tileWord([...tile])
  if (!Number.isInteger(tile) || tile < 0 || tile > TILE_WORD_MASK) {
    throw new RangeError(`tile word ${tile} is outside 0-${TILE_WORD_MASK}`)
  }
  return tile
}

/** The `first` entry of each `TILE_DEF`, in the order they are sent. */
export const DEFINE_FIRSTS: readonly number[] = Array.from(
  { length: TILE_COUNT / TILE_DEF_ENTRIES },
  (_, i) => i * TILE_DEF_ENTRIES,
)

/**
 * Sixteen tiles, complete because there is no way to build an incomplete one.
 *
 * `of` pads rather than refusing a short list, since a picture needing five tiles is
 * normal and the wire defines four entries whatever they hold. Padding with
 * `DARK_TILE` also means the whole palette can reach `Painter.ready`.
 */
export class Palette {
  readonly words: readonly number[]
  private readonly first: Map<number, number>

  private constructor(words: number[]) {
    this.words = words
    this.first = new Map()
    words.forEach((w, i) => {
      if (!this.first.has(w)) this.first.set(w, i)
    })
  }

  static of(tiles: readonly Tile[]): Palette {
    if (tiles.length > TILE_COUNT) {
      throw new RangeError(`a palette holds ${TILE_COUNT} tiles, got ${tiles.length}`)
    }
    const words = tiles.map(wordOf)
    while (words.length < TILE_COUNT) words.push(DARK_TILE)
    return new Palette(words)
  }

  /** Which entry draws this column word, or -1 when the palette cannot draw it. */
  indexOf(tile: Tile): number {
    return this.first.get(wordOf(tile)) ?? -1
  }

  /** The levels entry `n` draws, row 0 first. */
  levels(entry: number): number[] {
    if (!Number.isInteger(entry) || entry < 0 || entry >= TILE_COUNT) {
      throw new RangeError(`entry ${entry} is not one of 0-${TILE_COUNT - 1}`)
    }
    return tileLevels(this.words[entry])
  }

  equals(other: Palette): boolean {
    return this.words.every((w, i) => w === other.words[i])
  }
}

/**
 * The 24 tile words a panel-sized bitmap wants, masked where the panel has no LED.
 *
 * `normalise` first, so a renderer may be as sloppy as `content.ts` already lets it be.
 * Columns past `COLS` are ignored here and named by `planProblems`, because silently
 * dropping content is the failure this repo keeps recording.
 */
export function columnWords(panel: Bitmap): number[] {
  const px = normalise(panel)
  const out: number[] = []
  for (let c = 0; c < COLS; c++) {
    const levels: number[] = []
    for (let r = 0; r < ROWS; r++) {
      levels.push(alive(r, c) ? (px[r]?.[c] ?? 0) : 0)
    }
    out.push(tileWord(levels))
  }
  return out
}

/** Distinct masked columns across these panels, most used first. */
export function tilesFor(panels: readonly Bitmap[]): number[] {
  const uses = new Map<number, { count: number; at: number }>()
  let seen = 0
  for (const panel of panels) {
    for (const word of columnWords(panel)) {
      const hit = uses.get(word)
      if (hit) hit.count++
      else uses.set(word, { count: 1, at: seen++ })
    }
  }
  return [...uses.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].at - b[1].at)
    .map(([word]) => word)
}

export interface Plan {
  palette: Palette
  /** 24 indices per panel, in the order the panels were given. */
  frames: number[][]
  /** Distinct masked columns these panels need, at most `TILE_COUNT`. */
  distinct: number
  /**
   * `TILE_DEF` frames that must be acknowledged before every tile these frames use is
   * held. One or two for most pictures, because `tilesFor` puts the common tiles first.
   */
  defines: number
}

/**
 * Why these panels cannot be drawn as tile frames, as sentences. Empty means they can.
 *
 * A list rather than a throw, for the same reason `content.check` is one: a screen
 * wants to disable a button and say why, and more than one thing can be wrong.
 */
export function planProblems(panels: readonly Bitmap[]): string[] {
  const out: string[] = []
  if (panels.length === 0) out.push('no panels to draw')
  const wide = panels.filter((p) => width(p) > COLS).length
  if (wide > 0) {
    out.push(
      `${wide} of ${panels.length} panels are wider than the ${COLS} columns a frame ` +
        'carries; window them first, because the extra columns are not drawn',
    )
  }
  const distinct = tilesFor(panels).length
  if (distinct > TILE_COUNT) {
    out.push(
      `these panels need ${distinct} distinct columns and a palette holds ` +
        `${TILE_COUNT}. Grey ramps run out fastest, and the dead-LED mask spends ` +
        'entries of its own: identical content either side of the nose notch masks ' +
        'to two different tiles',
    )
  }
  return out
}

/** A palette and one row of indices per panel. Throws with `planProblems`'s sentences. */
export function plan(panels: readonly Bitmap[]): Plan {
  const problems = planProblems(panels)
  if (problems.length) throw new Error(problems.join('; '))

  const tiles = tilesFor(panels)
  const palette = Palette.of(tiles)
  const frames = panels.map((panel) => columnWords(panel).map((w) => palette.indexOf(w)))
  const highest = frames.reduce((m, row) => Math.max(m, ...row), 0)
  return {
    palette,
    frames,
    distinct: tiles.length,
    defines: Math.ceil((highest + 1) / TILE_DEF_ENTRIES),
  }
}

/** Four consecutive palette entries, and the frame that defines them. */
export interface DefineStep {
  first: number
  entries: readonly number[]
  frame: Uint8Array
}

/**
 * What one unit is believed to hold, and the only route from a palette to the wire.
 *
 * Construct one per connection from that connection's HELLO bitmap. `use` sets the
 * palette to draw from, `next`/`sent`/`confirm` walk the four defines one at a time,
 * and `frame`/`draw` refuse until the entries they need are believed held.
 *
 * **One define may be outstanding at a time.** `MSG.ACK` carries the sub-command but no
 * entry number, so with two in flight a failure could not be attributed to either. That
 * is the same reasoning `jgx.updData` records for the updater: order on the wire is
 * what makes the reply mean something.
 */
export class Painter {
  private readonly caps: number
  private wanted: Palette | null = null
  private readonly held: (number | null)[] = new Array(TILE_COUNT).fill(null)
  private outstanding: DefineStep | null = null

  constructor(capabilities: number) {
    this.caps = capabilities
  }

  /** Did this connection's HELLO license the tile palette at all? */
  get supported(): boolean {
    return permits(this.caps, SUB.TILE_DEF) && permits(this.caps, SUB.TILE_FRAME)
  }

  get palette(): Palette | null {
    return this.wanted
  }

  /**
   * Draw from this palette from now on.
   *
   * An entry whose word the unit is already believed to hold keeps its belief, so
   * swapping a palette that shares tiles with the old one costs only the defines that
   * changed. Anything outstanding is dropped rather than carried across, because an ACK
   * arriving after this call would be an ACK for a palette nobody is drawing from.
   */
  use(palette: Palette): void {
    this.wanted = palette
    this.outstanding = null
    for (let i = 0; i < TILE_COUNT; i++) {
      if (this.held[i] !== palette.words[i]) this.held[i] = null
    }
  }

  /** Is entry `n` believed to hold the wanted palette's word for it? */
  holds(entry: number): boolean {
    if (!Number.isInteger(entry) || entry < 0 || entry >= TILE_COUNT) return false
    return this.wanted !== null && this.held[entry] === this.wanted.words[entry]
  }

  /** Every entry believed held. Drawing needs less: `problems` asks about the used. */
  get ready(): boolean {
    return this.wanted !== null && this.held.every((w, i) => w === this.wanted!.words[i])
  }

  /** The one define to send now, or null when the whole palette is believed held. */
  next(): DefineStep | null {
    return this.pending()[0] ?? null
  }

  /** Every define still needed, in the order to send them. */
  pending(): DefineStep[] {
    if (!this.wanted) return []
    return DEFINE_FIRSTS.filter((first) => !this.groupHeld(first)).map((first) =>
      this.stepFor(first),
    )
  }

  /**
   * Record that a define has gone out and is awaiting its ACK.
   *
   * Re-sending the same step is how a lost ACK is handled, so that is allowed. A
   * *different* step while one is outstanding is not, and neither is a step built
   * against a palette that has since been replaced: the frame bytes are compared, so a
   * stale `DefineStep` cannot be sent by mistake.
   */
  sent(step: DefineStep): void {
    if (!this.wanted) throw new Error('no palette to define: call use() first')
    if (!DEFINE_FIRSTS.includes(step.first)) {
      throw new RangeError(`${step.first} is not the first entry of any TILE_DEF`)
    }
    if (this.outstanding && this.outstanding.first !== step.first) {
      throw new Error(
        `entries ${this.outstanding.first}-${this.outstanding.first + 3} are already ` +
          'awaiting an ACK, and an ACK carries no entry number to tell two apart',
      )
    }
    if (this.groupHeld(step.first)) {
      throw new Error(`entries ${step.first}-${step.first + 3} are already held`)
    }
    const mine = this.stepFor(step.first)
    if (!mine.frame.every((b, i) => b === step.frame[i])) {
      throw new Error(
        `this step defines entries ${step.first}-${step.first + 3} with other words: ` +
          'it was built against a palette this painter is no longer using',
      )
    }
    this.outstanding = mine
  }

  /**
   * Apply an `MSG.ACK`. True when it marked four entries held.
   *
   * A foreign sub-command leaves the state alone and answers false, so a caller may
   * hand every notification to every parser. A failure code clears the outstanding
   * step without marking anything, which puts the palette back to needing that define.
   */
  confirm(ack: Ack): boolean {
    const step = this.outstanding
    if (!step || ack.sub !== SUB.TILE_DEF) return false
    this.outstanding = null
    if (ack.code !== STATUS.OK) return false
    for (const entry of step.entries) this.held[entry] = this.wanted!.words[entry]
    return true
  }

  /** Give up on the outstanding define, e.g. after no ACK arrived. */
  abandon(): void {
    this.outstanding = null
  }

  /**
   * Believe nothing about the unit's palette. What a new connection calls.
   *
   * The palette stays, so `pending()` immediately asks for all four defines again.
   * There is no sub-command that reads a unit's palette back, so this is the only
   * honest thing to do when the belief is in doubt.
   */
  forget(): void {
    this.held.fill(null)
    this.outstanding = null
  }

  /** Why this frame is not safe to send, as sentences. Empty means it is. */
  problems(indices: readonly number[]): string[] {
    const out: string[] = []
    if (!this.supported) {
      out.push(
        'this unit did not advertise TILES in the HELLO for this connection, so a ' +
          'TILE_FRAME falls through its dispatcher in silence',
      )
    }
    if (!this.wanted) out.push('no palette has been defined: call use() first')
    if (indices.length !== COLS) {
      out.push(`a frame is ${COLS} columns, got ${indices.length}`)
    }
    const bad = indices.filter(
      (ix) => !Number.isInteger(ix) || ix < 0 || ix >= TILE_COUNT,
    )
    if (bad.length) out.push(`${bad.join(', ')} are not palette entries`)
    if (this.wanted) {
      const missing = [...new Set(indices)]
        .filter((ix) => Number.isInteger(ix) && ix >= 0 && ix < TILE_COUNT)
        .filter((ix) => !this.holds(ix))
        .sort((a, b) => a - b)
      if (missing.length) {
        out.push(
          `entries ${missing.join(', ')} have not been acknowledged by this unit, so ` +
            'those columns would draw whatever the last palette left there',
        )
      }
    }
    return out
  }

  /** One `TILE_FRAME`. Throws rather than draw from an entry the unit may not hold. */
  frame(indices: readonly number[]): Uint8Array {
    const problems = this.problems(indices)
    if (problems.length) throw new Error(problems.join('; '))
    return tileFrame(indices)
  }

  /** The same, from a panel-sized bitmap, through the palette. */
  draw(panel: Bitmap): Uint8Array {
    if (!this.wanted) throw new Error('no palette has been defined: call use() first')
    const words = columnWords(panel)
    const indices = words.map((w) => this.wanted!.indexOf(w))
    const absent = indices
      .map((ix, c) => (ix < 0 ? c : -1))
      .filter((c) => c >= 0)
    if (absent.length) {
      throw new Error(
        `columns ${absent.join(', ')} need tiles this palette does not hold; ` +
          'plan() the panel and use() the palette it returns',
      )
    }
    return this.frame(indices)
  }

  /**
   * A frame meant to stay on the panel, sent `resends` extra times.
   *
   * `TILE_FRAME` is unacknowledged, so a dropped write is silent and the panel keeps
   * the previous picture for ever. In a sequence the next frame repairs that; a still
   * has no next frame, which is the whole reason this exists. Pace the copies like any
   * other frame.
   */
  still(indices: readonly number[], resends = STILL_RESENDS): Uint8Array[] {
    if (!Number.isInteger(resends) || resends < 0) {
      throw new RangeError(`resends ${resends} is not a count`)
    }
    const one = this.frame(indices)
    return Array.from({ length: resends + 1 }, () => new Uint8Array(one))
  }

  private groupHeld(first: number): boolean {
    for (let i = first; i < first + TILE_DEF_ENTRIES; i++) {
      if (!this.holds(i)) return false
    }
    return true
  }

  private stepFor(first: number): DefineStep {
    const words = this.wanted!.words.slice(first, first + TILE_DEF_ENTRIES)
    return {
      first,
      entries: Array.from({ length: TILE_DEF_ENTRIES }, (_, i) => first + i),
      frame: tileDefine(first, words),
    }
  }
}
