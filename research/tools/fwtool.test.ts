/**
 * The region audit, on both builds and on images doctored to break it.
 *
 * The point of this file is that **the same code resolves both builds**. Before track
 * 58 `fwtool regions` compared a site count against 16, which is the APK's number and
 * only the APK's, so the donor build printed 39 and a passing gate said nothing. The
 * assertions below are the ones that hold on the APK image, on a real unit's window,
 * and would hold on a third build: one flash writer, no unknown ISPCMD opcode, and
 * nothing this repo writes landing in a region that has to survive.
 *
 * `PROTECTED_REGIONS` is asserted here too, but only as a comparison: on the APK every
 * static span contains the span resolved by content, and on the donor five of the seven
 * miss it entirely. Neither is a failure and the tests say which is which.
 *
 * `firmware/` is gitignored, so the blocks that need real vendor bytes are
 * `describe.if(existsSync(...))` and the rest run everywhere.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import * as ota from '../../packages/core/src/ota.js'
import { SIGNATURE as EXT_SIGNATURE } from './ext.js'
import { CMD_CHIP_ERASE, CMD_PAGE_ERASE, CMD_PROGRAM } from './swdflash.js'
import {
  auditRegions,
  BASE,
  clusters,
  deriveRegions,
  fmcSites,
  ISPCMD,
  occurrences,
  ourWrites,
  poolBlock,
  reader,
} from './fwtool.js'

const STOCK = 'firmware/TR1906R04-10_OTA.bin'
const DONOR = 'firmware/dump-12E69E-2026-08-19-a.bin'
const DONOR_B = 'firmware/dump-12E69E-2026-08-19-b.bin'
/** Unit 1 before the repair: the APK image with a longer build's tail still above it. */
const MIXED = 'firmware/dump-unit1-2026-08-19-a.bin'

const window = (path: string): Uint8Array => {
  const d = new Uint8Array(readFileSync(path))
  return d.slice(ota.FLASH_APP_ADDR, ota.FLASH_DFU_ADDR)
}

const apkImage = (): Uint8Array =>
  ota.plaintext(new Uint8Array(readFileSync(STOCK)))

const stateOf = (a: ReturnType<typeof auditRegions>, name: string) =>
  a.checks.find((c) => c.name === name)!.state

const regionOf = (a: ReturnType<typeof auditRegions>, name: string) =>
  a.regions.find((r) => r.name === name)

const rowOf = (a: ReturnType<typeof auditRegions>, name: string) =>
  a.staticMap.find((r) => r.name === name)!

// --- The parts that need no vendor bytes -------------------------------------------

describe('the ISPCMD table', () => {
  // The whole table cannot be imported from swdflash: that file only names the opcodes
  // it can emit. This is the tripwire that stops the two disagreeing about those three.
  it('agrees with swdflash about the three opcodes that file names', () => {
    expect(ISPCMD[CMD_PROGRAM]).toEqual({ name: 'program word', writes: true })
    expect(ISPCMD[CMD_PAGE_ERASE]).toEqual({ name: 'page erase', writes: true })
    expect(ISPCMD[CMD_CHIP_ERASE].writes).toBe(true)
  })

  it('marks exactly the three opcodes that change flash', () => {
    const writes = Object.entries(ISPCMD)
      .filter(([, v]) => v.writes)
      .map(([k]) => Number(k))
    expect(writes.sort((a, b) => a - b)).toEqual([0x21, 0x22, 0x23])
  })

  it('has no entry for 0x26, which is not a command on this part', () => {
    expect(0x26 in ISPCMD).toBe(false)
  })
})

describe('reader', () => {
  it('decodes a BL against a known target', () => {
    // `bl +0x10` from 0x16800: f000 f806.
    const img = new Uint8Array(0x20)
    img.set([0x00, 0xf0, 0x06, 0xf8], 0)
    expect(reader(img).blTarget(BASE)).toBe(BASE + 0x10)
  })

  it('returns null where there is no BL', () => {
    expect(reader(new Uint8Array(8)).blTarget(BASE)).toBeNull()
  })
})

describe('poolBlock', () => {
  // Two `ldr rN, [pc, #imm]` reading two adjacent pool words, then an unread word. The
  // run stops at the unread word, which is the whole reason the bound cannot over-reach.
  const img = new Uint8Array(0x20)
  const dv = new DataView(img.buffer)
  img.set([0x01, 0x48], 0x00) //  ldr r0, [pc, #4]   -> pool 0x08
  img.set([0x02, 0x49], 0x02) //  ldr r1, [pc, #8]   -> pool 0x0c
  dv.setUint32(0x08, 0xdead0001, true)
  dv.setUint32(0x0c, 0xdead0002, true)
  dv.setUint32(0x10, 0xdead0003, true) //  read by nothing

  it('runs from the first reader to the last read word', () => {
    const pb = poolBlock(img, BASE + 0x08)!
    expect(pb.start).toBe(0)
    expect(pb.poolStart).toBe(0x08)
    expect(pb.poolEnd).toBe(0x10)
    expect(pb.end).toBe(0x10)
  })

  it('stops at a word nothing reads', () => {
    expect(poolBlock(img, BASE + 0x10)).toBeNull()
  })
})

