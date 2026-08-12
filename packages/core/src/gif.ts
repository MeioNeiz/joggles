/**
 * GIF87a/GIF89a to `anim.RgbaFrame[]`: the whole decoder, pure TS, zero dependencies.
 *
 * This is how a file off the internet becomes frames, so it runs on the phone against
 * bytes nobody here produced. Two rules follow. It never returns a partial animation:
 * a truncated or malformed file throws an Error saying what was wrong, because half a
 * decode composited onto a panel looks like a rendering bug and gets debugged as one.
 * And every loop is bounded: the block walk advances at least one byte per step, LZW
 * stops at the declared pixel count however much the stream offers, a dictionary chain
 * walk terminates because every entry's prefix has a smaller index than the entry
 * itself, and `MAX_CANVAS_PIXELS`/`MAX_TOTAL_PIXELS` cap what a hostile header can make
 * us allocate. No `Buffer`, no `node:*`: React Native has neither, and
 * `safe-surface.test.ts` enforces that for whatever the barrel reaches.
 *
 * ## Why full frames come back, not patches
 *
 * A GIF frame is a sub-rectangle painted over a canvas plus a disposal rule for what
 * happens to the rectangle afterwards. Everything downstream wants pictures, so the
 * compositing happens here, once, and each returned frame is the complete canvas as a
 * viewer would see it, row 0 the top. Getting disposal wrong is the classic way a
 * decoder smears sprites across frames, so the rules as implemented:
 *
 *  - 0 and 1: leave the rectangle as painted.
 *  - 2, restore to background: the spec says paint the background colour, and every
 *    renderer since Netscape clears the rectangle to transparent instead, ignoring the
 *    background colour index outright. GIFs in the wild are authored against the
 *    renderers, not the spec, so this decoder clears to transparent too: obeying the
 *    spec paints solid rectangles behind sprites that every other viewer shows
 *    floating. The index (byte 11) is parsed and deliberately unused. *Derived* from
 *    renderer behaviour, not from the spec, which says the opposite.
 *  - 3, restore to previous: the canvas as it was before this frame drew. A frame only
 *    paints inside its own rectangle, so snapshotting the whole canvas before drawing
 *    and putting it back is exactly the rectangle restore the spec asks for.
 *  - 4: undefined by the spec, treated as restore-to-previous because an early draft
 *    numbered it that way and Blink still maps it so (*derived* from Blink source).
 *
 * The initial canvas is transparent, also the renderer consensus. A transparent index
 * in a frame means "do not paint", which over a previous frame is see-through and over
 * nothing is alpha 0.
 *
 * ## The LZW corners that produce garbage if missed
 *
 * - Codes are packed LSB-first at a width that grows as the dictionary fills. Encoder
 *   and decoder are one entry out of step (the decoder learns entry N only on the code
 *   after the one that created it), yet the natural widening rules agree: both widen
 *   between code j and code j+1 exactly when entry eoi+j lands on a power of two.
 *   Implementing either side's rule with the other side's timing desyncs the stream a
 *   few codes after every width change.
 * - The KwKwK case: a code equal to the next unassigned entry is legal, means "the
 *   previous sequence plus its own first byte", and appears in any run of repeats. It
 *   is only legal mid-stream; as the first code after a clear it is malformed.
 * - Deferred clear: at 4096 entries the dictionary is full and some encoders keep
 *   going without ever sending a clear code. The decoder must hold the width at 12,
 *   add nothing, and keep resolving codes against the full table until a clear arrives
 *   or the frame is done. Treating fullness as an error, or letting the width grow to
 *   13, breaks real files.
 * - The stream ends when the pixels are done, not when the data is: surplus codes are
 *   ignored and the end-of-information code is not required, but data running out
 *   before the pixel count is met throws.
 *
 * Interlaced frames arrive as four passes of rows (every 8th from row 0, every 8th
 * from 4, every 4th from 2, every 2nd from 1) and are reordered here, so everything
 * after the decode is natural row order.
 *
 * Delays pass through raw, in ms, including 0. `anim.normalise()` owns the policy of
 * what 0 means (the 100 ms every browser substitutes); applying it here as well would
 * put the rule in two places.
 *
 * How this is verified: against fixtures `gif.test.ts` assembles byte by byte with its
 * own LZW encoder, so the format claims are *derived* from the GIF89a spec and from
 * renderer behaviour rather than checked against a reference corpus. An encoder and a
 * decoder written by the same hand can agree on a shared misreading; the hand-packed
 * raw LZW streams in the tests exist to pin the bit order and the error paths
 * independently of that encoder.
 */
