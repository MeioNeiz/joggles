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
 *   regions                    resolve the flash-critical regions **by content** in
 *                              this image, audit every FMC/REGLCTL site against them,
 *                              and print PROTECTED_REGIONS beside them for comparison
 *
 * Prepare the input once:
 *   bun research/ota-codec.ts decode firmware/TR1906R04-10_OTA.bin /tmp/fw10.bin
 *   FW=/tmp/fw10.bin bun research/tools/fwtool.ts modes
 *
 * `FW` may equally be a real unit's application window, sliced out of an SWD dump at
 * `abs 0x16800`, and `regions` is written so that it must be: see its own section.
 *
 * WHY THIS EXISTS. Three traps make ad-hoc greps unreliable on this image, and all
 * three have already produced wrong entries in the research docs:
 *
 *  1. Animation bank data is 22.9% of the image and 129 of its words fall in the
 *     0x30000-0x40000 flash range by chance. A raw scan for a flash address invents
 *     references that are not there. `xref` reports LDR sites and shift-constructions
 *     separately from raw word hits for exactly this reason.
 *  2. Addresses are often computed, not stored. The button GPIO 0x500042a8 never
 *     appears as a literal; it is 0x50004280 + 0x28. An empty `xref` is not proof of
 *     absence, only of absence-as-a-literal.
 *  3. **An address read off one build names the wrong code in another.** No pair here
 *     runs the APK's application (`research/variant-mismatch-2026-08-19.md`), and on
 *     the donor build every span in `PROTECTED_REGIONS` lands somewhere it was not
 *     meant to: the driver grew a function, its tail moved 0x110, and the entry named
 *     for it now ends 0x4a bytes before that build's word programmer. `regions` used
 *     to assert a site count read off the APK, which is the same mistake wearing a
 *     gate's clothes.
 *     `research/protected-regions-2026-08-20.md`.
 */
import {
  FLASH_PAGE_SIZE,
  PAD_SEED,
  PROTECTED_REGIONS,
  SECTION_APP_FLAG,
  SECTION_SOFTDEVICE_FLAG,
} from '../../packages/core/src/ota.js'
import * as ext from './ext.js'

/** Where the application window starts in flash. Every `body` offset is `abs - BASE`. */
export const BASE = 0x16800

/** Animation bank data, contiguous. Verified by summing the per-mode banks. */
export const BANK_LO = 0x22df8
export const BANK_HI = 0x265de + 11 * 72

export const hx = (n: number) => '0x' + (n >>> 0).toString(16)

/** Decoding one image, so the pure half of this file is not bound to a global. */
export interface Reader {
  image: Uint8Array
  base: number
  end: number
  u8: (a: number) => number
  u16: (a: number) => number
  u32: (a: number) => number
  /** Literal-pool address an `ldr rN, [pc, #imm]` at `a` names. */
  poolOf: (a: number) => number
  /** Target of a 32-bit Thumb BL/BLX-immediate at `a`, or null. */
  blTarget: (a: number) => number | null
}

