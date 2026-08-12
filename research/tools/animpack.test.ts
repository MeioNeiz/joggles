/**
 * What the harvest must get right before a checked-in animation is worth trusting.
 *
 * The PNG decode is tested with synthetic files built here, byte by byte, because the
 * question is whether a filtered, packed, palette-mapped scanline lands on the right
 * pixels, and decoding a real sheet and comparing against this decoder's own output
 * would agree with itself whatever the mapping was. The judge is tested with synthetic
 * bitmaps for the same reason: each rejection ground gets the smallest case that
 * triggers it and a neighbour that does not.
 *
 * The checked-in `animpack-data.ts` is held to its invariants WITHOUT the sources on
 * disk: ids, licences, frame shapes and the dead-LED mask are all facts about the
 * committed file. The one test that needs `research/animpack-sources/` (byte-for-byte
 * agreement between the file and a fresh convert, which is `animpack check` inside the
 * suite) skips on checkouts that have not run `animpack fetch`, exactly as the bankdump
 * suite skips without `firmware/`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { describe, expect, test } from 'bun:test'
import type { RgbaFrame } from '../../packages/core/src/anim.js'
import { unpackBitmap } from '../../packages/core/src/quantise.js'
import { ROWS, COLS, alive } from '../../packages/core/src/display.js'
import { PACK_ROWS } from '../../packages/app/src/animpack-data.js'
import { decodePng, isPng } from './png.js'
import {
  MAX_LIT,
  MIN_LIT,
  PACKS,
  SOURCES,
  convertAll,
  cropFrames,
  emitText,
  invertInk,
  judge,
  keyBackground,
  perLens,
  slugOf,
} from './animpack.js'

const GENERATED = resolve(
  dirname(new URL(import.meta.url).pathname),
  '../../packages/app/src/animpack-data.ts',
)

// ---------------------------------------------------------------- synthetic PNGs

/** One chunk. The CRC is zeros: the decoder documents that it does not verify them. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  new DataView(out.buffer).setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  return out
}

interface PngSpec {
  width: number
  height: number
  depth: number
  colour: number
  /** Scanlines WITH their leading filter bytes, as they go into the zlib stream. */
  lines: number[]
  palette?: number[]
  trns?: number[]
  interlace?: number
}

function makePng(spec: PngSpec): Uint8Array {
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, spec.width)
  dv.setUint32(4, spec.height)
  ihdr[8] = spec.depth
  ihdr[9] = spec.colour
  ihdr[12] = spec.interlace ?? 0
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ]
  if (spec.palette) parts.push(chunk('PLTE', new Uint8Array(spec.palette)))
  if (spec.trns) parts.push(chunk('tRNS', new Uint8Array(spec.trns)))
  parts.push(chunk('IDAT', new Uint8Array(deflateSync(new Uint8Array(spec.lines)))))
  parts.push(chunk('IEND', new Uint8Array(0)))
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const px = (d: Uint8Array, w: number, x: number, y: number) =>
  [...d.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)]

