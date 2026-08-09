/**
 * What `dumpcheck` must get right before a probe is ever clipped on.
 *
 * The dumps here are synthetic, built by placing the real stock plaintext into an
 * otherwise erased 256 KB array. That is exactly the shape a good dump should have,
 * so the tests are checks against the real image rather than against a fixture we
 * invented. The mutations then cover the readings that matter on the day: a bad
 * read, a locked part, a partial dump, a staged image, and the brick signature.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import * as ota from '../../packages/core/src/ota.js'
import {
  analyse,
  census,
  compareDumps,
  compareImage,
  decodeConfig0,
  dump,
  fillOf,
  protectedAt,
  referenceImage,
  regionOf,
  vectors,
} from './dumpcheck.js'

const STOCK = 'firmware/TR1906R04-10_OTA.bin'

describe('page fill', () => {
  test('separates erased flash from zeroed flash from data', () => {
    expect(fillOf(new Uint8Array(8).fill(0xff))).toBe('blank')
    expect(fillOf(new Uint8Array(8))).toBe('zero')
    expect(fillOf(new Uint8Array([0xff, 0x00]))).toBe('data')
  })
})

describe('CONFIG0', () => {
  test('the erased value is boot-APROM and is not locked', () => {
    const c = decodeConfig0(0xffffffff)
    expect(c.erased).toBe(true)
    expect(c.cbs).toBe(3)
    expect(c.boot).toContain('APROM')
    expect(c.locked).toBe(false)
    expect(c.brickSignature).toBe(false)
  })

  test('0xffffff3f is the brick signature: CBS cleared to boot LDROM', () => {
    const c = decodeConfig0(0xffffff3f)
    expect(c.cbs).toBe(0)
    expect(c.boot).toBe('LDROM')
    expect(c.brickSignature).toBe(true)
    expect(c.erased).toBe(false)
  })

  test('bit 1 clear reads as locked', () => {
    expect(decodeConfig0(0xfffffffd).locked).toBe(true)
    expect(decodeConfig0(0xffffffff).locked).toBe(false)
  })

  test('the two middle CBS values are reported as unconfirmed, not asserted', () => {
    expect(decodeConfig0(0xffffff7f).boot).toContain('unconfirmed')
    expect(decodeConfig0(0xffffffbf).boot).toContain('unconfirmed')
  })
})

describe('the flash map', () => {
  test('names an address in each region, and nothing outside it', () => {
    expect(regionOf(0x0000)).toBe('BLE stack')
    expect(regionOf(0x16800)).toBe('application')
    expect(regionOf(0x29400)).toBe('OTA staging bank')
    expect(regionOf(0x3c000)).toBe('saved content')
    expect(regionOf(0x3dc00)).toBe('bootloader')
    expect(regionOf(0x40000)).toBe('outside the flash map')
  })

  test('protectedAt uses body offsets, so the GATT table is found by its own', () => {
    expect(protectedAt(0xc1e8)).toContain('GATT table')
    expect(protectedAt(0x0000)).toBe('image head and startup stub')
    expect(protectedAt(0x7000)).toBe(null)
  })
})

describe.if(existsSync(STOCK))('against the real stock image', () => {
  const stock = new Uint8Array(readFileSync(STOCK))
  const { plain } = referenceImage(stock)

  /** An otherwise erased 256 KB array with the application where it belongs. */
  const good = () => {
    const b = new Uint8Array(ota.FLASH_ADDR_END).fill(0xff)
    b.set(plain, ota.FLASH_APP_ADDR)
    return b
  }
  const opts = {
    base: 0,
    against: stock,
    againstName: STOCK,
    config0: null,
    ldrom: null,
  }
  const text = (b: Uint8Array, o: Partial<typeof opts> = {}) =>
    analyse(b, { ...opts, ...o }).lines.join('\n')

  test('the reference is the whole body the header claims', () => {
    expect(plain.length).toBe(ota.STOCK_CODE_SIZE)
  })

  test('a dump holding the stock image validates', () => {
    const r = analyse(good(), opts)
    expect(r.trustworthy).toBe(true)
    expect(r.lines.join('\n')).toContain('MATCHES byte for byte')
  })

  test('one flipped byte fails, and is reported in both coordinate systems', () => {
    const b = good()
    b[ota.FLASH_APP_ADDR + 0x7000] ^= 0xff
    const d = compareImage(dump(b), ota.FLASH_APP_ADDR, plain, 0)
    expect(d.matched).toBe(false)
    expect(d.differing).toBe(1)
    expect(d.runs).toEqual([
      { abs: 0x16800 + 0x7000, body: 0x7000, length: 1, protectedRegion: null },
    ])
    expect(analyse(b, opts).trustworthy).toBe(false)
  })

  test('adjacent differing bytes coalesce into one run', () => {
    const b = good()
    for (let i = 0; i < 4; i++) b[ota.FLASH_APP_ADDR + 0x2000 + i] ^= 0xff
    const d = compareImage(dump(b), ota.FLASH_APP_ADDR, plain, 0)
    expect(d.runs).toHaveLength(1)
    expect(d.runs[0].length).toBe(4)
  })

  test('a difference inside a protected region says which one', () => {
    const b = good()
    b[ota.FLASH_APP_ADDR + 0xc1f0] ^= 0xff
    const d = compareImage(dump(b), ota.FLASH_APP_ADDR, plain, 0)
    expect(d.runs[0].protectedRegion).toContain('GATT table')
    expect(text(b)).toContain('1 run inside PROTECTED_REGIONS')
  })

  test('an erased application region is called out as needing a full reflash', () => {
    const b = new Uint8Array(ota.FLASH_ADDR_END).fill(0xff)
    b[0x100] = 0x42 // so the whole-dump locked check does not fire first
    const r = analyse(b, opts)
    expect(r.trustworthy).toBe(false)
    expect(r.lines.join('\n')).toContain('erased flash')
    expect(r.lines.join('\n')).toContain('full reflash')
  })

  test('an all-0xff dump is reported as a locked part, not as a device finding', () => {
    const r = analyse(new Uint8Array(ota.FLASH_ADDR_END).fill(0xff), opts)
    expect(r.trustworthy).toBe(false)
    expect(r.lines.join('\n')).toContain('read-locked')
    // Nothing else is worth printing once this fires, and printing it would be
    // seven regions of "blank" that mean nothing.
    expect(r.lines.join('\n')).not.toContain('regions')
  })

  test('a dump that stops short of the application validates nothing', () => {
    const b = good().subarray(0, ota.FLASH_APP_ADDR + 0x100)
    const r = analyse(b, opts)
    expect(r.trustworthy).toBe(false)
    expect(r.lines.join('\n')).toContain('does not cover')
  })

  test('a dump starting above zero is addressed by its base', () => {
    const b = good().subarray(ota.FLASH_APP_ADDR)
    const r = analyse(b, { ...opts, base: ota.FLASH_APP_ADDR })
    expect(r.trustworthy).toBe(true)
    expect(r.lines.join('\n')).toContain('covers 0x00016800')
  })

  test('a staged copy in the bank is recognised as the reference image', () => {
    const b = good()
    b.set(plain, ota.FLASH_DFU_ADDR)
    expect(text(b)).toContain(`holds a plaintext copy of ${STOCK}`)
  })

  test('something else in the bank is reported as present but unrecognised', () => {
    const b = good()
    b.set(plain, ota.FLASH_DFU_ADDR)
    b[ota.FLASH_DFU_ADDR + 0x40] ^= 0xff
    const out = text(b)
    expect(out).toContain('not the reference image')
    expect(out).not.toContain('holds a plaintext copy')
  })

  test('an empty bank says nothing is staged', () => {
    expect(text(good())).toContain('erased, so nothing is staged')
  })

  test('a dump ending inside the bank says so, rather than judging what is staged', () => {
    // The comparison cannot run, so it reports 0 differing bytes. Reading that as
    // "not the reference image" is a claim about the device made from a short dump,
    // which is the failure notes/parallel-tracks.md opens by warning about.
    const b = good()
    b.set(plain.subarray(0, 0x800), ota.FLASH_DFU_ADDR)
    const out = text(b.subarray(0, ota.FLASH_DFU_ADDR + 0x800))
    expect(out).toContain('cannot be told from this dump')
    expect(out).not.toContain('not the reference image')
    expect(out).not.toContain('0 bytes differ')
  })

  test('the application head is printed but never judged as a vector table', () => {
    const v = vectors(dump(good()), ota.FLASH_APP_ADDR)!
    expect(v.plausible).toBe(false) // it is an image head, hence the exemption
    expect(text(good())).toContain('application image head, not a vector table')
    expect(text(good())).not.toContain('image head, not a vector table: NOT plausible')
  })

  test('census counts pages, and finds the last byte the image actually uses', () => {
    const c = census(dump(good()), ota.FLASH_APP_ADDR, ota.FLASH_DFU_ADDR)
    expect(c.covered).toBe(true)
    expect(c.pages).toBe(ota.FLASH_APP_SIZE / ota.FLASH_PAGE_SIZE)
    expect(c.firstUsed).toBe(ota.FLASH_APP_ADDR)
    // The gap between here and the staging bank is the free flash the extension
    // is appended into: research/tools/ext.ts.
    expect(c.lastUsed).toBeLessThan(0x26a24)
    expect(c.blank).toBeGreaterThan(0)
  })

  test('the CONFIG0 reading is surfaced with its repair', () => {
    const out = text(good(), { config0: 0xffffff3f, ldrom: 0xffffffff })
    expect(out).toContain('brick signature')
    expect(out).toContain('0x00300000')
    expect(out).toContain('sends the CPU into erased flash')
  })

  test('an LDROM that is not blank overturns the postmortem rather than confirming it', () => {
    expect(text(good(), { ldrom: 0x20001000 })).toContain('needs revisiting')
  })
})

