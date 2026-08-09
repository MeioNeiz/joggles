/**
 * DATS/DATCP: upload content wider than the panel, for the device to animate.
 *
 * This is a separate path from the DIY column writes. DIY draws to a live
 * 24-column buffer; DATS stores an arbitrary-width bitmap that the `MODE`
 * commands then display and scroll, unattended, with nothing connected.
 *
 * Protocol per the vendor's TextAgreement.java, confirmed against an HCI
 * capture:
 *
 *     cmd  9600   [07]["DATS"][01][len_hi][len_lo]
 *     notify      "DATSOK"
 *     data 960a   [len][up to 15 payload bytes]   xN
 *     cmd  9600   [05]["DATCP"]
 *     notify      "DATCPOK" | "ERROR"
 *
 * Two payload encodings hang off the type byte, and only type 1 is unlike
 * anything else here. Type 2 is the live column format and is documented at
 * `encodeImage`.
 *
 * **Only type 1 writes flash.** The erase-and-write at `abs 0x218cc` has one call
 * site, on the type 1 `DATCP` path; type 2 stops in RAM at `0x200030ac` and is
 * displayed by mode 26, the same buffer and mode `SMVEW 02` uses. So a type 2
 * upload survives a disconnect and not a power cycle, and is destroyed by the next
 * `DATS` of either type (*verified* on hardware, `research/firmware-internals.md`).
 *
 * Type 1 is 16-bit little-endian per column, one bit per pixel, and it addresses
 * the panel's 9 rows, not 14:
 *
 *     bits 0-6   rows 1-7
 *     bit  7     row 8
 *     bit  15    row 0
 *     bits 8-14  nothing
 *
 * *Corrected.* This file used to read the format as 14 rows in a 7+7 split, with
 * bits 7 and 15 unused. The receive path byte-swaps each column at `abs 0x1864e`
 * and the frame builder at `abs 0x221c8` maps the high field's bit `r+7` to row
 * `r`; the 27-byte animation format arrives at the same halfword layout from an
 * unrelated code path and renders as legible glyphs. Under the old reading a
 * 9-row bitmap drew one row too high and silently dropped rows 7 and 8, which
 * never bit us only because our uploads were 5-row text.
 *
 * Still *derived*: two firmware paths agree, no hardware has confirmed it. The
 * settling test is one upload of a single column with only row 8 set.
 */
import { frame } from './protocol.js'

/** Rows the payload reaches. The panel's full height, not the format's width. */
export const DATS_ROWS = 9

/** Content type announced by `datsStart`. Two exist and the app sends only these. */
export const TYPE_TEXT = 1
export const TYPE_IMAGE = 2

/** Bit carrying panel row `r`. Row 0 is the bottom, as everywhere else here. */
function bitForRow(r: number): number {
  if (r === 0) return 15
  if (r === 8) return 7
  return r - 1
}

/**
 * Payload bytes carried per 16-byte block; byte 0 is the length prefix.
 *
 * **Keep this a multiple of 3.** The type 2 receive loop at `abs 0x18640` steps its
 * block offset by 3 and reloads the block length each pass, so it reads whole
 * columns only while every block's payload divides by 3. The handler accepts up to
 * 20 bytes, so raising this to speed an upload would leave type 1 correct and
 * mis-frame every type 2 column after the first block.
 */
export const CHUNK_PAYLOAD = 15

/** Announce an upload of `byteLength` bytes. Length is 16-bit big-endian. */
export function datsStart(byteLength: number, type = TYPE_TEXT): Uint8Array {
  if (byteLength < 0 || byteLength > 0xffff) {
    throw new Error(`payload length out of range: ${byteLength}`)
  }
  return frame('DATS', type, (byteLength >> 8) & 0xff, byteLength & 0xff)
}

/** Signal the end of an upload. */
export const datsComplete = (): Uint8Array => frame('DATCP')

/**
 * Pack a [row][col] bitmap into the DATS payload encoding.
 *
 * Row 0 is the BOTTOM row, matching the rest of this codebase. Rows here are
 * panel rows, so a caller rendering 5-row text must place it first: see
 * `font.panelBitmap`, or rows 0 and 1 land under the nose notch.
 */
export function encodeBitmap(bitmap: number[][]): Uint8Array {
  const rows = bitmap.length
  if (rows > DATS_ROWS) {
    throw new Error(`DATS holds ${DATS_ROWS} rows, got ${rows}`)
  }
  const cols = bitmap[0]?.length ?? 0
  const out = new Uint8Array(cols * 2)
  for (let c = 0; c < cols; c++) {
    let word = 0
    for (let r = 0; r < rows; r++) {
      if (bitmap[r][c]) word |= 1 << bitForRow(r)
    }
    out[c * 2] = word & 0xff
    out[c * 2 + 1] = (word >> 8) & 0xff
  }
  return out
}

