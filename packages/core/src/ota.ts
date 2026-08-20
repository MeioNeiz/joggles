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
 * It checks two different things and the second half is younger than the first. The
 * size and structure checks bound an image against the flash map; they were all we
 * had on 2026-08-08, and a stock container over a stock unit passed them and bricked
 * it. "Does the image match the silicon" is the other half, it lives under "Does the
 * image match the silicon?" below, and it needs a dump of the unit to answer.
 *
 * Background and evidence: research/firmware-flashing.md, and
 * research/image-silicon-match.md for the second half.
 */
// Only for the extension's magic word, so the two cannot drift. Nothing here reaches
// the JGX wire, and jgx.ts must never reach this file: it is barrel-reachable and
// this one deliberately is not (`safe-surface.test.ts`).
import * as jgx from './jgx.js'

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

/**
 * The variant string the **APK's bundled image** declares.
 *
 * *Corrected 2026-08-19: the docblock here said "version string our unit reports", and
 * no unit here reports it.* Both pairs read on silicon run `TR1906R04-12`: measured on
 * `GLASSES-12E69E`, and on `GLASSES-12C3EF`'s own surviving application tail, which is
 * byte-identical to it. `TR1906R04-10` is the APK's value and nothing else, so a check
 * that compares an image against this constant is comparing it against the build that
 * bricked unit 1 on 2026-08-08, not against the fleet.
 * `research/variant-mismatch-2026-08-19.md`.
 *
 * It keeps its value and its name because `check()`'s default expectation, the built-in
 * bank labels and the stock-image tests are all about the APK image and are all correct
 * to name it. **What is still owed is the wider fix**: `check()` defaults `expect` to
 * this, so a caller with no `expectVersion` and no dump still measures an image against
 * the APK. Recorded as outstanding rather than changed on a bench night, because
 * flipping the default makes `build-firmware` refuse the APK-derived image outright,
 * which is right but is not a change to make while a probe is clipped on.
 */
export const DEVICE_VERSION = 'TR1906R04-10'

/**
 * The variant every pair here actually runs, *verified* on silicon 2026-08-19.
 *
 * Read off `GLASSES-12E69E` at `abs 0x1e3bc`, and corroborated by the 6,535 bytes of
 * `GLASSES-12C3EF`'s original application still standing above the shorter APK image
 * that overwrote it, which match the donor byte for byte.
 *
 * The vendor app's own OTA gate refuses any unit whose version major is >= 10
 * (`research/firmware-flashing.md`), so it refuses every unit here. Read against this
 * constant that gate stops looking like an obstacle and starts looking like the
 * safeguard the 2026-08-08 commit went around: the bundled image is older than what
 * shipped, and the vendor declines to install it. *derived*, and it is a reading of a
 * gate rather than a statement about anyone's intent.
 */
export const FLEET_VERSION = 'TR1906R04-12'

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
/**
 * The build `PROTECTED_REGIONS` was traced on, and therefore the only build it means
 * anything against.
 *
 * Every offset below is a body offset on the APK's `TR1906R04-10` image. The donor
 * that every real unit runs is 7,532 bytes larger and puts its version string 948
 * bytes further along, so the same offsets land in the middle of different functions.
 *
 * So `comparePatch` reports region findings as **warnings** off this base rather than
 * as refusals, and says why: a wall of protected-region fatals against an image nobody
 * edited there is how someone learns to skip a gate, and a clean pass while the real
 * OTA handler sits somewhere else entirely is the quiet version of the same lie.
 * Diffing two *different* builds is refused outright, which is a separate question.
 *
 * Re-tracing all seven regions on a donor dump is what makes them facts again. Until
 * then a donor-based image is guarded by the silicon half (`opts.reference`), which
 * needs no offsets because it reads the stack, and by SWD's own window guard.
 */
export const PROTECTED_REGIONS_BASE = 'TR1906R04-10'

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

/**
 * The contract, because these combine and the combinations are what callers get wrong.
 *
 * **Every option is independent and every combination is valid.** Nothing here refuses
 * an image for the *shape* of the question asked about it; each option only adds
 * checks. Two pairs are worth stating outright because both have been asked about:
 *
 * - **`reference` and `expectVersion` together are fine, and `expectVersion` wins.**
 *   The dump says what the unit is running now, the expectation says what the image
 *   ought to be, and on any unit mid-rebase those differ for good reasons. A
 *   disagreement is `expectation-differs-from-reference`, a **warning**. It was fatal
 *   for about an hour on 2026-08-20 and that was wrong: the check that matters is the
 *   callback-slot one, which reads the stack rather than the label.
 * - **`stock` needs a baseline that is the same build as the image.** Not the same
 *   *file*, the same build: `PROTECTED_REGIONS` are body offsets, so they only name
 *   real functions on the build they were traced on (`PROTECTED_REGIONS_BASE`). Two
 *   different builds are `stock-base-mismatch`, fatal, and no diff is attempted. The
 *   same build off the traced base still diffs, with `regions-off-base` warning that
 *   the region labels are labels. Diff against the target unit's own application.
 *
 * What each new finding means, in the order a caller meets them:
 *
 * | code | severity | means |
 * | --- | --- | --- |
 * | `expectation-differs-from-reference` | warn | a claim and a measurement disagree. Say which unit you meant |
 * | `wrong-variant` | fatal | the image is a different hardware variant from what is expected. The expectation comes from `expectVersion`, else the dump, else the APK's label |
 * | `no-version-string` | warn, fatal under `forCommit` | the image declares no variant, so nothing can be compared |
 * | `stock-base-mismatch` | fatal | `stock` and the image are different builds. No diff attempted |
 * | `regions-off-base` | warn | same build, but not the one the regions were traced on. Byte counts hold, region names do not |
 * | `override-on-commit` | fatal | `allowProtectedRegions` on a committing check |
 * | `no-reference-dump` | warn, fatal under `forCommit` | nobody asked whether this image belongs on this unit |
 * | `erases-jgx-slots` | warn | the unit carries our extension and staging lands on its slots |
 */
