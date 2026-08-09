#!/usr/bin/env bun
/**
 * Where does upload time actually go?
 *
 *   bun run packages/cli/src/uploadbench.ts [cols] --yes
 *
 * Answers "how many pairs can one host reach in an evening", which is a cycle-time
 * question: connect, upload, trigger, disconnect, next pair. The inter-block sleep is
 * the only term we control without firmware, and it was copied from the vendor app
 * rather than measured, so it is the first thing to test.
 *
 * Timing only. It does NOT prove the content arrived intact: DATS validates nothing and
 * replies DATCPOK regardless, so a fast pass that "succeeds" here still has to be read
 * off the panel by eye. Uses a striped pattern for exactly that reason - dropped or
 * shifted blocks are obvious, where a blank or solid fill would hide them.
 */
import { open, sleep } from './glasses.js'

// 1536 bytes is what the flash buffer holds; 740 columns is what the firmware will
// actually take. Bisected from both directions: 740 replies DATCPOK, 745 replies
// ERROR. Whether the real bound is 1485 bytes or 100 blocks is unresolved, and this
// encoder cannot separate them, so the enforced number is the measured one.
const MAX_COLS = 740

const PACINGS = [50, 25, 12, 6, 3, 0]

/** Page erases per DATCP: five hardcoded at `abs 0x218cc`, whatever the payload size. */
const ERASES_PER_SAVE = 5

const args = Bun.argv.slice(2)
const confirmed = args.includes('--yes')
const cols = Number(args.find((a) => !a.startsWith('--')) ?? MAX_COLS)

if (cols > MAX_COLS) {
  console.error(`${cols} cols is over the measured ceiling of ${MAX_COLS}.`)
  console.error('The device replies ERROR and stores nothing.')
  process.exit(1)
}

// This is the runaway we already ran: one invocation is six saves, and the bisection that
// found the 740 ceiling ran it many times over. Nothing can read the cycle count back off
// the device, so the only defence is announcing the spend before making it.
console.log(
  `This run performs ${PACINGS.length} saves, ` +
    `${PACINGS.length * ERASES_PER_SAVE} page erases at abs 0x3c000.`,
)
console.log('Wear here costs saved content, not the unit. Human-paced saving is a non-issue;')
console.log('loops are not. See "Flash wear" in notes/app-plan.md.\n')

if (!confirmed) {
  console.error('Refusing without --yes.')
  process.exit(1)
}

/**
 * Vertical stripes every 3rd column, so a dropped block shifts the phase visibly.
 *
 * `phase` exists for the budget guard, not for the measurement: six identical
 * payloads in a row are five duplicates, and the guard skips those silently
 * (correctly - they would write flash to store what is already stored), which
 * would leave five of the six rows below timing nothing at all.
 */
function stripes(width: number, phase: number): number[][] {
  return Array.from({ length: 9 }, () =>
    Array.from({ length: width }, (_, c) => (c % 3 === phase % 3 ? 1 : 0)),
  )
}

const bytes = cols * 2
const blocks = Math.ceil(bytes / 15)

console.log(`${cols} cols = ${bytes} bytes = ${blocks} blocks of 15\n`)
console.log('sleep    connect   handshake   blocks    total    per-pair cycle   reply')
console.log('-'.repeat(78))

for (const [pass, blockSleep] of PACINGS.entries()) {
  const t0 = performance.now()
  const glasses = await open()
  const tConnected = performance.now()

  // Time the handshake and the block stream separately: only the second scales with
  // the sleep, and if connect dominates then tuning the sleep is not worth much.
  const tStart = performance.now()
  // `confirm` is the --yes above: the run announced its cost and a human agreed to
  // it. The daily limit is deliberately not overridable from here.
  const { reply, saves } = await glasses.save(stripes(cols, pass), { blockSleep, confirm: true })
  const tDone = performance.now()

  await glasses.end('keep')
  const tClosed = performance.now()

  const connect = tConnected - t0
  const upload = tDone - tStart
  const cycle = tClosed - t0
  // Handshake = whatever upload() spent outside the paced writes.
  const paced = blocks * blockSleep
  const handshake = Math.max(0, upload - paced)

  console.log(
    `${String(blockSleep).padStart(4)}ms  ${connect.toFixed(0).padStart(7)}ms  ` +
      `${handshake.toFixed(0).padStart(8)}ms  ${paced.toFixed(0).padStart(7)}ms  ` +
      `${upload.toFixed(0).padStart(6)}ms  ${cycle.toFixed(0).padStart(12)}ms   ` +
      `${reply} (${saves} lifetime)`,
  )
  // Long enough to clear the guard's 3s minimum between saves rather than trip it:
  // this loop is the shape the limit exists for, so it waits instead of overriding.
  await sleep(3200)
}

console.log('\nCheck the panel: stripes every 3rd column, evenly spaced.')
console.log('Uneven spacing or gaps = blocks lost at that pacing, DATCPOK regardless.')
process.exit(0)
