#!/usr/bin/env bun
/**
 * Build a slot: the bytes `UPD_DATA` carries, for one set of features.
 *
 *   bun research/tools/features/build-slot.ts <feature>... [flags]
 *
 *     --from <image>   the image the slot will run on. A donor dump, or the APK
 *                      container, which is decoded automatically
 *     --slot a|b       which slot it is built for. **A body cannot be moved to the
 *                      other one**, and the resident dispatcher refuses one that has
 *                      been: ask the unit with `UPD_STATUS`, which names the slot the
 *                      next `UPD_BEGIN` writes
 *     --out <file>     write the body, so it can be sent
 *     --version <n>    slot version, reported in its own header
 *
 * This writes at most a file. It touches no Bluetooth and no device.
 *
 * ## Why the image and the slot are both arguments
 *
 * A slot is position-dependent twice over. Its code is assembled for one slot address,
 * because nothing in it is position-independent, and a feature's literals name addresses
 * in **one particular image**: the tick feature reads the vendor's own frequency and
 * hold immediates out of flash, and those move between builds. So a body built here is
 * good for one image in one slot, and both facts are stamped into its header: `entry`
 * carries the base it was assembled for, and the resident dispatcher compares it with
 * where the body actually is before it enters anything.
 */
import { existsSync } from 'node:fs'
import * as ota from '../../../packages/core/src/ota.js'
import * as jgx from '../../../packages/core/src/jgx.js'
import * as ext from '../ext.js'
import { SLOT_A, SLOT_B } from '../updater.js'
import { buildSlot, readSlot } from './index.js'
import { FEATURES, featureById } from './catalogue.js'

const hx = (n: number) => '0x' + (n >>> 0).toString(16)

const TAKES_VALUE = new Set(['from', 'slot', 'out', 'version'])
const values = new Map<string, string>()
const ids: string[] = []
for (let i = 2; i < Bun.argv.length; i++) {
  const arg = Bun.argv[i]
  if (!arg.startsWith('--')) {
    ids.push(arg)
    continue
  }
  const name = arg.slice(2)
  if (!TAKES_VALUE.has(name)) {
    console.error(`unknown flag --${name}`)
    process.exit(2)
  }
  values.set(name, Bun.argv[++i] ?? '')
}

if (!ids.length) {
  console.error('usage: build-slot.ts <feature>... --from <image> [--slot a|b] [--out f]')
  console.error(`features: ${FEATURES.map((f) => f.id).join(', ')}`)
  process.exit(2)
}
const features = ids.map((id) => {
  const f = featureById(id)
  if (!f) {
    console.error(`unknown feature '${id}'. There is: ${FEATURES.map((x) => x.id).join(', ')}`)
    process.exit(2)
  }
  return f
})

const from = values.get('from')
if (!from || !existsSync(from)) {
  console.error(`--from <image> is required and ${from ?? '(nothing)'} is not a file. ` +
    'A slot is built for one image: its literals name addresses in that image.')
  process.exit(2)
}
const raw = new Uint8Array(await Bun.file(from).arrayBuffer())
// A 256 KB dump is the whole part; anything else is an OTA container.
const image = raw.length === 0x40000
  ? raw.slice(ext.IMAGE_BASE, ext.STAGING_BANK)
  : ota.plaintext(raw)

const which = (values.get('slot') ?? 'a').toLowerCase()
if (which !== 'a' && which !== 'b') {
  console.error(`--slot must be a or b, not '${which}'`)
  process.exit(2)
}
const slotBase = which === 'a' ? SLOT_A : SLOT_B

const layout = ext.resolveLayout(image).layout
if (!layout) {
  console.error('REFUSED: this image\'s anchors do not resolve, so `notify` is unknown ' +
    'and a slot handler could not reply to anything. Run build-firmware for the detail.')
  process.exit(1)
}

const slot = buildSlot(features as never, {
  image,
  base: ext.IMAGE_BASE,
  slotBase,
  notify: layout.notify,
  arg: ext.ARG,
  version: Number(values.get('version') ?? 1),
})
for (const n of slot.notes) {
  console.error(`${n.severity === 'fatal' ? 'FATAL' : 'warn '}  ${n.message}`)
}
if (slot.notes.some((n) => n.severity === 'fatal')) {
  console.error('\nREFUSED: nothing was built.')
  process.exit(1)
}

const head = readSlot(slot.body)!
console.log(`slot ${which.toUpperCase()} at ${hx(slotBase)}, body at ${hx(slot.bodyBase)}`)
console.log(`  features   ${slot.features.join(', ')}`)
console.log(`  sub-commands ${slot.subcommands.map(hx).join(', ')}`)
console.log(`  capabilities ${hx(slot.capabilities)} ` +
  `(${jgx.capabilityNames(slot.capabilities).join(', ')})`)
console.log(`  ${slot.bytes} bytes, ${slot.headroom} left in the slot, ` +
  `${slot.frames} UPD_DATA frames`)
console.log(`  crc32 ${hx(slot.crc)}, assembled for ${hx(head.assembledFor)}`)

const out = values.get('out')
if (out) {
  await Bun.write(out, slot.body)
  console.log(`\nwrote ${out}`)
}
console.log('\nBefore this goes near a unit:')
console.log('  1. UPD_STATUS, and read the slot the NEXT write goes to. Build for that')
console.log('     slot, not for the live one: a body built for the other base has a')
console.log('     valid CRC and a valid magic, and the dispatcher refuses to enter it')
console.log('  2. the image on the unit has to be the image named by --from. A feature\'s')
console.log('     literals are that image\'s addresses')
console.log('  3. nothing here has run on silicon, and no unit carries our extension yet')