describe('png.ts', () => {
  test('RGBA rows through Sub, Up and Average filters land on the right pixels', () => {
    // Row 0 unfiltered: red then semi-transparent green. Row 1 Sub: repeats its first
    // pixel. Row 2 Up: copies row 1. Row 3 Average: floor((a+b)/2) per byte.
    const png = makePng({
      width: 2,
      height: 4,
      depth: 8,
      colour: 6,
      lines: [
        [0, 255, 0, 0, 255, 0, 200, 0, 128],
        [1, 10, 20, 30, 255, 10, 20, 30, 0],
        [2, 0, 0, 0, 0, 0, 0, 0, 0],
        [3, 0, 0, 0, 0, 0, 0, 0, 0],
      ].flat(),
    })
    expect(isPng(png)).toBe(true)
    const got = decodePng(png)
    expect([got.width, got.height]).toEqual([2, 4])
    expect(px(got.data, 2, 0, 0)).toEqual([255, 0, 0, 255])
    expect(px(got.data, 2, 1, 0)).toEqual([0, 200, 0, 128])
    expect(px(got.data, 2, 0, 1)).toEqual([10, 20, 30, 255])
    expect(px(got.data, 2, 1, 1)).toEqual([20, 40, 60, 255])
    expect(px(got.data, 2, 1, 2)).toEqual([20, 40, 60, 255])
    // Average of left (10,20,30,127) and up (10,20,30,255), per byte, floored.
    expect(px(got.data, 2, 0, 3)).toEqual([5, 10, 15, 127])
  })

  test('Paeth filter picks the right predictor', () => {
    // Grey 8-bit, 2x2: row 1 filter 4. For x=0 (a=0, b=up, c=0) Paeth returns b.
    const png = makePng({
      width: 2,
      height: 2,
      depth: 8,
      colour: 0,
      lines: [0, 100, 200, 4, 10, 0],
    })
    const got = decodePng(png)
    expect(px(got.data, 2, 0, 1)).toEqual([110, 110, 110, 255])
    // x=1: a=110, b=200, c=100; p=210, pa=100, pb=10, pc=110, so b again.
    expect(px(got.data, 2, 1, 1)).toEqual([200, 200, 200, 255])
  })

  test('4-bit palette with tRNS unpacks MSB-first and maps alpha per entry', () => {
    const png = makePng({
      width: 3,
      height: 1,
      depth: 4,
      colour: 3,
      // Indices 0,1,2 packed as nibbles: 0x01, 0x20.
      lines: [0, 0x01, 0x20],
      palette: [255, 0, 0, 0, 255, 0, 0, 0, 255],
      trns: [255, 0],
    })
    const got = decodePng(png)
    expect(px(got.data, 3, 0, 0)).toEqual([255, 0, 0, 255])
    expect(px(got.data, 3, 1, 0)).toEqual([0, 255, 0, 0])
    // Index 2 has no tRNS entry, so it is opaque.
    expect(px(got.data, 3, 2, 0)).toEqual([0, 0, 255, 255])
  })

  test('1-bit greyscale scales to 0 and 255', () => {
    // 10 wide so the row spills into a second byte: 1100000001.
    const png = makePng({
      width: 10,
      height: 1,
      depth: 1,
      colour: 0,
      lines: [0, 0b11000000, 0b01000000],
    })
    const got = decodePng(png)
    expect(px(got.data, 10, 0, 0)).toEqual([255, 255, 255, 255])
    expect(px(got.data, 10, 2, 0)).toEqual([0, 0, 0, 255])
    expect(px(got.data, 10, 9, 0)).toEqual([255, 255, 255, 255])
  })

  test('16-bit samples truncate to their high byte', () => {
    const png = makePng({
      width: 1,
      height: 1,
      depth: 16,
      colour: 0,
      lines: [0, 0xab, 0xcd],
    })
    expect(px(decodePng(png).data, 1, 0, 0)).toEqual([0xab, 0xab, 0xab, 255])
  })

  test('grey-plus-alpha carries the alpha channel', () => {
    const png = makePng({
      width: 1,
      height: 1,
      depth: 8,
      colour: 4,
      lines: [0, 80, 40],
    })
    expect(px(decodePng(png).data, 1, 0, 0)).toEqual([80, 80, 80, 40])
  })

  test('an RGB tRNS colour key turns exactly that colour transparent', () => {
    const png = makePng({
      width: 2,
      height: 1,
      depth: 8,
      colour: 2,
      lines: [0, 1, 2, 3, 9, 9, 9],
      trns: [0, 1, 0, 2, 0, 3],
    })
    const got = decodePng(png)
    expect(px(got.data, 2, 0, 0)[3]).toBe(0)
    expect(px(got.data, 2, 1, 0)[3]).toBe(255)
  })

  test('refuses what it cannot represent, by name', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/signature/)
    expect(() =>
      decodePng(
        makePng({ width: 1, height: 1, depth: 8, colour: 0, lines: [0, 1], interlace: 1 }),
      ),
    ).toThrow(/Adam7/)
    expect(() =>
      decodePng(
        makePng({
          width: 1,
          height: 1,
          depth: 8,
          colour: 3,
          lines: [0, 5],
          palette: [1, 2, 3],
        }),
      ),
    ).toThrow(/palette/)
  })
})

// ------------------------------------------------------------- frame shaping

const rgba = (width: number, height: number, fill: number[]): RgbaFrame => {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) data.set(fill, i * 4)
  return { width, height, data, delayMs: 100 }
}

describe('keyBackground', () => {
  test('keys a uniform opaque backdrop out and leaves the sprite', () => {
    const f = rgba(6, 6, [200, 30, 30, 255])
    f.data.set([10, 250, 10, 255], (2 * 6 + 2) * 4)
    const [got] = keyBackground([f])
    expect(got.data[3]).toBe(0)
    expect(got.data[(2 * 6 + 2) * 4 + 3]).toBe(255)
  })

  test('does nothing when the source already has real transparency', () => {
    const f = rgba(6, 6, [200, 30, 30, 255])
    for (let i = 0; i < 6; i++) f.data[i * 4 + 3] = 0
    const got = keyBackground([f])
    expect(got[0]).toBe(f)
  })

  test('does nothing when no one colour holds the border', () => {
    const f = rgba(4, 4, [0, 0, 0, 255])
    for (let i = 0; i < 16; i++) f.data[i * 4] = i * 16
    expect(keyBackground([f])[0]).toBe(f)
  })
})

