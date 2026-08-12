#!/usr/bin/env bun
/**
 * Harvest open-licence pixel art into the phone's animation library.
 *
 *   bun run animpack fetch           verify each pack's licence on its own page, then
 *                                    download into research/animpack-sources/ (gitignored)
 *   bun run animpack convert         slice, quantise, filter; report what survived and
 *                                    why the rest did not
 *   bun run animpack emit [path]     write packages/app/src/animpack-data.ts
 *   bun run animpack check [path]    fail if that file has drifted from what convert
 *                                    produces over the fetched sources
 *   bun run animpack list            the checked-in catalogue, with scores
 *   bun run animpack show <id>       one animation as ASCII frames, from the checked-in
 *                                    file; `--fresh <packId>` converts from sources and
 *                                    shows every cut of one pack, rejects included
 *
 * The same shape as `bankdump.ts` for the same reason: the phone cannot read the
 * sources, so a tool lifts them into generated checked-in data, and `check` makes a
 * hand-edit of that data a visible failure. The difference is the source: bankdump reads
 * the firmware image we already have, this reads the open web, which is why `fetch`
 * exists and why licence verification is part of the tool rather than a note somewhere.
 *
 * WHY A MANIFEST AND NOT A CRAWLER. Every pack here was found by hand, its licence read
 * on its own page, and its sheet layout worked out by eye - sprite sheets carry no
 * machine-readable frame map, and most game art is unreadable at 24x9 anyway. A crawler
 * would scale the part that was never the bottleneck. The manifest records the judgement
 * calls (which row of a sheet is the side view, what a file's frames are called) and
 * `fetch` re-proves the licence on every run: if a page stops saying CC0, the fetch
 * fails loudly rather than trusting what it saw last time.
 *
 * BUNDLE CC0 ONLY. `Pack.licence` is typed as the literal 'CC0' so an attribution-
 * required pack cannot be added without widening the type, and that widening is the
 * review moment. Two packs were dropped for exactly this during the first harvest:
 * Micro Character Bases (OGA-BY 3.0) and Explosion Effects (CC-BY/CC0 dual, honest but
 * ambiguous). The per-pack record a person can check is research/animpack-licences.md.
 *
 * THE FILTER IS THE POINT. At 24x9 with four grey levels and the dead-LED notch, most
 * art quantises to a grey rectangle, and a library of grey rectangles is worse than a
 * small library that reads. `judge()` rejects on four grounds (nearly nothing lit,
 * nearly everything lit, no frames left after `anim.normalise`, too little frame-to-
 * frame change) and scores the survivors so the app can sort by how well a thing
 * actually reads on the panel. `convert` prints every rejection with its reason: the
 * honest yield is the report, not the manifest length.
 *
 * SOURCES ALREADY SMALL, BY POLICY. A 256px illustration box-averaged onto 9 rows is
 * mush no threshold can rescue, so frames larger than `MAX_SOURCE_PX` are refused by
 * name before quantising rather than left to embarrass the scorer. That single rule
 * excluded more fetched material than every other filter combined (the 2D Spell Effects
 * pack is 98x203 to 184x85 per frame; para's particle fx are 1024px sheets).
 *
 * Timing passes through RAW. Sheets and frame-files carry no timing, so their cuts get
 * `Cut.ms` (defaulting to the built-ins' 120 ms); a GIF's own delays are kept as they
 * arrive, zeros included. `anim.normalise()` owns the zero-delay convention and the
 * merging of repeated frames, and the app applies it at load: baking it in here would
 * put that rule in two places (and the scorer does call it, because "did the animation
 * survive quantising" is a question about the normalised result).
 *
 * Nothing here can reach a device: it is fetch(), file reads, and arithmetic.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  type Animation,
  type RgbaFrame,
  changedColumns,
  normalise,
} from '../../packages/core/src/anim.js'
import {
  type QuantiseOptions,
  packBitmap,
  toAnimation,
  unpackBitmap,
} from '../../packages/core/src/quantise.js'
import type { Bitmap } from '../../packages/core/src/content.js'
import { COLS, ROWS, alive } from '../../packages/core/src/display.js'
import { detail } from './bankdump.js'
import { decodePng } from './png.js'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..')

/** Gitignored. Only the generated data file and the licence manifest are checked in. */
export const SOURCES = resolve(ROOT, 'research/animpack-sources')

const DEFAULT_OUT = resolve(ROOT, 'packages/app/src/animpack-data.ts')

/** ms per frame when the source format carries no timing: the built-ins' own rate. */
export const DEFAULT_MS = 120

/**
 * Largest source frame edge worth quantising, in pixels. 64 keeps the cuzco explosion
 * and the beating heart, both bold single shapes that survive a 7x downscale precisely
 * because they are one blob; anything detailed at that size is mush on 9 rows.
 */
export const MAX_SOURCE_PX = 64

export interface FileSpec {
  url: string
  /** Filename under the pack's directory. A .zip is unzipped beside itself. */
  to: string
}

export interface SheetCut {
  file: string
  /** Tile size in source pixels. */
  w: number
  h: number
  /** Frames in play order, as [tileCol, tileRow] into the sheet's tile grid. */
  at: Array<[number, number]>
}

