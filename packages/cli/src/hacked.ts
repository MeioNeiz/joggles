#!/usr/bin/env bun
/**
 * HACKED, in a face drawn for this panel and nothing else.
 *
 * The celebration for bringing a bricked unit back. Jacob's three rulings shaped
 * every decision below and they are worth having in front of you, because two of
 * them close doors the rest of this repo leaves open:
 *
 *   "write HACKED on the glasses"      2026-08-19
 *   "i dont want the hacked scrolling"  so it is static, so it fits 24 columns
 *   "def not using any default rendering style, finding a specific style for
 *    that display"                      so `font.ts` is out, all four faces
 *   "the hacked message does not need to persist"   so no flash, and grey is free
 *
 * **Nothing here connects unless asked.** The default is a terminal preview of
 * every treatment, so the thing can be judged with no unit powered up, no lock
 * taken and no wear spent. `--show` is the only path to the wire.
 *
 * ## Why the stock faces are out on their own merits, not just by ruling
 *
 * Measured with the repo's own metrics, `font.fit('HACKED', face)`:
 *
 *     band5   23 columns   fits, 5 rows, one row of air it does not need
 *     slim5   21 columns   fits, 5 rows, condensed
 *     band6   29 columns   does not fit
 *     tall7   29 columns   does not fit, drops "ED"
 *
 * So two of the four could not have shown it at all, and the two that could are
 * five rows tall because **they are built to scroll**. A scrolling face has to
 * stay inside rows 2 to 7 at every column and `band5` spends its sixth row on air
 * for legibility as it crosses the nose bridge (`fonts/band5.ts`). Static content
 * never crosses anything. That row is free, and taking it is a fifth of the cap
 * height back for nothing: this face is 6 rows in the same 3 columns per letter.
 *
 * ## The composition is the panel's own shape
 *
 * Three facts about the hardware, and every layout decision here falls out of
 * them (`display.alive()` is the only source, so none of it is hardcoded):
 *
 *     rows 2-7            an LED in every column. The band anything may use
 *     rows 0, 1, 8        alive at the edges, dead across the middle
 *     cols 0-8, 15-23     nine columns each side where all 9 rows are alive
 *
 * Six letters in 24 columns is four columns each including the gap, and at that
 * size the only free variable left is **where the gaps go**. So the word breaks
 * 3 and 3: `HAC` in columns 0-10, `KED` in columns 13-23, and the two columns
 * left in the middle straddle 11.5, which is the panel's axis of symmetry
 * (`content.centreOffset` and `effects.mirrorFolds` both snap to the same place).
 * One half per lens. The word's own break sits exactly over the nose bridge,
 * where the panel has no LEDs in three of its rows, so the gap the wearer's face
 * puts in the display is the gap the typography wanted anyway.
 *
 * Every treatment that decorates rows 0, 1 or 8 draws only where `alive()` says
 * there is an LED, which means each rule arrives as two segments with a break in
 * the middle. That break is not damage being worked around: it lines up with the
 * word's break, and it is why the whole composition reads as one deliberate
 * thing rather than as text that happened to fit.
 *
 * ## What grey is for here, and what it is not
 *
 * Grey costs nothing now that the message need not persist. It would have been
 * ruinous before: one grey pixel turns a save from DATS type 1 into type 2, and
 * only type 1 survives a power cycle (`content.savedType`). Off the saved route
 * that trap does not exist, so all four levels are available.
 *
 * **Use it for anti-aliasing, not for information.** That is the repo's own
 * finding and it is *verified* on hardware: three eight-column bands at levels
 * 1/2/3 read as three increasing steps, but six-column bands at different levels
 * were not separable side by side (`notes/protocol.md`, "The steps are subtle").
 * The level-to-brightness curve belongs to the panel module and no firmware patch
 * reaches it. So a single dim pixel beside a bright one will probably not read as
 * dim at all - it will read as the stroke being wider. That is exactly the
 * effect wanted at three columns per letter, and it is why `soften()` puts level
 * 1 only on staircase corners. Ten pixels in the whole word: two on the A's apex,
 * four rounding the C, two rounding the D and two on the steps of the K's arms.
 * The H and the E get none, because square is what they are supposed to be.
 *
 * **Nobody has looked at any of it on a panel.** The renders below are the
 * bitmap, and the bitmap is *verified* only as far as `display.alive()` and the
 * two-bits-per-pixel packing go. How level 1 next to level 3 actually reads at
 * arm's length is *unverified*, which is why `flat` is in the list: it is the
 * same letterforms with no grey at all, and it is the fallback if the soft
 * corners come back looking like dirt.
 *
 * ## Delivery
 *
 * The live buffer, and only the live buffer. 24 columns is the panel, the frame
 * goes out on `960b` in one pass, no DATS, no `MODE`, no page erases. It survives
 * the disconnect - `end('keep')` is what `verify.ts column0` relies on and what
 * `spray.ts` is built on - so the laptop can walk away and the glasses keep
 * showing it until someone power-cycles them. The cost sentence printed before
 * any of that happens is `app/src/deliver.ts`'s own, not a new one.
 *
 * **The BLE half is behind a dynamic import**, so importing this module pulls in no
 * adapter at all: `./glasses.js` reaches `@abandonware/noble`, which binds to
 * CoreBluetooth the moment it loads. That is what makes "nothing connects unless
 * asked" a property of the code rather than a promise in a comment, and it is what
 * lets `hacked.test.ts` exercise every treatment with a probe clipped to a unit in
 * the next room.
 *
 * House style is `core/src/motifs.ts`: named pictures drawn by arithmetic from
 * named vertices, so a glyph rescales and follows the geometry constants rather
 * than rotting when they move. The letters here are six of those pictures. The
 * Bresenham below is that file's, re-stated because it keeps its `stroke` private
 * and `motifs.ts` belongs to another track.
 */