export function reader(image: Uint8Array, base = BASE): Reader {
  const dv = new DataView(image.buffer, image.byteOffset, image.byteLength)
  const u16 = (a: number) => dv.getUint16(a - base, true)
  const blTarget = (a: number): number | null => {
    if (a - base + 4 > image.length) return null
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
  return {
    image,
    base,
    end: base + image.length,
    u8: (a: number) => image[a - base],
    u16,
    u32: (a: number) => dv.getUint32(a - base, true),
    poolOf: (a: number) => ((((a + 4) >> 2) << 2) as number) + (u16(a) & 0xff) * 4,
    blTarget,
  }
}

// --- Where the flash-critical code is, in whichever image this is -------------------
//
// `PROTECTED_REGIONS` is a list of body offsets read off the APK build's disassembly.
// It is right about that build and about nothing else. No pair here runs the APK's
// application, so on a donor window every span in it names code it was not written for,
// and the audit below resolves the same seven regions **by content** instead, the way
// `ext.findHookSite` resolves the hook. The static list is then printed beside the
// resolved one as a second opinion, and a disagreement between them is reported and
// never a failure: two builds are allowed to lay their code out differently.
//
// Two mechanisms do all the resolving, and which one fits depends on the shape of the
// code:
//
//  - **the cluster.** The flash driver is a run of leaf functions, each with its own
//    literal pool, so no single pool spans it. What does span it is the run of
//    FMC-base loads: they sit at most 0x76 bytes apart inside the driver on both
//    builds, and the nearest unrelated load is 0x326 away, so a 0x100 gap separates
//    them with room either side.
//  - **the pool block.** The OTA handler and the handoff are each one function reading
//    one literal pool, and the pool is both the tighter bound and the surer one: it is
//    found from a value the code must load rather than from a byte pattern the
//    compiler chose.

/** FMC base. Its `ISPCON` and `ISPTRG` are the two registers `REGLCTL` locks. */
export const FMC_BASE = 0x5000c000

/** SYS_REGLCTL. `thumbsim.ts` calls the same address `WRPROT`: one register, two
 *  names. */
export const REGLCTL_BASE = 0x50000100

/** FMC register offsets from `FMC_BASE`. */
export const FMC_REGS: Record<number, string> = {
  0x00: 'ISPCON',
  0x04: 'ISPADR',
  0x08: 'ISPDAT',
  0x0c: 'ISPCMD',
  0x10: 'ISPTRG',
}

/**
 * The complete `ISPCMD` set this FMC has, and which opcodes change what is in flash.
 *
 * *verified* from the vendor's own `PN102Series.h` and `fmc.h`, transcribed in
 * `research/fmc-erase-program.md` section 7.1, which also records where the wrong
 * number came from: `0x26` is OpenOCD's undocumented guess and is not a command at all
 * on this part. `swdflash.ts` exports the three it can emit and `fwtool.test.ts` holds
 * this table to them, so the two cannot drift.
 *
 * Anything not in here sets `ISPFF` and does nothing, so an image that writes one is an
 * image doing something neither we nor the vendor's header can account for, which is
 * why `regions` reports it rather than ignoring it.
 */
export const ISPCMD: Record<number, { name: string; writes: boolean }> = {
  0x00: { name: 'read word', writes: false },
  0x04: { name: 'read unique ID', writes: false },
  0x0b: { name: 'read company ID', writes: false },
  0x0c: { name: 'read product ID', writes: false },
  0x0d: { name: 'read CRC32 result', writes: false },
  0x21: { name: 'program word', writes: true },
  0x22: { name: 'page erase', writes: true },
  0x23: { name: 'whole-flash erase', writes: true },
  0x2d: { name: 'run CRC32', writes: false },
  0x2e: { name: 'vector remap', writes: false },
}

/** One `ldr rN, [pc, #imm]` that loads the FMC or REGLCTL base, and what it then does. */
export interface Site {
  at: number
  /** `at - base`, which is what `PROTECTED_REGIONS` speaks in. */
  body: number
  which: 'FMC' | 'REGLCTL'
  /** Register the base lands in. */
  reg: number
  /** `ISPCMD` immediates stored through that register before it is reloaded. */
  cmds: number[]
  /** Register offsets written through it, so a read-only site is visible as one. */
  wrote: number[]
  /** Last address touched through the base register, which bounds the access. */
  lastTouch: number
  /** True when one of `cmds` changes flash. */
  writesFlash: boolean
}

/**
 * Every FMC or REGLCTL base load in the image, with what it does through the register.
 *
 * The walk forward stops when the register is written again, so a site's `cmds` are its
 * own and not the next function's. `movs` immediates are tracked per register because
 * `ISPCMD` is always written from one: no store of a raw immediate exists in ARMv6-M.
 */
export function fmcSites(image: Uint8Array, base = BASE): Site[] {
  const r = reader(image, base)
  const pools = new Map<number, 'FMC' | 'REGLCTL'>()
  for (let a = base; a + 4 <= r.end; a += 4) {
    const v = r.u32(a)
    if (v === FMC_BASE) pools.set(a, 'FMC')
    else if (v === REGLCTL_BASE) pools.set(a, 'REGLCTL')
  }
  const out: Site[] = []
  for (let a = base; a + 2 <= r.end; a += 2) {
    if ((r.u16(a) & 0xf800) !== 0x4800) continue
    const which = pools.get(r.poolOf(a))
    if (!which) continue
    const reg = (r.u16(a) >> 8) & 7
    const cmds: number[] = []
    const wrote: number[] = []
    const imm = new Map<number, number>()
    let lastTouch = a + 2
    for (let q = a + 2; q + 2 <= r.end && q < a + 0x80; q += 2) {
      const h = r.u16(q)
      if ((h & 0xf800) === 0x2000) {
        const rd = (h >> 8) & 7
        imm.set(rd, h & 0xff)
        if (rd === reg) break
        continue
      }
      if ((h & 0xf800) === 0x4800 && ((h >> 8) & 7) === reg) break
      if ((h & 0xf800) === 0x6000) {
        const off = ((h >> 6) & 0x1f) * 4
        const rt = h & 7
        if (((h >> 3) & 7) === reg) {
          wrote.push(off)
          lastTouch = q + 2
          if (off === 0x0c && imm.has(rt)) cmds.push(imm.get(rt)!)
        }
        continue
      }
      if ((h & 0xf800) === 0x6800) {
        const rt = h & 7
        if (((h >> 3) & 7) === reg) lastTouch = q + 2
        if (rt === reg) break
        continue
      }
    }
    out.push({
      at: a,
      body: a - base,
      which,
      reg,
      cmds,
      wrote,
      lastTouch,
      writesFlash: cmds.some((c) => ISPCMD[c]?.writes),
    })
  }
  return out
}

/**
 * Largest gap between two FMC base loads that still counts as the same block.
 *
 * 0x100 rather than a traced function boundary because the boundary is not readable:
 * every function in the flash driver is a leaf, so there is no `push {..., lr}` to find
 * and the epilogues are bare `bx lr` that also occur inside literal pools. The measured
 * numbers on both builds in hand: 0x76 is the widest gap inside the driver and 0x326
 * the distance to the next unrelated load.
 */
export const CLUSTER_GAP = 0x100

export interface Cluster {
  sites: Site[]
  /** Body offsets. */
  start: number
  end: number
}

/** Group sites into blocks, nearest-neighbour, at `CLUSTER_GAP`. */
export function clusters(sites: Site[], gap = CLUSTER_GAP): Cluster[] {
  const out: Cluster[] = []
  for (const s of sites) {
    const last = out[out.length - 1]
    if (last && s.at - last.sites[last.sites.length - 1].at <= gap) last.sites.push(s)
    else out.push({ sites: [s], start: 0, end: 0 })
  }
  for (const c of out) {
    c.start = c.sites[0].body
    c.end = Math.max(...c.sites.map((s) => s.lastTouch - s.at + s.body))
  }
  return out
}

export interface PoolBlock {
  /** Body offset of the earliest `ldr` that reads any word of the pool. */
  start: number
  /** Body offset one past the last pool word anything reads. */
  end: number
  /** Body offsets of the pool's own first and last read words. */
  poolStart: number
  poolEnd: number
}

/**
 * The subroutine that reads a given literal-pool word, bounded by the pool it shares.
 *
 * A literal pool sits immediately after the code that reads it, and every word in it is
 * read from somewhere above. So the run of consecutive read words containing `word` is
 * the pool, and the earliest `ldr` into that run is where the function starts. Both ends
 * come out of the image rather than out of an offset anyone wrote down.
 *
 * Conservative in the right direction: it can only under-reach, never over-reach, since
 * an unread word breaks the run.
 */
export function poolBlock(
  image: Uint8Array,
  word: number,
  base = BASE,
): PoolBlock | null {
  const r = reader(image, base)
  const refs = new Map<number, number[]>()
  for (let a = base; a + 2 <= r.end; a += 2) {
    if ((r.u16(a) & 0xf800) !== 0x4800) continue
    const p = r.poolOf(a)
    if (p + 4 > r.end) continue
    const at = refs.get(p)
    if (at) at.push(a)
    else refs.set(p, [a])
  }
  if (!refs.has(word)) return null
  let lo = word
  let hi = word
  while (refs.has(lo - 4)) lo -= 4
  while (refs.has(hi + 4)) hi += 4
  let start = Infinity
  for (let p = lo; p <= hi; p += 4) {
    for (const s of refs.get(p)!) start = Math.min(start, s)
  }
  return {
    start: start - base,
    end: hi + 4 - base,
    poolStart: lo - base,
    poolEnd: hi + 4 - base,
  }
}

/** Every offset in `image` where `needle` appears, as body offsets. */
export function occurrences(image: Uint8Array, needle: Uint8Array): number[] {
  const out: number[] = []
  outer: for (let i = 0; i + needle.length <= image.length; i++) {
    for (let k = 0; k < needle.length; k++) if (image[i + k] !== needle[k]) continue outer
    out.push(i)
  }
  return out
}

// --- The seven regions, resolved by content ----------------------------------------

/**
 * Byte signatures, and the honest note that one of them is weaker than the others.
 *
 * Everything here except `descrambler` is a value the code has to load or a UUID the
 * radio has to advertise, so it survives a recompile. `descrambler` is 48 bytes of one
 * compiler's output and is in here only because nothing else distinguishes that routine:
 * it touches no FMC register, loads no OTA literal and sits in no table. It matches once
 * on each of the two builds in hand, which is evidence and not a guarantee, and it is
 * the first thing to fail on a third build.
 */
export const SIGNATURE = {
  /** The vendor's 128-bit service UUID, tail first. The byte before it indexes a row. */
  vendorUuid: new Uint8Array([
    0x96, 0x12, 0x16, 0x54, 0x92, 0x75, 0xb5, 0xa2, 0x45, 0xfd, 0xab, 0x39, 0xc4, 0x4b,
    0xd4,
  ]),
  /** `fd01`, the OTA control characteristic, as the GATT table holds it. */
  fd01: new Uint8Array([0x01, 0xfd]),
  /** `fd02`, the OTA data characteristic. Its row follows `fd01`'s. */
  fd02: new Uint8Array([0x02, 0xfd]),
  descrambler: new Uint8Array([
    0xf0, 0xb4, 0x00, 0x24, 0x00, 0x28, 0x27, 0xd0, 0x00, 0x29, 0x25, 0xd0,
    0x24, 0xd9, 0xa5, 0x00, 0x43, 0x59, 0x1f, 0x04, 0x1e, 0x02, 0x3f, 0x0e,
    0xbe, 0x19, 0x1f, 0x02, 0x36, 0x02, 0x3f, 0x0e, 0xbe, 0x19, 0x36, 0x02,
    0x1b, 0x0e, 0x9b, 0x19, 0x53, 0x40, 0x1f, 0x04, 0x1e, 0x02, 0x3f, 0x0e,
  ]),
} as const

/** GATT row stride, so `fd02` is looked for one row past `fd01` rather than anywhere. */
const GATT_ROW = 0x10

/**
 * `AIRCR = VECTKEY | SYSRESETREQ`, the word the handoff stores to `SCB + 0xc`.
 *
 * Not a signature on its own: it is a literal 20 to 22 times over in these images,
 * because everything that reboots the part loads it. What is unique is finding it in
 * the same literal pool as **both** section flags, which is the handoff's own pool.
 */
export const AIRCR_SYSRESET = 0x05fa0004

export type Severity = 'fatal' | 'warn'
export interface Note {
  severity: Severity
  message: string
}

/** One flash-critical region, resolved in the image handed in. Body offsets. */
export interface Region {
  /** Same name as the `PROTECTED_REGIONS` entry it corresponds to. */
  name: string
  start: number
  end: number
  /** The content that put it here, in one sentence, so a reader can re-check it. */
  anchor: string
  /** `ISPCMD` immediates issued inside. */
  cmds: number[]
  /** True when one of `cmds` changes flash. */
  writesFlash: boolean
  /** Body offsets of the FMC/REGLCTL base loads inside. */
  sites: number[]
}

export interface RegionResult {
  regions: Region[]
  /** Every FMC/REGLCTL base load in the image, resolved or not. */
  sites: Site[]
  /** Blocks of sites that are not one of the seven, with what they do. */
  other: { start: number; end: number; cmds: number[]; sites: number[] }[]
  notes: Note[]
}

/**
 * Resolve the seven flash-critical regions in whichever application image this is.
 *
 * Named after the `PROTECTED_REGIONS` entries so the two can be read side by side, but
 * every span comes out of the bytes. What each one is anchored on:
 *
 * | Region | Anchor |
 * | --- | --- |
 * | image head and startup stub | body 0, one flash page, the erase granularity |
 * | FMC flash driver | the cluster of FMC base loads that erases and programs |
 * | flash program primitive | the cluster with a `bl` to the driver's program entry |
 * | OTA handoff and reset | the pool holding both section flags and the AIRCR reset key |
 * | OTA handler | the pool holding the OTA pad seed |
 * | OTA payload descrambler | 48 bytes of the routine itself, the one weak signature |
 * | GATT table, including the fd00 OTA service | the UUID rows through `fd02`'s |
 *
 * A region that cannot be resolved is left out and a fatal note says why. That is the
 * whole contract: this never guesses, because a region placed by guess is worse than a
 * region reported missing.
 */
export function deriveRegions(image: Uint8Array, base = BASE): RegionResult {
  const r = reader(image, base)
  const notes: Note[] = []
  const fatal = (message: string) => notes.push({ severity: 'fatal', message })
  const warn = (message: string) => notes.push({ severity: 'warn', message })
  const sites = fmcSites(image, base)
  const blocks = clusters(sites)
  const regions: Region[] = []

  const fromCluster = (name: string, anchor: string, c: Cluster): Region => {
    const pools = c.sites.map((s) => r.poolOf(s.at) + 4 - base)
    return {
      name,
      anchor,
      start: c.start,
      end: Math.max(c.end, ...pools),
      cmds: [...new Set(c.sites.flatMap((s) => s.cmds))],
      writesFlash: c.sites.some((s) => s.writesFlash),
      sites: c.sites.map((s) => s.body),
    }
  }

  // The head. It does not move: it is where the image starts, and one flash page is
  // the least of it that can be lost, because a page is what an erase costs. Checked
  // rather than assumed, since a caller that hands this the whole 256 KB dump instead
  // of the application window would otherwise get seven regions off the BLE stack.
  const headWord = r.u32(base)
  const headVer = r.u32(base + 4)
  if (headWord < base || headWord >= ext.STAGING_BANK) {
    fatal(`the first word of this image is ${hx(headWord)}, which is not an address in ` +
      `the application region ${hx(base)}-${hx(ext.STAGING_BANK)}. A stock head holds ` +
      'its own end address there, so this is not an application image and nothing ' +
      'below can be trusted: check that FW is the window at abs 0x16800 and not a ' +
      'whole dump')
  } else {
    regions.push({
      name: 'image head and startup stub',
      anchor: `body 0, one flash page. First word ${hx(headWord)} is inside the ` +
        `application region and the build triple is ${hx(headVer)}`,
      start: 0,
      end: FLASH_PAGE_SIZE,
      cmds: [],
      writesFlash: false,
      sites: [],
    })
  }

  // The flash driver: the one block that can erase and program. Everything else in
  // the image reaches flash by calling into it, which is what makes "exactly one" a
  // claim worth checking rather than a coincidence of this build.
  const writers = blocks.filter((c) => c.sites.some((s) => s.writesFlash))
  let driver: Cluster | null = null
  if (writers.length === 0) {
    fatal('no block in this image issues ISPCMD 0x21 or 0x22, so nothing here can ' +
      'erase or program flash. Either this is not the application or the driver has ' +
      'been rewritten')
  } else if (writers.length > 1) {
    fatal(`${writers.length} separate blocks issue flash-modifying ISPCMD opcodes, at ` +
      writers.map((c) => hx(c.start)).join(', ') + '. On both builds in hand there is ' +
      'exactly one, and every other caller reaches flash through it. Two means either ' +
      'the driver has been split or something else has learned to write flash, and ' +
      'either way the region map wants a person')
  } else {
    driver = writers[0]
    regions.push(fromCluster(
      'FMC flash driver',
      'the one cluster of FMC base loads that issues page erase and word program',
      driver,
    ))
  }

  // The handoff: the pool that holds both section flags next to the reset key. Both
  // flags appear in a second pool as well, and the reset key appears twenty times over,
  // so it is the three together in one pool that names this one function.
  const flagPools: number[] = []
  for (let a = base; a + 12 <= r.end; a += 4) {
    const w = [r.u32(a), r.u32(a + 4), r.u32(a + 8)]
    if (!w.includes(SECTION_SOFTDEVICE_FLAG)) continue
    if (!w.includes(SECTION_APP_FLAG)) continue
    if (!w.includes(AIRCR_SYSRESET)) continue
    flagPools.push(a)
  }
  if (flagPools.length !== 1) {
    fatal(`${flagPools.length} literal pools hold both section flags ` +
      `(${hx(SECTION_SOFTDEVICE_FLAG)}, ${hx(SECTION_APP_FLAG)}) beside ` +
      `${hx(AIRCR_SYSRESET)}. Exactly one does on both builds in hand, and it is the ` +
      'boot-select flip: patch it and OTAs stage, pass CRC, write the record and never ' +
      'apply')
  } else {
    const pb = poolBlock(image, flagPools[0], base)
    if (!pb) {
      fatal(`the section-flag pool at ${hx(flagPools[0] - base)} is not read by any ` +
        'ldr in this image, which cannot be true of a live literal pool')
    } else {
      regions.push(withSites('OTA handoff and reset',
        `the literal pool at ${hx(pb.poolStart)} holding both section flags and ` +
          `${hx(AIRCR_SYSRESET)}`,
        pb, sites))
    }
  }

  // The OTA handler: the pool holding the obfuscation seed. One occurrence on both
  // builds, and it is the value the handler must load to descramble an incoming block.
  const seedAt: number[] = []
  for (let a = base; a + 4 <= r.end; a += 4) if (r.u32(a) === PAD_SEED) seedAt.push(a)
  if (seedAt.length !== 1) {
    fatal(`the OTA pad seed ${hx(PAD_SEED)} appears ${seedAt.length} times ` +
      `(${seedAt.map((a) => hx(a - base)).join(', ') || 'none'}). One identifies the ` +
      'handler; none or several does not')
  } else {
    const pb = poolBlock(image, seedAt[0], base)
    if (!pb) {
      fatal(`nothing loads the pad seed at ${hx(seedAt[0] - base)}, so the OTA handler ` +
        'cannot be resolved from it')
    } else {
      regions.push(withSites('OTA handler',
        `the literal pool at ${hx(pb.poolStart)} holding the OTA pad seed ` +
          `${hx(PAD_SEED)}`,
        pb, sites))
    }
  }

  // The program primitive: the OTA path's own page writer. Two blocks in this image
  // call the driver's word programmer, and the other one is the DATS saved-content
  // writer, which costs a saved drawing rather than a way back. What separates them is
  // that the OTA handler calls this one and nothing else, so it is resolved through the
  // handler above and not before it.
  //
  // Its start is the handler's own `bl` target, which is the function entry exactly:
  // the block's first FMC load is 0xe bytes further on on both builds, and taking the
  // call target instead of the load means no slack has to be invented.
  const handler = regions.find((x) => x.name === 'OTA handler') ?? null
  if (driver && handler) {
    const entries = driver.sites.filter(
      (s) => s.cmds.includes(0x21) && !s.cmds.includes(0x22),
    )
    if (entries.length !== 1) {
      fatal(`the flash driver has ${entries.length} entries that program without ` +
        'erasing, and the program primitive is resolved as whatever the OTA handler ' +
        `calls of them. Found: ${entries.map((s) => hx(s.body)).join(', ') || 'none'}`)
    } else {
      const entry = entries[0].at
      const callers: number[] = []
      for (let a = base; a + 4 <= r.end; a += 2) {
        if (r.blTarget(a) !== entry) continue
        const last = driver.sites[driver.sites.length - 1].at
        if (a >= driver.sites[0].at && a <= last) continue
        callers.push(a - base)
      }
      const candidates = blocks.filter(
        (c) => c !== driver && callers.some((a) => a >= c.start && a <= c.end),
      )
      const fromHandler: number[] = []
      for (let a = handler.start + base; a + 4 <= handler.end + base; a += 2) {
        const t = r.blTarget(a)
        if (t !== null && t >= base && t < r.end) fromHandler.push(t - base)
      }
      const picked = candidates.filter((c) => {
        const floor = Math.max(0, ...blocks.filter((d) => d.end <= c.start)
          .map((d) => d.end))
        return fromHandler.some((t) => t <= c.start && t > floor)
      })
      if (picked.length !== 1) {
        warn(`the word programmer at ${hx(entries[0].body)} is called from ` +
          `${candidates.length} block(s) and ${picked.length} of them are reached from ` +
          'the OTA handler, so "flash program primitive" did not resolve. It is the ' +
          'block that writes the staged pages, and breaking it leaves OTAs that stage, ' +
          'pass CRC, write the record and never apply, so this is worth a look')
      } else {
        const c = picked[0]
        const floor = Math.max(0, ...blocks.filter((d) => d.end <= c.start)
          .map((d) => d.end))
        const start = Math.min(...fromHandler.filter((t) => t <= c.start && t > floor))
        const region = fromCluster('flash program primitive',
          `the block calling the driver's program-only entry at ` +
            `${hx(entries[0].body)}, entered at ${hx(start)} from the OTA handler`,
          c)
        regions.push({ ...region, start })
      }
    }
  }

  // The descrambler, by its own bytes. The weak one; see SIGNATURE.
  const desc = occurrences(image, SIGNATURE.descrambler)
  if (desc.length !== 1) {
    fatal(`the descrambler signature matches ${desc.length} times ` +
      `(${desc.map(hx).join(', ') || 'none'}). It is 48 bytes of compiler output, not ` +
      'than a value the code must load, so it is the signature in here most likely to ' +
      'stop working, and this is what that looks like: re-derive the routine by hand')
  } else {
    regions.push({
      name: 'OTA payload descrambler',
      anchor: `48 bytes of the routine itself at ${hx(desc[0])}, the one byte signature`,
      start: desc[0],
      end: desc[0] + SIGNATURE.descrambler.length,
      cmds: [],
      writesFlash: false,
      sites: [],
    })
  }

  // The GATT table. From the first vendor 128-bit UUID row to the end of the fd02
  // row, both found by the UUIDs the radio advertises rather than by an offset.
  const uuids = occurrences(image, SIGNATURE.vendorUuid)
  const fd01 = occurrences(image, SIGNATURE.fd01).filter(
    (a) => image[a + GATT_ROW] === SIGNATURE.fd02[0] &&
      image[a + GATT_ROW + 1] === SIGNATURE.fd02[1],
  )
  if (fd01.length !== 1 || uuids.length === 0) {
    fatal(`the GATT table did not resolve: ${uuids.length} vendor UUID row(s) and ` +
      `${fd01.length} fd01 row(s) with an fd02 row one stride on. The fd00 service is ` +
      'the only way an image already on a unit can be replaced without a probe, so ' +
      'this one is worth stopping for')
  } else if (uuids[0] - 1 >= fd01[0]) {
    fatal(`the first vendor UUID row is at ${hx(uuids[0] - 1)}, after the fd01 row at ` +
      `${hx(fd01[0])}, so the table is not laid out the way both builds in hand lay it ` +
      'out and its extent cannot be read off these two anchors')
  } else {
    regions.push({
      name: 'GATT table, including the fd00 OTA service',
      anchor: `the first of ${uuids.length} vendor UUID rows at ${hx(uuids[0] - 1)} ` +
        `through the end of the fd02 row that follows fd01 at ${hx(fd01[0])}`,
      start: uuids[0] - 1,
      end: fd01[0] + 2 * GATT_ROW,
      cmds: [],
      writesFlash: false,
      sites: [],
    })
  }

  // A block is "other" only when no resolved region already accounts for it, which
  // catches both the two resolved from clusters and the two resolved from pools.
  const other = blocks
    .filter((c) => !regions.some((rg) => c.start >= rg.start && c.end <= rg.end))
    .map((c) => ({
      start: c.start,
      end: c.end,
      cmds: [...new Set(c.sites.flatMap((s) => s.cmds))],
      sites: c.sites.map((s) => s.body),
    }))
  regions.sort((a, b) => a.start - b.start)
  return { regions, sites, other, notes }
}

/** A pool-bounded region, plus whichever FMC sites happen to fall inside it. */
function withSites(name: string, anchor: string, pb: PoolBlock, sites: Site[]): Region {
  const inside = sites.filter((s) => s.body >= pb.start && s.body < pb.end)
  return {
    name,
    anchor,
    start: pb.start,
    end: pb.end,
    cmds: [...new Set(inside.flatMap((s) => s.cmds))],
    writesFlash: inside.some((s) => s.writesFlash),
    sites: inside.map((s) => s.body),
  }
}

// --- The gate ----------------------------------------------------------------------

/** One span this repo's own build writes into an image. Body offsets. */
export interface PatchSpan {
  name: string
  start: number
  end: number
}

/**
 * Everything a `bun run build-firmware` on this image would write, resolved in it.
 *
 * Asked of `ext.ts` rather than restated, so the gate cannot drift from the patcher: if
 * a future feature writes somewhere new, `resolveLayout` is where it appears and this
 * check picks it up for free.
 *
 * The extension span runs from wherever the block lands to the staging bank rather than
 * to the block's own length, because an overlap test does not need the length and the
 * length changes every time a sub-command is added. `intoFill` is set because this is
 * asking where the block *would* go, which is not the same act as consenting to put it
 * in a zero fill: that consent is `build-firmware --into-fill` and stays there.
 */
export function ourWrites(image: Uint8Array, base = BASE): {
  spans: PatchSpan[]
  notes: Note[]
} {
  const notes: Note[] = []
  const spans: PatchSpan[] = []
  const resolved = ext.resolveLayout(image, { base })
  if (!resolved.layout) {
    for (const n of resolved.notes) if (n.severity === 'fatal') notes.push(n)
    return { spans, notes }
  }
  const l = resolved.layout
  spans.push({
    name: 'dispatcher hook',
    start: l.site.callAt - base,
    end: l.site.callAt - base + ext.HOOK_LEN,
  })
  if (l.aesKey !== null) {
    const at = l.aesKey - base
    spans.push({ name: 'crew AES key', start: at, end: at + 16 })
  }
  if (l.advertName !== null) {
    spans.push({
      name: 'advert name',
      start: l.advertName - base,
      end: l.advertName - base + ext.SIGNATURE.advertName.length,
    })
  }
  const place = ext.placeExtension({ window: image, base, size: 1024, intoFill: true })
  if (place.place) {
    spans.push({
      name: 'JGX1 extension',
      start: place.place.addr - base,
      end: ext.STAGING_BANK - base,
    })
  } else {
    notes.push({
      severity: 'warn',
      message: 'the extension has nowhere to go in this image, so its span is not in ' +
        'the overlap check: ' +
        place.notes.filter((n) => n.severity === 'fatal').map((n) => n.message)
          .join('; '),
    })
  }
  return { spans, notes }
}

/**
 * One question the audit asks, and three answers rather than two.
 *
 * `n/a` exists because of unit 1's pre-repair dump. Its window carries the tail of a
 * longer build above a shorter one, so `ext.resolveLayout` refuses it outright and
 * there are no patch spans to check against anything. Reporting that as a failure is
 * the cry-wolf this whole rewrite is about: it is not a hazard, it is an image no build
 * can be based on, and it says so.
 */
export interface Check {
  name: string
  state: 'ok' | 'fail' | 'n/a'
  detail: string
}

/** How one `PROTECTED_REGIONS` entry reads against the region it names in this image. */
export interface StaticRow {
  name: string
  start: number
  end: number
  resolved: Region | null
  /** `same`, `shifted`, `partial` or `missed`, plus the numbers behind it. */
  verdict: string
  /** Flash-modifying sites inside the resolved region that the static span misses. */
  missedWriters: number[]
}

export interface Audit {
  regions: Region[]
  sites: Site[]
  other: { start: number; end: number; cmds: number[]; sites: number[] }[]
  writes: PatchSpan[]
  checks: Check[]
  staticMap: StaticRow[]
  notes: Note[]
  ok: boolean
}

/**
 * Resolve the regions, then ask the three questions that are true of any build.
 *
 * **What this does not do is compare a count.** It used to print "Expected: 16", which
 * is the number of FMC/REGLCTL sites the APK's layout leaves outside its own region
 * list; the donor's answer is 39 and neither number says anything about safety. A gate
 * that asserts one build's arithmetic is a gate that fails on the build that matters
 * and gets skipped, which had already happened once elsewhere
 * (`research/swdflash-review-2026-08-20.md`).
 *
 * The three that hold on both builds, and would hold on a third:
 *
 *  - **one-flash-writer.** Every ISPCMD that changes flash is issued from inside one
 *    block, and every other caller reaches flash by calling into it. Split that block
 *    and the map is no longer a map.
 *  - **known-opcodes.** Every ISPCMD immediate anywhere in the image is one the
 *    vendor's own header lists. A new one is a flash operation nothing here accounts for.
 *  - **patch-clear.** Nothing this repo's build writes lands in a resolved region. This
 *    is the live hazard the other two are scaffolding for.
 *
 * `PROTECTED_REGIONS` is reported beside the resolved regions and **never fails the
 * audit**, because two builds laying their code out differently is not a defect.
 */
export function auditRegions(image: Uint8Array, base = BASE): Audit {
  const derived = deriveRegions(image, base)
  const { regions, sites, other } = derived
  const notes = [...derived.notes]
  const writes = ourWrites(image, base)
  notes.push(...writes.notes)
  const checks: Check[] = []
  type Span = { start: number; end: number }
  const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end

  checks.push({
    name: 'regions-resolved',
    state: derived.notes.some((n) => n.severity === 'fatal') ? 'fail' : 'ok',
    detail: `${regions.length} of ${PROTECTED_REGIONS.length} resolved by content` +
      (derived.notes.some((n) => n.severity === 'fatal')
        ? ', and the notes say why not'
        : ''),
  })

  const driver = regions.find((r) => r.name === 'FMC flash driver') ?? null
  const flashWriters = sites.filter((s) => s.writesFlash)
  const strays = driver
    ? flashWriters.filter((s) => s.body < driver.start || s.body >= driver.end)
    : flashWriters
  checks.push({
    name: 'one-flash-writer',
    state: driver !== null && strays.length === 0 ? 'ok' : 'fail',
    detail: driver
      ? `${flashWriters.length} site(s) issue an opcode that changes flash, ` +
        `${flashWriters.length - strays.length} inside the driver at ` +
        `${hx(driver.start)}-` +
        `${hx(driver.end)}` +
        (strays.length ? `; OUTSIDE IT: ${strays.map((s) => hx(s.body)).join(', ')}` : '')
      : 'no flash driver resolved, so every flash-modifying site is unaccounted for',
  })

  const unknown = sites.flatMap((s) =>
    s.cmds.filter((c) => !(c in ISPCMD)).map((c) => ({ at: s.body, cmd: c })))
  checks.push({
    name: 'known-opcodes',
    state: unknown.length === 0 ? 'ok' : 'fail',
    detail: unknown.length === 0
      ? `every ISPCMD immediate written is in the vendor's own set`
      : unknown.map((u) => `${hx(u.cmd)} at ${hx(u.at)}`).join(', '),
  })

  const collisions: string[] = []
  for (const w of writes.spans) {
    for (const rg of regions) {
      if (overlaps(w, rg)) {
        collisions.push(`${w.name} ${hx(w.start)}-${hx(w.end)} in ${rg.name}`)
      }
    }
  }
  checks.push({
    name: 'patch-clear',
    state: writes.spans.length === 0 ? 'n/a' : collisions.length === 0 ? 'ok' : 'fail',
    detail: writes.spans.length === 0
      ? 'no build can be based on this image, so there is nothing to clear: ' +
        (writes.notes.map((n) => n.message).join('; ') || 'resolveLayout said nothing')
      : collisions.length === 0
        ? `${writes.spans.length} span(s) this build writes, none in a resolved region`
        : collisions.join('; '),
  })

  const clashes: string[] = []
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      if (overlaps(regions[i], regions[j])) {
        clashes.push(`${regions[i].name} and ${regions[j].name}`)
      }
    }
  }
  checks.push({
    name: 'regions-disjoint',
    state: clashes.length === 0 ? 'ok' : 'fail',
    detail: clashes.length === 0 ? 'no two resolved regions overlap' : clashes.join('; '),
  })

  const staticMap: StaticRow[] = PROTECTED_REGIONS.map((s) => {
    const resolved = regions.find((r) => r.name === s.name) ?? null
    if (!resolved) {
      return { ...s, resolved, verdict: 'not resolved in this image', missedWriters: [] }
    }
    const missedWriters = sites
      .filter((x) => x.writesFlash && x.body >= resolved.start && x.body < resolved.end)
      .filter((x) => x.body < s.start || x.body >= s.end)
      .map((x) => x.body)
    let verdict: string
    if (s.start === resolved.start && s.end === resolved.end) verdict = 'same span'
    else if (s.start <= resolved.start && s.end >= resolved.end) {
      verdict = `covers it, padded ${hx(resolved.start - s.start)} before and ` +
        `${hx(s.end - resolved.end)} after`
    } else if (overlaps(s, resolved)) {
      verdict = `partial: covers ${hx(Math.min(s.end, resolved.end) -
        Math.max(s.start, resolved.start))} of ${hx(resolved.end - resolved.start)} bytes`
    } else {
      verdict = `misses it by ${hx(Math.abs(resolved.start - s.start))}`
    }
    return { ...s, resolved, verdict, missedWriters }
  })

  return {
    regions,
    sites,
    other,
    writes: writes.spans,
    checks,
    staticMap,
    notes,
    ok: checks.every((c) => c.state !== 'fail'),
  }
}

