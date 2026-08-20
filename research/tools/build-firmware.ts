#!/usr/bin/env bun
/**
 * Build our firmware: stock, plus one dispatcher hook, plus the `JGX1` extension.
 *
 *   bun research/tools/build-firmware.ts [out.bin] [flags]
 *
 *     --from-donor <dump.bin>  build on a working unit's own application, read back
 *                              over SWD, instead of on the APK container. Repeat the
 *                              flag for each dump; they must agree byte for byte
 *     --into-fill      let the extension land in programmed zeros, not erased flash
 *     --name-at <hex>  which GLASSES- to patch, when the image holds more than one
 *     --key-at <hex>   which copy of the vendor AES key to patch, likewise
 *     --stock-key      leave the vendor AES key in place
 *     --stock-name     leave the advert name as GLASSES-
 *     --name <prefix>  advert name, exactly 8 bytes (default JOGGLES-)
 *     --key <32 hex>   crew group key, instead of firmware/crew-key.json
 *     --version <n>    extension version reported by HELLO (default 1)
 *     --feature <name> also apply a feature's in-place edits to the vendor's code.
 *                      Repeat the flag. `--feature list` prints what there is
 *
 * This writes a file. It touches no Bluetooth, so running it is always safe, and
 * `ota.check` gates the result before it is written at all.
 *
 * ## THE DEFAULT BUILD MUST NOT BE FLASHED, AND `--from-donor` IS THE ANSWER
 *
 * `research/hardfault-0xd38-2026-08-19.md`: the application in the vendor APK is not
 * the application this hardware runs. It skips the exports that register callback slot
 * `+0x60`, the BLE stack branches through that slot on a cold boot, and that is what
 * killed `GLASSES-12C3EF`. **`firmware/joggles-v1.bin` inherits the defect**, because
 * it is that image plus 88 bytes, and flashing it to a working pair would break it the
 * same way. So the default output of this tool is a study object until a donor exists.
 *
 * `--from-donor` bases the same three edits and the same appended block on a working
 * unit's own application region instead. Every address below is then wrong, and the
 * tool does not carry them over: `ext.resolveLayout` finds each anchor by content in
 * whatever image it is given, refuses when a signature is missing or appears twice,
 * scans for branches into the block the hook overwrites before overwriting it, and
 * `ext.placeExtension` computes where the block goes from the bytes rather than from
 * `EXT_BASE`. Every one of those is a refusal, not a fallback.
 *
 * ## What v1 changes, and what it deliberately does not
 *
 * Three in-place edits and one append. Nothing is relinked, no protected region is
 * touched, and the OTA service that provides the way back is untouched, so an
 * aborted transfer costs nothing and stock can be re-flashed at any time.
 *
 * The four addresses below are the APK's, and `--from-donor` resolves its own.
 *
 *  1. `abs 0x182a6`, 28 bytes: the `LOOP` dispatcher arm becomes a compare against
 *     `J` and a call into free flash. Costs `LOOP`, still reachable as `ANIM 19`.
 *  2. `abs 0x22b94`, exactly 16 bytes: the AES key becomes the crew group key. This is
 *     first a defence, since nobody with the stock vendor app can then drive a unit a
 *     crew member is wearing, and the same 16 bytes are the crew credential. Applied only
 *     to units we own and flash ourselves; strangers' units are never reflashed.
 *  3. `abs 0x2691c`, exactly 8 bytes: the advert name, so crew units are told from
 *     stock at scan time. Not "8 or fewer": the firmware writes 6 hex characters of
 *     the MAC at a fixed offset of 8 and advertises a fixed 14 bytes, so a short
 *     prefix zero-padded to 8 puts a NUL in front of the MAC and the whole fleet
 *     advertises the same truncated name. See "The advert name is 14 fixed bytes" in
 *     `research/firmware-internals.md`.
 *  4. `abs 0x26a24` onwards: the extension block itself.
 *
 * ## Losing the crew key does not brick anything
 *
 * The OTA service on `fd00` does not use this key. Its payload is XOR-descrambled
 * with the fixed pad at `abs 0x1f988`, not AES-decrypted, so a unit whose group key
 * has been lost can still be re-flashed back to stock. *derived*, from the OTA state
 * machine in `research/firmware-flashing.md`; nothing here traces the `fd00` write
 * path independently.
 */