import { Grid, content, display, motifs, viewport } from '@joggles/core'
import type { Bitmap, Content } from '@joggles/core'
import { costOf } from '../../app/src/deliver.js'

const { COLS, MAX_LEVEL, ROWS, alive } = display

/** The word, and the whole reason this face exists. Six glyphs, no more. */
export const WORD = 'HACKED'

/** Level a core stroke is drawn at. The brightest the panel has. */
export const CORE = MAX_LEVEL

/** Level a softened corner is drawn at. The dimmest that is not off. */
export const SOFT = 1

/** Columns one letter of this face occupies. Six of them plus gaps is 23 of 24. */
export const GLYPH_COLS = 3

/** Letters that go on each lens. Half the word each, which is what makes it fit. */
export const PER_LENS = WORD.length / 2

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const set = (bitmap: Bitmap, row: number, col: number, level: number): void => {
  if (row < 0 || row >= bitmap.length) return
  if (col < 0 || col >= bitmap[row].length) return
  bitmap[row][col] = level
}

/** A straight line, Bresenham, bottom-left origin. `motifs.ts` draws the same way. */
function stroke(bitmap: Bitmap, from: Cell, to: Cell, level = CORE): void {
  let [r0, c0] = from
  const [r1, c1] = to
  const dr = Math.abs(r1 - r0)
  const dc = Math.abs(c1 - c0)
  const sr = r0 < r1 ? 1 : -1
  const sc = c0 < c1 ? 1 : -1
  let err = dc - dr
  for (;;) {
    set(bitmap, r0, c0, level)
    if (r0 === r1 && c0 === c1) return
    const e2 = 2 * err
    if (e2 > -dr) {
      err -= dr
      c0 += sc
    }
    if (e2 < dc) {
      err += dc
      r0 += sr
    }
  }
}

type Cell = readonly [number, number]

/**
 * A vertex in the letter's own box: `[across, up]`, both 0 to 1, up from the
 * baseline.
 *
 * Fractions rather than pixels for the reason `motifs.wGlyph` takes a width: the
 * treatments below want the same six letters at five rows and at six, and a
 * vertex re-scales where a typed-out array does not.
 */
type Vertex = readonly [number, number]

type Segment = readonly [Vertex, Vertex]

/**
 * How far up the diagonal shoulders of A, C and D leave the vertical.
 *
 * One number for all three so the three letters agree about where a curve starts,
 * which at three columns wide is the only thing making them look like a family.
 */
const SHOULDER = 0.8

/**
 * Where K's two arms spring from the stem.
 *
 * Two vertices rather than one, and both arms are drawn **outwards from the
 * stem**, which is `motifs.wGlyph`'s rule and it is here for the same reason: one
 * continuous path lets Bresenham break its ties in opposite directions and the
 * upper arm comes out a row longer than the lower one. Six rows has no centre row
 * to hang a single joint on, so the waist is the two middle rows.
 */
const WAIST_HI = 0.6
const WAIST_LO = 0.4

