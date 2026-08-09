#!/usr/bin/env bun
/**
 * Which is the rightmost VISIBLE column?
 *
 * AnimData frames are all 24 columns, so the model says 0..23. If column 23 is
 * off screen the panel is physically narrower than the data format.
 * One full-height column at a time, so there is nothing to misread.
 */
import { Grid, display, protocol as p } from '@joggles/core'
import { open, sleep } from './glasses.js'

const g = await open({ pacing: 6 })
console.log(`connected to ${g.name}`)
await g.begin()

for (const col of [23, 22, 21, 0]) {
  console.log(`=== COLUMN ${col} alone, full height - 5s`)
  console.log(`    Do you see a vertical line? Where?`)
  const grid = new Grid()
  for (let r = 2; r <= 7; r++) grid.set(r, col)
  await g.show(grid, true)
  await sleep(5000)
}

console.log('\n=== both edges: columns 0 and 23 - 8s')
console.log('    Are BOTH visible, and equally far from their edges?')
const both = new Grid()
for (let r = 2; r <= 7; r++) { both.set(r, 0); both.set(r, 23) }
await g.show(both, true)
await sleep(8000)

await g.end('keep')
console.log('\ndone')
process.exit(0)
