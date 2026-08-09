import { Grid, display, font, protocol as p } from '@joggles/core'
import { open, sleep } from './glasses.js'

// Does the device hold a bitmap wider than the 24-column panel? If it does,
// scrolling is the firmware's job and we upload once instead of streaming.
const TEXT = 'JOGGLES ROCKS'
const bmp = font.textBitmap(TEXT)
const width = font.textWidth(TEXT)
console.log(`"${TEXT}" is ${width} columns wide, panel is ${display.COLS}\n`)

const g = await open({ pacing: 8 })
console.log(`connected to ${g.name}`)
await g.begin()

// Write every column of the full-width bitmap, including indices past 23.
console.log(`uploading ${width} columns (indices 0..${width - 1})...`)
for (let c = 0; c < width; c++) {
  let bits = 0
  for (let r = 0; r < font.HEIGHT; r++) {
    if (bmp[r][c]) bits |= 1 << (display.STRIDE * (font.BASELINE + r))
  }
  const word = new Uint8Array([(bits >> 16) & 0xff, (bits >> 8) & 0xff, bits & 0xff])
  await g.commandRaw(p.column(c, word))
}
console.log('upload done\n')

console.log('=== TEST 1: asking the DEVICE to animate it (MODE 03, vertical) - 20s')
console.log('    Does the full message move by itself?')
await g.command(p.mode(3, 1))
await sleep(20000)

console.log('\n=== TEST 2: saving with SMVEW 02, then DISCONNECTING - 20s')
console.log('    Does it keep running with no phone/laptop attached?')
await g.command(p.exitDIYSave())
await g.end('restore')
console.log('    disconnected. watch the glasses.')
await sleep(20000)
console.log('\ndone')

process.exit(0)
