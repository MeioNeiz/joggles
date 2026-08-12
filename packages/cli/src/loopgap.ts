#!/usr/bin/env bun
/**
 * Time the gap the device inserts between scroll-loop passes. Track 16.
 *
 * The claim under test, from `research/firmware-internals.md` "Type 1 gets 24 blank
 * columns at each end, free" (*derived*, `abs 0x1833e`): `DATS` starts type 1's byte
 * counter at 48 and `DATCP` stores `ncols = N + 48`, so every type 1 save scrolls
 * with 24 firmware-supplied blank columns before the content and 24 after. The
 * observation that prompted this: the app preview loops seamlessly while the panel
 * shows a long dark gap between passes.
 *
 * **It has run twice and the two answers disagree.** 2026-08-10, this script: the
 * solid block looped seamlessly, nothing dark (*verified*, one run). 2026-08-11, a
 * 27-column word saved from the app with no client gap: the panel showed a full
 * screen width of dark and the word cleared it completely (Jacob, by eye, against a
 * payload *verified* off the decoded wire log). One screen of gap fits a walk of
 * `N + 24`, the trailing half of the record's bracket; seamless fits `N`. The
 * difference may be that the second had been restored from flash and the first had
 * not, and **this script is one half of the experiment that separates them**: re-save
 * in a session and watch without power-cycling, having already watched a restored
 * loop. Both looks and their readings are the first thing in
 * `research/loop-gap-2026-08-10.md`.
 *
 * A third observation now sits beside those two and supports the one-bracket reading:
 * both scroll directions gap and one shows the dead space at the *beginning* of the
 * pass (`research/vendor-app-protocol.md`, 2026-08-11, by eye), which is direction
 * picking **which** bracket a pass walks rather than how many. The size is still what
 * nobody has measured, and it is what this script exists to measure.
 *
 * Method: save a SOLID 32-column block (type 1, monochrome), set the slowest speed
 * (SPEED 5), send `MODE 02 00`, disconnect and leave it looping. A person times two
 * things with a stopwatch, each two or three times:
 *
 *   DARK    from the panel going completely dark to anything lighting again
 *   PERIOD  from light first appearing to light first appearing on the next pass
 *
 * Predictions at 260ms/col, solid width W=32, window 24:
 *
 *   hypothesis                          DARK        PERIOD
 *   bracket 24+24                       ~6.5s       ~20.8s     (80 columns)
 *   no bracket                          never dark  n/a: block always lit  <- 08-10
 *   bracket one side only (24)          ~0.3s blink ~14.6s     <- fits the 08-11 word
 *   scroll walks the whole 1536B store  ~3 minutes  ~3.3 minutes
 *   bracket 24+24 plus inter-pass pause both exceed the first row by the pause
 *
 * DARK measures the total blank run B as `DARK/0.26 + 23` columns. The dark run is
 * contiguous through the wrap, so "before and after" versus "48 after" are
 * indistinguishable here - what is being measured is the total, which is what the
 * preview needs to simulate.
 *
 * **Read PERIOD before believing DARK.** Every millisecond above comes from
 * `protocol.speedDivisor`, which is *derived*: hand-disassembled from the bucketing
 * ladder at `abs 0x183da` and **never timed against a panel**, and the 2026-08-12
 * handset session reported the preview running "way slower than the actual speed of
 * the device", which is the ladder being wrong or the preview's clock being wrong and
 * nobody has separated them. PERIOD is the check: it is `(W + B) * ms` with W known, so
 * if PERIOD misses its row while DARK fits one, the ladder moved and not the bracket.
 * Timing the ladder is its own item, `notes/parallel-tracks.md` track 11.
 *
 * Costs one type 1 save (5 page erases) and REPLACES whatever text is in the flash
 * store. `speed <n>` re-times at another rate for free: SPEED and MODE write no
 * flash, and MODE here is safe because the panel is already on the type 1 store.
 *
 *   bun run packages/cli/src/loopgap.ts run --yes      save, slowest speed, leave looping
 *   bun run packages/cli/src/loopgap.ts speed 95       re-time at another SPEED, no save
 *
 * If the scan finds nothing: a connected device stops advertising, so close the
 * phone app first; and a dark panel may just be powered off (2s button press).
 */
import { dats, protocol as p, viewport } from '@joggles/core'
import { open } from './glasses.js'

const args = Bun.argv.slice(2)
const confirmed = args.includes('--yes')
const cmd = args.find((a) => !a.startsWith('--')) ?? 'run'

/** Wider than the window so the scroll must engage; content narrower than the
 * panel is verify item 5, deliberately not conflated with this test. */
const SOLID_COLUMNS = 32