import type { RgbaFrame } from './anim.js'

/**
 * Widest single canvas or sub-image decoded, 4096 x 4096. A GIF header can claim
 * 65535 x 65535, which is a 17 GB RGBA allocation on a phone; nothing headed at a
 * 24 x 9 panel is within two orders of magnitude of this cap.
 */
export const MAX_CANVAS_PIXELS = 4096 * 4096

/**
 * Pixels across all composited frames together, 2^26 (~256 MB of RGBA). This is the
 * hang-and-OOM bound for hostile files, not a format limit: a legitimate file over it
 * is refused with a clear error rather than decoded into a phone's whole memory.
 */
export const MAX_TOTAL_PIXELS = 1 << 26

/** True when the bytes start with a GIF signature. Cheap, reads six bytes. */
export function isGif(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false
  const sig = String.fromCharCode(...bytes.subarray(0, 6))
  return sig === 'GIF87a' || sig === 'GIF89a'
}

type Disposal = 'leave' | 'background' | 'previous'

interface ParsedImage {
  left: number
  top: number
  width: number
  height: number
  /** One palette index per pixel, natural row order (already de-interlaced). */
  indices: Uint8Array
  /** RGB triples, the local table if the frame carried one, else the global. */
  palette: Uint8Array
  /** Index that paints nothing, or -1. */
  transparent: number
  disposal: Disposal
  delayMs: number
}

/**
 * Decode a whole GIF into fully composited canvas-sized frames.
 *
 * Throws on anything truncated or malformed rather than returning a prefix of the
 * animation. A missing trailer counts as truncated: without it there is no way to
 * know the file was whole.
 */
export function decodeGif(bytes: Uint8Array): RgbaFrame[] {
  if (!isGif(bytes)) {
    throw new Error('not a GIF: the first six bytes are not GIF87a or GIF89a')
  }
  if (bytes.length < 13) {
    throw new Error('the file ends inside the logical screen descriptor')
  }
  let screenW = bytes[6] | (bytes[7] << 8)
  let screenH = bytes[8] | (bytes[9] << 8)
  // bytes[11] is the background colour index, parsed and deliberately unused: every
  // renderer clears to transparent instead. See the docblock.
  let pos = 13
  let global: Uint8Array | null = null
  if (bytes[10] & 0x80) {
    const n = 3 * (1 << ((bytes[10] & 0x07) + 1))
    if (pos + n > bytes.length) {
      throw new Error('the file ends inside the global colour table')
    }
    global = bytes.subarray(pos, pos + n)
    pos += n
  }

  const images: ParsedImage[] = []
  let gce: { disposal: Disposal; delayMs: number; transparent: number } | null = null
  let parsedPixels = 0
  let sawTrailer = false
  while (pos < bytes.length) {
    const introducer = bytes[pos]
    pos += 1
    if (introducer === 0x3b) {
      sawTrailer = true
      break
    }
    // Stray zero padding between blocks is common enough that browsers skip it.
    if (introducer === 0x00) continue
    if (introducer === 0x21) {
      if (pos >= bytes.length) throw new Error('the file ends at an extension label')
      const label = bytes[pos]
      pos += 1
      if (label === 0xf9) {
        const { data, end } = subBlocks(bytes, pos, 'the graphic control extension')
        pos = end
        if (data.length < 4) {
          throw new Error('the graphic control extension is shorter than its four bytes')
        }
        const raw = (data[0] >> 2) & 0x07
        gce = {
          disposal:
            raw === 2 ? 'background' : raw === 3 || raw === 4 ? 'previous' : 'leave',
          delayMs: (data[1] | (data[2] << 8)) * 10,
          transparent: data[0] & 0x01 ? data[3] : -1,
        }
      } else {
        // Comments, application blocks (NETSCAPE looping), plain text and anything
        // unknown all share the sub-block shape, so they all skip the same way.
        pos = subBlocks(bytes, pos, 'an extension').end
      }
      continue
    }
    if (introducer === 0x2c) {
      if (pos + 9 > bytes.length) {
        throw new Error('the file ends inside an image descriptor')
      }
      const left = bytes[pos] | (bytes[pos + 1] << 8)
      const top = bytes[pos + 2] | (bytes[pos + 3] << 8)
      const w = bytes[pos + 4] | (bytes[pos + 5] << 8)
      const h = bytes[pos + 6] | (bytes[pos + 7] << 8)
      const packed = bytes[pos + 8]
      pos += 9
      if (w * h > MAX_CANVAS_PIXELS) {
        throw new Error(`a ${w}x${h} frame is over the ${MAX_CANVAS_PIXELS} pixel cap`)
      }
      parsedPixels += w * h
      if (parsedPixels > MAX_TOTAL_PIXELS) {
        throw new Error(`the frames total over ${MAX_TOTAL_PIXELS} pixels together`)
      }
      let palette = global
      if (packed & 0x80) {
        const n = 3 * (1 << ((packed & 0x07) + 1))
        if (pos + n > bytes.length) {
          throw new Error('the file ends inside a local colour table')
        }
        palette = bytes.subarray(pos, pos + n)
        pos += n
      }
      if (!palette) throw new Error('a frame has no colour table, local or global')
      if (pos >= bytes.length) {
        throw new Error('the file ends before the LZW minimum code size')
      }
      const minCodeSize = bytes[pos]
      pos += 1
      const { data, end } = subBlocks(bytes, pos, 'the image data')
      pos = end
      let indices = lzwDecode(minCodeSize, data, w * h)
      if (packed & 0x40) indices = deinterlace(indices, w, h)
      images.push({
        left,
        top,
        width: w,
        height: h,
        indices,
        palette,
        transparent: gce ? gce.transparent : -1,
        disposal: gce ? gce.disposal : 'leave',
        delayMs: gce ? gce.delayMs : 0,
      })
      gce = null
      continue
    }
    throw new Error(`unknown block introducer 0x${introducer.toString(16)} in the GIF`)
  }
  if (!sawTrailer) {
    throw new Error('the file ends without the GIF trailer, so it is truncated')
  }
  if (images.length === 0) {
    throw new Error('the GIF holds no image data, only headers and extensions')
  }

  // Real-world quirk: some encoders write a zero logical screen and mean "the size of
  // the frames". Browsers grow the canvas to cover them; so does this.
  if (screenW === 0 || screenH === 0) {
    for (const im of images) {
      screenW = Math.max(screenW, im.left + im.width)
      screenH = Math.max(screenH, im.top + im.height)
    }
  }
  if (screenW * screenH === 0) throw new Error('the logical screen is zero pixels')
  if (screenW * screenH > MAX_CANVAS_PIXELS) {
    throw new Error(
      `a ${screenW}x${screenH} logical screen is over the ${MAX_CANVAS_PIXELS} pixel cap`,
    )
  }
  if (images.length * screenW * screenH > MAX_TOTAL_PIXELS) {
    throw new Error(`the composited frames total over ${MAX_TOTAL_PIXELS} pixels together`)
  }
  return composite(screenW, screenH, images)
}