/** Decode a DATS payload back to a [row][col] bitmap. Used by the log decoder. */
export function decodeBitmap(payload: Uint8Array): number[][] {
  const cols = Math.floor(payload.length / 2)
  const out = Array.from({ length: DATS_ROWS }, () => new Array(cols).fill(0))
  for (let c = 0; c < cols; c++) {
    const word = payload[c * 2] | (payload[c * 2 + 1] << 8)
    for (let r = 0; r < DATS_ROWS; r++) {
      out[r][c] = (word >> bitForRow(r)) & 1
    }
  }
  return out
}

/**
 * Type 2, the DIY image: 3 bytes per column, two bits per pixel, greyscale intact.
 *
 * **This is the live column encoding without its `[04][index]` header**, so a
 * drawing saves in the same layout it was shown in and `Grid.columnWord` is the
 * one place the bit order is decided. The equivalence is not an assumption; four
 * code paths state it, two in the vendor app and two in the firmware:
 *
 *     DiyAgreement.getDiyBytes0924   type 2 payload    same canvas, same ladders
 *     LedView.getRealTime            live 960b frame   ditto, after [04][index]
 *     abs 0x18616                    type 2 receive    (b0<<16)|(b1<<8)|b2 -> word
 *     abs 0x20694                    live receive      the same three instructions
 *
 * Per column the vendor emits
 *
 *     byte 0   the top row's two bits, in bits 0-1
 *     byte 1   four rows, two bits each, the higher row in the higher bits
 *     byte 2   the remaining four rows, same order
 *
 * Reassembled big-endian that puts panel row `r` at bit `2r` of a 24-bit word,
 * which is exactly what `display.Grid` builds for the live channel. The panel sees
 * the same bytes either way too: the flag `DATCP` passes to the frame builder at
 * `abs 0x221c8` selects a 3-bytes-per-word loop identical to the live renderer at
 * `abs 0x222c4`. *derived* from app source and disassembly; the levels themselves
 * are *verified* on hardware.
 *
 * The vendor allocates a fixed `byte[72]` and so only ever sends 24 columns. Wider
 * works: 383 columns is the ceiling (`content.MAX_IMAGE_COLUMNS`), *verified* on
 * hardware, with the levels checked by eye off the panel rather than only against
 * `decodeImage`.
 */
export const IMAGE_COLUMN_BYTES = 3

/** What the vendor sends, always: 24 columns of 3 bytes. */
export const IMAGE_BYTES = 72

export function encodeImage(bitmap: number[][]): Uint8Array {
  const rows = bitmap.length
  if (rows > DATS_ROWS) {
    throw new Error(`DATS holds ${DATS_ROWS} rows, got ${rows}`)
  }
  const cols = bitmap[0]?.length ?? 0
  const out = new Uint8Array(cols * IMAGE_COLUMN_BYTES)
  for (let c = 0; c < cols; c++) {
    let word = 0
    for (let r = 0; r < rows; r++) {
      word |= (bitmap[r][c] & 0b11) << (2 * r)
    }
    out[c * 3] = (word >> 16) & 0xff
    out[c * 3 + 1] = (word >> 8) & 0xff
    out[c * 3 + 2] = word & 0xff
  }
  return out
}

/** Decode a type 2 payload back to a [row][col] bitmap of levels 0-3. */
export function decodeImage(payload: Uint8Array): number[][] {
  const cols = Math.floor(payload.length / IMAGE_COLUMN_BYTES)
  const out = Array.from({ length: DATS_ROWS }, () => new Array(cols).fill(0))
  for (let c = 0; c < cols; c++) {
    const word =
      (payload[c * 3] << 16) | (payload[c * 3 + 1] << 8) | payload[c * 3 + 2]
    for (let r = 0; r < DATS_ROWS; r++) out[r][c] = (word >> (2 * r)) & 0b11
  }
  return out
}

/**
 * Split a payload into wire blocks, each `[length][up to 15 bytes]`.
 *
 * The length prefix is per-chunk, not cumulative. Reassembling without
 * stripping it shifts the bitmap and yields plausible-looking garbage.
 */
export function chunkPayload(payload: Uint8Array): Uint8Array[] {
  const blocks: Uint8Array[] = []
  for (let off = 0; off < payload.length; off += CHUNK_PAYLOAD) {
    const slice = payload.subarray(off, off + CHUNK_PAYLOAD)
    const block = new Uint8Array(16)
    block[0] = slice.length
    block.set(slice, 1)
    blocks.push(block)
  }
  return blocks
}

const ascii = (b: Uint8Array) => String.fromCharCode(...b)

/** Classify a decrypted notify frame during an upload. */
export function parseReply(plain: Uint8Array): 'DATSOK' | 'DATCPOK' | 'ERROR' | null {
  const text = ascii(plain.subarray(1, 9))
  if (text.startsWith('DATSOK')) return 'DATSOK'
  if (text.startsWith('DATCPOK')) return 'DATCPOK'
  if (text.startsWith('ERROR')) return 'ERROR'
  return null
}
