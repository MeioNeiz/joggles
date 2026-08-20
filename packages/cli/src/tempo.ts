#!/usr/bin/env bun
/**
 * Tap tempo with nothing attached: tap a beat in, watch it drift, or fail to.
 *
 *   bun run packages/cli/src/tempo.ts                 128 BPM, the default run
 *   bun run packages/cli/src/tempo.ts 137 --jitter=30 a sloppier human
 *   bun run packages/cli/src/tempo.ts 128 --seconds=300  five minutes of drift
 *   bun run packages/cli/src/tempo.ts 128 --hz=100    the same taps on the tick patch
 *
 * **It connects to nothing and it cannot.** A tap arrives as `jgx.MSG.BUTTON`, which
 * is our own extension's notification, and no unit carries our firmware; the stock
 * button is polled by the vendor's code and cannot talk to a host at all. So this
 * drives `core/src/tempo.ts` off a simulated human instead, and every number it prints
 * is arithmetic rather than a measurement.
 *
 * Three things it is for, in the order they matter:
 *
 *  1. **The drift table.** The same taps, stored two ways. 8.8 fixed point holds inside
 *     one tick forever; whole ticks is past a whole beat inside thirty seconds. That
 *     one number is why the module is not four lines long.
 *  2. **The verdict column.** The awkward taps are injected on purpose: a contact
 *     bounce, a frame delivered twice, a frame arriving after a later one, a lost
 *     notification and a three-second gap. What a tap tempo gets wrong is never the
 *     averaging, it is which taps it agreed to average.
 *  3. **The separation table**, which is the open question. Whether the 50 Hz tick is
 *     crystal-derived or from the internal RC oscillator decides whether two pairs hold
 *     all night or come apart in seconds, and nothing here can answer it. The last row
 *     is the experiment that would: with 50 ms of arrival jitter, five seconds of
 *     capture tells RC from crystal.
 */
import { rhythm } from '@joggles/core'
import {
  PPM_CRYSTAL,
  PPM_RC,
  type Tap,
  TapTempo,
  type Verdict,
  beatBars,
  clockAt,
  driftMs,
  intervalMs,
  ppmResolution,
  roundedToWholeTicks,
  secondsToSeparate,
  ticksAtMs,
} from '@joggles/core/src/tempo.js'

const args = Bun.argv.slice(2)
const flag = (name: string, fallback: number) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.slice(name.length + 3)) : fallback
}
const bpm = Number(args.find((a) => !a.startsWith('--')) ?? 128)
const hz = flag('hz', 50)
const jitterMs = flag('jitter', 12)
const seconds = flag('seconds', 30)
const taps = flag('taps', 4)
if (!Number.isFinite(bpm) || bpm < 40 || bpm > 240) {
  console.error(`bpm must be 40-240, got ${bpm}`)
  process.exit(2)
}

/** A fixed sequence, so two runs of this script are comparable. */
function jitter(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1103515245 + 12345) >>> 0
    return ((s >>> 16) / 65536) * 2 - 1
  }
}

const beatMs = 60_000 / bpm
const noise = jitter(20260820)
/** Ticks in, so the jitter on the first tap cannot push it below zero. */
const START_MS = 5000

/** The tap stream, with every awkward case the reset rules exist for folded into it. */
function stream(): { label: string; tap: Tap }[] {
  const out: { label: string; tap: Tap }[] = []
  let count = 0
  const press = (ms: number, label = 'on the beat') => {
    count += 1
    const tap: Tap = { ticks: ticksAtMs(ms, hz) >>> 0, count: count & 0xff }
    out.push({ label, tap })
    return tap
  }
  const at = (beat: number) => START_MS + beat * beatMs + noise() * jitterMs

  let beat = 0
  for (; beat < taps; beat++) press(at(beat))
  const bounce = press(at(beat - 1) + 30, 'bounce, 30 ms after the last press')
  out.push({ label: 'the same frame again', tap: bounce })

  press(at(beat++))
  const overtaken = press(at(beat++))
  press(at(beat++))
  out.push({ label: 'arriving after a later one', tap: overtaken })

  count += 1 // a notification the transport lost
  beat += 1
  press(at(beat++), 'a beat later, one notification lost')

  const gapMs = at(beat) + 3000
  press(gapMs, 'after three seconds of nothing')
  for (let again = 1; again <= taps; again++) {
    press(gapMs + again * beatMs + noise() * jitterMs, 'tapping again')
  }
  return out
}

const clock = new TapTempo({ hz, taps })
const rows: string[] = []
let last: ReturnType<TapTempo['estimate']> = null
const WORDS: Record<Verdict, string> = {
  first: 'tap one, nothing to measure',
  measured: 'folded in',
  released: 'not a press edge',
  duplicate: 'the same press again',
  stale: 'older than the anchor',
  bounce: 'too fast to be a beat',
  outlier: 'off the grid, estimate kept',
  changed: 'a new tempo',
  restart: 'the run is over, this is tap one',
}

