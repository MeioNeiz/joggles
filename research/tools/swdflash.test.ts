/**
 * What `swdflash` must get right before a probe is ever clipped on.
 *
 * Two kinds of test here, and the second kind is the point.
 *
 * The first kind reads the generated script as text and asserts the structural
 * properties the safety argument rests on: one window, one update-enable bit, two
 * ISPCMD values, one call site for `program_word`. Those are cheap and they are
 * tripwires, so that a future edit that quietly adds a third ISPCMD value or a
 * second `program_word` call site fails the build rather than a device.
 *
 * The second kind **runs the script**, against `swdflash-sim.tcl`, a TCL model of the
 * FMC and the flash array. That catches what reading text cannot: whether the unlock
 * sequence is right, whether the poll protocol terminates, whether the erase actually
 * precedes the program, and whether the bytes that end up in the simulated array are
 * the image. It also lets the two mutation tests exist: take a correct script, break
 * it in the exact way that would destroy a unit, and prove the script catches itself.
 * They are skipped where `tclsh` is absent, which on macOS it is not.
 *
 * No test here talks to a device, spawns openocd, or reads anything under `.claude/`.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ota from '../../packages/core/src/ota.js'
import { dump } from './dumpcheck.js'
import {
  blockBase,
  buildPlan,
  CANARIES,
  chooseBaseline,
  CANDIDATE_BLOCKS,
  chooseProbe,
  parseKeep,
  readDonor,
  UNIT_SPECIFIC,
  variantOf,
  CMD_CHIP_ERASE,
  CMD_PAGE_ERASE,
  CMD_PROGRAM,
  DHCSR,
  DHCSR_S_HALT,
  DHCSR_S_RESET_ST,
  FMC,
  ISPCMD_VALUES,
  ISPCON,
  ISPCON_APROM,
  ISPCON_KEEP,
  ISPCON_MUST_BE_CLEAR,
  ISPCON_OFF,
  MARKER,
  PAGE,
  pageMatches,
  planReport,
  sightedCanary,
  tcl,
  transactions,
  willBlank,
  willKeep,
  willWrite,
  WINDOW,
  words,
} from './swdflash.js'

const STOCK = 'firmware/TR1906R04-10_OTA.bin'
const V1 = 'firmware/joggles-v1.bin'
const UNIT1 = 'firmware/dump-unit1-2026-08-19-a.bin'
const TCLSH = Bun.which('tclsh')

// --- fixtures --------------------------------------------------------------------

/** An image that passes `ota.check`, so the plan tests exercise the plan and not it. */
function synthImage(bodyLength = 1300): Uint8Array {
  const plain = new Uint8Array(bodyLength)
  for (let i = 0; i < bodyLength; i++) plain[i] = (i * 7 + 13) & 0xff
  const dv = new DataView(plain.buffer)
  dv.setUint32(0x08, 0x20003910, true) //   initial SP, in SRAM
  dv.setUint32(0x0c, 0x00016a01, true) //   entry, Thumb, inside the application
  return ota.encode(plain, { appVer: 1, devVer: 10, proVer: 10, type: ota.OTA_APP })
}

/** A 256 KB dump with recognisable words everywhere a canary looks. */
function synthDump(app?: Uint8Array): Uint8Array {
  const b = new Uint8Array(ota.FLASH_ADDR_END).fill(0xff)
  const dv = new DataView(b.buffer)
  dv.setUint32(0x00000000, 0x20002648, true)
  dv.setUint32(0x00016000, 0x11112222, true)
  dv.setUint32(ota.FLASH_DFU_ADDR, 0x33334444, true)
  dv.setUint32(ota.FLASH_SAVED_CONTENT_ADDR, 0x55556666, true)
  dv.setUint32(ota.FLASH_ADDR_INFO, 0x0000dbc3, true)
  dv.setUint32(ota.FLASH_BOOTLOADER_ADDR, 0x20000610, true)
  dv.setUint32(0x0003fc00, 0x77778888, true)
  if (app) {
    // Exactly what a unit holding this image looks like: the image, then erased
    // flash. A pattern left under the tail would make every skip test a lie.
    b.set(app, ota.FLASH_APP_ADDR)
  } else {
    // Something in the destination, so the witnesses are not all erased flash.
    for (let i = 0; i < 4096; i++) b[ota.FLASH_APP_ADDR + i] = (i * 31 + 5) & 0xff
  }
  return b
}

type Opts = Partial<Parameters<typeof buildPlan>[0]>

const plan = (image: Uint8Array | undefined, opts: Opts = {}) =>
  buildPlan({ image, imageName: 'synthetic.bin', ...opts })

const okPlan = (image: Uint8Array | undefined, opts: Opts = {}) => {
  const r = plan(image, opts)
  expect(r.refusals).toEqual([])
  expect(r.plan).not.toBeNull()
  return r.plan!
}

// --- the constants the whole safety argument rests on ------------------------------

describe('the closed sets', () => {
  test('ISPCMD can only ever be program or page erase', () => {
    expect([...ISPCMD_VALUES].sort()).toEqual([CMD_PROGRAM, CMD_PAGE_ERASE].sort())
    expect(ISPCMD_VALUES).not.toContain(CMD_CHIP_ERASE)
    expect(ISPCMD_VALUES.length).toBe(2)
    // 0x23, not 0x26. Nine files in this repo guarded the wrong number until
    // 2026-08-20: research/fmc-erase-program.md, "The chip-erase opcode is 0x23".
    expect(CMD_CHIP_ERASE).toBe(0x23)
  })

  test('the one ISPCON value leaves CFGUEN and LDUEN clear', () => {
    expect(ISPCON_APROM & ISPCON.APUEN).toBe(ISPCON.APUEN)
    expect(ISPCON_APROM & ISPCON.ISPEN).toBe(ISPCON.ISPEN)
    expect(ISPCON_APROM & ISPCON.CFGUEN).toBe(0)
    expect(ISPCON_APROM & ISPCON.LDUEN).toBe(0)
  })

  test('the window is the application region and nothing else', () => {
    expect(WINDOW.start).toBe(ota.FLASH_APP_ADDR)
    expect(WINDOW.end).toBe(ota.FLASH_DFU_ADDR)
    expect(WINDOW.start % PAGE).toBe(0)
    expect(WINDOW.end % PAGE).toBe(0)
  })

  test('every canary sits outside the window', () => {
    for (const c of CANARIES) {
      expect(c.addr < WINDOW.start || c.addr >= WINDOW.end).toBe(true)
    }
  })

  test('the source file names no chip erase anywhere near an ISP command', () => {
    // A tripwire, not a proof: it exists so that adding chip erase means deleting
    // this test on purpose rather than adding a constant by accident.
    const src = readFileSync('research/tools/swdflash.ts', 'utf8')
      .split('\n')
      // Prose is allowed to name it; the point of the file is to explain why it is
      // absent. Code and emitted script lines are not.
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l) && !/say\('#/.test(l))
    const suspicious = src.filter(
      (l) =>
        /ISPCMD|CMD_PROGRAM|CMD_PAGE_ERASE|chip.?erase/i.test(l) &&
        /\b0x(23|26)\b/.test(l) &&
        !/export const CMD_CHIP_ERASE/.test(l),
    )
    expect(suspicious).toEqual([])
  })

  test('the simulator aborts on the real chip-erase opcode, not the imagined one', () => {
    const sim = readFileSync('research/tools/swdflash-sim.tcl', 'utf8')
    expect(sim).toContain(`if {$cmd == ${hexAddr(CMD_CHIP_ERASE)}} {`)
    expect(sim).not.toContain('cmd == 0x26')
  })
})

// --- the plan ----------------------------------------------------------------------

describe('the page plan', () => {
  test('covers the image exactly, with a partial last page', () => {
    const p = okPlan(synthImage(1300))
    expect(p.pages.length).toBe(Math.ceil(1300 / PAGE))
    expect(p.pages[0].addr).toBe(WINDOW.start)
    expect(p.pages[0].data!.length).toBe(PAGE)
    expect(p.pages.at(-1)!.data!.length).toBe(1300 % PAGE)
    expect(p.imageEnd).toBe(WINDOW.start + 1300)
  })

  test('every page is page-aligned and inside the window', () => {
    const p = okPlan(synthImage(60000), { blankTail: true })
    for (const page of p.pages) {
      expect(page.addr % PAGE).toBe(0)
      expect(page.addr).toBeGreaterThanOrEqual(WINDOW.start)
      expect(page.addr + PAGE).toBeLessThanOrEqual(WINDOW.end)
    }
  })

  test('--blank-tail reaches the staging bank and stops there', () => {
    const p = okPlan(synthImage(1300), { blankTail: true })
    expect(p.pages.length).toBe((WINDOW.end - WINDOW.start) / PAGE)
    expect(p.pages.at(-1)!.addr).toBe(WINDOW.end - PAGE)
    expect(willBlank(p).length).toBe(p.pages.length - Math.ceil(1300 / PAGE))
    for (const b of willBlank(p)) expect(b.data).toBeNull()
  })

  test('an image too big for the application region is refused', () => {
    const big = synthImage(ota.FLASH_APP_SIZE + 4)
    const r = plan(big)
    expect(r.ok).toBe(false)
    expect(r.plan).toBeNull()
  })

  test('the window bound is a backstop, because ota.check already holds it', () => {
    // The two limits are the same number for different reasons: ota.check bounds a
    // staged image by where the saved content starts, and this tool bounds a written
    // image by where the staging bank starts. They coincide at 76,800, so ota.check
    // refuses first and the window check below it has never fired. Keep both: if
    // either region ever moves, only one of them moves with it.
    expect(ota.SAFE_MAX_CODE_SIZE).toBe(WINDOW.end - WINDOW.start)
    expect(ota.FLASH_APP_SIZE).toBe(WINDOW.end - WINDOW.start)
  })

  test('a fatal ota.check finding is fatal here', () => {
    const bad = synthImage(1300)
    bad[14] = ota.OTA_SOFTDEVICE //   type 2 aims the bootloader at the BLE stack
    const r = plan(bad)
    expect(r.ok).toBe(false)
    expect(r.plan).toBeNull()
    expect(r.refusals.join(' ')).toContain('softdevice-image')
  })

  test('a corrupt CRC is refused before a page is computed', () => {
    const bad = synthImage(1300)
    bad[4] ^= 0xff
    const r = plan(bad)
    expect(r.ok).toBe(false)
    expect(r.refusals.join(' ')).toContain('crc-mismatch')
  })

  test('`script` refuses without a dump, `plan` does not', () => {
    const image = synthImage(1300)
    expect(plan(image, { requireDump: true }).ok).toBe(false)
    expect(plan(image, { requireDump: true }).refusals.join(' ')).toContain('--from')
    expect(plan(image, { requireDump: false }).ok).toBe(true)
  })

  test('a dump that does not reach the destination is refused', () => {
    const image = synthImage(1300)
    const short = dump(new Uint8Array(0x1000).fill(0xff), 0)
    const r = plan(image, { from: short, requireDump: true })
    expect(r.ok).toBe(false)
    expect(r.refusals.join(' ')).toContain('does not reach')
  })
})

