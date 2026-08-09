/**
 * OTA container codec and pre-flight safety checks.
 *
 * The constants below deliberately mirror Panchip's own `section_cfg.h` from the
 * PAN1020 SDK, names included, so the two can be diffed by eye. Everything the
 * vendor did not define is marked as ours.
 *
 * Why this file exists at all: the device accepts images that destroy it. Its only
 * size check is `codeSize < 0x19000`, while the staging bank has just 0x14800 bytes
 * below the bootloader. Nothing else in the flash path validates anything, and there
 * is no signature. So the guard rails have to live here, on our side of the wire.
 *
 * `check()` is the mandatory gate. Any future BLE write path must refuse to send an
 * image that has not passed it.
 *
 * Background and evidence: research/firmware-flashing.md.
 */

// --- Flash map: Panchip section_cfg.h, verbatim names ---------------------------

export const FLASH_ADDR_START = 0x00000000
export const FLASH_ADDR_END = 0x00040000
export const FLASH_PAGE_SIZE = 0x0200

/** BLE stack. Not the bootloader, despite occupying the bottom of flash. */
export const FLASH_SOFTDEVICE_ADDR = 0x00000000
export const FLASH_SOFTDEVICE_SIZE = 0x00016800

export const FLASH_APP_ADDR = 0x00016800
export const FLASH_APP_SIZE = 0x00012c00

/** OTA staging bank. Incoming images land here, never at FLASH_APP_ADDR. */
export const FLASH_DFU_ADDR = 0x00029400

export const FLASH_ADDR_INFO = 0x0003d800
export const FLASH_ADDR_INFO_BACKUP = 0x0003da00
export const FLASH_BOOTLOADER_ADDR = 0x0003dc00

/** Section flags, written to the info page so the bootloader knows the target. */
export const SECTION_SOFTDEVICE_FLAG = 0xdbd2
export const SECTION_APP_FLAG = 0xdbc3

/** Image type, the second byte of OTA control opcode 2. */
export const OTA_APP = 1
export const OTA_SOFTDEVICE = 2

// --- Ours: facts about this vendor's build, not in the SDK ----------------------

/** Saved DATS content. Sits inside the nominal staging bank, so it is the first
 *  casualty of an oversized image. */
export const FLASH_SAVED_CONTENT_ADDR = 0x0003c000

/** The only bound the device enforces: it rejects codeSize >= this. Far too
 *  generous, hence SAFE_MAX_CODE_SIZE below. */
export const DEVICE_MAX_CODE_SIZE = 0x19000

/** Stock TR1906R04-10 body length. The recommended ceiling for anything we build. */
export const STOCK_CODE_SIZE = 66084

/** Version string our unit reports. Flashing the other variant is a known hazard. */
export const DEVICE_VERSION = 'TR1906R04-10'

/** Largest image that touches nothing but the staging bank. */
export const SAFE_MAX_CODE_SIZE = FLASH_SAVED_CONTENT_ADDR - FLASH_DFU_ADDR

/** Largest image that leaves the bootloader intact. Past this, only SWD recovers. */
export const BOOTLOADER_SAFE_CODE_SIZE = FLASH_BOOTLOADER_ADDR - FLASH_DFU_ADDR

/**
 * Regions of the plaintext image that must never change, as body offsets.
 *
 * These are what makes the device recoverable. Patch any of them and a bad flash
 * can no longer be undone over the air, because the OTA service, the flash driver
 * or the radio would be gone. Addresses come from the disassembly; see
 * research/firmware-flashing.md for the landmark table. Ranges are padded outwards
 * because the exact function ends were not all traced.
 *
 * Three of these came from auditing every site in the image that loads the FMC base
 * or SYS_REGLCTL against this list; 21 of 41 fell outside it and three of those
 * mattered:
 *
 * - 'flash program primitive' (abs 0x1904c) writes the staged pages and is called
 *   only from the OTA handler. It was entirely unprotected.
 * - 'FMC flash driver' ended at 0x1290, which covered the CONFIG0 erase but not the
 *   program sequence that follows it. Extended to 0x1322, the end of the block.
 * - 'OTA handoff and reset' (abs 0x1c9c8) flips the boot select to LDROM and resets.
 *   Break it and OTAs stage, pass CRC, write the record, and never apply.
 */