/**
 * The six letters, as strokes between named vertices.
 *
 * Read them as instructions rather than as pictures: `H` is two stems and a bar,
 * `C` is a bar, a corner, a stem, a corner and a bar. Every crossbar sits at its
 * own height, which is the part a general-purpose face cannot do - `H`'s bar is
 * above centre because the counter below wants to be the larger one, `A`'s is
 * below centre because the apex has taken the space above it, and `E`'s is short
 * because a full-width middle arm on three columns reads as a solid block.
 */
const GLYPHS: Record<string, readonly Segment[]> = {
  H: [
    [[0, 0], [0, 1]],
    [[1, 0], [1, 1]],
    [[0, 0.55], [1, 0.55]],
  ],
  A: [
    [[0, 0], [0, SHOULDER]],
    [[0, SHOULDER], [0.5, 1]],
    [[0.5, 1], [1, SHOULDER]],
    [[1, SHOULDER], [1, 0]],
    [[0, 0.4], [1, 0.4]],
  ],
  C: [
    [[1, 1], [0.5, 1]],
    [[0.5, 1], [0, SHOULDER]],
    [[0, SHOULDER], [0, 1 - SHOULDER]],
    [[0, 1 - SHOULDER], [0.5, 0]],
    [[0.5, 0], [1, 0]],
  ],
  K: [
    [[0, 0], [0, 1]],
    [[0, WAIST_HI], [1, 1]],
    [[0, WAIST_LO], [1, 0]],
  ],
  E: [
    [[1, 1], [0, 1]],
    [[0, 1], [0, 0]],
    [[0, 0], [1, 0]],
    [[0, 0.55], [0.5, 0.55]],
  ],
  D: [
    [[0, 0], [0, 1]],
    [[0, 1], [0.5, 1]],
    [[0.5, 1], [1, SHOULDER]],
    [[1, SHOULDER], [1, 1 - SHOULDER]],
    [[1, 1 - SHOULDER], [0.5, 0]],
    [[0.5, 0], [0, 0]],
  ],
}

export const LETTERS = Object.keys(GLYPHS).join('')

/** One letter as a `[row][col]` bitmap, bottom row first, cores only. */
export function glyph(ch: string, height: number, cols = GLYPH_COLS): Bitmap {
  const strokes = GLYPHS[ch]
  if (!strokes) throw new Error(`this face has no ${ch}: it draws ${LETTERS} and no more`)
  const out = Array.from({ length: height }, () => new Array(cols).fill(0))
  const at = ([u, v]: Vertex): Cell => [
    Math.round(v * (height - 1)),
    Math.round(u * (cols - 1)),
  ]
  for (const [from, to] of strokes) stroke(out, at(from), at(to), CORE)
  return out
}

/**
 * Dim the inside of every staircase corner, which is the only honest use of grey
 * at this size.
 *
 * A cell qualifies when it is dark, has exactly two lit orthogonal neighbours,
 * those two are perpendicular to each other, and the diagonal cell between them
 * is dark. That is the definition of a corner in a stepped stroke and nothing
 * else: a T junction has three lit neighbours and is left alone, so `H`'s
 * crossbar stays crisp while `A`'s apex and `C`'s four corners soften.
 *
 * Deliberately not a bloom. Dilating everything by one column would make three
 * columns per letter into five and the counters would close up.
 */
export function soften(bitmap: Bitmap, level = SOFT): Bitmap {
  const out = bitmap.map((row) => [...row])
  const lit = (r: number, c: number): boolean =>
    r >= 0 && r < bitmap.length && c >= 0 && c < bitmap[r].length && bitmap[r][c] > 0
  for (let r = 0; r < bitmap.length; r++) {
    for (let c = 0; c < bitmap[r].length; c++) {
      if (bitmap[r][c] > 0) continue
      const up = lit(r + 1, c)
      const down = lit(r - 1, c)
      const left = lit(r, c - 1)
      const right = lit(r, c + 1)
      const vertical = Number(up) + Number(down)
      const horizontal = Number(left) + Number(right)
      if (vertical !== 1 || horizontal !== 1) continue
      const dr = up ? 1 : -1
      const dc = right ? 1 : -1
      if (lit(r + dr, c + dc)) continue
      out[r][c] = level
    }
  }
  return out
}

/**
 * `HAC` hard against the left edge and `KED` hard against the right, which puts
 * the break over the nose bridge.
 *
 * Not `content.centre`, and that is the point. Centring the whole word would put
 * the six letters on one even rhythm and the gap between C and K would land on
 * column 11, one column off the panel's axis. Splitting it and pushing each half
 * outward makes the two lenses mirror images and leaves the middle two columns
 * dark, straddling 11.5.
 */
