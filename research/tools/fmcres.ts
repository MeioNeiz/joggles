#!/usr/bin/env bun
/**
 * Resolve the FMC register block by content, in whatever application image it is given.
 *
 *   bun research/tools/fmcres.ts <image-or-dump.bin> [flashBase]
 *
 * A 262,144-byte file is treated as a full flash dump and the application window
 * `0x16800`-`0x293ff` is sliced out of it; anything else is taken as an image already
 * linked at `flashBase` (default `0x16800`).
 *
 * ## Why this exists
 *
 * `notes/patch-over-bt.md`, "Open, in the order it matters", carried this: *the FMC
 * primitive addresses on the donor build have not been resolved. `notify`, the AES key
 * and the advert name resolve by content today; the ISP helpers do not.* Our own
 * extension does not call the vendor's ISP helpers, so their addresses do not matter;
 * what matters is that the **register base, the five register offsets and the control
 * bits** our code writes are justified against the map the vendor's own code witnesses,
 * on the image a real unit runs, rather than against constants copied out of the APK
 * build. `research/tools/updater.ts` hardcodes `FMC_BASE`, `FMC_WRPROT` and `FMC_OFF`
 * and cites an APK-only address as their provenance; this module is what checks them.
 *
 * ## What it resolves, and the idiom each one rests on
 *
 * Nothing here matches an address. Every answer comes from an instruction idiom, so the
 * same code answers on the APK container and on a donor dump and is free to give
 * different addresses for each without either being a failure.
 *
 * | Answer | Idiom |
 * | --- | --- |
 * | `ISPTRG` offset, and the register base | `ldr rP,[rB,#T]; lsls rP,rP,#31; bne` back. The unbounded poll every NuMicro flash driver ever written spins in, and the only three-instruction shape in the image that names a peripheral register and loops on its bit 0 |
 * | `ISPCMD` offset, and the opcode set | a `str` of an immediate from the manual's closed opcode set, inside a sequence that ends in that poll |
 * | `ISPADR`, `ISPDAT` | the remaining stores to the base register in that sequence, in program order. A `0x21` program writes both, a `0x22` erase writes only the address |
 * | `ISPCON` offset, and every control bit | read-modify-write idioms on the base register: `orrs` with an immediate sets a bit, `lsrs #1; lsls #1` clears bit 0, `lsls rW,rY,#25` tests bit 6 |
 * | `SYS_REGLCTL` base | three adjacent stores of `0x59`, `0x16`, `0x88` to offset 0 of one register, which the reference manual requires to be adjacent |
 * | whether the unlock is retried | `ldr; cmp #0; beq` back to the first of the three, the vendor's `do`/`while` |
 *
 * ## The two scanning traps, honoured
 *
 * `research/tools/fwtool.ts`'s header names both and both have already put wrong entries
 * in the docs. Neither can bite here, and the reasons are worth stating rather than
 * assumed:
 *
 *  1. **A raw word scan invents references.** Animation bank data is 22.9% of the image
 *     and its words land in peripheral space by chance. Nothing below scans for a word.
 *     A literal only counts when an `ldr rN,[pc,#imm]` resolves to it, and it only
 *     becomes the FMC base when a poll idiom uses the register that load wrote.
 *  2. **Addresses are often computed, not stored.** `computed` reports every
 *     `lsls rW,rB,#n` taken off the base register, which is how both builds construct
 *     the `0x00300000` config aperture out of `0x5000c000 << 6`. So a base that is only
 *     ever shifted into something else is visible instead of silent.
 */
import { Asm } from './thumb.js'

/** Peripheral space, the only range a register base is looked for in. */
export const PERIPHERAL_LO = 0x40000000
export const PERIPHERAL_HI = 0x60000000

/** Application region, and the default link base of an image. */
export const IMAGE_BASE = 0x16800
/** OTA staging bank: the top of the window a dump is sliced to. */
export const STAGING_BANK = 0x29400
export const DUMP_BYTES = 0x40000

/**
 * The closed ISP opcode set, transcribed in `PN102Series.h` from the reference manual,
 * which then says "the other commands are invalid".
 *
 * `0x23` whole-chip erase is in the vendor SDK's `fmc.h` and is deliberately included
 * here so that a build which *does* contain it is reported rather than passed over.
 * `0x26` is not on the list at all: it is OpenOCD's own undocumented guess and appears
 * in no Nuvoton or Panchip table (`research/fmc-erase-program.md`, finding 1).
 */
export const ISPCMD_VALID = new Set([
  0x00, 0x04, 0x0b, 0x0c, 0x0d, 0x21, 0x22, 0x23, 0x2d, 0x2e,
])