/**
 * Concatenate one length-prefixed sub-block chain and return where it ended. Every
 * data-bearing structure past the header uses this framing; the terminator is the
 * zero-length block, and a file that ends before it is truncated mid-structure.
 */
function subBlocks(
  bytes: Uint8Array,
  pos: number,
  what: string,
): { data: Uint8Array; end: number } {
  let p = pos
  let total = 0
  for (;;) {
    if (p >= bytes.length) throw new Error(`the file ends inside ${what}`)
    const len = bytes[p]
    p += 1
    if (len === 0) break
    if (p + len > bytes.length) throw new Error(`the file ends inside ${what}`)
    total += len
    p += len
  }
  const data = new Uint8Array(total)
  let q = pos
  let o = 0
  for (;;) {
    const len = bytes[q]
    q += 1
    if (len === 0) break
    data.set(bytes.subarray(q, q + len), o)
    o += len
    q += len
  }
  return { data, end: p }
}

const MAX_CODES = 4096

/**
 * Decode one frame's LZW stream into exactly `pixelCount` palette indices.
 *
 * The dictionary is three flat arrays (prefix link, last byte, first byte) rather than
 * strings; a sequence is emitted by walking prefix links onto a stack and reversing.
 * The walk terminates because an entry's prefix always has a smaller index. Decoding
 * stops the moment the output is full: the end-of-information code is optional in
 * practice and surplus data is structural (the sub-block chain), not meaningful.
 */
