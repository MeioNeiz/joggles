/**
 * PNG decoder for the harvest tools: bytes in, one straight-sRGB RGBA image out.
 *
 * WHY THIS IS IN research/ AND NOT packages/core. The phone never decodes a PNG:
 * `animpack.ts` converts sprite sheets offline and checks in panel-shaped frames, so a
 * PNG only ever exists on this side of the fence. core is zero-dep pure TS that React
 * Native must be able to load, and a PNG needs a real inflate; `node:zlib` is free here
 * and forbidden there (`safe-surface.test.ts` is the fence). GIF is different: the app
 * may one day be handed a GIF at runtime, which is why `core/src/gif.ts` exists and
 * carries its own inflate-free decode.
 *
 * Covers what pixel-art packs actually use: colour types 0, 2, 3, 4, 6, bit depths
 * 1/2/4/8/16 (16 truncates to the high byte), `tRNS` transparency for types 0, 2, 3.
 * Refuses Adam7 interlace by name rather than emitting scrambled pixels: nothing in the
 * packs fetched so far is interlaced, and a wrong image that looks plausible is exactly
 * the failure mode a filter built on "how much survived quantising" cannot catch.
 *
 * Chunk CRCs are not verified. The input is a file just downloaded over TLS or already
 * on disk; a flipped bit fails loudly in inflate or in the dimensions, and the one thing
 * a CRC check would add is a reason for a working file to stop converting.
 *
 * Output rows run top to bottom, as in every image format. The flip to the panel's
 * row 0 at the bottom is `quantise.ts`'s job, done once, on the way to a `Bitmap`.
 */
import { inflateSync } from 'node:zlib'

export interface DecodedPng {
  width: number
  height: number
  /** `width * height * 4` bytes, straight (non-premultiplied) RGBA, row 0 at the top. */
  data: Uint8Array
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export const isPng = (bytes: Uint8Array): boolean =>
  bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b)

/** Samples per pixel, by colour type. Grey, RGB, palette index, grey+A, RGBA. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

interface Header {
  width: number
  height: number
  depth: number
  colour: number
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  if (!isPng(bytes)) throw new Error('not a PNG: bad signature')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let header: Header | null = null
  let palette: Uint8Array | null = null
  let trns: Uint8Array | null = null
  const idat: Uint8Array[] = []

  let at = 8
  while (at + 8 <= bytes.length) {
    const len = dv.getUint32(at)
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7])
    const data = bytes.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') {
      const interlace = data[12]
      if (interlace !== 0) throw new Error('Adam7-interlaced PNG: not supported here')
      header = {
        width: dv.getUint32(at + 8),
        height: dv.getUint32(at + 12),
        depth: data[8],
        colour: data[9],
      }
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    at += 12 + len
  }
  if (!header) throw new Error('no IHDR chunk')
  if (idat.length === 0) throw new Error('no IDAT chunks')
  const channels = CHANNELS[header.colour]
  if (!channels) throw new Error(`unknown colour type ${header.colour}`)

  const zipped = new Uint8Array(idat.reduce((n, c) => n + c.length, 0))
  let off = 0
  for (const c of idat) {
    zipped.set(c, off)
    off += c.length
  }
  const raw = new Uint8Array(inflateSync(zipped))

  const { width, height, depth } = header
  const bitsPerPx = channels * depth
  const rowBytes = Math.ceil((width * bitsPerPx) / 8)
  // The filter step works on whole bytes: for sub-byte depths the pixel to the left is
  // the byte to the left, which is what the spec means by clamping bpp at 1.
  const bpp = Math.max(1, Math.ceil(bitsPerPx / 8))
  if (raw.length < (rowBytes + 1) * height) {
    throw new Error(`short pixel data: ${raw.length} bytes for ${width}x${height}`)
  }

  const lines = defilter(raw, width, height, rowBytes, bpp)
  return { width, height, data: toRgba(lines, header, channels, rowBytes, palette, trns) }
}

/** Undo the per-row filter. Returns the raw scanlines with the filter bytes gone. */
function defilter(
  raw: Uint8Array,
  width: number,
  height: number,
  rowBytes: number,
  bpp: number,
): Uint8Array {
  const out = new Uint8Array(rowBytes * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)]
    const src = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1))
    const row = out.subarray(y * rowBytes, (y + 1) * rowBytes)
    const above = y > 0 ? out.subarray((y - 1) * rowBytes, y * rowBytes) : null
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? row[x - bpp] : 0
      const b = above ? above[x] : 0
      const c = above && x >= bpp ? above[x - bpp] : 0
      let v = src[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) v += paeth(a, b, c)
      else if (filter !== 0) throw new Error(`unknown filter ${filter} on row ${y}`)
      row[x] = v & 0xff
    }
  }
  return out
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Every sample of one scanline at its stored precision, MSB-first for sub-byte depths. */
function samples(row: Uint8Array, count: number, depth: number): number[] {
  const out = new Array<number>(count)
  if (depth === 8) {
    for (let i = 0; i < count; i++) out[i] = row[i]
  } else if (depth === 16) {
    for (let i = 0; i < count; i++) out[i] = row[i * 2]
  } else {
    const per = 8 / depth
    const mask = (1 << depth) - 1
    for (let i = 0; i < count; i++) {
      const byte = row[Math.floor(i / per)]
      const shift = 8 - depth * ((i % per) + 1)
      out[i] = (byte >> shift) & mask
    }
  }
  return out
}