export const PROTECTED_REGIONS = [
  { name: 'image head and startup stub', start: 0x0000, end: 0x0200 },
  { name: 'FMC flash driver', start: 0x1118, end: 0x1322 },
  { name: 'flash program primitive', start: 0x2840, end: 0x28a8 },
  { name: 'OTA handoff and reset', start: 0x61c0, end: 0x6290 },
  { name: 'OTA handler', start: 0x8100, end: 0x8700 },
  { name: 'OTA payload descrambler', start: 0x9180, end: 0x9200 },
  { name: 'GATT table, including the fd00 OTA service', start: 0xc1e8, end: 0xc350 },
] as const

/**
 * The AES key is 16 bytes and the AES S-box begins at the very next byte
 * (`abs 0x22ba4`, body 0xc3a4). A 17-byte key write corrupts the cipher in both
 * directions. Not a protected region, because patching the key is intended; this is
 * here so a key-swap tool can assert its own bounds.
 */
export const AES_KEY = { start: 0xc394, length: 16 } as const
export const AES_SBOX_START = 0xc3a4

// --- Container codec ------------------------------------------------------------

/** Seed for the obfuscation pad. Panchip's stock DECODE_KEY is 12345678. */
export const PAD_SEED = 0x37627996
const PAD_LEN = 128
export const HEADER_SIZE = 16

const rotr = (v: number, n: number) => ((v >>> n) | (v << (32 - n))) >>> 0

export const pad = (() => {
  const p = new Uint8Array(PAD_LEN)
  for (let n = 0; n < 32; n++) {
    const w = rotr(PAD_SEED, n)
    p[n * 4] = (w >>> 24) & 0xff
    p[n * 4 + 1] = (w >>> 16) & 0xff
    p[n * 4 + 2] = (w >>> 8) & 0xff
    p[n * 4 + 3] = w & 0xff
  }
  return p
})()

/** Involution: the same operation obfuscates and deobfuscates. */
export function deobfuscate(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length)
  for (let i = 0; i < body.length; i++) out[i] = body[i] ^ pad[i % PAD_LEN]
  return out
}

/** The device computes this in hardware, via FMC ISPCMD 0x2d, over the staged
 *  plaintext. Standard CRC-32, poly 0xedb88320. */
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (const x of b) {
    c = (c ^ x) >>> 0
    for (let k = 0; k < 8; k++) c = c & 1 ? ((c >>> 1) ^ 0xedb88320) >>> 0 : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

export interface Header {
  codeSize: number
  crc32: number
  appVer: number
  devVer: number
  proVer: number
  type: number
}

export function parseHeader(file: Uint8Array): Header {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength)
  return {
    codeSize: dv.getUint32(0, true),
    crc32: dv.getUint32(4, true),
    appVer: dv.getUint16(8, true),
    devVer: dv.getUint16(10, true),
    proVer: dv.getUint16(12, true),
    type: file[14],
  }
}

/** Body of a container file, still obfuscated. */
export const rawBody = (file: Uint8Array): Uint8Array => file.subarray(HEADER_SIZE)

/** Deobfuscated body, i.e. the image the device will actually execute. */
export const plaintext = (file: Uint8Array): Uint8Array => deobfuscate(rawBody(file))

/** Build a flashable container from plaintext. Recomputes size and CRC. */
export function encode(plain: Uint8Array, h: Omit<Header, 'codeSize' | 'crc32'>): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + plain.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, plain.length, true)
  dv.setUint32(4, crc32(plain), true)
  dv.setUint16(8, h.appVer, true)
  dv.setUint16(10, h.devVer, true)
  dv.setUint16(12, h.proVer, true)
  out[14] = h.type
  out.set(deobfuscate(plain), HEADER_SIZE)
  return out
}

// --- Pre-flight checks ----------------------------------------------------------

export type Severity = 'fatal' | 'warn'

export interface Finding {
  severity: Severity
  code: string
  message: string
}

export interface Verdict {
  safe: boolean
  header: Header | null
  findings: Finding[]
}

export interface CheckOptions {
  /** Stock image to diff against, as a container file. Enables the patch checks,
   *  which are the ones that stop us removing our own way back. */
  stock?: Uint8Array
  /** Version string the target unit reports. */
  expectVersion?: string
  /** Permit edits inside PROTECTED_REGIONS. There is no CLI flag for this on
   *  purpose: reaching it should require editing code. */
  allowProtectedRegions?: boolean
}

const hex = (n: number) => '0x' + (n >>> 0).toString(16)

const findAscii = (buf: Uint8Array, needle: string): number => {
  const pat = [...needle].map((c) => c.charCodeAt(0))
  outer: for (let i = 0; i + pat.length <= buf.length; i++) {
    for (let k = 0; k < pat.length; k++) if (buf[i + k] !== pat[k]) continue outer
    return i
  }
  return -1
}

