#!/usr/bin/env bun
/**
 * Firmware analysis workbench for the decoded application image.
 *
 *   bun research/tools/fwtool.ts <cmd> [args]      (decode fw10.bin first, see below)
 *
 *   peek   <abs> <len> [w|b]   dump words or bytes at a flash address
 *   xref   <value>             find a 32-bit value as a literal, plus every LDR that
 *                              loads it and every movs/lsls pair that builds it
 *   callers <lo> [hi]          every BL/BLX-immediate whose target lands in a range
 *   modes                      resolve all 33 display modes through both dispatch
 *                              tables to their handler, bank, frame count and format
 *   render <abs> <frames> <27|72> [first] [count]   draw bank frames as ASCII
 *   regions                    audit PROTECTED_REGIONS against every FMC/REGLCTL site
 *
 * Prepare the input once:
 *   bun research/ota-codec.ts decode firmware/TR1906R04-10_OTA.bin /tmp/fw10.bin
 *   FW=/tmp/fw10.bin bun research/tools/fwtool.ts modes
 *
 * WHY THIS EXISTS. Two traps make ad-hoc greps unreliable on this image, and both
 * have already produced wrong entries in the research docs:
 *
 *  1. Animation bank data is 22.9% of the image and 129 of its words fall in the
 *     0x30000-0x40000 flash range by chance. A raw scan for a flash address invents
 *     references that are not there. `xref` reports LDR sites and shift-constructions
 *     separately from raw word hits for exactly this reason.
 *  2. Addresses are often computed, not stored. The button GPIO 0x500042a8 never
 *     appears as a literal; it is 0x50004280 + 0x28. An empty `xref` is not proof of
 *     absence, only of absence-as-a-literal.
 */
import { PROTECTED_REGIONS } from '../../packages/core/src/ota.js'

const BASE = 0x16800
/** Animation bank data, contiguous. Verified by summing the per-mode banks. */
export const BANK_LO = 0x22df8
export const BANK_HI = 0x265de + 11 * 72

const path = process.env.FW ?? '/tmp/fw10.bin'
if (!(await Bun.file(path).exists())) {
  console.error(`no decoded image at ${path}. Run:\n`)
  const decode = 'bun research/ota-codec.ts decode'
  console.error(`  ${decode} firmware/TR1906R04-10_OTA.bin /tmp/fw10.bin\n`)
  console.error('or set FW=<path> to a decoded (deobfuscated) application image.')
  process.exit(2)
}
const fw = new Uint8Array(await Bun.file(path).arrayBuffer())
const dv = new DataView(fw.buffer, fw.byteOffset)
const END = BASE + fw.length

const u8 = (a: number) => fw[a - BASE]
const u16 = (a: number) => dv.getUint16(a - BASE, true)
const u32 = (a: number) => dv.getUint32(a - BASE, true)
const hx = (n: number) => '0x' + (n >>> 0).toString(16)
const inBank = (a: number) => a >= BANK_LO && a < BANK_HI

/** Decode a 32-bit Thumb BL/BLX-immediate, returning its target. */
function blTarget(a: number): number | null {
  const hi = u16(a)
  const lo = u16(a + 2)
  if ((hi & 0xf800) !== 0xf000) return null
  if ((lo & 0xd000) !== 0xd000 && (lo & 0xd001) !== 0xc000) return null
  const s = (hi >> 10) & 1
  const i1 = 1 - (((lo >> 13) & 1) ^ s)
  const i2 = 1 - (((lo >> 11) & 1) ^ s)
  let off =
    (s << 24) | (i1 << 23) | (i2 << 22) | ((hi & 0x3ff) << 12) | ((lo & 0x7ff) << 1)
  if (s) off -= 1 << 25
  return a + 4 + off
}

/** Resolve an `ldr rN, [pc, #imm]` at `a` to its literal pool address. */
const poolOf = (a: number) => ((((a + 4) >> 2) << 2) as number) + (u16(a) & 0xff) * 4

const [cmd, ...rest] = Bun.argv.slice(2)

