#!/usr/bin/env bun
/**
 * Put an application image on a unit over SWD, through the FMC's ISP registers.
 *
 *   bun research/tools/swdflash.ts plan   <image> [--from <dump.bin>] [flags]
 *   bun research/tools/swdflash.ts script <image> --from <dump.bin> --yes [flags]
 *   bun research/tools/swdflash.ts donor  <donor.bin> <donor-b.bin> [...] --to <dump.bin>
 *   bun research/tools/swdflash.ts verify <dump.bin> [image] [--donor <donor.bin>]
 *
 *     --from <dump.bin>  an SWD dump of the unit about to be flashed. Required for
 *                        `script`, because the precondition and the canaries are
 *                        read out of it and there is no other way to know what the
 *                        unit currently holds
 *     --to <dump.bin>    the same thing, for `donor`, where `--from` would read as
 *                        the source. Required
 *     --keep <lo>-<hi>   in `donor`, take this span from the target rather than from
 *                        the donor. Repeatable. For anything found to be per-unit
 *     --out <file.tcl>   where the generated script goes. Default firmware/
 *     --stock <file>     baseline to diff against: an OTA container or a raw dump.
                     Default is the --from dump's own application, not the APK. Default the vendor one
 *     --resume           skip pages the dump already shows holding the image. They
 *                        are still read back and verified, just not rewritten
 *     --blank-tail       also erase the rest of the application region, so nothing
 *                        of a longer previous image survives past the new one
 *     --config0 <hex>    the word at 0x00300000, watched as a canary
 *     --ldrom <hex>      the word at 0x00100000, likewise
 *     --speed <kHz>      adapter speed for the session. Default 100
 *
 * ## Donor mode
 *
 * `research/hardfault-0xd38-2026-08-19.md`: the application in the vendor APK is not the
 * application this hardware runs, and no copy of the real one exists in any file we
 * have. The only copies are on the working pairs. So the repair for unit 1 is to read a
 * working unit and write its application region across, and `donor` is that: the source
 * is a **dump**, not an image file, and the destination is the same one window as ever.
 *
 * It is the same generator, the same script and the same five safety layers. Four
 * things are added, all of them refusals:
 *
 *  - **The two units must share a BLE stack, byte for byte.** The region below
 *    `WINDOW.start` is the one this tool never writes and the one the application
 *    registers its callbacks into, so identical stacks is the strongest available
 *    statement that the donor's application belongs on the target. It is also what
 *    authorises a donor whose variant label differs from the target's, which is the
 *    real case here: see the variant argument in `readDonor`.
 *  - **Two donor dumps at least, and they must agree byte for byte.** The donor is the
 *    only surviving copy of a working application. A flaky read of it would be written
 *    into the target permanently and would look exactly like a firmware bug afterwards.
 *  - **A donor byte-identical to the APK plaintext is refused.** That is the defective
 *    build, and copying it across achieves nothing but 150 page erases.
 *  - **The two units are compared before anything is written**, run by run, and the
 *    report lists every span where they differ. Nothing here can prove a span is not
 *    per-unit; what it can do is put the evidence in front of the person holding the
 *    probe at the moment it first exists.
 *
 * ## This file talks to no device
 *
 * It reads files and writes one OpenOCD script, so running it is always safe. The
 * script is the thing that writes flash. That split is deliberate and it is the rule
 * in `research/hardware-access.md`: read scripts and write scripts live in separate
 * files, invoked separately, so a write procedure is never loaded during a read
 * session. It also means the entire plan is auditable as text before anything is
 * energised, and that this tool is unit-testable with no hardware attached.
 *
 * ## What has been driven on silicon, and what has not
 *
 * Reading is *verified* and routine: three byte-identical 256 KB dumps on 2026-08-19.
 * Writing is no longer hypothetical either. Later the same day the config repair erased
 * `0x00300000` with ISPCMD `0x22`, read all four words back as `0xffffffff`, and
 * reprogrammed three of them with ISPCMD `0x21`, verifying each. So the FMC base, the
 * `0x59/0x16/0x88` unlock keys, the ISPCON bits, both write opcodes and the ISPTRG poll
 * are all *verified* on this part: `research/hardware-access.md`, "The FMC write path".
 *
 * Two differences make the first run of **this** script still an experiment, and they
 * are the reason none of the safety below is relaxed. That session set `CFGUEN` and
 * never `APUEN`, so **no erase or program has ever been aimed at the application
 * region**; and it wrote four words, where this writes up to 19,200.
 * `notes/swd-flashing.md` says what that means.
 *
 * ## Safe by construction, in five layers
 *
 *  1. **One window.** `WINDOW` is the application region, 0x16800 to 0x29400, and
 *     nothing else. A page outside it is refused here, and the generated script
 *     re-checks every single address in its own `guard` proc, so a bug in this file
 *     still cannot reach the BLE stack, the info pages or the bootloader.
 *  2. **One update-enable bit.** ISPCON is set to ISPEN | APUEN | ISPFF and never
 *     anything else, so for the whole session the hardware refuses every write to the
 *     config page (CFGUEN clear) and the LDROM (LDUEN clear). The script asserts that
 *     after setting it, and stops if either bit came back set.
 *  3. **No chip erase.** ISPCMD `0x23` appears nowhere, `ISPCMD_VALUES` is the closed
 *     set of two opcodes this tool can emit, and `swdflash.test.ts` fails the build
 *     if a third ever appears or if the script writes any other value to ISPCMD.
 *     (*Corrected 2026-08-20*: nine files in this repo, four lines of this one among
 *     them, called chip erase `0x26`. The vendor's own `fmc.h` says
 *     `FMC_ISPCMD_CPERASE 0x23`, and `0x26` is not a command at all
 *     (`research/fmc-erase-program.md`). The closed set was never affected; every
 *     guard that named a number named the wrong one.)
 *  4. **Erase and program are one operation.** The script's `write_page` erases,
 *     proves the page reads back erased, then programs. `program_word` has exactly
 *     one call site and it is inside that proc. Programming a page that was not
 *     erased silently stores wrong data, which is a documented trap; here it is not
 *     warned about, it is unreachable.
 *  5. **Two confirmations.** `--yes` to emit the script at all, and the script itself
 *     refuses to run unless OpenOCD is given the image's own CRC32 as a token, so a
 *     stale command line cannot flash the wrong image.
 *
 * ## Verify before and after
 *
 * Before: witness words read straight out of the dump, checked **before the FMC is
 * unlocked**, so a device that is not the one the dump came from aborts the session
 * with everything still locked. After: every word written is read back, and the
 * canaries outside the window are read twice, before and after, so a write that
 * escaped the window would be caught rather than assumed impossible.
 *
 * ## What it reuses
 *
 * `ota.check` is the gate and runs before a page plan is even computed, and it is given
 * the target's dump as its `reference` whenever there is one, so the question it answers
 * is "will this unit run this" and not only "is this an image". `dumpcheck` supplies the
 * dump window, the repeat-dump comparison, the reference-image trim and the
 * after-the-fact comparison. Nothing here reimplements them.
 */
import * as ota from '../../packages/core/src/ota.js'
import {
  at,
  census,
  compareDumps,
  compareImage,
  covers,
  dump,
  extensionIn,
  fillOf,
  hx,
  referenceImage,
  REGIONS,
  type Dump,
} from './dumpcheck.js'

// --- The FMC, verified from the vendor's own config writer at abs 0x17a78 ----------

export const FMC = {
  ISPCON: 0x5000c000,
  ISPADR: 0x5000c004,
  ISPDAT: 0x5000c008,
  ISPCMD: 0x5000c00c,
  ISPTRG: 0x5000c010,
  WRPROT: 0x50000100,
} as const

/** The three writes that unlock SYS_WRPROT. *verified* on silicon 2026-08-19. */
export const UNLOCK_KEYS = [0x59, 0x16, 0x88] as const

/** ISPCON bit positions. ISPFF is write-1-to-clear. */
export const ISPCON = {
  ISPEN: 1 << 0,
  /** Boot select, and it is WRITABLE. See `ISPCON_KEEP`. */
  BS: 1 << 1,
  /** SPROM, the ID block at 0x00200000. Nothing in this repo has ever read it. */
  SPUEN: 1 << 2,
  APUEN: 1 << 3,
  CFGUEN: 1 << 4,
  LDUEN: 1 << 5,
  ISPFF: 1 << 6,
} as const

/**
 * The update-enable bits that must be clear for the whole session. There are **four**,
 * not three: `SPUEN` gates the SPROM at `0x00200000`, which the vendor's `config.h`
 * calls the ID block and which no dump in this project covers, since every one is
 * `0x0`-`0x3ffff`. *verified* 2026-08-20, `research/fmc-erase-program.md`.
 */
export const ISPCON_MUST_BE_CLEAR = ISPCON.SPUEN | ISPCON.CFGUEN | ISPCON.LDUEN

/**
 * The only value this tool ever writes to ISPCON, and the reason it is a constant
 * rather than a computed expression: APUEN is the one update-enable bit an APROM
 * write needs, and CFGUEN and LDUEN must stay clear so the config page and the LDROM
 * are refused by hardware for the whole session.
 */
export const ISPCON_APROM = ISPCON.ISPEN | ISPCON.APUEN | ISPCON.ISPFF

/**
 * Bits of whatever the boot ROM left in ISPCON that the script preserves.
 *
 * The script read-modify-writes ISPCON rather than storing `ISPCON_APROM` over it,
 * because bit 1 is `BS`, boot select, and it is writable: it comes up as the inverse of
 * `CONFIG0[7]` after a reset, and a wholesale store decides it. On both units in hand
 * `CONFIG0` bit 7 is 1, so `BS` reads 0 and `0x49` would have left it at 0 anyway. The
 * standing rule in `research/hardware-access.md` is not to write a register whose
 * semantics you have not read, and the vendor's own code never stores ISPCON whole.
 * *verified* 2026-08-20, `research/fmc-erase-program.md`, finding 3.
 */
export const ISPCON_KEEP = ISPCON.BS

/** Written at the end, so the session leaves the ISP engine disabled. */
export const ISPCON_OFF = 0x00

export const CMD_PROGRAM = 0x21
export const CMD_PAGE_ERASE = 0x22

/**
 * Whole-chip erase. Named here so the guards elsewhere can name the right number, and
 * never written: `ISPCMD_VALUES` does not contain it.
 *
 * *verified* 2026-08-20 from the vendor's `fmc.h`, `FMC_ISPCMD_CPERASE 0x23`. This
 * repo said `0x26` in nine places until then, and `0x26` is not a valid command on this
 * part at all: `research/fmc-erase-program.md`, "The chip-erase opcode is 0x23".
 */
export const CMD_CHIP_ERASE = 0x23

/**
 * Every ISPCMD value this tool is capable of emitting.
 *
 * `CMD_CHIP_ERASE`, 0x23, is absent on purpose. It is not guarded against, it is
 * simply not expressible: the generator writes ISPCMD from this list only, and
 * `swdflash.test.ts` asserts both the list and every generated script.
 */
export const ISPCMD_VALUES = [CMD_PROGRAM, CMD_PAGE_ERASE] as const

export const PAGE = ota.FLASH_PAGE_SIZE
export const PAGE_WORDS = PAGE / 4

// --- The one window ----------------------------------------------------------------

/**
 * The application region, and the only place this tool may write.
 *
 * `abs 0x16800` is where SWD puts an image, with no staging bank, no info record and
 * no CONFIG0 change: `research/brick-2026-08-08.md`, "SWD is not just the repair, it
 * is the better flashing route". The upper bound is the OTA staging bank, which is
 * scratch but is not ours to clear.
 */
export const WINDOW = {
  name: 'application',
  start: ota.FLASH_APP_ADDR,
  end: ota.FLASH_DFU_ADDR,
} as const

/**
 * Words outside the window read before and after the flash, which must not change.
 *
 * These are the regions whose loss is expensive or unrecoverable, so rather than
 * trusting the window guard alone the script proves each one still holds what the
 * dump said. `0x0003dc00` is both the SDK's bootloader and the LDROM aperture, which
 * are aliases of each other (*verified* 2026-08-19), so watching it covers both.
 */
export const CANARIES = [
  { addr: 0x00000000, what: 'BLE stack reset vector' },
  { addr: 0x00010000, what: 'BLE stack, 26 KB below the window' },
  { addr: 0x00014000, what: 'BLE stack, 10 KB below the window' },
  { addr: 0x00016000, what: 'BLE stack, 2 KB below the window' },
  { addr: WINDOW.start - 4, what: 'the last word below the window' },
  { addr: ota.FLASH_DFU_ADDR, what: 'OTA staging bank' },
  { addr: ota.FLASH_SAVED_CONTENT_ADDR, what: 'saved DATS content' },
  { addr: ota.FLASH_ADDR_INFO, what: 'section info record' },
  { addr: ota.FLASH_ADDR_INFO_BACKUP, what: 'section info backup' },
  { addr: ota.FLASH_BOOTLOADER_ADDR, what: 'bootloader, aliased at 0x00100000' },
  { addr: 0x0003fc00, what: 'last page of flash' },
] as const