export interface Cut {
  /** The animation's own name, as the source names it. This is what search finds. */
  name: string
  tags: string[]
  /** Exactly one of these three says where the frames come from. */
  sheet?: SheetCut
  files?: string[]
  gif?: string
  /** ms per frame for sheet and files cuts, which carry no timing of their own. */
  ms?: number
  /**
   * 'auto' (the default) keys out a uniform opaque backdrop, detected from the frame
   * borders; sprite sheets with coloured per-critter backgrounds need this or every
   * pixel is lit and the whole cut is a grey rectangle. It does nothing when the
   * source already has real transparency. 'none' for content where the backdrop is
   * the picture, like water.
   */
  key?: 'auto' | 'none'
  /** Draw the sprite once per lens instead of centred on the nose notch: `perLens`. */
  lens?: boolean
  /**
   * 'invert' flips the luminance of OPAQUE pixels only, for sprites drawn as dark ink
   * on a bright backdrop (the critter bat is black on blue). `QuantiseOptions.invert`
   * cannot do this: it inverts after compositing, so the keyed-out background lights
   * up and the panel floods. Ink stays ink here; the background stays gone.
   */
  ink?: 'invert'
  /** Quantise overrides. Default is 4 levels, no dither: see `QUANTISE_DEFAULTS`. */
  opts?: QuantiseOptions
}

export interface Pack {
  /** Prefixes every animation id from this pack, so ids stay stable and unique. */
  id: string
  name: string
  author: string
  /** The pack's own page: where the licence was read, and `PackRow.source`. */
  page: string
  /** The literal type is the fence: adding a CC-BY pack means widening it, visibly. */
  licence: 'CC0'
  /** When `fetch` last saw the licence on that page. */
  verified: string
  files: FileSpec[]
  tags: string[]
  cuts: Cut[]
}

/**
 * The licence proof `fetch` requires on every OpenGameArt page before downloading: the
 * License(s) field naming CC0, not a comment or a collection title mentioning it.
 * Matching the field markup means a page whose licence CHANGES fails the next fetch.
 */
const OGA_CC0 = /field-name-field-art-licenses[\s\S]{0,600}?>\s*CC0\s*</

const OGA = 'https://opengameart.org'
const FILES = `${OGA}/sites/default/files`

/**
 * Pixel art wants its pixels kept, not blended: at these sizes the box average already
 * softens edges, and a dither on top turns a clean sprite into speckle. Cuts whose
 * source is a soft-shaded render (the explosion, the heart) opt back into the ordered
 * dither individually. 4 levels always: the pack ships greys and the app flattens for
 * a type 1 save itself (`anim.filmstrip`), so flattening here would throw away depth
 * the live route can show.
 */
const QUANTISE_DEFAULTS: QuantiseOptions = { levels: 4, dither: 'none' }

/**
 * The manifest. Layout knowledge per pack, read off the sheets by eye with
 * `show --fresh <packId>`; the comments record what was seen so a re-tune does not
 * start from zero.
 */