/** The three key writes, which the manual requires to be adjacent. */
export const REGLCTL_KEY = [0x59, 0x16, 0x88] as const

export type RegName = 'ISPCON' | 'ISPADR' | 'ISPDAT' | 'ISPCMD' | 'ISPTRG'

export type Severity = 'fatal' | 'warn' | 'info'
export interface Note {
  severity: Severity
  text: string
}

export interface Store {
  addr: number
  off: number
  reg: number
  /** The immediate the stored register was last known to hold, or null if unknown. */
  imm: number | null
}

/** One vendor ISP primitive, found by its poll rather than by its address. */
export interface IspSite {
  /** The `ldr rB,[pc,#imm]` that put the register base in a register. */
  load: number
  /** The `ldr rP,[rB,#ISPTRG]` the poll spins on. */
  poll: number
  base: number
  /** ISPTRG offset, witnessed by the poll itself. */
  trigger: number
  /** The `str` of an opcode immediate, and the opcode. */
  cmd: { addr: number; off: number; opcode: number } | null
  /** Every store to the base register between the load and the poll, in order. */
  stores: Store[]
  /** Offsets read off the base register after the poll: a result being collected. */
  reads: { addr: number; off: number }[]
}

/** A control-register bit the image is witnessed setting, clearing or testing. */
export interface ConBit {
  addr: number
  off: number
  mask: number
  op: 'set' | 'clear' | 'test'
}

export interface UnlockSite {
  /** The first of the three adjacent key stores. */
  first: number
  base: number | null
  load: number | null
  /** `ldr; cmp #0; beq` back to the first store: the vendor's do/while. */
  retries: boolean
  /** Address of a store of zero to the same register, re-locking. */
  relock: number | null
}

export interface Computed {
  addr: number
  shift: number
  value: number
}

export interface FmcResolution {
  base: number | null
  wrprot: number | null
  offsets: Record<RegName, number | null>
  /** Every ISPCMD immediate the image is witnessed writing, ascending. */
  opcodes: number[]
  conBits: ConBit[]
  isp: IspSite[]
  unlocks: UnlockSite[]
  computed: Computed[]
  notes: Note[]
}

const sext8 = (v: number) => (v & 0x80 ? v - 0x100 : v)
export const hx = (n: number) => '0x' + (n >>> 0).toString(16)

/**
 * Slice a 256 KB dump down to the application window, and pass anything else through.
 *
 * A dump is the whole array and its low half is the BLE stack, which holds no ISP code
 * and would only add candidate literals. The window is also what `swdflash` can write
 * and what an image is linked for, so one base serves both inputs.
 */
export function windowOf(file: Uint8Array): { image: Uint8Array; base: number } {
  if (file.length === DUMP_BYTES) {
    return { image: file.slice(IMAGE_BASE, STAGING_BANK), base: IMAGE_BASE }
  }
  return { image: file, base: IMAGE_BASE }
}

const CALLER_SAVED = [0, 1, 2, 3]

interface Decoded {
  /** Registers this instruction writes. */
  dests: number[]
  /** The immediate it puts there, when it is a `movs rD,#imm`. */
  imm: number | null
  /** Whether it is a 32-bit encoding, so the walk skips four bytes. */
  wide: boolean
}

