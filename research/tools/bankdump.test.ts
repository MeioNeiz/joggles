/**
 * What `bankdump` must get right before a thumbnail is worth looking at.
 *
 * The two frame formats are the load-bearing part, and they are tested with synthetic
 * bytes rather than against the image, because the whole question is whether a bit lands
 * on the row the firmware puts it on. A test that decoded the real bank and compared it
 * against what this decoder produced would agree with itself whatever the mapping was.
 * The 27-byte case is the same halfword layout as the `DATS` receive path, which is the
 * *derived* claim `research/firmware-internals.md` flags as most worth checking, so it is
 * pinned here from the animation side.
 *
 * The rest runs against the real stock image where there is one. `firmware/` is gitignored,
 * so those are skipped rather than failing on a clean checkout, and the one that matters
 * is the last: the checked-in `builtins-data.ts` still being exactly what this tool emits.
 * That is `bankdump check` as part of the suite, so a hand-edit of generated data cannot
 * pass review unnoticed on a machine that has the image.
 *
 * Both paths below are resolved from this file rather than from the cwd, and the image is
 * read **inside** the tests. `describe.if(false)` still runs its callback and only marks
 * the tests skipped, so an eager read at describe level is an unhandled error rather than
 * a skip - which is a red suite on any checkout without `firmware/`, the one thing the
 * skip exists to prevent. *Fixed by review-20, which reproduced it by running the file
 * from a cwd where the relative path missed.*
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { parseHeader } from '../../packages/core/src/ota.js'
import { unpackThumb } from '../../packages/app/src/builtins.js'
import { BUILTIN_ROWS } from '../../packages/app/src/builtins-data.js'
import {
  DOCUMENTED,
  type Levels,
  banks,
  catalogue,
  decodeFrame,
  detail,
  emitText,
  frameAt,
  fromContainer,
  idOf,
  packThumb,
  usesGrey,
} from './bankdump.js'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..')
const STOCK = resolve(ROOT, 'firmware/TR1906R04-10_OTA.bin')
const GENERATED = resolve(ROOT, 'packages/app/src/builtins-data.ts')

const blank = (): Levels => Array.from({ length: 9 }, () => new Array(24).fill(0))

describe('the 27-byte format, 1 bit per pixel', () => {
  /** 24 data bytes then 3 mask bytes, as the firmware's own consumer reads them. */
  const frame = (data: number[], mask = 0): Uint8Array => {
    const out = new Uint8Array(27)
    out.set(data.slice(0, 24))
    out[24] = mask & 0xff
    out[25] = (mask >> 8) & 0xff
    out[26] = (mask >> 16) & 0xff
    return out
  }

  test('data bit 0 is row 1 and data bit 6 is row 7', () => {
    const got = decodeFrame(frame([0x01]), 27)
    expect(got[1][0]).toBe(3)
    expect(got[0][0]).toBe(0)
    expect(decodeFrame(frame([0x40]), 27)[7][0]).toBe(3)
  })

  test('data bit 7 is row 8, not row 0', () => {
    // The bit that decides whether uploaded graphics reach all 9 rows. If this were row
    // 0 the panel's top and bottom would be swapped for every built-in.
    const got = decodeFrame(frame([0x80]), 27)
    expect(got[8][0]).toBe(3)
    expect(got[0][0]).toBe(0)
  })

  test('the mask supplies row 0, one bit per column', () => {
    const got = decodeFrame(frame([], 1 << 5), 27)
    expect(got[0][5]).toBe(3)
    expect(got[0][4]).toBe(0)
    expect(got[8][5]).toBe(0)
  })

  test('is level 0 or level 3 and nothing between', () => {
    const got = decodeFrame(frame(new Array(24).fill(0xff), 0xffffff), 27)
    for (const row of got) for (const v of row) expect(v).toBe(3)
  })

  test('column n is byte n', () => {
    const data = new Array(24).fill(0)
    data[23] = 0x01
    expect(decodeFrame(frame(data), 27)[1][23]).toBe(3)
    expect(decodeFrame(frame(data), 27)[1][0]).toBe(0)
  })
})