/** The slowest the panel goes, and the rate every prediction below is scaled by. */
const SLOW_SPEED = 5
const SLOW_MS = p.msPerColumn(SLOW_SPEED)

/**
 * A solid monochrome block, with the run nonce in dead pixels so a repeat is never
 * silently skipped by the duplicate-payload guard (the type2.ts trap: a skipped
 * save sends nothing, which reads as "the panel ignored it"). Monochrome nonce on
 * purpose: one grey pixel would flip `savedType` to type 2, which `MODE` discards.
 */
function solidBlock(): number[][] {
  const bmp = Array.from({ length: 9 }, () => new Array(SOLID_COLUMNS).fill(1))
  const n = Date.now() & 0x3f
  for (let i = 0; i < 6; i++) bmp[0][9 + i] = (n >> i) & 1
  return bmp
}

/** Columns the 1536-byte type 1 store holds, at 2 bytes per column. */
const STORE_COLUMNS = 768

/** Steps the panel is COMPLETELY dark for, given a blank run of `blank` columns. */
const darkSteps = (blank: number) => Math.max(blank - viewport.WIDTH + 1, 0)

// Every number below is computed from SOLID_COLUMNS and dats.TYPE1_BRACKET rather
// than written out: the figures were right for a 32-column block and silently wrong
// for any other, which is a trap in a script whose whole output is a prediction.
const predictions = (ms: number) => {
  const B = dats.TYPE1_BRACKET
  const s = (steps: number) => ((steps * ms) / 1000).toFixed(1)
  const row = (dark: string, period: string) => `DARK ~${dark}s   PERIOD ~${period}s`
  console.log(`\nAt ${ms}ms per column, solid ${SOLID_COLUMNS} wide:`)
  console.log(`  bracket ${B}+${B} (the claim)   `
    + row(s(darkSteps(2 * B)), s(SOLID_COLUMNS + 2 * B)))
  console.log('  no bracket                  never dark, block always somewhere on the panel')
  console.log(`  bracket one side only       `
    + row(s(darkSteps(B)) + ' blink', s(SOLID_COLUMNS + B)))
  console.log(`  whole ${STORE_COLUMNS}-column store    `
    + row(s(darkSteps(STORE_COLUMNS - SOLID_COLUMNS)), s(STORE_COLUMNS)))
  console.log('  claim + inter-pass pause    both exceed the first row by the pause\n')
  console.log('Time DARK (all dark -> first light) and PERIOD (light -> next light), x2 each.')
  console.log(`Blank run B = DARK/${(ms / 1000).toFixed(2)} + ${viewport.WIDTH - 1} columns.`)
}

if (cmd === 'run') {
  console.log(`One type 1 save: solid ${SOLID_COLUMNS}x9 block, 5 page erases, and it`)
  console.log('replaces the text in the flash store.\n')
  if (!confirmed) {
    console.error('Refusing without --yes.')
    process.exit(1)
  }
  const g = await open()
  console.log(`connected to ${g.name}`)
  const { status, reply, saves } = await g.save(solidBlock(), {
    type: dats.TYPE_TEXT,
    blockSleep: 12,
    confirm: true,
  })
  console.log(`save: ${status}, ${reply}, ${saves} lifetime saves`)
  if (status !== 'saved' || reply !== 'DATCPOK') {
    await g.end('keep')
    console.error('Nothing was committed, so the panel proves nothing. Stop here.')
    process.exit(1)
  }
  // deliver()'s order: SPEED before MODE, matching the run that scrolled unattended.
  await g.command(p.speed(SLOW_SPEED))
  await g.command(p.mode(2, 0))
  await g.end('keep')
  console.log(`\nScrolling at SPEED ${SLOW_SPEED} and disconnected; it loops unattended.`)
  predictions(SLOW_MS)
} else if (cmd === 'speed') {
  const n = Number(args.find((a) => /^\d+$/.test(a)) ?? NaN)
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    console.error('usage: loopgap.ts speed <0-100>')
    process.exit(1)
  }
  // The ladder is protocol.speedDivisor and nowhere else: this used to re-derive it
  // inline from a comment pointing at packages/app/src/speed.ts, which has not held it
  // since it moved beside protocol.speed(). Two copies of a number a stopwatch is being
  // compared against is how a timing script silently measures the wrong thing.
  const ms = p.msPerColumn(n)
  const g = await open()
  console.log(`connected to ${g.name}`)
  await g.command(p.speed(n))
  await g.command(p.mode(2, 0))
  await g.end('keep')
  console.log(`\nSPEED ${n} set, no flash written.`)
  predictions(ms)
} else {
  console.error(`unknown command ${JSON.stringify(cmd)}. Use run or speed.`)
  process.exit(1)
}
process.exit(0)
