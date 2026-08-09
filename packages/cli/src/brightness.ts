#!/usr/bin/env bun
/**
 * Compare the two-bit pixel values. The vendor only ever writes 0b11; we wrote
 * 0b01 until now. If 0b11 is visibly brighter, the odd bit is a brightness bit
 * and we have been running the panel dim the whole time.
 */
import { display, protocol as p } from '@joggles/core'
import { open, sleep } from './glasses.js'

const g = await open({ pacing: 8 })
console.log(`connected to ${g.name}`)
await g.command(p.enterDIY())
await g.command(p.leds(true))

// Bypass Grid so we can choose the pixel value explicitly.
const fill = async (value: number) => {
  for (let c = 0; c < display.COLS; c++) {
    let bits = 0
    for (let r = 2; r <= 7; r++) bits |= value << (2 * r)
    const w = new Uint8Array([(bits >> 16) & 0xff, (bits >> 8) & 0xff, bits & 0xff])
    await g.commandRaw(p.column(c, w))
  }
}

for (let i = 0; i < 3; i++) {
  console.log('=== 0b01 (what we were writing) - 4s')
  await fill(0b01)
  await sleep(4000)
  console.log('=== 0b11 (what the vendor writes) - 4s')
  await fill(0b11)
  await sleep(4000)
}

await g.end('keep')
console.log('\ndone - was 0b11 noticeably brighter?')
process.exit(0)