describe('the 72-byte format, 2 bits per pixel', () => {
  /** Three little-endian bytes per column, two bits per row from row 0 up. */
  const frame = (columns: number[]): Uint8Array => {
    const out = new Uint8Array(72)
    columns.forEach((w, c) => {
      out[c * 3] = w & 0xff
      out[c * 3 + 1] = (w >> 8) & 0xff
      out[c * 3 + 2] = (w >> 16) & 0xff
    })
    return out
  }

  test('the low two bits are row 0', () => {
    const got = decodeFrame(frame([0b10]), 72)
    expect(got[0][0]).toBe(2)
    expect(got[1][0]).toBe(0)
  })

  test('row 8 is bits 16 and 17, which is the third byte', () => {
    expect(decodeFrame(frame([3 << 16]), 72)[8][0]).toBe(3)
  })

  test('carries the greys the 1bpp format cannot', () => {
    const w = 1 | (2 << 2) | (3 << 4)
    const got = decodeFrame(frame([w]), 72)
    expect([got[0][0], got[1][0], got[2][0]]).toEqual([1, 2, 3])
  })
})

describe('detail', () => {
  test('scores a blank frame and a full frame the same, at zero', () => {
    // The property the thumbnail choice exists for: "most lit pixels" picks a white
    // rectangle out of several banks, which is the frame that shows least.
    const full = blank().map((row) => row.map(() => 3))
    expect(detail(blank())).toBe(0)
    expect(detail(full)).toBe(0)
  })

  test('rises with structure', () => {
    const stripes = blank().map((row, r) => row.map(() => (r % 2 ? 3 : 0)))
    const one = blank()
    one[4][12] = 3
    expect(detail(stripes)).toBeGreaterThan(detail(one))
    expect(detail(one)).toBe(4)
  })
})

describe('the thumbnail format', () => {
  test('survives the trip through the generated file', () => {
    // The tool packs and the app unpacks, in different packages, and neither imports the
    // other's half of the format. This is the only place the two meet.
    const levels = blank()
    levels[0][0] = 1
    levels[4][12] = 2
    levels[8][23] = 3
    const packed = packThumb(levels)
    expect(packed.length).toBe(216)
    expect(unpackThumb(packed)).toEqual(levels)
  })

  test('every row of the checked-in catalogue unpacks', () => {
    expect(BUILTIN_ROWS.length).toBe(30)
    for (const row of BUILTIN_ROWS) expect(unpackThumb(row.thumb).length).toBe(9)
  })
})

test('ids are made from what gets sent, so they cannot drift', () => {
  expect(idOf('image', 0)).toBe('image-0')
  expect(idOf('animation', 18)).toBe('anim-18')
})

