#!/usr/bin/env bun
/**
 * Settle DATS type 2 on hardware. Run 2026-08-09 on `GLASSES-125B37`; every
 * prediction held, and this is now the regression rather than the experiment.
 *
 *   bun run packages/cli/src/type2.ts ceiling --yes    24 ok, 383 ok, 384 ERROR
 *   bun run packages/cli/src/type2.ts watch --yes      does it display, and when
 *   bun run packages/cli/src/type2.ts show --yes       upload, then power-cycle
 *   bun run packages/cli/src/type2.ts wide --yes       how much of 383 is visible
 *
 * **`ceiling` reads its answer off the wire; the other three read it off the panel,
 * by eye.** `wide` is the weakest of the set, because its answer is "the panel did
 * not change", which an inattentive minute produces just as readily. Anything
 * re-running it should put a distinct marker every 24 columns so a window other than
 * the head is identifiable rather than merely dark, and watch longer than two
 * minutes. `content.MAX_IMAGE_COLUMNS` is sized on that result.
 *
 * **What was being tested.** `DATCP` at `abs 0x182e0` answers `DATCPOK` only when a
 * running counter equals what `DATS` predicted. Type 2 counts columns, one 32-bit
 * word each, and wraps that counter at 384 (`abs 0x18634`), so column 384 resets it
 * to 0 and the comparison fails. The flash writer at `abs 0x218cc` has one call
 * site, on the *type 1* arm, so type 2 never persists. Both confirmed. Reasoning
 * and addresses: "`DATCP` is an exact-match gate" in
 * `research/firmware-internals.md`.
 *
 * 24 columns runs first as a positive control: it is the only type 2 width the
 * vendor app ever sends, so if that fails the fault is this script.
 *
 * **Two traps this script exists to not fall into again.** The wear budget skips a
 * payload identical to the last acknowledged one and a skipped save sends nothing,
 * which is indistinguishable from "the panel ignored it" - hence the dead-pixel
 * nonce and the status check on every call. And `MODE` after a type 2 upload
 * switches the panel to the type 1 flash store permanently, so `show` deliberately
 * sends none.
 */
import { content, dats, protocol } from '@joggles/core'
import { open, sleep } from './glasses.js'

const args = Bun.argv.slice(2)
const confirmed = args.includes('--yes')
const cmd = args.find((a) => !a.startsWith('--')) ?? 'ceiling'
const widths = args
  .filter((a) => !a.startsWith('--') && Number.isFinite(Number(a)))
  .map(Number)

/** Announced before every run, because nothing can read the count off the device. */
const ERASES_PER_SAVE = 5

/** Seconds of warning before the upload, so a watcher can get their eyes on the panel. */
const lead = Number(args.find((a) => a.startsWith('--lead='))?.slice(7) ?? 10)

/**
 * A ladder either side of the derived ceiling, with a vendor-width control first.
 *
 * 383 and 384 are the whole experiment: adjacent widths, opposite predictions.
 */
const LADDER = widths.length ? widths : [24, 383, 384]

/**
 * Levels 1, 2 and 3 in horizontal bands, and a moving marker per column.
 *
 * Greyscale on purpose: type 1 cannot carry it, so a panel showing three distinct
 * brightnesses is proof the image path ran rather than the text path. The marker
 * walks so that a wrapped or mis-framed buffer reads as a broken diagonal.
 */
function testCard(cols: number, nonce = 0): number[][] {
  const bmp = Array.from({ length: 9 }, () => new Array(cols).fill(0))
  for (let c = 0; c < cols; c++) {
    for (let r = 2; r < 7; r++) bmp[r][c] = 1 + ((r - 2) % 3)
    bmp[(c % 5) + 2][c] = 3
  }
  // Row 0 columns 9-14 have no LEDs behind them (`display.alive()`), so this
  // changes the payload bytes and cannot change the image. See `nonce` below.
  for (let i = 0; i < 6 && 9 + i < cols; i++) bmp[0][9 + i] = (nonce >> (2 * i)) & 0b11
  return bmp
}

/**
 * The budget skips a payload byte-identical to the last acknowledged one, which is
 * correct, and a skipped save sends nothing at all.
 *
 * A watched run that silently sent nothing looks exactly like "the card never
 * displayed", and that already wasted two runs here. So every payload carries a
 * nonce and every caller checks the save actually went out. The nonce goes in dead
 * pixels on purpose: varying anything visible would change the thing being watched.
 */
const nonce = () => Date.now() & 0xfff