/** Which registers an instruction writes, and whether it writes a known constant. */
function writes(h: number): Decoded {
  const one = (r: number, imm: number | null = null) => ({ dests: [r], imm, wide: false })
  if ((h & 0xf800) === 0x2000) return one((h >> 8) & 7, h & 0xff) // movs imm
  if ((h & 0xf800) === 0xf000) return { dests: CALLER_SAVED, imm: null, wide: true } // bl
  // blx
  if ((h & 0xff80) === 0x4780) return { dests: CALLER_SAVED, imm: null, wide: false }
  if ((h & 0xfe00) === 0xbc00) {
    const regs: number[] = []
    for (let r = 0; r < 8; r++) if (h & (1 << r)) regs.push(r)
    return { dests: regs, imm: null, wide: false } // pop
  }
  if ((h & 0xf800) === 0xc800) {
    const regs: number[] = []
    for (let r = 0; r < 8; r++) if (h & (1 << r)) regs.push(r)
    return { dests: regs, imm: null, wide: false } // ldm
  }
  if ((h & 0xf800) === 0x4800) return one((h >> 8) & 7) // ldr pc-rel
  if ((h & 0xf800) === 0x6800) return one(h & 7) // ldr [rN,#imm]
  if ((h & 0xf800) === 0x8800) return one(h & 7) // ldrh
  if ((h & 0xf800) === 0x7800) return one(h & 7) // ldrb
  if ((h & 0xfe00) === 0x5800) return one(h & 7) // ldr [rN,rM]
  if ((h & 0xf800) === 0x9800) return one((h >> 8) & 7) // ldr [sp,#imm]
  if ((h & 0xf800) === 0x0000) return one(h & 7) // lsls
  if ((h & 0xf800) === 0x0800) return one(h & 7) // lsrs
  if ((h & 0xf800) === 0x1000) return one(h & 7) // asrs
  if ((h & 0xf800) === 0x1800) return one(h & 7) // adds reg
  if ((h & 0xf800) === 0x1a00) return one(h & 7) // subs reg
  if ((h & 0xf800) === 0x3000) return one((h >> 8) & 7) // adds imm
  if ((h & 0xf800) === 0x3800) return one((h >> 8) & 7) // subs imm
  if ((h & 0xfc00) === 0x4000) return one(h & 7) // data processing
  if ((h & 0xff00) === 0x4600) return one((h & 7) | ((h >> 4) & 8)) // mov
  if ((h & 0xf800) === 0xa000) return one((h >> 8) & 7) // adr
  if ((h & 0xf800) === 0xa800) return one((h >> 8) & 7) // add rd,sp,#imm
  return { dests: [], imm: null, wide: false }
}

/**
 * Walk `[from, to)` tracking which registers hold which immediate.
 *
 * Coarse on purpose: any instruction that writes a register clears what is known about
 * it, so an unknown is reported as `null` rather than guessed. Every idiom below is a
 * handful of instructions long, so nothing needs dataflow. A call clears the
 * caller-saved registers, which is what keeps a constant from surviving a `bl` it
 * cannot have survived.
 */
function trackImmediates(u16: (a: number) => number, from: number, to: number) {
  const known: (number | null)[] = [null, null, null, null, null, null, null, null]
  const at = new Map<number, (number | null)[]>()
  for (let a = from; a < to; a += 2) {
    at.set(a, known.slice())
    const { dests, imm, wide } = writes(u16(a))
    for (const d of dests) if (d < 8) known[d] = imm
    if (wide) {
      a += 2
      at.set(a, known.slice())
    }
  }
  return at
}