import { existsSync } from 'node:fs'
import * as ota from '../../packages/core/src/ota.js'
import { build, bytes, type Append, type Assertion, type Edit } from './patch.js'
import { buildExtension, buildHook, readExtension } from './ext.js'
import * as ext from './ext.js'
import { readDonor, WINDOW } from './swdflash.js'
import { FEATURES, type ImageFeature } from './features/catalogue.js'

const STOCK = 'firmware/TR1906R04-10_OTA.bin'
const KEY_FILE = 'firmware/crew-key.json'
const DEFAULT_OUT = 'firmware/joggles-v1.bin'

const hx = (n: number) => '0x' + (n >>> 0).toString(16)
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)))
const hexKey = (k: Uint8Array) =>
  [...k].map((b) => b.toString(16).padStart(2, '0')).join('')

// --- Stock bytes every edit asserts against ---------------------------------------

// The addresses these two live at are the APK's and are no longer written down here:
// `ext.resolveLayout` finds them in whatever image is being patched. The bytes are what
// identifies them, so the bytes are what this file keeps.
const VENDOR_KEY = bytes('34 52 2a 5b 7a 6e 49 2c 08 09 0a 9d 8d 2a 23 f8')
const VENDOR_NAME = 'GLASSES-'

// --- The crew group key -----------------------------------------------------------

/**
 * Read the group key, generating one on first use.
 *
 * It lives under `firmware/`, which is gitignored in full, so the credential is
 * never committed. Regenerating it is not dangerous, only inconvenient: units
 * already flashed with the old key keep answering to the old key until re-flashed.
 */
async function crewKey(): Promise<Uint8Array> {
  if (existsSync(KEY_FILE)) {
    const saved = await Bun.file(KEY_FILE).json()
    const key = bytes(String(saved.key).replace(/(..)/g, '$1 '))
    if (key.length !== 16) throw new Error(`${KEY_FILE}: key must be 16 bytes`)
    return key
  }
  const key = crypto.getRandomValues(new Uint8Array(16))
  await Bun.write(KEY_FILE, JSON.stringify({ key: hexKey(key), created: 'v1' }, null, 2))
  console.log(`\ngenerated a new crew group key in ${KEY_FILE}`)
  console.log('  it is gitignored, it is the credential for every unit you flash,')
  console.log('  and any unit already carrying a different one will stop answering.\n')
  return key
}

// --- Argument parsing -------------------------------------------------------------

const TAKES_VALUE = new Set([
  'name', 'key', 'version', 'from-donor', 'name-at', 'key-at', 'feature',
])
const flags = new Set<string>()
const values = new Map<string, string>()
const repeated = new Map<string, string[]>()
const positional: string[] = []

for (let i = 0; i < Bun.argv.length - 2; i++) {
  const arg = Bun.argv[i + 2]
  if (!arg.startsWith('--')) {
    positional.push(arg)
    continue
  }
  const name = arg.slice(2)
  if (!TAKES_VALUE.has(name)) {
    flags.add(name)
    continue
  }
  const value = Bun.argv[i + 3] ?? ''
  values.set(name, value)
  repeated.set(name, [...(repeated.get(name) ?? []), value])
  i++ //   skip the value, so it is never mistaken for the output path
}

const unknown = [...flags].filter(
  (f) => !['stock-key', 'stock-name', 'into-fill'].includes(f) && !TAKES_VALUE.has(f),
)
if (unknown.length) {
  console.error(`unknown flag(s): ${unknown.map((f) => `--${f}`).join(', ')}`)
  process.exit(2)
}

const flag = (name: string) => flags.has(name)