export const PACKS: Pack[] = [
  {
    // 224x32, 8x8 tiles, opaque colour-block backgrounds (auto-keyed). Eight critters
    // as column groups of 4 or 2 frames; the four tile rows are walk directions
    // (down, up, right, left as drawn). Row 2, the right-facing walk, reads best
    // sideways-on, which is how things move on a panel this wide.
    id: 'critters',
    name: '8x8 Critter Pack',
    author: 'patvanmackelberg',
    page: `${OGA}/content/8x8-critter-pack`,
    licence: 'CC0',
    verified: '2026-08-12',
    files: [{ url: `${FILES}/8x8critters.png`, to: '8x8critters.png' }],
    tags: ['critter', 'walk', 'topdown'],
    cuts: (
      [
        ['Slime', 0, 4],
        ['Goblin', 4, 4],
        ['Skeleton', 8, 4],
        ['Rat', 12, 2],
        // The bat is black ink on the blue block, the one critter drawn darker than
        // its backdrop; without the ink flip it quantises to nothing.
        ['Bat', 14, 2, 'invert'],
        ['Spider', 16, 4],
        ['Bunny', 20, 4],
        ['Chicken', 24, 4],
      ] as Array<[string, number, number, 'invert'?]>
    ).map(([name, col, n, ink]) => ({
      name: `${name} walk`,
      tags: [name.toLowerCase(), 'monster'],
      lens: true,
      ink,
      sheet: {
        file: '8x8critters.png',
        w: 8,
        h: 8,
        at: Array.from({ length: n }, (_, i) => [col + i, 2] as [number, number]),
      },
    })),
  },
  {
    // 224x64, 8x8 tiles, one flat red backdrop (auto-keyed). Tile rows 0-3 are seven
    // villagers, four columns each in the classic stand/step/stand/step order, one
    // direction per row with row 0 the face-on view (row 2 is the back of the head).
    // Rows 4-7 are the blood, bones and the attack oddments, packed sparsely wherever
    // they fit; extracting those is archaeology for content that reads as scattered
    // dots at 9 rows, so the villagers are the whole harvest here.
    id: 'charpack',
    name: '8x8 Character Pack',
    author: 'patvanmackelberg',
    page: `${OGA}/content/8x8-character-pack`,
    licence: 'CC0',
    verified: '2026-08-12',
    files: [{ url: `${FILES}/8X8%20CharPack.png`, to: 'charpack.png' }],
    tags: ['character', 'walk', 'villager', 'topdown'],
    cuts: Array.from({ length: 7 }, (_, i) => ({
      name: `Villager ${i + 1} walk`,
      tags: ['person'],
      lens: true,
      sheet: {
        file: 'charpack.png',
        w: 8,
        h: 8,
        at: Array.from({ length: 4 }, (_, f) => [i * 4 + f, 0] as [number, number]),
      },
    })),
  },
  {
    // slime-Sheet.png is 128x128, 4x4 tiles of 32x32, real transparency. The page
    // names the animations: idle, move, attack, hurt, one per row in that order.
    id: 'slime',
    name: 'Pixel Art Animated Slime',
    author: 'rvros',
    page: `${OGA}/content/pixel-art-animated-slime`,
    licence: 'CC0',
    verified: '2026-08-12',
    files: [{ url: `${FILES}/Slime_0.zip`, to: 'slime.zip' }],
    tags: ['slime', 'monster', 'platformer'],
    // Drawn in dark teal, so it needs the same lift a saturated palette always needs
    // here: without the gain every pixel lands at level 1 and the blob reads as dust.
    cuts: (['idle', 'move', 'attack', 'hurt'] as const).map((phase, row) => ({
      name: `Slime ${phase}`,
      tags: [phase],
      opts: { gain: 1.9 },
      sheet: {
        file: 'slime-Sheet.png',
        w: 32,
        h: 32,
        at: Array.from({ length: 4 }, (_, f) => [f, row] as [number, number]),
      },
    })),
  },
  {
    // Eight 45x48 frames, one file per frame, already transparent. One full rotation.
    id: 'coin',
    name: 'Rotating Coin',
    author: 'puddin',
    page: `${OGA}/content/rotating-coin`,
    licence: 'CC0',
    verified: '2026-08-12',
    files: [{ url: `${FILES}/Coins_0.zip`, to: 'coins.zip' }],
    tags: ['coin', 'gold', 'spin', 'money'],
    cuts: [
      {
        name: 'Rotating Coin',
        tags: [],
        files: Array.from({ length: 8 }, (_, i) => `coin_0${i + 1}.png`),
        ms: 100,
        lens: true,
      },
    ],
  },
  {
    // exp2.png is 256x256, 4x4 tiles of 64x64, transparent, row-major: grows then
    // fades. At the size limit, and survives because it is one bright blob. The soft
    // gradients want the ordered dither the pixel-art default turns off.
    id: 'explosion',
    name: 'Explosion',
    author: 'Cuzco',
    page: `${OGA}/content/explosion`,
    licence: 'CC0',
    verified: '2026-08-12',
    files: [{ url: `${FILES}/exp2.png`, to: 'exp2.png' }],
    tags: ['explosion', 'boom', 'fire', 'effect'],
    cuts: [
      {
        name: 'Explosion',
        tags: [],
        sheet: {
          file: 'exp2.png',
          w: 64,
          h: 64,
          at: Array.from({ length: 16 }, (_, i) => [i % 4, i >> 2] as [number, number]),
        },
        ms: 60,
        opts: { dither: 'ordered', gain: 1.4 },
      },
    ],
  },
  {
    // 256x64, 8x2 tiles of 32x32, opaque by nature: the water IS the backdrop, so
    // key 'none'. Expected to sit near the everything-lit line; the filter decides.
    id: 'ocean',
    name: 'Animated Ocean Water Tile',
    author: 'PokoMoko',
    page: `${OGA}/content/animated-ocean-water-tile`,
    licence: 'CC0',
    verified: '2026-08-12',
    files: [{ url: `${FILES}/Ocean_SpriteSheet.png`, to: 'ocean.png' }],
    tags: ['water', 'ocean', 'sea', 'waves', 'tile'],
    cuts: [
      {
        name: 'Ocean Water',
        tags: [],
        sheet: {
          file: 'ocean.png',
          w: 32,
          h: 32,
          at: Array.from({ length: 16 }, (_, i) => [i % 8, i >> 3] as [number, number]),
        },
        ms: 150,
        key: 'none',
        opts: { dither: 'ordered', fit: 'cover' },
      },
    ],
  },
  {
    // 64x16: four 16x16 frames in a strip, transparent.
    id: 'campfire16',
    name: '16x16 Animated Campfire',
    author: 'Krial',
    page: `${OGA}/content/16x16-animated-campfire`,
    licence: 'CC0',
    verified: '2026-08-12',
    files: [{ url: `${FILES}/campfire_16x16.png`, to: 'campfire16.png' }],
    tags: ['campfire', 'fire', 'flame'],
    cuts: [
      {
        name: 'Campfire',
        tags: [],
        sheet: {
          file: 'campfire16.png',
          w: 16,
          h: 16,
          at: [[0, 0], [1, 0], [2, 0], [3, 0]],
        },
        ms: 150,
        lens: true,
        // The flicker is drawn in hue, not silhouette: without a dither the four
        // frames quantise identical, and the ordered pattern is what carries the
        // luminance wobble onto the panel.
        opts: { dither: 'ordered', gain: 1.3 },
      },
    ],
  },
  {
    // 128x32: four 32x32 frames in a strip.
    id: 'campfire32',
    name: 'Campfire Pixel Art',
    author: 'ArlanTR',
    page: `${OGA}/content/campfire-pixel-art-animated`,
    licence: 'CC0',
    verified: '2026-08-12',
    files: [{ url: `${FILES}/campfire-sprite-sheet.png`, to: 'campfire32.png' }],
    tags: ['campfire', 'fire', 'flame'],
    cuts: [
      {
        name: 'Campfire',
        tags: [],
        sheet: {
          file: 'campfire32.png',
          w: 32,
          h: 32,
          at: [[0, 0], [1, 0], [2, 0], [3, 0]],
        },
        ms: 150,
        lens: true,
      },
    ],
  },
  {
    // hearty_strip6.png is 384x64: six 64x64 frames. One bold shape, so it survives
    // the size limit the way the explosion does, and shades the same way.
    id: 'heart',
    name: 'Beating Heart',
    author: 'Darsycho',
    page: `${OGA}/content/beating-heart-0`,
    licence: 'CC0',
    verified: '2026-08-12',
    files: [{ url: `${FILES}/hearty_strip6.png`, to: 'heart.png' }],
    tags: ['heart', 'love', 'beat', 'pulse'],
    cuts: [
      {
        name: 'Beating Heart',
        tags: [],
        sheet: {
          file: 'heart.png',
          w: 64,
          h: 64,
          at: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]],
        },
        ms: 100,
        opts: { dither: 'ordered', gain: 2.5 },
      },
    ],
  },
  {
    // Eight 32x32 frames, one file per frame. The odd names are the site's own
    // dedup suffixes on upload, kept verbatim so fetch stays byte-for-byte honest.
    id: 'cradfire',
    name: 'Campfire Animation',
    author: 'crad',
    page: `${OGA}/content/campfire-animation`,
    licence: 'CC0',
    verified: '2026-08-12',
    files: [
      'fire1_1.png',
      'fire2_1.png',
      'fire3_0.png',
      'fire4.png',
      'fire5_0.png',
      'fire6.png',
      'fire7.png',
      'fire8.png',
    ].map((f) => ({ url: `${FILES}/${f}`, to: f })),
    tags: ['campfire', 'fire', 'flame'],
    cuts: [
      {
        name: 'Campfire',
        tags: [],
        files: [
          'fire1_1.png',
          'fire2_1.png',
          'fire3_0.png',
          'fire4.png',
          'fire5_0.png',
          'fire6.png',
          'fire7.png',
          'fire8.png',
        ],
        ms: 120,
        lens: true,
      },
    ],
  },
  {
    // A real GIF, so the delays are the artist's own rather than `Cut.ms`.
    id: 'loading',
    name: 'Pixel Art Loading Icon 2',
    author: 'qubodup',
    page: `${OGA}/content/pixel-art-loading-icon-2`,
    licence: 'CC0',
    verified: '2026-08-12',
    files: [{ url: `${FILES}/qubodup-loading2.gif`, to: 'loading.gif' }],
    tags: ['loading', 'spinner', 'icon', 'wait'],
    cuts: [{ name: 'Loading Icon', tags: [], gif: 'loading.gif' }],
  },
]