describe('resume', () => {
  const image = synthImage(1300)
  const { plain } = { plain: ota.plaintext(image).subarray(0, 1300) }

  test('needs a dump', () => {
    const r = plan(image, { resume: true })
    expect(r.ok).toBe(false)
    expect(r.refusals.join(' ')).toContain('--resume needs --from')
  })

  test('skips every page a matching dump already holds', () => {
    const d = dump(synthDump(plain), 0)
    const p = okPlan(image, { from: d, resume: true })
    expect(willKeep(p).length).toBe(p.pages.length)
    expect(willWrite(p).length).toBe(0)
  })

  test('one wrong byte un-skips exactly one page', () => {
    const bytes = synthDump(plain)
    bytes[WINDOW.start + PAGE + 17] ^= 0xff
    const p = okPlan(image, { from: dump(bytes, 0), resume: true })
    expect(willWrite(p).map((x) => x.addr)).toEqual([WINDOW.start + PAGE])
  })

  test('a stale tail in the last page defeats the skip', () => {
    // The last page is erased in full, so a page whose covered bytes match but
    // whose tail still holds an older image must be rewritten, not kept.
    const bytes = synthDump(plain)
    const last = WINDOW.start + Math.floor(1300 / PAGE) * PAGE
    bytes[last + (1300 % PAGE) + 4] = 0x00
    const p = okPlan(image, { from: dump(bytes, 0), resume: true })
    expect(willWrite(p).map((x) => x.addr)).toEqual([last])
  })

  test('pageMatches wants the tail erased as well as the data equal', () => {
    const d = dump(synthDump(plain), 0)
    const p = okPlan(image, { from: d })
    for (const page of p.pages) expect(pageMatches(d, page)).toBe(true)
  })
})

describe('preconditions and canaries', () => {
  const image = synthImage(4096)
  const d = dump(synthDump(), 0)

  test('canaries are read out of the dump, at the addresses that matter', () => {
    const p = okPlan(image, { from: d })
    const byAddr = new Map(p.canaries.map((c) => [c.addr, c.word]))
    expect(byAddr.get(0)).toBe(0x20002648)
    expect(byAddr.get(ota.FLASH_BOOTLOADER_ADDR)).toBe(0x20000610)
    expect(byAddr.get(ota.FLASH_ADDR_INFO)).toBe(0x0000dbc3)
    for (const c of p.canaries) {
      expect(c.addr < WINDOW.start || c.addr >= WINDOW.end).toBe(true)
    }
  })

  test('CONFIG0 is only watched when the caller supplies it, and says so otherwise', () => {
    const without = okPlan(image, { from: d })
    expect(without.canaries.some((c) => c.addr === 0x00300000)).toBe(false)
    expect(without.notes.join(' ')).toContain('--config0')
    const withIt = okPlan(image, { from: d, config0: 0xffffffbf })
    expect(withIt.canaries.find((c) => c.addr === 0x00300000)?.word).toBe(0xffffffbf)
  })

  test('witnesses come from the dump and lie in the destination', () => {
    const p = okPlan(image, { from: d })
    expect(p.witnesses.length).toBeGreaterThan(2)
    for (const w of p.witnesses) {
      expect(w.addr).toBeGreaterThanOrEqual(WINDOW.start)
      expect(w.addr).toBeLessThan(p.imageEnd)
      const off = w.addr - WINDOW.start
      const got = new DataView(d.bytes.buffer).getUint32(WINDOW.start + off, true)
      expect(w.word).toBe(got)
    }
  })

  test('no dump means no witnesses, and the report says so out loud', () => {
    const p = okPlan(image)
    expect(p.witnesses).toEqual([])
    expect(planReport(p, ota.check(image)).join('\n')).toContain('precondition: NONE')
  })

  test('the cost estimate scales with the words programmed', () => {
    const small = okPlan(synthImage(1300), { from: d })
    const large = okPlan(synthImage(40000), { from: d })
    expect(transactions(large)).toBeGreaterThan(transactions(small))
  })
})

// --- the generated script, read as text ---------------------------------------------

describe('the generated script', () => {
  const image = synthImage(4096)
  const d = dump(synthDump(), 0)
  const p = okPlan(image, { from: d, config0: 0xffffffbf, blankTail: true })
  const script = tcl(p)
  const lines = script.split('\n')
  const calls = (name: string) =>
    lines.filter((l) => new RegExp(`^\\s*${name}\\s`).test(l) && !l.startsWith('proc '))

  test('it is recognisable as ours, so a regenerate cannot clobber a stranger', () => {
    expect(script.startsWith(MARKER)).toBe(true)
  })

  test('ISPCMD is only ever written program or page erase', () => {
    const written = [...script.matchAll(new RegExp(`mww ${hexAddr(FMC.ISPCMD)} (\\S+)`, 'g'))]
      .map((m) => Number(m[1]))
    expect(written.length).toBeGreaterThan(0)
    expect([...new Set(written)].sort()).toEqual([CMD_PROGRAM, CMD_PAGE_ERASE].sort())
    expect(written).not.toContain(CMD_CHIP_ERASE)
  })

  test('ISPCON is read-modify-written, and the value can only clear the four bits', () => {
    // Bit 1 is BS, boot select, and it is writable, so the script preserves whatever
    // the boot ROM left there rather than storing a word over it:
    // research/fmc-erase-program.md, finding 3. The safety property survives that,
    // because the mask it keeps cannot contain an update-enable bit.
    const written = [...script.matchAll(new RegExp(`mww ${hexAddr(FMC.ISPCON)} (\\S+)`, 'g'))]
      .map((m) => m[1])
    // lock_down is defined near the top of the file, so its literal comes first
    expect([...new Set(written)].sort()).toEqual(['$jgx_new', w32(ISPCON_OFF)].sort())
    expect(script).toContain(
      `set jgx_new [expr {($jgx_was & ${w32(ISPCON_KEEP)}) | ${w32(ISPCON_APROM)}}]`,
    )
    expect(ISPCON_KEEP & ISPCON_MUST_BE_CLEAR).toBe(0)
    expect(ISPCON_APROM & ISPCON_MUST_BE_CLEAR).toBe(0)
    // and every bit the mask can produce, for every possible found value
    for (let was = 0; was < 256; was++) {
      expect(((was & ISPCON_KEEP) | ISPCON_APROM) & ISPCON_MUST_BE_CLEAR).toBe(0)
    }
  })

  test('the assertion covers SPUEN as well as CFGUEN and LDUEN', () => {
    // Four update-enable bits, not three. SPUEN gates the SPROM at 0x00200000, the
    // one region of this part that is potentially per-unit and has never been read.
    expect(ISPCON_MUST_BE_CLEAR).toBe(ISPCON.SPUEN | ISPCON.CFGUEN | ISPCON.LDUEN)
    expect(script).toContain(`($jgx_con & ${w32(ISPCON_MUST_BE_CLEAR)}) != 0`)
    expect(script).toContain('SPUEN, CFGUEN or LDUEN')
  })

  test('it prints ISPCON as found, because nobody has seen it on this part', () => {
    const read = script.indexOf(`set jgx_was [rd ${hexAddr(FMC.ISPCON)}]`)
    const write = script.indexOf(`mww ${hexAddr(FMC.ISPCON)} $jgx_new`)
    expect(read).toBeGreaterThan(-1)
    expect(read).toBeLessThan(write)
    expect(script).toContain('ISPCON as found:')
  })

  test('the only addresses written at all are the FMC and SYS_WRPROT', () => {
    const allowed = new Set(Object.values(FMC).map((a) => hexAddr(a)))
    const targets = [...script.matchAll(/^\s*mww (\S+)/gm)].map((m) => m[1])
    expect(targets.length).toBeGreaterThan(0)
    for (const t of targets) expect(allowed.has(t)).toBe(true)
  })

  test('program_word has exactly one call site and it is inside write_page', () => {
    const site = lines.findIndex((l) => /^\s*program_word\s/.test(l))
    expect(calls('program_word').length).toBe(1)
    const openedBy = lines
      .slice(0, site)
      .reduce((acc, l, i) => (l.startsWith('proc ') ? i : acc), -1)
    expect(lines[openedBy]).toContain('proc write_page')
  })

  test('write_page erases before it programs, in that order', () => {
    const body = script.slice(script.indexOf('proc write_page'))
    const proc = body.slice(0, body.indexOf('\nproc '))
    expect(proc.indexOf('erase_page')).toBeGreaterThan(-1)
    expect(proc.indexOf('erase_page')).toBeLessThan(proc.indexOf('program_word'))
    expect(proc.indexOf('program_word')).toBeLessThan(proc.indexOf('check_words'))
  })

  test('erase_page proves the page is blank before anything is programmed', () => {
    const body = script.slice(script.indexOf('proc erase_page'))
    const proc = body.slice(0, body.indexOf('\nproc '))
    expect(proc).toContain('check_erased')
    expect(proc.indexOf('wait_trg')).toBeLessThan(proc.indexOf('check_erased'))
  })

  test('the guard names exactly the window', () => {
    const body = script.slice(script.indexOf('proc guard'))
    const proc = body.slice(0, body.indexOf('\n}'))
    expect(proc).toContain(`$addr < ${hx(WINDOW.start)}`)
    expect(proc).toContain(`$addr >= ${hx(WINDOW.end)}`)
  })

  test('every page addressed is aligned and inside the window', () => {
    const call =
      /^(?:write_page|blank_page|keep_page|check_erased|erase_page|check_words) (0x[0-9a-f]+)/gm
    const targets = [...script.matchAll(call)]
    // the plan's pages, plus the probe's own erase and the pages it reads back
    const probeReads = p.probe ? 1 + 1 + (p.probe.above !== null ? 1 : 0) : 0
    expect(targets.length).toBe(p.pages.length + probeReads)
    for (const m of targets) {
      const a = Number(m[1])
      expect(a % PAGE).toBe(0)
      expect(a).toBeGreaterThanOrEqual(WINDOW.start)
      expect(a + PAGE).toBeLessThanOrEqual(WINDOW.end)
    }
  })

  test('the call counts are the plan, not a hope', () => {
    expect(calls('write_page').length).toBe(willWrite(p).length)
    expect(calls('blank_page').length).toBe(willBlank(p).length)
  })

  test('the confirmation token is the image CRC', () => {
    const token = '0x' + (p.crc32 >>> 0).toString(16).padStart(8, '0')
    expect(script).toContain(`JOGGLES_FLASH_CONFIRM ${token}`)
    expect(script).toContain('shutdown error')
  })

  test('every witness is checked, and every canary lives in the one sweep', () => {
    for (const w of p.witnesses) expect(script).toContain(`expect_word ${hx(w.addr, 8)}`)
    const sweep = script.slice(script.indexOf('proc canary_sweep'))
    const body = sweep.slice(0, sweep.indexOf('\n}'))
    for (const c of p.canaries) {
      expect(body).toContain(`expect_word ${hx(c.addr, 8)} ${w32(c.word)} {${c.what}}`)
    }
    expect(body.split('expect_word').length - 1).toBe(p.canaries.length)
  })

  test('the sweep runs three times: before, inside the first erase, and at the end', () => {
    const calls = [...script.matchAll(/^\s*canary_sweep /gm)].map((m) => m.index!)
    expect(calls.length).toBe(3)
    // The one inside erase_page is textually first, because the procs precede the
    // body. It is the new one and the only one that can stop an oversized block.
    const erase = script.indexOf('proc erase_page')
    const body = script.indexOf('\ninit\n')
    expect(calls[0]).toBeGreaterThan(erase)
    expect(calls[0]).toBeLessThan(body)
    expect(script.slice(erase, calls[0])).toContain('$::JGX_SWEPT')
    // the other two bracket the page loop
    expect(calls[1]).toBeGreaterThan(script.indexOf('=== 2.'))
    expect(calls[1]).toBeLessThan(script.indexOf('=== 3.'))
    expect(calls[2]).toBeGreaterThan(script.indexOf('=== 8.'))
  })

  test('the after-the-fact sweep does not tell the reader nothing was written', () => {
    const tail = script.slice(script.indexOf('=== 8.'))
    expect(tail).not.toContain('Nothing has been written')
    expect(tail).toContain('it is NOT true that nothing has been')
    // and the before-sweep still does say it, because there it is true
    expect(script.slice(0, script.indexOf('=== 3.')))
      .toContain('canary_sweep {Nothing has been written.}')
  })

  test('the preconditions are read before SYS_WRPROT is unlocked', () => {
    // The first unlock KEY, not the first write to WRPROT: `lock_down` writes 0 to it
    // and is defined near the top, and 0 is a re-lock rather than an unlock.
    const firstWitness = script.search(/^expect_word /m)
    const unlock = script.indexOf(`mww ${hexAddr(FMC.WRPROT)} 0x00000059`)
    expect(firstWitness).toBeGreaterThan(-1)
    expect(unlock).toBeGreaterThan(-1)
    expect(firstWitness).toBeLessThan(unlock)
  })

  test('the data in the script is the image, word for word', () => {
    const written =
      [...script.matchAll(/^write_page (0x[0-9a-f]+) \{\n([\s\S]*?)\n\} \d+$/gm)]
    expect(written.length).toBe(willWrite(p).length)
    for (const m of written) {
      const page = p.pages.find((x) => x.addr === Number(m[1]))!
      const got = m[2].trim().split(/\s+/).map(Number)
      expect(got).toEqual(words(page.data!))
    }
  })
})