/**
 * Everything that must hold before an image is allowed near the device.
 *
 * A `fatal` finding means do not send this, at all. A `warn` means it will work
 * but is outside what we have evidence for.
 */
export function check(file: Uint8Array, opts: CheckOptions = {}): Verdict {
  const f: Finding[] = []
  const fatal = (code: string, message: string) => f.push({ severity: 'fatal', code, message })
  const warn = (code: string, message: string) => f.push({ severity: 'warn', code, message })

  if (file.length <= HEADER_SIZE) {
    fatal('truncated', `file is ${file.length} bytes, too short to hold a header`)
    return { safe: false, header: null, findings: f }
  }

  const h = parseHeader(file)
  const body = rawBody(file)
  const plain = deobfuscate(body)

  // Container integrity. The device checks the CRC but nothing else.
  if (h.codeSize !== body.length) {
    fatal('size-mismatch', `header codeSize ${h.codeSize} but body is ${body.length} bytes`)
  }
  if (h.codeSize === 0) {
    fatal('empty', 'codeSize is 0, which the device rejects')
  }
  if (h.codeSize % 4 !== 0) {
    fatal(
      'not-word-aligned',
      `codeSize ${h.codeSize} is not a multiple of 4. The device writes ` +
        'whole words, so the trailing bytes are dropped and the CRC then fails',
    )
  }
  if (crc32(plain) !== h.crc32) {
    fatal(
      'crc-mismatch',
      `header CRC ${hex(h.crc32)} but plaintext CRC is ${hex(crc32(plain))}. ` +
        'Re-encode with encode(), which recomputes it',
    )
  }

  // Section type. Type 2 aims the bootloader at the BLE stack.
  if (h.type === OTA_SOFTDEVICE) {
    fatal(
      'softdevice-image',
      'type 2 flags this as a BLE stack image, so the bootloader would write it ' +
        `to ${hex(FLASH_SOFTDEVICE_ADDR)} and replace the radio. Only type 1 is safe`,
    )
  } else if (h.type !== OTA_APP) {
    fatal(
      'unknown-type',
      `type ${h.type} matches no section flag, so the info record would carry ` +
        'stale SRAM contents and the bootloader behaviour is undefined',
    )
  }

  // Size, against the real flash layout rather than the device's own loose bound.
  if (h.codeSize >= DEVICE_MAX_CODE_SIZE) {
    fatal('device-rejects', `codeSize ${h.codeSize} is at or above the device bound ${DEVICE_MAX_CODE_SIZE}`)
  } else if (h.codeSize > BOOTLOADER_SAFE_CODE_SIZE) {
    fatal(
      'erases-bootloader',
      `codeSize ${h.codeSize} exceeds ${BOOTLOADER_SAFE_CODE_SIZE}, so staging ` +
        `would erase the bootloader at ${hex(FLASH_BOOTLOADER_ADDR)}. Only SWD recovers this`,
    )
  } else if (h.codeSize > SAFE_MAX_CODE_SIZE) {
    fatal(
      'erases-info-page',
      `codeSize ${h.codeSize} exceeds ${SAFE_MAX_CODE_SIZE}, so staging would ` +
        `overrun into saved content at ${hex(FLASH_SAVED_CONTENT_ADDR)} and the info pages`,
    )
  } else if (h.codeSize > STOCK_CODE_SIZE) {
    warn('larger-than-stock', `codeSize ${h.codeSize} is larger than stock (${STOCK_CODE_SIZE})`)
  }

  // Will it boot? The head is not a Cortex-M vector table: body 0x08 is the initial
  // SP and body 0x0c the entry vector.
  if (plain.length >= 0x10) {
    const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)
    const sp = dv.getUint32(0x08, true)
    const entry = dv.getUint32(0x0c, true)
    if ((sp & 0xffff0000) !== 0x20000000) {
      fatal('bad-stack-pointer', `initial SP ${hex(sp)} is not in SRAM at 0x20000000`)
    }
    if ((entry & 1) !== 1) {
      fatal('bad-entry-vector', `entry vector ${hex(entry)} is even, so not a Thumb address`)
    }
    const target = entry & ~1
    if (target < FLASH_APP_ADDR || target >= FLASH_APP_ADDR + FLASH_APP_SIZE) {
      fatal(
        'entry-out-of-range',
        `entry vector ${hex(entry)} points outside the application region. ` +
          `An image linked for the wrong base is the classic way to brick this family`,
      )
    }
  }

  // Variant. The two stock images are different hardware, and the vendor app will
  // happily flash the wrong one.
  const expect = opts.expectVersion ?? DEVICE_VERSION
  const at = findAscii(plain, 'TR1906R04')
  if (at < 0) {
    warn('no-version-string', 'no TR1906R04 version string found, so the variant cannot be confirmed')
  } else {
    const end = plain.indexOf(0, at)
    const found = String.fromCharCode(...plain.subarray(at, end < 0 ? at + 24 : end))
    if (found !== expect) {
      fatal(
        'wrong-variant',
        `image reports "${found}" but the target unit is "${expect}". ` +
          'These are different hardware variants',
      )
    }
  }

  if (opts.stock) f.push(...comparePatch(opts.stock, file, opts))

  return { safe: !f.some((x) => x.severity === 'fatal'), header: h, findings: f }
}