describe('clusters', () => {
  const site = (at: number) => ({
    at,
    body: at - BASE,
    which: 'FMC' as const,
    reg: 0,
    cmds: [],
    wrote: [],
    lastTouch: at + 2,
    writesFlash: false,
  })

  it('splits on a gap wider than the threshold and not on a narrower one', () => {
    const sites = [site(BASE), site(BASE + 0x40), site(BASE + 0x200)]
    expect(clusters(sites, 0x100).map((c) => c.sites.length)).toEqual([2, 1])
    expect(clusters(sites, 0x400).map((c) => c.sites.length)).toEqual([3])
  })
})

describe('occurrences', () => {
  it('finds every copy, not just the first', () => {
    const img = new Uint8Array([1, 2, 3, 1, 2, 3])
    expect(occurrences(img, new Uint8Array([1, 2]))).toEqual([0, 3])
  })
})

// --- The APK build ------------------------------------------------------------------

describe.if(existsSync(STOCK))('the APK image', () => {
  const img = apkImage()

  it('resolves all seven regions by content, and nothing else', () => {
    const d = deriveRegions(img)
    expect(d.notes.filter((n) => n.severity === 'fatal')).toEqual([])
    expect([...d.regions.map((r) => r.name)].sort()).toEqual(
      [...ota.PROTECTED_REGIONS].map((r) => r.name).sort(),
    )
  })

  it('puts the resolved spans where the disassembly said they were', () => {
    const a = auditRegions(img)
    const span = (n: string) => {
      const r = regionOf(a, n)!
      return [r.start, r.end]
    }
    expect(span('image head and startup stub')).toEqual([0x0, 0x200])
    expect(span('FMC flash driver')).toEqual([0x1118, 0x1318])
    expect(span('flash program primitive')).toEqual([0x284c, 0x28a4])
    expect(span('OTA handoff and reset')).toEqual([0x61d2, 0x628c])
    expect(span('OTA handler')).toEqual([0x8226, 0x8660])
    expect(span('OTA payload descrambler')).toEqual([0x9188, 0x91b8])
    expect(span('GATT table, including the fd00 OTA service')).toEqual([0xc1e8, 0xc34c])
  })

  // The load-bearing check on the derivation itself. `PROTECTED_REGIONS` was traced by
  // hand off this build and its docblock says the ranges are padded outwards, so every
  // resolved span must sit inside its static one. Where it did not, one of the two is
  // wrong, and that is worth knowing before either is trusted on another build.
  it('resolves a span inside every static entry, which is what padding means', () => {
    const a = auditRegions(img)
    for (const row of a.staticMap) {
      expect(row.resolved).not.toBeNull()
      expect(row.verdict).toMatch(/^(same span|covers it)/)
      expect(row.missedWriters).toEqual([])
    }
  })

  it('finds one flash writer, three writing sites, and passes every check', () => {
    const a = auditRegions(img)
    const writers = a.sites.filter((s) => s.writesFlash).map((s) => s.body)
    expect(writers).toEqual([0x1128, 0x125c, 0x1282])
    for (const c of a.checks) expect(c.state).toBe('ok')
    expect(a.ok).toBe(true)
  })

  it('names the four spans a build on this image would write', () => {
    const w = ourWrites(img)
    expect(w.spans.map((s) => s.name)).toEqual([
      'dispatcher hook',
      'crew AES key',
      'advert name',
      'JGX1 extension',
    ])
    expect(w.spans.find((s) => s.name === 'crew AES key')!.start).toBe(ota.AES_KEY.start)
  })

  // The count the old gate asserted. Kept only so it is on the record that it is one
  // build's arithmetic: the donor's answer is 39 and neither says anything about safety.
  it('leaves 16 sites outside the static regions, which is why 16 was no gate', () => {
    const a = auditRegions(img)
    const outside = a.sites.filter(
      (s) => !ota.PROTECTED_REGIONS.some((r) => s.body >= r.start && s.body < r.end),
    )
    expect(outside).toHaveLength(16)
  })
})

// --- A real unit's own application --------------------------------------------------