export function resolveFmc(image: Uint8Array, flashBase = IMAGE_BASE): FmcResolution {
  const dv = new DataView(image.buffer, image.byteOffset, image.byteLength)
  const end = flashBase + image.length
  const ok = (a: number, n: number) => a >= flashBase && a + n <= end
  const u16 = (a: number) => (ok(a, 2) ? dv.getUint16(a - flashBase, true) : 0)
  const u32 = (a: number) => (ok(a, 4) ? dv.getUint32(a - flashBase, true) : 0)
  const poolOf = (a: number) => (((a + 4) >> 2) << 2) + (u16(a) & 0xff) * 4

  const notes: Note[] = []

  // --- every pc-relative load of a peripheral address ------------------------------
  //
  // Trap 1: this is a scan for LDR sites, never for words. A literal that no LDR
  // resolves to is bank data or a coincidence and is never a candidate.
  const loads: { addr: number; reg: number; value: number }[] = []
  for (let a = flashBase; a + 2 <= end; a += 2) {
    const h = u16(a)
    if ((h & 0xf800) !== 0x4800) continue
    const p = poolOf(a)
    if (p + 4 > end) continue
    const v = u32(p)
    if (v < PERIPHERAL_LO || v >= PERIPHERAL_HI) continue
    loads.push({ addr: a, reg: (h >> 8) & 7, value: v })
  }

  /** The nearest preceding load into `reg`, within `back` halfwords. */
  const baseFor = (a: number, reg: number, back = 96) => {
    let best: { addr: number; value: number } | null = null
    for (const l of loads) {
      if (l.reg !== reg) continue
      if (l.addr >= a || l.addr < a - back * 2) continue
      if (!best || l.addr > best.addr) best = { addr: l.addr, value: l.value }
    }
    return best
  }

  // --- the poll, which is what finds the block ------------------------------------
  //
  // One primitive can hold several sequences off a single base load, which the vendor's
  // config reader does four times over. Each poll therefore owns only the stores after
  // the previous poll, so a later sequence does not inherit the earlier one's registers.
  type Poll = { addr: number; reg: number; off: number; load: number; base: number }
  const polls: Poll[] = []
  for (let a = flashBase; a + 6 <= end; a += 2) {
    const h = u16(a)
    if ((h & 0xf800) !== 0x6800) continue
    const rt = h & 7
    const rn = (h >> 3) & 7
    const off = ((h >> 6) & 0x1f) * 4
    const shift = u16(a + 2)
    if ((shift & 0xf800) !== 0x0000) continue
    if (((shift >> 6) & 0x1f) !== 31) continue
    if ((shift & 7) !== rt || ((shift >> 3) & 7) !== rt) continue
    const br = u16(a + 4)
    if ((br & 0xff00) !== 0xd100) continue // bne
    if (a + 8 + sext8(br & 0xff) * 2 !== a) continue
    const b = baseFor(a, rn)
    if (!b) continue
    polls.push({ addr: a, reg: rn, off, load: b.addr, base: b.value })
  }

  const isp: IspSite[] = []
  for (let i = 0; i < polls.length; i++) {
    const p = polls[i]
    const prev = i > 0 ? polls[i - 1].addr + 6 : flashBase
    const from = Math.max(p.load + 2, prev)
    const imms = trackImmediates(u16, Math.min(p.load, from), p.addr + 48)
    const stores: Store[] = []
    let cmd: IspSite['cmd'] = null
    for (let b = from; b < p.addr; b += 2) {
      const s = u16(b)
      if ((s & 0xf800) !== 0x6000) continue
      if (((s >> 3) & 7) !== p.reg) continue
      const reg = s & 7
      const imm = imms.get(b)?.[reg] ?? null
      const o = ((s >> 6) & 0x1f) * 4
      stores.push({ addr: b, off: o, reg, imm })
      if (cmd === null && imm !== null && ISPCMD_VALID.has(imm) && o !== p.off) {
        cmd = { addr: b, off: o, opcode: imm }
      }
    }
    const reads: { addr: number; off: number }[] = []
    for (let b = p.addr + 6; b < p.addr + 6 + 16; b += 2) {
      const r = u16(b)
      if ((r & 0xf800) !== 0x6800) break
      if (((r >> 3) & 7) !== p.reg) break
      const o = ((r >> 6) & 0x1f) * 4
      if (o === p.off) break // still polling
      reads.push({ addr: b, off: o })
    }
    const { load, base: b, off: trigger } = p
    isp.push({ load, poll: p.addr, base: b, trigger, cmd, stores, reads })
  }

  // --- which base, and is it the only one ----------------------------------------
  const perBase = new Map<number, IspSite[]>()
  for (const s of isp) perBase.set(s.base, [...(perBase.get(s.base) ?? []), s])
  const ranked = [...perBase.entries()].sort((x, y) => y[1].length - x[1].length)
  let base: number | null = null
  if (ranked.length === 0) {
    notes.push({
      severity: 'fatal',
      text:
        'no ISP poll idiom anywhere in the image, so no register base is resolved. ' +
        'An image with no flash writer in it is the benign reading; the other is that ' +
        'this is not an application image at all',
    })
  } else if (ranked.length > 1 && ranked[0][1].length === ranked[1][1].length) {
    notes.push({
      severity: 'fatal',
      text:
        `two peripheral bases carry the same number of ISP polls, ${hx(ranked[0][0])} ` +
        `and ${hx(ranked[1][0])}. Refusing rather than picking one`,
    })
  } else {
    base = ranked[0][0]
    if (ranked.length > 1) {
      const others = ranked.slice(1).map(([b, s]) => `${hx(b)} (${s.length})`)
      notes.push({
        severity: 'warn',
        text: `other peripheral bases carry a poll-shaped loop: ${others.join(', ')}`,
      })
    }
  }

  const mine = base === null ? [] : (perBase.get(base) ?? [])

  // --- the offsets, each from the sequences that witness it -----------------------
  const offsets: Record<RegName, number | null> = {
    ISPCON: null,
    ISPADR: null,
    ISPDAT: null,
    ISPCMD: null,
    ISPTRG: null,
  }
  const tally = (xs: number[]) => {
    const c = new Map<number, number>()
    for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1)
    return [...c.entries()].sort((a, b) => b[1] - a[1])
  }
  const pick = (name: RegName, xs: number[], why: string) => {
    if (xs.length === 0) return
    const t = tally(xs)
    offsets[name] = t[0][0]
    if (t.length > 1) {
      notes.push({
        severity: 'fatal',
        text:
          `${name} resolves to more than one offset from ${why}: ` +
          t.map(([o, n]) => `${hx(o)} x${n}`).join(', '),
      })
    }
  }

  // --- the control register first, because it is what tells the other stores apart --
  //
  // Resolved before `ISPADR`, and not for tidiness: the vendor's config writer sets
  // `CFGUEN` inside the same sequence it triggers an erase from, so a store to
  // `ISPCON` sits between the base load and the poll and would otherwise be counted as
  // the address store. `research/fmc-erase-program.md` finding 3 is the same register
  // seen from the other side.
  const conBits: ConBit[] = []
  const conOffs: number[] = []
  const shifts: { addr: number; shift: number; reg: number; base: number }[] = []
  if (base !== null) {
    for (const l of loads) {
      if (l.value !== base) continue
      const rB = l.reg
      const span = 24 * 2
      const imms = trackImmediates(u16, l.addr, l.addr + 2 + span)
      for (let a = l.addr + 2; a < l.addr + 2 + span && a + 8 <= end; a += 2) {
        const h = u16(a)
        // `lsls rW, rB, #n`: the base register shifted into an address. Trap 2. Only
        // counted below once something stores the result into `ISPADR`.
        if ((h & 0xf800) === 0x0000 && ((h >> 3) & 7) === rB && ((h >> 6) & 0x1f) !== 0) {
          const sh = (h >> 6) & 0x1f
          if ((h & 7) !== rB) shifts.push({ addr: a, shift: sh, reg: h & 7, base })
          continue
        }
        if ((h & 0xf800) !== 0x6800) continue // ldr rY,[rB,#K]
        if (((h >> 3) & 7) !== rB) continue
        const rY = h & 7
        const off = ((h >> 6) & 0x1f) * 4
        const orrsAt = (x: number, w: number) =>
          (u16(x) & 0xffc0) === 0x4300 && (u16(x) & 7) === w
        const strBack = (x: number, w: number) =>
          (u16(x) & 0xf800) === 0x6000 &&
          (u16(x) & 7) === w &&
          ((u16(x) >> 3) & 7) === rB &&
          ((u16(x) >> 6) & 0x1f) * 4 === off
        // set: movs rZ,#m either side of `orrs rY,rZ`, then the store back
        for (const [oa, sa] of [
          [a + 2, a + 4],
          [a + 4, a + 6],
        ]) {
          if (!orrsAt(oa, rY) || !strBack(sa, rY)) continue
          const rZ = (u16(oa) >> 3) & 7
          const m = imms.get(oa)?.[rZ] ?? null
          if (m !== null) conBits.push({ addr: a, off, mask: m, op: 'set' })
          conOffs.push(off)
        }
        // clear bit 0: lsrs rY,rY,#1 ; lsls rY,rY,#1 ; str rY,[rB,#K]
        const isShift = (v: number, opc: number) =>
          (v & 0xf800) === opc &&
          (v & 7) === rY &&
          ((v >> 3) & 7) === rY &&
          ((v >> 6) & 0x1f) === 1
        const clears = isShift(u16(a + 2), 0x0800) && isShift(u16(a + 4), 0x0000)
        if (clears && strBack(a + 6, rY)) {
          conBits.push({ addr: a, off, mask: 1, op: 'clear' })
          conOffs.push(off)
        }
        // test bit 6: lsls rW, rY, #25, so ISPFF lands in the sign bit
        const t = u16(a + 2)
        const tests = (t & 0xf800) === 0x0000 && ((t >> 3) & 7) === rY
        if (tests && ((t >> 6) & 0x1f) === 25) {
          conBits.push({ addr: a, off, mask: 1 << 6, op: 'test' })
          conOffs.push(off)
        }
      }
    }
  }
  pick('ISPCON', conOffs, 'the read-modify-write idioms')

  pick('ISPTRG', mine.map((s) => s.trigger), 'the poll')
  pick(
    'ISPCMD',
    mine.flatMap((s) => (s.cmd ? [s.cmd.off] : [])),
    'the opcode stores',
  )

  // ISPADR and ISPDAT are the stores that are none of the three already named, in
  // program order. A `0x21` program writes both, so the pair is ordered by a sequence
  // that has two of them rather than by a rule about which offset is lower.
  const adrs: number[] = []
  const dats: number[] = []
  for (const s of mine) {
    // A sequence whose opcode could not be established is not evidence about which
    // offset the address goes in. Two of the vendor's config reader's four sequences
    // reuse a register the tracker loses across a `pop` on a path not taken, and
    // counting them would have made ISPADR ambiguous rather than merely unwitnessed.
    if (s.cmd === null) continue
    const rest = s.stores.filter(
      (x) =>
        x.off !== s.trigger &&
        x.off !== s.cmd?.off &&
        x.addr !== s.cmd?.addr &&
        x.off !== offsets.ISPCON,
    )
    const uniq: number[] = []
    for (const r of rest) if (!uniq.includes(r.off)) uniq.push(r.off)
    if (uniq.length >= 1) adrs.push(uniq[0])
    if (uniq.length >= 2) dats.push(uniq[1])
  }
  // A read primitive collects its result out of ISPDAT after the poll, which is a
  // second and independent witness for the same offset. A read of ISPCON there is the
  // ISPFF check instead, so it is excluded rather than counted.
  for (const s of mine) {
    for (const r of s.reads) if (r.off !== offsets.ISPCON) dats.push(r.off)
  }
  pick('ISPADR', adrs, 'the address store in each sequence')
  pick('ISPDAT', dats, 'the data store and the result read')

  // A shifted base only counts as a computed address once it is stored into `ISPADR`.
  // Without that condition the poll's own `lsls #31` and every literal-pool word that
  // happens to decode as a shift come back as findings, which is the noise fwtool's
  // first trap warns about wearing different clothes.
  const computed: Computed[] = []
  for (const sh of shifts) {
    if (offsets.ISPADR === null) break
    let used = false
    for (let a = sh.addr + 2; a < sh.addr + 2 + 12 && a + 2 <= end; a += 2) {
      const h = u16(a)
      if ((h & 0xf800) !== 0x6000) continue
      if ((h & 7) !== sh.reg) continue
      if (((h >> 6) & 0x1f) * 4 !== offsets.ISPADR) continue
      used = true
      break
    }
    if (!used) continue
    if (computed.some((c) => c.addr === sh.addr)) continue
    computed.push({ addr: sh.addr, shift: sh.shift, value: (sh.base << sh.shift) >>> 0 })
  }

  const opcodes = [...new Set(mine.flatMap((s) => (s.cmd ? [s.cmd.opcode] : [])))].sort(
    (a, b) => a - b,
  )

  // --- SYS_REGLCTL, from the three adjacent key writes ---------------------------
  const unlocks: UnlockSite[] = []
  for (let a = flashBase; a + 6 <= end; a += 2) {
    const s = [u16(a), u16(a + 2), u16(a + 4)]
    if (s.some((h) => (h & 0xf800) !== 0x6000)) continue
    if (s.some((h) => ((h >> 6) & 0x1f) !== 0)) continue
    const rn = (s[0] >> 3) & 7
    if (s.some((h) => ((h >> 3) & 7) !== rn)) continue
    const regs = s.map((h) => h & 7)
    const imms = trackImmediates(u16, a - 32, a + 2)
    const held = imms.get(a) ?? []
    if (regs.some((r, i) => held[r] !== REGLCTL_KEY[i])) continue
    const b = baseFor(a + 2, rn, 32)
    const retries =
      (u16(a + 6) & 0xf800) === 0x6800 &&
      ((u16(a + 6) >> 3) & 7) === rn &&
      ((u16(a + 6) >> 6) & 0x1f) === 0 &&
      (u16(a + 8) & 0xf800) === 0x2800 &&
      (u16(a + 8) & 0xff) === 0 &&
      ((u16(a + 8) >> 8) & 7) === (u16(a + 6) & 7) &&
      (u16(a + 10) & 0xff00) === 0xd000 &&
      a + 14 + sext8(u16(a + 10) & 0xff) * 2 === a
    let relock: number | null = null
    const after = trackImmediates(u16, a + 6, a + 6 + 160 * 2)
    for (let c = a + 6; c < a + 6 + 160 * 2 && c + 2 <= end; c += 2) {
      const h = u16(c)
      if ((h & 0xf800) !== 0x6000) continue
      if (((h >> 3) & 7) !== rn || ((h >> 6) & 0x1f) !== 0) continue
      if ((after.get(c)?.[h & 7] ?? null) !== 0) continue
      relock = c
      break
    }
    const base_ = b?.value ?? null
    unlocks.push({ first: a, base: base_, load: b?.addr ?? null, retries, relock })
  }

  const wrBases = tally(unlocks.flatMap((u) => (u.base === null ? [] : [u.base])))
  let wrprot: number | null = null
  if (wrBases.length === 0) {
    notes.push({
      severity: unlocks.length ? 'warn' : 'fatal',
      text:
        unlocks.length > 0
          ? `${unlocks.length} unlock sequence(s) found but none names a resolvable base`
          : 'no 0x59/0x16/0x88 unlock sequence anywhere, so SYS_REGLCTL is unresolved',
    })
  } else {
    wrprot = wrBases[0][0]
    if (wrBases.length > 1) {
      notes.push({
        severity: 'fatal',
        text:
          'the unlock sequences name more than one base: ' +
          wrBases.map(([b, n]) => `${hx(b)} x${n}`).join(', '),
      })
    }
  }

  if (base !== null && wrprot === base) {
    notes.push({
      severity: 'fatal',
      text: 'the FMC and the write-protect register resolved to the same address',
    })
  }
  for (const name of ['ISPCON', 'ISPADR', 'ISPDAT', 'ISPCMD', 'ISPTRG'] as RegName[]) {
    if (offsets[name] === null) {
      notes.push({ severity: 'fatal', text: `${name} was not witnessed by any idiom` })
    }
  }
  if (base !== null && computed.length > 0) {
    notes.push({
      severity: 'info',
      text:
        `the base register is shifted into an address at ${computed.length} site(s): ` +
        computed.map((c) => `${hx(c.addr)} <<${c.shift} = ${hx(c.value)}`).join(', ') +
        '. Reported because a computed address is invisible to a literal scan',
    })
  }

  return { base, wrprot, offsets, opcodes, conBits, isp, unlocks, computed, notes }
}

