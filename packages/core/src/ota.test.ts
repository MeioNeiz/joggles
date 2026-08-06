import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import * as ota from './ota.js'

/**
 * A minimal plaintext image that passes the "will it boot" checks: initial SP in
 * SRAM at body 0x08, Thumb entry vector at body 0x0c, and a version string.
 */
function makePlain(size = 0x10000, version = ota.DEVICE_VERSION): Uint8Array {
  const p = new Uint8Array(size)
  const dv = new DataView(p.buffer)
  dv.setUint32(0x08, 0x20003910, true)
  dv.setUint32(0x0c, 0x00016a01, true)
  for (let i = 0; i < version.length; i++) p[0x7808 + i] = version.charCodeAt(i)
  return p
}

const wrap = (plain: Uint8Array, type = ota.OTA_APP) =>
  ota.encode(plain, { appVer: 3, devVer: 10, proVer: 10, type })

const fatals = (v: ota.Verdict) =>
  v.findings.filter((f) => f.severity === 'fatal').map((f) => f.code)

describe('flash map', () => {
  test('staging bank begins exactly where the application region ends', () => {
    expect(ota.FLASH_DFU_ADDR).toBe(ota.FLASH_APP_ADDR + ota.FLASH_APP_SIZE)
  })

  test('application region begins where the BLE stack ends', () => {
    expect(ota.FLASH_APP_ADDR).toBe(ota.FLASH_SOFTDEVICE_ADDR + ota.FLASH_SOFTDEVICE_SIZE)
  })

  test('safety ceilings follow from the layout', () => {
    expect(ota.SAFE_MAX_CODE_SIZE).toBe(0x12c00)
    expect(ota.BOOTLOADER_SAFE_CODE_SIZE).toBe(0x14800)
  })

  test('the device bound is looser than the flash allows, which is why we check', () => {
    expect(ota.DEVICE_MAX_CODE_SIZE).toBeGreaterThan(ota.BOOTLOADER_SAFE_CODE_SIZE)
  })
})

describe('container codec', () => {
  test('encode and plaintext round-trip', () => {
    const plain = makePlain()
    const file = wrap(plain)
    expect(ota.plaintext(file)).toEqual(plain)
  })

  test('header carries size, crc and version fields', () => {
    const plain = makePlain()
    const h = ota.parseHeader(wrap(plain))
    expect(h.codeSize).toBe(plain.length)
    expect(h.crc32).toBe(ota.crc32(plain))
    expect(h).toMatchObject({ appVer: 3, devVer: 10, proVer: 10, type: 1 })
  })

  test('obfuscation is an involution with a 128-byte period', () => {
    expect(ota.pad.length).toBe(128)
    const b = new Uint8Array([1, 2, 3, 4, 5])
    expect(ota.deobfuscate(ota.deobfuscate(b))).toEqual(b)
  })
})

describe('check accepts what it should', () => {
  test('a well-formed application image passes', () => {
    const v = ota.check(wrap(makePlain()))
    expect(v.safe).toBe(true)
    expect(fatals(v)).toEqual([])
  })

  test('an image at the safe ceiling still passes', () => {
    const v = ota.check(wrap(makePlain(ota.SAFE_MAX_CODE_SIZE)))
    expect(v.safe).toBe(true)
  })
})