/** What one emitted row holds. Structurally `PackRow` in `app/src/animations.ts`. */
export interface Row {
  id: string
  name: string
  tags: string[]
  pack: string
  licence: string
  author: string
  source: string
  frameMs: number[]
  frames: string[]
  score: number
}

export interface Skip {
  pack: string
  cut: string
  reason: string
}

export interface Converted {
  rows: Row[]
  skips: Skip[]
}

/** 'Slime walk' -> 'slime-walk'. Ids are `<packId>-<slug>`, stable across reorders. */
export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/**
 * Key out a uniform opaque backdrop, in place of the transparency pixel art usually
 * has and sprite sheets with coloured critter blocks do not.
 *
 * The backdrop is read off the frame BORDERS, pooled across all frames: a sprite may
 * touch an edge in one frame, but across a walk cycle the backdrop dominates the
 * border or it is not a backdrop. Applied only when the source has effectively no
 * transparency of its own (under 3%), and only when one colour holds a majority of
 * the border; otherwise the frames pass through untouched, which is the right answer
 * for photographs of nothing in particular and for content like water.
 */
export function keyBackground(frames: RgbaFrame[]): RgbaFrame[] {
  let clear = 0
  let total = 0
  for (const f of frames) {
    total += f.width * f.height
    for (let i = 3; i < f.data.length; i += 4) if (f.data[i] === 0) clear++
  }
  if (total === 0 || clear / total > 0.03) return frames

  const border = new Map<number, number>()
  let samples = 0
  for (const f of frames) {
    const px = (x: number, y: number) => {
      const o = (y * f.width + x) * 4
      const key = (f.data[o] << 16) | (f.data[o + 1] << 8) | f.data[o + 2]
      border.set(key, (border.get(key) ?? 0) + 1)
      samples++
    }
    for (let x = 0; x < f.width; x++) {
      px(x, 0)
      px(x, f.height - 1)
    }
    for (let y = 1; y < f.height - 1; y++) {
      px(0, y)
      px(f.width - 1, y)
    }
  }
  const top = [...border.entries()].sort((a, b) => b[1] - a[1])[0]
  if (!top || top[1] < samples * 0.5) return frames

  return frames.map((f) => {
    const data = new Uint8Array(f.data)
    for (let o = 0; o < data.length; o += 4) {
      const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]
      if (key === top[0]) data[o + 3] = 0
    }
    return { ...f, data }
  })
}