describe.if(existsSync(DONOR))('the donor build, off GLASSES-12E69E', () => {
  const img = window(DONOR)

  it('resolves all seven regions, at addresses that are not the APK\'s', () => {
    const a = auditRegions(img)
    expect(a.notes.filter((n) => n.severity === 'fatal')).toEqual([])
    expect(a.regions).toHaveLength(ota.PROTECTED_REGIONS.length)
    const span = (n: string) => {
      const r = regionOf(a, n)!
      return [r.start, r.end]
    }
    expect(span('FMC flash driver')).toEqual([0x120c, 0x1428])
    expect(span('flash program primitive')).toEqual([0x2b14, 0x2b6c])
    expect(span('OTA handoff and reset')).toEqual([0x6562, 0x661c])
    expect(span('OTA handler')).toEqual([0x85d6, 0x89f4])
    expect(span('OTA payload descrambler')).toEqual([0x957c, 0x95ac])
    expect(span('GATT table, including the fd00 OTA service')).toEqual([0xcc30, 0xcd94])
  })

  it('passes every check on a build no static offset in the repo describes', () => {
    const a = auditRegions(img)
    for (const c of a.checks) expect(c.state).toBe('ok')
    expect(a.ok).toBe(true)
  })

  // The finding this file exists for. The driver grew a function on this build, so the
  // static span stops 0x110 bytes short and leaves the word programmer and the CONFIG0
  // writer outside it: two of the three sites that slid can erase or program flash.
  it('shows the static driver span missing the programmer and config writer', () => {
    const a = auditRegions(img)
    const row = rowOf(a, 'FMC flash driver')
    expect(row.verdict).toStartWith('partial')
    expect(row.missedWriters).toEqual([0x136c, 0x1392])
  })

  it('shows five of the seven static entries missing their code entirely', () => {
    const a = auditRegions(img)
    const missed = a.staticMap.filter((r) => r.verdict.startsWith('misses'))
    expect(missed.map((r) => r.name)).toEqual([
      'flash program primitive',
      'OTA handoff and reset',
      'OTA payload descrambler',
      'GATT table, including the fd00 OTA service',
    ])
    // The head is the only one that lands right, because it is the only one that is a
    // position rather than a piece of code.
    expect(rowOf(a, 'image head and startup stub').verdict).toBe('same span')
  })

  it('leaves 39 sites outside every static region, against the APK\'s 16', () => {
    const a = auditRegions(img)
    const outside = a.sites.filter(
      (s) => !ota.PROTECTED_REGIONS.some((r) => s.body >= r.start && s.body < r.end),
    )
    expect(outside).toHaveLength(39)
  })

  it('reads the same on the second dump of the same unit', () => {
    if (!existsSync(DONOR_B)) return
    const b = auditRegions(window(DONOR_B))
    const a = auditRegions(img)
    expect(b.regions).toEqual(a.regions)
  })
})

// --- Doctored: what the gate does when something is actually wrong -------------------