test('invertInk flips opaque pixels and leaves transparent ones untouched', () => {
  const f = rgba(2, 1, [10, 20, 30, 255])
  f.data[7] = 0
  const [got] = invertInk([f])
  expect([...got.data.subarray(0, 4)]).toEqual([245, 235, 225, 255])
  expect([...got.data.subarray(4, 8)]).toEqual([10, 20, 30, 0])
})

describe('cropFrames', () => {
  test('crops to the union box across frames, not per frame', () => {
    const a = rgba(10, 10, [0, 0, 0, 0])
    a.data.set([255, 255, 255, 255], (2 * 10 + 2) * 4)
    const b = rgba(10, 10, [0, 0, 0, 0])
    b.data.set([255, 255, 255, 255], (7 * 10 + 7) * 4)
    const got = cropFrames([a, b])
    expect(got[0].width).toBe(6)
    expect(got[0].height).toBe(6)
    // Frame a keeps its pixel at the box's origin; frame b at the box's far corner.
    expect(got[0].data[3]).toBe(255)
    expect(got[1].data[(5 * 6 + 5) * 4 + 3]).toBe(255)
  })

  test('a fully opaque frame passes through unchanged', () => {
    const f = rgba(5, 4, [9, 9, 9, 255])
    expect(cropFrames([f])[0]).toBe(f)
  })
})

describe('perLens', () => {
  test('a small square sprite becomes two copies on a panel-shaped canvas', () => {
    const f = rgba(8, 8, [255, 255, 255, 255])
    const [got] = perLens([f])
    expect(got.width).toBe(Math.round((8 * COLS) / ROWS))
    expect(got.data[3]).toBe(255)
    expect(got.data[((got.width - 1) * 4) + 3]).toBe(255)
    // The middle stays clear: that is where the nose notch would eat pixels.
    expect(got.data[(10 * 4) + 3]).toBe(0)
  })

  test('a frame too wide for two copies passes through unchanged', () => {
    const f = rgba(20, 8, [255, 255, 255, 255])
    expect(perLens([f])[0]).toBe(f)
  })
})

// ------------------------------------------------------------------ the judge

const frame = (fill: number): number[][] =>
  Array.from({ length: ROWS }, () => new Array(COLS).fill(fill))

const checker = (phase: 0 | 1): number[][] =>
  Array.from({ length: ROWS }, (_, r) =>
    Array.from({ length: COLS }, (_, c) => ((r + c + phase) % 2 ? 3 : 0)),
  )

describe('judge', () => {
  test('rejects a dark animation and an all-lit one the same way: grey rectangles', () => {
    // The frames must differ, or the merged-identical rejection speaks first.
    const a = frame(0)
    a[4][2] = 3
    const b = frame(0)
    b[4][3] = 3
    const dark = judge({ frames: [a, b], frameMs: [100, 100] })
    expect(dark.kept).toBe(false)
    expect(dark.reason).toContain('nothing lit')
    const full = frame(3)
    const dimmed = frame(3)
    dimmed[4][2] = 2
    const flood = judge({ frames: [full, dimmed], frameMs: [100, 100] })
    expect(flood.kept).toBe(false)
    expect(flood.reason).toContain('everything lit')
    // The thresholds the two cases sit outside of, pinned so a tune is a visible diff.
    expect(MIN_LIT).toBeCloseTo(0.04)
    expect(MAX_LIT).toBeCloseTo(0.85)
  })

  test('rejects an animation whose frames all quantised identical', () => {
    const a = checker(0)
    const got = judge({ frames: [a, a.map((r) => [...r])], frameMs: [100, 100] })
    expect(got.kept).toBe(false)
    expect(got.reason).toContain('died in the downscale')
  })

  test('keeps a crisp mover and scores it inside 0..1', () => {
    const got = judge({ frames: [checker(0), checker(1)], frameMs: [100, 100] })
    expect(got.kept).toBe(true)
    expect(got.score).toBeGreaterThan(0)
    expect(got.score).toBeLessThanOrEqual(1)
  })

  test('a change hidden entirely behind dead LEDs does not count as motion', () => {
    // Only the notch cells differ, so the two frames are the same lit picture.
    const a = checker(0)
    const b = a.map((row) => [...row])
    b[0][10] = b[0][10] ? 0 : 3
    const got = judge({ frames: [a, b], frameMs: [100, 100] })
    expect(got.kept).toBe(false)
    expect(got.reason).toContain('died in the downscale')
  })
})