const hx = (n: number, w = 0) => '0x' + (n >>> 0).toString(16).padStart(w, '0')
const w32 = (n: number) => hx(n, 8)
const hexAddr = (n: number) => hx(n)

// --- running the script against a simulated FMC ---------------------------------------

interface SimResult {
  code: number
  stdout: string
  stderr: string
  after: Uint8Array | null
}

function simulate(script: string, preload: Uint8Array, opts: {
  confirm?: string
  config0?: string
  wantOutput?: boolean
  /** Keep the script's own echo, which is where a `fail` message comes out. */
  verbose?: boolean
  /** What one ISPCMD 0x22 really erases. 512 is the tool's *derived* assumption. */
  eraseBlock?: number
  /** Polls ISPTRG stays busy after each trigger, so wait_trg's loop is real. */
  busy?: number
  /** The core resets after this many erases: S_HALT clears, S_RESET_ST sets. */
  resetAt?: number
} = {}): SimResult {
  const dir = mkdtempSync(join(tmpdir(), 'swdflash-'))
  const scriptPath = join(dir, 'flash.tcl')
  const preloadPath = join(dir, 'before.bin')
  const outPath = join(dir, 'after.bin')
  writeFileSync(scriptPath, script)
  writeFileSync(preloadPath, preload)
  const args = [
    'research/tools/swdflash-sim.tcl',
    scriptPath,
    '--preload',
    preloadPath,
  ]
  if (!opts.verbose) args.push('--quiet')
  if (opts.wantOutput !== false) args.push('--out', outPath)
  if (opts.config0) args.push('--config0', opts.config0)
  if (opts.eraseBlock) args.push('--erase-block', String(opts.eraseBlock))
  if (opts.busy !== undefined) args.push('--busy', String(opts.busy))
  if (opts.resetAt !== undefined) args.push('--reset-at', String(opts.resetAt))
  if (opts.confirm) args.push('--set', `JOGGLES_FLASH_CONFIRM=${opts.confirm}`)
  const r = Bun.spawnSync(['tclsh', ...args])
  return {
    code: r.exitCode ?? -1,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
    after: existsSync(outPath) ? new Uint8Array(readFileSync(outPath)) : null,
  }
}

describe.if(TCLSH !== null)('run against a simulated FMC', () => {
  const image = synthImage(4096)
  const plain = ota.plaintext(image).subarray(0, 4096)
  const before = synthDump()
  const p = okPlan(image, { from: dump(before, 0), config0: 0xffffffff })
  const token = w32(p.crc32)
  const script = tcl(p)

  test('a correct run lands the image and touches nothing else', () => {
    const r = simulate(script, before, { confirm: token })
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`${p.pages.length + (p.probe ? 1 : 0)} page erases`)
    expect(r.after).not.toBeNull()
    const after = r.after!
    expect([...after.subarray(WINDOW.start, WINDOW.start + plain.length)]).toEqual([...plain])

    // Everything outside the pages the plan named is byte-identical to before.
    const touchedTo = WINDOW.start + p.pages.length * PAGE
    for (let i = 0; i < before.length; i++) {
      if (i >= WINDOW.start && i < touchedTo) continue
      if (after[i] !== before[i]) throw new Error(`byte ${hx(i)} changed outside the plan`)
    }
    // The tail of the last page is erased, not left holding the old image.
    for (let i = WINDOW.start + plain.length; i < touchedTo; i++) expect(after[i]).toBe(0xff)
  })

  test('no confirmation token writes nothing', () => {
    const r = simulate(script, before)
    expect(r.stdout).toContain('0 page erases')
    expect(r.stdout).toContain('no flash was written')
  })

  test('the wrong confirmation token writes nothing', () => {
    const r = simulate(script, before, { confirm: '0xdeadbeef' })
    expect(r.code).not.toBe(0)
    expect(r.stdout).toContain('0 page erases')
  })

  test('a device that does not match the dump stops before the unlock', () => {
    const other = synthDump()
    other[WINDOW.start + 3] ^= 0xff
    const r = simulate(script, other, { confirm: token })
    expect(r.code).not.toBe(0)
    expect(r.stdout).toContain('0 page erases')
    expect(r.stdout).toContain('no flash was written')
  })

  test('a canary that moved stops the run, even though the write succeeded', () => {
    const moved = synthDump()
    new DataView(moved.buffer).setUint32(ota.FLASH_BOOTLOADER_ADDR, 0xdeadbeef, true)
    const r = simulate(script, moved, { confirm: token })
    expect(r.code).not.toBe(0)
  })

  test('MUTATION: an erase removed from write_page is caught by the read-back', () => {
    // The documented trap is that programming an unerased page silently stores
    // wrong data. This proves the script notices rather than trusting that it
    // would: strip the erase, and the run must fail with nothing verified.
    const broken = script.replace(
      /proc write_page \{addr data tail\} \{\n  erase_page \$addr\n/,
      'proc write_page {addr data tail} {\n',
    )
    expect(broken).not.toBe(script)
    const r = simulate(broken, before, { confirm: token, verbose: true })
    expect(r.code).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('FAILED')
  })

  test('MUTATION: a page aimed at the config page is refused by the guard', () => {
    const broken = script.replace(
      `write_page ${hx(WINDOW.start)} {`,
      'write_page 0x00300000 {',
    )
    expect(broken).not.toBe(script)
    const r = simulate(broken, before, { confirm: token, verbose: true })
    expect(r.code).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('outside the application window')
    // The granularity probe legitimately erases one page of the window before the
    // mutated call is reached; nothing else does, and the config page never moves.
    expect(r.stdout).toContain(`${p.probe ? 1 : 0} page erases`)
    expect(r.stdout).toContain('0 words programmed')
  })

  test('MUTATION: with the guard gone, CFGUEN clear still refuses the config page', () => {
    // Belt and braces are separate: this removes the software guard entirely and
    // relies only on the update-enable bit, which is what the hardware enforces.
    const noGuard = script
      .replace(/proc guard \{addr\} \{[\s\S]*?\n\}\n/, 'proc guard {addr} { }\n')
      .replace(`write_page ${hx(WINDOW.start)} {`, 'write_page 0x00300000 {')
    const r = simulate(noGuard, before, { confirm: token, verbose: true })
    expect(r.code).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('CFGUEN clear')
  })
})

describe.if(TCLSH !== null && existsSync(V1) && existsSync(STOCK) && existsSync(UNIT1))(
  'the real image on the real dump of unit 1',
  () => {
    const image = new Uint8Array(readFileSync(V1))
    const stock = new Uint8Array(readFileSync(STOCK))
    const before = new Uint8Array(readFileSync(UNIT1))
    const plain = ota.plaintext(image).subarray(0, ota.parseHeader(image).codeSize)

    test('joggles-v1 lands at 0x16800 and nothing outside the window moves', () => {
      const p = okPlan(image, {
        imageName: V1,
        stock,
        from: dump(before, 0),
        config0: 0xffffffbf,
      })
      expect(p.pages.length).toBe(Math.ceil(plain.length / PAGE))
      const r = simulate(tcl(p), before, { confirm: w32(p.crc32), config0: '0xffffffbf' })
      expect(r.stderr).toBe('')
      expect(r.code).toBe(0)
      const after = r.after!
      expect([...after.subarray(ota.FLASH_APP_ADDR, ota.FLASH_APP_ADDR + plain.length)])
        .toEqual([...plain])
      const touchedTo = WINDOW.start + p.pages.length * PAGE
      for (let i = 0; i < before.length; i++) {
        if (i >= WINDOW.start && i < touchedTo) continue
        if (after[i] !== before[i]) throw new Error(`byte ${hx(i)} changed outside the plan`)
      }
    })

    test('the leftover past the image survives unless --blank-tail is asked for', () => {
      const keep = okPlan(image, { imageName: V1, stock, from: dump(before, 0) })
      const wipe = okPlan(image, {
        imageName: V1,
        stock,
        from: dump(before, 0),
        blankTail: true,
      })
      const a = simulate(tcl(keep), before, { confirm: w32(keep.crc32) }).after!
      const b = simulate(tcl(wipe), before, { confirm: w32(wipe.crc32) }).after!
      // 0x26c00 is the first page past the image, and on unit 1 it holds the tail
      // of a longer factory image: research/tools/swdflash.ts and notes/swd-flashing.md.
      expect(a[0x26c00]).toBe(before[0x26c00])
      expect(b[0x26c00]).toBe(0xff)
      expect(b.subarray(WINDOW.end, WINDOW.end + 16)).toEqual(
        before.subarray(WINDOW.end, WINDOW.end + 16),
      )
    })
  },
)


