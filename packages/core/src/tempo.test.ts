import { expect, test } from 'bun:test'
import { EDGE, TICK_STOCK_HZ, tickMs } from './jgx.js'
import { encode } from './rhythm.js'
import {
  BeatClock,
  MAX_BPM,
  MIN_BPM,
  NOTICEABLE_MS,
  ONE,
  PPM_CRYSTAL,
  PPM_RC,
  TAPS_AVERAGED,
  type Tap,
  TapTempo,
  beatBars,
  bpmOf,
  clockAt,
  driftMs,
  interval88ForBpm,
  intervalMs,
  measuredPpm,
  phase88,
  ppmResolution,
  roundedToWholeTicks,
  separationMs,
  secondsToSeparate,
  ticksAtMs,
} from './tempo.js'

const HZ = TICK_STOCK_HZ
/** 128 BPM at 50 Hz is 23.4375 ticks, which is exactly 6000 in 8.8. */
const B128 = interval88ForBpm(128, HZ)

/**
 * A run of presses on an exact grid, stamped the way a tick counter would see them.
 *
 * The flooring is the point: every stamp is a whole tick, so the quantisation the
 * fractional accumulator exists to survive is present in the test input.
 */
function grid(
  bpm: number,
  beats: number,
  opts: { start?: number; hz?: number; from?: number; jitterMs?: number[] } = {},
): Tap[] {
  const { start = 0, hz = HZ, from = 0, jitterMs = [] } = opts
  const beatMs = 60_000 / bpm
  return Array.from({ length: beats }, (_, i) => {
    const beat = from + i
    const ms = beat * beatMs + (jitterMs[i] ?? 0)
    return { ticks: (start + ticksAtMs(ms, hz)) >>> 0, count: (beat + 1) & 0xff }
  })
}

const feed = (t: TapTempo, taps: Tap[]) => taps.map((x) => t.tap(x))
const verdicts = (t: TapTempo, taps: Tap[]) => feed(t, taps).map((r) => r.verdict)

/** The estimate after a run, or a thrown assertion rather than a null dereference. */
function estimateAfter(taps: Tap[], t = new TapTempo()) {
  feed(t, taps)
  const e = t.estimate()
  if (!e) throw new Error('no estimate')
  return e
}

// --- The 2% error, which is the whole reason the module exists ----------------------

/**
 * The note's own numbers, checked: 23.4375 ticks a beat stored as 23 loses 0.4375 of
 * a tick every beat, and thirty seconds of that is more than a whole beat out.
 */
test('whole ticks drifts past a full beat inside thirty seconds, 8.8 does not', () => {
  const ticks = 30 * HZ
  const fine = driftMs(B128, ticks, HZ)
  const coarse = driftMs(roundedToWholeTicks(B128), ticks, HZ, B128)

  expect(fine.maxMs).toBeLessThanOrEqual(tickMs(HZ))
  expect(Math.abs(coarse.finalMs)).toBeGreaterThan(intervalMs(B128, HZ))
  expect(Math.abs(coarse.finalMs)).toBeGreaterThan(25 * fine.maxMs)
})

/** 23 ticks against 23.4375 is 1.9%, which is the figure the note quotes. */
test('storing the interval as whole ticks is a 1.9% tempo error', () => {
  const error = Math.abs(bpmOf(roundedToWholeTicks(B128), HZ) - 128) / 128
  expect(error).toBeGreaterThan(0.018)
  expect(error).toBeLessThan(0.02)
})

/**
 * The legible form of the same defect, and the test that fails if the accumulator is
 * ever quantised: half a minute at 128 BPM is 64 beats, and the whole-tick clock has
 * produced 65 of them.
 */
test('the accumulator fires the exact beat count over thirty seconds', () => {
  const ticks = 30 * HZ
  expect(driftMs(B128, ticks, HZ).beats).toBe(64)
  expect(driftMs(roundedToWholeTicks(B128), ticks, HZ, B128).beats).toBe(65)
})

/**
 * Ten minutes, because "bounded" is the claim and thirty seconds cannot show it. The
 * fine clock's error never leaves one tick; the coarse one is over five seconds out.
 */