test('the tool cannot reach a device, by what it imports', () => {
  // "It never touches a device" is the tool's central claim and the reason running it
  // needs neither the glasses lock nor a pair in the room. A header cannot enforce that,
  // so this does: the deobfuscator is a pure function over bytes and is the only thing
  // the file pulls in. Comments go first, because the prose says "glasses" a lot.
  const src = readFileSync(resolve(ROOT, 'research/tools/bankdump.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  // Anchored on the statement, or the `import type` line inside the module this tool
  // GENERATES counts as one of its own. Line-anchoring is what review-14 caught missing a
  // dynamic import, so that is forbidden outright on the next line rather than enumerated.
  expect([...src.matchAll(/^import[^\n]*?from '(.+?)'/gm)].map((m) => m[1])).toEqual([
    '../../packages/core/src/ota.js',
  ])
  expect(src, 'imports at runtime').not.toMatch(/\bimport\s*\(|\brequire\s*\(/)
  const device = [/\bGlasses\b/, /\bTransport\b/, /noble/i, /\bble\b/i, /\bconnect/i]
  for (const named of device) expect(src, `names ${named}`).not.toMatch(named)
})

describe.if(existsSync(STOCK))('against the real stock image', () => {
  // Read on first use, not here: see the header. Memoised because every test wants it.
  let loaded: { bin: Uint8Array; fw: ReturnType<typeof fromContainer> } | null = null
  const image = () => {
    if (!loaded) {
      const bin = new Uint8Array(readFileSync(STOCK))
      loaded = { bin, fw: fromContainer(bin) }
    }
    return loaded
  }

  test('the resolved banks are the ones the tool quotes from the research file', () => {
    // `bankdump list` prints this diff, and until review-20 nothing but a person running
    // it ever checked. The quoted table is what `research/firmware-internals.md` "Bank
    // inventory" says; the image is the authority, so a stale quote is a failure here.
    const { fw } = image()
    const got = banks(fw).map((b) => [b.mode, b.addr, b.frames, b.stride])
    expect(got).toEqual(DOCUMENTED)
  })

  test('the catalogue is 11 images and 19 animations', () => {
    const { fw } = image()
    const items = catalogue(fw)
    expect(items.filter((i) => i.kind === 'image').length).toBe(11)
    expect(items.filter((i) => i.kind === 'animation').length).toBe(19)
  })

  test('no two built-ins share a thumbnail, and none is blank', () => {
    const { fw } = image()
    const seen = new Set<string>()
    for (const item of catalogue(fw)) {
      const packed = packThumb(frameAt(fw, item.bank, item.thumbFrame))
      expect(seen.has(packed), `${item.id} duplicates another thumbnail`).toBe(false)
      seen.add(packed)
      expect(/^0+$/.test(packed), `${item.id} is blank`).toBe(false)
    }
  })

  test('no 1bpp bank claims grey, and every 2bpp animation does', () => {
    // A 27-byte bank has no intermediate level to reach for, so this doubles as a check
    // that the format flag was resolved per mode rather than assumed.
    const { fw } = image()
    for (const item of catalogue(fw)) {
      if (item.bank.stride === 27) expect(usesGrey(fw, item), item.id).toBe(false)
      else if (item.kind === 'animation') expect(usesGrey(fw, item), item.id).toBe(true)
    }
  })

  test('the images share one 2bpp bank and only some of them use grey', () => {
    // Which is why the flag is asked per item and not per bank: a bank-wide answer would
    // put a "greys" tag on seven pictures that have none.
    const { fw } = image()
    const images = catalogue(fw).filter((i) => i.kind === 'image')
    expect(images.every((i) => i.bank.stride === 72)).toBe(true)
    expect(images.some((i) => usesGrey(fw, i))).toBe(true)
    expect(images.some((i) => !usesGrey(fw, i))).toBe(true)
  })

  test('the thumbnail frame is stable across runs, collisions included', () => {
    // `thumbFrame` is pure, so comparing it with itself proves nothing. What can move is
    // the collision fallback in `catalogue`, which depends on the order banks are walked
    // in and on what earlier rows have already taken. So run the whole thing twice, and
    // hold it to what is checked in as well: a re-emit must not reshuffle the tiles.
    const { fw } = image()
    const once = catalogue(fw).map((i) => [i.id, i.thumbFrame])
    const twice = catalogue(fw).map((i) => [i.id, i.thumbFrame])
    expect(once).toEqual(twice)
    expect(once).toEqual(BUILTIN_ROWS.map((r) => [r.id, r.thumbFrame]))
  })

  test('the collision fallback lands on a real frame of the right bank', () => {
    // Modes 7 and 8 share 19 of 35 frames and used to arrive at the same tile, so two of
    // these are a fallback rather than the most detailed frame. Whatever it picks has to
    // be inside the bank, and it must not be the blank frame the fallback could reach if
    // every better frame were taken.
    const { fw } = image()
    for (const item of catalogue(fw)) {
      expect(item.thumbFrame, item.id).toBeGreaterThanOrEqual(0)
      expect(item.thumbFrame, item.id).toBeLessThan(item.bank.frames)
      expect(detail(frameAt(fw, item.bank, item.thumbFrame)), item.id).toBeGreaterThan(0)
    }
  })

  test('the checked-in builtins-data.ts is what this tool emits', () => {
    const { bin, fw } = image()
    const have = readFileSync(GENERATED, 'utf8')
    expect(have).toBe(emitText(fw, `TR1906R04-10 app ${parseHeader(bin).appVer}`))
  })
})