// --- The erase granularity, which is *derived* and has never been measured ----------

/**
 * A dump whose whole application region holds something, which is what a real one
 * looks like. `synthDump()` leaves everything past the first 4 KB erased, and a probe
 * refuses a neighbour page that is entirely 0xff because reading it back could not
 * tell an over-erase from the truth.
 */
function filledDump(): Uint8Array {
  const b = synthDump()
  for (let i = WINDOW.start; i < WINDOW.end; i++) b[i] = (i * 37 + 11) & 0xff
  return b
}

describe('the erase granularity', () => {
  test('WINDOW.start is 2 KB aligned and not 4 KB aligned, which is the whole risk', () => {
    // 0x16800 / 0x1000 = 22.5. So a 1 KB or 2 KB block never leaves the window and
    // every canary reads what it read before; a 4 KB block or larger has its base at
    // 0x16000 or below and takes live BLE stack with it. Two different failures.
    expect(WINDOW.start % 2048).toBe(0)
    expect(WINDOW.start % 4096).not.toBe(0)
    for (const b of CANDIDATE_BLOCKS) {
      const lost = WINDOW.start - blockBase(WINDOW.start, b)
      expect(lost).toBe(b <= 2048 ? 0 : WINDOW.start % b)
    }
    expect(blockBase(WINDOW.start, 4096)).toBe(0x16000)
    expect(blockBase(WINDOW.start, 16384)).toBe(0x14000)
    expect(blockBase(WINDOW.start, 32768)).toBe(0x10000)
  })

  test('every candidate block larger than a page eats the page before it', () => {
    // The reason a canary cannot be the whole answer: at 1 KB and 2 KB nothing
    // outside the window moves, and erasing page 1 still wipes page 0.
    const page1 = WINDOW.start + PAGE
    for (const b of CANDIDATE_BLOCKS) {
      expect(blockBase(page1, b)).toBeLessThanOrEqual(WINDOW.start)
    }
  })

  test('the probe page is one the plan already erases, and its neighbour too', () => {
    const image = synthImage(40 * 1024)
    const p = okPlan(image, { from: dump(filledDump(), 0), config0: 0xffffffbf })
    const probe = p.probe!
    expect(probe).not.toBeNull()
    const addrs = new Set(p.pages.filter((x) => !x.skip).map((x) => x.addr))
    expect(addrs.has(probe.addr)).toBe(true)
    expect(addrs.has(probe.below)).toBe(true)
    expect(probe.below).toBe(probe.addr - PAGE)
  })

  test('the probe is placed so an oversized block cannot leave the window', () => {
    const image = synthImage(40 * 1024)
    const p = okPlan(image, { from: dump(filledDump(), 0), config0: 0xffffffbf })
    const probe = p.probe!
    expect(probe.containedTo).toBeGreaterThanOrEqual(1024)
    for (const b of CANDIDATE_BLOCKS) {
      if (b > probe.containedTo) continue
      const base = blockBase(probe.addr, b)
      expect(base).toBeGreaterThanOrEqual(WINDOW.start)
      expect(base + b).toBeLessThanOrEqual(WINDOW.end)
      // and the page read back afterwards is inside every one of those blocks
      expect(probe.below).toBeGreaterThanOrEqual(base)
      expect(probe.below + PAGE).toBeLessThanOrEqual(base + b)
    }
  })

  test('the probe also reads the page above, for a geometry nobody has ruled out', () => {
    const image = synthImage(40 * 1024)
    const p = okPlan(image, { from: dump(filledDump(), 0), config0: 0xffffffbf })
    const probe = p.probe!
    expect(probe.above).toBe(probe.addr + PAGE)
    expect(probe.aboveWords.length).toBe(PAGE / 4)
    const script = tcl(p)
    expect(script).toContain(`check_words ${hexAddr(probe.below)} {`)
    expect(script).toContain(`check_words ${hexAddr(probe.above!)} {`)
  })

  test('the probe reads a page with something in it, so it cannot be blind', () => {
    const image = synthImage(40 * 1024)
    const p = okPlan(image, { from: dump(filledDump(), 0), config0: 0xffffffbf })
    expect(p.probe!.sighted).toBe(PAGE / 4)
  })

  test('the probe erase comes before every page of the plan', () => {
    const image = synthImage(40 * 1024)
    const p = okPlan(image, { from: dump(filledDump(), 0), config0: 0xffffffbf })
    const script = tcl(p)
    const probeErase = script.search(/^erase_page /m)
    const firstPage = script.search(/^(?:write_page|blank_page|keep_page) /m)
    expect(probeErase).toBeGreaterThan(-1)
    expect(probeErase).toBeLessThan(firstPage)
    expect(script).toContain(`erase_page ${hexAddr(p.probe!.addr)}`)
  })

  test('the probe never leans on a page --resume is going to skip', () => {
    // An over-erase of a page nobody rewrites is damage the run would not repair, so
    // the neighbour the probe reads back has to be a page the run owns.
    const image = synthImage(40 * 1024)
    const app = ota.plaintext(image).subarray(0, 40 * 1024)
    const b = filledDump()
    b.set(app, WINDOW.start)
    b.fill(0xff, WINDOW.start + app.length, WINDOW.end)
    const p = okPlan(image, { from: dump(b, 0), config0: 0xffffffbf, resume: true })
    // everything matches, so everything is skipped, so there is nothing to probe
    expect(willKeep(p).length).toBe(p.pages.length)
    expect(p.probe).toBeNull()

    // now break one page: it is rewritten, but its neighbour is still skipped
    const b2 = b.slice()
    b2[WINDOW.start + 20 * PAGE + 8] ^= 0xff
    const p2 = okPlan(image, { from: dump(b2, 0), config0: 0xffffffbf, resume: true })
    expect(willWrite(p2).length).toBe(1)
    expect(p2.probe).toBeNull()
  })

  test('a plan with no consecutive pages says out loud that it did not probe', () => {
    const image = synthImage(PAGE)
    const p = okPlan(image, { from: dump(filledDump(), 0), config0: 0xffffffbf })
    expect(p.pages.length).toBe(1)
    expect(p.probe).toBeNull()
    expect(tcl(p)).toContain('NO PROBE')
    expect(p.notes.join(' ')).toContain('NO granularity probe')
  })
})

describe.if(TCLSH !== null)('an erase block bigger than a page', () => {
  const image = synthImage(40 * 1024)
  const before = filledDump()
  const p = okPlan(image, { from: dump(before, 0), config0: 0xffffffbf })
  const token = w32(p.crc32)
  const script = tcl(p)

  test('the probe is the layer that catches it, and it catches every candidate', () => {
    for (const block of CANDIDATE_BLOCKS) {
      const r = simulate(script, before, {
        confirm: token,
        config0: '0xffffffbf',
        eraseBlock: block,
        verbose: true,
      })
      expect(r.code, `block ${block}`).not.toBe(0)
      // one erase, the probe's own, and not a single word programmed
      expect(r.stdout, `block ${block}`).toContain('1 page erases')
      expect(r.stdout, `block ${block}`).toContain('0 words programmed')
      // and nothing outside the window was touched, at any block size
      expect(r.stdout, `block ${block}`).not.toContain('DESTROYED')
      const after = r.after!
      for (let i = 0; i < WINDOW.start; i++) {
        if (after[i] !== before[i]) throw new Error(`block ${block} lost ${hx(i)}`)
      }
      for (let i = WINDOW.end; i < before.length; i++) {
        if (after[i] !== before[i]) throw new Error(`block ${block} lost ${hx(i)}`)
      }
    }
  })

  test('the probe is load-bearing: without it a 4 KB block reaches the BLE stack', () => {
    // This is the script as it stood before the probe existed. It is here so that
    // deleting the probe fails a test rather than a unit.
    const noProbe = tcl({ ...p, probe: null })
    expect(noProbe).toContain('NO PROBE')
    const r = simulate(noProbe, before, {
      confirm: token,
      config0: '0xffffffbf',
      eraseBlock: 4096,
      verbose: true,
    })
    expect(r.code).not.toBe(0)
    expect(r.stdout).toContain('DESTROYED')
    expect(r.stdout + r.stderr).toContain('FIRST erase of the session')
  })

  test('verify_last is load-bearing: it is what sees 1 KB and 2 KB at all', () => {
    // At 1 KB and 2 KB the window edges do not move, so no canary can help. Strip
    // both the probe and the per-erase re-read and the run reaches the end of the
    // page loop with half the region erased; the final read-back is the last net.
    const noProbe = tcl({ ...p, probe: null })
    const noVerify = noProbe.replace(/\n  verify_last\n\}/, '\n}')
    expect(noVerify).not.toBe(noProbe)
    for (const block of [1024, 2048]) {
      const kept = simulate(noProbe, before, {
        confirm: token, config0: '0xffffffbf', eraseBlock: block, verbose: true,
      })
      expect(kept.code, `verify_last on, block ${block}`).not.toBe(0)
      // caught at the second page: two erases, one page programmed
      expect(kept.stdout, `block ${block}`).toContain('2 page erases')

      const gone = simulate(noVerify, before, {
        confirm: token, config0: '0xffffffbf', eraseBlock: block, verbose: true,
      })
      expect(gone.code, `verify_last off, block ${block}`).not.toBe(0)
      expect(gone.stdout + gone.stderr).toContain('=== 7.')
    }
  })

  test('with all three layers gone the run passes and the flash is wrong', () => {
    // The shape the tool had before this review: per-page read-back only, canaries
    // at the ends. At 1 KB it exits 0, prints that every word matched, and leaves
    // half the application region erased. Kept as the reason the layers exist.
    const bare = tcl({ ...p, probe: null })
      .replace(/\n  verify_last\n\}/, '\n}')
      .replace(/foreach jgx_a \$::JGX_ORDER \{ verify_page \$jgx_a \}/, '')
    const r = simulate(bare, before, {
      confirm: token, config0: '0xffffffbf', eraseBlock: 1024,
    })
    expect(r.code).toBe(0)
    const after = r.after!
    const plain = ota.plaintext(image).subarray(0, 40 * 1024)
    const wrong = [...plain].filter((b, i) => after[WINDOW.start + i] !== b).length
    expect(wrong).toBeGreaterThan(10000)
  })
})