/**
 * The block sizes an oversized erase could plausibly have, smallest first.
 *
 * The 512-byte page is *derived*, never measured on this silicon
 * (`notes/swd-flashing.md`, "What is still unproven", item 2): it comes from Panchip's
 * `section_cfg.h` and from OpenOCD's `numicro` driver, which uses 512 for ARMv6-M
 * parts. Every entry here is a real FMC page size on some part in the family, and each
 * one loses a different amount:
 *
 * | block | block base of 0x16800 | BLE stack lost | erasing page 1 wipes page 0 |
 * | ----- | --------------------- | -------------- | --------------------------- |
 * | 512 B | 0x16800               | 0              | no                          |
 * | 1 KB  | 0x16800               | 0              | yes                         |
 * | 2 KB  | 0x16800               | 0              | yes                         |
 * | 4 KB  | 0x16000               | 2,048          | yes                         |
 * | 8 KB  | 0x16000               | 2,048          | yes                         |
 * | 16 KB | 0x14000               | 10,240         | yes                         |
 * | 32 KB | 0x10000               | 26,624         | yes                         |
 *
 * `WINDOW.start` is 2 KB aligned and not 4 KB aligned, which is the whole reason the
 * table splits the way it does: at 1 KB and 2 KB nothing outside the window moves and
 * every canary reads exactly what it read before, so the canaries alone are blind to
 * the two smallest failures. The four canaries below the window are for the bottom four
 * rows; `verify_last` in the generated script is for all six, because it re-reads the
 * previous page after every erase and an oversized block always contains it.
 */
export const CANDIDATE_BLOCKS = [1024, 2048, 4096, 8192, 16384, 32768] as const

export const blockBase = (addr: number, block: number) => addr - (addr % block)

/** Read with `mdw`, not present in any 0x0-0x40000 dump, so they arrive as flags. */
export const CONFIG0_ADDR = 0x00300000
export const LDROM_ADDR = 0x00100000

/**
 * The core's own debug status, read once per page so a reset cannot go unnoticed.
 *
 * The script halts once and never looks again. If the part resets, OpenOCD resumes the
 * application, which then runs while this session pokes the FMC, and which writes flash
 * itself on a DATS save. The application arms a ~2 s reset watchdog; `WDT_CTL[31]`
 * `ICEDEBUG` is clear so the counter should freeze while the CPU is held by ICE
 * (*derived*, `research/fmc-erase-program.md`), and a brown-out reboot is not covered by
 * that reasoning at all. 150 extra reads against 116,000 is the price of noticing.
 */
export const DHCSR = 0xe000edf0
export const DHCSR_S_HALT = 1 << 17
export const DHCSR_S_RESET_ST = 1 << 25

// --- What must not be cloned from one unit onto another --------------------------------

export interface KeepSpan {
  /** Absolute, inside the window, and word-aligned at both ends. */
  start: number
  end: number
  why: string
}

/**
 * Spans of the window that belong to the unit rather than to the firmware, and so are
 * taken from the target's own dump instead of the donor's.
 *
 * **It is empty, and that is a finding rather than an omission.** How hard it was
 * looked for, on `firmware/dump-unit1-2026-08-19-a.bin` and the SRAM capture beside it:
 *
 *  - **The whole of `0x16800`-`0x26a23` on unit 1 is byte-identical to the vendor's
 *    generic APK plaintext.** The vendor's own OTA overwrites that entire span with a
 *    build-generic image on every update, so nothing per-unit can live there and
 *    survive one. *verified* from the bytes.
 *  - **The advert-name suffix is not in flash at all.** Unit 1's SRAM holds
 *    `GLASSES-12E69E` at three addresses; flash holds only the eight-byte `GLASSES-`
 *    prefix, at `0x2691c` in the current image and again at `0x28688` in the orphan.
 *    The six hex characters appear nowhere in the 256 KB dump, in either case, and
 *    nor do the three raw bytes in either order. `abs 0x21540` builds them: a
 *    nibble-to-hex loop over bytes `+3`..`+5` of a struct in RAM.
 *  - **That struct is filled below the window.** `abs 0xe1c` and `abs 0x143c0`, both in
 *    the BLE stack, write `ISPCMD` `0x04` with `ISPADR` `0x58` then `0x5c` and read
 *    `ISPDAT`. `0x04` is not the flash read, which is `0x00`, and the main array at
 *    `0x58`/`0x5c` holds two vector-table entries, `0x000010ad` and `0x00000213`, which
 *    are not a MAC. So the two words come from a separate aperture, and both reading
 *    sites are below `0x16800` regardless. This is the claim
 *    `research/hardfault-0xd38-2026-08-19.md` marks *derived*; the bytes agree with it.
 *  - **No calibration, serial or trim block inside the window.** Past the image end the
 *    only content is 5x7 glyph bitmaps, 2-bit LED frame data, two RAM pointers, the
 *    second `GLASSES-` prefix, and then programmed zeros to `0x293ff`.
 *  - Everything genuinely per-unit that we know of is outside the window anyway: the
 *    saved DATS content at `0x3c000`, the info pages at `0x3d800` and `0x3da00`, the
 *    LDROM, and the config aperture, which stays hardware-refused because `CFGUEN` is
 *    clear for the whole session.
 *
 * **What none of that can do is compare two units**, which is the only test that
 * settles it. So `donor` prints every run where the donor and the target differ before
 * it writes anything, and `--keep` puts a span back under the target's own bytes
 * without anyone having to edit this list under time pressure.
 */
export const UNIT_SPECIFIC: KeepSpan[] = []

// --- The plan ------------------------------------------------------------------------

export interface Witness {
  addr: number
  word: number
  what: string
}

export interface PagePlan {
  addr: number
  /**
   * The bytes to program, or null for an erase-only page. Shorter than `PAGE` only
   * for the last page of the image; the page is erased in full either way.
   */
  data: Uint8Array | null
  /** The dump already shows this page holding exactly `data`, and --resume was given. */
  skip: boolean
}

export interface Plan {
  imageName: string
  codeSize: number
  crc32: number
  base: number
  /** One past the last byte the image occupies. */
  imageEnd: number
  pages: PagePlan[]
  witnesses: Witness[]
  canaries: Witness[]
  notes: string[]
  speedKhz: number
  /** Set when the payload came from a donor dump rather than an image file. */
  donor: DonorSource | null
  kept: KeepSpan[]
  /** The one page erased before any other, to test the erase granularity. */
  probe: Probe | null
}

export interface PlanInput {
  /** An OTA container. Exactly one of this and `donor` is given. */
  image?: Uint8Array
  imageName: string
  /** A working unit's application region, read back over SWD. */
  donor?: DonorSource | null
  /** Stock container for the patch checks. Omit when the image is stock itself. */
  stock?: Uint8Array
  /**
   * The variant string to hold the payload to, passed straight to `ota.check`.
   *
   * In donor mode the CLI fills this from the donor's own application, which
   * `readDonor` only reports once it has proved the two units share a BLE stack. Left
   * unset, `ota.check` falls back to `ota.DEVICE_VERSION`, which is the APK's label
   * rather than anything measured off a unit.
   */
  expectVersion?: string
  from?: Dump | null
  resume?: boolean
  blankTail?: boolean
  config0?: number | null
  ldrom?: number | null
  speedKhz?: number
  /** `script` cannot run without a dump; `plan` will, and says what it lost. */
  requireDump?: boolean
  /**
   * `script` and `donor` cannot run without `--config0` either.
   *
   * The headline safety claim of the whole session is that the config page is refused
   * by hardware because `CFGUEN` is clear, and that claim has never been tested in the
   * refusing direction on this part: `fmc-ladder1.sh` only ever read, and the config
   * repair set `CFGUEN` because it wanted it. A CONFIG0 canary is the only thing in the
   * run that would notice if the bit does not mean what Nuvoton says it means, and it
   * costs one read-only `swd-recon.sh diag` to supply. So it is required rather than
   * suggested.
   */
  requireConfig0?: boolean
  /** Spans taken from the target instead of the donor. See `UNIT_SPECIFIC`. */
  keep?: KeepSpan[]
  /**
   * The target's raw dump from address 0, handed to `ota.check` as its reference.
   *
   * This is the gate `research/image-silicon-match.md` added and it is the one that
   * would have stopped 2026-08-08: it asks whether this image is the application
   * **this unit's stack** expects, which is a question about a part and cannot be
   * answered from an image alone. The CLI passes it whenever it has a dump; it is a
   * separate field from `from` so that a caller with a fixture rather than a device
   * can still exercise the page plan.
   */
  reference?: Uint8Array
}

export interface PlanResult {
  ok: boolean
  plan: Plan | null
  verdict: ota.Verdict | null
  refusals: string[]
}

export const pageOf = (addr: number) => addr - (addr % PAGE)

/** Little-endian words of a byte run whose length is a multiple of 4. */
export function words(data: Uint8Array): number[] {
  if (data.length % 4 !== 0) throw new Error(`${data.length} bytes is not whole words`)
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const out: number[] = []
  for (let i = 0; i < data.length; i += 4) out.push(dv.getUint32(i, true))
  return out
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Does the dump already show this page holding exactly what we would write?
 *
 * For the last page of the image that means the covered bytes match **and** the rest
 * of the page is erased, because a page is erased in full and a stale tail would
 * survive a skip.
 */
export function pageMatches(d: Dump, p: PagePlan): boolean {
  const whole = at(d, p.addr, p.addr + PAGE)
  if (!whole) return false
  if (p.data === null) return fillOf(whole) === 'blank'
  if (!sameBytes(whole.subarray(0, p.data.length), p.data)) return false
  return fillOf(whole.subarray(p.data.length)) === 'blank'
}

/** Witness words: enough to identify the unit, few enough to read in a second. */
function pickWitnesses(d: Dump, base: number, length: number): Witness[] {
  const out: Witness[] = []
  const push = (addr: number, what: string) => {
    const b = at(d, addr, addr + 4)
    if (!b) return
    if (out.some((w) => w.addr === addr)) return
    out.push({ addr, word: new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true), what })
  }
  push(base, 'application image head')
  const pages = Math.ceil(length / PAGE)
  const step = Math.max(1, Math.floor(pages / 8))
  for (let i = step; i < pages; i += step) push(base + i * PAGE, `page ${i} of the image`)
  push(base + length - 4, 'last word of the image')
  return out
}

const wordAt = (d: Dump, addr: number): number | null => {
  const b = at(d, addr, addr + 4)
  if (!b) return null
  return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true)
}

/**
 * The nearest word to `addr`, inside its own 512-byte page, that is not erased.
 *
 * A canary whose dump value is already `0xffffffff` cannot detect an erase, only a
 * program, and an erase is the failure that matters: it is what an oversized erase
 * block does to the region below the window. Three of the addresses in `CANARIES` read
 * `0xffffffff` on the units in hand, `WINDOW.start - 4` among them, so the nominal
 * address is a starting point and the canary is the nearest word that can actually say
 * something. Backwards first, because the canaries below the window are there to sit as
 * close under the edge as a non-erased word allows.
 */
export function sightedCanary(d: Dump, addr: number): number | null {
  const page = pageOf(addr)
  if (wordAt(d, addr) !== 0xffffffff) return wordAt(d, addr) === null ? null : addr
  for (let a = addr - 4; a >= page; a -= 4) {
    const w = wordAt(d, a)
    if (w !== null && w !== 0xffffffff) return a
  }
  for (let a = addr + 4; a < page + PAGE; a += 4) {
    const w = wordAt(d, a)
    if (w !== null && w !== 0xffffffff) return a
  }
  return null
}

function pickCanaries(
  d: Dump | null | undefined,
  config0: number | null | undefined,
  ldrom: number | null | undefined,
): { canaries: Witness[]; notes: string[] } {
  const canaries: Witness[] = []
  const notes: string[] = []
  for (const c of CANARIES) {
    const b = d ? at(d, c.addr, c.addr + 4) : null
    if (!b) {
      notes.push(`no canary at ${hx(c.addr, 8)} (${c.what}): the dump does not cover it`)
      continue
    }
    const seen = sightedCanary(d!, c.addr)
    if (seen === null) {
      const word = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true)
      canaries.push({ addr: c.addr, word, what: `${c.what}, BLIND to an erase` })
      notes.push(
        `the canary at ${hx(c.addr, 8)} (${c.what}) reads 0xffffffff, and so does ` +
          `every other word in its page, so it can catch a stray program there but ` +
          'not a stray erase. It is kept and labelled rather than dropped',
      )
      continue
    }
    if (seen !== c.addr) {
      notes.push(
        `the canary for ${c.what} moved from ${hx(c.addr, 8)} to ${hx(seen, 8)}: the ` +
          'nominal address reads 0xffffffff, which cannot detect an erase',
      )
    }
    canaries.push({ addr: seen, word: wordAt(d!, seen)!, what: c.what })
  }
  if (config0 !== null && config0 !== undefined) {
    canaries.push({ addr: CONFIG0_ADDR, word: config0 >>> 0, what: 'CONFIG0' })
  } else {
    notes.push(
      'no CONFIG0 canary: pass --config0 <word> from `swd-recon.sh diag` and the ' +
        'script will prove the config page did not move, which is the strongest ' +
        'evidence that CFGUEN never took effect',
    )
  }
  if (ldrom !== null && ldrom !== undefined) {
    canaries.push({ addr: LDROM_ADDR, word: ldrom >>> 0, what: 'LDROM aperture' })
  }
  return { canaries, notes }
}