function toRgba(
  lines: Uint8Array,
  header: Header,
  channels: number,
  rowBytes: number,
  palette: Uint8Array | null,
  trns: Uint8Array | null,
): Uint8Array {
  const { width, height, depth, colour } = header
  // 16-bit samples arrive already truncated to their high byte, so scale from 8 bits.
  const sampleDepth = Math.min(depth, 8)
  const max = (1 << sampleDepth) - 1
  const scale = (v: number) => Math.round((v * 255) / max)

  // tRNS carries 16-bit values for types 0 and 2; compare at the truncated precision.
  const trns16 = (i: number) => (trns ? trns[i * 2] * 256 + trns[i * 2 + 1] : -1)
  const keyGrey = colour === 0 && trns ? trns16(0) >> (depth === 16 ? 8 : 0) : -1
  const keyRgb =
    colour === 2 && trns
      ? [0, 1, 2].map((i) => trns16(i) >> (depth === 16 ? 8 : 0))
      : null

  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const row = lines.subarray(y * rowBytes, (y + 1) * rowBytes)
    const s = samples(row, width * channels, depth)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (colour === 3) {
        const i = s[x]
        if (!palette || i * 3 + 2 >= palette.length) {
          throw new Error(`palette index ${i} outside the PLTE at (${x},${y})`)
        }
        out[o] = palette[i * 3]
        out[o + 1] = palette[i * 3 + 1]
        out[o + 2] = palette[i * 3 + 2]
        out[o + 3] = trns && i < trns.length ? trns[i] : 255
      } else if (colour === 0) {
        const g = s[x]
        out[o] = out[o + 1] = out[o + 2] = scale(g)
        out[o + 3] = g === keyGrey ? 0 : 255
      } else if (colour === 4) {
        const g = scale(s[x * 2])
        out[o] = out[o + 1] = out[o + 2] = g
        out[o + 3] = scale(s[x * 2 + 1])
      } else if (colour === 2) {
        const [r, g, b] = [s[x * 3], s[x * 3 + 1], s[x * 3 + 2]]
        out[o] = scale(r)
        out[o + 1] = scale(g)
        out[o + 2] = scale(b)
        out[o + 3] = keyRgb && r === keyRgb[0] && g === keyRgb[1] && b === keyRgb[2] ? 0 : 255
      } else {
        out[o] = scale(s[x * 4])
        out[o + 1] = scale(s[x * 4 + 1])
        out[o + 2] = scale(s[x * 4 + 2])
        out[o + 3] = scale(s[x * 4 + 3])
      }
    }
  }
  return out
}