// Features, before anything is read: `--feature list` should answer without needing an
// image, a donor or a key.
const wanted = repeated.get('feature') ?? []
if (wanted.includes('list')) {
  console.log('features:')
  for (const f of FEATURES) {
    console.log(`  ${f.id}  ${f.summary}`)
    console.log(`      sub-commands ${f.subcommands.map((sc) => hx(sc.id)).join(', ')}` +
      `, capability ${hx(f.capability)}` +
      `${f.edits ? ', and edits to the vendor\'s code' : ', slot only'}`)
  }
  process.exit(0)
}
const out = positional[0] ?? DEFAULT_OUT
const version = Number(values.get('version') ?? 1)
const name = values.get('name') ?? 'JOGGLES-'

const donorPaths = repeated.get('from-donor') ?? []
if (!donorPaths.length && !existsSync(STOCK)) {
  console.error(`no stock image at ${STOCK}. firmware/ is gitignored; restore it first.`)
  process.exit(2)
}
// Exactly 8, not "up to 8". The MAC suffix is written at name + 8 by the boot code at
// abs 0x21540 and the advert length is the constant 14, so a shorter prefix padded with
// NUL hides the MAC and every unit on the image advertises the same name.
if (name.length !== VENDOR_NAME.length) {
  console.error(`--name ${name} is ${name.length} bytes; it must be exactly ` +
    `${VENDOR_NAME.length}, because the MAC suffix lands at a fixed offset of ` +
    `${VENDOR_NAME.length} and a NUL before it truncates the advert for every unit.`)
  process.exit(2)
}
if (!/^[\x20-\x7e]+$/.test(name)) {
  console.error(`--name ${name} must be printable ASCII; it is advertised verbatim.`)
  process.exit(2)
}

// --- The base image, and where its anchors are --------------------------------------

const hexArg = (name: string) => {
  if (!values.has(name)) return undefined
  const raw = values.get(name)!
  return Number.parseInt(raw, 16) || Number(raw)
}

/** The plaintext being patched, and what to call it in the report. */
let basePlain: Uint8Array | undefined
let baseName = STOCK
/** The donor's own build label, and a dump to hold the image against. */
let expectVersion: string | undefined
let reference: Uint8Array | undefined

if (donorPaths.length) {
  const dumps = await Promise.all(
    donorPaths.map(async (p) => {
      if (!existsSync(p)) {
        console.error(`no such donor dump: ${p}`)
        process.exit(2)
      }
      return { name: p, bytes: new Uint8Array(await Bun.file(p).arrayBuffer()) }
    }),
  )
  const apk: { name: string; container: Uint8Array }[] = []
  for (const p of [STOCK, 'firmware/TR1906R04-1-10_OTA.bin']) {
    if (!existsSync(p)) continue
    apk.push({ name: p, container: new Uint8Array(await Bun.file(p).arrayBuffer()) })
  }
  const src = readDonor({ dumps, apk })
  console.log(`donor  ${donorPaths.join(', ')}`)
  for (const f of src.facts) console.log(`       ${f}`)
  if (!src.donor) {
    console.error('\nREFUSED: this donor cannot be the base for a build.')
    for (const r of src.refusals) console.error(`  ${r}`)
    process.exit(1)
  }
  basePlain = src.donor.window
  baseName = `${src.donor.name} (${hx(WINDOW.start)}-${hx(WINDOW.end)})`
  expectVersion = src.donor.variant ?? undefined
  // The donor is a working unit, so its own dump is the reference the image has to
  // match: `compareDevice` then asks whether every callback slot that unit's BLE stack
  // dispatches through is one this image registers. On the APK image that is what
  // fires `unregistered-callback`, and it is the check 2026-08-08 did not have.
  reference = dumps[0].bytes
  console.log()
} else {
  basePlain = ota.plaintext(new Uint8Array(await Bun.file(STOCK).arrayBuffer()))
  console.log(`base   ${STOCK}, the APK container`)
  console.log('       *** THIS BUILD MUST NOT BE FLASHED TO ANY UNIT. *** The APK\'s')
  console.log('       application is not the one this hardware runs, and an image built')
  console.log('       on it bricks a working pair the way GLASSES-12C3EF was bricked:')
  console.log('       research/hardfault-0xd38-2026-08-19.md. Use --from-donor.')
  console.log()
}