// --- The granularity probe --------------------------------------------------------------

export interface Probe {
  /** The page erased first, alone, before the plan's own pages are touched. */
  addr: number
  /** The page immediately below it, whose contents are read back afterwards. */
  below: number
  /** What `below` holds in the target's dump, so the script can assert it. */
  belowWords: number[]
  /**
   * The page above, and its contents, when there is one worth reading.
   *
   * `below` alone settles every power-of-two block from 1 KB up, because the probe is
   * chosen so their bases all sit at or under `addr - PAGE`. This is for a geometry
   * that is not a power of two or not aligned, which no datasheet suggests and nothing
   * rules out. 128 reads.
   */
  above: number | null
  aboveWords: number[]
  /** Largest block in `CANDIDATE_BLOCKS` whose base and end both stay in the window. */
  containedTo: number
  /** Non-erased words in `below`. Zero would make the check blind. */
  sighted: number
}

/**
 * Pick the one page to erase first, so that the 512-byte page size is tested before
 * 150 erases depend on it.
 *
 * **Why a probe at all.** The page size is *derived*. If the real erase block is larger
 * than 512 bytes, the first erase of the plan, at `WINDOW.start`, is the worst possible
 * place to find out: `0x16800` is not 4 KB aligned, so a block of 4 KB or more has its
 * base at `0x16000` or below and the erase takes live BLE stack with it, which this tool
 * can never write back. The damage is done by the time anything could notice.
 *
 * **What the probe changes.** It does not reorder the plan and it does not try to make
 * an oversized erase safe; no ordering can (an ascending run reaches backwards over
 * pages already written, a descending one reaches forwards and then erases them again).
 * It moves the *first* erase of the session to a page chosen so that a block of up to
 * `containedTo` bytes cannot leave the window, and then reads the neighbour back. Every
 * byte the probe can destroy is inside the window and inside the plan, which is to say
 * inside the span about to be rewritten anyway.
 *
 * **Why the page below.** The probe page is picked with `addr % 1024 === 512`, so for
 * every block size in `CANDIDATE_BLOCKS` the block base is at or below `addr - PAGE`.
 * One page-sized read-back of `below` therefore detects every oversized block from
 * 1 KB up to `containedTo`, including the 1 KB and 2 KB cases that change nothing
 * outside the window and that no canary can see.
 *
 * Returns null when no page qualifies, which is a plan of fewer than two pages to write
 * or a plan with no dump behind it. The script then falls back to the canary sweep after
 * the first erase and to `verify_last`, which catch the same faults one page later.
 */
export function chooseProbe(pages: PagePlan[], d: Dump | null): Probe | null {
  if (!d) return null
  const live = new Set(pages.filter((p) => !p.skip).map((p) => p.addr))
  let best: Probe | null = null
  for (const p of pages) {
    if (p.skip) continue
    if (p.addr % 1024 !== 512) continue
    const below = p.addr - PAGE
    if (!live.has(below)) continue
    const bytes = at(d, below, below + PAGE)
    if (!bytes) continue
    let containedTo = 0
    for (const b of CANDIDATE_BLOCKS) {
      const base = blockBase(p.addr, b)
      if (base < WINDOW.start || base + b > WINDOW.end) break
      containedTo = b
    }
    if (containedTo === 0) continue
    const belowWords = words(bytes)
    const sighted = belowWords.filter((w) => w !== 0xffffffff).length
    if (sighted === 0) continue
    const up = p.addr + PAGE
    const upBytes = live.has(up) ? at(d, up, up + PAGE) : null
    const aboveWords = upBytes && fillOf(upBytes) !== 'blank' ? words(upBytes) : []
    const cand: Probe = {
      addr: p.addr,
      below,
      belowWords,
      above: aboveWords.length ? up : null,
      aboveWords,
      containedTo,
      sighted,
    }
    if (
      !best ||
      cand.containedTo > best.containedTo ||
      (cand.containedTo === best.containedTo && cand.sighted > best.sighted)
    ) {
      best = cand
    }
  }
  return best
}

// --- Reading the donor ------------------------------------------------------------------

export interface DonorSource {
  name: string
  /** The application region exactly as the donor holds it, `WINDOW.start` first. */
  window: Uint8Array
  /** The build label in the donor's own application, or null if it carries none. */
  variant: string | null
}

export interface DonorInput {
  /** Repeat dumps of the same working unit. At least two, and they must agree. */
  dumps: { name: string; bytes: Uint8Array; base?: number }[]
  /** Vendor containers a defective donor would match. */
  apk?: { name: string; container: Uint8Array }[]
  /**
   * The unit being written, whole dump from address 0. Optional only because `verify`
   * uses a donor as a read-only baseline with no target in play; for anything that
   * leads to a write the CLI always supplies it, because it is what turns the variant
   * question below from a string comparison into a fact about two pieces of silicon.
   */
  target?: { name: string; bytes: Uint8Array }
}

/**
 * The `TR1906R04-xx` build label the vendor stamps into an application.
 *
 * `ota.check` finds the same string; this reads it out so a donor can be described by
 * what it *is* rather than measured against a constant. Both are needed: see the
 * variant argument in `readDonor`.
 */
export function variantOf(window: Uint8Array): string | null {
  const needle = [...'TR1906R04'].map((c) => c.charCodeAt(0))
  outer: for (let i = 0; i + needle.length <= window.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (window[i + j] !== needle[j]) continue outer
    }
    let end = i
    while (end < window.length && end < i + 24 && window[end] !== 0) end++
    return String.fromCharCode(...window.subarray(i, end))
  }
  return null
}

export interface DonorResult {
  donor: DonorSource | null
  refusals: string[]
  facts: string[]
}

/**
 * Decide whether a set of dumps can be trusted as the source for another unit's flash.
 *
 * The bar is higher than for `--from`. A bad `--from` dump stops the script at its
 * first precondition and costs nothing; a bad donor is written into the target and is
 * then indistinguishable from a firmware fault. Hence two dumps rather than one, and
 * hence the APK test: `research/hardfault-0xd38-2026-08-19.md` establishes that the
 * APK's application is the one that does not work on this hardware, so a donor holding
 * it is not a donor.
 *
 * `ota.check` is still the gate, run on a container encoded from the window, which is
 * how the head, the entry vector and the variant string get checked without a second
 * implementation of any of them. It is run **without** a stock baseline on purpose: a
 * donor is a different build, not a patch of stock, so `comparePatch` would report tens
 * of thousands of differing bytes and `PROTECTED_REGIONS`, whose offsets are the APK's
 * layout, would name the wrong code. What makes a donor safe is not that it matches
 * something we hold, it is that it came off a unit that works.
 *
 * **What the regions are on a donor is answerable now**, and by content rather than by
 * offset: `bun research/tools/fwtool.ts regions` with `FW` set to the window resolves
 * all seven in whichever build it is handed, and reports whether anything this repo
 * writes lands in one. It is not wired in here, because a donor write is the whole
 * window and every region is inside it by definition; it is the thing to run before
 * *patching* a donor-based image. `research/protected-regions-2026-08-20.md`.
 */
export function readDonor(input: DonorInput): DonorResult {
  const refusals: string[] = []
  const facts: string[] = []
  const { dumps } = input
  if (dumps.length === 0) {
    return { donor: null, facts, refusals: ['no donor dump given'] }
  }
  if (dumps.length < 2) {
    refusals.push(
      'one donor dump is not enough. It is the only surviving copy of an application ' +
        'that works on this hardware, and an intermittent read of it would be written ' +
        'into the target permanently, where it would look like a firmware bug rather ' +
        'than a bad read. Take at least two from cold and pass both',
    )
  }
  const names = dumps.map((d) => d.name)
  if (new Set(names).size !== names.length) {
    refusals.push(
      'the same dump was given twice. Two reads of one unit agreeing is the evidence ' +
        'this asks for, and one file compared with itself is not that',
    )
  }
  const sizes = new Set(dumps.map((d) => d.bytes.length))
  if (sizes.size > 1) {
    refusals.push(
      'the donor dumps are different lengths: ' +
        dumps.map((d) => `${d.name} ${d.bytes.length}`).join(', '),
    )
    return { donor: null, facts, refusals }
  }
  if (dumps.length > 1) {
    const diffs = compareDumps(dumps.map((d) => dump(d.bytes, d.base ?? 0)))
    if (diffs.length > 0) {
      const total = diffs.reduce((n, r) => n + r.length, 0)
      refusals.push(
        `the donor dumps disagree: ${total} bytes in ${diffs.length} runs, first at ` +
          `${hx(diffs[0].abs, 8)} in the ${diffs[0].region}. Repeat reads of one unit ` +
          'must agree before any of them is believed. Slow the adapter, check the ' +
          'ground return, and dump again',
      )
      return { donor: null, facts, refusals }
    }
    facts.push(`${dumps.length} dumps of ${dumps[0].bytes.length} bytes, byte-identical`)
  }

  const d = dump(dumps[0].bytes, dumps[0].base ?? 0)
  if (!covers(d, WINDOW.start, WINDOW.end)) {
    refusals.push(
      `the donor dump covers ${hx(d.base, 8)}-${hx(d.end - 1, 8)}, which does not hold ` +
        `all of ${hx(WINDOW.start)}-${hx(WINDOW.end)}`,
    )
    return { donor: null, facts, refusals }
  }
  const window = at(d, WINDOW.start, WINDOW.end)!.slice()

  if (fillOf(d.bytes) === 'blank') {
    refusals.push(
      'every byte of the donor dump reads 0xff, which on this family is what a ' +
        'read-locked part looks like as well as an erased one. It records nothing',
    )
    return { donor: null, facts, refusals }
  }
  const fill = fillOf(window)
  if (fill !== 'data') {
    refusals.push(`the donor's application region is entirely ${fill === 'blank' ?
      'erased' : 'zeros'}, so it holds no application to copy`)
    return { donor: null, facts, refusals }
  }

  // --- the variant question, answered from silicon rather than from a constant -----
  //
  // `ota.check` defaults its expectation to `ota.DEVICE_VERSION`, which is the APK's
  // label and not the fleet's, so on the real donor it fired `wrong-variant` and
  // refused the repair: the donor declares TR1906R04-12 and the constant says -10.
  // Comparing a donor against the build that bricked unit 1 is the wrong test.
  //
  // The right one is whether the two units are the same piece of hardware, and the
  // evidence for that is the region this tool never writes: the BLE stack below
  // WINDOW.start. It is the half that dispatches through the callback slots the
  // application registers, so if it is identical then the donor's application is
  // built against exactly the stack the target is running. Identical stack authorises
  // a differing variant; a differing stack refuses, whatever the labels say.
  const variant = variantOf(window)
  if (input.target) {
    const t = dump(input.target.bytes, 0)
    const theirs = at(t, 0, WINDOW.start)
    const ours = at(d, 0, WINDOW.start)
    if (!theirs || !ours) {
      refusals.push(
        `the target dump ${input.target.name} does not cover 0x0-${hx(WINDOW.start)}, ` +
          'so the two units cannot be compared below the application region and there ' +
          'is nothing to authorise writing one unit\'s application onto another',
      )
    } else if (!sameBytes(theirs, ours)) {
      const runs = windowRuns(ours, theirs, 0)
      const total = runs.reduce((n, r) => n + r.length, 0)
      refusals.push(
        `the two units do not share a BLE stack: ${total} bytes differ over ` +
          `${runs.length} runs below ${hx(WINDOW.start)}, the first at ` +
          `${hx(runs[0].abs, 5)}. That region is never written by this tool, so it is ` +
          'the closest thing to a hardware fingerprint either unit has, and a donor ' +
          'application built against a different stack registers a different set of ' +
          'callbacks. This is the 2026-08-08 fault shape. Stop and find out why they ' +
          'differ; do not write across it',
      )
    } else {
      const mine = variantOf(at(t, WINDOW.start, WINDOW.end) ?? new Uint8Array())
      facts.push(
        `BLE stack 0x0-${hx(WINDOW.start)} byte-identical on both units ` +
          `(${WINDOW.start} bytes), so they are the same hardware and the same SDK ` +
          'build. That is what permits a donor whose variant differs',
      )
      facts.push(
        `variant: donor ${variant ?? 'none'}, target ${mine ?? 'none'}` +
          (variant && mine && variant !== mine
            ? `. They differ, and the donor's is the expectation: the target reads ` +
              `${mine} because that is what was written onto it, not because it is ` +
              'what it ran'
            : ''),
      )
    }
  } else if (variant) {
    facts.push(
      `variant ${variant}, taken from the donor's own application with no target ` +
        'dump to corroborate it. Read-only use only',
    )
  }
  if (refusals.length) return { donor: null, facts, refusals }

  // The head, the entry vector, the size bounds and the variant string, all of them
  // ota.check's rather than a second copy here. `expectVersion` is the donor's own
  // label, which is only reached once the stack comparison above has agreed.
  const container = ota.encode(window, DONOR_HEADER)
  const verdict = ota.check(container, variant ? { expectVersion: variant } : {})
  for (const f of verdict.findings) {
    if (f.severity !== 'fatal') continue
    refusals.push(`the donor fails ota.check: ${f.code}: ${f.message}`)
  }

  for (const a of input.apk ?? []) {
    const { plain } = referenceImage(a.container)
    if (plain.length > window.length) continue
    const same = plain.every((b, i) => window[i] === b)
    if (!same) continue
    refusals.push(
      `this donor's application is byte-identical to ${a.name} over all ` +
        `${plain.length} bytes of it. That is the build that does not work on this ` +
        'hardware: it never registers callback slot +0x60, and the BLE stack calls out ' +
        'through it (research/hardfault-0xd38-2026-08-19.md). Copying it onto another ' +
        'unit spends 150 page erases to reproduce the fault',
    )
  }

  const c = census(d, WINDOW.start, WINDOW.end)
  facts.push(
    `application region ${hx(WINDOW.start)}-${hx(WINDOW.end)}: ${c.pages} pages, ` +
      `${c.blank} erased, ${c.zero} all-zero, ${c.data} holding data`,
  )
  if (c.lastUsed !== null) {
    facts.push(`last byte that is not 0xff: ${hx(c.lastUsed)}`)
  }
  let lastReal = -1
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i] !== 0xff && window[i] !== 0x00) {
      lastReal = WINDOW.start + i
      break
    }
  }
  if (lastReal >= 0) facts.push(`last byte that is neither 0xff nor zero: ${hx(lastReal)}`)
  const ext = extensionIn(d)
  if (ext) {
    facts.push(`the donor already carries a ${ext.magic} v${ext.version} extension, ` +
      `${ext.size} bytes, entry ${hx(ext.entry)}`)
  }

  const donor = refusals.length ? null : { name: dumps[0].name, window, variant }
  return { donor, facts, refusals }
}