/** Named ISPCON bits, so a resolved mask reads as a name in the report. */
export const CON_BIT_NAMES: Record<number, string> = {
  0x01: 'ISPEN',
  0x02: 'BS',
  0x04: 'SPUEN',
  0x08: 'APUEN',
  0x10: 'CFGUEN',
  0x20: 'LDUEN',
  0x40: 'ISPFF',
}

/**
 * Check a set of hardcoded constants against what an image witnesses.
 *
 * This is the point of the module: `updater.ts` names a base, a lock register and five
 * offsets, and this says whether the image a unit actually runs agrees. A mismatch is
 * returned rather than thrown, because the two images are allowed to disagree about
 * addresses and only the register map has to hold on both.
 */
export function checkAgainst(
  r: FmcResolution,
  claim: {
    base: number
    wrprot: number
    offsets: Record<RegName, number>
    conMask?: number
    opcodes?: number[]
  },
): string[] {
  const bad: string[] = []
  if (r.base !== claim.base) {
    bad.push(`base: claims ${hx(claim.base)}, image says ${hx(r.base ?? 0)}`)
  }
  if (r.wrprot !== claim.wrprot) {
    bad.push(`wrprot: claims ${hx(claim.wrprot)}, image says ${hx(r.wrprot ?? 0)}`)
  }
  for (const [name, off] of Object.entries(claim.offsets) as [RegName, number][]) {
    if (r.offsets[name] !== off) {
      bad.push(`${name}: claims ${hx(off)}, image says ${hx(r.offsets[name] ?? -1)}`)
    }
  }
  if (claim.conMask !== undefined) {
    const witnessed = r.conBits.reduce((m, b) => m | b.mask, 0)
    const unwitnessed = claim.conMask & ~witnessed
    if (unwitnessed) {
      const names = Object.entries(CON_BIT_NAMES)
        .filter(([m]) => Number(m) & unwitnessed)
        .map(([, n]) => n)
      bad.push(`ISPCON bits nothing in the image touches: ${hx(unwitnessed)} (${names})`)
    }
  }
  for (const op of claim.opcodes ?? []) {
    if (!r.opcodes.includes(op)) bad.push(`opcode ${hx(op)} is not written anywhere`)
  }
  return bad
}

