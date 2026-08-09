#!/usr/bin/env bun
/**
 * Read an SWD flash dump and say whether it is trustworthy and what it shows.
 *
 *   bun research/tools/dumpcheck.ts <dump.bin> [flags]
 *   bun research/tools/dumpcheck.ts compare <a.bin> <b.bin> [c.bin ...]
 *
 *   --base <hex>      address the dump starts at (default 0)
 *   --against <file>  OTA container whose plaintext should appear at abs 0x16800.
 *                     Default firmware/TR1906R04-10_OTA.bin; pass our own image
 *                     after an SWD flash
 *   --config0 <hex>   the word read at 0x00300000, which no 0x0-0x40000 dump holds
 *   --ldrom <hex>     the word read at 0x00100000, likewise
 *
 * WHY THIS EXISTS. `notes/plan-after-the-brick.md` names it as the first thing to
 * write once a dump exists, because the strongest possible check on a dump is
 * already sitting in this repo. We hold the vendor's own OTA container, so
 * `ota.plaintext()` of it is a byte-exact prediction of what must appear at
 * `abs 0x16800`. If it does, the dump is good *and* the flash map is confirmed, in
 * one comparison. A vector-table sanity check proves far less: an all-zero read and
 * a stale bus both produce plausible-looking words.
 *
 * It never talks to a device. The OpenOCD sequence that produces its input is
 * `research/tools/swd-recon.sh`, deliberately a separate file with no write command
 * in it, per the read/write separation in `research/hardware-access.md`.
 *
 * Exit code answers one question only: **can this dump be trusted as a record of
 * the device?** 0 yes, 1 no, 2 usage. The diagnosis of *which* device state it
 * shows is in the report and is not an error either way; a bricked unit with an
 * intact application is a good dump of a broken device.
 */
import * as ota from '../../packages/core/src/ota.js'
import { readExtension } from './ext.js'

const STOCK = 'firmware/TR1906R04-10_OTA.bin'
const BLANK = 0xff

/** Flash map, from `packages/core/src/ota.ts` so the two cannot drift. */
export const REGIONS = [
  { name: 'BLE stack', start: ota.FLASH_SOFTDEVICE_ADDR, end: ota.FLASH_APP_ADDR },
  { name: 'application', start: ota.FLASH_APP_ADDR, end: ota.FLASH_DFU_ADDR },
  { name: 'OTA staging bank', start: ota.FLASH_DFU_ADDR, end: ota.FLASH_SAVED_CONTENT_ADDR },
  { name: 'saved content', start: ota.FLASH_SAVED_CONTENT_ADDR, end: ota.FLASH_ADDR_INFO },
  { name: 'info page', start: ota.FLASH_ADDR_INFO, end: ota.FLASH_ADDR_INFO_BACKUP },
  { name: 'info backup', start: ota.FLASH_ADDR_INFO_BACKUP, end: ota.FLASH_BOOTLOADER_ADDR },
  { name: 'bootloader', start: ota.FLASH_BOOTLOADER_ADDR, end: ota.FLASH_ADDR_END },
] as const

/** Config and LDROM apertures. Separate address spaces, so a dump of the main
 *  array never contains them and they arrive as `mdw` words instead. */
export const CONFIG0_ADDR = 0x00300000
export const LDROM_ADDR = 0x00100000

/** SRAM bounds used only to judge whether a vector table looks like one.
 *  *derived*: the observed SP is 0x20003910 and app RAM ends near 0x20003804. */
const SRAM_START = 0x20000000
const SRAM_END = 0x20004000

export const hx = (n: number, w = 0) =>
  '0x' + (n >>> 0).toString(16).padStart(w, '0')

// --- The dump as an addressable window ------------------------------------------

export interface Dump {
  bytes: Uint8Array
  base: number
  end: number
}

export const dump = (bytes: Uint8Array, base = 0): Dump => ({
  bytes,
  base,
  end: base + bytes.length,
})

export const covers = (d: Dump, start: number, end: number) =>
  start >= d.base && end <= d.end

/** Bytes for an absolute span, or null if the dump does not reach that far. */
export function at(d: Dump, start: number, end: number): Uint8Array | null {
  if (!covers(d, start, end)) return null
  return d.bytes.subarray(start - d.base, end - d.base)
}

// --- Page census ----------------------------------------------------------------

export type Fill = 'blank' | 'zero' | 'data'