if (cmd === 'peek') {
  const addr = Number(rest[0])
  const len = Number(rest[1])
  const mode = rest[2] ?? 'w'
  if (mode === 'w') {
    for (let i = 0; i < len; i += 4) console.log(`${hx(addr + i)}  ${hx(u32(addr + i))}`)
  } else {
    for (let i = 0; i < len; i += 16) {
      const row = [...fw.slice(addr - BASE + i, addr - BASE + i + 16)]
      const cells = row.map((b) => b.toString(16).padStart(2, '0')).join(' ')
      console.log(`${hx(addr + i)}  ${cells}`)
    }
  }
} else if (cmd === 'xref') {
  const target = Number(rest[0])
  const words: number[] = []
  for (let a = BASE; a + 4 <= END; a += 4) if (u32(a) === target) words.push(a)
  const real = words.filter((a) => !inBank(a))
  const noise = words.filter(inBank)
  console.log(`${hx(target)} as a literal word: ${words.length} hit(s)`)
  console.log(`  outside bank data: ${real.length ? real.map(hx).join(', ') : 'NONE'}`)
  console.log(`  inside bank data (coincidence): ${noise.length}`)

  const pools = new Set(real)
  const loads: number[] = []
  for (let a = BASE; a + 2 <= END; a += 2) {
    if ((u16(a) & 0xf800) !== 0x4800) continue
    if (pools.has(poolOf(a))) loads.push(a)
  }
  console.log(`  LDR sites: ${loads.length ? loads.map(hx).join(', ') : 'none'}`)

  const built: string[] = []
  for (let a = BASE; a + 4 <= END; a += 2) {
    const h = u16(a)
    const l = u16(a + 2)
    if ((h & 0xf800) !== 0x2000 || (l & 0xf800) !== 0x0000) continue
    const rd = (h >> 8) & 7
    if ((l & 7) !== rd || ((l >> 3) & 7) !== rd) continue
    const sh = (l >> 6) & 0x1f
    if (sh && (((h & 0xff) << sh) >>> 0) === target) {
      built.push(`${hx(a)} movs r${rd}, #${hx(h & 0xff)}; lsls #${sh}`)
    }
  }
  const builtStr = built.length ? '\n    ' + built.join('\n    ') : 'none'
  console.log(`  built by shift: ${builtStr}`)
  if (!real.length && !built.length) {
    console.log('  NOTE: may still be computed as base+offset. See the header comment.')
  }
} else if (cmd === 'callers') {
  const lo = Number(rest[0])
  const hi = rest[1] ? Number(rest[1]) : lo + 2
  let n = 0
  for (let a = BASE; a + 4 <= END; a += 2) {
    const t = blTarget(a)
    if (t !== null && t >= lo && t < hi) {
      console.log(`  ${hx(a)} -> ${hx(t)}`)
      n++
    }
  }
  console.log(`${n} call site(s) into ${hx(lo)}..${hx(hi)}`)
} else if (cmd === 'modes') {
  const TICK_TBL = 0x2204a
  const SET_TBL = 0x21dea
  const target = (tbl: number, m: number) => tbl + 2 + 2 * u8(tbl + m)

  console.log('mode | ANIM | set_mode | tick | bank | frames | B/frame | bytes')
  console.log('--- | --- | --- | --- | --- | --- | --- | ---')
  let total = 0
  for (let m = 0; m < 33; m++) {
    const sm = target(SET_TBL, m)
    const tk = target(TICK_TBL, m)
    const fn = blTarget(tk)
    let bank: number | null = null
    let frames: number | null = null
    let fmt: number | null = null
    if (fn) {
      for (let a = fn; a < fn + 0x1c; a += 2) {
        const h = u16(a)
        if ((h & 0xf800) === 0x4800 && bank === null) {
          const p = poolOf(a)
          if (p >= BASE && p + 4 <= END) {
            const v = u32(p)
            if (v >= BASE && v < 0x29400) bank = v
          }
        }
        if ((h & 0xff00) === 0x2000 && frames === null) frames = h & 0xff
        if ((h & 0xff00) === 0x2300 && fmt === null) fmt = h & 0xff
      }
    }
    const stride = fmt === null ? null : fmt === 0 ? 27 : 72
    const bytes = stride && frames ? stride * frames : 0
    total += bytes
    console.log(
      [
        m,
        m >= 5 ? m - 5 : '-',
        hx(sm),
        hx(tk),
        bank ? hx(bank) : '-',
        frames ?? '-',
        stride ?? '-',
        bytes || '-',
      ].join(' | ')
    )
  }
  console.log(`\nbutton cycles modes 4..24 (index 0..20, +4, wrap at 21)`)
  console.log(`set_mode table reach ${hx(SET_TBL + 2)}..${hx(SET_TBL + 2 + 510)}`)
  console.log(`tick table reach     ${hx(TICK_TBL + 2)}..${hx(TICK_TBL + 2 + 510)}`)
  console.log(`bank bytes accounted for: ${total}`)
} else if (cmd === 'render') {
  const addr = Number(rest[0])
  const totalFrames = Number(rest[1])
  const stride = Number(rest[2])
  const first = Number(rest[3] ?? 0)
  const count = Math.min(Number(rest[4] ?? 3), totalFrames - first)
  const GLYPH = [' ', '.', '+', '#']
  for (let i = first; i < first + count; i++) {
    const o = addr - BASE + i * stride
    const b = fw.slice(o, o + stride)
    const px: number[][] = Array.from({ length: 9 }, () => new Array(24).fill(0))
    if (stride === 72) {
      for (let c = 0; c < 24; c++) {
        const w = b[c * 3] | (b[c * 3 + 1] << 8) | (b[c * 3 + 2] << 16)
        for (let r = 0; r < 9; r++) px[r][c] = (w >> (2 * r)) & 3
      }
    } else {
      const mask = b[24] | (b[25] << 8) | (b[26] << 16)
      for (let c = 0; c < 24; c++) {
        px[0][c] = (mask >> c) & 1 ? 3 : 0
        for (let r = 1; r <= 7; r++) px[r][c] = (b[c] >> (r - 1)) & 1 ? 3 : 0
        px[8][c] = (b[c] >> 7) & 1 ? 3 : 0
      }
    }
    console.log(`\n  frame ${i}/${totalFrames} @ ${hx(addr)} (${stride} B/frame)`)
    for (let r = 8; r >= 0; r--) {
      console.log('   |' + px[r].map((v) => GLYPH[v]).join('') + '|')
    }
  }
} else if (cmd === 'regions') {
  const FMC = 0x5000c000
  const REGLCTL = 0x50000100
  const pools = new Set<number>()
  for (let a = BASE; a + 4 <= END; a += 4) {
    const v = u32(a)
    if (v === FMC || v === REGLCTL) pools.add(a)
  }
  const covers = (body: number) =>
    PROTECTED_REGIONS.find((r) => body >= r.start && body < r.end)
  let uncovered = 0
  console.log('site | body | reg | protected by')
  for (let a = BASE; a + 2 <= END; a += 2) {
    if ((u16(a) & 0xf800) !== 0x4800) continue
    const p = poolOf(a)
    if (!pools.has(p)) continue
    const body = a - BASE
    const r = covers(body)
    if (!r) uncovered++
    console.log(
      `${hx(a)} | ${hx(body)} | ${u32(p) === FMC ? 'FMC' : 'REGLCTL'} | ` +
        (r ? r.name : '*** NOT PROTECTED ***')
    )
  }
  console.log(`\n${uncovered} site(s) outside every protected region`)
  console.log('Expected: 16. The rest are clock/power REGLCTL writes and the two DATS')
  console.log('saved-content writers, which cost content rather than recoverability.')
} else {
  console.log('usage: fwtool.ts <peek|xref|callers|modes|render|regions> ...')
  console.log('see the header comment for the decode step and the two scanning traps')
}
