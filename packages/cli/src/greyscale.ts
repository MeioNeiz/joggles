#!/usr/bin/env bun
/** Show all four brightness levels at once, as vertical bands. */
import { Grid, display, protocol as p } from '@joggles/core'
import { open, sleep } from './glasses.js'

const g = new Grid()
// Three LIT levels across the full width, separated by one dark column each,
// so all three are directly comparable rather than one band being darkness.
for (let c = 0; c < display.COLS; c++) {
  const band = Math.floor(c / 8) // 0,1,2 across 24 columns
  const level = band + 1 // dim, mid, bright
  const separator = c % 8 === 7
  for (let r = 2; r <= 7; r++) g.set(r, c, separator ? 0 : level)
}
console.log('levels 1,2,3 as eight-column bands, left to right:\n')
console.log(g.render())

const glasses = await open({ pacing: 8 })
console.log(`\nconnected to ${glasses.name}`)
await glasses.begin()
await glasses.show(g, true)
console.log('holding 20s - are the three bands distinct, or do any match?')
await sleep(20000)
await glasses.end('keep')
process.exit(0)