/**
 * Header for the container a donor window is wrapped in.
 *
 * It exists only so `ota.check` can be the gate, and nothing on the SWD path reads it:
 * SWD writes `0x16800` directly, with no staging bank, no info record and no
 * bootloader. `devVer 10` is the variant this hardware is, which is the one field that
 * would matter if this container ever reached the OTA service, and it never should.
 */
export const DONOR_HEADER =
  { appVer: 0, devVer: 10, proVer: 10, type: ota.OTA_APP } as const

/** Runs where two windows of the same length differ. */
export function windowRuns(a: Uint8Array, b: Uint8Array, base: number) {
  const runs: { abs: number; length: number }[] = []
  let run: { abs: number; length: number } | null = null
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) {
      run = null
      continue
    }
    if (run && run.abs + run.length === base + i) {
      run.length++
      continue
    }
    run = { abs: base + i, length: 1 }
    runs.push(run)
  }
  return runs
}

/**
 * Everything that must hold before a page plan exists at all.
 *
 * `ota.check` runs first and its fatal findings are fatal here too, including inside
 * `PROTECTED_REGIONS`. Over SWD those regions are recoverable and the brick postmortem
 * calls the check advisory, but `ota.check` deliberately has no CLI flag for lifting
 * it, and adding one here would be the same door by a different name.
 *
 * **Read a `protected-region` finding against the base it was traced on.** Those
 * offsets are the APK's, so on a donor-based image they name the wrong functions in
 * both directions: on a real unit's window the entry named for the flash driver ends
 * 0x4a bytes before that build's word programmer, because the driver grew a function
 * and its tail moved 0x110 (`research/protected-regions-2026-08-20.md`). A finding here
 * is a question about which base was used before it is a statement about the image.
 */
export function buildPlan(input: PlanInput): PlanResult {
  const refusals: string[] = []
  const base = WINDOW.start
  const d0 = input.from ?? null

  // A donor payload is the target's own bytes wherever `keep` says so, and the CRC
  // token is computed over the result, so the token names what actually goes on the
  // wire rather than what the donor happened to hold.
  const kept: KeepSpan[] = []
  let payload: Uint8Array | null = null
  if (input.donor) {
    payload = input.donor.window.slice()
    for (const k of input.keep ?? []) {
      const bad =
        k.start % 4 !== 0 || k.end % 4 !== 0 || k.end <= k.start ||
        k.start < WINDOW.start || k.end > WINDOW.end
      if (bad) {
        refusals.push(
          `--keep ${hx(k.start)}-${hx(k.end)} is not a word-aligned span inside ` +
            `${hx(WINDOW.start)}-${hx(WINDOW.end)}`,
        )
        continue
      }
      const mine = d0 ? at(d0, k.start, k.end) : null
      if (!mine) {
        refusals.push(
          `--keep ${hx(k.start)}-${hx(k.end)} needs the target's own bytes and the ` +
            '--to dump does not cover that span',
        )
        continue
      }
      payload.set(mine, k.start - WINDOW.start)
      kept.push(k)
    }
    if (refusals.length) return { ok: false, plan: null, verdict: null, refusals }
  }

  const container = payload ? ota.encode(payload, DONOR_HEADER) : input.image
  if (!container) {
    return {
      ok: false,
      plan: null,
      verdict: null,
      refusals: ['no image and no donor: there is nothing to write'],
    }
  }
  // A donor is a different build, not a patch of stock, so it is checked on its own:
  // `comparePatch` would report tens of thousands of differing bytes and
  // `PROTECTED_REGIONS`, whose offsets are the APK's layout, would name the wrong code.
  const verdict = ota.check(container, {
    stock: payload ? undefined : input.stock,
    reference: input.reference,
    expectVersion: input.expectVersion,
  })
  if (!verdict.safe) {
    for (const f of verdict.findings) {
      if (f.severity === 'fatal') refusals.push(`${f.code}: ${f.message}`)
    }
    return { ok: false, plan: null, verdict, refusals }
  }

  const { plain, header } = referenceImage(container)
  if (base % PAGE !== 0) {
    refusals.push(`the window base ${hx(base)} is not page-aligned`)
    return { ok: false, plan: null, verdict, refusals }
  }
  if (plain.length === 0) {
    refusals.push('the image has no body')
    return { ok: false, plan: null, verdict, refusals }
  }
  // The FMC programs one 32-bit word at a time and there is no byte or halfword
  // opcode, so a body that is not a whole number of words cannot be written by this
  // route at all. It used to reach `words()` and throw a raw Error out of the CLI.
  if (plain.length % 4 !== 0) {
    refusals.push(
      `the image body is ${plain.length} bytes, which is not a whole number of ` +
        '32-bit words. ISPCMD 0x21 programs one word at a time and there is no ' +
        'narrower opcode, so the last bytes could not be written',
    )
    return { ok: false, plan: null, verdict, refusals }
  }
  if (base + plain.length > WINDOW.end) {
    refusals.push(
      `the image is ${plain.length} bytes and the ${WINDOW.name} region holds ` +
        `${WINDOW.end - WINDOW.start}. Writing it at ${hx(base)} would run into the ` +
        `OTA staging bank at ${hx(WINDOW.end)}`,
    )
    return { ok: false, plan: null, verdict, refusals }
  }
  if (input.requireConfig0 && (input.config0 === null || input.config0 === undefined)) {
    refusals.push(
      'no --config0. The one claim the whole session rests on is that the config page ' +
        'is refused by hardware because CFGUEN is clear, and nothing on this part has ' +
        'ever tested that in the refusing direction: fmc-ladder1.sh only read, and the ' +
        'config repair set CFGUEN because it wanted it. The CONFIG0 canary is the only ' +
        'thing in the run that would notice. Read it with `swd-recon.sh diag` and pass ' +
        'it. `plan` runs without one and says what it lost',
    )
    return { ok: false, plan: null, verdict, refusals }
  }
  if (input.requireDump && !input.from) {
    refusals.push(
      'no --from dump. The precondition words and the canaries are read out of a ' +
        'dump of the unit being flashed, and there is no honest substitute: without ' +
        'one the script cannot tell it is talking to the right device, and a mistake ' +
        'has nothing to restore from. Take three dumps from cold first',
    )
    return { ok: false, plan: null, verdict, refusals }
  }

  const notes: string[] = []
  const pages: PagePlan[] = []
  const imagePages = Math.ceil(plain.length / PAGE)
  for (let i = 0; i < imagePages; i++) {
    const addr = base + i * PAGE
    const from = i * PAGE
    const data = plain.subarray(from, Math.min(from + PAGE, plain.length))
    // A page of nothing but erased flash is written by erasing it. Programming
    // 0xffffffff word by word reaches the same array contents at 128 transactions a
    // page, and a donor window is mostly this: unit 1's holds 21 such pages.
    pages.push({ addr, data: fillOf(data) === 'blank' ? null : data, skip: false })
  }
  if (input.blankTail) {
    for (let addr = base + imagePages * PAGE; addr < WINDOW.end; addr += PAGE) {
      pages.push({ addr, data: null, skip: false })
    }
  }

  // The guard the whole tool rests on. It should be unreachable given the bounds
  // above, which is exactly why it is asserted rather than assumed.
  for (const p of pages) {
    if (p.addr % PAGE !== 0 || p.addr < WINDOW.start || p.addr + PAGE > WINDOW.end) {
      refusals.push(
        `page ${hx(p.addr)} falls outside the ${WINDOW.name} window ` +
          `${hx(WINDOW.start)}-${hx(WINDOW.end)}`,
      )
    }
  }
  if (refusals.length) return { ok: false, plan: null, verdict, refusals }

  const d = d0
  if (d && !covers(d, WINDOW.start, base + plain.length)) {
    refusals.push(
      `the dump covers ${hx(d.base, 8)}-${hx(d.end - 1, 8)}, which does not reach ` +
        `the ${hx(WINDOW.start)}-${hx(base + plain.length)} the image occupies`,
    )
    return { ok: false, plan: null, verdict, refusals }
  }

  if (input.resume) {
    if (!d) {
      refusals.push('--resume needs --from: the skips come from reading the device')
      return { ok: false, plan: null, verdict, refusals }
    }
    for (const p of pages) p.skip = pageMatches(d, p)
  }

  if (d && !input.blankTail) {
    const tail = census(d, base + imagePages * PAGE, WINDOW.end)
    if (tail.firstUsed !== null) {
      notes.push(
        `the unit holds ${tail.lastUsed! - tail.firstUsed! + 1} bytes at ` +
          `${hx(tail.firstUsed)}-${hx(tail.lastUsed!)}, past the end of this image. ` +
          'They are left alone, and dumpcheck will report them afterwards as ' +
          '"beyond the reference". --blank-tail erases them, and on unit 1 that is ' +
          'the leftover of a longer factory image rather than anything this build ' +
          'refers to (notes/swd-flashing.md, "The tail nobody erased"). Nothing has ' +
          'proved it unused, so the default is to leave it',
      )
    }
  }

  // Two different units, so the comparison is the only evidence there will ever be
  // about what in this window belongs to the unit rather than to the firmware. It is
  // reported rather than judged: see UNIT_SPECIFIC for how hard it has been looked for.
  if (input.donor && d) {
    const mine = at(d, WINDOW.start, WINDOW.end)
    if (mine) {
      const runs = windowRuns(input.donor.window, mine, WINDOW.start)
      const total = runs.reduce((n, r) => n + r.length, 0)
      if (runs.length === 0) {
        notes.push(
          'the donor and the target already hold the same application region, byte ' +
            'for byte. Nothing needs writing; --resume would skip every page',
        )
      } else {
        const shown = runs.slice(0, 12)
          .map((r) => `${hx(r.abs, 5)} ${r.length} B`)
          .join(', ')
        notes.push(
          `donor and target differ in ${total} bytes over ${runs.length} runs: ` +
            shown + (runs.length > 12 ? `, and ${runs.length - 12} more` : '') +
            '. Everything in that list is about to become the donor\'s. Nothing found ' +
            'in this window is per-unit (UNIT_SPECIFIC says how hard that was looked ' +
            'for), so the expected shape is a small number of long runs where the two ' +
            'builds differ, not scattered single words. Scattered words are the ' +
            'signature this tool cannot rule out, and --keep is the answer to one',
        )
      }
    }
  }
  if (input.donor && kept.length === 0) {
    notes.push(
      'no --keep spans: every byte of the window comes from the donor. That is the ' +
        'intended behaviour and the evidence for it is the UNIT_SPECIFIC docblock in ' +
        'research/tools/swdflash.ts',
    )
  }
  for (const k of kept) {
    notes.push(`--keep ${hx(k.start)}-${hx(k.end)} taken from the target, not the ` +
      `donor: ${k.why}`)
  }

  const speedKhz = input.speedKhz ?? 100
  if (!Number.isInteger(speedKhz) || speedKhz < 5 || speedKhz > 4000) {
    refusals.push(
      `--speed ${input.speedKhz} is not an adapter speed between 5 and 4000 kHz. ` +
        'OpenOCD reads 0 as adaptive clocking, which this part has no RTCK pin for, ' +
        'and a NaN from a mistyped flag reaches the script as a syntax error',
    )
    return { ok: false, plan: null, verdict, refusals }
  }
  const flagged = [['--config0', input.config0], ['--ldrom', input.ldrom]] as const
  for (const [name, v] of flagged) {
    if (v === null || v === undefined) continue
    if (!Number.isInteger(v)) {
      refusals.push(
        `${name} is not a number. A mistyped flag becomes NaN, and NaN >>> 0 is zero, ` +
          'so the canary would silently expect 0x00000000 at an address that has ' +
          'never held it',
      )
      return { ok: false, plan: null, verdict, refusals }
    }
  }

  const picked = pickCanaries(d, input.config0, input.ldrom)
  notes.push(...picked.notes)
  const probe = chooseProbe(pages, d)
  if (probe) {
    notes.push(
      `the erase granularity is probed first, at ${hx(probe.addr)}: one page erase, ` +
        `then ${hx(probe.below)} is read back in full. That page is chosen so a block ` +
        `of up to ${probe.containedTo} bytes cannot leave the window, and so that ` +
        `every block size from 1 KB up contains it (${probe.sighted} of ` +
        `${PAGE_WORDS} words there are not already erased). Both pages are the plan's ` +
        'own, so the probe erases nothing the run was not going to erase anyway',
    )
  } else if (d) {
    notes.push(
      'NO granularity probe: no page in this plan has its predecessor in the plan too, ' +
        'which needs at least two consecutive pages to write. The 512-byte page size ' +
        'is *derived* and this run does not test it before it depends on it. The ' +
        'canary sweep after the first erase and verify_last after every erase still ' +
        'catch an oversized block, one page later and with the damage already done',
    )
  }

  return {
    ok: true,
    verdict,
    refusals,
    plan: {
      imageName: input.imageName,
      codeSize: header.codeSize,
      crc32: header.crc32,
      base,
      imageEnd: base + plain.length,
      pages,
      witnesses: d ? pickWitnesses(d, base, plain.length) : [],
      canaries: picked.canaries,
      notes,
      speedKhz,
      donor: input.donor ?? null,
      kept,
      probe,
    },
  }
}

