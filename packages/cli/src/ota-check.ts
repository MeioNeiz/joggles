#!/usr/bin/env bun
/**
 * Pre-flight gate. Run this on any image before it goes near the device.
 *
 *   bun run ota-check <image.bin> [--stock <file>] [--reference <dump>] [--for-commit]
 *
 * Touches no Bluetooth and writes nothing, so it is always safe to run. Exits 1 on
 * a fatal finding so it can gate a script.
 *
 * `--stock` turns on the patch checks, which are the ones that stop us editing away
 * our own way back. It needs a baseline that is **the same build** as the image, not
 * merely a stock file: different builds report `stock-base-mismatch` and no diff is
 * attempted.
 *
 * `--reference` is a raw SWD dump of the unit the image is destined for, and it turns
 * on the silicon checks: whether this image is the application that unit's BLE stack
 * actually expects. **That is the check 2026-08-08 did not have.** Before track 64
 * this CLI had no way to pass one, so the check existed and no command in the repo ran
 * it, which is why `firmware/joggles-v2.bin` could not be verified from a terminal at
 * all. Supply the donor dump for a donor-rebased image.
 *
 * `--for-commit` promotes "nobody asked the question" findings from warn to fatal. Use
 * it when the next step writes flash rather than when reading a file on a laptop.
 *
 * The old positional `[stock.bin]` second argument still works, because scripts and
 * docs use it, but it is not the documented form any more.
 */
import { existsSync } from 'node:fs'
import { ota } from '@joggles/core/src/firmware.js'

const DEFAULT_STOCK = 'firmware/TR1906R04-10_OTA.bin'

const usage =
  'usage: ota-check.ts <image.bin> [--stock <file>|--no-stock] [--reference <dump>]' +
  ' [--for-commit]'

const args = Bun.argv.slice(2)
const flags = { stock: '', reference: '', forCommit: false, noStock: false }
const positional: string[] = []

for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--for-commit') flags.forCommit = true
  else if (a === '--no-stock') flags.noStock = true
  else if (a === '--stock' || a === '--reference') {
    const v = args[++i]
    if (!v || v.startsWith('--')) {
      console.error(`${a} needs a file path`)
      process.exit(2)
    }
    flags[a === '--stock' ? 'stock' : 'reference'] = v
  } else if (a.startsWith('--')) {
    console.error(`unknown flag: ${a}\n${usage}`)
    process.exit(2)
  } else positional.push(a)
}

const [imagePath, legacyStock] = positional
if (!imagePath) {
  console.error(usage)
  process.exit(2)
}

const read = async (p: string): Promise<Uint8Array> => {
  if (!existsSync(p)) {
    console.error(`no such file: ${p}`)
    process.exit(2)
  }
  return new Uint8Array(await Bun.file(p).arrayBuffer())
}

const file = await read(imagePath)

// A baseline of a different build is worse than none: it produces a wall of findings
// that are all wrong, and track 64 recorded that burying a real edit that way is how
// someone learns to skip the gate. So the default is only used when it is there, and
// the report says which baseline was actually compared.
const stockPath = flags.noStock
  ? ''
  : flags.stock || legacyStock || (existsSync(DEFAULT_STOCK) ? DEFAULT_STOCK : '')
const same = (a: string, b: string) => Bun.pathToFileURL(a).href === Bun.pathToFileURL(b).href
const stock = stockPath && !same(stockPath, imagePath) ? await read(stockPath) : undefined
const reference = flags.reference ? await read(flags.reference) : undefined

let verdict = ota.check(file, { stock, reference, forCommit: flags.forCommit })

// An explicit --stock that is the wrong build is a fatal, because the caller asserted a
// baseline and the assertion is false. A DEFAULTED one is not: the default is the APK's
// TR1906R04-10, every donor-rebased image is -12, and letting an inference we made turn
// into a refusal means the honest image gets refused while nobody learns anything. That
// is the shape of the defect track 64 found in the gate itself, so do not reintroduce it
// here. Drop the guess, say so, and check the image on its own terms.
const defaulted = !flags.stock && !legacyStock
let stockLine = stock ? `stock: ${stockPath}` : 'stock: none supplied, patch checks skipped'
if (defaulted && verdict.findings.some((f) => f.code === 'stock-base-mismatch')) {
  stockLine =
    `stock: ${stockPath} ignored, it is a different build from this image.\n` +
    "       Pass --stock <the target unit's own application> for patch checks."
  verdict = ota.check(file, { reference, forCommit: flags.forCommit })
}

console.log(`image: ${imagePath}`)
console.log(stockLine)
console.log(
  reference
    ? `reference: ${flags.reference}`
    : 'reference: none supplied, the silicon checks cannot run',
)
if (flags.forCommit) console.log('mode: for-commit, unanswered questions are fatal')
console.log()
console.log(ota.report(verdict))

if (!reference) {
  console.log()
  console.log('No reference dump was supplied, so this run did NOT ask the question that')
  console.log('2026-08-08 got wrong: whether this image is the application the target')
  console.log('unit\'s BLE stack expects. Pass --reference <dump of the target>.')
}

if (verdict.safe) {
  console.log()
  console.log('Reminders that no static check can enforce:')
  console.log('  - send OTA type 1 only, and never control opcode 02 with type 2')
  console.log('  - nothing is committed until control opcode 03 with a matching CRC')
  console.log('  - do not run this on a flat battery: the reboot copy has no protection')
}

process.exit(verdict.safe ? 0 : 1)