test('ids slug from the source name, so they cannot drift with array order', () => {
  expect(slugOf('Slime walk')).toBe('slime-walk')
  expect(slugOf('  Fancy--Name!! ')).toBe('fancy-name')
})

// ------------------------------------------------------- the checked-in catalogue

describe('the checked-in animpack-data.ts', () => {
  test('ids are unique and every one begins with a manifest pack id', () => {
    const ids = new Set(PACK_ROWS.map((r) => r.id))
    expect(ids.size).toBe(PACK_ROWS.length)
    const packIds = new Set(PACKS.map((p) => p.id))
    for (const row of PACK_ROWS) {
      const prefix = [...packIds].find((p) => row.id.startsWith(`${p}-`))
      expect(prefix, row.id).toBeTruthy()
    }
  })

  test('every animation is CC0, named, sourced, and actually an animation', () => {
    expect(PACK_ROWS.length).toBeGreaterThan(0)
    for (const row of PACK_ROWS) {
      expect(row.licence, row.id).toBe('CC0')
      expect(row.name.length, row.id).toBeGreaterThan(0)
      expect(row.author.length, row.id).toBeGreaterThan(0)
      expect(row.source, row.id).toStartWith('https://')
      expect(row.frames.length, row.id).toBeGreaterThan(1)
      expect(row.frameMs.length, row.id).toBe(row.frames.length)
      expect(row.score, row.id).toBeGreaterThan(0)
      expect(row.score, row.id).toBeLessThanOrEqual(1)
      expect(row.tags.every((t) => t === t.toLowerCase()), row.id).toBe(true)
    }
  })

  test('every frame unpacks to a panel shape that respects the dead LEDs', () => {
    for (const row of PACK_ROWS) {
      for (const packed of row.frames) {
        const b = unpackBitmap(packed)
        expect(b.length).toBe(ROWS)
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            if (!alive(r, c)) expect(b[r][c], `${row.id} lights a dead LED`).toBe(0)
          }
        }
      }
    }
  })

  test('no two rows are the same frames: near-duplicates would pad the count', () => {
    const seen = new Set<string>()
    for (const row of PACK_ROWS) {
      const key = row.frames.join('')
      expect(seen.has(key), `${row.id} duplicates another row`).toBe(false)
      seen.add(key)
    }
  })
})

describe.if(existsSync(SOURCES))('against the fetched sources', () => {
  test('the checked-in file is exactly what convert produces', async () => {
    const { rows } = await convertAll()
    expect(readFileSync(GENERATED, 'utf8')).toBe(emitText(rows))
  })

  test('the report is honest: manifest cuts equal kept plus skipped', async () => {
    const { rows, skips } = await convertAll()
    const cuts = PACKS.reduce((n, p) => n + p.cuts.length, 0)
    expect(rows.length + skips.length).toBe(cuts)
    for (const skip of skips) expect(skip.reason.length).toBeGreaterThan(0)
  })
})

test('the tool cannot reach a device, by what it imports', () => {
  // As bankdump's same-named test: the property that makes running this tool need no
  // hardware lock is enforced from the source text. The static imports are pinned; the
  // only dynamic imports allowed are the GIF decoder (loaded lazily while that track
  // was in flight) and the generated data file that `list`/`show` read back.
  const src = readFileSync(
    resolve(dirname(new URL(import.meta.url).pathname), 'animpack.ts'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  expect([...src.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]).sort()).toEqual(
    [
      '../../packages/core/src/anim.js',
      '../../packages/core/src/content.js',
      '../../packages/core/src/display.js',
      '../../packages/core/src/quantise.js',
      './bankdump.js',
      './png.js',
      'node:fs',
      'node:path',
    ].sort(),
  )
  const dynamic = [...src.matchAll(/import\s*\(\s*([^)]*)\)/g)].map((m) => m[1].trim())
  expect(dynamic).toEqual(["'../../packages/core/src/gif.js'", 'path'])
  const device = [/\bGlasses\b/, /\bTransport\b/, /noble/i, /9600|960a|960b/, /\bconnect\(/]
  for (const named of device) expect(src, `names ${named}`).not.toMatch(named)
})