/**
 * Wall clock, in minutes, low and high.
 *
 * Every transaction is an OpenOCD round trip and the flash itself is under two seconds
 * of the whole run: `research/fmc-erase-program.md`, "Timing, honestly", which
 * calibrates 4 to 10 minutes for ~116,000 round trips at 100 kHz against the measured
 * 22.9 s for a 256 KB dump at 200 kHz. *derived* by arithmetic, and the range is wide
 * because nobody has run one.
 */
export function estimateMinutes(p: Plan): [number, number] {
  const n = transactions(p)
  const scale = 100 / p.speedKhz
  return [(n / 480) * scale / 60, (n / 190) * scale / 60]
}

export const willWrite = (p: Plan) => p.pages.filter((x) => !x.skip && x.data !== null)
export const willBlank = (p: Plan) => p.pages.filter((x) => !x.skip && x.data === null)
export const willKeep = (p: Plan) => p.pages.filter((x) => x.skip)

/**
 * Register transactions the session costs, which is what makes it slow.
 *
 * The read-back terms are the bulk of it and they are the price of the granularity
 * checks: `verify_last` re-reads a page after every erase, and section 7 reads every
 * page once more at the end so that what the script claims is the state of the flash
 * now rather than the state each page was in when it was finished.
 */
export function transactions(p: Plan): number {
  const wordCount = willWrite(p).reduce((n, x) => n + x.data!.length / 4, 0)
  const erases = willWrite(p).length + willBlank(p).length + (p.probe ? 1 : 0)
  const reread = erases * PAGE_WORDS + p.pages.length * PAGE_WORDS
  const probe = p.probe ? PAGE_WORDS + p.canaries.length : 0
  return wordCount * 5 + erases * 6 + p.pages.length * 2 + p.witnesses.length +
    p.canaries.length * 2 + reread + probe
}

// --- The generated script -------------------------------------------------------------

const w32 = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0')

/** A TCL brace list of words, eight to a line so the file stays readable. */
function wordList(vals: number[], indent: string): string {
  const lines: string[] = []
  for (let i = 0; i < vals.length; i += 8) {
    lines.push(indent + vals.slice(i, i + 8).map(w32).join(' '))
  }
  return lines.join('\n')
}

export const MARKER = '# swdflash: generated by research/tools/swdflash.ts.'

/**
 * Emit the OpenOCD script.
 *
 * Everything the script needs is in the text, including the data, so it can be read
 * in full before it is run and it cannot silently pick up a different image later.
 */