/** Luminance-invert the opaque pixels, leaving transparency alone. See `Cut.ink`. */
export function invertInk(frames: RgbaFrame[]): RgbaFrame[] {
  return frames.map((f) => {
    const data = new Uint8Array(f.data)
    for (let o = 0; o < data.length; o += 4) {
      if (data[o + 3] === 0) continue
      data[o] = 255 - data[o]
      data[o + 1] = 255 - data[o + 1]
      data[o + 2] = 255 - data[o + 2]
    }
    return { ...f, data }
  })
}

/**
 * Crop every frame to the union bounding box of what is visible in ANY frame.
 *
 * Sprites sit inside generous margins (the 64x64 heart is a ~40px drawing; the coin
 * files are 45x48 around a ~30px disc), and `contain` fits the whole frame, so without
 * this the drawing lands 6 pixels tall in the middle of the panel. The box is the
 * UNION across frames, never per frame: a per-frame crop would re-centre each frame
 * and turn a walk cycle into a twitch. Alpha decides visibility because keying has
 * already run by the time this is called.
 */
export function cropFrames(frames: RgbaFrame[]): RgbaFrame[] {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  for (const f of frames) {
    for (let y = 0; y < f.height; y++) {
      for (let x = 0; x < f.width; x++) {
        if (f.data[(y * f.width + x) * 4 + 3] === 0) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return frames
  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  if (frames.every((f) => w === f.width && h === f.height)) return frames
  return frames.map((f) => {
    const data = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      const src = ((y0 + y) * f.width + x0) * 4
      data.set(f.data.subarray(src, src + w * 4), y * w * 4)
    }
    return { width: w, height: h, data, delayMs: f.delayMs }
  })
}

/**
 * One copy of the sprite per lens, the way the firmware's own images put a picture in
 * front of each eye and `motifs.ts` draws its W per lens.
 *
 * A small sprite `contain`-centred lands exactly on the nose notch (columns 9-14),
 * which eats its feet: `alive()` is false across the bottom-middle. The two fully
 * alive 9x9 blocks are columns 0-8 and 15-23, one per lens, so a near-square sprite
 * drawn once per lens keeps every pixel it has. Done on the source frames, before
 * quantising, by compositing two copies at the ends of a canvas whose aspect ratio is
 * the panel's: `contain` then maps them onto the lenses with no placement knob needed
 * in core. Frames too wide for two copies pass through unchanged.
 */
export function perLens(frames: RgbaFrame[]): RgbaFrame[] {
  return frames.map((f) => {
    const width = Math.round((f.height * COLS) / ROWS)
    if (width < f.width * 2) return f
    const data = new Uint8Array(width * f.height * 4)
    for (let y = 0; y < f.height; y++) {
      const row = f.data.subarray(y * f.width * 4, (y + 1) * f.width * 4)
      data.set(row, y * width * 4)
      data.set(row, (y * width + (width - f.width)) * 4)
    }
    return { width, height: f.height, data, delayMs: f.delayMs }
  })
}

/** Tiles of a sheet as frames. Throws on a tile outside the sheet: a recipe typo. */
export function sliceSheet(
  png: { width: number; height: number; data: Uint8Array },
  cut: SheetCut,
  ms: number,
): RgbaFrame[] {
  return cut.at.map(([tc, tr]) => {
    const x0 = tc * cut.w
    const y0 = tr * cut.h
    if (x0 + cut.w > png.width || y0 + cut.h > png.height) {
      throw new Error(
        `tile [${tc},${tr}] of ${cut.w}x${cut.h} is outside the ` +
          `${png.width}x${png.height} sheet ${cut.file}`,
      )
    }
    const data = new Uint8Array(cut.w * cut.h * 4)
    for (let y = 0; y < cut.h; y++) {
      const src = ((y0 + y) * png.width + x0) * 4
      data.set(png.data.subarray(src, src + cut.w * 4), y * cut.w * 4)
    }
    return { width: cut.w, height: cut.h, data, delayMs: ms }
  })
}

/**
 * The GIF decoder is another track's module, reached lazily so every PNG pack still
 * converts while it is in flight; a GIF cut without it is a loud per-cut failure.
 */
async function decodeGifFile(path: string): Promise<RgbaFrame[]> {
  const gif = await import('../../packages/core/src/gif.js')
  const bytes = new Uint8Array(readFileSync(path))
  if (!gif.isGif(bytes)) throw new Error(`${path} is not a GIF`)
  return gif.decodeGif(bytes)
}

async function loadCut(pack: Pack, cut: Cut): Promise<RgbaFrame[]> {
  const dir = resolve(SOURCES, pack.id)
  const ms = cut.ms ?? DEFAULT_MS
  if (cut.gif) return decodeGifFile(findFile(dir, cut.gif))
  if (cut.files) {
    return cut.files.map((f) => {
      const png = decodePng(new Uint8Array(readFileSync(findFile(dir, f))))
      return { width: png.width, height: png.height, data: png.data, delayMs: ms }
    })
  }
  if (cut.sheet) {
    const png = decodePng(new Uint8Array(readFileSync(findFile(dir, cut.sheet.file))))
    return sliceSheet(png, cut.sheet, ms)
  }
  throw new Error(`cut ${cut.name} names no gif, files or sheet`)
}

/**
 * A cut names files bare; zips unpack with their own directory layouts. One recursive
 * lookup keeps the manifest free of paths that are really the archive's business.
 */
function findFile(dir: string, name: string): string {
  const direct = resolve(dir, name)
  if (existsSync(direct)) return direct
  const walk = (d: string): string | null => {
    for (const entry of readdirSync(d)) {
      const p = resolve(d, entry)
      if (statSync(p).isDirectory()) {
        const hit = walk(p)
        if (hit) return hit
      } else if (entry === name) return p
    }
    return null
  }
  const hit = existsSync(dir) ? walk(dir) : null
  if (!hit) throw new Error(`${name} not found under ${dir}. Run \`animpack fetch\`.`)
  return hit
}

/**
 * One cut's frames through the whole shaping pipeline: key, ink, crop, lens, quantise.
 * The single implementation both `convert` and the `show --fresh` workbench call, so
 * what is tuned by eye is exactly what gets emitted.
 *
 * `contentPx` is the largest edge of the cropped sprite BEFORE the per-lens doubling:
 * the size gate asks how steep the downscale of the drawing is, and two copies of a
 * 30px coin are still a 30px coin.
 */
async function cutAnimation(
  pack: Pack,
  cut: Cut,
): Promise<{ animation: Animation; contentPx: number }> {
  const loaded = await loadCut(pack, cut)
  const keyed = (cut.key ?? 'auto') === 'auto' ? keyBackground(loaded) : loaded
  const inked = cut.ink === 'invert' ? invertInk(keyed) : keyed
  const cropped = cropFrames(inked)
  const shaped = cut.lens ? perLens(cropped) : cropped
  const contentPx = cropped.reduce((n, f) => Math.max(n, f.width, f.height), 0)
  return { animation: toAnimation(shaped, { ...QUANTISE_DEFAULTS, ...cut.opts }), contentPx }
}

/** Cells with an LED, counted once: the denominator for every coverage fraction. */
const ALIVE_CELLS = (() => {
  let n = 0
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (alive(r, c)) n++
  return n
})()

const litFraction = (b: Bitmap): number => {
  let lit = 0
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) if (alive(r, c) && b[r][c] > 0) lit++
  }
  return lit / ALIVE_CELLS
}

