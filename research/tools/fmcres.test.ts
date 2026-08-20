/**
 * What these tests are worth.
 *
 * The ones that always run are about the **idiom**: they assemble a vendor-shaped ISP
 * primitive, sometimes at a base that is not the FMC's and sometimes with the five
 * register offsets permuted, and require the resolver to come back with what was
 * assembled rather than with the canonical answer. That is the only way to tell
 * resolving from asserting, and it is the whole reason this module exists: the constants
 * in `updater.ts` were right and their stated provenance was an APK-only address.
 *
 * The rest need `firmware/`, which is gitignored, and are skipped without it. They are
 * the ones that matter: the same code on the vendor's APK container and on a dump of the
 * application a healthy unit actually runs, agreeing about the register map and
 * disagreeing about every address, with neither being a failure.
 *
 * Nothing here touches hardware.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import {
  checkAgainst,
  fakePrimitive,
  resolveFmc,
  windowOf,
  type FmcResolution,
  type RegName,
} from './fmcres.js'
import * as upd from './updater.js'

const ORG = 0x16800
const CANON: Record<RegName, number> = {
  ISPCON: 0,
  ISPADR: 4,
  ISPDAT: 8,
  ISPCMD: 12,
  ISPTRG: 16,
}
const FMC = 0x5000c000
const WRPROT = 0x50000100

const fatal = (r: FmcResolution) => r.notes.filter((n) => n.severity === 'fatal')
const said = (r: FmcResolution) => r.notes.map((n) => n.text).join(' | ')

describe('the idiom, on assembled bytes', () => {
  test('one primitive yields the base and all five offsets', () => {
    const img = fakePrimitive({ org: ORG, base: FMC, wrprot: WRPROT, opcode: 0x21 })
    const r = resolveFmc(img, ORG)
    expect(r.base).toBe(FMC)
    expect(r.wrprot).toBe(WRPROT)
    expect(r.offsets).toEqual(CANON)
    expect(r.opcodes).toEqual([0x21])
    expect(fatal(r)).toEqual([])
  })

  test('a program writes ISPDAT and an erase does not, and both resolve', () => {
    const prog = resolveFmc(
      fakePrimitive({ org: ORG, base: FMC, wrprot: WRPROT, opcode: 0x21, withData: true }),
      ORG,
    )
    expect(prog.offsets.ISPDAT).toBe(8)
    // An erase never writes ISPDAT, so the only witness left is the result read.
    const erase = resolveFmc(
      fakePrimitive({ org: ORG, base: FMC, wrprot: WRPROT, opcode: 0x22 }),
      ORG,
    )
    expect(erase.offsets.ISPADR).toBe(4)
    expect(erase.opcodes).toEqual([0x22])
  })

  test('a base that is not the FMC comes back as itself', () => {
    // The strongest available proof that nothing is hardcoded: the watchdog's base,
    // wearing an ISP-shaped poll. `0x5000c000` never appears in this image.
    const img = fakePrimitive({ org: ORG, base: 0x40004000, opcode: 0x21 })
    const r = resolveFmc(img, ORG)
    expect(r.base).toBe(0x40004000)
    expect(r.offsets).toEqual(CANON)
    // No unlock sequence was assembled, so REGLCTL is refused rather than assumed.
    expect(r.wrprot).toBeNull()
    expect(said(r)).toContain('unlock sequence')
  })

  test('permuted offsets come back permuted, not canonical', () => {
    const regs: Record<RegName, number> = {
      ISPCON: 0x20,
      ISPADR: 0x2c,
      ISPDAT: 0x30,
      ISPCMD: 0x24,
      ISPTRG: 0x28,
    }
    const img = fakePrimitive({
      org: ORG,
      base: FMC,
      wrprot: WRPROT,
      opcode: 0x21,
      regs,
      withData: true,
    })
    const r = resolveFmc(img, ORG)
    expect(r.offsets).toEqual(regs)
    expect(r.offsets).not.toEqual(CANON)
    expect(fatal(r)).toEqual([])
  })

  test('no poll idiom means no base, and it says so rather than guessing', () => {
    const r = resolveFmc(new Uint8Array(512), ORG)
    expect(r.base).toBeNull()
    expect(said(r)).toContain('no ISP poll idiom')
  })

  test('two bases tied on poll count are refused, not ranked', () => {
    const a = fakePrimitive({ org: ORG, base: FMC, opcode: 0x21 })
    const b = fakePrimitive({ org: ORG + a.length, base: 0x40004000, opcode: 0x22 })
    const img = new Uint8Array(a.length + b.length)
    img.set(a)
    img.set(b, a.length)
    const r = resolveFmc(img, ORG)
    expect(r.base).toBeNull()
    expect(said(r)).toContain('same number of ISP polls')
  })
})

describe('the write-protect register', () => {
  test('the three key writes name their own base', () => {
    const r = resolveFmc(
      fakePrimitive({ org: ORG, base: FMC, wrprot: 0x40000100, opcode: 0x21 }),
      ORG,
    )
    expect(r.wrprot).toBe(0x40000100)
    expect(r.unlocks).toHaveLength(1)
    expect(r.unlocks[0].relock).not.toBeNull()
  })

  test('the read-back-and-retry loop is reported, and its absence is too', () => {
    const withRetry = resolveFmc(
      fakePrimitive({ org: ORG, base: FMC, wrprot: WRPROT, opcode: 0x21, retryUnlock: true }),
      ORG,
    )
    expect(withRetry.unlocks[0].retries).toBe(true)
    const without = resolveFmc(
      fakePrimitive({ org: ORG, base: FMC, wrprot: WRPROT, opcode: 0x21 }),
      ORG,
    )
    expect(without.unlocks[0].retries).toBe(false)
  })

  test('a primitive with no unlock at all resolves the FMC and refuses REGLCTL', () => {
    const r = resolveFmc(fakePrimitive({ org: ORG, base: FMC, opcode: 0x21 }), ORG)
    expect(r.base).toBe(FMC)
    expect(r.wrprot).toBeNull()
    expect(r.unlocks).toEqual([])
  })
})

describe('the two scanning traps fwtool warns about', () => {
  test('a bare literal nothing loads is not a candidate base', () => {
    // Trap 1. Four copies of the FMC base as data, which a word scan would report and
    // which mean nothing at all.
    const img = new Uint8Array(64)
    const dv = new DataView(img.buffer)
    for (let i = 0; i < 4; i++) dv.setUint32(i * 4, FMC, true)
    const r = resolveFmc(img, ORG)
    expect(r.base).toBeNull()
  })

  test('a base shifted into an address is reported, not silently dropped', () => {
    // Trap 2, in the exact form both vendor builds use: `0x5000c000 << 6` is the
    // `0x00300000` config aperture, and it appears as a literal nowhere.
    const img = fakePrimitive({
      org: ORG,
      base: FMC,
      wrprot: WRPROT,
      opcode: 0x22,
      shiftAddr: 6,
    })
    const r = resolveFmc(img, ORG)
    expect(r.computed).toHaveLength(1)
    expect(r.computed[0].value).toBe(0x00300000)
    expect(said(r)).toContain('shifted into an address')
  })

  test('the poll\'s own shift is not mistaken for a computed address', () => {
    // `lsls rP,rP,#31` shifts the value read out of ISPTRG, not the base register, and
    // an earlier draft reported it. Nothing here shifts the base.
    const r = resolveFmc(
      fakePrimitive({ org: ORG, base: FMC, wrprot: WRPROT, opcode: 0x21 }),
      ORG,
    )
    expect(r.computed).toEqual([])
  })
})

// firmware/ is gitignored, so everything from here needs the real bytes.
const APK = 'firmware/TR1906R04-10_OTA.bin'
const DONOR = 'firmware/dump-12E69E-2026-08-19-a.bin'
const DONOR_B = 'firmware/dump-12E69E-2026-08-19-b.bin'

/** The APK container is obfuscated, so it has to go through the OTA codec first. */
async function apkImage(): Promise<Uint8Array> {
  const ota = await import('../../packages/core/src/ota.js')
  return ota.plaintext(new Uint8Array(readFileSync(APK)))
}