test('the fractional error stays inside one tick for ten minutes', () => {
  const ticks = 600 * HZ
  expect(driftMs(B128, ticks, HZ).maxMs).toBeLessThanOrEqual(tickMs(HZ))
  expect(Math.abs(driftMs(roundedToWholeTicks(B128), ticks, HZ, B128).finalMs))
    .toBeGreaterThan(5000)
})

/** A beat under one tick cannot be drawn, and firing every tick instead is worse. */
test('a clock faster than the tick is refused rather than fired every tick', () => {
  expect(() => new BeatClock(ONE - 1)).toThrow(/under a tick/)
  expect(() => new BeatClock(6000.5)).toThrow()
})

test('the accumulator carries its remainder rather than resetting to zero', () => {
  const clock = new BeatClock(B128)
  const fired: number[] = []
  for (let t = 1; t <= 100; t++) if (clock.tick()) fired.push(t)
  // 23.4375 ticks a beat: the gaps have to alternate 23 and 24, never all 23.
  expect(fired).toEqual([24, 47, 71, 94])
  expect(clock.beats).toBe(4)
})

// --- Averaging four taps -----------------------------------------------------------

/**
 * Why the window is four taps and not two. At 137 BPM a beat is 21.9 ticks, so a
 * single interval is 18 ms out on the quantisation alone; the span over three beats
 * divides that error by three and lands inside 5 ms.
 */
test('four taps beat two, because the error falls as one over the beats', () => {
  const taps = grid(137, 4)
  const exact = intervalMs(interval88ForBpm(137, HZ), HZ)
  const two = Math.abs(estimateAfter(taps.slice(0, 2)).intervalMs - exact)
  const four = Math.abs(estimateAfter(taps).intervalMs - exact)

  expect(two).toBeGreaterThan(15)
  expect(four).toBeLessThan(5)
  expect(four * 3).toBeLessThan(two)
})

test('the window holds the last four taps and the beats it spans', () => {
  const e = estimateAfter(grid(128, 8))
  expect(e.taps).toBe(TAPS_AVERAGED)
  expect(e.beats).toBe(TAPS_AVERAGED - 1)
})

/** 128 BPM at 50 Hz needs no rounding at all, so a clean run lands within 3 ms of it. */
test('a clean run at 128 BPM lands on the exact 8.8 interval', () => {
  expect(B128).toBe(6000)
  const e = estimateAfter(grid(128, 4))
  expect(Math.abs(e.interval88 - B128)).toBeLessThan(ONE / 2)
  expect(Math.abs(e.bpm - 128)).toBeLessThan(0.6)
})

/** Human sloppiness has to be visible, or a caller cannot tell a good run from a bad. */
test('spreadMs reports how far off the grid the tapping was', () => {
  expect(estimateAfter(grid(128, 4)).spreadMs).toBeLessThan(tickMs(HZ))
  // 30 ms either side of the beat, which is inside tolerance and so is folded in.
  const sloppy = estimateAfter(grid(128, 4, { jitterMs: [0, 30, -30, 0] }))
  expect(sloppy.spreadMs).toBeGreaterThan(25)
  expect(sloppy.spreadMs).toBeLessThan(45)
})

// --- The device's time base: wrap, duplicates, order --------------------------------

test('a run across the counter wrap measures the same as one that does not', () => {
  const base = 0xffff_fff0
  const wrapped = estimateAfter(grid(128, 4, { start: base }))
  const plain = estimateAfter(grid(128, 4))

  expect(wrapped.interval88).toBe(plain.interval88)
  // The anchor is past the wrap, so it is numerically below the base it started from.
  expect(wrapped.anchorTicks).toBe(54)
  expect(wrapped.anchorTicks).toBeLessThan(base)
})

test('phase is wrap-safe, so an anchor before the wrap still places the beat', () => {
  expect(phase88(B128, 0xffff_fff0, 0x0000_0010)).toBe(phase88(B128, 0, 32))
})

test('the same frame twice is one press', () => {
  const t = new TapTempo()
  const taps = grid(128, 3)
  feed(t, taps)
  const before = t.estimate()
  expect(t.tap(taps[2]).verdict).toBe('duplicate')
  expect(t.estimate()).toEqual(before)
})

test('a press that arrives after a later one is stale, not an interval', () => {
  const t = new TapTempo()
  const taps = grid(128, 4)
  feed(t, taps)
  const before = t.estimate()
  const late = t.tap(taps[1])
  expect(late.verdict).toBe('stale')
  expect(t.estimate()).toEqual(before)
})

