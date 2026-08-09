import { protocol as p } from '@joggles/core'
import { open, sleep } from './glasses.js'

// MODE's second byte is probably a content-slot index, not speed: SPEED has its
// own opcode. Cycle static mode across slots and see which one holds our JOM.
const g = await open({ pacing: 8 })
console.log(`connected to ${g.name}\n`)
console.log('Cycling MODE 01 <slot> - static display of each content slot.')
console.log('Call out which SLOT NUMBER shows JOM.\n')

for (let slot = 0; slot <= 7; slot++) {
  console.log(`=== SLOT ${slot}  (MODE 01 ${slot}) - 4s`)
  await g.command(p.frame('MODE', 1, slot))
  await sleep(4000)
}

console.log('\ndone - which slot was JOM?')
await g.end('keep')
process.exit(0)