/** Rejection thresholds, exported so the test pins them from the other side. */
export const MIN_LIT = 0.04
export const MAX_LIT = 0.85
export const MIN_DETAIL = 16
export const MIN_MOTION = 2

export interface Verdict {
  kept: boolean
  reason: string
  /** 0 to 1. Meaningful only when kept; the app sorts on it. */
  score: number
}

/**
 * Does a quantised animation actually read on this panel, and how well?
 *
 * Judged on the NORMALISED animation: what plays is what is judged, and an animation
 * whose frames all quantised identical collapses to one frame there, which is the
 * "died in the downscale" case stated in its own words.
 *
 * The score is a ranking heuristic, not physics: structure (edges per frame, the same
 * `detail` that picks bankdump's thumbnails, saturating at 100), motion (changed
 * columns per transition, saturating at 10), and coverage (rising to full marks at 12%
 * lit, falling away above 60%, the range where this panel reads as a picture rather
 * than a floodlight). Weights favour structure because a crisp still frame survives a
 * glance and mush survives nothing.
 */
export function judge(animation: Animation): Verdict {
  const n = normalise(animation)
  if (n.frames.length === 0) return { kept: false, reason: 'nothing decoded', score: 0 }
  if (n.frames.length === 1) {
    return {
      kept: false,
      reason: 'every frame quantised identical: the animation died in the downscale',
      score: 0,
    }
  }
  const lit = n.frames.reduce((s, f) => s + litFraction(f), 0) / n.frames.length
  if (lit < MIN_LIT) {
    return { kept: false, reason: `almost nothing lit (${pc(lit)} of the panel)`, score: 0 }
  }
  if (lit > MAX_LIT) {
    return {
      kept: false,
      reason: `almost everything lit (${pc(lit)} of the panel): a grey rectangle`,
      score: 0,
    }
  }
  const edges = n.frames.reduce((s, f) => s + detail(f), 0) / n.frames.length
  if (edges < MIN_DETAIL) {
    return {
      kept: false,
      reason: `too little contrast survived (${edges.toFixed(1)} edges a frame)`,
      score: 0,
    }
  }
  let changed = 0
  for (let i = 0; i < n.frames.length; i++) {
    changed += changedColumns(n.frames[(i + n.frames.length - 1) % n.frames.length], n.frames[i])
  }
  const motion = changed / n.frames.length
  if (motion < MIN_MOTION) {
    return {
      kept: false,
      reason: `barely moves (${motion.toFixed(1)} columns change a frame)`,
      score: 0,
    }
  }
  const structure = Math.min(1, edges / 100)
  const movement = Math.min(1, motion / 10)
  const coverage = Math.min(1, lit / 0.12) * Math.min(1, Math.max(0, (0.9 - lit) / 0.3))
  const score = 0.45 * structure + 0.35 * movement + 0.2 * coverage
  return { kept: true, reason: '', score: Math.round(score * 1000) / 1000 }
}

const pc = (v: number): string => `${(v * 100).toFixed(0)}%`

/**
 * Convert every pack on disk. Deterministic over the same source bytes, which is what
 * lets `check` compare its output against the checked-in file byte for byte.
 */