/**
 * With no press counter the stamp is the only ordering signal there is, so the two
 * cases it can still tell apart are a repeat of the anchor and a stamp behind it.
 */
test('without a press counter, ordering falls back to the stamp', () => {
  const t = new TapTempo()
  const bare = grid(128, 3).map(({ ticks }) => ({ ticks }))
  feed(t, bare)
  expect(t.tap({ ticks: bare[2].ticks }).verdict).toBe('duplicate')
  expect(t.tap({ ticks: bare[1].ticks }).verdict).toBe('stale')
})

/** A count proves two presses; the same stamp then means two inside one 20 ms tick. */
test('two presses inside one tick are a bounce, not a duplicate', () => {
  const t = new TapTempo()
  feed(t, grid(128, 2))
  expect(t.tap({ ticks: 23, count: 3 }).verdict).toBe('bounce')
})

test('a lost notification is folded in as the beats it spanned, not as a reset', () => {
  const t = new TapTempo()
  const taps = grid(128, 4)
  const kept = [taps[0], taps[1], taps[3]]
  const results = feed(t, kept)

  expect(results.map((r) => r.verdict)).toEqual(['first', 'measured', 'measured'])
  expect(results[2].beats).toBe(2)
  expect(results[2].missed).toBe(1)
  // Exactly the estimate the unbroken run gives: nothing was degraded by the loss.
  expect(t.estimate()?.interval88).toBe(estimateAfter(taps).interval88)
})

test('a beat the human skipped is two beats, with nothing reported missed', () => {
  const t = new TapTempo()
  const taps = grid(128, 4).map(({ ticks }) => ({ ticks }))
  const results = feed(t, [taps[0], taps[1], taps[3]])
  expect(results[2].beats).toBe(2)
  expect(results[2].missed).toBe(0)
})

/** Subscribing to `BTN.PRESS | BTN.RELEASE` must not read as double tempo. */
test('a release edge is ignored rather than tapped', () => {
  const t = new TapTempo()
  const presses = grid(128, 4)
  const mixed: Tap[] = []
  for (const p of presses) {
    mixed.push({ ...p, edge: EDGE.PRESS })
    mixed.push({ ...p, ticks: (p.ticks + 5) >>> 0, edge: EDGE.RELEASE })
  }
  const seen = verdicts(t, mixed)
  expect(seen.filter((v) => v === 'released')).toHaveLength(4)
  expect(Math.abs((t.estimate() as { bpm: number }).bpm - 128)).toBeLessThan(1)
})

/** A stamp before the anchor with a forward count is a broken unit, not an interval. */
test('a stamp behind the anchor is refused whatever the count says', () => {
  const t = new TapTempo()
  feed(t, grid(128, 2))
  expect(t.tap({ ticks: 5, count: 9 }).verdict).toBe('stale')
})

// --- What resets the estimate ------------------------------------------------------

test('one tap is not a tempo', () => {
  const t = new TapTempo()
  expect(t.tap({ ticks: 100, count: 1 }).verdict).toBe('first')
  expect(t.estimate()).toBeNull()
})

/**
 * The failure the brief names: a three-second gap must not become a 128 BPM interval.
 * Nor may two of them bootstrap a run between themselves.
 */
test('a three-second gap restarts the run instead of joining it', () => {
  const t = new TapTempo()
  const taps = grid(128, 4)
  feed(t, taps)
  const gap = (t.estimate() as { anchorTicks: number }).anchorTicks + 3 * HZ

  expect(t.tap({ ticks: gap, count: 5 }).verdict).toBe('restart')
  expect(t.estimate()).toBeNull()
  expect(t.tap({ ticks: gap + 3 * HZ, count: 6 }).verdict).toBe('restart')
  expect(t.estimate()).toBeNull()
})

/**
 * A bounce keeps the anchor rather than moving it to the spurious edge. Discriminated
 * by what happens next: from the real beat the following tap is an interval, and from
 * the bounce it would be another bounce and the run would never start.
 */
