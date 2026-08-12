#!/usr/bin/env bun
/**
 * The hardware sitting: one connection per look, for the items only eyes can settle.
 *
 * Track 11. Every subcommand here ends in a human saying what the panel did, so each
 * one prints WHAT TO LOOK FOR before it sends anything and then holds the panel long
 * enough to be looked at. They are separate invocations on purpose: a script that
 * walked the whole list would reach step 5 with nobody having read step 2.
 *
 * **Run them in the order below, because the order is load-bearing.** The flash store
 * holds content saved earlier that cannot be recovered once overwritten, and the one
 * observation that separates "the device's 24 blank columns are unconditional" from
 * "they only follow a restore from flash" needs that content restored by a power
 * cycle and watched BEFORE anything saves over it (`research/loop-gap-2026-08-10.md`,
 * and track 16's half of this sitting).
 *
 *   0  power cycle by hand, watch what it comes up as        no BLE at all
 *   1  verify.ts scroll 0        item 3 dir 0, track 16 look 1       no flash
 *   2  verify.ts scroll 1        item 3 dir 1                        no flash
 *   3  verify.ts column0        item 2, which lens column 0 is on    no flash
 *   4  verify.ts clrl           item 6, CLRL alone on a lit panel    no flash
 *   5  verify.ts pacing <ms>    item 7, how low live pacing goes     no flash
 *   6  verify.ts anim 0        which ANIM base is real (track 20)   no flash
 *   7  verify.ts rows --yes     items 1 and 5, track 16 look 2   ONE save, 5 erases
 *
 * Steps 1 to 6 write no flash: `SPEED`, `MODE`, `SMVEW`, `CLRL` and live column
 * writes all stay in RAM. Step 6 is the only cost of the whole sitting and it is
 * deliberately last, because it replaces the flash store.
 *
 * The item list is `notes/app-plan.md`, "Verify before building". Findings go to
 * `research/vendor-app-protocol.md` with a confidence marker.
 */
import { Grid, dats, display, protocol as p } from '@joggles/core'
import { open, sleep } from './glasses.js'

const args = Bun.argv.slice(2)
const cmd = args.find((a) => !a.startsWith('--')) ?? 'help'
const confirmed = args.includes('--yes')
const numeric = args.filter((a) => /^\d+$/.test(a) && a !== cmd).map(Number)

/** How long a look gets before the script lets go. Long enough to fetch someone. */
const LOOK_MS = 30000

function look(...lines: string[]): void {
  console.log('\n=== WHAT TO LOOK FOR ' + '='.repeat(52))
  for (const l of lines) console.log('  ' + l)
  console.log('='.repeat(73) + '\n')
}

/**
 * Content for step 6: 10 columns, and the ONLY thing set is row 8.
 *
 * Two items in one save, because a save is five page erases and the sitting should
 * spend as few as it can. Item 1 asks whether DATS bit 7 reaches row 8, and the
 * answer is legible as a single horizontal line: our model says row 0 is the bottom,
 * so a row-8 line belongs at the TOP. Item 5 asks whether `MODE 02` scrolls content
 * narrower than the panel at all, which the same 10 columns answer once they move.
 *
 * The dead LEDs make the reading self-checking. The top row is dead in its middle
 * six and the bottom row is dead in the same six (`display.DEAD`), so a line drawn
 * at the top must appear BROKEN as it crosses the middle of the panel, and a line
 * that is unbroken all the way across is not on either of those rows. That is a
 * second, independent signal that the mapping is what `dats.ts` claims, and it costs
 * nothing to read.
 *
 * No nonce, unlike `loopgap.ts`. A nonce would have to sit in a dead pixel to stay
 * invisible, only one such column exists inside 10, and a stray lit dot anywhere
 * else is exactly the ambiguity this test cannot afford. The duplicate-payload guard
 * is handled by reading `status` instead: a skipped save sends nothing, which reads
 * as "the panel ignored it", and that trap has bitten here before.
 */
function rowEightLine(): number[][] {
  const bmp = Array.from({ length: dats.DATS_ROWS }, () => new Array(10).fill(0))
  bmp[8] = new Array(10).fill(1)
  return bmp
}