export function tcl(plan: Plan, cfgPath = 'research/tools/pan1020.cfg'): string {
  const L: string[] = []
  const say = (s = '') => L.push(s)
  const token = w32(plan.crc32)
  const writes = willWrite(plan)
  const blanks = willBlank(plan)
  const keeps = willKeep(plan)

  say(MARKER)
  say('# Do not edit by hand: regenerate it, so the plan and the data cannot diverge.')
  say('#')
  say(`#   openocd -f ${cfgPath} \\`)
  say(`#     -c "set JOGGLES_FLASH_CONFIRM ${token}" -f <this file>`)
  say('#')
  if (plan.donor) {
    say(`# SOURCE     a donor DUMP, ${plan.donor.name}, not an image file.`)
    say(`#            build ${plan.donor.variant ?? 'unlabelled'}, and the target's own`)
    say('#            BLE stack below the window is byte-identical to this donor\'s,')
    say('#            which is what permitted a build whose label differs')
    say('#            These are the bytes another physical unit is running. Everything')
    say('#            in the destination span becomes that unit\'s, except any --keep')
    say('#            span listed below.')
    for (const k of plan.kept) {
      say(`#            keep ${hx(k.start, 5)}-${hx(k.end, 5)} from the target: ${k.why}`)
    }
  }
  say(`# Image      ${plan.imageName}`)
  say(`# Body       ${plan.codeSize} bytes, CRC32 ${token}`)
  say(`# Destination ${hx(plan.base)} to ${hx(plan.imageEnd)}, inside the application`)
  say(`#            region ${hx(WINDOW.start)}-${hx(WINDOW.end)} and nothing else`)
  say(`# Pages      ${writes.length} written, ${blanks.length} erased only, ` +
    `${keeps.length} verified without writing`)
  say('#')
  say('# WHAT THIS CANNOT DO, by construction rather than by care:')
  say('#')
  say('#   - reach any address outside the application window. Every ISPADR write')
  say('#     passes through `guard`, which aborts the session on anything else')
  say('#   - write the config page, the LDROM or the SPROM through their apertures.')
  say(`#     ISPCON gets ${w32(ISPCON_APROM)}, ISPEN | APUEN | ISPFF, so SPUEN, CFGUEN`)
  say('#     and LDUEN are clear and the hardware refuses all three. The script')
  say('#     asserts that after setting it. NOTE: this is about the apertures at')
  say('#     0x300000, 0x100000 and 0x200000. The bootloader and the config page also')
  say('#     live in the main array, at 0x3dc00 and 0x3fe00, inside what APUEN')
  say('#     enables, and there `guard` is the only thing between them and this file')
  say(`#   - whole-chip erase. ISPCMD ${w32(CMD_CHIP_ERASE)} is not in this file and the`)
  say('#     only two')
  say(`#     values written to ISPCMD are ${w32(CMD_PROGRAM)} and ${w32(CMD_PAGE_ERASE)}`)
  say('#   - program a page that was not erased first. `program_word` has one call')
  say('#     site, inside `write_page`, after the erase and its blank check')
  say('#   - lean on the 512-byte page size without testing it. The FIRST erase of')
  say('#     the session sweeps every canary outside the window, and every erase')
  say('#     after it re-reads the page finished before it, so an erase block bigger')
  say('#     than a page stops the run on the second page rather than the 150th')
  say('#')
  say('# NOTHING HAS EVER ERASED OR PROGRAMMED THE APPLICATION REGION ON THIS FAMILY.')
  say('# ISPCMD 0x22 and 0x21 are *verified* on silicon as of 2026-08-19, but on the')
  say('# CONFIG page with CFGUEN, four words at a time. This is APUEN, the application')
  say(`# region, and ${plan.pages.length} pages. Read notes/swd-flashing.md first.`)
  say('#')
  say('# Run the glasses from their own battery, never the probe. A brown-out during')
  say('# an erase is the one failure that may not be recoverable.')
  say('')

  say('# The confirmation is the image CRC, so a command line copied from an older')
  say('# session cannot flash a different image than the one it names.')
  say('if {![info exists JOGGLES_FLASH_CONFIRM]} {')
  say('  echo "REFUSED: this script erases and programs flash."')
  say(`  echo "Re-run with: -c {set JOGGLES_FLASH_CONFIRM ${token}}"`)
  say('  shutdown error')
  say('}')
  say('if {[catch {expr {($JOGGLES_FLASH_CONFIRM & 0xffffffff) != ' +
    `${token}}} jgx_bad] || $jgx_bad} {`)
  say(`  echo "REFUSED: JOGGLES_FLASH_CONFIRM must be ${token}, the CRC32 of"`)
  say(`  echo "${plan.imageName}. It is not, so this is not the image you meant."`)
  say('  shutdown error')
  say('}')
  say('')
  say('# Slower than the 200 kHz the dumps were taken at, for margin. A poor ground')
  say('# return shows up as intermittent reads, which during a program is a stop.')
  say(`adapter speed ${plan.speedKhz}`)
  say('')

  // --- procs -------------------------------------------------------------------
  say('# The teardown, called on the success path and on every abort. Writing any')
  say('# value that is not the key sequence re-locks SYS_WRPROT: *derived* from')
  say('# Nuvoton, and nothing depends on it, since a power cycle clears the register.')
  say('proc lock_down {} {')
  say(`  mww ${hx(FMC.ISPCON)} ${w32(ISPCON_OFF)}`)
  say(`  mww ${hx(FMC.WRPROT)} ${w32(0)}`)
  say('}')
  say('')
  say('# Every abort goes through here, so the FMC is disabled and SYS_WRPROT is')
  say('# re-locked on the error paths as well as the success path. A run that stopped')
  say('# half way used to leave ISPEN and APUEN set with the write protection open,')
  say('# and whatever resumed the core next would have run with the flash writable.')
  say('proc fail {msg} {')
  say('  echo "FAILED: $msg"')
  say('  catch {lock_down}')
  say('  echo "The ISP engine is disabled and SYS_WRPROT is re-locked."')
  say('  echo "Stopping. Re-dump before deciding what state the unit is in."')
  say('  shutdown error')
  say('}')
  say('')
  say('proc rd {addr} { return [expr {[lindex [read_memory $addr 32 1] 0] & 0xffffffff}] }')
  say('')
  say('# Every address that reaches ISPADR passes through here. The bounds are the')
  say('# application region: the BLE stack, the staging bank, the saved content, the')
  say('# info pages, the bootloader, the LDROM aperture and the config page are all')
  say('# outside it, so no mistake above this line can reach any of them.')
  say('#')
  say('# For four of those this is the SECOND layer and the hardware is the first.')
  say('# For the BLE stack at 0x0-0x16800, the staging bank, the saved content, the')
  say('# info pages, the bootloader content at 0x3dc00 and the config page at its')
  say('# main-array address 0x3fe00, it is the ONLY layer: all of them are inside')
  say('# what APUEN enables. research/fmc-erase-program.md, finding 5.')
  say('proc guard {addr} {')
  say(`  if {$addr < ${hx(WINDOW.start)} || $addr >= ${hx(WINDOW.end)}} {`)
  say('    fail "address [format 0x%08x $addr] is outside the application window ' +
    `${hx(WINDOW.start)}-${hx(WINDOW.end)}"`)
  say('  }')
  say('}')
  say('')
  say('# The core must still be halted, and must not have reset since the last look.')
  say('# S_RESET_ST is sticky and clears on read, so the first call after a reset sees')
  say('# it. A reset mid-run means OpenOCD resumed the application, which writes flash')
  say('# itself on a DATS save, on top of whatever this session is doing.')
  say('proc check_halted {what} {')
  say(`  set st [rd ${hx(DHCSR, 8)}]`)
  say(`  if {($st & ${w32(DHCSR_S_HALT)}) == 0} {`)
  say('    fail "$what: the core is not halted, DHCSR [format 0x%08x $st]. It has been')
  say('resumed or reset, and the application writes flash itself"')
  say('  }')
  say(`  if {($st & ${w32(DHCSR_S_RESET_ST)}) != 0} {`)
  say('    fail "$what: the core RESET during this session, DHCSR [format 0x%08x $st].')
  say('Stop and dump: the application may have run while the FMC was unlocked"')
  say('  }')
  say('}')
  say('')
  say('# A page erase takes milliseconds and reading flash while the ISP engine is')
  say('# busy can stall the AHB past OpenOCD\'s timeout. Bounded at ~2s.')
  say('proc wait_trg {} {')
  say('  for {set i 0} {$i < 2000} {incr i} {')
  say(`    if {([lindex [read_memory ${hx(FMC.ISPTRG)} 32 1] 0] & 1) == 0} { return }`)
  say('    sleep 1')
  say('  }')
  say('  fail "ISPTRG stuck busy"')
  say('}')
  say('')
  say('# ISPCON bit 6 is the fail flag. It used to be cleared here and the run stopped')
  say('# anyway, which achieved nothing and was a wholesale store to a register whose')
  say('# bit 1 is boot select. It is left set now, so a dump taken afterwards still')
  say('# shows that the FMC refused something. `lock_down` disables the engine.')
  say('proc isp_ok {what} {')
  say(`  set con [rd ${hx(FMC.ISPCON)}]`)
  say(`  if {($con & ${hx(ISPCON.ISPFF)}) != 0} {`)
  say('    fail "$what: ISPCON bit 6 set, the FMC refused the operation"')
  say('  }')
  say('}')
  say('')
  // The consequence is the caller's, not this proc's. It used to end "Nothing has
  // been written.", which is true in sections 1 and 2 and false in section 8, where
  // the same proc runs the after-the-fact sweep: it would have been read as
  // reassurance at the exact moment it was wrong.
  say('proc expect_word {addr want what note} {')
  say('  set got [rd $addr]')
  say('  if {$got != ($want & 0xffffffff)} {')
  say('    fail "$what at [format 0x%08x $addr] reads [format 0x%08x $got], expected \\')
  say('[format 0x%08x $want]. $note"')
  say('  }')
  say('}')
  say('')
  say('proc check_erased {addr count} {')
  say('  set got [read_memory $addr 32 $count]')
  say('  set i 0')
  say('  foreach g $got {')
  say('    if {($g & 0xffffffff) != 0xffffffff} {')
  say('      fail "[format 0x%08x [expr {$addr + $i * 4}]] reads [format 0x%08x $g] \\')
  say('after an erase, not 0xffffffff"')
  say('    }')
  say('    incr i')
  say('  }')
  say('}')
  say('')
  say('proc check_words {addr expected} {')
  say('  set got [read_memory $addr 32 [llength $expected]]')
  say('  set i 0')
  say('  foreach e $expected {')
  say('    set g [lindex $got $i]')
  say('    if {($g & 0xffffffff) != ($e & 0xffffffff)} {')
  say('      fail "[format 0x%08x [expr {$addr + $i * 4}]] reads [format 0x%08x $g], \\')
  say('expected [format 0x%08x $e]"')
  say('    }')
  say('    incr i')
  say('  }')
  say('}')
  say('')
  // The canary list, as a proc, so it can be swept more than once: before, after the
  // very first erase of the session, and at the end. The middle sweep is the only one
  // that can stop an oversized erase block before it has been repeated 149 times.
  say('# The words outside the window that must not change, as one callable sweep.')
  say('proc canary_sweep {note} {')
  for (const c of plan.canaries) {
    say(`  expect_word ${hx(c.addr, 8)} ${w32(c.word)} {${c.what}} "$note"`)
  }
  if (plan.canaries.length === 0) say('  # none: this script was generated with no dump')
  say('}')
  say('')
  say('# What has been written and proved, so it can be proved again. An erase that')
  say('# reaches backwards over a page already programmed is invisible to the erased')
  say('# check of the page it aimed at, so every erase re-reads the last page finished.')
  say('set ::JGX_ORDER {}')
  say('array set ::JGX_DATA {}')
  say('array set ::JGX_TAIL {}')
  say('set ::JGX_SWEPT 0')
  say('')
  say('proc record_page {addr data tail} {')
  say('  lappend ::JGX_ORDER $addr')
  say('  set ::JGX_DATA($addr) $data')
  say('  set ::JGX_TAIL($addr) $tail')
  say('}')
  say('')
  say('proc verify_page {addr} {')
  say('  set data $::JGX_DATA($addr)')
  say('  if {[llength $data] > 0} { check_words $addr $data }')
  say('  set tail $::JGX_TAIL($addr)')
  say('  if {$tail > 0} { check_erased [expr {$addr + 4 * [llength $data]}] $tail }')
  say('}')
  say('')
  say('# The page finished most recently, re-read after the next erase. Any erase block')
  say('# larger than a page and reaching backwards contains it, because it is the')
  say('# adjacent page; a block that reaches only forwards has its base at the page')
  say('# just erased and has destroyed nothing that was already written.')
  say('proc verify_last {} {')
  say('  if {[llength $::JGX_ORDER] == 0} { return }')
  say('  verify_page [lindex $::JGX_ORDER end]')
  say('}')
  say('')
  say(`# ISPCMD ${w32(CMD_PAGE_ERASE)}, page erase. The other erase opcode this FMC has`)
  say(`# is whole-chip erase, ${w32(CMD_CHIP_ERASE)}, which is not in this file and must`)
  say('# never be added.')
  say('proc erase_page {addr} {')
  say('  check_halted "before the erase at [format 0x%08x $addr]"')
  say('  guard $addr')
  say(`  guard [expr {$addr + ${PAGE - 1}}]`)
  say(`  if {($addr % ${PAGE}) != 0} {`)
  say(`    fail "erase of [format 0x%08x $addr], which is not on a ${PAGE}-byte page"`)
  say('  }')
  say(`  mww ${hx(FMC.ISPCMD)} ${w32(CMD_PAGE_ERASE)}`)
  say(`  mww ${hx(FMC.ISPADR)} $addr`)
  say(`  mww ${hx(FMC.ISPTRG)} 0x00000001`)
  say('  wait_trg')
  say('  isp_ok "page erase at [format 0x%08x $addr]"')
  say(`  check_erased $addr ${PAGE_WORDS}`)
  say('  # The 512-byte page is *derived*. These two lines are the whole of the test')
  say('  # for it, and between them they cover every block size from 1 KB upwards:')
  say('  # the sweep catches a block that leaves the window, verify_last catches one')
  say('  # that stays inside it and eats the page before this one.')
  say('  if {!$::JGX_SWEPT} {')
  say('    set ::JGX_SWEPT 1')
  say('    canary_sweep {This is the FIRST erase of the session and it reached OUTSIDE\\')
  say(' the window, so the erase block is larger than 512 bytes and flash below or above\\')
  say(' the application region is gone. STOP. Do not retry and do not power cycle: dump\\')
  say(' the unit and work out what is missing.}')
  say('  }')
  say('  verify_last')
  say('}')
  say('')
  say(`# ISPCMD ${w32(CMD_PROGRAM)}, program one word. Order is the vendor's own, at`)
  say('# abs 0x17a78: command, address, data, trigger.')
  say('proc program_word {addr word} {')
  say('  guard $addr')
  say('  guard [expr {$addr + 3}]')
  say('  if {($addr % 4) != 0} {')
  say('    fail "program at [format 0x%08x $addr], which is not word aligned"')
  say('  }')
  say(`  mww ${hx(FMC.ISPCMD)} ${w32(CMD_PROGRAM)}`)
  say(`  mww ${hx(FMC.ISPADR)} $addr`)
  say(`  mww ${hx(FMC.ISPDAT)} $word`)
  say(`  mww ${hx(FMC.ISPTRG)} 0x00000001`)
  say('  wait_trg')
  say('  isp_ok "program at [format 0x%08x $addr]"')
  say('}')
  say('')
  say('# The only caller of program_word, and it erases first. Splitting the two is')
  say('# what produces a page that reads back as garbage with no error anywhere, so')
  say('# they are one operation here rather than two that must be used in order.')
  say('proc write_page {addr data tail} {')
  say('  erase_page $addr')
  say('  set a $addr')
  say('  foreach word $data {')
  say('    program_word $a $word')
  say('    set a [expr {$a + 4}]')
  say('  }')
  say('  check_words $addr $data')
  say('  if {$tail > 0} { check_erased [expr {$addr + 4 * [llength $data]}] $tail }')
  say('  record_page $addr $data $tail')
  say('}')
  say('')
  say('# Erase with nothing to follow: a page the source holds entirely erased, or a')
  say('# page of a longer previous image under --blank-tail. Programming 0xffffffff')
  say('# word by word would reach the same array contents 128 transactions later.')
  say(`proc blank_page {addr} { erase_page $addr ; record_page $addr {} ${PAGE_WORDS} }`)
  say('')
  say('# --resume: the dump says this page already holds the image, so it is read')
  say('# back and proved rather than rewritten. tail is the words after the data,')
  say('# which must still be erased or a stale tail would survive the skip.')
  say('proc keep_page {addr data tail} {')
  say('  check_words $addr $data')
  say('  if {$tail > 0} { check_erased [expr {$addr + 4 * [llength $data]}] $tail }')
  say('  record_page $addr $data $tail')
  say('}')
  say('')

  // --- body --------------------------------------------------------------------
  say('init')
  say('halt')
  say('')
  say('echo "=== 1. precondition, read before anything is unlocked"')
  if (plan.witnesses.length === 0) {
    say('echo "  no witnesses: this script was generated without a dump"')
  }
  for (const wt of plan.witnesses) {
    say(`expect_word ${hx(wt.addr, 8)} ${w32(wt.word)} {${wt.what}} ` +
      '{Nothing has been written.}')
  }
  say('echo "  the unit matches the dump this script was built from"')
  say('')
  say('echo "=== 2. canaries outside the window, before"')
  say('canary_sweep {Nothing has been written.}')
  say('')
  say('check_halted "before the unlock"')
  say('echo "=== 3. unlock SYS_WRPROT"')
  for (const k of UNLOCK_KEYS) say(`mww ${hx(FMC.WRPROT)} ${w32(k)}`)
  say(`if {([rd ${hx(FMC.WRPROT)}] & 1) != 1} {`)
  say('  fail "SYS_WRPROT is still locked after the 0x59/0x16/0x88 keys"')
  say('}')
  say('')
  say(`echo "=== 4. ISPCON := ISPEN | APUEN | ISPFF, read-modify-write"`)
  say('# Read first. Nobody has ever seen this register on this part, and bit 1 is BS,')
  say('# boot select, which is writable and comes up as the inverse of CONFIG0[7]. So')
  say('# the update-enable bits are cleared and the engine enabled without storing a')
  say('# whole word over whatever the boot ROM left behind.')
  say(`set jgx_was [rd ${hx(FMC.ISPCON)}]`)
  say('echo "  ISPCON as found: [format 0x%08x $jgx_was]"')
  say(`set jgx_new [expr {($jgx_was & ${w32(ISPCON_KEEP)}) | ${w32(ISPCON_APROM)}}]`)
  say(`mww ${hx(FMC.ISPCON)} $jgx_new`)
  say(`set jgx_con [rd ${hx(FMC.ISPCON)}]`)
  say(`if {($jgx_con & ${w32(ISPCON.ISPEN | ISPCON.APUEN)}) != ` +
    `${w32(ISPCON.ISPEN | ISPCON.APUEN)}} {`)
  say('  fail "ISPCON reads [format 0x%08x $jgx_con]: ISPEN or APUEN did not take"')
  say('}')
  say('# The load-bearing assertion of the whole session. Four update-enable bits, not')
  say('# three: SPUEN at bit 2 gates the SPROM at 0x00200000, which no dump in this')
  say('# project covers. With all three of these clear the config page, the LDROM and')
  say('# the SPROM are refused through their apertures by the hardware, not by this')
  say('# file. That is NOT established for the same content at its main-array')
  say('# addresses, 0x3dc00 and 0x3fe00, which are inside what APUEN enables: there,')
  say('# `guard` is the only layer. research/fmc-erase-program.md, finding 5.')
  say(`if {($jgx_con & ${w32(ISPCON_MUST_BE_CLEAR)}) != 0} {`)
  say('  fail "ISPCON has SPUEN, CFGUEN or LDUEN set: [format 0x%08x $jgx_con]"')
  say('}')
  say('')
  const pb = plan.probe
  say('echo "=== 5. erase granularity, tested once before 150 pages assume it"')
  if (pb) {
    say(`# The 512-byte page size is *derived* (notes/swd-flashing.md, "What is still`)
    say('# unproven", item 2) and this is where it stops being assumed. One page is')
    say(`# erased first, at ${hx(pb.addr, 5)}, chosen so that an erase block of up to`)
    const lo = blockBase(pb.addr, pb.containedTo)
    say(`# ${pb.containedTo} bytes runs from ${hx(lo, 5)} to ` +
      `${hx(lo + pb.containedTo, 5)}, both inside`)
    say('# the window. Nothing the probe can destroy is outside the span this run')
    say('# rewrites anyway. Then the page below it is read back in full: every block')
    say(`# size from 1 KB to ${pb.containedTo} contains ${hx(pb.below, 5)}, and`)
    say(`# ${pb.sighted} of its ${PAGE_WORDS} words are not already erased, so an`)
    say('# oversized erase cannot hide there.')
    say(`erase_page ${hx(pb.addr, 5)}`)
    say(`check_words ${hx(pb.below, 5)} {`)
    say(wordList(pb.belowWords, '  '))
    say('}')
    if (pb.above !== null) {
      say('# And the page above, for a block geometry that is neither a power of two')
      say('# nor aligned. Nothing suggests one; nothing rules one out either.')
      say(`check_words ${hx(pb.above, 5)} {`)
      say(wordList(pb.aboveWords, '  '))
      say('}')
    }
    say(`echo "  512-byte granularity holds at ${hx(pb.addr, 5)}: the page below is"`)
    say('echo "  intact and every canary outside the window still matches"')
  } else {
    say('# NO PROBE. This plan has no two consecutive pages to write, so there is no')
    say('# page whose erase could be checked against a neighbour the run also owns.')
    say('# The 512-byte page size is *derived* and this run does not test it before it')
    say('# depends on it. The canary sweep inside the first erase, and verify_last')
    say('# after every erase, still catch an oversized block one page later.')
    say('echo "  no probe: fewer than two consecutive pages to write"')
  }
  say('')
  const total = plan.pages.length
  say(`echo "=== 6. ${total} pages: ${writes.length} written, ${blanks.length} erased, ` +
    `${keeps.length} kept"`)
  let n = 0
  for (const p of plan.pages) {
    n++
    const label = `${n}/${total} ${hx(p.addr, 5)}`
    if (p.skip) {
      const ws = p.data ? words(p.data) : []
      const tail = PAGE_WORDS - ws.length
      say(`echo "  keep  ${label}"`)
      if (p.data === null) {
        say(`check_erased ${hx(p.addr, 5)} ${PAGE_WORDS}`)
      } else {
        say(`keep_page ${hx(p.addr, 5)} {`)
        say(wordList(ws, '  '))
        say(`} ${tail}`)
      }
      continue
    }
    if (p.data === null) {
      say(`echo "  blank ${label}"`)
      say(`blank_page ${hx(p.addr, 5)}`)
      continue
    }
    const ws = words(p.data)
    say(`echo "  write ${label}"`)
    say(`write_page ${hx(p.addr, 5)} {`)
    say(wordList(ws, '  '))
    say(`} ${PAGE_WORDS - ws.length}`)
  }
  say('')
  say('# Every page was read back as it was written, and every erase re-read the page')
  say('# before it. This reads the whole window once more at the end, so what the')
  say('# script claims is the state of the flash NOW and not the state each page was')
  say('# in at the moment it was finished. It writes nothing.')
  say(`echo "=== 7. read all ${plan.pages.length} pages back again, as they now stand"`)
  say('foreach jgx_a $::JGX_ORDER { verify_page $jgx_a }')
  say(`if {[llength $::JGX_ORDER] != ${plan.pages.length}} {`)
  say(`  fail "only [llength $::JGX_ORDER] of ${plan.pages.length} pages were reached"`)
  say('}')
  say('')
  say('echo "=== 8. canaries again. A change here means something wrote outside"')
  say('echo "       the window, which nothing in this script can do"')
  say('canary_sweep {This is AFTER the write, so it is NOT true that nothing has been\\')
  say(' written: the application region has been erased and reprogrammed. Something\\')
  say(' reached outside the window. Do not power cycle and do not retry until you have\\')
  say(' dumped the unit and worked out what moved.}')
  say('')
  say('check_halted "after the last page"')
  say('echo "=== 9. disable the ISP engine and re-lock SYS_WRPROT"')
  say('lock_down')
  say('')
  say('echo "=== DONE. Every word written was read back twice: once as it was"')
  say(`echo "written, and once at the end with all ${plan.pages.length} pages in place."`)
  say('echo "Now: power-cycle the glasses from their own button, then dump and check"')
  // In donor mode `imageName` carries a parenthetical, so pasting it produced a
  // command line that does not run. The donor form takes --donor instead.
  say(plan.donor
    ? `echo "  bun research/tools/swdflash.ts verify <dump.bin> --donor ${plan.donor.name}"`
    : `echo "  bun research/tools/swdflash.ts verify <dump.bin> ${plan.imageName}"`)
  say('shutdown')
  say('')
  return L.join('\n')
}

