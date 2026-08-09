#!/usr/bin/env bun
/**
 * Are there really 4 levels, or just on/off?
 *
 * Side-by-side bands read as uniform, but a whole-panel switch was noticed.
 * So test temporally: fill everything at one level, hold, step to the next.
 */
import { display, protocol as p } from '@joggles/core'
import { open, sleep } from './glasses.js'

const g = await open({ pacing: 8 })
console.log(`connected to ${g.name}`)
await g.command(p.enterDIY())
await g.command(p.leds(true))

const fill = async (value: number) => {
  for (let c = 0; c < display.COLS; c++) {
    let bits = 0
    for (let r = 2; r <= 7; r++) bits |= value << (2 * r)
    await g.commandRaw(p.column(c, new Uint8Array([(bits >> 16) & 0xff, (bits >> 8) & 0xff, bits & 0xff])))
  }
}

for (let pass = 0; pass < 2; pass++) {
  for (const level of [1, 2, 3]) {
    console.log(`=== LEVEL ${level} (0b${level.toString(2).padStart(2, '0')}) - 5s`)
    await fill(level)
    await sleep(5000)
  }
  console.log('=== OFF - 2s\n')
  await fill(0)
  await sleep(2000)
}

await g.end('keep')
console.log('done - how many distinct brightnesses did you count?')
process.exit(0)