if (cmd === 'scroll') {
  const dir = numeric[0] ?? 0
  const speed = numeric[1] ?? 40
  if (dir !== 0 && dir !== 1) {
    console.error('usage: verify.ts scroll <0|1> [speed]')
    process.exit(1)
  }
  console.log(`MODE 02 ${String(dir).padStart(2, '0')} at SPEED ${speed}. No flash written.`)
  console.log('Scrolls whatever is ALREADY in the type 1 store; uploads nothing.')
  look(
    `Direction: which way does it travel, and is dir ${dir} left or right?`,
    'Does the content read correctly, or is it mirrored or upside down?',
    'THE GAP between repeats: does the panel go COMPLETELY dark between passes?',
    '  "empty for a beat, about a screen wide" = the device added ~24 blank columns',
    '  "never fully empty" = it did not, and the preview is now wrong to show a gap',
    'A blank run of 24 in a 24-wide window is fully dark for one column step only,',
    'so "properly empty but briefly" and "empty for a beat" are different answers.',
  )
  const g = await open()
  console.log(`connected to ${g.name}`)
  await g.command(p.speed(speed))
  await g.command(p.mode(2, dir))
  console.log(`SPEED ${speed} then MODE 02 ${dir} sent. Holding ${LOOK_MS / 1000}s.`)
  await sleep(LOOK_MS)
  await g.end('keep')
  console.log('disconnected, and it keeps scrolling unattended from here')
} else if (cmd === 'column0') {
  console.log('DIY live buffer, column 0 lit full height. No flash written.')
  look(
    'WHICH LENS does the lit column appear on: left, right, or neither?',
    'This decides whether the draw canvas is ONE 24-wide surface across both eyes',
    'or TWO mirrored 12-wide ones, so it is a UI decision, not a detail.',
    'Is it a single column, and is it the OUTERMOST column of that lens?',
    'Say which lens as YOU wear them, and say if you are looking at them head-on',
    'instead, because that swaps left and right.',
  )
  const g = await open()
  console.log(`connected to ${g.name}`)
  await g.begin()
  const live = g.live()
  const grid = new Grid()
  for (let row = 0; row < display.ROWS; row++) grid.set(row, 0, true)
  live.set(grid)
  await live.idle()
  console.log(`column 0 lit, rows 0-${display.ROWS - 1}. Holding ${LOOK_MS / 1000}s.`)
  await sleep(LOOK_MS)
  await live.stop()
  await g.end('keep')
  console.log("disconnected with end('keep'), so what you saw should still be lit")
} else if (cmd === 'clrl') {
  console.log('DIY, draw a pattern, hold, then CLRL ALONE on the lit panel. No flash.')
  look(
    'FIRST you should see a lit pattern: three separated vertical bars.',
    'Then, 15s later, CLRL goes out by itself and NOTHING else follows it.',
    'Does the panel go completely dark, and does it do it all at once?',
    'If it stays lit, CLRL is a no-op: the draw screen s clear button does nothing',
    'and the sender believes all 24 columns are blank when they are not.',
    'If it clears one column at a time, it is not the atomic write we think it is.',
  )
  const g = await open()
  console.log(`connected to ${g.name}`)
  await g.begin()
  const live = g.live()
  const grid = new Grid()
  for (const col of [2, 11, 20]) {
    for (let row = 0; row < display.ROWS; row++) grid.set(row, col, true)
  }
  live.set(grid)
  await live.idle()
  console.log('pattern drawn: bars at columns 2, 11 and 20. Look now, 15s.')
  await sleep(15000)
  console.log('sending CLRL alone...')
  live.clear()
  await live.idle()
  console.log(`CLRL sent, nothing after it. Holding ${LOOK_MS / 1000}s.`)
  await sleep(LOOK_MS)
  await live.stop()
  await g.end('keep')
  console.log('disconnected')
} else if (cmd === 'pacing') {
  const ms = numeric[0]
  if (!Number.isFinite(ms) || ms < 1 || ms > 200) {
    console.error('usage: verify.ts pacing <1-200>   ms between column writes')
    process.exit(1)
  }
  console.log(`DIY, alternate columns lit, ${ms}ms between writes. No flash written.`)
  look(
    'Count the lit columns. There should be exactly 12, every other one, with the',
    'ODD columns dark. Read the END STATE, not the sweep: it is meant to look like',
    'a wipe on the way in.',
    'MISSING lit columns mean writes were dropped at this pacing, so it is too low.',
    'All 12 present means this pacing survives, and the next run can go lower.',
    'Report the COUNT and WHICH ones are missing; a pattern in the gaps matters.',
  )
  const g = await open({ pacing: ms })
  console.log(`connected to ${g.name} with pacing ${ms}ms`)
  await g.begin()
  const live = g.live({ pacing: ms })
  const grid = new Grid()
  for (let col = 0; col < display.COLS; col += 2) {
    for (let row = 0; row < display.ROWS; row++) grid.set(row, col, true)
  }
  live.set(grid)
  await live.idle()
  console.log(`12 columns written at ${ms}ms. Holding ${LOOK_MS / 1000}s.`)
  await sleep(LOOK_MS)
  await live.stop()
  await g.end('keep')
  console.log('disconnected')
} else if (cmd === 'anim') {
  const n = numeric[0] ?? 0
  if (n < 0 || n > 29) {
    console.error('usage: verify.ts anim <0-29>')
    process.exit(1)
  }
  console.log(`ANIM ${n}, a read-only built-in bank. No flash written.`)
  console.log('Track 20 found two readings of the ANIM base that cannot both be right:')
  console.log('  firmware decode   ANIM n selects mode n + 5')
  console.log('  the vendor app    sends ANIM 20-29 for its ten animations')
  console.log('Under the firmware reading the vendor range is modes 25-34, which are the')
  console.log('image mode, the type 2 mode, six oddments and two values set_mode refuses.')
  look(
    `Does ANIM ${n} play an animation at all, or does the panel sit still or blank?`,
    'DESCRIBE WHAT IT SHOWS in a few words, then compare it against',
    `  bun run research/tools/bankdump.ts show anim-${n}`,
    'If it matches that thumbnail, the firmware decode is right and the vendor app',
    'is using a different convention. If it plays something else, or nothing, the',
    'n + 5 reading is wrong and builtins.ts commandFor is the one line to change.',
    'This decides whether every built-in in the new Library screen is mislabelled.',
  )
  const g = await open()
  console.log(`connected to ${g.name}`)
  await g.command(p.animation(n))
  console.log(`ANIM ${n} sent. Holding ${LOOK_MS / 1000}s.`)
  await sleep(LOOK_MS)
  await g.end('keep')
  console.log('disconnected, and the built-in keeps playing unattended')
} else if (cmd === 'rows') {
  const bmp = rowEightLine()
  console.log('ONE type 1 save: 10 columns, row 8 only. FIVE PAGE ERASES, and it')
  console.log('REPLACES whatever is in the flash store. Run this LAST.\n')
  for (let r = bmp.length - 1; r >= 0; r--) {
    console.log(`  row ${r} ` + bmp[r].map((v) => (v ? '#' : '.')).join(''))
  }
  if (!confirmed) {
    console.error('\nRefusing without --yes.')
    process.exit(1)
  }
  look(
    'Is the line at the TOP of the panel or the BOTTOM?',
    '  TOP    = DATS bit 7 reaches row 8 and dats.ts is right, mapping settled',
    '  BOTTOM = the mapping is inverted and every renderer targets the wrong row',
    'Is the line BROKEN in the middle? The top and bottom rows are both dead in',
    'their middle six columns, so a line on either must show a gap there. An',
    'unbroken line all the way across means it is on neither row.',
    'Does it appear at all, and is it 10 columns wide rather than 24?',
  )
  const g = await open()
  console.log(`connected to ${g.name}`)
  const { status, reply, saves } = await g.save(bmp, {
    type: dats.TYPE_TEXT,
    blockSleep: 12,
    confirm: true,
  })
  console.log(`save: ${status}, ${reply}, ${saves} lifetime saves`)
  if (status === 'skipped') {
    await g.end('keep')
    console.error('SKIPPED as a duplicate payload: nothing was sent, so the panel')
    console.error('proves nothing. It already held this exact content.')
    process.exit(1)
  }
  if (status !== 'saved' || reply !== 'DATCPOK') {
    await g.end('keep')
    console.error('Nothing committed, so the panel proves nothing. Stop here.')
    process.exit(1)
  }
  await g.command(p.mode(1))
  console.log(`MODE 01 sent, static. Holding ${LOOK_MS / 1000}s.`)
  await sleep(LOOK_MS)
  await g.end('keep')
  console.log('\ndisconnected. Static and left in the flash store.')
  console.log('NEXT: verify.ts scroll 0  answers item 5 and track 16 look 2 for free,')
  console.log('because these 10 columns are now what scrolls, and no save is needed.')
} else {
  console.log(`usage: verify.ts <step>   run them in this order

  scroll <0|1> [speed]   item 3, and track 16 look 1 on a restored store   no flash
  column0                item 2, which lens column 0 lands on             no flash
  clrl                   item 6, CLRL alone on a lit panel                 no flash
  pacing <ms>            item 7, how low live pacing goes                  no flash
  anim <0-29>            which ANIM base is real, track 20's contradiction  no flash
  rows --yes             items 1 and 5, and track 16 look 2      ONE save, 5 erases

Power-cycle the unit by hand first and watch what it comes up as. Only then
scroll: the restored-from-flash look cannot be taken again once anything saves.`)
  process.exit(1)
}
process.exit(0)
