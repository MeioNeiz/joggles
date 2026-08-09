#!/usr/bin/env bun
/**
 * Build a patched firmware image from stock, safely.
 *
 * The load-bearing idea is `expect`: every edit declares the bytes it believes are
 * currently at that address, and a mismatch aborts the build. A wrong address then
 * fails here, loudly, instead of on the device.
 *
 * This is not optional politeness. Most addresses in `research/` were read out of a
 * disassembly, and an off-by-one that lands on the wrong instruction still produces a
 * valid CRC, a bootable image, and no complaint from `ota.check`. `expect` is the only
 * layer that catches it. It has already caught one real off-by-one (`abs 0x216f0` is
 * the `blo`, not the `cmp r0, #0x15` at `abs 0x216ee`).
 *
 * Usage: write a script that imports `build` and describes its edits.
 *
 *   import { build, bytes, encode27 } from './research/tools/patch.ts'
 *   await build({
 *     out: '/tmp/patched.bin',
 *     edits: [
 *       { abs: 0x216ee, expect: bytes('15 28'), to: bytes('05 28'),
 *         note: 'button cycle 21 -> 5, short-press path' },
 *       { abs: 0x216b0, expect: bytes('15 28'), to: bytes('05 28'),
 *         note: 'the duplicate on the power-on path. BOTH must change' },
 *     ],
 *   })
 *
 * Then, always: bun run ota-check /tmp/patched.bin firmware/TR1906R04-10_OTA.bin
 *
 * `edits` never shift an address, which is what makes `expect` meaningful. New code
 * goes in `appends` instead: bytes placed at or after the end of the stock image, in
 * the free flash below the staging bank. An append cannot move anything that already
 * exists, so it keeps the same guarantee by construction.
 */
import * as ota from '../../packages/core/src/ota.js'

export const BASE = 0x16800
const STOCK = 'firmware/TR1906R04-10_OTA.bin'

const hx = (n: number) => '0x' + (n >>> 0).toString(16)
const show = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ')

/**
 * Parse "15 28 3f" into bytes.
 *
 * Throws rather than letting `parseInt` turn a typo into 0x00. In an `expect` that
 * only costs a confusing mismatch, but the same helper parses the crew key, where a
 * silent zero is a credential nobody recorded.
 */
export const bytes = (s: string) =>
  new Uint8Array(
    s.trim().split(/\s+/).map((x) => {
      if (!/^[0-9a-fA-F]{1,2}$/.test(x)) throw new Error(`not a hex byte: "${x}"`)
      return parseInt(x, 16)
    }),
  )

export interface Edit {
  /** Flash address, i.e. `abs`. Converted to a body offset internally. */
  abs: number
  /** Bytes currently expected there. A mismatch aborts the build. */
  expect: Uint8Array
  /** Replacement. Must be the same length: this tool never shifts addresses. */
  to: Uint8Array
  note: string
}

/**
 * 27 B/frame, 1 bit per pixel: 24 data bytes then 3 mask bytes.
 * `art` is 9 strings of up to 24 chars, row 8 first, space = off.
 * Inverse of the decoder at `abs 0x20be4` with r3 = 0.
 */
export function encode27(art: string[]): Uint8Array {
  if (art.length !== 9) throw new Error(`need 9 rows, got ${art.length}`)
  const on = (r: number, c: number) => (art[8 - r][c] ?? ' ') !== ' '
  const out = new Uint8Array(27)
  let mask = 0
  for (let c = 0; c < 24; c++) {
    let b = 0
    for (let r = 1; r <= 7; r++) if (on(r, c)) b |= 1 << (r - 1)
    if (on(8, c)) b |= 0x80
    out[c] = b
    if (on(0, c)) mask |= 1 << c
  }
  out[24] = mask & 0xff
  out[25] = (mask >> 8) & 0xff
  out[26] = (mask >> 16) & 0xff
  return out
}

/**
 * 72 B/frame, 2 bits per pixel: 24 columns of 3 bytes little-endian, row r at bit 2r.
 * `levels[row][col]` holds 0 to 3, row 0 bottom. Inverse of `abs 0x20be4` with r3 = 1.
 */
export function encode72(levels: number[][]): Uint8Array {
  const out = new Uint8Array(72)
  for (let c = 0; c < 24; c++) {
    let w = 0
    for (let r = 0; r < 9; r++) w |= ((levels[r]?.[c] ?? 0) & 3) << (2 * r)
    out[c * 3] = w & 0xff
    out[c * 3 + 1] = (w >> 8) & 0xff
    out[c * 3 + 2] = (w >> 16) & 0xff
  }
  return out
}

/**
 * Bytes that must be present but are not edited.
 *
 * A patch often depends on code somewhere else staying exactly as it is. The hook
 * in `ext.ts` is the example: its layout is dictated by a branch in the `LIGHT`
 * handler at `abs 0x184a6` that jumps into the middle of the block being replaced.
 * Nothing writes to `0x184a6`, so no `expect` covers it, and yet if that branch ever
 * differs the hook is wrong. Assertions make that dependency fail the build.
 */
export interface Assertion {
  abs: number
  expect: Uint8Array
  note: string
}