/**
 * Diff a patched image against stock and refuse edits that remove our way back.
 *
 * The realistic brick is not a failed transfer, it is shipping an image that no
 * longer brings up BLE. Since the OTA service lives in the application, patching
 * the radio, the GATT table or the OTA handler is self-sealing.
 */
export function comparePatch(
  stock: Uint8Array,
  patched: Uint8Array,
  opts: CheckOptions = {},
): Finding[] {
  const f: Finding[] = []
  const a = plaintext(stock)
  const b = plaintext(patched)

  // Growing is how new code gets in: the free flash between the end of the image
  // and the staging bank is where an extension lives. That is not the same as an
  // insertion, which shifts everything after it and breaks every absolute address
  // in the image. The two are told apart by where the extra bytes went, so the
  // in-place bytes are still compared one for one below.
  if (b.length > a.length) {
    f.push({
      severity: 'warn',
      code: 'appended',
      message:
        `${b.length - a.length} byte(s) appended at body ${hex(a.length)}, past the ` +
        `end of stock. Nothing that already existed moves, and the bytes below ` +
        'stock length are still diffed one for one',
    })
  } else if (b.length < a.length) {
    f.push({
      severity: 'warn',
      code: 'length-changed',
      message:
        `patched body is ${b.length} bytes against stock ${a.length}. A shorter ` +
        'image means content was removed rather than patched in place',
    })
  }

  const n = Math.min(a.length, b.length)
  const diffs: number[] = []
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) diffs.push(i)

  // An insertion shows up as a diff running to the end of the overlap, because
  // everything after the insertion point has slid. A handful of in-place edits does
  // not. This is a heuristic and it knows it: an insertion into a region that is
  // mostly zero padding would slide quietly past. The real guarantee is upstream, in
  // patch.ts, which can only append past the end of the image and refuses anything
  // that would shift an existing address.
  if (b.length !== a.length && diffs.length > n / 2) {
    f.push({
      severity: 'fatal',
      code: 'looks-like-an-insertion',
      message:
        `${diffs.length} of ${n} overlapping bytes differ, which is what a shift ` +
        'looks like rather than a patch. Absolute addresses in the image would break',
    })
  }

  if (diffs.length === 0 && a.length === b.length) {
    f.push({ severity: 'warn', code: 'identical', message: 'identical to stock, nothing patched' })
    return f
  }

  for (const region of PROTECTED_REGIONS) {
    const hits = diffs.filter((i) => i >= region.start && i < region.end)
    if (hits.length === 0) continue
    f.push({
      severity: opts.allowProtectedRegions ? 'warn' : 'fatal',
      code: 'protected-region',
      message:
        `${hits.length} byte(s) changed inside "${region.name}" ` +
        `(body ${hex(region.start)}-${hex(region.end)}, first at body ${hex(hits[0])}). ` +
        'This region is what makes a bad flash recoverable over the air',
    })
  }

  f.push({
    severity: 'warn',
    code: 'diff-summary',
    message:
      `${diffs.length} byte(s) patched in place` +
      (diffs.length ? `, body ${hex(diffs[0])} to ${hex(diffs[diffs.length - 1])}` : ''),
  })
  return f
}

/** Human-readable report. Used by `bun cli ota-check`. */
export function report(v: Verdict): string {
  const lines: string[] = []
  if (v.header) {
    const h = v.header
    lines.push(
      `codeSize ${h.codeSize}  crc32 ${hex(h.crc32)}  ` +
        `app=${h.appVer} dev=${h.devVer} pro=${h.proVer} type=${h.type}`,
    )
  }
  for (const x of v.findings) {
    lines.push(`  ${x.severity === 'fatal' ? 'FATAL' : 'warn '}  ${x.code}: ${x.message}`)
  }
  lines.push(v.safe ? 'PASS: no fatal findings' : 'REFUSED: do not send this image')
  return lines.join('\n')
}