test('a bounce keeps the anchor, so the next real tap still counts', () => {
  const t = new TapTempo()
  const seen = verdicts(t, [
    { ticks: 0, count: 1 },
    { ticks: 23, count: 2 },
    { ticks: 34, count: 3 },
    { ticks: 46, count: 4 },
  ])
  expect(seen).toEqual(['first', 'measured', 'bounce', 'measured'])
  expect(t.estimate()?.interval88).toBe(46 * ONE / 2)
})

test('a bounce advances the press counter, so nothing reads as missed after it', () => {
  const t = new TapTempo()
  const results = feed(t, [
    { ticks: 0, count: 1 },
    { ticks: 23, count: 2 },
    { ticks: 34, count: 3 },
    { ticks: 46, count: 4 },
  ])
  expect(results[3].missed).toBe(0)
})

test('one stray tap does not move the estimate', () => {
  const t = new TapTempo()
  const taps = grid(128, 4)
  feed(t, taps)
  const before = t.estimate()
  const anchor = (before as { anchorTicks: number }).anchorTicks

  expect(t.tap({ ticks: anchor + 15, count: 5 }).verdict).toBe('outlier')
  expect(t.estimate()).toEqual(before)
  // And the run picks up again from the anchor the stray did not move.
  expect(t.tap({ ticks: anchor + 23, count: 6 }).verdict).toBe('measured')
  expect(Math.abs((t.estimate() as { bpm: number }).bpm - 128)).toBeLessThan(2)
})

/**
 * Two outliers that agree with each other are a person changing tempo, and cost one
 * extra tap. 128 to 158 BPM, because a near-commensurate change is deliberately
 * absorbed by the standing grid instead (the docblock says so).
 */
test('two consecutive outliers that agree are a new tempo', () => {
  const t = new TapTempo()
  feed(t, grid(128, 4))
  const anchor = (t.estimate() as { anchorTicks: number }).anchorTicks

  expect(t.tap({ ticks: anchor + 19, count: 5 }).verdict).toBe('outlier')
  expect(t.tap({ ticks: anchor + 38, count: 6 }).verdict).toBe('changed')
  const e = t.estimate() as { interval88: number; bpm: number }
  expect(e.interval88).toBe(19 * ONE)
  expect(Math.abs(e.bpm - 158)).toBeLessThan(1)
})

/**
 * Tapping double time is the same grid, which is what a musician means by it. At 100
 * BPM, because double time at 128 is 256 BPM and every one of those taps is a bounce.
 */
test('exact double time is read as the grid already established', () => {
  const t = new TapTempo()
  feed(t, grid(100, 4))
  const anchor = (t.estimate() as { anchorTicks: number }).anchorTicks

  expect(t.tap({ ticks: anchor + 15, count: 5 }).verdict).toBe('outlier')
  expect(t.tap({ ticks: anchor + 30, count: 6 }).verdict).toBe('measured')
  expect(Math.abs((t.estimate() as { bpm: number }).bpm - 100)).toBeLessThan(1)
})

test('reset forgets the run', () => {
  const t = new TapTempo()
  feed(t, grid(128, 4))
  t.reset()
  expect(t.estimate()).toBeNull()
  expect(t.tap({ ticks: 5000, count: 9 }).verdict).toBe('first')
})

test('a window of one tap and an inverted bpm window are refused', () => {
  expect(() => new TapTempo({ taps: 1 })).toThrow(/two taps/)
  expect(() => new TapTempo({ minBpm: 200, maxBpm: 100 })).toThrow(/not a window/)
})

// --- What comes out ----------------------------------------------------------------

/**
 * The tempo is device ticks, so it is not comparable across tick rates; the BPM is.
 * `jgx.SUB.TICK` can move a unit to 100 Hz, which is why `hz` is fixed per object.
 */
test('the same tapping at 100 Hz gives twice the interval and the same tempo', () => {
  const fifty = estimateAfter(grid(128, 4, { hz: 50 }), new TapTempo({ hz: 50 }))
  const hundred = estimateAfter(grid(128, 4, { hz: 100 }), new TapTempo({ hz: 100 }))

  expect(Math.abs(hundred.interval88 - 2 * fifty.interval88)).toBeLessThanOrEqual(2)
  expect(Math.abs(hundred.bpm - fifty.bpm)).toBeLessThan(0.5)
  expect(hundred.hz).toBe(100)
})