function lzwDecode(minCodeSize: number, data: Uint8Array, pixelCount: number): Uint8Array {
  if (minCodeSize < 2 || minCodeSize > 8) {
    throw new Error(`LZW minimum code size ${minCodeSize} is outside the 2 to 8 GIF allows`)
  }
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  const prefix = new Uint16Array(MAX_CODES)
  const suffix = new Uint8Array(MAX_CODES)
  const first = new Uint8Array(MAX_CODES)
  for (let i = 0; i < clear; i++) {
    suffix[i] = i
    first[i] = i
  }
  const out = new Uint8Array(pixelCount)
  const stack = new Uint8Array(MAX_CODES + 1)
  let outPos = 0
  let next = eoi + 1
  let width = minCodeSize + 1
  let acc = 0
  let accBits = 0
  let pos = 0
  let prev = -1
  while (outPos < pixelCount) {
    while (accBits < width) {
      if (pos >= data.length) {
        throw new Error(`the LZW data ran out ${pixelCount - outPos} pixels short`)
      }
      acc |= data[pos] << accBits
      pos += 1
      accBits += 8
    }
    const code = acc & ((1 << width) - 1)
    acc >>>= width
    accBits -= width
    if (code === clear) {
      next = eoi + 1
      width = minCodeSize + 1
      prev = -1
      continue
    }
    if (code === eoi) {
      throw new Error(`the LZW stream ended ${pixelCount - outPos} pixels short`)
    }
    const kwkwk = code === next
    if (code > next || (kwkwk && prev === -1)) {
      throw new Error(`LZW code ${code} names a dictionary entry that does not exist yet`)
    }
    let n = 0
    let c = kwkwk ? prev : code
    while (c >= clear) {
      stack[n] = suffix[c]
      n += 1
      c = prefix[c]
    }
    stack[n] = c
    n += 1
    const take = Math.min(n, pixelCount - outPos)
    for (let i = 0; i < take; i++) out[outPos + i] = stack[n - 1 - i]
    outPos += take
    if (kwkwk && outPos < pixelCount) {
      // The KwKwK sequence is prev's sequence plus its own first byte, which is `c`.
      out[outPos] = c
      outPos += 1
    }
    if (prev !== -1 && next < MAX_CODES) {
      prefix[next] = prev
      suffix[next] = kwkwk ? first[prev] : first[code]
      first[next] = first[prev]
      next += 1
      // Deferred clear lives in the two guards: at 4096 nothing is added above and the
      // width holds at 12 here, however long the encoder goes without a clear code.
      if (next === 1 << width && width < 12) width += 1
    }
    prev = code
  }
  return out
}

/** GIF's four row passes. Not PNG's Adam7: rows only, no column interlace. */
const INTERLACE_PASSES: ReadonlyArray<readonly [number, number]> = [
  [0, 8],
  [4, 8],
  [2, 4],
  [1, 2],
]

function deinterlace(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length)
  let from = 0
  for (const [start, step] of INTERLACE_PASSES) {
    for (let y = start; y < h; y += step) {
      out.set(src.subarray(from, from + w), y * w)
      from += w
    }
  }
  return out
}

/**
 * Paint every frame onto one running canvas, snapshotting a copy per frame, and apply
 * that frame's disposal before the next. Disposal is scoped to the frame's rectangle:
 * clearing more than the rectangle on disposal 2 is the smear bug in mirror image.
 */
function composite(w: number, h: number, images: ParsedImage[]): RgbaFrame[] {
  const frames: RgbaFrame[] = []
  const canvas = new Uint8Array(w * h * 4)
  for (const im of images) {
    const before = im.disposal === 'previous' ? canvas.slice() : null
    const y1 = Math.min(im.top + im.height, h)
    const x1 = Math.min(im.left + im.width, w)
    for (let y = im.top; y < y1; y++) {
      const srcRow = (y - im.top) * im.width
      for (let x = im.left; x < x1; x++) {
        const idx = im.indices[srcRow + (x - im.left)]
        if (idx === im.transparent) continue
        // An index past the table names a colour that does not exist; renderers
        // paint nothing, and painting black instead would invent data.
        if (idx * 3 + 2 >= im.palette.length) continue
        const o = (y * w + x) * 4
        canvas[o] = im.palette[idx * 3]
        canvas[o + 1] = im.palette[idx * 3 + 1]
        canvas[o + 2] = im.palette[idx * 3 + 2]
        canvas[o + 3] = 255
      }
    }
    frames.push({ width: w, height: h, data: canvas.slice(), delayMs: im.delayMs })
    if (im.disposal === 'background') {
      for (let y = im.top; y < y1; y++) {
        canvas.fill(0, (y * w + im.left) * 4, (y * w + x1) * 4)
      }
    } else if (before) {
      canvas.set(before)
    }
  }
  return frames
}
