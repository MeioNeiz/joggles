#!/usr/bin/env bun
/**
 * Upload our OWN rendered bitmap via DATS, then let the device animate it.
 *
 * The point: the renderer is entirely ours - our font, our layout, any width -
 * and the device stores and scrolls the result with nothing connected.
 */
import { font, protocol as p } from '@joggles/core'
import { open, sleep } from './glasses.js'

const text = process.argv.slice(2).join(' ') || 'JOGGLES'

// Our own renderer. Row 0 is the bottom, and DATS addresses the panel's 9 rows,
// so the glyphs are placed at the baseline rather than sitting at row 0.
const bitmap = font.panelBitmap(text)

console.log(`"${text}" -> ${bitmap[0].length} columns (panel is 24)\n`)
for (let r = bitmap.length - 1; r >= 0; r--) {
  console.log('  ' + bitmap[r].map((v) => (v ? '#' : '.')).join(''))
}

const g = await open({ pacing: 8 })
console.log(`\nconnected to ${g.name}`)

console.log('uploading via DATS...')
const { status, reply, saves } = await g.save(bitmap)
console.log(`device replied: ${reply} (${status}, ${saves} saves to this unit)`)

if (reply === 'DATCPOK') {
  console.log('\nsetting MODE 01 (static) then MODE 02 (horizontal scroll)')
  await g.command(p.mode(1))
  await g.command(p.speed(50))
  await sleep(5000)
  await g.command(p.mode(2, 0))
  console.log('scrolling - disconnecting in 10s, it should KEEP GOING')
  await sleep(10000)
}

await g.end('keep')
console.log('disconnected')
process.exit(0)
