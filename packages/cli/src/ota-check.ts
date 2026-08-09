#!/usr/bin/env bun
/**
 * Pre-flight gate. Run this on any image before it goes near the device.
 *
 *   bun packages/cli/src/ota-check.ts <image.bin> [stock.bin]
 *
 * Touches no Bluetooth and writes nothing, so it is always safe to run. Exits 1 on
 * a fatal finding so it can gate a script.
 *
 * The second argument is the stock image to diff against, which turns on the patch
 * checks. Those are the ones that stop us editing away our own way back, so supply
 * it whenever the image is a patched stock build. It defaults to the matching stock
 * file in firmware/ when that is present.
 */
import { existsSync } from 'node:fs'
import { ota } from '@joggles/core/src/firmware.js'

const DEFAULT_STOCK = 'firmware/TR1906R04-10_OTA.bin'

const [imagePath, stockArg] = Bun.argv.slice(2)
if (!imagePath) {
  console.error('usage: ota-check.ts <image.bin> [stock.bin]')
  process.exit(2)
}

const file = new Uint8Array(await Bun.file(imagePath).arrayBuffer())

const stockPath = stockArg ?? (existsSync(DEFAULT_STOCK) ? DEFAULT_STOCK : undefined)
const sameFile = stockPath !== undefined && Bun.pathToFileURL(stockPath).href === Bun.pathToFileURL(imagePath).href
const stock =
  stockPath && !sameFile ? new Uint8Array(await Bun.file(stockPath).arrayBuffer()) : undefined

console.log(`image: ${imagePath}`)
console.log(stock ? `stock: ${stockPath}` : 'stock: none supplied, patch checks skipped')
console.log()
const verdict = ota.check(file, { stock })
console.log(ota.report(verdict))

if (verdict.safe) {
  console.log()
  console.log('Reminders that no static check can enforce:')
  console.log('  - send OTA type 1 only, and never control opcode 02 with type 2')
  console.log('  - nothing is committed until control opcode 03 with a matching CRC')
  console.log('  - do not run this on a flat battery: the reboot copy has no protection')
}

process.exit(verdict.safe ? 0 : 1)
