#!/usr/bin/env bun
/**
 * Is the visible wipe a display limit or just our transmission rate?
 *
 * Fill the panel at three pacings. Time-to-fill is 24 * pacing, so if the wipe
 * is transmission-bound it should shrink proportionally and vanish at the low
 * end. If it looks identical at every speed, something else causes it.
 */
import { type Glasses, display, protocol as p } from '@joggles/core'
import { open, sleep } from './glasses.js'

const fillAt = async (g: Glasses, value: number) => {
  for (let c = 0; c < display.COLS; c++) {
    let bits = 0
    for (let r = 2; r <= 7; r++) bits |= value << (2 * r)
    await g.commandRaw(p.column(c, new Uint8Array([(bits >> 16) & 0xff, (bits >> 8) & 0xff, bits & 0xff])))
  }
}

for (const pacing of [18, 6, 2]) {
  const g = await open({ pacing })
  await g.command(p.enterDIY())
  await g.command(p.leds(true))
  console.log(`=== pacing ${pacing}ms -> ~${24 * pacing}ms to fill. 5 on/off cycles`)
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now()
    await fillAt(g, 3)
    const took = performance.now() - t0
    await sleep(700)
    await fillAt(g, 0)
    await sleep(400)
    if (i === 0) console.log(`    measured fill: ${took.toFixed(0)}ms`)
  }
  await g.end('keep')
  await sleep(1200)
}
console.log('\ndoes the wipe get shorter as pacing drops?')
process.exit(0)