export function layout(height: number, baseline: number): Bitmap {
  const out = content.blank(COLS)
  const half = PER_LENS * GLYPH_COLS + (PER_LENS - 1)
  const starts = [0, COLS - half]
  for (const [lens, start] of starts.entries()) {
    for (let i = 0; i < PER_LENS; i++) {
      const ch = WORD[lens * PER_LENS + i]
      const art = glyph(ch, height)
      const at = start + i * (GLYPH_COLS + 1)
      for (let r = 0; r < art.length; r++) {
        for (let c = 0; c < art[r].length; c++) {
          if (art[r][c] > 0) set(out, baseline + r, at + c, art[r][c])
        }
      }
    }
  }
  return out
}

/**
 * Light one whole row wherever the panel has an LED there, and nowhere else.
 *
 * Rows 0, 1 and 8 are dead across the middle, so a rule drawn this way arrives as
 * two segments with a break in it. The break is the point: it lands on the nose
 * bridge, in line with the word's own break, and drawing the row solid and letting
 * `viewport` mask it would look identical on the panel while hiding from the
 * preview that the shape was the hardware's idea.
 */
function rule(bitmap: Bitmap, row: number, level: number): void {
  for (let c = 0; c < COLS; c++) if (alive(row, c)) lift(bitmap, row, c, level)
}

/** Brighten `bitmap` at one cell, so decoration never dims a stroke it crosses. */
const lift = (bitmap: Bitmap, row: number, col: number, level: number): void => {
  set(bitmap, row, col, Math.max(bitmap[row]?.[col] ?? 0, level))
}

// ---------------------------------------------------------------------------
// Treatments
// ---------------------------------------------------------------------------

export interface Treatment {
  name: string
  /** What it is, in one line, for the menu. */
  about: string
  /** Why it might be the one, in one line. Reasons differ; that is the choice. */
  why: string
  make: () => Bitmap
}

/** Rows 2 to 7, the band with an LED in every column, straight off `motifs`. */
const BAND_LOW = motifs.BAND_LOW
const BAND_ROWS = motifs.BAND_ROWS

/** The tallest the letters can be and stay inside the band. Six rows. */
const full = (): Bitmap => soften(layout(BAND_ROWS, BAND_LOW))

/** Five rows at the same baseline, leaving row 7 as air under a top rule. */
const short = (): Bitmap => soften(layout(BAND_ROWS - 1, BAND_LOW))

export const TREATMENTS: readonly Treatment[] = [
  {
    name: 'notch',
    about: '6 rows, soft corners, and nothing else on the panel',
    why: 'the letters as large as 24 columns allow, and the only gap is the bridge',
    make: full,
  },
  {
    name: 'outline',
    about: 'the same, with the panel tracing its own silhouette at level 1',
    why: 'the notch gets drawn rather than left out, so the gap reads as shape',
    make: () => {
      const out = full()
      // `display.edgePixels()` is the panel's true perimeter, holes included, and it
      // is what `bun cli edge` traces on hardware. Nothing here decides what the
      // silhouette is.
      for (const [r, c] of display.edgePixels()) lift(out, r, c, SOFT)
      return out
    },
  },
  {
    name: 'terminal',
    about: '5 rows, with a dim rule above and below, each broken in the middle',
    why: 'a row of letter height traded for a frame the hardware puts the break in',
    make: () => {
      const out = short()
      rule(out, ROWS - 1, SOFT)
      rule(out, 0, SOFT)
      return out
    },
  },
  {
    name: 'flat',
    about: 'the notch letters with no grey at all, every lit pixel at level 3',
    why: 'the control. Nobody has seen level 1 next to level 3 on this panel yet',
    make: () => layout(BAND_ROWS, BAND_LOW),
  },
]

export const treatmentByName = (name: string): Treatment | null =>
  TREATMENTS.find((t) => t.name === name) ?? null