describe.if(existsSync(DONOR))('an image doctored to break it', () => {
  const clean = window(DONOR)

  /** A copy with `bytes` written at a body offset. */
  const patched = (at: number, bytes: number[]): Uint8Array => {
    const img = clean.slice()
    img.set(bytes, at)
    return img
  }

  it('fails loudly on a second block that can program flash', () => {
    // `ldr r1, [pc, #4]` / `movs r0, #0x22` / `str r0, [r1, #12]` / nop / FMC base,
    // planted in the zero fill far enough away to be its own cluster.
    const img = patched(0x11000, [
      0x01, 0x49, 0x22, 0x20, 0xc8, 0x60, 0xc0, 0x46, 0x00, 0xc0, 0x00, 0x50,
    ])
    const a = auditRegions(img)
    expect(stateOf(a, 'regions-resolved')).toBe('fail')
    expect(stateOf(a, 'one-flash-writer')).toBe('fail')
    expect(a.notes.some((n) => n.message.includes('2 separate blocks'))).toBe(true)
    expect(a.ok).toBe(false)
  })

  it('fails on an ISPCMD opcode the vendor\'s own header does not list', () => {
    // The page-erase immediate at the head of the driver, `movs r0, #0x22` -> `#0x25`.
    const sites = fmcSites(clean)
    const erase = sites.find((s) => s.cmds.includes(0x22))!
    const r = reader(clean)
    let movsAt = -1
    for (let a = erase.at - 0x10; a < erase.at + 0x20; a += 2) {
      if ((r.u16(a) & 0xf8ff) === 0x2022) movsAt = a
    }
    expect(movsAt).toBeGreaterThan(0)
    const img = patched(movsAt - BASE, [0x25, r.u16(movsAt) >> 8])
    const a = auditRegions(img)
    expect(stateOf(a, 'known-opcodes')).toBe('fail')
    expect(a.checks.find((c) => c.name === 'known-opcodes')!.detail).toContain('0x25')
  })

  it('fails when something this build writes lands inside a resolved region', () => {
    // Move the advert prefix into the OTA handler. `resolveLayout` refuses two copies,
    // so the real one is blanked first: what is left is one prefix, inside the region.
    const name = occurrences(clean, EXT_SIGNATURE.advertName)
    expect(name).toHaveLength(1)
    const img = clean.slice()
    img.set(new Uint8Array(EXT_SIGNATURE.advertName.length).fill(0x5f), name[0])
    img.set(EXT_SIGNATURE.advertName, 0x8700)
    const a = auditRegions(img)
    expect(stateOf(a, 'patch-clear')).toBe('fail')
    const detail = a.checks.find((c) => c.name === 'patch-clear')!.detail
    expect(detail).toContain('advert name')
    expect(detail).toContain('OTA handler')
    expect(a.ok).toBe(false)
  })

  it('refuses an image whose OTA pad seed has gone', () => {
    const r = reader(clean)
    let seedAt = -1
    for (let a = BASE; a + 4 <= r.end; a += 4) {
      if (r.u32(a) === ota.PAD_SEED) seedAt = a - BASE
    }
    expect(seedAt).toBeGreaterThan(0)
    const a = auditRegions(patched(seedAt, [0, 0, 0, 0]))
    expect(stateOf(a, 'regions-resolved')).toBe('fail')
    expect(regionOf(a, 'OTA handler')).toBeUndefined()
    expect(a.notes.some((n) => n.message.includes('pad seed'))).toBe(true)
  })

  it('refuses the whole dump handed in where the window was meant', () => {
    const whole = new Uint8Array(readFileSync(DONOR))
    const a = auditRegions(whole)
    expect(stateOf(a, 'regions-resolved')).toBe('fail')
    expect(a.notes.some((n) => n.message.includes('not an application image'))).toBe(true)
  })
})

// --- The image Track C would actually flash -----------------------------------------

const V2 = 'firmware/joggles-v2.bin'

describe.if(existsSync(V2))('joggles-v2.bin, the donor-rebased image', () => {
  // The case that has to pass, because it is the one Track C flashes. Track 57 recorded
  // `chooseBaseline` returning seven spurious `protected-region` fatals against exactly
  // this image, and this asserts the content-derived audit does not add an eighth.
  //
  // **UNFLASHED.** Nothing here has run on any unit and this test reads a file.
  const img = ota.plaintext(new Uint8Array(readFileSync(V2)))

  it('resolves all seven regions and refuses nothing', () => {
    const a = auditRegions(img)
    expect(a.regions).toHaveLength(ota.PROTECTED_REGIONS.length)
    expect(a.checks.filter((c) => c.state === 'fail')).toEqual([])
    expect(a.ok).toBe(true)
  })

  it('keeps the driver where the donor it is built on puts it', () => {
    const a = auditRegions(img)
    expect(regionOf(a, 'FMC flash driver')!.start).toBe(0x120c)
    expect(rowOf(a, 'FMC flash driver').missedWriters).toEqual([0x136c, 0x1392])
  })

  // Not a refusal, and the reason it must not be one: this image is already patched, so
  // its hook site is spent, its key is ours and its advert prefix is not `GLASSES-`.
  // There is no second build to base on it, which is a different thing from a hazard.
  it('reports patch-clear as n/a, because nothing can be built on top of it', () => {
    const a = auditRegions(img)
    expect(stateOf(a, 'patch-clear')).toBe('n/a')
  })
})

// --- The window nothing can be built on --------------------------------------------

describe.if(existsSync(MIXED))('unit 1 before the repair, a mixed window', () => {
  const img = window(MIXED)

  // Not a hazard and not a pass: two builds' bytes are in this window, so
  // `resolveLayout` refuses it and there are no patch spans to hold against anything.
  // Calling that a failure is the cry-wolf the count check already was.
  it('reports patch-clear as n/a with the reason, and does not fail the audit', () => {
    const a = auditRegions(img)
    expect(stateOf(a, 'patch-clear')).toBe('n/a')
    expect(a.checks.find((c) => c.name === 'patch-clear')!.detail)
      .toContain('appears 2 times')
    expect(a.ok).toBe(true)
  })

  it('still resolves all seven regions, because the live copy is the low one', () => {
    const a = auditRegions(img)
    expect(a.regions).toHaveLength(ota.PROTECTED_REGIONS.length)
    expect(regionOf(a, 'FMC flash driver')!.start).toBe(0x1118)
  })
})