// Every anchor found by content, in this image, rather than carried over from the APK.
// On the APK image this resolves to exactly the constants in ext.ts, which is asserted
// in ext.test.ts, so the donor path is not a second implementation of the same idea.
const resolved = ext.resolveLayout(basePlain, {
  advertNameAt: hexArg('name-at'),
  aesKeyAt: hexArg('key-at'),
})
for (const n of resolved.notes) {
  console.error(`${n.severity === 'fatal' ? 'FATAL' : 'warn '}  ${n.message}`)
}
if (!resolved.layout) {
  console.error('\nREFUSED: the patch cannot be placed in this image.')
  console.error('Every address in ext.ts is the APK build\'s. On a different build they')
  console.error('have to be re-derived, and this tool will not guess at one.')
  process.exit(1)
}
const layout = resolved.layout

// --- Build ------------------------------------------------------------------------

// Sized once at a throwaway base to learn how many bytes have to fit, then assembled
// again at the address that was found for them. Nothing in the block is
// position-independent, so the two-pass shape is the honest one.
const sized = buildExtension({
  version,
  base: ext.EXT_BASE,
  notify: layout.notify,
  site: layout.site,
})
const placement = ext.placeExtension({
  window: basePlain,
  size: sized.code.length,
  intoFill: flag('into-fill'),
})
for (const n of placement.notes) {
  console.error(`${n.severity === 'fatal' ? 'FATAL' : 'warn '}  ${n.message}`)
}
if (!placement.place) {
  console.error('\nREFUSED: there is nowhere in this image to put the extension.')
  console.error(`${hx(ext.EXT_BASE)} is where the APK's image ends and it means nothing`)
  console.error('here. Nothing has been written.')
  process.exit(1)
}

const extension = buildExtension({
  version,
  base: placement.place.addr,
  notify: layout.notify,
  site: layout.site,
})
const hook = buildHook(extension.entry, layout.site)

console.log(`extension v${version}: ${extension.code.length} B at ${hx(extension.base)}`)
console.log(`  entry ${hx(extension.entry)}, capabilities ${hx(extension.capabilities)}`)
console.log(`  opcode '${ext.OPCODE}', sub-commands: HELLO(${hx(ext.SUB.HELLO)})`)
console.log(`  landing on ${placement.place.on === 'erased' ? 'erased flash' : 'programmed zeros'}`)
const left = ext.STAGING_BANK - extension.base - extension.code.length
console.log(`  free flash left: ${left} B`)
console.log()
console.log('anchors, found by content in this image:')
console.log(`  chain      ${hx(layout.site.chainAt)}, opcode in r${layout.site.opReg} ` +
  `from [r${layout.site.frameReg}, #2] loaded at ${hx(layout.site.loadAt)}`)
console.log(`  hook       ${hx(layout.site.callAt)}, ${ext.HOOK_LEN} B: the dead ` +
  `'${String.fromCharCode(layout.site.deadImm)}' compare and its island at ` +
  hx(layout.site.deadIsland))
console.log(`  returns to ${hx(layout.site.returnTo)} when the opcode is not ours, ` +
  `${hx(layout.site.epilogue)} when it is`)
console.log(`  block left alone ${hx(layout.site.returnTo)}-${hx(layout.site.epilogue)}` +
  `, with ${layout.blockEntries.length} branch(es) into it`)
console.log(`  notify     ${hx(layout.notify)}`)
console.log(`  AES key    ${layout.aesKey === null ? 'not found' : hx(layout.aesKey)}`)
const nameAt = layout.advertName === null ? 'not found' : hx(layout.advertName)
console.log(`  advert name ${nameAt}`)
console.log()

// --- Features: in-place edits to the vendor's own code -------------------------------
//
// A feature's slot half is uploaded over Bluetooth and is nothing to do with this build.
// What lands here is the other half: the length-preserving immediate edits a feature
// needs in the image before its slot is any use. The tick is the one that has any:
// `features/tick.ts`, and the reason it cannot be a slot alone is in its header.
const unknownFeature = wanted.filter((w) => !FEATURES.some((f) => f.id === w))
if (unknownFeature.length) {
  console.error(`unknown feature(s): ${unknownFeature.join(', ')}`)
  console.error(`there is: ${FEATURES.map((f) => f.id).join(', ')}`)
  process.exit(2)
}