describe('check refuses what would brick or misbehave', () => {
  test('a softdevice image, which would overwrite the BLE stack', () => {
    const v = ota.check(wrap(makePlain(), ota.OTA_SOFTDEVICE))
    expect(v.safe).toBe(false)
    expect(fatals(v)).toContain('softdevice-image')
  })

  test('an unrecognised section type', () => {
    const v = ota.check(wrap(makePlain(), 7))
    expect(fatals(v)).toContain('unknown-type')
  })

  test('an image large enough to reach the saved-content buffer', () => {
    const v = ota.check(wrap(makePlain(ota.SAFE_MAX_CODE_SIZE + 4)))
    expect(fatals(v)).toContain('erases-info-page')
  })

  test('an image large enough to erase the bootloader', () => {
    const v = ota.check(wrap(makePlain(ota.BOOTLOADER_SAFE_CODE_SIZE + 4)))
    expect(fatals(v)).toContain('erases-bootloader')
  })

  test('an image the device itself would reject', () => {
    const v = ota.check(wrap(makePlain(ota.DEVICE_MAX_CODE_SIZE)))
    expect(fatals(v)).toContain('device-rejects')
  })

  test('a codeSize that is not a whole number of words', () => {
    const v = ota.check(wrap(makePlain(0x10001)))
    expect(fatals(v)).toContain('not-word-aligned')
  })

  test('a corrupted body, caught by the CRC', () => {
    const file = wrap(makePlain())
    file[ota.HEADER_SIZE + 0x40] ^= 0xff
    expect(fatals(ota.check(file))).toContain('crc-mismatch')
  })

  test('a stack pointer outside SRAM', () => {
    const plain = makePlain()
    new DataView(plain.buffer).setUint32(0x08, 0x12345678, true)
    expect(fatals(ota.check(wrap(plain)))).toContain('bad-stack-pointer')
  })

  test('an entry vector linked for the wrong base', () => {
    const plain = makePlain()
    new DataView(plain.buffer).setUint32(0x0c, 0x00000201, true)
    expect(fatals(ota.check(wrap(plain)))).toContain('entry-out-of-range')
  })

  test('the other hardware variant', () => {
    const v = ota.check(wrap(makePlain(0x10000, 'TR1906R04-01-10')))
    expect(fatals(v)).toContain('wrong-variant')
  })

  test('report() says so out loud', () => {
    const v = ota.check(wrap(makePlain(), ota.OTA_SOFTDEVICE))
    expect(ota.report(v)).toContain('REFUSED')
  })
})

describe('comparePatch guards the way back', () => {
  const stock = wrap(makePlain())

  test('an edit outside the protected regions is allowed', () => {
    const plain = makePlain()
    plain[0xd000] = 0x42
    const v = ota.check(wrap(plain), { stock })
    expect(v.safe).toBe(true)
  })

  test('an edit inside the OTA handler is refused', () => {
    const plain = makePlain()
    plain[0x8200] = 0x42
    const v = ota.check(wrap(plain), { stock })
    expect(v.safe).toBe(false)
    expect(fatals(v)).toContain('protected-region')
  })

  test('an edit inside the GATT table is refused', () => {
    const plain = makePlain()
    plain[0xc200] = 0x42
    expect(fatals(ota.check(wrap(plain), { stock }))).toContain('protected-region')
  })

  test('an edit inside the flash driver is refused', () => {
    const plain = makePlain()
    plain[0x1120] = 0x42
    expect(fatals(ota.check(wrap(plain), { stock }))).toContain('protected-region')
  })

  test('the override exists but must be asked for explicitly', () => {
    const plain = makePlain()
    plain[0x8200] = 0x42
    const v = ota.check(wrap(plain), { stock, allowProtectedRegions: true })
    expect(v.safe).toBe(true)
  })

  test('an unpatched image is called out rather than silently passing', () => {
    const v = ota.check(stock, { stock })
    expect(v.findings.map((x) => x.code)).toContain('identical')
  })
})

// firmware/ is gitignored, so these only run where the vendor images are present.
const STOCK = 'firmware/TR1906R04-10_OTA.bin'
const OTHER = 'firmware/TR1906R04-1-10_OTA.bin'

describe.if(existsSync(STOCK))('the real vendor images', () => {
  test('stock re-encodes byte-identically and passes every check', async () => {
    const file = new Uint8Array(await Bun.file(STOCK).arrayBuffer())
    const rebuilt = ota.encode(ota.plaintext(file), ota.parseHeader(file))
    expect(rebuilt).toEqual(file)

    const v = ota.check(file)
    expect(fatals(v)).toEqual([])
    expect(v.header?.codeSize).toBe(ota.STOCK_CODE_SIZE)
  })

  test.if(existsSync(OTHER))('the other variant is refused for our unit', async () => {
    const file = new Uint8Array(await Bun.file(OTHER).arrayBuffer())
    expect(fatals(ota.check(file))).toContain('wrong-variant')
  })
})