export function fillOf(b: Uint8Array): Fill {
  let blank = true
  let zero = true
  for (const x of b) {
    if (x !== BLANK) blank = false
    if (x !== 0) zero = false
    if (!blank && !zero) return 'data'
  }
  return blank ? 'blank' : 'zero'
}

export interface Census {
  covered: boolean
  pages: number
  blank: number
  zero: number
  data: number
  /** First and last address holding anything other than erased flash. */
  firstUsed: number | null
  lastUsed: number | null
}

export function census(d: Dump, start: number, end: number): Census {
  const lo = Math.max(start, d.base)
  const hi = Math.min(end, d.end)
  const empty: Census = {
    covered: false,
    pages: 0,
    blank: 0,
    zero: 0,
    data: 0,
    firstUsed: null,
    lastUsed: null,
  }
  if (hi <= lo) return empty

  const c: Census = { ...empty, covered: lo === start && hi === end }
  for (let a = lo; a < hi; a += ota.FLASH_PAGE_SIZE) {
    const page = at(d, a, Math.min(a + ota.FLASH_PAGE_SIZE, hi))!
    c.pages++
    c[fillOf(page)]++
  }
  const body = at(d, lo, hi)!
  for (let i = 0; i < body.length; i++) {
    if (body[i] === BLANK) continue
    if (c.firstUsed === null) c.firstUsed = lo + i
    c.lastUsed = lo + i
  }
  return c
}

// --- The load-bearing check: does the reference image appear at 0x16800? --------

export interface DiffRun {
  abs: number
  body: number
  length: number
  /** Name of the PROTECTED_REGIONS entry this run falls in, if any. */
  protectedRegion: string | null
}

export interface ImageDiff {
  /** False when the dump does not reach far enough to judge. */
  covered: boolean
  length: number
  matched: boolean
  differing: number
  runs: DiffRun[]
  /** The dumped region is entirely erased flash, so nothing was compared. */
  erased: boolean
}

/**
 * Our own `JGX1` extension header, if this unit is carrying one.
 *
 * Worth reading separately from the image diff because the diff cannot see it: the
 * extension is *appended* past the end of the stock body, so a comparison bounded
 * by the stock length runs out before reaching it. A v1 unit checked against stock
 * shows only the 48 bytes of hook, key and name.
 */
export function extensionIn(d: Dump) {
  const body = at(d, ota.FLASH_APP_ADDR, ota.FLASH_DFU_ADDR)
  return body ? readExtension(body) : null
}

export function protectedAt(body: number): string | null {
  for (const r of ota.PROTECTED_REGIONS) {
    if (body >= r.start && body < r.end) return r.name
  }
  return null
}

/** Reference plaintext for a container, trimmed to the length the header claims. */
export function referenceImage(container: Uint8Array): {
  plain: Uint8Array
  header: ota.Header
} {
  const header = ota.parseHeader(container)
  const plain = ota.plaintext(container)
  return { plain: plain.subarray(0, Math.min(plain.length, header.codeSize)), header }
}

/**
 * Compare a span of the dump against a plaintext image.
 *
 * `bodyBase` is the body offset the span corresponds to, so diff runs can be
 * reported in the same `body 0x...` coordinates as PROTECTED_REGIONS. For the
 * application region that is 0; for the staging bank the comparison is positional
 * and the protected-region names do not apply, so pass null.
 */
export function compareImage(
  d: Dump,
  addr: number,
  plain: Uint8Array,
  bodyBase: number | null = 0,
): ImageDiff {
  const got = at(d, addr, addr + plain.length)
  if (!got) {
    const n = plain.length
    return { covered: false, length: n, matched: false, differing: 0, runs: [], erased: false }
  }
  const runs: DiffRun[] = []
  let differing = 0
  let run: DiffRun | null = null
  for (let i = 0; i < plain.length; i++) {
    if (got[i] === plain[i]) {
      run = null
      continue
    }
    differing++
    if (run && run.abs + run.length === addr + i) {
      run.length++
      continue
    }
    run = {
      abs: addr + i,
      body: bodyBase === null ? -1 : bodyBase + i,
      length: 1,
      protectedRegion: bodyBase === null ? null : protectedAt(bodyBase + i),
    }
    runs.push(run)
  }
  return {
    covered: true,
    length: plain.length,
    matched: differing === 0,
    differing,
    runs,
    erased: fillOf(got) === 'blank',
  }
}

// --- Vector tables --------------------------------------------------------------