const featureEdits: Edit[] = []
for (const id of wanted) {
  const feature = FEATURES.find((f) => f.id === id) as ImageFeature
  const resolved = feature.resolve(basePlain, ext.IMAGE_BASE)
  for (const n of resolved.notes) {
    console.error(`${n.severity === 'fatal' ? 'FATAL' : 'warn '}  ${id}: ${n.message}`)
  }
  if (!resolved.facts) {
    console.error(`\nREFUSED: feature '${id}' cannot be applied to this image.`)
    process.exit(1)
  }
  const planned = feature.edits!(resolved.facts as never, basePlain, ext.IMAGE_BASE)
  for (const n of planned.notes) {
    console.error(`${n.severity === 'fatal' ? 'FATAL' : 'warn '}  ${id}: ${n.message}`)
  }
  if (planned.notes.some((n) => n.severity === 'fatal')) {
    console.error(`\nREFUSED: feature '${id}' has nothing safe to emit for this image.`)
    process.exit(1)
  }
  console.log(`feature ${id}: ${planned.edits.length} in-place edit(s)`)
  for (const e of planned.edits) console.log(`  ${hx(e.abs)}  ${e.note}`)
  console.log()
  featureEdits.push(...planned.edits)
}

// On the APK the LIGHT back-branch is a constant read out of a disassembly, so the
// assertion is worth having: it fails the build if the file on disk is not the file
// those documents describe. On a donor there is no such constant, and the equivalent
// guarantee is stronger and already spent: `resolveLayout` scanned the whole image for
// branches into the block instead of trusting one address.
// Nothing outside the hook is asserted any more, and that is a consequence of the hook
// shrinking to four bytes: the 28-byte version depended on the LIGHT arm's back-branch
// landing where it expected, so that branch had to be asserted separately. This one
// overwrites no block anything branches into, so its own `expect` is the whole check.
const assertions: Assertion[] = []

const edits: Edit[] = [
  ...featureEdits,
  {
    abs: layout.site.callAt,
    expect: ext.hookStockBytes(layout.site),
    to: hook,
    note: `dead '${String.fromCharCode(layout.site.deadImm)}' compare -> bl ` +
      `${hx(extension.entry)}, the '${ext.OPCODE}' trampoline`,
  },
]

if (!flag('stock-key')) {
  const given = values.get('key')
  // Checked as a string, not after parsing: a stray non-hex character parses to 0x00
  // and the unit would be flashed with a credential nobody has written down.
  if (given !== undefined && !/^[0-9a-fA-F]{32}$/.test(given)) {
    console.error(`--key must be exactly 32 hex characters, got "${given}"`)
    process.exit(2)
  }
  if (layout.aesKey === null) {
    console.error('REFUSED: the vendor AES key is not findable in this image, so there')
    console.error('is nothing to replace with the crew key. --stock-key builds without it.')
    process.exit(1)
  }
  const key = given ? bytes(given.replace(/(..)/g, '$1 ')) : await crewKey()
  edits.push({
    abs: layout.aesKey,
    expect: VENDOR_KEY,
    to: key,
    // patch.ts refuses a 17th byte here. The AES S-box starts at abs 0x22ba4 and a
    // one-byte overrun corrupts the cipher in both directions, uncaught by ota.check.
    note: 'AES key -> crew group key (exactly 16 bytes; S-box follows)',
  })
}

if (!flag('stock-name')) {
  if (layout.advertName === null) {
    console.error('REFUSED: the GLASSES- prefix is not findable in this image, so the')
    console.error('advert cannot be renamed. --stock-name builds without the rename.')
    process.exit(1)
  }
  edits.push({
    abs: layout.advertName,
    expect: ascii(VENDOR_NAME),
    to: ascii(name),
    note: `advert name ${VENDOR_NAME} -> ${name}`,
  })
}

