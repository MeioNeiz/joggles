/**
 * Every door to the flash-writing half, not just the one the app comes through.
 *
 * `safe-surface.test.ts` guards the barrel: it proves the phone app cannot reach `ota`
 * or `dfu` *by importing `@joggles/core`*. That is one door. Nothing stopped a second
 * one being cut, and a gate on one door is the failure this project keeps recording:
 * a new CLI command importing `firmware.js`, a screen importing `ota.js` by path, a
 * research tool growing a radio path. This file is the whole doorway list, and it is
 * an allowlist by exact path, so a new importer fails the build and has to be added
 * here on purpose.
 *
 * ## What is being kept apart, and why they are not the same thing
 *
 * Two mechanisms write firmware and they have nothing in common but the word "update":
 *
 * | | carries | over | worst case |
 * | --- | --- | --- | --- |
 * | **OTA commit** | a whole application image | `fd00`, ctrl `03` | a dead unit. It bricked `GLASSES-12C3EF` on 2026-08-08 and the bar is still down |
 * | **slot push** | one `JGX1` slot body | `fff0`/`9600`, `J` opcode | a slot whose magic never landed, with the live slot untouched |
 *
 * So they must never meet in one module. A slot payload aimed at the OTA staging
 * commit path is an image the bootloader would copy over the running application; the
 * resident half, which is the only thing that can push a slot again, is the half that
 * would go. `notes/patch-over-bt.md` is the design.
 *
 * The two are physically adjacent, which is why this is worth a test rather than a
 * comment: the slots live *inside* the OTA staging bank, at `FLASH_DFU_ADDR` onwards.
 * `ota.compareExtension` is the finding that says so.
 *
 * ## The rules, and what each one caught
 *
 * Written by track 64 after defeating the two existing gates in a scratch copy. Every
 * assertion below either failed before it was written or was verified to fail when the
 * violation it names was introduced deliberately.
 *
 * Comments are stripped before any import or call is looked for, so a docblock stays
 * free to name what its module may not do. `patch.ts` says "Not `firmware.js`, which
 * would also put `dfu` and the OTA control point in reach", and that sentence is the
 * opposite of a violation.
 */
import { expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import * as jgx from './jgx.js'
import * as ota from './ota.js'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../../..')

const SKIP = new Set(['node_modules', '.git', 'apk', 'decompiled', 'native', 'firmware'])

/** Source with comments removed. A comment imports nothing and calls nothing. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const isSource = (f: string) =>
  (f.endsWith('.ts') || f.endsWith('.tsx')) &&
  !f.endsWith('.test.ts') &&
  !f.endsWith('.test.tsx')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry) || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (isSource(entry)) out.push(path)
  }
  return out
}

/** Every non-test source file in the repo, as repo-relative paths with its code. */
const FILES: { path: string; src: string }[] = walk(ROOT)
  .map((f) => ({ path: f.slice(ROOT.length + 1), src: code(readFileSync(f, 'utf8')) }))
  .sort((a, b) => a.path.localeCompare(b.path))

const named = (re: RegExp) => FILES.filter((f) => re.test(f.src)).map((f) => f.path)
const one = (path: string) => FILES.find((f) => f.path === path)!.src

test('the walker sees the codebase it thinks it does', () => {
  // Guards every assertion below: a wrong root, or a filter that dropped a whole
  // extension, would make them all vacuous. That is exactly how the `.tsx` hole in
  // choke-point.test.ts stayed open, so it is checked first here.
  const paths = FILES.map((f) => f.path)
  expect(paths).toContain('packages/core/src/ota.ts')
  expect(paths).toContain('packages/cli/src/flash.ts')
  expect(paths).toContain('packages/app/App.tsx')
  expect(paths).toContain('research/tools/build-firmware.ts')
  expect(paths.filter((p) => p.endsWith('.tsx')).length).toBeGreaterThan(5)
  expect(paths.length).toBeGreaterThan(60)
})

// --- Door 1: who may import the flash-writing half at all -------------------------

/**
 * Every module that reaches `ota`, `dfu` or the `firmware.js` barrel that exports
 * them, by any spelling of import.
 *
 * Deliberately an exact-path allowlist rather than a directory rule. The point is
 * that adding a route to this code is a decision somebody writes down, not something
 * a convenient import does quietly.
 */
const FIRMWARE_IMPORTERS = [
  'packages/cli/src/flash.ts', //      the OTA wire. The only one that can send ctrl 03
  'packages/cli/src/ota-check.ts', //  the offline gate, writes nothing
  'packages/cli/src/patch.ts', //      slot push: crc32 only, straight from ota.js
  'packages/core/src/dfu.ts', //       the wire format, needs the container's header
  'packages/core/src/firmware.ts', //  the door itself
]

const REACHES_FIRMWARE =
  /(?:from|import|require)\s*\(?\s*['"][^'"\n]*\/(?:ota|dfu|firmware)\.js['"]/

/** The four packet builders. Anything holding one of these can reach ctrl `03`. */
const OTA_WIRE = /\b(?:crcPacket|sizePacket|versionPacket|dataPackets)\s*\(/

test('only these files reach the flash-writing half', () => {
  const inPackages = named(REACHES_FIRMWARE).filter((p) => p.startsWith('packages/'))
  expect(inPackages).toEqual(FIRMWARE_IMPORTERS)
})

test('research tooling may read images but never speak the OTA wire', () => {
  // Offline analysis is what research/ is for, so importing `ota` there is expected.
  // Growing a radio path there is not: it would be a second flash.ts with no bar.
  const wire = named(OTA_WIRE).filter((p) => p.startsWith('research/'))
  expect(wire).toEqual([])
})

test('nothing under packages/app can reach it, by any route', () => {
  // The app's "cannot brick a unit" guarantee. safe-surface proves the barrel is
  // clean; this proves the app does not go round the barrel.
  const app = FILES.filter((f) => f.path.startsWith('packages/app/'))
  expect(app.length).toBeGreaterThan(20)
  for (const f of app) {
    expect(f.src, `${f.path} reaches the firmware half`).not.toMatch(REACHES_FIRMWARE)
    expect(f.src, `${f.path} names an OTA characteristic`).not.toMatch(/fd0[0-2]/i)
    expect(f.src, `${f.path} builds an OTA control packet`).not.toMatch(OTA_WIRE)
  }
})

// --- Door 2: who may speak the fd00 wire ------------------------------------------

test('exactly one file in the repo speaks the fd00 wire', () => {
  const speakers = named(OTA_WIRE).filter((p) => p !== 'packages/core/src/dfu.ts')
  expect(speakers).toEqual(['packages/cli/src/flash.ts'])
})

test('the fd00 UUIDs are named only where they have to be', () => {
  expect(named(/fd0[0-2]/i)).toEqual([
    'packages/cli/src/flash.ts', //    the one client
    'packages/core/src/dfu.ts', //     the wire format
    'packages/core/src/ota.ts', //     the protected GATT region's own name
    'research/tools/fwtool.ts', //     finds those GATT rows in an image, offline
  ])
})

// --- Door 3: the commit bar --------------------------------------------------------

/**
 * The bar itself, asserted as a property of the source rather than trusted.
 *
 * Nothing else in this repo would notice the bar being deleted, reworded into a
 * warning, or moved below the code it guards. It has survived every argument attack
 * tried against it (`--ldrom-verified=true`, `--ldrom_verified`, `--LDROM-VERIFIED`,
 * `-ldrom-verified`, and `--stock --ldrom-verified`, where the value-taking flag eats
 * it), because the flag set only ever holds exactly what was typed and every
 * deviation fails closed. What it has no defence against is an edit.
 */
test('commit is barred, and the bar is a negative test on a literal flag', () => {
  const src = one('packages/cli/src/flash.ts')
  const bar = "cmd === 'commit' && !flags.has('ldrom-verified')"
  expect(src.split("flags.has('ldrom-verified')").length - 1).toBe(1)

  // The condition AND what it does about it. Asserting the condition alone was not
  // enough: swapping `return commitBar()` for a `console.warn` left the test green
  // with the run carrying straight on to the radio, which is the one attack the first
  // draft of this test survived rather than caught.
  expect(src).toContain(`if (${bar}) return commitBar()`)
  expect(src.split('commitBar()').length - 1).toBe(2) // the definition and one call
  const from = src.indexOf('function commitBar(')
  const body = src.slice(from, src.indexOf('async function main('))
  expect(body).toContain('REFUSED')
  expect(body).toContain('return 2')

  // And it stands in front of the wire, not behind it.
  expect(src.indexOf(bar)).toBeLessThan(src.indexOf('await d.commit('))
  expect(src.indexOf(bar)).toBeLessThan(src.indexOf('Dfu.open('))
})

test('no environment variable can lift the bar', () => {
  // A flag is typed by a person each time. An env var is set once and forgotten,
  // which is the wrong shape entirely for a claim about evidence.
  const src = one('packages/cli/src/flash.ts')
  expect(src).not.toMatch(/process\.env|Bun\.env/)
})

test("nothing else in the repo passes the flag on anybody's behalf", () => {
  // A wrapper script or an npm alias carrying --ldrom-verified would lift the bar for
  // every future invocation without anyone typing it. flash.ts names it in the
  // refusal it prints, which is the opposite of passing it.
  const passers = FILES.filter(
    (f) => /--ldrom-verified/.test(f.src) && f.path !== 'packages/cli/src/flash.ts',
  ).map((f) => f.path)
  expect(passers).toEqual([])
  const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8')
  expect(pkg).not.toContain('ldrom-verified')
})

test('the refusal does not describe a bar that has already been cleared', () => {
  // The flag was named after evidence that has since been gathered: track 48 dumped
  // and disassembled the LDROM on 2026-08-19, so "dump the LDROM and confirm a
  // bootloader restores CBS", which is what this message used to ask for, now reads
  // as a box that has been ticked. The answer is still no, for reasons the dump
  // produced rather than removed, and the message has to say the later thing.
  const src = one('packages/cli/src/flash.ts')
  expect(src).toContain('ldrom-2026-08-19.md')
  expect(src).toMatch(/no recovery transport|no UART receive|no button, no radio/)
  expect(src).not.toMatch(/The bar to lift this is dumping the LDROM/)
})

// --- Door 4: the slot push and the OTA commit never meet ---------------------------

/** Driving the JGX update wire. `jgx.ts` declares them; every other file is a caller. */
const SLOT_PUSH = /\b(?:updBegin|updData|updEnd|updAbort)\s*\(/
const DECLARED_IN = 'packages/core/src/jgx.ts'

const pushers = () => named(SLOT_PUSH).filter((p) => p !== DECLARED_IN)

test('the slot-push clients are known, and there is at least one', () => {
  // Guards the two assertions below from passing because nothing matched.
  expect(pushers()).toEqual(['packages/cli/src/patch.ts'])
})

test('no module drives both the slot push and the OTA commit', () => {
  const both = FILES.filter((f) => SLOT_PUSH.test(f.src) && OTA_WIRE.test(f.src))
  expect(both.map((f) => f.path)).toEqual([])
})

test('a slot-push client cannot reach the OTA control point', () => {
  // `crc32` is a legitimate need and comes straight from `ota.js`. `firmware.js` is
  // not, because it hands out `dfu` in the same import.
  for (const path of pushers()) {
    const src = one(path)
    expect(src, `${path} imports firmware.js`).not.toMatch(/\/firmware\.js['"]/)
    expect(src, `${path} imports dfu.js`).not.toMatch(/\/dfu\.js['"]/)
    expect(src, `${path} names an OTA characteristic`).not.toMatch(/fd0[0-2]/i)
  }
})

test('the OTA client does not know the slot push exists', () => {
  expect(one('packages/cli/src/flash.ts')).not.toMatch(/\bjgx\b|\bupd[A-Z]/)
})

/**
 * The client cannot aim a payload, and that is a property of the wire format.
 *
 * The device picks which slot from the two generations; the phone does not choose and
 * cannot. That is the whole defence of the resident half, because the resident half is
 * the only code that can push a slot again. It holds only while no `UPD_*` builder
 * accepts an address or a slot index, so the arity is asserted rather than described:
 * the moment one gains a third parameter, a caller can name `0x28800`.
 */
test('no UPD_ builder takes an address or a slot index', () => {
  expect(jgx.updBegin.length).toBe(2) //  length, crc
  expect(jgx.updData.length).toBe(2) //   seq, block
  expect(jgx.updEnd.length).toBe(0)
  expect(jgx.updAbort.length).toBe(0)
  expect(jgx.updStatus.length).toBe(0)

  // Every future one too. Naming the five above is not enough: the first draft of this
  // test was defeated by *adding* `updBeginAt(length, crc, slot)` beside them rather
  // than by widening any of them, which is the realistic shape of the mistake.
  for (const [name, value] of Object.entries(jgx)) {
    if (typeof value !== 'function' || !name.startsWith('upd')) continue
    const why = `jgx.${name} takes ${value.length} arguments`
    expect(value.length, why).toBeLessThanOrEqual(2)
  }
})

test('no exported signature in the wire format names a flash location', () => {
  // Scoped to parameters, because a *reply* legitimately reports which slot is live.
  // What must not exist is an argument going the other way.
  const sigs = [
    ...one(DECLARED_IN).matchAll(
      /export\s+(?:function\s+(\w+)\s*|const\s+(\w+)\s*=\s*)\(([^)]*)\)/g,
    ),
  ].map((m) => ({ name: m[1] ?? m[2], params: m[3] }))

  // Guards the extractor: a regex that matched nothing would make this vacuous.
  expect(sigs.map((s) => s.name)).toContain('updBegin')
  expect(sigs.map((s) => s.name)).toContain('updData')
  expect(sigs.length).toBeGreaterThan(3)

  for (const s of sigs) {
    expect(s.params, `jgx.${s.name}(${s.params}) names a location`).not.toMatch(
      /\b(?:slot|addr|address|page)\b/i,
    )
  }
})

test('the wire format names no flash address at all', () => {
  // A five-digit hex literal in this file would be a flash address on this part, and
  // the client has no business holding one.
  expect(one(DECLARED_IN)).not.toMatch(/0x[0-9a-f]{5,}/i)
})

test('a slot body is bounded before it reaches the device', () => {
  expect(() => jgx.updBegin(0, 0)).toThrow()
  expect(() => jgx.updBegin(0x10000, 0)).toThrow()
  expect(() => jgx.updData(0, new Uint8Array(jgx.UPD_DATA_BYTES + 1))).toThrow()
})

/**
 * The slots are inside the OTA staging bank, so the two mechanisms overlap in flash
 * whatever the code does.
 *
 * `notes/patch-over-bt.md` puts the resident block at `0x28800`-`0x28bd3` and slot A
 * at `0x29400`, which is `FLASH_DFU_ADDR`. Both literals are quoted from that table
 * rather than imported, because the constants live in `research/tools/updater.ts` and
 * a core test coupling itself to the assembler would be the wrong dependency.
 */
test('staging lands on the slots and leaves the resident half alone', () => {
  const RESIDENT = 0x28800
  const SLOT_A = 0x29400
  expect(ota.FLASH_DFU_ADDR).toBe(SLOT_A)
  expect(RESIDENT).toBeLessThan(ota.FLASH_DFU_ADDR)
  // And the finding that says so out loud fires off the extension's own magic word.
  const dump = new Uint8Array(ota.REFERENCE_MIN_BYTES)
  expect(ota.compareExtension(dump)).toEqual([])
  const at = ota.FLASH_APP_ADDR + (RESIDENT - ota.FLASH_APP_ADDR)
  for (let i = 0; i < jgx.MAGIC.length; i++) dump[at + i] = jgx.MAGIC.charCodeAt(i)
  const f = ota.compareExtension(dump)
  expect(f.map((x) => x.code)).toEqual(['erases-jgx-slots'])
  expect(f[0].message).toContain('0x29400')
})

// --- Door 5: the escape hatches stay out of reach ----------------------------------

test('allowProtectedRegions has no caller outside the module that defines it', () => {
  // Its own docblock says reaching it should require editing code. That is only true
  // while nothing has already wired it to a flag.
  expect(named(/allowProtectedRegions/)).toEqual(['packages/core/src/ota.ts'])
})

test('the committing path asks for the silicon check rather than warning about it', () => {
  // `no-reference-dump` is a warning for an offline look and fatal on the way to the
  // wire. That only helps if the caller that reaches the wire sets the flag.
  const src = one('packages/cli/src/flash.ts')
  expect(src).toMatch(/forCommit:\s*cmd === 'commit'/)
})