// --- Canaries that can actually see an erase ------------------------------------------

describe('canaries', () => {
  test('a canary on an erased word is moved to one that is not', () => {
    const b = synthDump()
    // blank the nominal word but leave something else in the same page
    new DataView(b.buffer).setUint32(0x00016000, 0xffffffff, true)
    new DataView(b.buffer).setUint32(0x00016080, 0xcafe1234, true)
    const d = dump(b, 0)
    expect(sightedCanary(d, 0x00016000)).toBe(0x00016080)
    const p = okPlan(synthImage(4096), { from: d, config0: 0xffffffbf })
    const moved = p.canaries.find((c) => c.addr === 0x00016080)!
    expect(moved.word).toBe(0xcafe1234)
    expect(p.canaries.some((c) => c.addr === 0x00016000)).toBe(false)
    expect(p.notes.join(' ')).toContain('cannot detect an erase')
  })

  test('a page that is entirely erased leaves the canary labelled BLIND', () => {
    const b = synthDump()
    const d = dump(b, 0)
    // FLASH_ADDR_INFO_BACKUP is 0xff throughout in this fixture, as it is on unit 1
    expect(sightedCanary(d, ota.FLASH_ADDR_INFO_BACKUP)).toBeNull()
    const p = okPlan(synthImage(4096), { from: d, config0: 0xffffffbf })
    const blind = p.canaries.find((c) => c.addr === ota.FLASH_ADDR_INFO_BACKUP)!
    expect(blind.what).toContain('BLIND')
    expect(p.notes.join(' ')).toContain('not a stray erase')
  })

  test('no canary is left silently unable to detect an erase', () => {
    const p = okPlan(synthImage(4096), { from: dump(synthDump(), 0), config0: 0xffffffbf })
    for (const c of p.canaries) {
      if (c.word === 0xffffffff) expect(c.what).toContain('BLIND')
    }
  })

  test('there is a canary within one page below the window, on both sides', () => {
    // The two that matter for an oversized erase: the closest word below
    // WINDOW.start and the first word above WINDOW.end.
    expect(CANARIES.some((c) => c.addr === WINDOW.start - 4)).toBe(true)
    expect(CANARIES.some((c) => c.addr === WINDOW.end)).toBe(true)
    const below = CANARIES.filter((c) => c.addr < WINDOW.start).map((c) => c.addr)
    // one per block base an oversized erase could have: 0x16000, 0x14000, 0x10000
    for (const b of [4096, 16384, 32768]) {
      expect(below).toContain(blockBase(WINDOW.start, b))
    }
  })
})

describe.if(existsSync(UNIT1))('canaries on the unit the repair is aimed at', () => {
  test('the word just below the window is erased, so the canary moves', () => {
    const d = dump(new Uint8Array(readFileSync(UNIT1)), 0)
    // 0x167fc reads 0xffffffff on both units in hand. Left as it was, the canary
    // closest to the window would have been the one that could say least.
    const raw = new DataView(d.bytes.buffer, d.bytes.byteOffset).getUint32(0x167fc, true)
    expect(raw).toBe(0xffffffff)
    const seen = sightedCanary(d, WINDOW.start - 4)!
    expect(seen).toBeLessThan(WINDOW.start)
    expect(seen).toBeGreaterThanOrEqual(WINDOW.start - PAGE)
    const w = new DataView(d.bytes.buffer, d.bytes.byteOffset).getUint32(seen, true)
    expect(w).not.toBe(0xffffffff)
  })
})

// --- The teardown, on the error paths as well as the good one -------------------------

describe('locking the FMC back down', () => {
  const p = okPlan(synthImage(4096), { from: dump(synthDump(), 0), config0: 0xffffffbf })
  const script = tcl(p)

  test('fail tears the FMC down before it shuts down', () => {
    const body = script.slice(script.indexOf('proc fail'))
    const proc = body.slice(0, body.indexOf('\n}'))
    expect(proc).toContain('lock_down')
    expect(proc.indexOf('lock_down')).toBeLessThan(proc.indexOf('shutdown error'))
  })

  test('lock_down clears ISPCON and re-locks SYS_WRPROT, in that order', () => {
    const body = script.slice(script.indexOf('proc lock_down'))
    const proc = body.slice(0, body.indexOf('\n}'))
    expect(proc).toContain(`mww ${hexAddr(FMC.ISPCON)} ${w32(ISPCON_OFF)}`)
    expect(proc).toContain(`mww ${hexAddr(FMC.WRPROT)} ${w32(0)}`)
    expect(proc.indexOf(FMC.ISPCON.toString(16))).toBeLessThan(
      proc.indexOf(FMC.WRPROT.toString(16)),
    )
  })

  test.if(TCLSH !== null)('a run that aborts mid-flash still leaves the flash locked', () => {
    // The canary check inside the first erase is the easiest abort to provoke: a
    // 4 KB block. Before this, an abort left ISPEN and APUEN set with SYS_WRPROT
    // open, and whatever resumed the core next would have run on writable flash.
    const before = synthDump()
    const r = simulate(tcl({ ...p, probe: null }), before, {
      confirm: w32(p.crc32), config0: '0xffffffbf', eraseBlock: 4096, verbose: true,
    })
    expect(r.code).not.toBe(0)
    expect(r.stdout).toContain('left SYS_WRPROT locked')
    expect(r.stdout).toContain('ISPCON 0x00')
  })

  test.if(TCLSH !== null)('and so does a run that finishes', () => {
    const before = synthDump()
    const r = simulate(script, before, { confirm: w32(p.crc32), config0: '0xffffffbf' })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('left SYS_WRPROT locked')
  })
})

// --- Reading the whole window back at the end -----------------------------------------

describe('the final read-back', () => {
  const p = okPlan(synthImage(4096), {
    from: dump(synthDump(), 0), config0: 0xffffffbf, blankTail: true,
  })
  const script = tcl(p)

  test('every page is recorded and every page is read again', () => {
    expect(script).toContain('foreach jgx_a $::JGX_ORDER { verify_page $jgx_a }')
    expect(script).toContain(`if {[llength $::JGX_ORDER] != ${p.pages.length}}`)
    for (const proc of ['write_page', 'blank_page', 'keep_page']) {
      const body = script.slice(script.indexOf(`proc ${proc} `))
      expect(body.slice(0, body.indexOf('\nproc '))).toContain('record_page')
    }
  })

  test('it runs after the last page and before the closing canary sweep', () => {
    const lastPage = script.lastIndexOf('\nblank_page ')
    const pass = script.indexOf('foreach jgx_a')
    const sweep = script.indexOf('=== 8.')
    expect(lastPage).toBeLessThan(pass)
    expect(pass).toBeLessThan(sweep)
  })
})

// --- The poll, and what happens when it does not clear --------------------------------

describe.if(TCLSH !== null)('wait_trg', () => {
  const p = okPlan(synthImage(2048), { from: dump(synthDump(), 0), config0: 0xffffffbf })
  const before = synthDump()
  const script = tcl(p)

  test('a trigger that stays busy for a while is waited out, not failed', () => {
    const r = simulate(script, before, {
      confirm: w32(p.crc32), config0: '0xffffffbf', busy: 3,
    })
    expect(r.code).toBe(0)
  })

  test('a trigger that never clears stops the run inside the bound', () => {
    const r = simulate(script, before, {
      confirm: w32(p.crc32), config0: '0xffffffbf', busy: 5000, verbose: true,
    })
    expect(r.code).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('ISPTRG stuck busy')
  })
})

// --- Refusals that used to be crashes or silence --------------------------------------

describe('what the plan refuses before a script exists', () => {
  test('a body that is not whole words is refused, twice over', () => {
    const plain = new Uint8Array(1301)
    for (let i = 0; i < plain.length; i++) plain[i] = (i * 7 + 13) & 0xff
    new DataView(plain.buffer).setUint32(0x08, 0x20003910, true)
    new DataView(plain.buffer).setUint32(0x0c, 0x00016a01, true)
    const odd = ota.encode(plain, { appVer: 1, devVer: 10, proVer: 10, type: ota.OTA_APP })
    // `ota.check` gets there first with `not-word-aligned`. The backstop in
    // `buildPlan` is there because `words()` used to throw a raw Error out of the CLI
    // if anything ever reached it with an odd body, and an unhandled exception is not
    // a refusal. Same shape as the window bound: asserted, not assumed.
    const r = plan(odd, { from: dump(synthDump(), 0) })
    expect(r.ok).toBe(false)
    expect(r.refusals.join(' ')).toContain('not a multiple of 4')
    const src = readFileSync('research/tools/swdflash.ts', 'utf8')
    expect(src).toContain('is not a whole number of ')
  })

  test('script and donor need a CONFIG0 canary; plan does not', () => {
    const image = synthImage(4096)
    const d = dump(synthDump(), 0)
    const strict = plan(image, { from: d, requireDump: true, requireConfig0: true })
    expect(strict.ok).toBe(false)
    expect(strict.refusals.join(' ')).toContain('no --config0')
    expect(plan(image, { from: d }).ok).toBe(true)
  })

  test('a mistyped --config0 is refused rather than becoming a canary of zero', () => {
    // num() returns NaN, and NaN >>> 0 is 0, so the script used to assert that
    // CONFIG0 reads 0x00000000, an address that has never held it.
    const r = plan(synthImage(4096), { from: dump(synthDump(), 0), config0: NaN })
    expect(r.ok).toBe(false)
    expect(r.refusals.join(' ')).toContain('--config0 is not a number')
  })

  test('an adapter speed OpenOCD would read as adaptive clocking is refused', () => {
    for (const speed of [0, -1, NaN, 100000]) {
      const r = plan(synthImage(4096), { from: dump(synthDump(), 0), speedKhz: speed })
      expect(r.ok, `speed ${speed}`).toBe(false)
      expect(r.refusals.join(' ')).toContain('not an adapter speed')
    }
    expect(plan(synthImage(4096), { from: dump(synthDump(), 0), speedKhz: 50 }).ok).toBe(true)
  })
})

// --- What actually protects the BLE stack ---------------------------------------------