/**
 * Assemble one vendor-shaped ISP primitive, for tests and as executable documentation
 * of the idiom the resolver keys on.
 *
 * `regs` is deliberately a parameter rather than a constant: a test that permutes the
 * offsets and still gets them back is the proof that this resolves rather than assumes.
 */
export function fakePrimitive(opts: {
  org: number
  base: number
  wrprot?: number
  opcode: number
  regs?: Record<RegName, number>
  withData?: boolean
  retryUnlock?: boolean
  /** Store a shifted copy of the base register as the address, as the vendor does. */
  shiftAddr?: number
}): Uint8Array {
  const off = opts.regs ?? { ISPCON: 0, ISPADR: 4, ISPDAT: 8, ISPCMD: 12, ISPTRG: 16 }
  const a = new Asm(opts.org)
  if (opts.wrprot !== undefined) {
    a.ldrPool('r4', 'wrprot')
    a.movs('r0', 0x59)
    a.movs('r1', 0x16)
    a.movs('r2', 0x88)
    a.label('keys')
    a.str('r0', 'r4', 0)
    a.str('r1', 'r4', 0)
    a.str('r2', 'r4', 0)
    if (opts.retryUnlock) {
      a.ldr('r3', 'r4', 0)
      a.cmp('r3', 0)
      a.bcond('eq', 'keys')
    }
  }
  a.ldrPool('r1', 'fmc')
  a.ldr('r2', 'r1', off.ISPCON)
  a.movs('r3', 1)
  a.orrs('r2', 'r3')
  a.str('r2', 'r1', off.ISPCON)
  a.movs('r2', opts.opcode)
  a.str('r2', 'r1', off.ISPCMD)
  if (opts.shiftAddr !== undefined) {
    a.lsls('r5', 'r1', opts.shiftAddr)
    a.str('r5', 'r1', off.ISPADR)
  } else {
    a.str('r0', 'r1', off.ISPADR)
  }
  if (opts.withData) a.str('r5', 'r1', off.ISPDAT)
  a.movs('r0', 1)
  a.str('r0', 'r1', off.ISPTRG)
  a.label('wait')
  a.ldr('r0', 'r1', off.ISPTRG)
  a.lsls('r0', 'r0', 31)
  a.bcond('ne', 'wait')
  if (!opts.withData) {
    a.ldr('r0', 'r1', off.ISPDAT)
  }
  a.ldr('r0', 'r1', off.ISPCON)
  a.lsls('r2', 'r0', 25)
  if (opts.wrprot !== undefined) {
    a.movs('r0', 0)
    a.str('r0', 'r4', 0)
  }
  a.bx('lr')
  a.align(4)
  a.label('fmc').word(opts.base)
  if (opts.wrprot !== undefined) a.label('wrprot').word(opts.wrprot)
  return a.assemble()
}