export interface CheckOptions {
  /** Stock image to diff against, as a container file. Enables the patch checks,
   *  which are the ones that stop us removing our own way back. */
  stock?: Uint8Array
  /** Version string the target unit reports. */
  expectVersion?: string
  /** Permit edits inside PROTECTED_REGIONS. There is no CLI flag for this on
   *  purpose: reaching it should require editing code. */
  allowProtectedRegions?: boolean
  /** Raw SWD dump of the unit this image is destined for, read from flash address 0.
   *  Enables the silicon checks: whether the image is the application this unit's BLE
   *  stack expects. There is no option to lift what they find. */
  reference?: Uint8Array
  /**
   * This check is the last thing before bytes are committed to a unit, rather than
   * an offline look at a file.
   *
   * It promotes the findings that mean "nobody asked the question" from warn to
   * fatal. A missing dump is tolerable when someone is inspecting an image on a
   * laptop; it is the whole of the 2026-08-08 mistake when the next step writes
   * flash. Any caller that is about to reach the wire passes this.
   */
  forCommit?: boolean
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

/** Common prefix of every variant string this vendor ships. */
export const VERSION_PREFIX = 'TR1906R04'

const readAscii = (buf: Uint8Array, at: number): string => {
  const end = buf.indexOf(0, at)
  return String.fromCharCode(...buf.subarray(at, end < 0 ? at + 24 : end))
}

/** Where an image declares its variant, and what it declares. */
const versionIn = (plain: Uint8Array): { at: number; version: string } | null => {
  const at = findAscii(plain, VERSION_PREFIX)
  return at < 0 ? null : { at, version: readAscii(plain, at) }
}

/**
 * The variant a reference dump reports, read out of its application region.
 *
 * This is what turns the variant check from a comparison against a constant into a
 * measurement of the unit. The scan is confined to the application region because
 * that is where both builds declare it (body 0x7808 on the APK's, 0x7bbc on the
 * donor's) and a hit anywhere else would not be the application's own declaration.
 */
export function referenceVersion(reference: Uint8Array): string | null {
  const hi = Math.min(FLASH_APP_ADDR + FLASH_APP_SIZE, reference.length)
  if (hi <= FLASH_APP_ADDR) return null
  return versionIn(reference.subarray(FLASH_APP_ADDR, hi))?.version ?? null
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
  //
  // Where the expectation comes from matters more than the comparison does. Defaulting
  // to DEVICE_VERSION measures an image against the APK's build rather than against
  // the fleet, and that default points the wrong way: it refuses the correctly rebased
  // image and waves the APK-derived one through. So a dump, whenever there is one,
  // sets the expectation, and the constant is only the answer when nothing read a unit.
  const fromReference = opts.reference ? referenceVersion(opts.reference) : null
  const expect = opts.expectVersion ?? fromReference ?? DEVICE_VERSION
  if (opts.expectVersion && fromReference && opts.expectVersion !== fromReference) {
    // Reported, never refused. A caller holding both a dump and an expectation is not
    // making a mistake: the dump says what the unit is running *now*, the expectation
    // says what the image should be, and those legitimately differ on any unit
    // mid-rebase. `dump-unit1-2026-08-19-a.bin` is the case in hand, an APK image over
    // the tail of the original, so it reads TR1906R04-10 for a unit whose own firmware
    // was -12. What actually has to match is the BLE stack, and that is
    // `compareDevice`'s callback-slot check rather than a string.
    warn(
      'expectation-differs-from-reference',
      `the expected variant given is "${opts.expectVersion}", which wins, but the ` +
        `reference dump reports "${fromReference}". If those were meant to be the ` +
        'same unit then one of them is not: a filename asserting a provenance ' +
        'nobody checked is how this project has lost time before. The registration ' +
        'check below is unaffected either way, because it reads the stack rather ' +
        'than the label',
    )
  }
  const declared = versionIn(plain)
  if (!declared) {
    f.push({
      severity: opts.forCommit ? 'fatal' : 'warn',
      code: 'no-version-string',
      message:
        `no ${VERSION_PREFIX} version string found, so the variant cannot be ` +
        'confirmed' +
        (opts.forCommit ? '. Nothing unidentifiable goes on a unit' : ''),
    })
  } else if (declared.version !== expect) {
    // Say where the expectation came from. Asserting "the target unit is X" when X
    // is only DEVICE_VERSION reads as a measurement of the device, and it is not
    // one: it sent a cold session hunting a variant mismatch that did not exist.
    const whence = opts.expectVersion
      ? 'the expected variant given is'
      : fromReference
        ? 'the reference dump reports'
        : `nothing here read the unit, and the default expectation is the APK's own ` +
          `value,`
    fatal(
      'wrong-variant',
      `image reports "${declared.version}" but ${whence} "${expect}". These are ` +
        'different hardware variants, or the expectation is wrong: every pair read ' +
        `on silicon runs ${FLEET_VERSION}, so pass a dump as opts.reference rather ` +
        'than trusting the default',
    )
  }

  // The override is a code-only escape hatch for offline work. Reaching the wire with
  // it set is the one combination that cannot be defended: the protected regions are
  // what makes a bad flash recoverable, so an image that edits them is exactly the
  // image an over-the-air commit must not carry.
  if (opts.forCommit && opts.allowProtectedRegions) {
    fatal(
      'override-on-commit',
      'allowProtectedRegions was set on a check that precedes a commit. The regions ' +
        'it lifts are the OTA service, the flash driver and the radio, so lifting ' +
        'them is lifting the way back. Use SWD for an image that has to edit them',
    )
  }

  if (opts.stock) f.push(...comparePatch(opts.stock, file, opts))

  // The 8 August question: is this the application this particular unit runs? Only a
  // dump of that unit can answer it, so say so loudly when there is not one.
  if (opts.reference) {
    f.push(...compareDevice(opts.reference, file))
    f.push(...compareExtension(opts.reference))
  } else {
    f.push({
      severity: opts.forCommit ? 'fatal' : 'warn',
      code: 'no-reference-dump',
      message:
        'no reference dump supplied, so nothing here tested the image against the ' +
        'unit. That is the check 2026-08-08 did not have: pass a raw SWD dump as ' +
        'opts.reference before committing anything',
    })
  }

  return { safe: !f.some((x) => x.severity === 'fatal'), header: h, findings: f }
}

/**
 * What an OTA transfer costs a unit that is already running our own extension.
 *
 * The two are not neighbours, they are the same bytes: `notes/patch-over-bt.md` puts
 * the extension's update slots at `0x29400` onwards, which is `FLASH_DFU_ADDR`, the
 * address every staged image lands at. So staging anything erases both slots, and it
 * does so at `stage` rather than at `commit`, which is the one place in this file
 * where the least committal subcommand still costs something.
 *
 * The resident half sits below the bank and survives, which is the whole point of
 * putting it there: the unit stays reachable by the commands that push a slot again.
 */
export function compareExtension(reference: Uint8Array): Finding[] {
  const hi = Math.min(FLASH_APP_ADDR + FLASH_APP_SIZE, reference.length)
  if (hi <= FLASH_APP_ADDR) return []
  if (findAscii(reference.subarray(FLASH_APP_ADDR, hi), jgx.MAGIC) < 0) return []
  return [
    {
      severity: 'warn',
      code: 'erases-jgx-slots',
      message:
        `this unit carries the ${jgx.MAGIC} extension, and the OTA staging bank at ` +
        `${hex(FLASH_DFU_ADDR)} is where its update slots live, so staging this ` +
        'image erases both of them. The resident half sits below the bank and ' +
        'survives, so the slots can be pushed again over Bluetooth afterwards',
    },
  ]
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

  // Two images can only be diffed byte for byte if they are builds of the same thing,
  // and the region offsets only mean anything on the build they were traced on. Those
  // are two different questions and they get two different answers.
  const base = versionIn(a)
  const cand = versionIn(b)
  const off = (x: { at: number; version: string } | null) =>
    x ? `"${x.version}" at body ${hex(x.at)}` : 'no version string'

  // Different builds entirely: nothing below is worth computing. Diffing the APK's
  // image against a donor-based one reports 60,684 of 66,084 bytes differing and every
  // protected region as edited, and all of it says only "these are different builds".
  if (base?.version !== cand?.version) {
    return [
      {
        severity: 'fatal',
        code: 'stock-base-mismatch',
        message:
          `stock reports ${off(base)} and this image reports ${off(cand)}, so they ` +
          'are different builds rather than one patched against the other. No diff ' +
          'was attempted: every byte after the first difference in layout would ' +
          'report as edited. Diff against the target unit\'s own application, or ' +
          'check the image against a dump with opts.reference',
      },
    ]
  }

  // Same build, but not the one the regions were traced on. The diff itself is sound,
  // so it runs; what cannot be trusted is the labels. Downgraded rather than dropped,
  // because a byte count and an insertion check are still evidence, and because the
  // regions exist to keep *OTA* recovery possible: over SWD they are editable anyway
  // (CLAUDE.md, "Track C: the order once flashing works").
  const onTracedBase = base?.version === PROTECTED_REGIONS_BASE
  if (!onTracedBase) {
    f.push({
      severity: 'warn',
      code: 'regions-off-base',
      message:
        `both images are ${off(base)}, and the protected regions were traced on ` +
        `${PROTECTED_REGIONS_BASE}. Their body offsets name different functions here, ` +
        'so any protected-region finding below is a label rather than a fact. The ' +
        'byte counts are still exact',
    })
  }

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
      severity: opts.allowProtectedRegions || !onTracedBase ? 'warn' : 'fatal',
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

// --- Does the image match the silicon? -------------------------------------------

/**
 * The gate that was missing on 2026-08-08.
 *
 * `check()` above bounds an image against the flash map. Nothing bounded it against
 * the part, so a commit of the vendor's own stock container over a stock unit passed
 * every test we had and bricked `GLASSES-12C3EF`. The reason, established offline in
 * `research/hardfault-0xd38-2026-08-19.md`, is that the application in the APK is not
 * the application that unit was running: the BLE stack below `abs 0x16800` dispatches
 * through a RAM callback slot that no APK application ever registers, so the first
 * boot after the update `bx`es through an uninitialised word.
 *
 * **The rule, not the instance.** Nothing here knows about export indices 89 and 90,
 * or about slot `0x20000074`. Three shapes are recovered from the bytes of whatever
 * dump is handed in, and the rule is stated over them:
 *
 * - a **leaf setter**, `ldr rB,[pc,#imm] / str rS,[rB,#off] / bx lr`, where the
 *   literal is a RAM address. Six bytes, one per callback slot, and the only thing in
 *   the stack that writes one.
 * - a **dispatch trampoline**, `ldr rN,[pc,#imm] / ldr rM,[rN,#off] / bx rM`, again
 *   over a RAM literal. This is how the stack calls out through a slot, and there is
 *   no null check in front of any of them.
 * - the **export table**, found by seeding on the setter addresses (as `addr | 1`)
 *   and growing the run outwards while the words stay Thumb pointers into the stack.
 *   Setters are reachable *only* through it, so using an export is how an application
 *   registers a callback.
 *
 * Then: **every slot the system dispatches through must be one the candidate
 * application writes**, by reading the setter's export entry, by branching to the
 * setter directly, or by storing to the slot itself. A slot that fails all three is
 * dispatched-but-never-registered, which is the 8 August fault by definition rather
 * than by coincidence, and it is fatal.
 *
 * The register-tracking pass that decides which exports an application reads is
 * `exportsRead()`, and it propagates constants as well as literal pool loads. That is
 * not optional: the stock registrar at `abs 0x190a4` reaches the export table as
 * `movs r4,#0xb3 / lsls r4,#9`, which is trap 2 in `research/tools/fwtool.ts`
 * verbatim, and a pass that follows only `ldr rN,[pc]` reports fifteen registrations
 * that exist as missing. Against `firmware/dump-unit1-2026-08-19-a.bin` the pass
 * reads 72 of 92 exports for the stock `TR1906R04-10` application and leaves exactly
 * the four slots `+0x5c` to `+0x68` unregistered, which is what
 * `research/hardfault-0xd38-2026-08-19.md` establishes from the bytes and from a live
 * SRAM capture. That agreement is the only calibration this pass has.
 *
 * **Two limits worth knowing before trusting a pass.**
 *
 * - A slot with no leaf setter is out of scope, deliberately. The interrupt table at
 *   `0x20000080` is written through a register-offset store (`str r1,[r2,r0]`) whose
 *   index cannot be resolved statically, and structs filled through a pointer argument
 *   cannot either. Including them would make every image fail for want of evidence.
 * - The tracker follows literal loads, `mov` between low registers and the shift and
 *   add forms that build an address, and drops a register on anything else. It does
 *   not follow branches, so a base loaded in one block and used in another is
 *   credited. That errs towards *believing* the application registers a slot, i.e.
 *   towards a false pass, which is why the report also names how many slots the
 *   reference's own application leaves unregistered: a healthy pairing should be zero.
 *
 * `research/tools/fwtool.ts` documents the two scanning traps on this image. Both are
 * honoured here: literals are resolved from `ldr`-pool sites rather than matched as
 * raw words, and no claim is made from a raw word scan.
 */

/** SRAM window on this part. A literal outside it is not a RAM pointer. */
export const SRAM_ADDR = 0x20000000
export const SRAM_END = 0x20004000

/** Smallest useful reference dump: the BLE stack plus the whole application region. */
export const REFERENCE_MIN_BYTES = FLASH_APP_ADDR + FLASH_APP_SIZE

/** A function-pointer slot in SRAM that the stack calls out through. */
export interface CallbackSlot {
  /** SRAM address of the slot. */
  slot: number
  /** Flash address of the leaf setter that writes it. */
  setter: number
  /** Index of that setter in the export table, or -1 if it is not exported. */
  exportIndex: number
  /** Flash addresses of the trampolines that `bx` through the slot. */
  dispatchedAt: number[]
  /** Does the candidate application do anything that fills it? */
  registered: boolean
}

export interface DeviceMatch {
  /** Where the export table was found in the reference, and how many entries. */
  exportTable: { addr: number; length: number } | null
  /** Export indices the candidate application reads. */
  exportsUsed: number[]
  /** Every dispatched slot that has a leaf setter, registered or not. */
  slots: CallbackSlot[]
  /** What the device holds in the application region above the candidate's end. */
  orphaned: { bytes: number; lowest: number; highest: number }
  /** Candidate `ldr` literals pointing into the application region above its end. */
  dangling: number[]
  /** Literals the candidate *builds* by shift into that same range. See trap 2. */
  danglingBuilt: number[]
  /** Slots the application the reference itself holds leaves unregistered. */
  referenceUnregistered: number
}

/** A byte range addressed by flash address rather than by offset. */
class View {
  private dv: DataView
  constructor(
    readonly bytes: Uint8Array,
    readonly base: number,
  ) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  get end(): number {
    return this.base + this.bytes.length
  }
  has(a: number, n: number): boolean {
    return a >= this.base && a + n <= this.end
  }
  u16(a: number): number {
    return this.dv.getUint16(a - this.base, true)
  }
  u32(a: number): number {
    return this.dv.getUint32(a - this.base, true)
  }
  /** What a Thumb `ldr rN,[pc,#imm]` at `a` loads, or null if the pool is off the end. */
  literal(a: number): number | null {
    const pool = (((a + 4) >> 2) << 2) + (this.u16(a) & 0xff) * 4
    return this.has(pool, 4) ? this.u32(pool) : null
  }
}

const isRam = (v: number) => (v >>> 0) >= SRAM_ADDR && (v >>> 0) < SRAM_END
const isLdrPc = (h: number) => (h & 0xf800) === 0x4800

/** `ldr rB,[pc,#imm] / str rS,[rB,#off] / bx lr`, over a RAM literal. */
function leafSetters(v: View, lo: number, hi: number): { at: number; slot: number }[] {
  const out: { at: number; slot: number }[] = []
  for (let a = lo; a + 6 <= hi; a += 2) {
    const h0 = v.u16(a)
    if (!isLdrPc(h0)) continue
    const h1 = v.u16(a + 2)
    if ((h1 & 0xf800) !== 0x6000 || ((h1 >> 3) & 7) !== ((h0 >> 8) & 7)) continue
    if (v.u16(a + 4) !== 0x4770) continue
    const lit = v.literal(a)
    if (lit === null || !isRam(lit)) continue
    out.push({ at: a, slot: lit + ((h1 >> 6) & 0x1f) * 4 })
  }
  return out
}

/** `ldr rN,[pc,#imm] / ldr rM,[rN,#off] / bx rM`, over a RAM literal. */
function trampolines(v: View, lo: number, hi: number): { at: number; slot: number }[] {
  const out: { at: number; slot: number }[] = []
  for (let a = lo; a + 6 <= hi; a += 2) {
    const h0 = v.u16(a)
    if (!isLdrPc(h0)) continue
    const h1 = v.u16(a + 2)
    if ((h1 & 0xf800) !== 0x6800 || ((h1 >> 3) & 7) !== ((h0 >> 8) & 7)) continue
    if (v.u16(a + 4) !== (0x4700 | ((h1 & 7) << 3))) continue
    const lit = v.literal(a)
    if (lit === null || !isRam(lit)) continue
    out.push({ at: a, slot: lit + ((h1 >> 6) & 0x1f) * 4 })
  }
  return out
}

/**
 * Locate the export table by seeding on known function addresses.
 *
 * A table entry is the Thumb address of its function, so a setter at `S` appears as
 * `S | 1`. Seeding on addresses we already recovered avoids inventing a table out of
 * whatever run of odd words happens to exist.
 */
function findExportTable(
  v: View,
  lo: number,
  hi: number,
  seeds: number[],
): { addr: number; length: number } | null {
  const wanted = new Set(seeds.map((s) => (s | 1) >>> 0))
  let first = -1
  let last = -1
  for (let a = lo; a + 4 <= hi; a += 4) {
    if (!wanted.has(v.u32(a) >>> 0)) continue
    if (first < 0) first = a
    last = a
  }
  if (first < 0) return null
  const plausible = (a: number) => {
    if (a < lo || a + 4 > hi) return false
    const w = v.u32(a)
    return (w & 1) === 1 && (w & ~1) >= 0x100 && (w & ~1) < hi
  }
  let start = first
  let end = last + 4
  while (plausible(start - 4)) start -= 4
  while (plausible(end)) end += 4
  return { addr: start, length: (end - start) / 4 }
}

/**
 * Which low register a Thumb instruction destroys, as a list. `-1` means none.
 *
 * Deliberately over-broad: anything unrecognised drops the caller-saved registers.
 * Getting this wrong in the generous direction credits an application with a
 * registration it never made, so the conservative reading is the one to keep.
 */
function clobbers(h: number): number[] {
  if (h < 0x2000) return [h & 7]
  if (h < 0x2800) return [(h >> 8) & 7]
  if (h < 0x3000) return []
  if (h < 0x4000) return [(h >> 8) & 7]
  if (h < 0x4400) {
    const op = (h >> 6) & 0xf
    return op === 0x8 || op === 0xa || op === 0xb ? [] : [h & 7]
  }
  if (h < 0x4500) return [(h & 7) | ((h >> 4) & 8)]
  if (h < 0x4600) return []
  if (h < 0x4700) return [(h & 7) | ((h >> 4) & 8)]
  if (h < 0x4780) return []
  if (h < 0x4800) return [0, 1, 2, 3]
  if (h < 0x5000) return [(h >> 8) & 7]
  if (h < 0x5200) return []
  if (h < 0x5400) return [h & 7]
  if (h < 0x5600) return []
  if (h < 0x6000) return [h & 7]
  if (h < 0x6800) return []
  if (h < 0x7000) return [h & 7]
  if (h < 0x7800) return []
  if (h < 0x8000) return [h & 7]
  if (h < 0x8800) return []
  if (h < 0x9000) return [h & 7]
  if (h < 0x9800) return []
  if (h < 0xb000) return [(h >> 8) & 7]
  if (h < 0xbc00) return []
  if (h < 0xc000 || (h >= 0xc800 && h < 0xd000)) {
    const out: number[] = []
    for (let r = 0; r < 8; r++) if (h & (1 << r)) out.push(r)
    return out
  }
  if (h < 0xe800) return []
  return [0, 1, 2, 3]
}

/**
 * Which export indices this code reads, and which RAM words it stores to.
 *
 * A register-tracking pass, because the application never loads the table base: it
 * loads four 64-byte-aligned addresses *inside* the table and indexes off those with
 * `ldr rX,[rB,#imm5]`, so the index is only knowable by following the base register.
 */
function exportsRead(
  v: View,
  lo: number,
  hi: number,
  tbl: { addr: number; length: number },
): { indices: Set<number>; stores: Set<number> } {
  const indices = new Set<number>()
  const stores = new Set<number>()
  const tblEnd = tbl.addr + 4 * tbl.length
  const reg: (number | undefined)[] = new Array(8).fill(undefined)
  const known = (r: number) => reg[r]
  for (let a = lo; a + 2 <= hi; a += 2) {
    const h = v.u16(a)
    if (isLdrPc(h)) {
      reg[(h >> 8) & 7] = v.literal(a) ?? undefined
      continue
    }
    // Trap 2, and the one that cost track 47 a wrong finding: the registrar reaches
    // the export table as `movs r4,#0xb3 / lsls r4,#9`, never as a literal. An
    // address on this part is as likely to be built as stored, so the tracker
    // propagates constants as well as pool loads.
    if ((h & 0xf800) === 0x2000) {
      reg[(h >> 8) & 7] = h & 0xff
      continue
    }
    if ((h & 0xf800) === 0x0000) {
      const src = known((h >> 3) & 7)
      reg[h & 7] = src === undefined ? undefined : (src << ((h >> 6) & 0x1f)) >>> 0
      continue
    }
    if ((h & 0xf800) === 0x1800 || (h & 0xf800) === 0x1c00) {
      const src = known((h >> 3) & 7)
      const add = (h & 0xf800) === 0x1c00 ? (h >> 6) & 7 : known((h >> 6) & 7)
      reg[h & 7] =
        src === undefined || add === undefined ? undefined : (src + add) >>> 0
      continue
    }
    if ((h & 0xf000) === 0x3000) {
      const rd = (h >> 8) & 7
      const cur = known(rd)
      const delta = (h & 0x0800 ? -1 : 1) * (h & 0xff)
      reg[rd] = cur === undefined ? undefined : (cur + delta) >>> 0
      continue
    }
    if ((h & 0xf800) === 0x6800) {
      const base = reg[(h >> 3) & 7]
      // The base being in the table is what makes this an export read. The index can
      // land past the end, which is the mirror defect: an application expecting a
      // newer stack than the unit runs.
      if (base !== undefined && base >= tbl.addr && base < tblEnd) {
        indices.add((base + ((h >> 6) & 0x1f) * 4 - tbl.addr) / 4)
      }
      reg[h & 7] = undefined
      continue
    }
    if ((h & 0xf800) === 0x6000) {
      const base = reg[(h >> 3) & 7]
      if (base !== undefined && isRam(base)) stores.add(base + ((h >> 6) & 0x1f) * 4)
      continue
    }
    if ((h & 0xff00) === 0x4600) {
      const rd = (h & 7) | ((h >> 4) & 8)
      const rs = (h >> 3) & 15
      if (rd < 8 && rs < 8) {
        reg[rd] = reg[rs]
        continue
      }
    }
    for (const r of clobbers(h)) if (r < 8) reg[r] = undefined
    if ((h & 0xf800) === 0xf000) a += 2
  }
  return { indices, stores }
}

/** Targets of every 32-bit Thumb `BL`/`BLX` immediate in a range. */
function branchTargets(v: View, lo: number, hi: number): Set<number> {
  const out = new Set<number>()
  for (let a = lo; a + 4 <= hi; a += 2) {
    const h = v.u16(a)
    if ((h & 0xf800) !== 0xf000) continue
    const l = v.u16(a + 2)
    if ((l & 0xd000) !== 0xd000 && (l & 0xd001) !== 0xc000) continue
    const s = (h >> 10) & 1
    const i1 = 1 - (((l >> 13) & 1) ^ s)
    const i2 = 1 - (((l >> 11) & 1) ^ s)
    let off =
      (s << 24) | (i1 << 23) | (i2 << 22) | ((h & 0x3ff) << 12) | ((l & 0x7ff) << 1)
    if (s) off -= 1 << 25
    out.add(a + 4 + off)
  }
  return out
}

/** Addresses in `[lo,hi)` that this code reaches, by literal and by shift. */
function reachesRange(
  v: View,
  from: number,
  to: number,
  lo: number,
  hi: number,
): { literals: number[]; built: number[] } {
  const literals: number[] = []
  const built: number[] = []
  for (let a = from; a + 2 <= to; a += 2) {
    const h = v.u16(a)
    if (isLdrPc(h)) {
      const lit = v.literal(a)
      if (lit !== null && lit >= lo && lit < hi) literals.push(a)
      continue
    }
    // trap 2: an address is often built rather than stored. movs rN,#imm; lsls rN,#k
    if ((h & 0xf800) !== 0x2000 || a + 4 > to) continue
    const l = v.u16(a + 2)
    const rd = (h >> 8) & 7
    if ((l & 0xf800) !== 0x0000 || (l & 7) !== rd || ((l >> 3) & 7) !== rd) continue
    const sh = (l >> 6) & 0x1f
    if (!sh) continue
    const value = ((h & 0xff) << sh) >>> 0
    if (value >= lo && value < hi) built.push(a)
  }
  return { literals, built }
}

/**
 * Work out whether `image` is the application this `reference` unit's stack expects.
 *
 * `reference` is a raw SWD dump read from flash address 0. `image` is an OTA
 * container, whose plaintext body loads at `FLASH_APP_ADDR`.
 */
export function matchDevice(reference: Uint8Array, image: Uint8Array): DeviceMatch {
  const ref = new View(reference, FLASH_ADDR_START)
  const stackLo = FLASH_SOFTDEVICE_ADDR
  const appRegionEnd = FLASH_APP_ADDR + FLASH_APP_SIZE
  // Clamped, so a partial dump reads as less evidence rather than as an exception.
  const stackHi = Math.min(FLASH_APP_ADDR, ref.end)
  const appHi = Math.min(appRegionEnd, ref.end)
  const plain = plaintext(image)
  const app = new View(plain, FLASH_APP_ADDR)

  const setters = [
    ...leafSetters(ref, stackLo, stackHi),
    ...leafSetters(app, FLASH_APP_ADDR, app.end),
  ]
  const setterOf = new Map<number, number>()
  for (const s of setters) if (!setterOf.has(s.slot)) setterOf.set(s.slot, s.at)

  const dispatch = new Map<number, number[]>()
  for (const t of [
    ...trampolines(ref, stackLo, stackHi),
    ...trampolines(app, FLASH_APP_ADDR, app.end),
  ]) {
    const at = dispatch.get(t.slot)
    if (at) at.push(t.at)
    else dispatch.set(t.slot, [t.at])
  }

  const tbl = findExportTable(
    ref,
    stackLo,
    stackHi,
    setters.map((s) => s.at),
  )
  const indexOfFn = new Map<number, number>()
  if (tbl) {
    for (let i = 0; i < tbl.length; i++) {
      indexOfFn.set((ref.u32(tbl.addr + 4 * i) & ~1) >>> 0, i)
    }
  }

  const empty = { indices: new Set<number>(), stores: new Set<number>() }
  const read = tbl ? exportsRead(app, FLASH_APP_ADDR, app.end, tbl) : empty
  const calls = branchTargets(app, FLASH_APP_ADDR, app.end)
  const refRead = tbl ? exportsRead(ref, FLASH_APP_ADDR, appHi, tbl) : empty
  const refCalls = branchTargets(ref, FLASH_APP_ADDR, appHi)

  const slots: CallbackSlot[] = []
  let referenceUnregistered = 0
  for (const [slot, dispatchedAt] of [...dispatch].sort((a, b) => a[0] - b[0])) {
    const setter = setterOf.get(slot)
    if (setter === undefined) continue
    const exportIndex = indexOfFn.get(setter) ?? -1
    const fills = (
      r: { indices: Set<number>; stores: Set<number> },
      c: Set<number>,
    ) =>
      (exportIndex >= 0 && r.indices.has(exportIndex)) ||
      c.has(setter) ||
      r.stores.has(slot)
    if (!fills(refRead, refCalls)) referenceUnregistered++
    slots.push({
      slot,
      setter,
      exportIndex,
      dispatchedAt,
      registered: fills(read, calls),
    })
  }

  let bytes = 0
  let lowest = -1
  let highest = -1
  for (let a = app.end; a < appHi; a++) {
    if (ref.bytes[a] === 0xff) continue
    bytes++
    if (lowest < 0) lowest = a
    highest = a
  }

  const reach = reachesRange(app, FLASH_APP_ADDR, app.end, app.end, appRegionEnd)
  return {
    exportTable: tbl,
    exportsUsed: [...read.indices].sort((a, b) => a - b),
    slots,
    orphaned: { bytes, lowest, highest },
    dangling: reach.literals,
    danglingBuilt: reach.built,
    referenceUnregistered,
  }
}

/**
 * Refuse an image that does not belong on this unit.
 *
 * Everything here is fatal and there is no option to lift it. The one finding that is
 * not a defect, `no-registration-api`, is fatal too: a gate that cannot run and
 * passes anyway is what we already had on 8 August.
 */
export function compareDevice(reference: Uint8Array, image: Uint8Array): Finding[] {
  const f: Finding[] = []
  const fatal = (code: string, message: string) =>
    f.push({ severity: 'fatal', code, message })

  if (reference.length < REFERENCE_MIN_BYTES) {
    fatal(
      'reference-too-short',
      `reference dump is ${reference.length} bytes, and the BLE stack plus the ` +
        `application region need ${REFERENCE_MIN_BYTES}. Dump from flash address 0`,
    )
    return f
  }

  const m = matchDevice(reference, image)
  if (!m.exportTable) {
    fatal(
      'no-registration-api',
      'no export table found in this reference, so which callbacks the stack ' +
        'expects the application to register cannot be established. Refusing rather ' +
        'than passing an image nothing checked',
    )
    return f
  }

  const missing = m.slots.filter((s) => !s.registered)
  if (missing.length) {
    const named = missing
      .slice(0, 8)
      .map(
        (s) =>
          `${hex(s.slot)} (export ${s.exportIndex}, bx at ${hex(s.dispatchedAt[0])})`,
      )
      .join(', ')
    fatal(
      'unregistered-callback',
      `${missing.length} of ${m.slots.length} callback slots are dispatched through ` +
        "by this unit's BLE stack and never written by this image: " +
        named +
        (missing.length > 8 ? `, and ${missing.length - 8} more` : '') +
        '. There is no null check in front of any of those trampolines, so the ' +
        'first one reached branches to whatever SRAM happens to hold. This is the ' +
        '2026-08-08 brick. For comparison the application this unit already holds ' +
        `leaves ${m.referenceUnregistered} of the same slots unregistered`,
    )
  }

  const over = m.exportsUsed.filter((i) => i >= m.exportTable.length)
  if (over.length) {
    fatal(
      'export-out-of-range',
      `this image reads export ${over.join(', ')} but the stack on this unit ` +
        `publishes ${m.exportTable.length} at ${hex(m.exportTable.addr)}. The ` +
        'application is built against a newer stack than the device is running',
    )
  }

  if (m.orphaned.bytes) {
    fatal(
      'device-holds-more',
      `the device holds ${m.orphaned.bytes} programmed byte(s) in the application ` +
        `region above the end of this image, ${hex(m.orphaned.lowest)} to ` +
        `${hex(m.orphaned.highest)}. The bootloader copies only ceil(codeSize/512) ` +
        'pages, so those bytes survive the update and this image is the tail of a ' +
        'larger application that is not in it',
    )
  }

  if (m.dangling.length) {
    fatal(
      'dangling-reference',
      `${m.dangling.length} ldr literal(s) in this image point into the application ` +
        `region above its own end, the first at ${hex(m.dangling[0])}. The image ` +
        'does not contain what it reads',
    )
  } else if (m.danglingBuilt.length) {
    f.push({
      severity: 'warn',
      code: 'dangling-built',
      message:
        `${m.danglingBuilt.length} shift-constructed constant(s) fall above the end ` +
        `of this image, the first at ${hex(m.danglingBuilt[0])}. Addresses on this ` +
        'part are often built rather than stored, so check these by hand',
    })
  }

  if (!f.length) {
    f.push({
      severity: 'warn',
      code: 'device-match',
      message:
        `all ${m.slots.length} dispatched callback slots are registered, this image ` +
        `covers everything the device holds, and it reads ${m.exportsUsed.length} of ` +
        `${m.exportTable.length} exports`,
    })
  }
  return f
}