export interface Vectors {
  sp: number
  reset: number
  spInSram: boolean
  resetIsThumb: boolean
  plausible: boolean
}

/**
 * Read the first two words at an address as if they were a vector table.
 *
 * Only `0x0` is one. `abs 0x16800` is *not*: the application image begins with a
 * head whose first two words in stock are `0x00026904` and `0x03010100`, so
 * judging it as a vector table reports a failure that is not one. The landmarks
 * below print their words either way and only 0x0 carries a verdict.
 */
export function vectors(d: Dump, addr: number): Vectors | null {
  const b = at(d, addr, addr + 8)
  if (!b) return null
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const sp = dv.getUint32(0, true)
  const reset = dv.getUint32(4, true)
  const spInSram = sp > SRAM_START && sp <= SRAM_END
  const resetIsThumb = (reset & 1) === 1 && reset < ota.FLASH_ADDR_END
  return { sp, reset, spInSram, resetIsThumb, plausible: spInSram && resetIsThumb }
}

/** The addresses worth reading two words of, and what they are. */
export const LANDMARKS = [
  {
    addr: ota.FLASH_SOFTDEVICE_ADDR,
    what: 'reset vector, where CBS = 11 starts the CPU',
    judge: true,
  },
  {
    addr: ota.FLASH_APP_ADDR,
    what: 'application image head, not a vector table',
    judge: false,
  },
  { addr: ota.FLASH_DFU_ADDR, what: 'staging bank', judge: false },
  { addr: ota.FLASH_BOOTLOADER_ADDR, what: "the SDK's bootloader region", judge: false },
] as const

// --- CONFIG0 --------------------------------------------------------------------

export interface Config0 {
  raw: number
  erased: boolean
  /** Bits 7:6, the chip boot select. */
  cbs: number
  boot: string
  /** Bit 1 low is the locked state on this Nuvoton-derived FMC. */
  locked: boolean
  /** True for the exact value the failed OTA commit wrote. */
  brickSignature: boolean
}

/**
 * Decode CONFIG0.
 *
 * Only `CBS = 11` (boot APROM, the erased default) and `CBS = 00` (boot LDROM,
 * what the OTA commit wrote) are established for this part, in
 * `research/brick-2026-08-08.md`. The middle two are Nuvoton's documented mapping
 * and are reported as unconfirmed rather than asserted, because nothing on this
 * family has ever been seen holding them.
 */
export function decodeConfig0(raw: number): Config0 {
  const v = raw >>> 0
  const cbs = (v >>> 6) & 3
  const boot =
    cbs === 3
      ? 'APROM, the erased default'
      : cbs === 0
        ? 'LDROM'
        : `unconfirmed on this part (Nuvoton maps ${cbs === 2 ? '10' : '01'} to ` +
          `${cbs === 2 ? 'APROM with IAP' : 'LDROM without IAP'})`
  return {
    raw: v,
    erased: v === 0xffffffff,
    cbs,
    boot,
    locked: (v & 2) === 0,
    brickSignature: v === 0xffffff3f,
  }
}

// --- Report ---------------------------------------------------------------------

export interface Options {
  base: number
  against: Uint8Array | null
  againstName: string
  config0: number | null
  ldrom: number | null
}