if (import.meta.main) {
  const [file, baseArg] = Bun.argv.slice(2)
  if (!file) {
    console.error('usage: bun research/tools/fmcres.ts <image-or-dump.bin> [flashBase]')
    process.exit(2)
  }
  const raw = new Uint8Array(await Bun.file(file).arrayBuffer())
  const { image, base: linked } = windowOf(raw)
  const flashBase = baseArg ? Number(baseArg) : linked
  const r = resolveFmc(image, flashBase)

  console.log(`${file}: ${image.length} bytes linked at ${hx(flashBase)}`)
  console.log(`FMC base   ${r.base === null ? 'UNRESOLVED' : hx(r.base)}`)
  console.log(`SYS_REGLCTL ${r.wrprot === null ? 'UNRESOLVED' : hx(r.wrprot)}`)
  console.log('\nregister | offset | witnessed by')
  console.log('--- | --- | ---')
  const witness: Record<RegName, string> = {
    ISPCON: 'read-modify-write idioms',
    ISPADR: 'the address store',
    ISPDAT: 'the data store and the result read',
    ISPCMD: 'the opcode store',
    ISPTRG: 'the poll',
  }
  for (const n of ['ISPCON', 'ISPADR', 'ISPDAT', 'ISPCMD', 'ISPTRG'] as RegName[]) {
    const off = r.offsets[n]
    console.log(`${n} | ${off === null ? '-' : hx(off)} | ${witness[n]}`)
  }

  console.log(`\nISP opcodes written: ${r.opcodes.map(hx).join(', ') || 'none'}`)
  console.log('\nISPCON bits the image touches')
  console.log('op | mask | name | site')
  console.log('--- | --- | --- | ---')
  const seen = new Set<string>()
  for (const b of r.conBits) {
    const k = `${b.op}:${b.mask}`
    if (seen.has(k)) continue
    seen.add(k)
    const nm = CON_BIT_NAMES[b.mask] ?? '?'
    console.log(`${b.op} | ${hx(b.mask)} | ${nm} | ${hx(b.addr)}`)
  }

  console.log(`\n${r.isp.length} ISP primitive site(s)`)
  console.log('poll | base load | opcode | stores')
  console.log('--- | --- | --- | ---')
  for (const s of r.isp) {
    const st = s.stores.map((x) => hx(x.off)).join(' ')
    const op = s.cmd ? hx(s.cmd.opcode) : '-'
    console.log(`${hx(s.poll)} | ${hx(s.load)} | ${op} | ${st}`)
  }

  console.log(`\n${r.unlocks.length} REGLCTL unlock site(s)`)
  console.log('keys at | base | retries | relock at')
  console.log('--- | --- | --- | ---')
  for (const u of r.unlocks) {
    const b = u.base === null ? '-' : hx(u.base)
    const rl = u.relock === null ? '-' : hx(u.relock)
    console.log(`${hx(u.first)} | ${b} | ${u.retries} | ${rl}`)
  }

  if (r.notes.length) {
    console.log('\nnotes')
    for (const n of r.notes) console.log(`  [${n.severity}] ${n.text}`)
  }
  process.exit(r.notes.some((n) => n.severity === 'fatal') ? 1 : 0)
}