export async function convertAll(packs: Pack[] = PACKS): Promise<Converted> {
  const rows: Row[] = []
  const skips: Skip[] = []
  const seenIds = new Set<string>()
  const seenFrames = new Map<string, string>()
  for (const pack of packs) {
    for (const cut of pack.cuts) {
      const id = `${pack.id}-${slugOf(cut.name)}`
      if (seenIds.has(id)) throw new Error(`duplicate id ${id}: rename the cut`)
      seenIds.add(id)
      let animation: Animation
      let contentPx: number
      try {
        ;({ animation, contentPx } = await cutAnimation(pack, cut))
      } catch (e) {
        skips.push({ pack: pack.id, cut: cut.name, reason: String(e) })
        continue
      }
      // The size gate runs on the cropped content: what matters is how steep the
      // drawing's downscale is, and a small sprite in a large canvas is still small.
      if (contentPx > MAX_SOURCE_PX) {
        skips.push({
          pack: pack.id,
          cut: cut.name,
          reason:
            `content is ${contentPx}px, over the ${MAX_SOURCE_PX}px source ` +
            'limit: a downscale that steep is mush at 24x9',
        })
        continue
      }
      const verdict = judge(animation)
      if (!verdict.kept) {
        skips.push({ pack: pack.id, cut: cut.name, reason: verdict.reason })
        continue
      }
      const packed = animation.frames.map(packBitmap)
      const twin = seenFrames.get(packed.join(''))
      if (twin) {
        skips.push({ pack: pack.id, cut: cut.name, reason: `identical to ${twin} once quantised` })
        continue
      }
      seenFrames.set(packed.join(''), id)
      rows.push({
        id,
        name: cut.name,
        tags: [...new Set([...cut.tags, ...pack.tags])].map((t) => t.toLowerCase()).sort(),
        pack: pack.name,
        licence: pack.licence,
        author: pack.author,
        source: pack.page,
        frameMs: animation.frameMs,
        frames: packed,
        score: verdict.score,
      })
    }
  }
  return { rows, skips }
}

/**
 * The generated module. Deterministic: no timestamp, no machine path, so `check` can
 * compare whole files. `PackRow` itself lives in the app (`animations.ts`), which owns
 * what the library screen needs; this file only promises to keep matching it.
 */
export function emitText(rows: Row[]): string {
  const body = rows.map((r) => {
    const tags = r.tags.map((t) => `'${t}'`).join(', ')
    const frames = r.frames.map((f) => `      '${f}',`).join('\n')
    return [
      '  {',
      `    id: '${r.id}',`,
      `    name: '${r.name}',`,
      `    tags: [${tags}],`,
      `    pack: '${r.pack}',`,
      `    licence: '${r.licence}',`,
      `    author: '${r.author}',`,
      `    source: '${r.source}',`,
      `    frameMs: [${r.frameMs.join(', ')}],`,
      '    frames: [',
      frames,
      '    ],',
      `    score: ${r.score},`,
      '  },',
    ].join('\n')
  })
  const packs = [...new Set(rows.map((r) => r.pack))].length
  return [
    '/**',
    ' * GENERATED by `bun run animpack emit`. Do not edit: `animpack check` fails if this',
    ' * file has drifted from what the fetched sources produce.',
    ' *',
    ` * ${rows.length} animations from ${packs} CC0 packs, converted to 24x9 four-level`,
    ' * frames and filtered for what actually reads on the panel. Licences were verified',
    ' * per pack on the page each row names in `source`; the human-readable record is',
    ' * research/animpack-licences.md, and the harvest tool with the layout notes is',
    ' * research/tools/animpack.ts.',
    ' *',
    ' * `frames` are `quantise.packBitmap` strings (72 base64 chars = 216 pixels at 2',
    ' * bits); `frameMs` is raw source timing, so run `anim.normalise()` before playing.',
    ' * `score` is 0-1, higher reads better on the panel; sort descending.',
    ' */',
    "import type { PackRow } from './animations.js'",
    '',
    'export const PACK_ROWS: PackRow[] = [',
    ...body,
    ']',
    '',
  ].join('\n')
}

const GLYPH = [' ', '.', '+', '#']

const asciiFrame = (b: Bitmap): string[] =>
  Array.from({ length: ROWS }, (_, i) => {
    const row = b[ROWS - 1 - i]
    return '   |' + row.map((v) => GLYPH[v] ?? '?').join('') + '|'
  })

async function checkedInRows(path: string): Promise<Row[]> {
  const mod = await import(path)
  return mod.PACK_ROWS as Row[]
}

async function fetchPacks(): Promise<boolean> {
  let ok = true
  for (const pack of PACKS) {
    const res = await fetch(pack.page)
    const html = await res.text()
    if (!res.ok || !OGA_CC0.test(html)) {
      console.error(`${pack.id}: ${pack.page} no longer proves ${pack.licence}. NOT fetched.`)
      ok = false
      continue
    }
    const dir = resolve(SOURCES, pack.id)
    mkdirSync(dir, { recursive: true })
    for (const file of pack.files) {
      const out = resolve(dir, file.to)
      const body = await (await fetch(file.url)).arrayBuffer()
      await Bun.write(out, body)
      if (file.to.endsWith('.zip')) {
        const unzip = Bun.spawnSync(['unzip', '-oq', out, '-d', dir])
        if (unzip.exitCode !== 0) {
          console.error(`${pack.id}: unzip of ${file.to} failed`)
          ok = false
        }
      }
    }
    await Bun.write(
      resolve(dir, 'PROVENANCE.txt'),
      `${pack.name} by ${pack.author}\n${pack.page}\n` +
        `licence field read as ${pack.licence} by animpack fetch, ` +
        `${new Date().toISOString().slice(0, 10)}\n`,
    )
    console.log(`${pack.id}: licence field says ${pack.licence}, ${pack.files.length} file(s)`)
  }
  return ok
}