// On a donor the block lands inside the window rather than past the end of it, so it
// is an edit against whatever is currently there rather than an append.
//
// `expect` is the fill itself, not a slice of the base. *Corrected 2026-08-20 by
// review*, which pointed out that slicing the expectation out of `basePlain` asserts
// the image against itself, the same fault the four-byte hook's own expectation was
// called out for. `placeExtension` has already established the landing is either all
// `0xff` or all `0x00`, so the expectation is one of those two, spelled out.
const inside = extension.base < ext.IMAGE_BASE + basePlain.length
const appends: Append[] = inside
  ? []
  : [{ abs: extension.base, data: extension.code, note: `JGX1 extension v${version}` }]
if (inside) {
  const fill = placement.place.on === 'erased' ? 0xff : 0x00
  edits.push({
    abs: extension.base,
    expect: new Uint8Array(extension.code.length).fill(fill),
    to: extension.code,
    note: `JGX1 extension v${version}, into ${placement.place.on} at ${hx(extension.base)}`,
  })
}

const container = await build({
  out,
  edits,
  appends,
  assertions,
  stock: STOCK,
  basePlain: donorPaths.length ? basePlain : undefined,
  baseName: donorPaths.length ? baseName : undefined,
  expectVersion,
  reference,
})

// --- Report -----------------------------------------------------------------------

const plain = ota.plaintext(container)
const readBack = readExtension(plain, extension.base, ext.IMAGE_BASE)
if (!readBack) throw new Error('the built image does not read back as a JGX1 extension')

// The hook is one `bl`, so this decodes it out of the built image and checks where it
// actually lands, rather than trusting that the assembler was handed the right number.
const landed = ext.branchAt(plain, ext.IMAGE_BASE, layout.site.callAt)
if (!landed || landed.kind !== 'bl' || landed.target !== (readBack.entry & ~1)) {
  throw new Error(
    `the hook at ${hx(layout.site.callAt)} is ${landed ? `a ${landed.kind} to ` +
      hx(landed.target) : 'not a branch at all'}, and the extension entry the header ` +
      `declares is ${hx(readBack.entry)}`,
  )
}

console.log(`\nheader reads back: JGX1 v${readBack.version}, entry ${hx(readBack.entry)},`)
console.log(`  ${readBack.size} B, sub-commands ${readBack.subcommands.map(hx).join(', ')}`)
console.log(`  hook at ${hx(layout.site.callAt)} is a bl to ${hx(landed.target)}`)

const baseFile = donorPaths.length
  ? ota.encode(basePlain, { appVer: 3, devVer: 10, proVer: 10, type: ota.OTA_APP })
  : new Uint8Array(await Bun.file(STOCK).arrayBuffer())
const verdict = ota.check(container, { stock: baseFile, expectVersion, reference })
console.log()
console.log(ota.report(verdict))

// The OTA route is barred: `CLAUDE.md`, "Don't", and the commit that bricked unit 1.
// SWD is the delivery route now, and `swdflash` is the only tool that takes this file
// anywhere. It wants a dump of the unit being written, which is also what turns on the
// one check that would have stopped 2026-08-08.
console.log('\nBefore this goes near a device, in order:')
if (!donorPaths.length) {
  console.log('  0. DO NOT FLASH THIS ONE. Rebuild it with --from-donor first.')
}
console.log('  1. dump the target unit twice from cold: ./research/tools/swd-recon.sh dump')
console.log(`  2. bun research/tools/swdflash.ts plan ${out} --from <that dump>`)
console.log('     which runs ota.check against the unit, not just against the image')
console.log('  3. read notes/swd-flashing.md, then emit and simulate the script')
// The firmware appends 6 hex characters of the MAC to the prefix, so the name to look
// for is the prefix plus the same suffix the unit advertised as stock. With
// --stock-name that prefix is still the vendor's, and saying otherwise here would make
// a unit that came back correctly look like a failed flash.
const advert = flag('stock-name') ? VENDOR_NAME : name
console.log(`  4. probe it: the unit should advertise as ${advert}<MAC6> and answer HELLO`)

process.exit(verdict.safe ? 0 : 1)