describe.if(TCLSH !== null)('the region below the window has no hardware backstop', () => {
  const p = okPlan(synthImage(4096), { from: dump(synthDump(), 0), config0: 0xffffffbf })
  const before = synthDump()
  const script = tcl(p)

  test('MUTATION: with the guard gone, APUEN lets an erase reach the BLE stack', () => {
    // The config page and the LDROM are refused by hardware because CFGUEN and LDUEN
    // are clear. The BLE stack is APROM, so APUEN covers it too: `guard` is the only
    // thing between this script and 0x0-0x16800. That asymmetry is worth a test of
    // its own, because the script's own banner groups the four refusals together and
    // three of them are hardware while this one is software.
    const noGuard = script
      .replace(/proc guard \{addr\} \{[\s\S]*?\n\}\n/, 'proc guard {addr} { }\n')
      .replace(`write_page ${hx(WINDOW.start)} {`, 'write_page 0x00000000 {')
    const r = simulate(noGuard, before, {
      confirm: w32(p.crc32), config0: '0xffffffbf', verbose: true,
    })
    expect(r.code).not.toBe(0)
    // it got erased: no ISPFF, no refusal, only the canary noticed
    expect(r.stdout).toContain('ISPFF raised 0 time(s)')
    expect(r.stdout).toContain('DESTROYED')
    expect(r.stdout + r.stderr).toContain('BLE stack reset vector')
  })

  test('and the guard names the window in both directions', () => {
    const body = script.slice(script.indexOf('proc guard'))
    const proc = body.slice(0, body.indexOf('\n}'))
    expect(proc).toContain(`$addr < ${hx(WINDOW.start)}`)
    expect(proc).toContain(`$addr >= ${hx(WINDOW.end)}`)
    // and both ends of every page pass through it
    for (const caller of ['erase_page', 'program_word']) {
      const c = script.slice(script.indexOf(`proc ${caller}`))
      const one = c.slice(0, c.indexOf('\n}'))
      expect((one.match(/guard /g) ?? []).length).toBe(2)
    }
  })
})


describe('addresses the FMC is handed', () => {
  const p = okPlan(synthImage(4096), { from: dump(synthDump(), 0), config0: 0xffffffbf })
  const script = tcl(p)

  test('an erase asserts its own page alignment, and a program its word alignment', () => {
    const erase = script.slice(script.indexOf('proc erase_page'))
    expect(erase.slice(0, erase.indexOf('\n}'))).toContain(`($addr % ${PAGE}) != 0`)
    const prog = script.slice(script.indexOf('proc program_word'))
    expect(prog.slice(0, prog.indexOf('\n}'))).toContain('($addr % 4) != 0')
  })

  test('the cost estimate counts the read-backs, not only the writes', () => {
    // It used to print about 97,000 for the 150-page run and the simulator did
    // 115,681 reads on top of the writes. A number the operator uses to decide how
    // long to sit still should not be the optimistic half of the work.
    const words = willWrite(p).reduce((n, x) => n + x.data!.length / 4, 0)
    const finalPass = p.pages.length * (PAGE / 4)
    expect(transactions(p)).toBeGreaterThan(words * 5 + finalPass)
  })
})


// --- Noticing that the core stopped being ours ----------------------------------------

describe('the core must stay halted', () => {
  const p = okPlan(synthImage(4096), { from: dump(synthDump(), 0), config0: 0xffffffbf })
  const script = tcl(p)

  test('DHCSR is read before the unlock, before every erase, and after the last page', () => {
    const erase = script.slice(script.indexOf('proc erase_page'))
    expect(erase.slice(0, erase.indexOf('\n}'))).toContain('check_halted')
    const calls = [...script.matchAll(/^\s*check_halted /gm)].map((m) => m.index!)
    expect(calls.length).toBe(3) // inside erase_page, before section 3, before section 9
    expect(script.indexOf('check_halted "before the unlock"'))
      .toBeLessThan(script.indexOf(`mww ${hexAddr(FMC.WRPROT)} 0x00000059`))
    const body = script.slice(script.indexOf('proc check_halted'))
    const proc = body.slice(0, body.indexOf('\n}\n'))
    expect(proc).toContain(hx(DHCSR, 8))
    expect(proc).toContain(w32(DHCSR_S_HALT))
    expect(proc).toContain(w32(DHCSR_S_RESET_ST))
  })

  test.if(TCLSH !== null)('a reset part way through stops the run at the next page', () => {
    const before = synthDump()
    // reset after the probe's erase, so the very next erase_page sees it
    const r = simulate(script, before, {
      confirm: w32(p.crc32), config0: '0xffffffbf', resetAt: 1, verbose: true,
    })
    expect(r.code).not.toBe(0)
    // S_HALT is tested first and a reset clears it, so that is the sentence that
    // comes out; S_RESET_ST is what catches a core that reset and re-halted.
    expect(r.stdout + r.stderr).toContain('DHCSR')
    expect(r.stdout + r.stderr).toMatch(/not halted|RESET during this session/)
    // and it stopped at the first page, not the last
    expect(r.stdout).toContain('1 page erases')
    expect(r.stdout).toContain('0 words programmed')
    expect(r.stdout).toContain('left SYS_WRPROT locked')
  })

  test.if(TCLSH !== null)('and a run where it stays halted is unaffected', () => {
    const r = simulate(script, synthDump(), { confirm: w32(p.crc32), config0: '0xffffffbf' })
    expect(r.code).toBe(0)
  })
})

// --- Donor mode ----------------------------------------------------------------------

/**
 * A window that looks like a working unit's application region: a body, a stretch of
 * erased pages, a stretch of programmed zeros. Not the APK, on purpose.
 */
function synthDonorWindow(bodyLength = 70000): Uint8Array {
  const w = new Uint8Array(WINDOW.end - WINDOW.start).fill(0xff)
  for (let i = 0; i < bodyLength; i++) w[i] = (i * 11 + 3) & 0xff
  const dv = new DataView(w.buffer)
  dv.setUint32(0x08, 0x20003910, true) //   initial SP, in SRAM
  dv.setUint32(0x0c, 0x00016a01, true) //   entry, Thumb, inside the application
  const version = [...'TR1906R04-10\0'].map((c) => c.charCodeAt(0))
  w.set(version, 0x7000)
  // The zero fill unit 1 has at the top of its window, so an erase-only page and a
  // programmed-zero page both appear in every donor plan below.
  w.fill(0x00, w.length - 2 * PAGE)
  return w
}

const donorDumps = (window: Uint8Array, howMany = 2) => {
  const bytes = synthDump()
  bytes.set(window, WINDOW.start)
  return Array.from({ length: howMany }, (_, i) => ({
    name: `donor-${'abc'[i]}.bin`,
    bytes: bytes.slice(),
  }))
}

describe('trusting a donor', () => {
  const window = synthDonorWindow()

  test('a good donor is accepted and says what it found', () => {
    const r = readDonor({ dumps: donorDumps(window) })
    expect(r.refusals).toEqual([])
    expect(r.donor).not.toBeNull()
    expect([...r.donor!.window]).toEqual([...window])
    expect(r.facts.join(' ')).toContain('byte-identical')
  })

  test('one dump is not enough, because a bad read becomes permanent', () => {
    const r = readDonor({ dumps: donorDumps(window, 1) })
    expect(r.donor).toBeNull()
    expect(r.refusals.join(' ')).toContain('one donor dump is not enough')
  })

  test('the same file twice is not two reads', () => {
    const one = donorDumps(window, 1)[0]
    const r = readDonor({ dumps: [one, one] })
    expect(r.donor).toBeNull()
    expect(r.refusals.join(' ')).toContain('the same dump was given twice')
  })

  test('dumps that disagree are refused, and the rig is blamed before the silicon', () => {
    const dumps = donorDumps(window)
    dumps[1].bytes[WINDOW.start + 900] ^= 0xff
    const r = readDonor({ dumps })
    expect(r.donor).toBeNull()
    expect(r.refusals.join(' ')).toContain('the donor dumps disagree')
  })

  test('a dump that does not reach the window is refused', () => {
    const short = { name: 'short.bin', bytes: new Uint8Array(0x20000).fill(0x11) }
    const r = readDonor({ dumps: [short, { ...short, name: 'short-b.bin' }] })
    expect(r.donor).toBeNull()
    expect(r.refusals.join(' ')).toContain('does not hold all of')
  })

  test('an all-0xff dump is a read-locked part, not a donor', () => {
    const blank = new Uint8Array(ota.FLASH_ADDR_END).fill(0xff)
    const r = readDonor({
      dumps: [{ name: 'a.bin', bytes: blank }, { name: 'b.bin', bytes: blank.slice() }],
    })
    expect(r.donor).toBeNull()
    expect(r.refusals.join(' ')).toContain('read-locked')
  })

  test('an erased application region holds nothing to copy', () => {
    const erased = new Uint8Array(WINDOW.end - WINDOW.start).fill(0xff)
    const r = readDonor({ dumps: donorDumps(erased) })
    expect(r.donor).toBeNull()
    expect(r.refusals.join(' ')).toContain('entirely erased')
  })

  test('ota.check is the gate, so a bad entry vector is refused', () => {
    const bad = window.slice()
    new DataView(bad.buffer).setUint32(0x0c, 0x00016a00, true) //   even, so not Thumb
    const r = readDonor({ dumps: donorDumps(bad) })
    expect(r.donor).toBeNull()
    expect(r.refusals.join(' ')).toContain('bad-entry-vector')
  })
})

/**
 * The variant question, which is the one that refused the real repair.
 *
 * `ota.check` defaults its expectation to `ota.DEVICE_VERSION`, the APK's label, and
 * every pair here runs `TR1906R04-12`, so donor mode refused the only donor that
 * exists with `wrong-variant`. What replaced the constant is not a looser check but a
 * different one: the two units must share a BLE stack byte for byte, and that is what
 * permits a differing label. These tests pin both halves.
 */