async function cmdCeiling(): Promise<void> {
  console.log(`${LADDER.length} type 2 uploads: ${LADDER.join(', ')} columns.`)
  console.log(
    `Charged to the wear budget as ${LADDER.length * ERASES_PER_SAVE} erases, though ` +
      'type 2 is verified to write none. See SaveOpts.type.\n',
  )
  if (!confirmed) {
    console.error('Refusing without --yes.')
    process.exit(1)
  }

  console.log('cols   bytes   predicted   reply')
  console.log('-'.repeat(46))

  const results: Array<[number, string, string]> = []
  for (const [i, cols] of LADDER.entries()) {
    const glasses = await open()
    const predicted = cols <= content.IMAGE_ACCEPT_CEILING ? 'DATCPOK' : 'ERROR'
    const { status, reply } = await glasses.save(testCard(cols, nonce()), {
      type: dats.TYPE_IMAGE,
      blockSleep: 12,
      confirm: true,
    })
    await glasses.end('keep')
    if (status === 'skipped') {
      console.error(`${cols}: budget skipped it, so nothing was sent. Run aborted.`)
      process.exit(1)
    }
    results.push([cols, predicted, reply])
    const mark = reply === predicted ? '' : '   <- refutes the model'
    console.log(
      `${String(cols).padStart(4)}   ${String(cols * 3).padStart(5)}   ` +
        `${predicted.padEnd(9)}   ${reply}${mark}`,
    )
    // The budget's own minimum gap, waited out rather than overridden.
    if (i < LADDER.length - 1) await sleep(3200)
  }

  const agreed = results.every(([, predicted, reply]) => predicted === reply)
  console.log(
    agreed
      ? '\nEvery width matched the prediction. 383 is the ceiling.'
      : '\nA width disagreed. The disassembly reading is wrong; do not edit the docs' +
          '\nto match this run until the mismatch is understood.',
  )
}

async function cmdShow(): Promise<void> {
  console.log('Uploading the solid block as DATS type 2, then leaving it on the panel.')
  console.log('Charged as 5 erases. Prediction: none are actually spent.\n')
  if (!confirmed) {
    console.error('Refusing without --yes.')
    process.exit(1)
  }

  const glasses = await open()
  const { status, reply, saves } = await glasses.save(solidCard(), {
    type: dats.TYPE_IMAGE,
    blockSleep: 12,
    confirm: true,
  })
  // No MODE afterwards, deliberately: MODE 01/02 switch the panel to the type 1
  // flash store and there is no command that switches back, so sending one would
  // throw away the very thing this test needs left on screen.
  await glasses.end('keep')
  console.log(`reply ${reply}, ${saves} lifetime saves counted\n`)
  if (status !== 'saved' || reply !== 'DATCPOK') {
    console.error('Not stored, so the power-cycle test has nothing to prove. Stop here.')
    process.exit(1)
  }

  console.log('The panel should be a solid block now: bright left half, dim right half.')
  console.log('Confirm that first. If it is text, stop, because the test is already void.\n')
  console.log('Then power-cycle: hold the button ~2s until it goes dark, switch it back')
  console.log('on, and look again.\n')
  console.log('  text is back    ->  type 2 is RAM only, writes no flash, as derived')
  console.log('  block still up  ->  type 2 does write flash, and the budget was right')
}

/**
 * Is a type 2 buffer reachable for display at all?
 *
 * The first run of `show` returned `DATCPOK` and left the panel showing the type 1
 * saved text, so the card either never rendered or was rendered and replaced. This
 * separates the two, and then asks `MODE` for it, which is the only other command
 * that selects saved content.
 */
async function cmdWatch(): Promise<void> {
  console.log('Watch the panel for ~80 seconds. Looking for a SOLID FILLED PANEL:')
  console.log('every column lit, bright left half, dim right half. Not text, not bars.')
  console.log('Anything text-shaped is the old type 1 content and means "no".\n')
  console.log('  0s   nothing sent, panel unchanged')
  console.log(' 10s   type 2 upload')
  console.log(' 10-30s  phase A, nothing further sent')
  console.log(' 30-50s  phase B, MODE 01 00 sent at 30s')
  console.log(' 50-70s  phase C, MODE 02 00 sent at 50s\n')
  if (!confirmed) {
    console.error('Refusing without --yes.')
    process.exit(1)
  }
  const glasses = await open()

  for (let s = lead; s > 0; s--) {
    process.stdout.write(`\r  upload in ${s}s   `)
    await sleep(1000)
  }

  const { status, reply } = await glasses.save(solidCard(), {
    type: dats.TYPE_IMAGE,
    blockSleep: 12,
    confirm: true,
  })
  console.log(`\r  uploaded, DATCP -> ${reply}   `)
  if (status !== 'saved' || reply !== 'DATCPOK') {
    await glasses.end('keep')
    console.error(`\nNothing was sent (${status}). The panel proves nothing; do not read it.`)
    process.exit(1)
  }

  for (const [phase, frame] of [
    ['A  nothing sent', null],
    ['B  MODE 01 00', protocol.mode(1, 0)],
    ['C  MODE 02 00', protocol.mode(2, 0)],
  ] as const) {
    if (frame) await glasses.command(frame)
    for (let s = 20; s > 0; s--) {
      process.stdout.write(`\r  phase ${phase}, ${s}s remaining    `)
      await sleep(1000)
    }
  }

  await glasses.end('keep')
  console.log('\r  done                                   ')
  console.log('\nDid a solid filled panel appear at any point? If so, roughly when?')
}

