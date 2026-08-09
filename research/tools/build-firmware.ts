#!/usr/bin/env bun
/**
 * Build our firmware: stock, plus one dispatcher hook, plus the `JGX1` extension.
 *
 *   bun research/tools/build-firmware.ts [out.bin] [flags]
 *
 *     --stock-key      leave the vendor AES key in place
 *     --stock-name     leave the advert name as GLASSES-
 *     --name <prefix>  advert name, exactly 8 bytes (default JOGGLES-)
 *     --key <32 hex>   crew group key, instead of firmware/crew-key.json
 *     --version <n>    extension version reported by HELLO (default 1)
 *
 * This writes a file. It touches no Bluetooth, so running it is always safe, and
 * `ota.check` gates the result before it is written at all.
 *
 * ## What v1 changes, and what it deliberately does not
 *
 * Three in-place edits and one append. Nothing is relinked, no protected region is
 * touched, and the OTA service that provides the way back is untouched, so an
 * aborted transfer costs nothing and stock can be re-flashed at any time.
 *
 *  1. `abs 0x182a6`, 28 bytes: the `LOOP` dispatcher arm becomes a compare against
 *     `J` and a call into free flash. Costs `LOOP`, still reachable as `ANIM 19`.
 *  2. `abs 0x22b94`, exactly 16 bytes: the AES key becomes the crew group key. This
 *     both locks out the vendor app and *is* the crew credential.
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

const STOCK = 'firmware/TR1906R04-10_OTA.bin'
const KEY_FILE = 'firmware/crew-key.json'
const DEFAULT_OUT = 'firmware/joggles-v1.bin'

const hx = (n: number) => '0x' + (n >>> 0).toString(16)
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)))
const hexKey = (k: Uint8Array) =>
  [...k].map((b) => b.toString(16).padStart(2, '0')).join('')

// --- Stock bytes every edit asserts against ---------------------------------------

/** The `LOOP` arm. `expect` fails the build if this is not what is there. */
const STOCK_LOOP = bytes(
  '4c 2a 0b d1 e0 78 4f 28 08 d1 20 79 4f 28 05 d1 60 79 50 28 02 d1 18 20 09 f0 87 fd',
)

/** `b 0x182aa` in the LIGHT arm. The hook's layout exists because of this branch. */
const LIGHT_BACK_BRANCH = { abs: 0x184a6, bytes: bytes('00 e7') }

const VENDOR_KEY = bytes('34 52 2a 5b 7a 6e 49 2c 08 09 0a 9d 8d 2a 23 f8')
const AES_KEY_ADDR = 0x22b94
const NAME_ADDR = 0x2691c
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

const TAKES_VALUE = new Set(['name', 'key', 'version'])
const flags = new Set<string>()
const values = new Map<string, string>()
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
  values.set(name, Bun.argv[i + 3] ?? '')
  i++ //   skip the value, so it is never mistaken for the output path
}

const unknown = [...flags].filter(
  (f) => !['stock-key', 'stock-name'].includes(f) && !TAKES_VALUE.has(f),
)
if (unknown.length) {
  console.error(`unknown flag(s): ${unknown.map((f) => `--${f}`).join(', ')}`)
  process.exit(2)
}

const flag = (name: string) => flags.has(name)
const out = positional[0] ?? DEFAULT_OUT
const version = Number(values.get('version') ?? 1)
const name = values.get('name') ?? 'JOGGLES-'

if (!existsSync(STOCK)) {
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

// --- Build ------------------------------------------------------------------------

const extension = buildExtension({ version })
const hook = buildHook(extension.entry)

console.log(`extension v${version}: ${extension.code.length} B at ${hx(extension.base)}`)
console.log(`  entry ${hx(extension.entry)}, capabilities ${hx(extension.capabilities)}`)
console.log(`  opcode '${ext.OPCODE}', sub-commands: HELLO(${hx(ext.SUB.HELLO)})`)
const left = ext.STAGING_BANK - extension.base - extension.code.length
console.log(`  free flash left: ${left} B`)
console.log()

const assertions: Assertion[] = [
  {
    abs: LIGHT_BACK_BRANCH.abs,
    expect: LIGHT_BACK_BRANCH.bytes,
    note: `the LIGHT arm's b ${hx(ext.LIGHT_FALLBACK)}, which the hook layout answers`,
  },
]

const edits: Edit[] = [
  {
    abs: ext.HOOK_ADDR,
    expect: STOCK_LOOP,
    to: hook,
    note: `LOOP arm -> '${ext.OPCODE}' trampoline into ${hx(extension.entry)}`,
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
  const key = given ? bytes(given.replace(/(..)/g, '$1 ')) : await crewKey()
  edits.push({
    abs: AES_KEY_ADDR,
    expect: VENDOR_KEY,
    to: key,
    // patch.ts refuses a 17th byte here. The AES S-box starts at abs 0x22ba4 and a
    // one-byte overrun corrupts the cipher in both directions, uncaught by ota.check.
    note: 'AES key -> crew group key (exactly 16 bytes; S-box follows)',
  })
}

if (!flag('stock-name')) {
  edits.push({
    abs: NAME_ADDR,
    expect: ascii(VENDOR_NAME),
    to: ascii(name),
    note: `advert name ${VENDOR_NAME} -> ${name}`,
  })
}

const appends: Append[] = [
  { abs: extension.base, data: extension.code, note: `JGX1 extension v${version}` },
]

const container = await build({ out, edits, appends, assertions, stock: STOCK })

// --- Report -----------------------------------------------------------------------

const plain = ota.plaintext(container)
const readBack = readExtension(plain)
if (!readBack) throw new Error('the built image does not read back as a JGX1 extension')

const hookLiteral = new DataView(plain.buffer, plain.byteOffset).getUint32(
  0x182b4 - 0x16800,
  true,
)
if (hookLiteral !== readBack.entry) {
  throw new Error(
    `hook targets ${hx(hookLiteral)} but the extension entry is ${hx(readBack.entry)}`,
  )
}

console.log(`\nheader reads back: JGX1 v${readBack.version}, entry ${hx(readBack.entry)},`)
console.log(`  ${readBack.size} B, sub-commands ${readBack.subcommands.map(hx).join(', ')}`)
console.log(`  hook literal at 0x182b4 matches the entry`)

const stockFile = new Uint8Array(await Bun.file(STOCK).arrayBuffer())
const verdict = ota.check(container, { stock: stockFile })
console.log()
console.log(ota.report(verdict))

console.log('\nBefore this goes near a device, in order:')
console.log('  1. prove staging: ctrl 02, stream a few KB, disconnect without ctrl 03')
console.log('  2. re-flash stock over stock, to exercise the whole path with no new code')
console.log('  3. only then flash this, on a charged battery')
// The firmware appends 6 hex characters of the MAC to the prefix, so the name to look
// for is the prefix plus the same suffix the unit advertised as stock. With
// --stock-name that prefix is still the vendor's, and saying otherwise here would make
// a unit that came back correctly look like a failed flash.
const advert = flag('stock-name') ? VENDOR_NAME : name
console.log(`  4. probe it: the unit should advertise as ${advert}<MAC6> and answer HELLO`)

process.exit(verdict.safe ? 0 : 1)