const resolveFile = (path: string) => {
  const { image, base } = windowOf(new Uint8Array(readFileSync(path)))
  return resolveFmc(image, base)
}

describe.if(existsSync(APK))('the APK container', () => {
  test('resolves the FMC block the whole project has assumed', async () => {
    const r = resolveFmc(await apkImage(), ORG)
    expect(r.base).toBe(FMC)
    expect(r.wrprot).toBe(WRPROT)
    expect(r.offsets).toEqual(CANON)
    expect(fatal(r)).toEqual([])
  })

  test('the opcodes it writes, and the two it does not', async () => {
    const r = resolveFmc(await apkImage(), ORG)
    expect(r.opcodes).toEqual([0x00, 0x04, 0x0d, 0x21, 0x22, 0x2d])
    // 0x23 is the real whole-chip erase and 0x26 is OpenOCD's guess at one. Neither is
    // anywhere in the vendor's application, so no vendor code path can erase the chip.
    expect(r.opcodes).not.toContain(0x23)
    expect(r.opcodes).not.toContain(0x26)
  })
})

describe.if(existsSync(DONOR))('the donor build, which is what a unit actually runs', () => {
  test('the same register map, resolved from its own bytes', () => {
    const r = resolveFile(DONOR)
    expect(r.base).toBe(FMC)
    expect(r.wrprot).toBe(WRPROT)
    expect(r.offsets).toEqual(CANON)
    expect(r.opcodes).toEqual([0x00, 0x04, 0x0d, 0x21, 0x22, 0x2d])
    expect(fatal(r)).toEqual([])
  })

  test.if(existsSync(DONOR_B))('and the second dump of the same unit agrees exactly', () => {
    expect(resolveFile(DONOR_B)).toEqual(resolveFile(DONOR))
  })

  test('every ISPCON bit the image touches, and the ones it never does', () => {
    const r = resolveFile(DONOR)
    const masks = new Set(r.conBits.map((b) => b.mask))
    // ISPEN, APUEN, CFGUEN and ISPFF are all witnessed on this image.
    expect([...masks].sort((a, b) => a - b)).toEqual([0x01, 0x08, 0x10, 0x40])
    // BS, SPUEN and LDUEN are not. Their bit positions come from the CMSIS header
    // alone, and `updater.ts` names BS.
    expect(masks.has(0x02)).toBe(false)
    expect(masks.has(0x04)).toBe(false)
    expect(masks.has(0x20)).toBe(false)
  })

  test('the unlock is retried far more often than it is not', () => {
    const r = resolveFile(DONOR)
    expect(r.unlocks.length).toBeGreaterThan(10)
    expect(r.unlocks.filter((u) => u.retries).length).toBeGreaterThan(
      r.unlocks.filter((u) => !u.retries).length,
    )
    // Almost every site re-locks. `updater.ts` does too, on every exit path.
    expect(r.unlocks.filter((u) => u.relock !== null).length).toBeGreaterThan(10)
  })

  test('the config aperture is computed off the base register, not stored', () => {
    const r = resolveFile(DONOR)
    expect(r.computed.map((c) => c.value)).toEqual([0x00300000])
  })
})