for (const { label, tap } of stream()) {
  const r = clock.tap(tap)
  last = r.estimate ?? last
  const bpmNow = r.estimate ? r.estimate.bpm.toFixed(1).padStart(5) : '    -'
  const missed = r.missed ? ` (${r.missed} lost)` : ''
  rows.push(
    `${String(tap.ticks).padStart(6)} | ${r.verdict.padEnd(9)} | ${bpmNow} | ` +
      `${label}${missed} | ${WORDS[r.verdict]}`,
  )
}

console.log(`tapping ${bpm} BPM at ${hz} Hz, +/-${jitterMs} ms of human jitter\n`)
console.log(' ticks | verdict   |   bpm | the tap | what happened with it')
console.log(rows.join('\n'))

if (!last) {
  console.log('\nno estimate: nothing in that stream was a pair of beats')
  process.exit(0)
}

const exact = intervalMs(last.interval88, hz)
console.log(
  `\nestimate: interval88 ${last.interval88} (${exact.toFixed(2)} ms, ` +
    `${last.bpm.toFixed(2)} BPM), anchor tick ${last.anchorTicks}, ` +
    `${last.taps} taps over ${last.beats} beats, spread ${last.spreadMs.toFixed(1)} ms`,
)
console.log(
  `  measurement error against a true ${bpm}: ` +
    `${(exact - beatMs).toFixed(2)} ms a beat`,
)

const ticks = Math.round(seconds * hz)
const fine = driftMs(last.interval88, ticks, hz)
const coarse = driftMs(roundedToWholeTicks(last.interval88), ticks, hz, last.interval88)
console.log(`\nrunning that for ${seconds} s, the same interval stored two ways:`)
console.log('  stored as     | beats | worst error | at the end')
for (const [what, d] of [
  ['8.8 fixed', fine],
  ['whole ticks', coarse],
] as const) {
  console.log(
    `  ${what.padEnd(13)} | ${String(d.beats).padStart(5)} | ` +
      `${`${d.maxMs.toFixed(1)} ms`.padStart(11)} | ${d.finalMs.toFixed(1)} ms`,
  )
}
// The 30-second figure moves with the tempo, because how much a whole tick rounds away
// depends on where the interval sits between two ticks. The invariant is the one worth
// printing: the fixed-point error is bounded and the whole-tick error is not.
const lostPerBeat = Math.abs(intervalMs(roundedToWholeTicks(last.interval88), hz) - exact)
const fullBeatAfter = lostPerBeat > 0 ? ((exact / lostPerBeat) * exact) / 1000 : Infinity
console.log(
  `  whole ticks loses ${lostPerBeat.toFixed(2)} ms a beat, so it is a whole beat out ` +
    `after ${human(fullBeatAfter)} and keeps going`,
)

console.log('\nand the part no arithmetic here can settle, if the two units disagree:')
console.log('  tick source        | 50 ms apart | one beat apart')
for (const [what, ppm] of [
  ['crystal, 20 ppm', PPM_CRYSTAL],
  ['internal RC, 1%', PPM_RC],
] as const) {
  const fifty = secondsToSeparate(50, ppm)
  const beat = secondsToSeparate(exact, ppm)
  console.log(`  ${what.padEnd(18)} | ${human(fifty).padStart(11)} | ${human(beat)}`)
}
console.log('\n  the experiment, if 50 ms is what BLE arrival costs (measuredPpm):')
for (const capture of [5, 60, 2500]) {
  const resolves = ppmResolution(capture * 1000, 50)
  const reads =
    resolves >= 1000 ? `${(resolves / 10_000).toFixed(2)}%` : `${resolves.toFixed(0)} ppm`
  console.log(`  ${human(capture).padStart(8)} of capture | resolves ${reads}`)
}

function human(s: number): string {
  if (s < 90) return `${s.toFixed(1)} s`
  if (s < 5400) return `${(s / 60).toFixed(1)} min`
  return `${(s / 3600).toFixed(1)} h`
}

// One beat as the rhythm channel would draw it: every bar the same height, full on the
// beat and falling to nothing by the next, so time runs left to right below and the
// panel itself is a solid block that dims. Leaving DIY first is not optional on a real
// unit (`core/src/rhythm.ts`), and nothing here sends anything.
const beatClock = clockAt(last.interval88, last.anchorTicks, last.anchorTicks)
const heights: number[] = []
for (let t = 0; t < Math.ceil(exact / (1000 / hz)); t++) {
  heights.push(beatBars(beatClock.phase)[0])
  beatClock.tick()
}
console.log(
  `\none beat as ${heights.length} rhythm frames of ` +
    `${rhythm.encode(beatBars(0)).length} bytes, one write each, time left to right:`,
)
for (let h = rhythm.MAX_HEIGHT; h >= 1; h--) {
  console.log(`  ${heights.map((v) => (v >= h ? '#' : '.')).join('')}`)
}
console.log(`  ${heights.map((v) => v.toString(36)).join('')}`)