describe('which baseline the patch checks diff against', () => {
  // The bug this exists for: `plan <image> --from <dump>` used to diff every image
  // against the APK container, so an image rebased on a donor came back with seven
  // `protected-region` fatals and `looks-like-an-insertion`, all of which said only
  // "TR1906R04-12 is not TR1906R04-10". Nothing was wrong with the image.
  const donorWindow = (() => {
    const w = synthDonorWindow()
    w.set([...'TR1906R04-12\0'].map((c) => c.charCodeAt(0)), 0x7000)
    return w
  })()
  const target = synthDump(donorWindow)
  const targetDump = dump(target, 0)
  const apk = { path: 'firmware/TR1906R04-10_OTA.bin', bytes: new Uint8Array(64) }

  test('a dump beats the APK container, and the header says which was used', () => {
    const b = chooseBaseline({ from: targetDump, apk })
    expect(b.stock).not.toBeUndefined()
    expect(b.whence).toContain("target's own application")
    expect(ota.plaintext(b.stock!)).toEqual(donorWindow)
  })

  test('the variant comes off the target, never off the image', () => {
    // An image vouching for its own variant is the tool agreeing with itself.
    expect(chooseBaseline({ from: targetDump }).expectVersion).toBe('TR1906R04-12')
    expect(chooseBaseline({ apk }).expectVersion).toBeUndefined()
  })

  test('an image rebased on that unit passes, where the APK baseline refused it', () => {
    // One patched byte inside the window, which is all it takes: against the APK the
    // whole 76,800 bytes differ and the region labels land on the wrong code.
    const patched = donorWindow.slice()
    patched[0x1d06] ^= 0xff
    const image = ota.encode(patched, { appVer: 3, devVer: 10, proVer: 10, type: ota.OTA_APP })

    const good = chooseBaseline({ from: targetDump, apk })
    const withTarget = buildPlan({
      image, imageName: 'rebased.bin', from: targetDump, stock: good.stock,
      expectVersion: good.expectVersion, config0: 0xffffffff, ldrom: 0x20000610,
    })
    expect(withTarget.refusals).toEqual([])
    expect(withTarget.ok).toBe(true)

    // And the old behaviour, kept as the reason the default moved.
    const wrong = buildPlan({
      image, imageName: 'rebased.bin', from: targetDump,
      stock: ota.encode(new Uint8Array(66084), {
        appVer: 3, devVer: 10, proVer: 10, type: ota.OTA_APP,
      }),
      expectVersion: undefined, config0: 0xffffffff, ldrom: 0x20000610,
    })
    expect(wrong.ok).toBe(false)
    expect(wrong.refusals.join(' ')).toContain('wrong-variant')
  })

  test('--stock takes a raw dump as readily as a container', () => {
    const b = chooseBaseline({
      from: null, explicit: { path: 'unit.bin', bytes: target }, apk,
    })
    expect(b.whence).toContain('its application window')
    expect(ota.plaintext(b.stock!)).toEqual(donorWindow)
  })

  test('--stock beats the dump, so the old behaviour is one flag away', () => {
    const container = ota.encode(donorWindow, {
      appVer: 3, devVer: 10, proVer: 10, type: ota.OTA_APP,
    })
    const b = chooseBaseline({
      from: targetDump, explicit: { path: 'given.bin', bytes: container }, apk,
    })
    expect(b.whence).toContain('given.bin')
  })

  test('with no dump and no --stock the APK is used, and labelled as a question', () => {
    const b = chooseBaseline({ apk })
    expect(b.stock).toBe(apk.bytes)
    expect(b.whence).toContain('not the one any unit here runs')
  })

  test('with nothing at all the patch checks are skipped, and it says so', () => {
    const b = chooseBaseline({})
    expect(b.stock).toBeUndefined()
    expect(b.whence).toContain('did not run')
  })
})

describe('the variant, and what authorises one that differs', () => {
  const labelled = (label: string) => {
    const w = synthDonorWindow()
    const bytes = [...label, '\0'].map((c) => c.charCodeAt(0))
    w.set(bytes, 0x7000)
    return w
  }

  test('variantOf reads the build label out of an application', () => {
    expect(variantOf(labelled('TR1906R04-12'))).toBe('TR1906R04-12')
    expect(variantOf(new Uint8Array(4096))).toBeNull()
  })

  test('the label is not truncated by a missing terminator', () => {
    const w = new Uint8Array(64).fill(0x41)
    w.set([...'TR1906R04-12'].map((c) => c.charCodeAt(0)), 0)
    expect(variantOf(w)).toBe('TR1906R04-12AAAAAAAAAAAA')
  })

  test('a -12 donor onto a -10 target is accepted when the stacks agree', () => {
    // The real case: unit 1 reads -10 only because that is what was written onto it.
    const donorWindow = labelled('TR1906R04-12')
    const target = synthDump(labelled('TR1906R04-10'))
    const r = readDonor({
      dumps: donorDumps(donorWindow),
      target: { name: 'unit1.bin', bytes: target },
    })
    expect(r.refusals).toEqual([])
    expect(r.donor!.variant).toBe('TR1906R04-12')
    expect(r.facts.join(' ')).toContain('byte-identical on both units')
    expect(r.facts.join(' ')).toContain('donor TR1906R04-12, target TR1906R04-10')
  })

  test('and the plan it feeds passes ota.check rather than tripping wrong-variant', () => {
    const donorWindow = labelled('TR1906R04-12')
    const target = synthDump(labelled('TR1906R04-10'))
    const src = readDonor({
      dumps: donorDumps(donorWindow),
      target: { name: 'unit1.bin', bytes: target },
    })
    const r = buildPlan({
      donor: src.donor!,
      imageName: 'donor',
      from: dump(target, 0),
      expectVersion: src.donor!.variant ?? undefined,
    })
    expect(r.refusals).toEqual([])
    expect(r.verdict!.findings.map((f) => f.code)).not.toContain('wrong-variant')
  })

  test('without expectVersion the same donor is refused, which was the bug', () => {
    const donorWindow = labelled('TR1906R04-12')
    const target = synthDump(labelled('TR1906R04-10'))
    const r = buildPlan({
      donor: { name: 'donor-a.bin', window: donorWindow, variant: 'TR1906R04-12' },
      imageName: 'donor',
      from: dump(target, 0),
    })
    expect(r.refusals.join(' ')).toContain('wrong-variant')
  })

  test('different BLE stacks are refused, whatever the labels say', () => {
    const donorWindow = labelled('TR1906R04-12')
    const target = synthDump(labelled('TR1906R04-12'))
    target[0x12340] ^= 0xff //   one byte, below the window this tool writes
    const r = readDonor({
      dumps: donorDumps(donorWindow),
      target: { name: 'other-model.bin', bytes: target },
    })
    expect(r.donor).toBeNull()
    expect(r.refusals.join(' ')).toContain('do not share a BLE stack')
    expect(r.refusals.join(' ')).toContain('0x12340')
  })

  test('a target dump that stops short of the window cannot authorise anything', () => {
    const r = readDonor({
      dumps: donorDumps(labelled('TR1906R04-12')),
      target: { name: 'short.bin', bytes: new Uint8Array(0x1000) },
    })
    expect(r.donor).toBeNull()
    expect(r.refusals.join(' ')).toContain('does not cover')
  })

  test('the emitted script records the build and why a differing one was allowed', () => {
    const donorWindow = labelled('TR1906R04-12')
    const target = synthDump(labelled('TR1906R04-10'))
    const src = readDonor({
      dumps: donorDumps(donorWindow),
      target: { name: 'unit1.bin', bytes: target },
    })
    const p = okPlan(undefined, {
      donor: src.donor!,
      from: dump(target, 0),
      imageName: 'donor',
      expectVersion: 'TR1906R04-12',
    })
    const text = tcl(p)
    expect(text).toContain('build TR1906R04-12')
    expect(text).toContain('byte-identical to this donor')
  })
})

describe.if(existsSync(UNIT1) && existsSync(STOCK))('the APK test, on the real bytes', () => {
  test('a donor carrying the APK application is refused', () => {
    // Unit 1 is exactly this case: its application region is the vendor plaintext byte
    // for byte, which is the build that never registers callback slot +0x60.
    const bytes = new Uint8Array(readFileSync(UNIT1))
    const r = readDonor({
      dumps: [
        { name: UNIT1, bytes },
        { name: 'copy.bin', bytes: bytes.slice() },
      ],
      apk: [{ name: STOCK, container: new Uint8Array(readFileSync(STOCK)) }],
    })
    expect(r.donor).toBeNull()
    expect(r.refusals.join(' ')).toContain('byte-identical to')
    expect(r.refusals.join(' ')).toContain('+0x60')
  })

  test('one byte away from the APK is not the APK, and the test says nothing more', () => {
    const bytes = new Uint8Array(readFileSync(UNIT1))
    bytes[0x25000] ^= 0xff
    const r = readDonor({
      dumps: [
        { name: 'a.bin', bytes },
        { name: 'b.bin', bytes: bytes.slice() },
      ],
      apk: [{ name: STOCK, container: new Uint8Array(readFileSync(STOCK)) }],
    })
    // A byte-comparison cannot recognise a build, only a file. What recognises the
    // fault itself is ota.check's reference check, which needs the target unit.
    expect(r.donor).not.toBeNull()
  })
})

describe('the donor page plan', () => {
  const window = synthDonorWindow()
  const target = synthDump()
  const donor = { name: 'donor-a.bin', window }
  const donorPlan = (opts: Opts = {}) =>
    okPlan(undefined, { donor, from: dump(target, 0), imageName: 'donor', ...opts })

  test('it covers the whole window and stops at the staging bank', () => {
    const p = donorPlan()
    expect(p.base).toBe(WINDOW.start)
    expect(p.imageEnd).toBe(WINDOW.end)
    expect(p.pages.length).toBe((WINDOW.end - WINDOW.start) / PAGE)
    expect(p.pages.at(-1)!.addr).toBe(WINDOW.end - PAGE)
  })

  test('a page the donor holds erased is erased, not programmed with 0xffffffff', () => {
    const p = donorPlan()
    expect(willBlank(p).length).toBeGreaterThan(0)
    for (const b of willBlank(p)) {
      const off = b.addr - WINDOW.start
      expect([...window.subarray(off, off + PAGE)].every((x) => x === 0xff)).toBe(true)
    }
    // Programmed zeros are data and must still be written; only 0xff is free.
    const zeroPage = p.pages.find((x) => x.addr === WINDOW.end - PAGE)!
    expect(zeroPage.data).not.toBeNull()
  })

  test('the CRC token is over the bytes that go on the wire', () => {
    const p = donorPlan()
    expect(p.crc32).toBe(ota.crc32(window))
    expect(p.codeSize).toBe(window.length)
  })

  test('the plan says which two units it is about', () => {
    const p = donorPlan()
    expect(p.donor?.name).toBe('donor-a.bin')
    expect(p.notes.join(' ')).toContain('donor and target differ')
    expect(p.notes.join(' ')).toContain('every byte of the window comes from the donor')
  })

  test('no --to dump is refused, exactly as `script` refuses no --from', () => {
    const r = buildPlan({ donor, imageName: 'donor', requireDump: true })
    expect(r.ok).toBe(false)
    expect(r.refusals.join(' ')).toContain('--from')
  })

  test('nothing to write at all is refused rather than producing an empty plan', () => {
    const r = buildPlan({ imageName: 'nothing' })
    expect(r.ok).toBe(false)
    expect(r.refusals.join(' ')).toContain('nothing to write')
  })
})