test('the whole tempo window fits an unsigned 16-bit 8.8 field', () => {
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm++) {
    const i88 = interval88ForBpm(bpm, HZ)
    expect(i88).toBeGreaterThanOrEqual(ONE)
    expect(i88).toBeLessThanOrEqual(0xffff)
    expect(Math.abs(bpmOf(i88, HZ) - bpm)).toBeLessThan(0.5)
  }
})

/**
 * The property the whole feature rests on, and the one that makes simultaneous presses
 * unnecessary: two pairs tapped on **different beats of the same grid** come out on the
 * same tempo and the same phase. Pair B is tapped five beats after pair A.
 */
test('two pairs tapped on different beats of one grid agree on tempo and phase', () => {
  const a = estimateAfter(grid(128, 4, { start: 1000 }))
  const b = estimateAfter(grid(128, 4, { start: 1000, from: 5 }))

  expect(b.interval88).toBe(a.interval88)
  const at = 5000
  const apart = Math.abs(
    phase88(a.interval88, a.anchorTicks, at) - phase88(b.interval88, b.anchorTicks, at),
  )
  const nearest = Math.min(apart, a.interval88 - apart)
  expect(intervalMs(nearest, HZ)).toBeLessThan(tickMs(HZ))
})

test('two clocks aligned to anchors one beat apart fire on the same ticks', () => {
  const interval = 23 * ONE
  const one = clockAt(interval, 1000, 5000)
  const other = clockAt(interval, 1023, 5000)
  expect(other.acc88).toBe(one.acc88)

  const firedBy = (clock: BeatClock) => {
    const out: number[] = []
    for (let t = 1; t <= 100; t++) if (clock.tick()) out.push(t)
    return out
  }
  expect(firedBy(other)).toEqual(firedBy(one))
})

test('the bars a beat produces are what the rhythm channel takes', () => {
  for (const style of [0, 1, 2, 3] as const) {
    const bars = beatBars(0, style)
    expect(encode(bars, style).length).toBe(16)
    expect(new Set(bars).size).toBe(1)
  }
  expect(beatBars(0)[0]).toBe(9)
  expect(beatBars(1)[0]).toBe(0)
  expect(beatBars(0.5)[0]).toBe(5)
  // Outside 0..1 clamps rather than producing a height the firmware blanks a column for.
  expect(beatBars(-1)[0]).toBe(9)
  expect(beatBars(9)[0]).toBe(0)
})

// --- The accuracy question this module cannot answer -------------------------------

/**
 * The numbers the docblock quotes, so they cannot rot: at 1% each two pairs are 50 ms
 * apart in 2.5 s and a whole 128 BPM beat apart in 23 s. At 20 ppm each the same two
 * are 21 minutes and 3.3 hours, and eight hours is still two and a half beats.
 */
test('the crystal-or-RC question is worth seconds against hours', () => {
  expect(separationMs(1000, PPM_RC)).toBe(20)
  expect(secondsToSeparate(NOTICEABLE_MS, PPM_RC)).toBeCloseTo(2.5, 3)
  expect(secondsToSeparate(intervalMs(B128, HZ), PPM_RC)).toBeCloseTo(23.4, 1)

  expect(secondsToSeparate(NOTICEABLE_MS, PPM_CRYSTAL) / 60).toBeCloseTo(20.8, 1)
  expect(secondsToSeparate(intervalMs(B128, HZ), PPM_CRYSTAL) / 3600).toBeCloseTo(3.3, 1)
  const overnight = separationMs(8 * 3600 * 1000, PPM_CRYSTAL)
  expect(overnight / intervalMs(B128, HZ)).toBeCloseTo(2.46, 1)
})

/** A unit ticking 1% slow, measured the way the experiment would measure it. */
test('a tick error is measurable from stamps against the host clock', () => {
  expect(measuredPpm(1000, 20_200, HZ)).toBeCloseTo(9901, 0)
  expect(measuredPpm(1000, 20_000, HZ)).toBe(0)
})

/** Five seconds of capture answers the open question; 20 ppm needs forty minutes. */
test('the capture length needed says which question is cheap', () => {
  expect(ppmResolution(5000, NOTICEABLE_MS)).toBe(PPM_RC)
  expect(ppmResolution(40 * 60 * 1000, NOTICEABLE_MS)).toBeLessThan(PPM_CRYSTAL + 1)
})