export interface Result {
  /** Can this dump be trusted as a record of the device? */
  trustworthy: boolean
  lines: string[]
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

/** Share of the image, omitted when it rounds to nothing and would read as 0%. */
const share = (n: number, of: number) => {
  const p = Math.round((100 * n) / of)
  return p < 1 ? '' : ` (${p}% of the image)`
}

export function analyse(bytes: Uint8Array, opts: Options): Result {
  const d = dump(bytes, opts.base)
  const out: string[] = []
  const say = (s = '') => out.push(s)

  say(`covers ${hx(d.base, 8)} - ${hx(d.end - 1, 8)}  (${d.bytes.length} bytes)`)

  // A read-locked part answers every transaction and returns erased flash, so this
  // is checked before anything else: research/hardware-access.md, "If the port is
  // locked". Every other finding below would be an artefact of it.
  if (fillOf(d.bytes) === 'blank') {
    say()
    say('EVERY BYTE READS 0xFF.')
    say('  On this family that is what a read-locked part looks like: SWD connects,')
    say('  DPIDR is correct, and the array reads erased. It is also what a dump of a')
    say('  chip-erased unit looks like. Either way this dump records nothing.')
    return { trustworthy: false, lines: out }
  }

  let trustworthy = false
  const ext = extensionIn(d)
  // Reported on both paths: which firmware a unit carries is worth knowing even when
  // there is no reference to validate the dump against.
  const sayExtension = () => {
    if (!ext) return
    say(`  carries a ${ext.magic} extension: v${ext.version}, ` +
      `capabilities ${hx(ext.capabilities, 4)}, ${ext.size} bytes, entry ${hx(ext.entry)}`)
    say(`  sub-commands: ${ext.subcommands.map((s) => hx(s)).join(', ') || 'none'}`)
  }
  say()
  say('application region')
  if (!opts.against) {
    say('  no reference image given, so the dump cannot be validated')
    sayExtension()
  } else {
    const { plain, header } = referenceImage(opts.against)
    const diff = compareImage(d, ota.FLASH_APP_ADDR, plain, 0)
    say(`  reference  ${opts.againstName}`)
    say(`             ${plain.length} bytes, appVer ${header.appVer}, devVer ${header.devVer}`)
    if (!diff.covered) {
      say(`  the dump does not cover ${hx(ota.FLASH_APP_ADDR)} - ` +
        `${hx(ota.FLASH_APP_ADDR + plain.length)}, so nothing is validated`)
    } else if (diff.matched) {
      trustworthy = true
      say(`  MATCHES byte for byte at ${hx(ota.FLASH_APP_ADDR)}`)
      say('  -> the dump is good and the flash map is confirmed by the same comparison')
    } else if (diff.erased) {
      say(`  the application region is erased flash`)
      say('  -> either the bootloader ran and half-wrote APROM, or this unit never')
      say('     held this image. A full reflash is needed, not a config repair')
    } else {
      say(`  DIFFERS: ${plural(diff.differing, 'byte')} in ` +
        `${plural(diff.runs.length, 'run')}${share(diff.differing, plain.length)}`)
      const shown = diff.runs.slice(0, 12)
      for (const r of shown) {
        const tag = r.protectedRegion ? `  ** ${r.protectedRegion} **` : ''
        say(`    abs ${hx(r.abs, 5)}  body ${hx(r.body, 4)}  ${r.length} B${tag}`)
      }
      if (diff.runs.length > shown.length) {
        say(`    ... and ${diff.runs.length - shown.length} more runs`)
      }
      const hit = diff.runs.filter((r) => r.protectedRegion).length
      if (hit > 0) say(`  ${plural(hit, 'run')} inside PROTECTED_REGIONS`)
    }

    // The appended extension lives past the end of the stock body, so a comparison
    // bounded by the reference length never reaches it. Report the tail separately
    // or a unit carrying our firmware looks like stock plus 48 stray bytes.
    if (diff.covered) {
      const beyond = census(d, ota.FLASH_APP_ADDR + plain.length, ota.FLASH_DFU_ADDR)
      if (beyond.firstUsed !== null) {
        say(`  beyond the reference: ${beyond.lastUsed! - beyond.firstUsed! + 1} bytes at ` +
          `${hx(beyond.firstUsed)}-${hx(beyond.lastUsed!)}, which the diff above cannot see`)
      }
    }
    sayExtension()
    if (diff.covered && !diff.matched && !diff.erased) {
      if (ext) {
        say('  -> this unit is carrying our own firmware, so re-run with')
        say('     --against firmware/joggles-v1.bin to validate the dump properly')
      } else {
        say('  -> a dump that differs is either a bad read or a device carrying a')
        say('     different image. Re-dump from cold and compare before concluding;')
        say('     `dumpcheck compare` is what settles which')
      }
    }
  }

  say()
  say('regions')
  const row = (name: string, span: string, pages: string, blank: string, used: string,
    first: string) =>
    `  ${name.padEnd(19)} ${span.padEnd(17)} ${pages.padStart(6)} ${blank.padStart(6)} ` +
    `${used.padStart(6)}  ${first}`
  say(row('name', 'span', 'pages', 'blank', 'used', 'first used'))
  for (const r of REGIONS) {
    const c = census(d, r.start, r.end)
    if (c.pages === 0) continue
    const first = c.firstUsed === null ? '-' : hx(c.firstUsed, 5)
    say(row(
      r.name,
      `${hx(r.start, 5)}-${hx(r.end, 5)}`,
      String(c.pages),
      String(c.blank),
      String(c.data + c.zero),
      first + (c.covered ? '' : ' (partial)'),
    ))
  }

  say()
  say('landmarks, first two words')
  for (const l of LANDMARKS) {
    const v = vectors(d, l.addr)
    if (!v) continue
    const erased = v.sp === 0xffffffff && v.reset === 0xffffffff
    let note = erased ? `${l.what}, erased` : l.what
    if (l.judge && !erased) {
      note = v.plausible
        ? `${l.what}: plausible`
        : `${l.what}: NOT plausible ` +
          `(${!v.spInSram ? 'SP outside SRAM' : 'reset vector is not Thumb'})`
    }
    say(`  ${hx(l.addr, 5)}  ${hx(v.sp, 8)} ${hx(v.reset, 8)}  ${note}`)
  }

  say()
  say('staging bank')
  const stagingCensus = census(d, ota.FLASH_DFU_ADDR, ota.FLASH_SAVED_CONTENT_ADDR)
  if (!stagingCensus.covered && stagingCensus.pages === 0) {
    say('  not covered by this dump')
  } else if (stagingCensus.firstUsed === null) {
    say('  erased, so nothing is staged')
  } else if (opts.against) {
    const { plain } = referenceImage(opts.against)
    const staged = compareImage(d, ota.FLASH_DFU_ADDR, plain, null)
    // The device descrambles each page in RAM before programming it, so a staged
    // image sits here as plaintext, comparable directly against the reference.
    if (!staged.covered) {
      // Without this the comparison reports 0 differing bytes and the branch below
      // reads that as "not the reference image", which is a conclusion about the
      // device drawn from a shortfall in the dump.
      say(`  holds something: ${hx(stagingCensus.firstUsed)} to ` +
        `${hx(stagingCensus.lastUsed!)}, but the dump ends at ${hx(d.end - 1)},`)
      say(`  short of the ${plain.length} bytes a staged image occupies, so whether`)
      say('  it is the reference cannot be told from this dump')
    } else if (staged.matched) {
      say(`  holds a plaintext copy of ${opts.againstName}, ${plain.length} bytes`)
    } else {
      say(`  holds something: ${hx(stagingCensus.firstUsed)} to ` +
        `${hx(stagingCensus.lastUsed!)}, not the reference image`)
      say(`  (${staged.differing} bytes differ from it)`)
    }
  } else {
    say(`  holds something: ${hx(stagingCensus.firstUsed)} to ${hx(stagingCensus.lastUsed!)}`)
  }

  if (opts.config0 !== null || opts.ldrom !== null) {
    say()
    say('separate apertures')
  }
  if (opts.config0 !== null) {
    const c = decodeConfig0(opts.config0)
    say(`  CONFIG0 at ${hx(CONFIG0_ADDR)} = ${hx(c.raw, 8)}`)
    say(`    CBS = ${c.cbs.toString(2).padStart(2, '0')} -> boot ${c.boot}`)
    say(`    ${c.locked ? 'LOCKED: bit 1 is clear' : 'not read-locked'}`)
    if (c.brickSignature) {
      say('    ** the brick signature. This is exactly what the OTA commit wrote on')
      say('       2026-08-08, and the repair is one page erase at 0x00300000.')
      say('       research/brick-2026-08-08.md **')
    } else if (c.erased) {
      say('    erased, i.e. the factory default. If this unit is dead, the config')
      say('    write never happened and the postmortem is wrong')
    }
  }
  if (opts.ldrom !== null) {
    const blank = opts.ldrom >>> 0 === 0xffffffff
    say(`  LDROM at ${hx(LDROM_ADDR)} = ${hx(opts.ldrom, 8)}`)
    say(
      blank
        ? '    blank, so CBS = 00 sends the CPU into erased flash'
        : '    not blank, so an LDROM image exists and the postmortem needs revisiting',
    )
  }

  return { trustworthy, lines: out }
}

// --- Comparing repeat dumps -----------------------------------------------------

export interface Divergence {
  abs: number
  length: number
  region: string
}

/**
 * Compare dumps of the same unit taken from cold.
 *
 * Intermittent SWD reads look exactly like a device that changed underneath you,
 * which is why the plan takes three dumps rather than one. Divergence here means
 * the rig is unreliable and no conclusion drawn from any single dump is safe.
 */
export function compareDumps(dumps: Dump[]): Divergence[] {
  const [first, ...rest] = dumps
  const out: Divergence[] = []
  let run: Divergence | null = null
  for (let i = 0; i < first.bytes.length; i++) {
    const same = rest.every((o) => o.bytes[i] === first.bytes[i])
    if (same) {
      run = null
      continue
    }
    const abs = first.base + i
    if (run && run.abs + run.length === abs) {
      run.length++
      continue
    }
    run = { abs, length: 1, region: regionOf(abs) }
    out.push(run)
  }
  return out
}

export const regionOf = (abs: number) =>
  REGIONS.find((r) => abs >= r.start && abs < r.end)?.name ?? 'outside the flash map'

// --- CLI ------------------------------------------------------------------------

const num = (s: string) => (s.startsWith('0x') ? parseInt(s.slice(2), 16) : parseInt(s, 10))

async function read(path: string): Promise<Uint8Array> {
  const f = Bun.file(path)
  if (!(await f.exists())) {
    console.error(`no such file: ${path}`)
    process.exit(2)
  }
  return new Uint8Array(await f.arrayBuffer())
}

async function main(argv: string[]) {
  if (argv.length === 0) {
    console.error('usage: dumpcheck <dump.bin> [--base 0x0] [--against <ota.bin>]')
    console.error('                            [--config0 <hex>] [--ldrom <hex>]')
    console.error('       dumpcheck compare <a.bin> <b.bin> [c.bin ...]')
    process.exit(2)
  }

  if (argv[0] === 'compare') {
    const paths = argv.slice(1)
    if (paths.length < 2) {
      console.error('compare needs at least two dumps')
      process.exit(2)
    }
    const files = await Promise.all(paths.map(read))
    const sizes = new Set(files.map((f) => f.length))
    if (sizes.size > 1) {
      const each = paths.map((p, i) => `${p} ${files[i].length}`).join(', ')
      console.error(`dumps differ in length: ${each}`)
      process.exit(1)
    }
    const diffs = compareDumps(files.map((f) => dump(f)))
    if (diffs.length === 0) {
      console.log(`${paths.length} dumps of ${files[0].length} bytes are byte-identical`)
      console.log('-> the rig is reading the device reliably')
      process.exit(0)
    }
    const total = diffs.reduce((n, r) => n + r.length, 0)
    console.log(`DIVERGE: ${plural(total, 'byte')} in ${plural(diffs.length, 'run')}`)
    for (const r of diffs.slice(0, 20)) {
      console.log(`  ${hx(r.abs, 5)}  ${r.length} B  ${r.region}`)
    }
    if (diffs.length > 20) console.log(`  ... and ${diffs.length - 20} more runs`)
    console.log('-> repeat reads of one unit must agree. Slow the adapter, shorten the')
    console.log('   leads, check the ground return, and dump again before trusting any')
    process.exit(1)
  }

  const path = argv[0]
  let base = 0
  let againstName = STOCK
  let againstGiven = false
  let config0: number | null = null
  let ldrom: number | null = null
  for (let i = 1; i < argv.length; i += 2) {
    const v = argv[i + 1]
    if (v === undefined) {
      console.error(`${argv[i]} needs a value`)
      process.exit(2)
    }
    if (argv[i] === '--base') base = num(v)
    else if (argv[i] === '--against') {
      againstName = v
      againstGiven = true
    }
    else if (argv[i] === '--config0') config0 = num(v)
    else if (argv[i] === '--ldrom') ldrom = num(v)
    else {
      console.error(`unknown flag ${argv[i]}`)
      process.exit(2)
    }
  }

  const bytes = await read(path)
  const hasReference = await Bun.file(againstName).exists()
  // A missing default is a warning, because firmware/ is gitignored. A reference the
  // caller named and got wrong is not: it would degrade to "cannot be validated",
  // which is the same output as asking for no validation at all.
  if (!hasReference && againstGiven) {
    console.error(`no reference image at ${againstName}`)
    process.exit(2)
  }
  const against = hasReference ? await read(againstName) : null
  if (!against) console.error(`warning: no reference image at ${againstName}\n`)

  console.log(`dump  ${path}`)
  const r = analyse(bytes, { base, against, againstName, config0, ldrom })
  for (const l of r.lines) console.log(l)
  console.log()
  console.log(r.trustworthy ? 'VERDICT: dump validated' : 'VERDICT: dump NOT validated')
  process.exit(r.trustworthy ? 0 : 1)
}

if (import.meta.main) await main(process.argv.slice(2))