const V1 = 'firmware/joggles-v1.bin'

describe.if(existsSync(STOCK) && existsSync(V1))('a unit carrying our own firmware', () => {
  const stock = new Uint8Array(readFileSync(STOCK))
  const v1 = new Uint8Array(readFileSync(V1))
  const b = new Uint8Array(ota.FLASH_ADDR_END).fill(0xff)
  b.set(referenceImage(v1).plain, ota.FLASH_APP_ADDR)
  const against = (ref: Uint8Array, name: string) =>
    analyse(b, { base: 0, against: ref, againstName: name, config0: null, ldrom: null })

  test('validates against joggles-v1 and identifies the extension', () => {
    const r = against(v1, V1)
    expect(r.trustworthy).toBe(true)
    expect(r.lines.join('\n')).toContain('carries a JGX1 extension: v1')
  })

  test('against stock it is the documented 48-byte footprint, not a bad read', () => {
    const out = against(stock, STOCK).lines.join('\n')
    // notes/firmware-design.md: 27 B of hook, 16 B of key, 5 B of name.
    expect(out).toContain('DIFFERS: 48 bytes in 4 runs')
    expect(out).toContain('abs 0x22b94') // the AES key
    expect(out).toContain('abs 0x2691c') // the advert name
  })

  test('the extension is named even with no reference image to validate against', () => {
    // Which firmware a unit carries does not depend on having a reference to hand,
    // and on the day the reference may well be missing: firmware/ is gitignored.
    const r = analyse(b, {
      base: 0,
      against: null,
      againstName: '',
      config0: null,
      ldrom: null,
    })
    expect(r.trustworthy).toBe(false)
    expect(r.lines.join('\n')).toContain('carries a JGX1 extension: v1')
  })

  test('the appended extension is reported, since the diff cannot reach it', () => {
    const out = against(stock, STOCK).lines.join('\n')
    expect(out).toContain('beyond the reference: 88 bytes at 0x26a24')
    expect(out).toContain('re-run with')
  })

  test('the key patch stops before the S-box, which the diff would show', () => {
    const runs = compareImage(
      dump(b),
      ota.FLASH_APP_ADDR,
      referenceImage(stock).plain,
      0,
    ).runs
    const key = runs.find((r) => r.abs === 0x22b94)!
    expect(key.length).toBe(ota.AES_KEY.length)
    expect(0x16800 + ota.AES_SBOX_START).toBe(key.abs + key.length)
  })
})

describe('comparing repeat dumps', () => {
  const a = new Uint8Array(0x1000).fill(0xaa)

  test('identical dumps diverge nowhere', () => {
    expect(compareDumps([dump(a), dump(new Uint8Array(a))])).toEqual([])
  })

  test('a divergence is located and named by region', () => {
    const b = new Uint8Array(a)
    b[0x800] = 0x00
    b[0x801] = 0x00
    expect(compareDumps([dump(a), dump(b)])).toEqual([
      { abs: 0x800, length: 2, region: 'BLE stack' },
    ])
  })

  test('a third dump agreeing with neither still shows one divergence', () => {
    const b = new Uint8Array(a)
    const c = new Uint8Array(a)
    b[0x10] = 1
    c[0x10] = 2
    expect(compareDumps([dump(a), dump(b), dump(c)])).toHaveLength(1)
  })
})