// --- CLI ----------------------------------------------------------------------------

if (import.meta.main) {
  const path = process.env.FW ?? '/tmp/fw10.bin'
  if (!(await Bun.file(path).exists())) {
    console.error(`no decoded image at ${path}. Run:\n`)
    const decode = 'bun research/ota-codec.ts decode'
    console.error(`  ${decode} firmware/TR1906R04-10_OTA.bin /tmp/fw10.bin\n`)
    console.error('or set FW=<path> to a decoded (deobfuscated) application image.')
    process.exit(2)
  }
  const fw = new Uint8Array(await Bun.file(path).arrayBuffer())
  const r = reader(fw)
  const { u8, u16, u32, poolOf, blTarget } = r
  const END = r.end
  const inBank = (a: number) => a >= BANK_LO && a < BANK_HI
  const [cmd, ...rest] = Bun.argv.slice(2)

  if (cmd === 'peek') {
    const addr = Number(rest[0])
    const len = Number(rest[1])
    const mode = rest[2] ?? 'w'
    if (mode === 'w') {
      for (let i = 0; i < len; i += 4) {
        console.log(`${hx(addr + i)}  ${hx(u32(addr + i))}`)
      }
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
    const a = auditRegions(fw)

    console.log('# Resolved by content, in this image')
    console.log('region | body span | ISPCMD | sites | anchor')
    console.log('--- | --- | --- | --- | ---')
    for (const rg of a.regions) {
      console.log([
        rg.name,
        `${hx(rg.start)}-${hx(rg.end)}`,
        rg.cmds.length ? rg.cmds.map(hx).join(' ') : '-',
        rg.sites.length || '-',
        rg.anchor,
      ].join(' | '))
    }

    console.log('\n# Every FMC/REGLCTL base load, and what it does through the register')
    console.log('site | body | reg | ISPCMD or registers written | resolved region')
    console.log('--- | --- | --- | --- | ---')
    for (const s of a.sites) {
      const rg = a.regions.find((x) => s.body >= x.start && s.body < x.end)
      const cmds = s.cmds.length
        ? s.cmds.map((c) => `${hx(c)} ${ISPCMD[c]?.name ?? 'UNKNOWN'}`).join(', ')
        : s.wrote.map((o) => FMC_REGS[o] ?? hx(o)).join(' ') || '-'
      console.log([hx(s.at), hx(s.body), s.which, cmds, rg ? rg.name : '-'].join(' | '))
    }

    console.log('\n# Blocks of sites that are none of the seven')
    for (const o of a.other) {
      const cmds = o.cmds.length ? o.cmds.map(hx).join(' ') : 'no ISPCMD write'
      console.log(`  ${hx(o.start)}-${hx(o.end)}  ${o.sites.length} site(s)  ${cmds}`)
    }
    console.log('  Clock and power REGLCTL unlock/lock pairs, and the DATS saved-content')
    console.log('  writers. They cost content rather than recoverability, which is why')
    console.log('  the region list does not name them.')

    console.log('\n# What a build on this image would write')
    for (const s of a.writes) console.log(`  ${hx(s.start)}-${hx(s.end)}  ${s.name}`)

    console.log('\n# PROTECTED_REGIONS beside them. Never a failure: see auditRegions')
    console.log('static entry | static span | resolved span | reads as')
    console.log('--- | --- | --- | ---')
    for (const row of a.staticMap) {
      console.log([
        row.name,
        `${hx(row.start)}-${hx(row.end)}`,
        row.resolved ? `${hx(row.resolved.start)}-${hx(row.resolved.end)}` : '-',
        row.verdict +
          (row.missedWriters.length
            ? `. MISSES ${row.missedWriters.map(hx).join(', ')}, which change flash`
            : ''),
      ].join(' | '))
    }

    for (const n of a.notes) {
      console.log(`\n${n.severity === 'fatal' ? 'FATAL' : 'warn '}  ${n.message}`)
    }

    console.log('\n# Checks')
    for (const c of a.checks) {
      const flag = c.state === 'ok' ? 'ok  ' : c.state === 'n/a' ? 'n/a ' : 'FAIL'
      console.log(`  ${flag}  ${c.name.padEnd(18)} ${c.detail}`)
    }
    if (!a.ok) process.exit(1)
  } else {
    console.log('usage: fwtool.ts <peek|xref|callers|modes|render|regions> ...')
    console.log('see the header comment for the decode step and the three scanning traps')
  }
}