describe('--keep, for anything found to belong to the unit', () => {
  const window = synthDonorWindow()
  const target = synthDump()
  const donor = { name: 'donor-a.bin', window }
  const span = { start: WINDOW.start + 0x1000, end: WINDOW.start + 0x1010, why: 'a test' }

  test('the kept bytes come from the target and the rest from the donor', () => {
    const p = okPlan(undefined, {
      donor,
      imageName: 'donor',
      from: dump(target, 0),
      keep: [span],
    })
    const page = p.pages.find((x) => x.addr === WINDOW.start + 0x1000)!
    expect([...page.data!.subarray(0, 16)])
      .toEqual([...target.subarray(span.start, span.end)])
    expect(page.data![16]).toBe(window[0x1010])
    expect(p.kept).toEqual([span])
    expect(p.notes.join(' ')).toContain('taken from the target')
  })

  test('the token changes with the kept bytes, so it names what is written', () => {
    const withKeep = okPlan(undefined, {
      donor, imageName: 'donor', from: dump(target, 0), keep: [span],
    })
    expect(withKeep.crc32).not.toBe(ota.crc32(window))
  })

  test('a span that is not word-aligned or not in the window is refused', () => {
    for (const bad of [
      { start: WINDOW.start + 1, end: WINDOW.start + 8, why: 'x' },
      { start: WINDOW.end - 4, end: WINDOW.end + 4, why: 'x' },
      { start: WINDOW.start + 16, end: WINDOW.start + 16, why: 'x' },
    ]) {
      const r = buildPlan({
        donor, imageName: 'donor', from: dump(target, 0), keep: [bad],
      })
      expect(r.ok).toBe(false)
      expect(r.refusals.join(' ')).toContain('word-aligned span')
    }
  })

  test('the empty default is the finding, and the report says so out loud', () => {
    expect(UNIT_SPECIFIC).toEqual([])
    const p = okPlan(undefined, { donor, imageName: 'donor', from: dump(target, 0) })
    expect(p.notes.join(' ')).toContain('no --keep spans')
  })

  test('parseKeep reads what the flag documents and rejects the rest', () => {
    expect(parseKeep('0x26c00-0x26c10')).toMatchObject({ start: 0x26c00, end: 0x26c10 })
    expect(parseKeep('0x26c00')).toBeNull()
    expect(parseKeep('nonsense')).toBeNull()
  })
})

describe('the donor script', () => {
  const window = synthDonorWindow()
  const target = synthDump()
  const p = okPlan(undefined, {
    donor: { name: 'donor-a.bin', window },
    imageName: 'donor-a.bin (donor window)',
    from: dump(target, 0),
    config0: 0xffffffbf,
  })
  const script = tcl(p)

  test('it says the source is another physical unit, at the top', () => {
    expect(script).toContain('SOURCE     a donor DUMP, donor-a.bin')
    expect(script).toContain('becomes that unit')
  })

  test('every structural property still holds, because it is the same generator', () => {
    const cmds = [...script.matchAll(new RegExp(`mww ${hexAddr(FMC.ISPCMD)} (\\S+)`, 'g'))]
      .map((m) => Number(m[1]))
    expect([...new Set(cmds)].sort()).toEqual([CMD_PROGRAM, CMD_PAGE_ERASE].sort())
    const cons = [...script.matchAll(new RegExp(`mww ${hexAddr(FMC.ISPCON)} (\\S+)`, 'g'))]
      .map((m) => m[1])
    expect([...new Set(cons)].sort()).toEqual(['$jgx_new', w32(ISPCON_OFF)].sort())
    expect(script).toContain(`($jgx_was & ${w32(ISPCON_KEEP)}) | ${w32(ISPCON_APROM)}`)
    expect(script).toContain(`($jgx_con & ${w32(ISPCON_MUST_BE_CLEAR)}) != 0`)
    const allowed = new Set(Object.values(FMC).map((a) => hexAddr(a)))
    for (const t of [...script.matchAll(/^\s*mww (\S+)/gm)].map((m) => m[1])) {
      expect(allowed.has(t)).toBe(true)
    }
    expect(script.split('\n').filter((l) => /^\s*program_word\s/.test(l)).length).toBe(1)
  })
})

describe.if(TCLSH !== null)('a donor write, run against the simulated FMC', () => {
  const window = synthDonorWindow()
  const before = synthDump()
  const p = okPlan(undefined, {
    donor: { name: 'donor-a.bin', window },
    imageName: 'donor-a.bin (donor window)',
    from: dump(before, 0),
    config0: 0xffffffff,
  })

  test('the target ends up holding the donor window and nothing else moves', () => {
    const r = simulate(tcl(p), before, { confirm: w32(p.crc32) })
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const after = r.after!
    expect([...after.subarray(WINDOW.start, WINDOW.end)]).toEqual([...window])
    for (let i = 0; i < before.length; i++) {
      if (i >= WINDOW.start && i < WINDOW.end) continue
      if (after[i] !== before[i]) throw new Error(`byte ${hx(i)} changed outside the window`)
    }
  })

  test('the erase-only pages really do come out erased', () => {
    const r = simulate(tcl(p), before, { confirm: w32(p.crc32) })
    for (const b of willBlank(p)) {
      for (let i = 0; i < PAGE; i++) expect(r.after![b.addr + i]).toBe(0xff)
    }
  })

  test('a --keep span survives the write, which is the whole point of it', () => {
    const span = { start: WINDOW.start + 0x1000, end: WINDOW.start + 0x1010, why: 'a test' }
    const kept = okPlan(undefined, {
      donor: { name: 'donor-a.bin', window },
      imageName: 'donor-a.bin (donor window)',
      from: dump(before, 0),
      keep: [span],
      config0: 0xffffffff,
    })
    const r = simulate(tcl(kept), before, { confirm: w32(kept.crc32) })
    expect(r.code).toBe(0)
    expect([...r.after!.subarray(span.start, span.end)])
      .toEqual([...before.subarray(span.start, span.end)])
    // and one byte either side is the donor's, so the span is the span and no wider
    expect(r.after![span.start - 1]).toBe(window[span.start - 1 - WINDOW.start])
    expect(r.after![span.end]).toBe(window[span.end - WINDOW.start])
  })
})

describe.if(existsSync(V1) && existsSync(STOCK) && existsSync(UNIT1))(
  'the gate that would have stopped 8 August',
  () => {
    const image = new Uint8Array(readFileSync(V1))
    const stock = new Uint8Array(readFileSync(STOCK))
    const before = new Uint8Array(readFileSync(UNIT1))

    test('joggles-v1 is refused when the plan is given the unit it would be written to', () => {
      // The image passes every check that can be made of an image alone, which is how
      // it came to exist. What refuses it is the unit: research/image-silicon-match.md.
      const r = buildPlan({
        image,
        imageName: V1,
        stock,
        from: dump(before, 0),
        reference: before,
      })
      expect(r.ok).toBe(false)
      const said = r.refusals.join(' ')
      expect(said).toContain('unregistered-callback')
      expect(said).toContain('device-holds-more')
    })

    test('without the reference it still passes, which is why the reference exists', () => {
      const r = buildPlan({ image, imageName: V1, stock, from: dump(before, 0) })
      expect(r.ok).toBe(true)
    })

    test('unit 1 cannot donate to itself: its own application is the broken one', () => {
      const window = before.slice(WINDOW.start, WINDOW.end)
      const r = buildPlan({
        donor: { name: UNIT1, window },
        imageName: 'self',
        from: dump(before, 0),
        reference: before,
      })
      expect(r.ok).toBe(false)
      expect(r.refusals.join(' ')).toContain('unregistered-callback')
    })
  },
)

const DONOR_A = 'firmware/dump-12E69E-2026-08-19-a.bin'
const DONOR_B = 'firmware/dump-12E69E-2026-08-19-b.bin'

describe.if(
  TCLSH !== null && existsSync(DONOR_A) && existsSync(DONOR_B) && existsSync(UNIT1),
)('the actual repair: 12E69E onto unit 1', () => {
  const before = new Uint8Array(readFileSync(UNIT1))
  const src = readDonor({
    dumps: [
      { name: DONOR_A, bytes: new Uint8Array(readFileSync(DONOR_A)) },
      { name: DONOR_B, bytes: new Uint8Array(readFileSync(DONOR_B)) },
    ],
    target: { name: UNIT1, bytes: before },
  })
  const p = okPlan(undefined, {
    donor: src.donor!,
    imageName: `${DONOR_A} (donor window)`,
    from: dump(before, 0),
    reference: before,
    expectVersion: src.donor!.variant ?? undefined,
    config0: 0xffffffff,
    ldrom: 0x20000610,
  })
  const token = w32(p.crc32)
  const script = tcl(p)

  test('it is the 150-page run the procedure describes', () => {
    expect(p.pages.length).toBe(150)
    expect(willWrite(p).length + willBlank(p).length).toBe(150)
  })

  test('the probe on this run is contained to 32 KB, all of it inside the window', () => {
    const probe = p.probe!
    expect(probe.containedTo).toBe(32768)
    const base = blockBase(probe.addr, 32768)
    expect(base).toBeGreaterThanOrEqual(WINDOW.start)
    expect(base + 32768).toBeLessThanOrEqual(WINDOW.end)
    expect(probe.sighted).toBe(PAGE / 4)
  })

  test('the canary closest to the window is one that can see an erase', () => {
    const below = p.canaries.filter((c) => c.addr < WINDOW.start)
    expect(below.length).toBeGreaterThanOrEqual(4)
    const closest = Math.max(...below.map((c) => c.addr))
    expect(WINDOW.start - closest).toBeLessThan(PAGE)
    expect(below.find((c) => c.addr === closest)!.word).not.toBe(0xffffffff)
  })

  test('at 512 bytes it lands, and touches nothing outside the window', () => {
    const r = simulate(script, before, {
      confirm: token, config0: '0xffffffff',
    })
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect([...r.after!.subarray(WINDOW.start, WINDOW.end)]).toEqual([...src.donor!.window])
    for (let i = 0; i < before.length; i++) {
      if (i >= WINDOW.start && i < WINDOW.end) continue
      if (r.after![i] !== before[i]) throw new Error(`byte ${hx(i)} changed`)
    }
  })

  test('at every other block size it stops at the probe with the stack intact', () => {
    for (const block of CANDIDATE_BLOCKS) {
      const r = simulate(script, before, {
        confirm: token, config0: '0xffffffff', eraseBlock: block, verbose: true,
      })
      expect(r.code, `block ${block}`).not.toBe(0)
      expect(r.stdout, `block ${block}`).toContain('1 page erases')
      expect(r.stdout, `block ${block}`).toContain('0 words programmed')
      expect(r.stdout, `block ${block}`).not.toContain('DESTROYED')
      expect(r.stdout, `block ${block}`).toContain('left SYS_WRPROT locked')
      // the BLE stack, byte for byte, at every block size
      expect([...r.after!.subarray(0, WINDOW.start)])
        .toEqual([...before.subarray(0, WINDOW.start)])
    }
  })
})