// --- Reporting -------------------------------------------------------------------------

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

export function planReport(plan: Plan, verdict: ota.Verdict): string[] {
  const out: string[] = []
  const say = (s = '') => out.push(s)
  const writes = willWrite(plan)
  const blanks = willBlank(plan)
  const keeps = willKeep(plan)

  if (plan.donor) {
    say(`donor       ${plan.donor.name}`)
    say('            a dump of another unit, and the source of every byte below')
  }
  say(`image       ${plan.imageName}`)
  say(`            ${plan.codeSize} bytes, CRC32 ${w32(plan.crc32)}`)
  say(ota.report(verdict).split('\n').map((l) => '            ' + l.trim()).join('\n'))
  say()
  say(`destination ${hx(plan.base)} to ${hx(plan.imageEnd)}`)
  say(`window      ${hx(WINDOW.start)}-${hx(WINDOW.end)}, the ${WINDOW.name} region`)
  say(`            ${WINDOW.end - WINDOW.start - (plan.imageEnd - plan.base)} bytes ` +
    'of it left over')
  say()
  say('pages')
  say(`  write     ${writes.length}, erased then programmed then read back`)
  say(`  blank     ${blanks.length}, erased only`)
  say(`  keep      ${keeps.length}, already correct, read back but not rewritten`)
  const wordCount = writes.reduce((n, x) => n + x.data!.length / 4, 0)
  const [lo, hi] = estimateMinutes(plan)
  say(`  ${plural(wordCount, 'word')} programmed, about ${transactions(plan)} register`)
  say(`  transactions, which at ${plan.speedKhz} kHz is roughly ${lo.toFixed(0)} to ` +
    `${hi.toFixed(0)} minutes.`)
  say('  It is all wire time: the flash itself is under two seconds of it. *derived*')
  say('  by arithmetic, and nobody has run one of these')
  if (plan.probe) {
    const lo = blockBase(plan.probe.addr, plan.probe.containedTo)
    say()
    say(`granularity  probed at ${hx(plan.probe.addr, 5)} before any other page, then`)
    say(`             ${hx(plan.probe.below, 5)} read back whole. A block of up to ` +
      `${plan.probe.containedTo} B`)
    say(`             lies in ${hx(lo, 5)}-${hx(lo + plan.probe.containedTo, 5)}, ` +
      'inside the window, so the probe')
    say('             cannot damage anything this run does not rewrite')
  } else {
    say()
    say('granularity  NOT PROBED: no two consecutive pages to write. The 512-byte page')
    say('             is *derived* and this run leans on it before testing it')
  }
  say()
  say('NOT COVERED BY ANY DUMP: the SPROM at 0x00200000, 512 bytes, which the vendor')
  say('  calls the ID block and which ISPCON bit 2 SPUEN gates. Every dump this')
  say('  project holds is 0x0-0x3ffff, so it has never been read, and it is the best')
  say('  candidate for the factory trim or unique ID that research/hardware-access.md')
  say('  warns may live outside that range. `mdw 0x00200000 128` is read-only and')
  say('  takes seconds. Archive it before this session, not after.')
  say()
  say('never touched, and proved so by a canary read before, after the first erase,')
  say('and at the end')
  for (const r of REGIONS) {
    if (r.start === WINDOW.start && r.end === WINDOW.end) continue
    const hits = plan.canaries.filter((x) => x.addr >= r.start && x.addr < r.end)
    const span = `${hx(r.start, 5)}-${hx(r.end, 5)}`
    if (hits.length === 0) say(`  ${r.name.padEnd(19)} ${span}  no canary`)
    for (const c of hits) {
      say(`  ${r.name.padEnd(19)} ${span}  canary ${hx(c.addr, 5)} = ${w32(c.word)}`)
    }
  }
  for (const c of plan.canaries) {
    if (c.addr < ota.FLASH_ADDR_END) continue
    say(`  ${c.what.padEnd(19)} ${hx(c.addr, 5)}          canary = ${w32(c.word)}`)
  }
  say()
  if (plan.witnesses.length) {
    say(`precondition, checked before the FMC is unlocked: ` +
      `${plural(plan.witnesses.length, 'word')}`)
    for (const wt of plan.witnesses.slice(0, 4)) {
      say(`  ${hx(wt.addr, 5)} = ${w32(wt.word)}  ${wt.what}`)
    }
    if (plan.witnesses.length > 4) say(`  ... and ${plan.witnesses.length - 4} more`)
  } else {
    say('precondition: NONE. Without --from the script cannot tell it is talking to')
    say('the unit you think it is.')
  }
  for (const n of plan.notes) {
    say()
    say('note: ' + n)
  }
  return out
}

// --- Which baseline the patch checks diff against ---------------------------------------

export interface BaselineInput {
  /** The target's own dump, from `--from`. */
  from?: Dump | null
  /** An explicit `--stock`, already read. A container or a raw dump; both are taken. */
  explicit?: { path: string; bytes: Uint8Array } | null
  /** The APK container, if it is on disk. The last resort, never the first choice. */
  apk?: { path: string; bytes: Uint8Array } | null
}

export interface Baseline {
  /** The container `ota.check` diffs against, or undefined for no patch checks. */
  stock?: Uint8Array
  /** Said in the plan header, because which baseline was used changes what it means. */
  whence: string
  /** The build label to hold the payload to, read off the target. */
  expectVersion?: string
}

/**
 * Choose the baseline, and the build label, for an image that is a patch of something.
 *
 * **The target's own application, whenever a dump is given.** `comparePatch` and
 * `PROTECTED_REGIONS` only mean anything against the build the image is a patch OF, and
 * since 2026-08-19 that is not the APK's for any unit here
 * (`research/hardfault-0xd38-2026-08-19.md`). Handed the APK, an image rebased on a
 * donor comes back with seven `protected-region` fatals and `looks-like-an-insertion`,
 * every one of which says only "TR1906R04-12 is not TR1906R04-10". Seven spurious
 * fatals is how a person learns to skip a gate.
 *
 * Picking the right baseline does not re-place the regions, and that is the half this
 * function cannot do: the names still sit at the APK's offsets. `fwtool regions`
 * resolves all seven by content in whichever window it is given, and on a real unit
 * five of the seven static spans miss their code outright
 * (`research/protected-regions-2026-08-20.md`). Until `PROTECTED_REGIONS` is resolved
 * rather than looked up, a clean `comparePatch` off a donor baseline means "no byte
 * outside the patch changed", not "no protected code was touched".
 *
 * `expectVersion` is read off the target for the same reason, and deliberately **not**
 * off the image: an image vouching for its own variant is the tool agreeing with
 * itself, which is the failure `research/swdflash-review-2026-08-20.md` records about
 * the simulator. A dump is a fact about silicon.
 */
export function chooseBaseline(input: BaselineInput): Baseline {
  const targetWindow = input.from ? at(input.from, WINDOW.start, WINDOW.end) : null
  const expectVersion = targetWindow ? (variantOf(targetWindow) ?? undefined) : undefined

  if (input.explicit) {
    // A raw dump as readily as a container: a baseline read off a unit is the better
    // one, and making someone re-encode it by hand first is friction on the path we
    // want taken.
    const window = at(dump(input.explicit.bytes, 0), WINDOW.start, WINDOW.end)
    return {
      stock: window ? ota.encode(window.slice(), DONOR_HEADER) : input.explicit.bytes,
      whence: `${input.explicit.path}${window ? ', its application window' : ''}`,
      expectVersion,
    }
  }
  if (targetWindow) {
    return {
      stock: ota.encode(targetWindow.slice(), DONOR_HEADER),
      whence: "the target's own application, out of the dump given to --from",
      expectVersion,
    }
  }
  if (input.apk) {
    return {
      stock: input.apk.bytes,
      whence: `${input.apk.path}, the APK container, because no dump was given. Its ` +
        'layout is not the one any unit here runs, so read the findings as questions',
      expectVersion,
    }
  }
  return { whence: 'none, so the patch checks did not run', expectVersion }
}

