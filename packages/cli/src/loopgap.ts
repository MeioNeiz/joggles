#!/usr/bin/env bun
/**
 * Time the gap the device inserts between scroll-loop passes. Track 16.
 *
 * The claim under test, from `research/firmware-internals.md` "Type 1 gets 24 blank
 * columns at each end, free" (*derived*, `abs 0x1833e`): `DATS` starts type 1's byte
 * counter at 48 and `DATCP` stores `ncols = N + 48`, so every type 1 save scrolls
 * with 24 firmware-supplied blank columns before the content and 24 after. Nobody
 * has timed it on hardware. The observation that prompted this: the app preview
 * loops seamlessly while the panel shows a long dark gap between passes.
 *
 * Method: save a SOLID 32-column block (type 1, monochrome), set the slowest speed
 * (SPEED 5, 260ms per column per `packages/app/src/speed.ts`, *verified* ladder),
 * send `MODE 02 00`, disconnect and leave it looping. A person times two things
 * with a stopwatch, each two or three times:
 *
 *   DARK    from the panel going completely dark to anything lighting again
 *   PERIOD  from light first appearing to light first appearing on the next pass
 *
 * Predictions at 260ms/col, solid width W=32, window 24:
 *
 *   hypothesis                          DARK        PERIOD
 *   bracket 24+24 (the claim)           ~6.5s       ~20.8s     (80 columns)
 *   no bracket                          never dark  n/a: block always lit
 *   bracket one side only (24)          ~0.3s blink ~14.6s
 *   scroll walks the whole 1536B store  ~3 minutes  ~3.3 minutes
 *   bracket 24+24 plus inter-pass pause both exceed the first row by the pause
 *
 * DARK measures the total blank run B as `DARK/0.26 + 23` columns; PERIOD checks
 * the speed ladder for free. The dark run is contiguous through the wrap, so
 * "before and after" versus "48 after" are indistinguishable here - what is being
 * measured is the total, which is what the preview needs to simulate.
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
import { dats, protocol as p } from '@joggles/core'
import { open } from './glasses.js'

const args = Bun.argv.slice(2)
const confirmed = args.includes('--yes')
const cmd = args.find((a) => !a.startsWith('--')) ?? 'run'

/** Wider than the window so the scroll must engage; content narrower than the
 * panel is verify item 5, deliberately not conflated with this test. */
const SOLID_COLUMNS = 32

/** Milliseconds per column at SPEED 5, the bottom of the divisor ladder. */
const SLOW_MS = 260

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

const predictions = (ms: number) => {
  const s = (steps: number) => ((steps * ms) / 1000).toFixed(1)
  console.log(`\nAt ${ms}ms per column, solid ${SOLID_COLUMNS} wide:`)
  console.log('  bracket 24+24 (the claim)   DARK ~' + s(25) + 's   PERIOD ~' + s(80) + 's')
  console.log('  no bracket                  never dark, block always somewhere on the panel')
  console.log('  bracket one side only       DARK ~' + s(1) + 's blink   PERIOD ~' + s(56) + 's')
  console.log('  whole 1536-byte store       DARK ~' + s(713) + 's')
  console.log('  claim + inter-pass pause    both exceed the first row by the pause\n')
  console.log('Time DARK (all dark -> first light) and PERIOD (light -> next light), x2 each.')
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
  await g.command(p.speed(5))
  await g.command(p.mode(2, 0))
  await g.end('keep')
  console.log('\nScrolling at SPEED 5 and disconnected; it loops unattended from here.')
  predictions(SLOW_MS)
} else if (cmd === 'speed') {
  const n = Number(args.find((a) => /^\d+$/.test(a)) ?? NaN)
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    console.error('usage: loopgap.ts speed <0-100>')
    process.exit(1)
  }
  // The divisor ladder from packages/app/src/speed.ts: 13 ticks per column at
  // SPEED <= 10, one fewer per bucket of 10, floor of 4 above 90. 20ms ticks.
  const divisor = n > 90 ? 4 : 13 - Math.max(0, Math.ceil(n / 10) - 1)
  const ms = divisor * 20
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