/** Bytes appended in free flash, past the end of the stock image. */
export interface Append {
  /** Flash address to place the block at. Must be at or after the stock image end. */
  abs: number
  data: Uint8Array
  note: string
}

export interface BuildOptions {
  out: string
  edits: Edit[]
  /** New code and data, placed past the end of the stock image. */
  appends?: Append[]
  /** Bytes the patch depends on but does not write. Checked against stock. */
  assertions?: Assertion[]
  stock?: string
  /** Skip the ota.check gate. There is no good reason; it exists for unit tests. */
  skipCheck?: boolean
  /** Where the running commentary goes. Tests silence it. */
  log?: (line: string) => void
}

/**
 * Largest body we will emit.
 *
 * The device's own bound is `0x19000`, and the real ceiling before staging overruns
 * the saved-content pages is `FLASH_APP_SIZE`, 76,800 bytes. `firmware-flashing.md`
 * prefers staying at the stock 66,084 where possible, and a build that appends
 * necessarily cannot, so it says how far past stock it went instead.
 */
const MAX_BODY = ota.FLASH_APP_SIZE

/** Apply the edits to stock and write a flashable container. Throws on any problem. */
export async function build(opts: BuildOptions): Promise<Uint8Array> {
  const log = opts.log ?? console.log
  const stockPath = opts.stock ?? STOCK
  const stockFile = new Uint8Array(await Bun.file(stockPath).arrayBuffer())
  const plain = ota.plaintext(stockFile)

  let failed = false
  for (const as of opts.assertions ?? []) {
    const off = as.abs - BASE
    const cur = plain.slice(off, off + as.expect.length)
    if (off < 0 || !cur.every((v, i) => v === as.expect[i])) {
      log(`FAIL ${hx(as.abs)}  assertion: ${as.note}`)
      log(`       expected ${show(as.expect)}`)
      log(`       found    ${show(cur)}`)
      failed = true
    } else {
      log(`ok   ${hx(as.abs)}  unchanged, as ${as.note} requires`)
    }
  }

  // Grow first, so an edit may legitimately target appended bytes.
  const appends = [...(opts.appends ?? [])].sort((a, b) => a.abs - b.abs)
  let grown = plain.length
  for (const ap of appends) {
    const off = ap.abs - BASE
    if (off < plain.length) {
      throw new Error(
        `append at ${hx(ap.abs)} lands inside the stock image, which ends at ` +
          `${hx(BASE + plain.length)}. Use an edit, so the old bytes are asserted`,
      )
    }
    grown = Math.max(grown, off + ap.data.length)
  }
  if (grown % 4 !== 0) grown += 4 - (grown % 4)
  if (grown > MAX_BODY) {
    throw new Error(`body would be ${grown} bytes, past the ${MAX_BODY} ceiling`)
  }

  const patched = new Uint8Array(grown)
  patched.set(plain)
  for (const ap of appends) {
    patched.set(ap.data, ap.abs - BASE)
    const end = hx(ap.abs + ap.data.length)
    log(`ok   ${hx(ap.abs)}..${end}  ${ap.data.length} B appended: ${ap.note}`)
  }

  for (const e of opts.edits) {
    const off = e.abs - BASE
    if (off < 0 || off + e.expect.length > patched.length) {
      log(`FAIL ${hx(e.abs)}  out of range`)
      failed = true
      continue
    }
    if (e.to.length !== e.expect.length) {
      log(`FAIL ${hx(e.abs)}  length ${e.expect.length} -> ${e.to.length}`)
      log('       this tool never shifts addresses; keep edits length-preserving')
      failed = true
      continue
    }
    const cur = patched.slice(off, off + e.expect.length)
    if (!cur.every((v, i) => v === e.expect[i])) {
      log(`FAIL ${hx(e.abs)}  ${e.note}`)
      log(`       expected ${show(e.expect)}`)
      log(`       found    ${show(cur)}`)
      failed = true
      continue
    }
    // The AES S-box sits immediately after the 16-byte key; a 17th byte breaks the
    // cipher in both directions and ota.check cannot see it.
    const body = e.abs - BASE
    if (body < ota.AES_SBOX_START && body + e.to.length > ota.AES_SBOX_START) {
      log(`FAIL ${hx(e.abs)}  edit runs past the AES key into the S-box`)
      failed = true
      continue
    }
    patched.set(e.to, off)
    log(`ok   ${hx(e.abs)}  ${e.note}`)
  }
  if (failed) throw new Error('refusing to emit: an edit did not match its expectation')

  const hdr = { appVer: 3, devVer: 10, proVer: 10, type: ota.OTA_APP }
  const container = ota.encode(patched, hdr)
  if (!opts.skipCheck) {
    const verdict = ota.check(container, { stock: stockFile })
    if (!verdict.safe) {
      log(ota.report(verdict))
      throw new Error('ota.check refused the built image')
    }
  }
  await Bun.write(opts.out, container)
  const crc = hx(ota.crc32(patched))
  const grewBy = patched.length - plain.length
  log(`\nwrote ${opts.out}: ${patched.length} body bytes, crc32 ${crc}`)
  log(`grew by ${grewBy} bytes; ${MAX_BODY - patched.length} left below the bank`)
  log(`now run: bun run ota-check ${opts.out} ${stockPath}`)
  return container
}