/** A treatment as `Content` on the free route, which is the only route offered. */
export function piece(t: Treatment): Content {
  return content.drawing(t.make(), 'live')
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * The panel as it will actually light, dead LEDs included.
 *
 * `viewport.windowAt` rather than the raw bitmap, so the mask is applied in panel
 * coordinates by the one module that gets that right, and a space is printed
 * where there is no LED at all. `Grid.render` prints a dot there instead, which
 * for a design whose whole argument is about the holes would hide the argument.
 */
export function render(bitmap: Bitmap): string {
  const shade = ['.', '-', '+', '#']
  const win = viewport.windowAt(bitmap)
  const lines: string[] = []
  for (let r = ROWS - 1; r >= 0; r--) {
    lines.push(
      Array.from({ length: COLS }, (_, c) =>
        alive(r, c) ? (shade[win[r][c]] ?? '#') : ' ',
      ).join(''),
    )
  }
  return lines.join('\n')
}

/** Lit cells per level, so a render can be checked against what it claims. */
export function levels(bitmap: Bitmap): number[] {
  const out = [0, 0, 0, 0]
  for (const row of bitmap) for (const v of row) out[v] = (out[v] ?? 0) + 1
  return out
}

function describe(t: Treatment): void {
  const bitmap = t.make()
  const count = levels(bitmap)
  const lost = motifs.hidden(bitmap)
  const problems = content.check(content.drawing(bitmap, 'live'))

  console.log(`\n${t.name}  ${t.about}`)
  console.log(`${' '.repeat(t.name.length)}  ${t.why}\n`)
  console.log(render(bitmap))
  console.log(
    `\nlit        ${count[3]} at level 3, ${count[2]} at level 2, ${count[1]} at level 1`,
  )
  console.log(`dead LEDs  ${lost} lit cells land on a hole`)
  if (problems.length) console.log(`refused    ${problems.join('; ')}`)
}

/**
 * What sending one costs, in `app/src/deliver.ts`'s own words.
 *
 * Its sentence rather than a new one, because the app already says this to a
 * person about this exact route and two wordings for one cost is how a UI and a
 * CLI end up disagreeing about what the glasses just did.
 */
function delivery(t: Treatment): void {
  const cost = costOf(piece(t), 'live')
  console.log(
    `\ndelivery   live buffer, ${cost.columns} columns, ${cost.erases} page erases, ` +
      `persists: ${cost.persists}`,
  )
  console.log(`           ${cost.words}`)
}

function usage(): void {
  console.log(
    'bun run hacked [treatment] [--show] [--reveal] [--pair <name>] [--lock-is-mine]\n',
  )
  const width = Math.max(...TREATMENTS.map((t) => t.name.length))
  for (const t of TREATMENTS) console.log(`  ${t.name.padEnd(width)}  ${t.about}`)
  console.log(`
  --show          put it on the glasses. Without this, nothing connects
  --reveal        with --show, bring the letters in one at a time, then hold
  --pair <name>   which pair, by advert name or any prefix of one. Without it the
                  first pair to answer the scan gets it, which with two powered up
                  is a coin toss
  --lock-is-mine  proceed even though ${LOCK} exists, because you are its holder

Free either way: 24 columns straight to the live buffer, no DATS, no MODE and no
page erases. It stays lit after the laptop disconnects and clears at power off.`)
}

// ---------------------------------------------------------------------------
// The wire, which nothing above this line touches
// ---------------------------------------------------------------------------

export const names = (): string => TREATMENTS.map((t) => t.name).join(', ')

/**
 * The advisory lock for the one physical pair, per `.claude/locks/README`.
 *
 * *Added 2026-08-20.* It was referenced by `usage()` and by `takeLock`'s default and
 * **never defined**, so every path that reached either threw `LOCK is not defined`:
 * `--help` and, more to the point, `--show`. The script had never been run against a
 * unit, and `hacked.test.ts` passes an explicit path on purpose so that it can exercise
 * the lock without touching the real one, which is exactly why 32 green tests said
 * nothing about it.
 */
export const LOCK = '.claude/locks/glasses'

/**
 * Refuse to connect while another agent has the pair, and take the lock if not.
 *
 * Advisory, and the protocol is `.claude/locks/README`: the file existing is the
 * claim, and the holder deletes it. A held lock is a refusal rather than a wait,
 * because the thing being protected is one physical pair, and queueing behind the
 * lock would only mean two sessions driving it at once a moment later.
 *
 * **A lock we did not take is never deleted.** `--lock-is-mine` is a person saying
 * the file is theirs, which is a reason to proceed and not a reason to tidy up
 * after them: the holder is relying on it still being there when they look. So the
 * release this returns is a no-op in that case, and the only file this ever removes
 * is one it wrote itself.
 *
 * `path` is a parameter so `hacked.test.ts` can exercise both branches without
 * writing to the real lock, which belongs to whoever is holding the pair.
 */
export async function takeLock(
  mine: boolean,
  path = LOCK,
  say: (line: string) => void = console.log,
): Promise<() => Promise<void>> {
  const file = Bun.file(path)
  if (await file.exists()) {
    const held = (await file.text()).trim()
    if (!mine) {
      throw new Error(
        `the glasses are locked by someone else. ${path} says:\n\n${held}\n\n` +
          'If that is you, re-run with --lock-is-mine. Otherwise leave it alone.',
      )
    }
    say(`${path} held, proceeding on --lock-is-mine. It says: ${held}`)
    return async () => {}
  }
  await Bun.write(path, 'track-50, bun run hacked. Delete this if it outlives the run.\n')
  return async () => {
    await Bun.file(path).delete()
  }
}

async function put(
  t: Treatment,
  reveal: boolean,
  mine: boolean,
  pair?: string,
): Promise<void> {
  const release = await takeLock(mine)
  try {
    // Imported here and nowhere else: noble binds to the adapter at load time.
    const { open, sleep } = await import('./glasses.js')
    // `open()` resolves the FIRST advert matching a prefix, so with more than one pair
    // powered up it is a coin toss which one lights up. An advert name IS a prefix of
    // itself, so naming one pins it.
    const glasses = await open(pair ? { prefixes: [pair] } : {})
    console.log(`connected to ${glasses.name}`)
    await glasses.begin()
    const bitmap = t.make()
    if (reveal) {
      // One letter at a time, then hold. Not an animation the device runs: it is
      // 24 columns arriving in six batches and then stopping, which is why it is
      // safe to do over a link that has no flow control.
      for (let n = 1; n <= WORD.length; n++) {
        await glasses.show(upTo(bitmap, n), n === 1)
        await sleep(220)
      }
    }
    await glasses.show(content.toGrid(bitmap), true)
    // `keep` rather than `restore`: leaving DIY makes the firmware put the vendor's
    // own saved image back, which would wipe this the moment the laptop walked away.
    await glasses.end('keep')
    console.log('sent, and disconnected with the panel still lit. Power cycle clears it')
  } finally {
    await release()
  }
}

/** The first `n` letters of the composition, for the reveal. */
export function upTo(bitmap: Bitmap, n: number): Grid {
  const half = PER_LENS * GLYPH_COLS + (PER_LENS - 1)
  const pitch = GLYPH_COLS + 1
  const out = new Grid()
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!bitmap[r][c]) continue
      const lens = c < COLS / 2 ? 0 : 1
      const within = lens === 0 ? c : c - (COLS - half)
      // Clamped rather than trusted: a softened corner and a rule both sit outside
      // any glyph box, and this only decides which batch a pixel joins.
      const slot = Math.max(0, Math.min(PER_LENS - 1, Math.floor(within / pitch)))
      const index = lens * PER_LENS + slot
      if (index < n) out.set(r, c, bitmap[r][c])
    }
  }
  return out
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const show = argv.includes('--show')
  const reveal = argv.includes('--reveal')
  const mine = argv.includes('--lock-is-mine')
  const pairAt = argv.indexOf('--pair')
  const pair = pairAt >= 0 ? argv[pairAt + 1] : undefined
  const named = argv.find((a, i) => !a.startsWith('--') && i !== pairAt + 1)

  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      usage()
      process.exit(0)
    }
    if (named && !treatmentByName(named)) {
      throw new Error(`no treatment called ${named}. One of: ${names()}`)
    }
    if (show && !named) throw new Error(`--show needs a treatment: ${names()}`)
    if (reveal && !show) throw new Error('--reveal only means anything with --show')
    if (pairAt >= 0 && !pair) throw new Error('--pair needs an advert name, e.g. GLASSES-12C3EF')

    const chosen = named ? [treatmentByName(named) as Treatment] : [...TREATMENTS]
    console.log(
      `HACKED in ${GLYPH_COLS} columns a letter: ${PER_LENS} letters a lens, ` +
        `the break on the bridge.\nDead LEDs are printed as blanks, so this is the ` +
        'panel and not the bitmap.',
    )
    for (const t of chosen) describe(t)
    delivery(chosen[0])
    if (!show) {
      console.log(
        '\nNothing was sent and nothing connected. Add --show to put one on the ' +
          `panel:\n  bun run hacked ${TREATMENTS[0].name} --show`,
      )
      process.exit(0)
    }
    await put(chosen[0], reveal, mine, pair)
    process.exit(0)
  } catch (err) {
    console.error('error:', (err as Error).message)
    process.exit(1)
  }
}
