import { beforeAll, describe, expect, test } from 'bun:test'
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

  test('an edit inside the flash program primitive is refused', () => {
    const plain = makePlain()
    plain[0x2860] = 0x42
    expect(fatals(ota.check(wrap(plain), { stock }))).toContain('protected-region')
  })

  test('an edit inside the OTA handoff and reset is refused', () => {
    const plain = makePlain()
    plain[0x6200] = 0x42
    expect(fatals(ota.check(wrap(plain), { stock }))).toContain('protected-region')
  })

  test('the flash driver region reaches the CONFIG0 program sequence', () => {
    // body 0x12ac is the ISPCMD-program store inside the CONFIG0 writer. The region
    // used to end at 0x1290, leaving it editable.
    const plain = makePlain()
    plain[0x12ac] = 0x42
    expect(fatals(ota.check(wrap(plain), { stock }))).toContain('protected-region')
  })

  test('the AES key is patchable but the S-box starts right after it', () => {
    expect(ota.AES_KEY.start + ota.AES_KEY.length).toBe(ota.AES_SBOX_START)
    const plain = makePlain()
    for (let i = 0; i < ota.AES_KEY.length; i++) plain[ota.AES_KEY.start + i] = 0x42
    expect(ota.check(wrap(plain), { stock }).safe).toBe(true)
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

describe('growing the image is how new code gets in', () => {
  /**
   * A fixture with content in it, rather than makePlain's zeros.
   *
   * The insertion check counts how much of the overlap differs, so a mostly-empty
   * image would slide 64 bytes and still look almost identical. Real firmware does
   * not, and neither does this.
   */
  function busy(size = 0x10000): Uint8Array {
    const p = new Uint8Array(size)
    let x = 0x12345678
    for (let i = 0; i < size; i++) {
      x = (x * 1103515245 + 12345) >>> 0
      p[i] = (x >>> 16) & 0xff
    }
    const dv = new DataView(p.buffer)
    dv.setUint32(0x08, 0x20003910, true)
    dv.setUint32(0x0c, 0x00016a01, true)
    const v = ota.DEVICE_VERSION
    for (let i = 0; i < v.length; i++) p[0x7808 + i] = v.charCodeAt(i)
    p[0x7808 + v.length] = 0
    return p
  }

  const base = busy()
  const stock = wrap(base)

  /** Stock with `extra` bytes of new code past the end, i.e. an append. */
  const appended = (extra: number, edit?: number) => {
    const plain = new Uint8Array(base.length + extra)
    plain.set(base)
    plain.fill(0xa5, base.length)
    if (edit !== undefined) plain[edit] = plain[edit] ^ 0xff
    return wrap(plain)
  }

  test('an append is allowed, and named as an append', () => {
    const v = ota.check(appended(64), { stock })
    expect(v.safe).toBe(true)
    expect(v.findings.map((x) => x.code)).toContain('appended')
  })

  test('an append plus an in-place edit still diffs the in-place part', () => {
    const v = ota.check(appended(64, 0xd000), { stock })
    expect(v.safe).toBe(true)
    const summary = v.findings.find((x) => x.code === 'diff-summary')
    expect(summary?.message).toContain('1 byte(s) patched in place')
  })

  test('an append that lands a protected region edit is still refused', () => {
    const v = ota.check(appended(64, 0x8200), { stock })
    expect(fatals(v)).toContain('protected-region')
  })

  test('an insertion, which shifts everything after it, is refused', () => {
    // The dangerous case the length check alone cannot see: same growth, but the
    // new bytes went in at the front, so every absolute address in the image moved.
    const plain = new Uint8Array(base.length + 64)
    plain.set(base.subarray(0, 0x100))
    plain.set(base.subarray(0x100), 0x100 + 64)
    const v = ota.check(wrap(plain), { stock })
    expect(fatals(v)).toContain('looks-like-an-insertion')
  })

  test('a shorter image is flagged rather than passed over', () => {
    const v = ota.check(wrap(base.slice(0, base.length - 64)), { stock })
    expect(v.findings.map((x) => x.code)).toContain('length-changed')
  })

  test('growth past the application region is fatal on size alone', () => {
    const v = ota.check(appended(ota.SAFE_MAX_CODE_SIZE + 4 - base.length), { stock })
    expect(fatals(v)).toContain('erases-info-page')
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

/**
 * A synthetic unit, so the rule can be tested rather than the one instance.
 *
 * The real dump proves the check fires on what actually happened. It cannot prove the
 * check ever passes, because no image we hold matches unit 1. So this builds a tiny
 * stack with the same three shapes the rule is stated over, and an application that
 * registers what it dispatches.
 */
const SLOT_BASE = 0x20000100
const SETTERS = 0x1000
const SET_POOL = 0x1100
const TRAMPS = 0x2000
const TR_POOL = 0x2100
const TABLE = 0x3000
const N_SLOTS = 4

/** imm8 for `ldr rN,[pc,#imm]` at `at` reaching the literal pool at `pool`. */
const pcImm = (at: number, pool: number) => (pool - (((at + 4) >> 2) << 2)) / 4

function makeReference(): Uint8Array {
  const ref = new Uint8Array(ota.REFERENCE_MIN_BYTES)
  const dv = new DataView(ref.buffer)
  const h = (at: number, v: number) => dv.setUint16(at, v, true)

  for (let n = 0; n < N_SLOTS; n++) {
    const at = SETTERS + 6 * n
    h(at, 0x4900 | pcImm(at, SET_POOL)) //      ldr r1, [pc, #..]
    h(at + 2, 0x6000 | (n << 6) | (1 << 3)) //  str r0, [r1, #4n]
    h(at + 4, 0x4770) //                        bx  lr
  }
  dv.setUint32(SET_POOL, SLOT_BASE, true)

  for (let n = 0; n < N_SLOTS; n++) {
    const at = TRAMPS + 8 * n
    h(at, 0x4800 | pcImm(at, TR_POOL)) //       ldr r0, [pc, #..]
    h(at + 2, 0x6800 | (n << 6)) //             ldr r0, [r0, #4n]
    h(at + 4, 0x4700) //                        bx  r0
  }
  dv.setUint32(TR_POOL, SLOT_BASE, true)

  for (let n = 0; n < N_SLOTS; n++) dv.setUint32(TABLE + 4 * n, (SETTERS + 6 * n) | 1, true)

  // Erased application region: the reference holds nothing above any image's end.
  ref.fill(0xff, ota.FLASH_APP_ADDR)
  return ref
}

/** Bytes for a 32-bit Thumb `bl` at `at` reaching `target`. */
function bl(at: number, target: number): [number, number] {
  const off = target - (at + 4)
  const s = (off >>> 24) & 1
  const j1 = (1 - ((off >>> 23) & 1)) ^ s
  const j2 = (1 - ((off >>> 22) & 1)) ^ s
  return [
    0xf000 | (s << 10) | ((off >>> 12) & 0x3ff),
    0xd000 | (j1 << 13) | (j2 << 11) | ((off >>> 1) & 0x7ff),
  ]
}

const APP_CODE = 0x300
const APP_POOL = 0x400

/**
 * An application that registers `slots` by reading their export entries. Anything
 * listed in `direct` is registered by branching to the setter instead.
 */
function makeApp(slots: number[], direct: number[] = []): Uint8Array {
  const plain = makePlain()
  const dv = new DataView(plain.buffer)
  const h = (off: number, v: number) => dv.setUint16(off, v, true)
  const abs = ota.FLASH_APP_ADDR

  let off = APP_CODE
  h(off, 0x4800 | pcImm(abs + off, abs + APP_POOL)) //  ldr r0, [pc, #..]
  off += 2
  for (const n of slots) {
    h(off, 0x6801 | (n << 6)) //                        ldr r1, [r0, #4n]
    off += 2
  }
  for (const n of direct) {
    const [hi, lo] = bl(abs + off, SETTERS + 6 * n)
    h(off, hi)
    h(off + 2, lo)
    off += 4
  }
  dv.setUint32(APP_POOL, TABLE, true)
  return plain
}

describe.if(existsSync(STOCK))('the gate 2026-08-08 did not have', () => {
  const reference = makeReference()

  test('an application that registers every dispatched slot is accepted', () => {
    const v = ota.check(wrap(makeApp([0, 1, 2, 3])), { reference })
    expect(fatals(v)).toEqual([])
    expect(v.findings.map((x) => x.code)).toContain('device-match')
  })

  test('the model is derived from the dump, not from constants', () => {
    const m = ota.matchDevice(reference, wrap(makeApp([0, 1, 2, 3])))
    expect(m.exportTable).toEqual({ addr: TABLE, length: N_SLOTS })
    expect(m.slots.map((s) => s.slot)).toEqual([0, 1, 2, 3].map((n) => SLOT_BASE + 4 * n))
    expect(m.slots.map((s) => s.exportIndex)).toEqual([0, 1, 2, 3])
    expect(m.slots.map((s) => s.setter)).toEqual([0, 1, 2, 3].map((n) => SETTERS + 6 * n))
  })

  test('one missing registration is fatal, and the slot is named', () => {
    const v = ota.check(wrap(makeApp([0, 1, 3])), { reference })
    expect(fatals(v)).toContain('unregistered-callback')
    const f = v.findings.find((x) => x.code === 'unregistered-callback')
    expect(f?.message).toContain('0x20000108')
    expect(f?.message).toContain('1 of 4')
  })

  test('a base built by shift counts, which is the trap that hid the real one', () => {
    // 0xc0 << 6 = 0x3000, the table. The stock registrar reaches abs 0x16600 as
    // movs r4,#0xb3 / lsls r4,#9, and a pass that only follows literal pools reports
    // every slot it registers as missing.
    const plain = makePlain()
    const dv = new DataView(plain.buffer)
    dv.setUint16(APP_CODE, 0x2000 | 0xc0, true) //        movs r0, #0xc0
    dv.setUint16(APP_CODE + 2, 0x0000 | (6 << 6), true) // lsls r0, r0, #6
    for (let n = 0; n < N_SLOTS; n++) {
      dv.setUint16(APP_CODE + 4 + 2 * n, 0x6801 | (n << 6), true) // ldr r1,[r0,#4n]
    }
    expect(fatals(ota.check(wrap(plain), { reference }))).toEqual([])
  })

  test('registering by branching to the setter counts too', () => {
    const v = ota.check(wrap(makeApp([0, 1, 3], [2])), { reference })
    expect(fatals(v)).toEqual([])
  })

  test('writing the slot directly counts too', () => {
    // No export use at all: the application stores to the slot itself.
    const plain = makePlain()
    const dv = new DataView(plain.buffer)
    const abs = ota.FLASH_APP_ADDR
    let off = APP_CODE
    for (let n = 0; n < N_SLOTS; n++) {
      dv.setUint16(off, 0x4900 | pcImm(abs + off, abs + APP_POOL), true) // ldr r1,[pc]
      dv.setUint16(off + 2, 0x6000 | (n << 6) | (1 << 3), true) //          str r0,[r1,#4n]
      off += 4
    }
    dv.setUint32(APP_POOL, SLOT_BASE, true)
    expect(fatals(ota.check(wrap(plain), { reference }))).toEqual([])
  })

  test('there is no flag that lifts it', () => {
    const opts = { reference, allowProtectedRegions: true }
    expect(fatals(ota.check(wrap(makeApp([0, 1, 3])), opts))).toContain(
      'unregistered-callback',
    )
  })

  test('an application built against a newer stack is fatal the other way', () => {
    // Export 9 exists in the application's world and not in this unit's table.
    const v = ota.check(wrap(makeApp([0, 1, 2, 3, 9])), { reference })
    expect(fatals(v)).toContain('export-out-of-range')
  })

  test('content the device holds above the end of the image is fatal', () => {
    const ref = makeReference()
    ref[ota.FLASH_APP_ADDR + 0x12000] = 0x5a
    const v = ota.check(wrap(makeApp([0, 1, 2, 3])), { reference: ref })
    expect(fatals(v)).toContain('device-holds-more')
    const f = v.findings.find((x) => x.code === 'device-holds-more')
    expect(f?.message).toContain('0x28800')
  })

  test('an image that reads what it does not contain is fatal', () => {
    const plain = makeApp([0, 1, 2, 3])
    // A literal pointing past the end of this image, still inside the app region.
    new DataView(plain.buffer).setUint32(APP_POOL + 8, ota.FLASH_APP_ADDR + 0x11000, true)
    const dv = new DataView(plain.buffer)
    const at = ota.FLASH_APP_ADDR + APP_CODE + 0x40
    const pool = ota.FLASH_APP_ADDR + APP_POOL + 8
    dv.setUint16(APP_CODE + 0x40, 0x4a00 | pcImm(at, pool), true)
    expect(fatals(ota.check(wrap(plain), { reference }))).toContain('dangling-reference')
  })

  test('a reference that cannot answer the question refuses rather than passes', () => {
    const blank = new Uint8Array(ota.REFERENCE_MIN_BYTES).fill(0xff)
    expect(fatals(ota.check(wrap(makeApp([])), { reference: blank }))).toContain(
      'no-registration-api',
    )
  })

  test('a dump that is too short to hold the stack is refused', () => {
    const short = reference.slice(0, ota.FLASH_APP_ADDR)
    expect(fatals(ota.check(wrap(makeApp([])), { reference: short }))).toContain(
      'reference-too-short',
    )
  })
})

describe('no dump means the question was not asked', () => {
  test('and check() says so instead of staying quiet', () => {
    const v = ota.check(wrap(makePlain()))
    expect(v.findings.map((x) => x.code)).toContain('no-reference-dump')
    expect(v.safe).toBe(true)
  })
})

const DUMP = 'firmware/dump-unit1-2026-08-19-a.bin'
const OURS = 'firmware/joggles-v1.bin'

describe.if(existsSync(DUMP) && existsSync(STOCK))('against a real unit', () => {
  let reference: Uint8Array
  beforeAll(async () => {
    reference = new Uint8Array(await Bun.file(DUMP).arrayBuffer())
  })

  test('the stock container that bricked a unit is now refused', async () => {
    const file = new Uint8Array(await Bun.file(STOCK).arrayBuffer())
    const v = ota.check(file, { reference })
    expect(fatals(v)).toContain('unregistered-callback')
    // The slot the recorded exception frame came through.
    const f = v.findings.find((x) => x.code === 'unregistered-callback')
    expect(f?.message).toContain('0x20000074')
    expect(fatals(v)).toContain('device-holds-more')
  })

  test('the export table and the callback slots come out of the bytes', async () => {
    const file = new Uint8Array(await Bun.file(STOCK).arrayBuffer())
    const m = ota.matchDevice(reference, file)
    expect(m.exportTable).toEqual({ addr: 0x16600, length: 92 })
    expect(m.exportsUsed.length).toBe(72)
    const faulting = m.slots.find((s) => s.slot === 0x20000074)
    expect(faulting).toMatchObject({ exportIndex: 90, setter: 0x13538, registered: false })
    expect(faulting?.dispatchedAt).toContain(0x10f54)
    // The registrar at abs 0x190a4 stops at +0x58, so these four and only these four.
    // Reading the export base as a literal only would report nineteen.
    expect(m.slots.filter((s) => !s.registered).map((s) => s.slot)).toEqual([
      0x20000070, 0x20000074, 0x20000078, 0x2000007c,
    ])
  })

  const ours = 'our own build inherits the defect and is refused'
  test.if(existsSync(OURS))(ours, async () => {
    const file = new Uint8Array(await Bun.file(OURS).arrayBuffer())
    const v = ota.check(file, { reference })
    expect(v.safe).toBe(false)
    expect(fatals(v)).toContain('unregistered-callback')
    expect(fatals(v)).toContain('device-holds-more')
  })
})

/**
 * The claims `CLAUDE.md` makes about the two images we have built, tested rather than
 * restated, against a dump of a **healthy** unit.
 *
 * The existing block above uses unit 1's pre-repair dump, which holds the APK image
 * over the tail of the original. That proves the check fires on what actually
 * happened. It cannot test the claim that matters for Track C, which is about a
 * healthy donor: `joggles-v1.bin` must be refused for one, and `joggles-v2.bin` must
 * pass for that same one.
 *
 * Neither of those was covered before track 64, and the second was **false as
 * documented**: `check(v2, { reference: donor })` was refused, because the default
 * variant expectation is the APK's `TR1906R04-10` and the correctly rebased image
 * declares the fleet's `TR1906R04-12`. The gate refused the right image and passed
 * the wrong one until the expectation started coming off the dump.
 */
const DONOR = 'firmware/dump-12E69E-2026-08-19-a.bin'
const V2 = 'firmware/joggles-v2.bin'

describe.if(existsSync(DONOR))('against a healthy donor', () => {
  let donor: Uint8Array
  beforeAll(async () => {
    donor = new Uint8Array(await Bun.file(DONOR).arrayBuffer())
  })

  test('the expectation is read off the unit, not off the APK', () => {
    expect(ota.referenceVersion(donor)).toBe(ota.FLEET_VERSION)
    expect(ota.FLEET_VERSION).not.toBe(ota.DEVICE_VERSION)
  })

  const v1 = 'joggles-v1 is refused, and the faulting bx is named'
  test.if(existsSync(OURS))(v1, async () => {
    const file = new Uint8Array(await Bun.file(OURS).arrayBuffer())
    const v = ota.check(file, { reference: donor })
    expect(v.safe).toBe(false)
    const f = v.findings.find((x) => x.code === 'unregistered-callback')
    expect(f?.message).toContain('0x10f54')
    expect(f?.message).toContain('0x20000074')
    expect(f?.message).toContain('4 of 23')
    // A healthy unit's own application leaves none of them unregistered, which is what
    // makes the four an image defect rather than a property of the part.
    expect(f?.message).toContain('leaves 0 of the same slots unregistered')
    // And the wrong-variant half fires now too: the APK's build against a -12 unit.
    expect(fatals(v)).toContain('wrong-variant')
  })

  test.if(existsSync(V2))('joggles-v2 passes with the donor dump alone', async () => {
    const file = new Uint8Array(await Bun.file(V2).arrayBuffer())
    const v = ota.check(file, { reference: donor })
    expect(fatals(v)).toEqual([])
    expect(v.safe).toBe(true)
    const f = v.findings.find((x) => x.code === 'device-match')
    expect(f?.message).toContain('all 23 dispatched callback slots are registered')

    const m = ota.matchDevice(donor, file)
    expect(m.referenceUnregistered).toBe(0)
    expect(m.slots.filter((s) => !s.registered)).toEqual([])
    expect(m.slots.length).toBe(23)
  })

  test.if(existsSync(V2))('and it fills the application region exactly', async () => {
    const file = new Uint8Array(await Bun.file(V2).arrayBuffer())
    expect(ota.parseHeader(file).codeSize).toBe(ota.FLASH_APP_SIZE)
  })

  test('an expectation beside a dump is reported, and the expectation wins', () => {
    // Both together is a valid question, and a common one: the dump says what the unit
    // runs now, the expectation says what the image should be. Refusing it would refuse
    // every check made part-way through a rebase.
    const v = ota.check(wrap(makePlain()), {
      reference: donor,
      expectVersion: ota.DEVICE_VERSION,
    })
    expect(v.findings.map((x) => x.code)).toContain('expectation-differs-from-reference')
    expect(fatals(v)).not.toContain('wrong-variant')
    expect(fatals(v)).not.toContain('expectation-differs-from-reference')
  })

  test('a stock unit carries no extension, so nothing warns about slots', () => {
    expect(ota.compareExtension(donor)).toEqual([])
  })
})

describe('the limits the gate is supposed to encode', () => {
  test('the staging ceiling is the application region, 76,800 bytes', () => {
    // Two different quantities that have to stay equal: the room below the saved
    // content buffer, and the region the bootloader will copy into. Asserted as a
    // relation rather than as two literals, because moving either one silently turns
    // the size check into a bound on something else.
    expect(ota.SAFE_MAX_CODE_SIZE).toBe(ota.FLASH_APP_SIZE)
    expect(ota.FLASH_APP_SIZE).toBe(76800)
  })

  test('the bootloader bound is the ~84 KB one, and it is checked first', () => {
    expect(ota.BOOTLOADER_SAFE_CODE_SIZE).toBe(83968)
    // Ordering matters: an oversized image must be told it would erase the bootloader
    // rather than merely that it would reach the info page.
    const over = fatals(ota.check(wrap(makePlain(ota.BOOTLOADER_SAFE_CODE_SIZE + 4))))
    expect(over).toContain('erases-bootloader')
    expect(over).not.toContain('erases-info-page')
  })

  test('every limit CLAUDE.md credits the gate with is a fatal finding', () => {
    // The four in "Don't": type 2, the application region, the bootloader bound, and
    // the callback registration check that 2026-08-08 did not have.
    const codes = (v: ota.Verdict) => fatals(v)
    expect(codes(ota.check(wrap(makePlain(), ota.OTA_SOFTDEVICE)))).toContain(
      'softdevice-image',
    )
    expect(codes(ota.check(wrap(makePlain(ota.SAFE_MAX_CODE_SIZE + 4))))).toContain(
      'erases-info-page',
    )
    expect(codes(ota.check(wrap(makePlain(ota.BOOTLOADER_SAFE_CODE_SIZE + 4))))).toContain(
      'erases-bootloader',
    )
    expect(typeof ota.compareDevice).toBe('function')
  })
})

describe('a check that precedes a commit demands its evidence', () => {
  test('a missing dump is a warning offline and fatal on the way to the wire', () => {
    const image = wrap(makePlain())
    expect(ota.check(image).safe).toBe(true)
    const v = ota.check(image, { forCommit: true })
    expect(v.safe).toBe(false)
    expect(fatals(v)).toContain('no-reference-dump')
  })

  test('the protected-region override cannot be combined with a commit', () => {
    const v = ota.check(wrap(makePlain()), { forCommit: true, allowProtectedRegions: true })
    expect(fatals(v)).toContain('override-on-commit')
  })

  test('an image that declares no variant at all cannot be committed', () => {
    const plain = new Uint8Array(0x10000)
    const dv = new DataView(plain.buffer)
    dv.setUint32(0x08, 0x20003910, true)
    dv.setUint32(0x0c, 0x00016a01, true)
    expect(fatals(ota.check(wrap(plain), { forCommit: true }))).toContain(
      'no-version-string',
    )
    expect(ota.check(wrap(plain)).safe).toBe(true)
  })
})

describe('the patch diff refuses to run off the base it was traced on', () => {
  /** A plaintext image declaring `version`, otherwise well formed. */
  const onBase = (version: string, at = 0x7808) => {
    const p = new Uint8Array(0x10000)
    const dv = new DataView(p.buffer)
    dv.setUint32(0x08, 0x20003910, true)
    dv.setUint32(0x0c, 0x00016a01, true)
    for (let i = 0; i < version.length; i++) p[at + i] = version.charCodeAt(i)
    return p
  }

  test('the regions declare which build they were traced on', () => {
    expect(ota.PROTECTED_REGIONS_BASE).toBe(ota.DEVICE_VERSION)
  })

  test('a donor-based image against the APK stock is one clear refusal', () => {
    const stock = wrap(onBase(ota.DEVICE_VERSION))
    const patched = wrap(onBase(ota.FLEET_VERSION, 0x7bbc))
    const v = ota.check(patched, { stock, expectVersion: ota.FLEET_VERSION })
    expect(fatals(v)).toContain('stock-base-mismatch')
    // And not the wall of eight it used to be, every one of them wrong.
    expect(fatals(v)).not.toContain('protected-region')
    expect(fatals(v)).not.toContain('looks-like-an-insertion')
  })

  test('two images on the same base that is not the traced one still diff', () => {
    // The fail-silent half. Their bytes are comparable, so the count is real, but the
    // region labels are the APK's layout and name different functions here. The diff
    // runs and says so, rather than passing cleanly as if the labels held: that is
    // what the SWD path needs, since it diffs against the target's own application.
    const stock = wrap(onBase(ota.FLEET_VERSION, 0x7bbc))
    const patched = onBase(ota.FLEET_VERSION, 0x7bbc)
    patched[0x8200] = 0x42 // inside what is the OTA handler on the APK's build only
    const v = ota.check(wrap(patched), { stock, expectVersion: ota.FLEET_VERSION })
    const codes = v.findings.map((x) => x.code)
    expect(codes).toContain('regions-off-base')
    expect(codes).toContain('diff-summary')
    // Named, but as a label rather than a refusal.
    expect(fatals(v)).not.toContain('protected-region')
    expect(v.safe).toBe(true)
  })

  test('an image with no version string at all cannot be diffed', () => {
    const stock = wrap(onBase(ota.DEVICE_VERSION))
    const blank = new Uint8Array(0x10000)
    const dv = new DataView(blank.buffer)
    dv.setUint32(0x08, 0x20003910, true)
    dv.setUint32(0x0c, 0x00016a01, true)
    expect(fatals(ota.check(wrap(blank), { stock }))).toContain('stock-base-mismatch')
  })

  test('a diff on the traced base is unaffected', () => {
    const stock = wrap(onBase(ota.DEVICE_VERSION))
    const patched = onBase(ota.DEVICE_VERSION)
    patched[0x8200] = 0x42
    expect(fatals(ota.check(wrap(patched), { stock }))).toContain('protected-region')
  })
})