describe.if(existsSync(APK) && existsSync(DONOR))(
  'the two images agree about the map and disagree about the addresses',
  () => {
    test('same base, same offsets, same opcodes', async () => {
      const a = resolveFmc(await apkImage(), ORG)
      const d = resolveFile(DONOR)
      expect(d.base).toBe(a.base!)
      expect(d.wrprot).toBe(a.wrprot!)
      expect(d.offsets).toEqual(a.offsets)
      expect(d.opcodes).toEqual(a.opcodes)
    })

    test('and not one primitive at the same address', async () => {
      const a = resolveFmc(await apkImage(), ORG)
      const d = resolveFile(DONOR)
      const apkPolls = new Set(a.isp.filter((s) => s.base === FMC).map((s) => s.poll))
      const donorPolls = d.isp.filter((s) => s.base === FMC).map((s) => s.poll)
      expect(donorPolls.length).toBeGreaterThan(10)
      expect(donorPolls.filter((p) => apkPolls.has(p))).toEqual([])
    })
  },
)

describe.if(existsSync(DONOR))('what the resident updater assumes about the FMC', () => {
  const claim = {
    base: upd.FMC_BASE,
    wrprot: upd.FMC_WRPROT,
    offsets: upd.FMC_OFF as unknown as Record<RegName, number>,
    opcodes: [upd.CMD_PROGRAM, upd.CMD_PAGE_ERASE],
  }

  test('its base, its lock register and all five offsets are what the donor witnesses', () => {
    expect(checkAgainst(resolveFile(DONOR), claim)).toEqual([])
  })

  test('and the same holds on the APK container, so neither build is special', async () => {
    expect(checkAgainst(resolveFmc(await apkImage(), ORG), claim)).toEqual([])
  })

  test('the bits it sets are all witnessed; the one it preserves is not', () => {
    const r = resolveFile(DONOR)
    // ISPEN | APUEN | ISPFF: every one of them is set by vendor code on this image.
    expect(checkAgainst(r, { ...claim, conMask: upd.ISPCON_APROM })).toEqual([])
    // BS is the exception, and it is the only constant in the updater's FMC block that
    // nothing on this hardware is witnessed touching.
    const withBs = checkAgainst(r, { ...claim, conMask: upd.ISPCON_APROM | upd.ISPCON_BS })
    expect(withBs).toHaveLength(1)
    expect(withBs[0]).toContain('BS')
  })

  test('it never names an opcode outside the closed set', () => {
    const r = resolveFile(DONOR)
    for (const op of [upd.CMD_PROGRAM, upd.CMD_PAGE_ERASE]) expect(r.opcodes).toContain(op)
    // The tripwire: a whole-chip erase opcode must never appear among our constants.
    const ours = Object.entries(upd)
      .filter(([k]) => k.startsWith('CMD_'))
      .map(([, v]) => v as number)
      .sort((a, b) => a - b)
    expect(ours).toEqual([0x21, 0x22])
  })

  test('the slots it writes sit where 512-byte pages have the strongest witness', () => {
    // The staging bank is where the vendor's own OTA writer erased and programmed 130
    // pages at 512-byte stride, so the granularity the updater's erase loop assumes is
    // witnessed at exactly the addresses it writes.
    expect(upd.SLOT_A).toBe(0x29400)
    expect(upd.PAGE).toBe(512)
    expect(upd.SLOT_A % upd.PAGE).toBe(0)
    expect(upd.SLOT_B % upd.PAGE).toBe(0)
    expect(upd.SLOT_SIZE % upd.PAGE).toBe(0)
  })
})