/**
 * A solid rectangle, bright half and dim half, for the watched display test.
 *
 * `testCard`'s bands and walking marker turned out to be unreportable: the thing
 * being asked about has to be describable in three words by someone glancing at a
 * pair of glasses. Everything already on this unit is text-shaped, so "the whole
 * panel is lit" is the entire question. The two brightnesses are a bonus, since
 * type 1 cannot draw a dim pixel at all.
 */
function solidCard(): number[][] {
  const bmp = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 24 }, (_, c) => (c < 12 ? 3 : 1)),
  )
  // Same dead-pixel nonce as testCard, so a repeat run is never skipped silently.
  const n = nonce()
  for (let i = 0; i < 6; i++) bmp[0][9 + i] = (n >> (2 * i)) & 0b11
  return bmp
}

/**
 * How much of a type 2 image wider than the panel is ever visible?
 *
 * `set_mode(26)` copies 96 bytes, 24 columns, from the staging buffer to the live
 * column buffer (`abs 0x21f26`), and the frame the `DATCP` arm builds is 24 columns
 * wide too (`abs 0x221de`). So the expectation is that a 383-column upload is
 * accepted and stored in full while only its first 24 columns ever reach the panel.
 *
 * The counter-hypothesis is real though: type 2's `DATCP` also stores the full
 * column count to `ncols` at `0x2000309e` (`abs 0x182f0`), which is what the type 1
 * scroll reads. If mode 26 uses it, the panel cycles through all 383.
 *
 * Lit head, **dark** tail. The first pass of this used a dim tail and the report
 * came back "not certain, but it feels like it is bright all the time": bright
 * against dim is too fine a call to make by eye on a pair of glasses. Lit against
 * black is not.
 */
async function cmdWide(): Promise<void> {
  const cols = content.IMAGE_ACCEPT_CEILING
  console.log(`Uploading ${cols} columns: first 24 LIT, remaining ${cols - 24} DARK.`)
  console.log('Then 120s of watching, with no MODE sent (MODE would discard it).\n')
  console.log('  stays lit, never goes dark -> only the first 24 columns are visible')
  console.log('  goes black for a stretch   -> it scrolls the whole buffer')
  console.log('  black the whole time       -> visible window is not the head\n')
  if (!confirmed) {
    console.error('Refusing without --yes.')
    process.exit(1)
  }

  const bmp = Array.from({ length: 9 }, () =>
    Array.from({ length: cols }, (_, c) => (c < 24 ? 3 : 0)),
  )
  // The nonce lives in the head here, not at column 9 of a dark tail: those are
  // dead pixels either way, but keeping it inside the lit window means a repeat run
  // still differs in bytes without putting a stray lit pixel in the dark region.
  const n = nonce()
  for (let i = 0; i < 6; i++) bmp[0][9 + i] = (n >> (2 * i)) & 0b11

  const glasses = await open()
  for (let s = 15; s > 0; s--) {
    process.stdout.write(`\r  upload in ${s}s   `)
    await sleep(1000)
  }
  const { status, reply } = await glasses.save(bmp, {
    type: dats.TYPE_IMAGE,
    blockSleep: 12,
    confirm: true,
  })
  console.log(`\r  uploaded, DATCP -> ${reply}    `)
  if (status !== 'saved' || reply !== 'DATCPOK') {
    await glasses.end('keep')
    console.error(`\nNothing was sent (${status}). The panel proves nothing.`)
    process.exit(1)
  }
  await glasses.end('keep')

  // 383 columns at SPEED's 3.8-12.5 columns/second is 31s to 101s for one pass, so
  // two minutes covers a full cycle even at the slow end.
  for (let s = 120; s > 0; s--) {
    process.stdout.write(`\r  watching, ${s}s remaining    `)
    await sleep(1000)
  }
  console.log('\r  done                          ')
}

if (cmd === 'wide') await cmdWide()
else if (cmd === 'show') await cmdShow()
else if (cmd === 'watch') await cmdWatch()
else if (cmd === 'ceiling') await cmdCeiling()
else {
  console.error(`unknown command ${JSON.stringify(cmd)}. Use ceiling or show.`)
  process.exit(1)
}
process.exit(0)
