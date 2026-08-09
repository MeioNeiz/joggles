import { Grid, display, font, protocol as p } from '@joggles/core'
import { open, sleep } from './glasses.js'

// Earlier tests sent MODE while still in DIY, which switches to the SAVED image
// and discards the live buffer. Correct order is: draw, save, then set mode.
const TEXT = 'JOM'
const g = await open({ pacing: 8 })
console.log(`connected to ${g.name}`)

await g.command(p.enterDIY())
await g.command(p.leds(true))

const bmp = font.textBitmap(TEXT)
const w = font.textWidth(TEXT)
const grid = new Grid()
for (let r = 0; r < font.HEIGHT; r++)
  for (let c = 0; c < w && c < display.COLS; c++)
    if (bmp[r][c]) grid.set(font.BASELINE + r, c + 2)
console.log(`"${TEXT}" is ${w} cols (panel ${display.COLS})`)
console.log(grid.render())

console.log('\n=== PHASE 1: drawn in DIY, 8s. Should read JOM')
await g.show(grid, true)
await sleep(8000)

console.log('\n=== PHASE 2: SMVEW 02 (exit DIY and SAVE), 8s')
console.log('    Does JOM survive the save, or does WOWo come back?')
await g.command(p.exitDIYSave())
await sleep(8000)

console.log('\n=== PHASE 3: MODE 03 (vertical bounce) on the SAVED image, 15s')
console.log('    Is the moving text now JOM instead of WOWo?')
await g.command(p.mode(3, 1))
await sleep(15000)

await g.end('keep')
console.log('done')
process.exit(0)