function printReport({ rows, skips }: Converted): void {
  for (const pack of PACKS) {
    const kept = rows.filter((r) => r.id.startsWith(`${pack.id}-`))
    const lost = skips.filter((s) => s.pack === pack.id)
    console.log(`\n${pack.id}: ${kept.length} of ${pack.cuts.length} cuts kept`)
    for (const row of kept) {
      console.log(`  + ${row.id}  score ${row.score.toFixed(3)}  ${row.frames.length} frames`)
    }
    for (const skip of lost) console.log(`  - ${skip.cut}: ${skip.reason}`)
  }
  const cuts = PACKS.reduce((n, p) => n + p.cuts.length, 0)
  const bytes = rows.reduce((n, r) => n + r.frames.length * 72, 0)
  console.log(
    `\n${rows.length} of ${cuts} cuts survived; ` +
      `${rows.reduce((n, r) => n + r.frames.length, 0)} frames, ~${Math.round(bytes / 1024)} KB packed`,
  )
}

async function main(argv: string[]) {
  const [cmd, ...args] = argv
  if (!cmd) {
    console.log('usage: animpack <fetch|convert|emit|check|list|show> [args]')
    console.log('see the header comment for what each one reads and writes')
    process.exit(2)
  }

  if (cmd === 'fetch') {
    process.exit((await fetchPacks()) ? 0 : 1)
  }

  if (cmd === 'convert' || cmd === 'emit' || cmd === 'check') {
    if (!existsSync(SOURCES)) {
      console.error(`${SOURCES} does not exist. Run \`animpack fetch\` first.`)
      process.exit(2)
    }
    const converted = await convertAll()
    if (cmd === 'convert') {
      printReport(converted)
      return
    }
    const path = args[0] ? resolve(args[0]) : DEFAULT_OUT
    const text = emitText(converted.rows)
    if (cmd === 'emit') {
      await Bun.write(path, text)
      console.log(`wrote ${path}: ${converted.rows.length} animations, ${text.length} bytes`)
      printReport(converted)
      return
    }
    if (!existsSync(path)) {
      console.error(`${path} does not exist. Run \`emit\`.`)
      process.exit(1)
    }
    if (readFileSync(path, 'utf8') === text) {
      console.log(`${path} matches what the sources produce`)
      return
    }
    console.error(`${path} DIFFERS from what the fetched sources produce.`)
    console.error('Either it was hand-edited or the sources changed upstream.')
    console.error('`emit` overwrites it; nothing here does that for you.')
    process.exit(1)
  }

  if (cmd === 'list') {
    const rows = await checkedInRows(args[0] ? resolve(args[0]) : DEFAULT_OUT)
    console.log('id | name | pack | frames | score')
    console.log('--- | --- | --- | --- | ---')
    for (const r of [...rows].sort((a, b) => b.score - a.score)) {
      console.log([r.id, r.name, r.pack, r.frames.length, r.score.toFixed(3)].join(' | '))
    }
    console.log(`\n${rows.length} animations, all ${rows[0]?.licence ?? 'CC0'}`)
    return
  }

  if (cmd === 'show') {
    if (args[0] === '--fresh') {
      // Recipe workbench: convert ONE pack from sources and show everything, the
      // rejects included, because a recipe is tuned by looking at what it produces.
      const pack = PACKS.find((p) => p.id === args[1])
      if (!pack) {
        console.error(`no pack called ${args[1]}. Packs: ${PACKS.map((p) => p.id).join(', ')}`)
        process.exit(2)
      }
      for (const cut of pack.cuts) {
        let animation: Animation
        try {
          ;({ animation } = await cutAnimation(pack, cut))
        } catch (e) {
          console.log(`\n${cut.name}: UNREADABLE, ${e}`)
          continue
        }
        const verdict = judge(animation)
        const said = verdict.kept
          ? `kept, score ${verdict.score.toFixed(3)}`
          : `REJECTED, ${verdict.reason}`
        console.log(`\n${cut.name}: ${said}`)
        animation.frames.forEach((f, i) => {
          console.log(`  frame ${i}, ${animation.frameMs[i]}ms`)
          for (const line of asciiFrame(f)) console.log(line)
        })
      }
      return
    }
    const rows = await checkedInRows(DEFAULT_OUT)
    const row = rows.find((r) => r.id === args[0])
    if (!row) {
      console.error(`no animation called ${args[0]}. Try \`list\`.`)
      process.exit(2)
    }
    console.log(
      `${row.id}  "${row.name}"  ${row.pack} by ${row.author} (${row.licence})\n` +
        `score ${row.score.toFixed(3)}, tags: ${row.tags.join(', ')}`,
    )
    row.frames.forEach((f, i) => {
      console.log(`\n  frame ${i} of ${row.frames.length}, ${row.frameMs[i]}ms`)
      for (const line of asciiFrame(unpackBitmap(f))) console.log(line)
    })
    return
  }

  console.error(`unknown command ${cmd}`)
  process.exit(2)
}

if (import.meta.main) await main(process.argv.slice(2))