// --- CLI -------------------------------------------------------------------------------

const DEFAULT_STOCK = 'firmware/TR1906R04-10_OTA.bin'

/**
 * Both APK containers, because a donor matching either one carries the defect.
 *
 * `research/hardfault-0xd38-2026-08-19.md`: neither `TR1906R04-1-10` (appVer 1) nor
 * `TR1906R04-10` (appVer 3) registers callback slot `+0x60`, so either would brick a
 * unit the same way. Whichever is on disk is used; a missing one is not an error,
 * because `firmware/` is gitignored.
 */
const APK_CONTAINERS = ['firmware/TR1906R04-10_OTA.bin', 'firmware/TR1906R04-1-10_OTA.bin']

async function apkContainers(): Promise<{ name: string; container: Uint8Array }[]> {
  const out: { name: string; container: Uint8Array }[] = []
  for (const name of APK_CONTAINERS) {
    const f = Bun.file(name)
    if (!(await f.exists())) continue
    out.push({ name, container: new Uint8Array(await f.arrayBuffer()) })
  }
  return out
}

const num = (s: string) => (s.startsWith('0x') ? parseInt(s.slice(2), 16) : parseInt(s, 10))

async function readFile(path: string): Promise<Uint8Array> {
  const f = Bun.file(path)
  if (!(await f.exists())) {
    console.error(`no such file: ${path}`)
    process.exit(2)
  }
  return new Uint8Array(await f.arrayBuffer())
}

const USAGE = [
  'usage: bun research/tools/swdflash.ts <plan|script|verify> ...',
  '',
  '  plan   <image> [--from <dump.bin>] [flags]     writes nothing, says everything',
  '  script <image> --from <dump.bin> --yes [flags] emits the OpenOCD script',
  '  donor  <a.bin> <b.bin> [...] --to <dump.bin>   copy a working unit across',
  '  verify <dump.bin> [image] [--donor <a.bin>]    after the flash, from a new dump',
  '',
  '  --from <dump.bin>  dump of the unit being flashed. Required for `script`',
  '  --to <dump.bin>    the same, for `donor`. Required',
  '  --keep <lo>-<hi>   in `donor`, take this span from the target. Repeatable',
  '  --out <file.tcl>   where the script goes. Default under firmware/',
  '  --stock <file>     baseline to diff against: a container or a raw dump.',
  '                     Default is the --from dump\'s own application, not the APK',
  '  --resume           skip pages the dump shows already correct',
  '  --blank-tail       erase the rest of the application region too',
  '  --config0 <hex>    the word at 0x00300000, watched as a canary',
  '  --ldrom <hex>      the word at 0x00100000, likewise',
  '  --speed <kHz>      adapter speed. Default 100',
  '  --base <hex>       address a `verify` dump starts at. Default 0',
].join('\n')

/** Parse `0x16800-0x16900` into a span. */
export function parseKeep(s: string): KeepSpan | null {
  const m = /^(0x[0-9a-fA-F]+|\d+)-(0x[0-9a-fA-F]+|\d+)$/.exec(s.trim())
  if (!m) return null
  return { start: num(m[1]), end: num(m[2]), why: 'named on the command line' }
}

async function main(argv: string[]): Promise<number> {
  const TAKES_VALUE = new Set([
    'from', 'to', 'out', 'stock', 'config0', 'ldrom', 'speed', 'base', 'keep', 'donor',
  ])
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const repeated = new Map<string, string[]>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    const name = a.slice(2)
    if (TAKES_VALUE.has(name)) {
      const v = argv[++i] ?? ''
      values.set(name, v)
      repeated.set(name, [...(repeated.get(name) ?? []), v])
    } else flags.add(name)
  }

  const [cmd, first, second] = positional
  if (!cmd || !['plan', 'script', 'donor', 'verify'].includes(cmd)) {
    console.error(USAGE)
    return 2
  }

  if (cmd === 'verify') {
    if (!first) {
      console.error('verify needs a dump: swdflash verify <dump.bin> [image]')
      return 2
    }
    const bytes = await readFile(first)
    const d = dump(bytes, values.has('base') ? num(values.get('base')!) : 0)
    const donorPaths = repeated.get('donor') ?? []
    let plain: Uint8Array
    let imagePath: string
    if (donorPaths.length) {
      const read = await Promise.all(
        donorPaths.map(async (p) => ({ name: p, bytes: await readFile(p) })),
      )
      const src = readDonor({ dumps: read, apk: await apkContainers() })
      if (!src.donor) {
        console.error('REFUSED: the donor cannot be trusted as a reference either.')
        for (const r of src.refusals) console.error(`  ${r}`)
        return 1
      }
      plain = src.donor.window
      imagePath = `donor ${src.donor.name}`
    } else {
      imagePath = second ?? 'firmware/joggles-v1.bin'
      plain = referenceImage(await readFile(imagePath)).plain
    }
    const diff = compareImage(d, WINDOW.start, plain, 0)
    console.log(`dump   ${first}`)
    console.log(`image  ${imagePath}, ${plain.length} bytes`)
    if (!diff.covered) {
      const end = WINDOW.start + plain.length
      console.log(`the dump does not cover ${hx(WINDOW.start)}-${hx(end)}`)
      return 1
    }
    if (diff.matched) {
      console.log(`MATCHES byte for byte at ${hx(WINDOW.start)}`)
      const ext = extensionIn(d)
      if (ext) {
        const subs = ext.subcommands.map((s) => hx(s)).join(', ')
        console.log(`  carries ${ext.magic} v${ext.version}, ${ext.size} bytes, ` +
          `entry ${hx(ext.entry)}, sub-commands ${subs}`)
      }
      const tail = census(d, WINDOW.start + plain.length, WINDOW.end)
      if (tail.firstUsed !== null) {
        console.log(`  ${hx(tail.firstUsed)}-${hx(tail.lastUsed!)} beyond the image is ` +
          'not erased. Inert, but --blank-tail would have cleared it')
      }
      console.log('-> the flash landed')
      return 0
    }
    console.log(`DIFFERS: ${plural(diff.differing, 'byte')} in ` +
      `${plural(diff.runs.length, 'run')}`)
    for (const r of diff.runs.slice(0, 12)) {
      console.log(`  abs ${hx(r.abs, 5)}  body ${hx(r.body, 4)}  ${r.length} B`)
    }
    if (diff.runs.length > 12) console.log(`  ... and ${diff.runs.length - 12} more runs`)
    console.log('-> re-run `script` with --resume against this dump to fix only the')
    console.log('   pages that are wrong')
    return 1
  }

  let donor: DonorSource | null = null
  let keep: KeepSpan[] = []
  let targetBytes: Uint8Array | null = null
  if (cmd === 'donor') {
    const donorPaths = positional.slice(1)
    if (donorPaths.length === 0) {
      console.error('donor needs its dumps: swdflash donor <a.bin> <b.bin> --to <dump>')
      return 2
    }
    if (!values.has('to')) {
      console.error('donor needs --to <dump.bin>, a dump of the unit being written.')
      console.error('It is where the preconditions and the canaries come from, and it')
      console.error('is the only thing that can tell the two units apart.')
      return 2
    }
    const read = await Promise.all(
      donorPaths.map(async (p) => ({ name: p, bytes: await readFile(p) })),
    )
    // The target is read here rather than below, because the donor cannot be trusted
    // without it: the stack comparison is what authorises writing one unit's
    // application onto another.
    const toPath = values.get('to')!
    targetBytes = await readFile(toPath)
    const src = readDonor({
      dumps: read,
      apk: await apkContainers(),
      target: { name: toPath, bytes: targetBytes },
    })
    console.log(`donor  ${donorPaths.join(', ')}`)
    for (const f of src.facts) console.log(`       ${f}`)
    console.log(`target ${values.get('to')}`)
    console.log()
    if (!src.donor) {
      console.error('REFUSED: this donor cannot be the source for another unit.')
      for (const r of src.refusals) console.error(`  ${r}`)
      return 1
    }
    donor = src.donor
    keep = UNIT_SPECIFIC.slice()
    for (const s of repeated.get('keep') ?? []) {
      const span = parseKeep(s)
      if (!span) {
        console.error(`--keep ${s} is not a span; write it as 0x26c00-0x26c10`)
        return 2
      }
      keep.push(span)
    }
  } else if (!first) {
    console.error(`${cmd} needs an image path`)
    return 2
  }

  const image = donor ? undefined : await readFile(first)

  let from: Dump | null = null
  const fromPath = values.get(donor ? 'to' : 'from')
  if (fromPath) from = dump(targetBytes ?? (await readFile(fromPath)), 0)

  const stockPath = values.get('stock')
  const sameFile =
    !donor && stockPath !== undefined &&
    Bun.pathToFileURL(stockPath).href === Bun.pathToFileURL(first).href
  let explicit: { path: string; bytes: Uint8Array } | null = null
  if (stockPath !== undefined && !sameFile) {
    if (!(await Bun.file(stockPath).exists())) {
      console.error(`no such --stock file: ${stockPath}`)
      return 2
    }
    explicit = { path: stockPath, bytes: new Uint8Array(await Bun.file(stockPath).arrayBuffer()) }
  }
  const apkOnDisk = (await Bun.file(DEFAULT_STOCK).exists())
    ? { path: DEFAULT_STOCK, bytes: new Uint8Array(await Bun.file(DEFAULT_STOCK).arrayBuffer()) }
    : null
  const baseline =
    donor || sameFile
      ? { stock: undefined, whence: '', expectVersion: donor?.variant ?? undefined }
      : chooseBaseline({ from, explicit, apk: apkOnDisk })
  const stock = baseline.stock
  const expectVersion = baseline.expectVersion

  if (!donor) {
    console.log(`image  ${first}`)
    if (sameFile) console.log('stock  this IS the stock image; there is nothing to diff')
    else console.log(`stock  ${baseline.whence}`)
    console.log(from ? `dump   ${fromPath}, ${from.bytes.length} bytes` : 'dump   none given')
    if (expectVersion) console.log(`variant ${expectVersion}, read off the target's dump`)
    console.log()
  }

  const result = buildPlan({
    image,
    imageName: donor ? `${donor.name} (donor window)` : first,
    donor,
    stock,
    from,
    resume: flags.has('resume'),
    blankTail: flags.has('blank-tail'),
    config0: values.has('config0') ? num(values.get('config0')!) : null,
    ldrom: values.has('ldrom') ? num(values.get('ldrom')!) : null,
    speedKhz: values.has('speed') ? num(values.get('speed')!) : undefined,
    requireDump: cmd === 'script' || cmd === 'donor',
    requireConfig0: cmd === 'script' || cmd === 'donor',
    expectVersion,
    keep,
    reference: from && from.base === 0 ? from.bytes : undefined,
  })
  if (!result.ok || !result.plan) {
    if (result.verdict) console.log(ota.report(result.verdict))
    console.error()
    console.error('REFUSED:')
    for (const r of result.refusals) console.error(`  ${r}`)
    return 1
  }
  if (!donor && !stock && !sameFile) {
    console.error('REFUSED: no baseline to diff a patched image against.')
    console.error('Pass --from <dump of the target>, which is the right baseline, or')
    console.error(`--stock <path>, or put the APK container at ${DEFAULT_STOCK}.`)
    return 1
  }

  for (const l of planReport(result.plan, result.verdict!)) console.log(l)

  if (cmd === 'plan') {
    console.log()
    console.log('Nothing was written and no script was emitted. To emit one, add --yes.')
    return 0
  }

  if (!flags.has('yes')) {
    console.log()
    console.error(`REFUSED: \`${cmd}\` emits a file that erases and programs flash.`)
    console.error('Read the plan above, then re-run with --yes.')
    return 2
  }

  const source = donor ? donor.name : first
  const base = source.split('/').pop()!.replace(/\.[^.]*$/, '')
  const out = values.get('out') ?? `firmware/swdflash-${donor ? 'donor-' : ''}${base}.tcl`
  const existing = Bun.file(out)
  if ((await existing.exists()) && !(await existing.text()).startsWith(MARKER)) {
    console.error(`\nREFUSED: ${out} exists and was not generated by this tool.`)
    return 1
  }
  const text = tcl(result.plan)
  await Bun.write(out, text)
  console.log()
  console.log(`wrote ${out}, ${text.length} bytes. Read it before you run it.`)
  console.log()
  console.log('Then, with the unit on its own battery and the probe attached:')
  console.log()
  console.log('  openocd -f research/tools/pan1020.cfg \\')
  console.log(`    -c "set JOGGLES_FLASH_CONFIRM ${w32(result.plan.crc32)}" -f ${out}`)
  console.log()
  console.log('The procedure around that command, and what is still unproven about it,')
  console.log('is notes/swd-flashing.md. Read it first: nothing has ever erased or')
  console.log('programmed the application region on this part.')
  return 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
