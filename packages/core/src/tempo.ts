/**
 * Tap tempo: button presses into a tempo and a beat grid, in the device's time base.
 *
 * `notes/what-to-build.md`, "Syncing several pairs", ranks this above streaming and
 * above local-tempo-plus-resync: tap the same beats into two pairs and they end up on
 * the same tempo **and** the same grid, with no host, no radio and nothing left to
 * drift apart but the oscillator. That removes the resync machinery rather than
 * improving it. This is the host half: measure the tempo off `jgx.MSG.BUTTON` stamps,
 * and model the accumulator the firmware would run, so the divergence between two
 * pairs is a number somebody can read rather than a mystery.
 *
 * **This is not "press both buttons at the same instant", which is worse than BLE.**
 * Human simultaneity across two buttons is 50 to 100 ms, so it does not even beat
 * connection-interval skew, and each pair keeps its own mode counter that wraps at 21,
 * so a synchronised press lands two pairs on different modes. Tap tempo needs no
 * simultaneity at all: the four taps into pair B can be four *different* beats of the
 * same bar, because what the two pairs share is the grid, not the press. Nothing here
 * takes two devices, compares two presses, or cares which pair was tapped first.
 *
 * ## Provenance: all *derived*, and it cannot run yet
 *
 * Nothing in this file has been near hardware and it could not have been. A tap
 * arrives as `jgx.MSG.BUTTON`, which is our own extension's notification, and **no
 * unit carries our firmware**; the stock button is polled by the vendor's code and
 * cannot talk to a host at all. `rhythm.ts`, where the output lands, has never run on
 * hardware either. So every claim below is arithmetic, the tests are the whole of the
 * evidence, and the one number that decides whether the feature works in a field is
 * the one this file cannot measure without a unit ("What evaporates", last section).
 *
 * ## Work in the device's time base
 *
 * `ButtonEvent.ticks` is a free-running 32-bit count of the device's own animation
 * ticks at the moment of the edge, and it exists precisely so that a tempo is measured
 * without BLE round-trip jitter in it. Arrival time on the host is worth 15 to 50 ms of
 * noise per tap; the device stamp is worth one tick, 20 ms at 50 Hz, and unlike the
 * jitter it is a *bounded* error rather than a random one.
 *
 * Three consequences the code has to carry:
 *
 *  1. **The counter wraps**, every 994 days at 50 Hz. An unsigned subtraction gives
 *     the right interval across the wrap; a signed one gives a negative. Every delta
 *     here goes through `since()`.
 *  2. **A frame can arrive twice, or late.** Notifications are not acknowledged, and
 *     this transport re-sends. `ButtonEvent.count` (presses since power-on, mod 256)
 *     is what orders them: same count is the same press, a count behind the last one
 *     is a press that overtook nothing and arrived anyway. Without a count the only
 *     ordering signal left is the stamp itself, so a zero delta reads as a duplicate
 *     and a delta past 2^31 reads as backwards.
 *  3. **A tick stamp is only comparable to another stamp from the same tick rate.**
 *     `jgx.SUB.TICK` can move a unit to 100 Hz, which halves the meaning of every
 *     stamp. `hz` is fixed at construction: change the rate, build a new `TapTempo`.
 *
 * `jgx.tapIntervalMs` is this same subtraction for a single pair of stamps, and it is
 * what a caller holding two presses and no run should use. Nothing here passes through
 * its milliseconds: the arithmetic stays in ticks, because the accumulator is integer
 * and a float millisecond is exactly where the quantisation would creep back in.
 *
 * ## Why 8.8 fixed point, and what it does not fix
 *
 * One tick is 20 ms. A beat at 128 BPM is 23.4375 ticks, so **whole ticks is 23**, a
 * 1.9% tempo error: 0.4375 ticks lost per beat, 28 ticks after the 64 beats in thirty
 * seconds, which is 560 ms, past a whole beat of 469 ms. Two pairs storing that are
 * visibly apart before the first chorus even if their crystals are perfect.
 *
 * 8.8 fixed point (`interval88`, integer ticks in the high byte, 1/256 tick in the
 * low) costs one 16-bit field and removes the accumulation completely, because the
 * remainder survives each beat instead of being thrown away. At 50 Hz and 128 BPM the
 * interval is exactly 6000, so the note's own example needs no rounding at all.
 *
 *  - **Resolution**: 1/256 tick is 78 microseconds, 0.02 BPM at 128 BPM. Four taps
 *    measure the interval to about 7 ms (below), so the format is nowhere near being
 *    the limiting factor, which is the point of choosing it over 8.4 or 12.4.
 *  - **Range**: an unsigned 16-bit 8.8 tops out at 255.996 ticks, 5.12 s, 11.7 BPM. The
 *    40 to 240 BPM window this file accepts is 12.5 to 75 ticks, so a `u16` is the
 *    right device-side field with room to spare.
 *  - **What it does not fix**: a beat still fires on a tick boundary, so any single
 *    beat can be up to one tick (20 ms) late. That error is bounded and never grows.
 *    "Removes quantisation drift entirely" is true of the drift and would be false of
 *    the jitter, and `driftMs()` measures exactly this difference.
 *
 * ## Four taps, and why the average is a subtraction
 *
 * The estimate is the span of the window divided by the beats it covers, not the mean
 * of separately measured intervals. They are the same number (consecutive intervals
 * telescope) and the subtraction is the honest form of it: only two stamps carry
 * quantisation error, so **the error falls as 1/beats**, 20 ms over 3 beats is about
 * 7 ms for the four taps the note asks for. Averaging separately rounded intervals
 * looks like it should behave differently and does not; anyone reading it should not
 * have to work that out twice.
 *
 * Each accepted tap carries a **beat count**, not just a stamp, so a window is still
 * exact when a tap was skipped: an interval two beats long counts as two. That is what
 * makes `missed` recoverable instead of a reset.
 *
 * ## Reject rather than average nonsense
 *
 * A first tap, a three-second gap, a contact bounce and a deliberate tempo change all
 * look like intervals. Folding any of them into a mean gives a confident wrong answer,
 * which is worse than starting again, because a caller cannot tell it happened.
 *
 * | Verdict | What it saw | Effect on the estimate |
 * | --- | --- | --- |
 * | `first` | no anchor yet | starts a run, no estimate |
 * | `measured` | a tap within `tolerance` of a beat of the grid | folded in |
 * | `released` | an edge that is not `jgx.EDGE.PRESS` | none |
 * | `duplicate` | the same press again: same count, or a repeat stamp | none |
 * | `stale` | a press older than the anchor: count behind, or delta past 2^31 | none |
 * | `bounce` | under `maxBpm`'s shortest interval since the anchor | none, anchor kept |
 * | `outlier` | one tap that is not on the grid | none, remembered |
 * | `changed` | two consecutive outliers that agree | window restarts on those two |
 * | `restart` | over `MAX_MISSED_BEATS` beats of silence | window restarts on this tap |
 *
 * The reasoning behind the four that are judgement rather than arithmetic:
 *
 *  - **`bounce` keeps the anchor**, it does not move it. The real beat was the first
 *    edge; the second is a contact bounce or a fumbled double tap, and either way the
 *    earlier stamp is the better guess at where the beat was. It advances the press
 *    counter, so a bounce never leaves the next tap looking like a missed beat.
 *  - **`outlier` leaves the estimate alone.** One stray tap in a good run must not pull
 *    the tempo, and it cannot be un-averaged afterwards. `tolerance` defaults to 15%,
 *    which is about three times the jitter a human tap has (*unverified*, nobody has
 *    tapped into this) and has to stay well under 50%, or a missed beat and a tempo
 *    change stop being distinguishable.
 *  - **`changed` costs one extra tap, deliberately.** A tempo change is two consecutive
 *    intervals that disagree with the standing estimate and agree with each other. One
 *    tap can never change the tempo; two can. The standing grid is checked first, so
 *    tapping exact double or half time is read as the same grid, which is what a
 *    musician means by it, and a **near-commensurate** change costs another tap or two:
 *    two beats of 90 BPM are three beats of 128 to within 4.5%, so those taps keep
 *    landing on the old grid until two of them miss it together. The bias towards the
 *    tempo already established is the point; the alternative is a run that loses its
 *    tempo whenever somebody taps sloppily.
 *  - **`restart` is silence, not a slow tempo.** Past four beats of nothing the run is
 *    over and this tap is tap one. At 128 BPM that is 1.9 s, so the three-second gap
 *    the brief names cannot reach the mean. The rule is beats of silence rather than
 *    seconds of it, which cuts the other way at the slow end: at 40 BPM four beats is
 *    6 s, and a tap three seconds late there is genuinely on the grid and is folded in
 *    as the two beats it covers. A caller that wants the music to keep playing through
 *    a restart keeps the last estimate it was handed: this object forgets, on purpose.
 *
 * ## What comes out, in units that already exist
 *
 * No third representation of tempo. `Estimate` carries the two words a device needs
 * and derives the rest for people:
 *
 *  - `interval88`, the beat in 8.8 device ticks: what a set-tempo sub-command would
 *    carry, and what `BeatClock` runs on. `jgx.SUB` reserves `0x11`-`0x1f` for
 *    set-phase and set-tempo, and the wire format belongs there, not here.
 *  - `anchorTicks`, an unsigned 32-bit device tick that is on the beat: what a
 *    set-phase or sync-mark would carry, the same width as `ButtonEvent.ticks`. Two
 *    pairs are in phase when each holds an anchor from the same grid, whichever beat
 *    it happened to be, which is the whole reason no press has to be simultaneous.
 *  - `bpm` and `intervalMs` for display only, and `spreadMs`, the worst tap in the
 *    window against the fitted grid, which is the one honest confidence number here.
 *
 * `jgx.SUB.SEED` is the other half of the sync family and is orthogonal to this: a
 * shared seed makes two pairs play the same built-in sequence, a shared grid makes them
 * do it at the same moment. Seeding needs no clock, which is why it is worth having
 * while the accuracy question below is open.
 *
 * For the panel, `beatBars()` gives `rhythm.encode()` exactly the heights it takes, so
 * a host can drive a beat today with no firmware of ours anywhere: the rhythm channel
 * paints all 24 columns in one write. Its own rules still apply, and one bites here:
 * leave DIY first, or the same frame writes a garbage column instead (`rhythm.ts`).
 *
 * ## What evaporates under RC accuracy
 *
 * Open, and settled only by hardware: **whether the 50 Hz tick is crystal-derived or
 * from the internal RC oscillator.** Everything above is arithmetic on ticks and holds
 * either way. What does not hold, at RC accuracy:
 *
 *  - **That the same `interval88` on two pairs is the same tempo.** It is a count of
 *    *that unit's* ticks. If A ticks at 20.2 ms and B at 19.8 ms, one number is two
 *    tempos 2% apart and nothing on the host can see it.
 *  - **That a shared grid stays shared.** `separationMs()` is the arithmetic: two units
 *    each off by 1% in opposite directions separate by 50 ms, the note's own human
 *    simultaneity floor, in **2.5 s**, and by a whole 128 BPM beat in **23 s**. At 20
 *    ppm each the same two numbers are 21 minutes and 3.3 hours.
 *  - **That "essentially all night" means beat-accurate.** Even at 20 ppm each, eight
 *    hours is 1.2 s of separation, two and a half beats at 128 BPM (*derived*,
 *    arithmetic only). Two pairs still look deliberate; they are not in lockstep.
 *  - **That the BPM on the phone is the BPM in the room.** It is measured in device
 *    ticks, so at RC accuracy a displayed 128 could be 126.7.
 *
 * What this file can do is make the question cheap to answer, which is why
 * `measuredPpm()` and `ppmResolution()` are here. A unit's tick error is the drift
 * between its own stamps and the host's clock over a long capture, and the resolution
 * of that measurement is the arrival jitter divided by the capture length: with 50 ms
 * of jitter, **telling RC from crystal takes about 5 s of capture**, while measuring a
 * 20 ppm part at all takes about 40 minutes. So the open question is a ten-second
 * experiment and the answer that would be expensive to get is one nobody needs.
 */
import { EDGE, TICK_STOCK_HZ, tickMs } from './jgx.js'
import { MAX_HEIGHT, type Style, barCount } from './rhythm.js'

/** Fractional bits in an `interval88`. 8.8, so `ONE` is one whole device tick. */
export const FRAC_BITS = 8
export const ONE = 1 << FRAC_BITS

/** The tempo window taps are believed inside. Outside it, a tap is not a beat. */
export const MIN_BPM = 40
export const MAX_BPM = 240

/** Taps kept in the averaging window. Four is three intervals, the note's figure. */
export const TAPS_AVERAGED = 4

/** Beats a single interval may cover before the run counts as over rather than sparse. */
export const MAX_MISSED_BEATS = 4

/** How far off the estimate an interval may be and still be the same tempo. */
export const TOLERANCE = 0.15

/**
 * Separation at which two pairs read as out of step rather than together.
 *
 * Not invented here: it is the 50 ms floor `notes/what-to-build.md` gives for human
 * simultaneity across two buttons, reused as the threshold two pairs have to beat.
 */
export const NOTICEABLE_MS = 50

/** A plausible crystal part, for `separationMs`. *unverified*: no part is identified. */
export const PPM_CRYSTAL = 20

/**
 * An internal RC oscillator, taken as 1%.
 *
 * The optimistic end deliberately: a trimmed NuMicro HIRC is around 1% near room
 * temperature and around 2% across its range (*unverified*, from the family's usual
 * datasheet figures, not from this part). If the tick turns out to be RC, the truth is
 * this or worse.
 */
export const PPM_RC = 10_000

/** Wrap-safe forward distance between two 32-bit tick stamps. */
const since = (from: number, to: number): number => (to - from) >>> 0

/** Half the counter: past this, a "forward" delta is really a stamp from the past. */
const BACKWARDS = 0x8000_0000

/** Forward distance between two press counters, mod 256. 0 is the same press. */
const countAhead = (from: number, to: number): number => (to - from) & 0xff

/** Milliseconds a beat of this length lasts, on a unit ticking at `hz`. */
export const intervalMs = (interval88: number, hz = TICK_STOCK_HZ): number =>
  (interval88 / ONE) * tickMs(hz)

/** The same beat as a tempo. */
export const bpmOf = (interval88: number, hz = TICK_STOCK_HZ): number =>
  60_000 / intervalMs(interval88, hz)

/** A tempo as an `interval88`. The inverse of `bpmOf`, for seeding and for tests. */
export const interval88ForBpm = (bpm: number, hz = TICK_STOCK_HZ): number =>
  Math.round((60_000 / bpm / tickMs(hz)) * ONE)

/**
 * The tick a press at this millisecond lands in. Floor, because a tick counter is a
 * count of completed ticks: the firmware sees the press at the poll after it happened.
 */
export const ticksAtMs = (ms: number, hz = TICK_STOCK_HZ): number =>
  Math.floor(ms / tickMs(hz))

/**
 * The same interval as whole ticks, which is the mistake this module exists to avoid.
 *
 * Exported so the error is measurable rather than asserted: pass it to `driftMs` and
 * the drift is over a beat inside thirty seconds. Nothing should ever store this.
 */
export const roundedToWholeTicks = (interval88: number): number =>
  Math.round(interval88 / ONE) * ONE

/** What a tap is, structurally a `jgx.ButtonEvent` so one can be passed straight in. */
export interface Tap {
  /** The device's own tick count at the edge, unsigned 32-bit. */
  ticks: number
  /** Presses since power-on, mod 256. Absent means no ordering signal but the stamp. */
  count?: number
  /** `jgx.EDGE`. Absent means the caller has already filtered to presses. */
  edge?: number
}

export type Verdict =
  | 'first'
  | 'measured'
  | 'released'
  | 'duplicate'
  | 'stale'
  | 'bounce'
  | 'outlier'
  | 'changed'
  | 'restart'

export interface Estimate {
  /** The beat in 8.8 device ticks. The device-side representation, and the only one. */
  interval88: number
  /** An unsigned 32-bit device tick that is on the beat. What a set-phase would carry. */
  anchorTicks: number
  /** Taps in the window. */
  taps: number
  /** Beats the window spans, which is what the interval was divided by. */
  beats: number
  /** The rate the stamps were read at. A stamp from another rate is not comparable. */
  hz: number
  bpm: number
  intervalMs: number
  /** Worst tap in the window against the fitted grid. How tight the tapping was. */
  spreadMs: number
}

export interface TapResult {
  verdict: Verdict
  /** Null until two taps have been accepted, and again after a `restart`. */
  estimate: Estimate | null
  /** Beats this tap advanced the grid. 2 means one tap was skipped, not lost. */
  beats: number
  /** Presses the device made whose notifications never arrived. Needs `Tap.count`. */
  missed: number
}

export interface TapOptions {
  /** The unit's tick rate. Fixed for the life of the object: see the docblock. */
  hz?: number
  taps?: number
  minBpm?: number
  maxBpm?: number
  tolerance?: number
}

interface Accepted {
  /** Ticks since `base`, so the arithmetic never has to wrap. */
  at: number
  /** Beats since the first tap in the window. */
  beat: number
}

/**
 * Taps in, tempo and grid out. One per pair being tapped; it holds no transport.
 *
 * Feed it `jgx.ButtonEvent`s as they arrive, in any order and with repeats. Every call
 * says what it did with the tap, which is the part a UI needs: "that one did not
 * count" is a thing a person tapping has to be able to see.
 */
export class TapTempo {
  readonly hz: number
  private readonly limit: number
  private readonly min88: number
  private readonly max88: number
  private readonly tolerance: number

  private base = 0
  private window: Accepted[] = []
  private interval88 = 0
  private lastCount: number | null = null
  /** The last rejected outlier and its distance from the anchor. A change is two. */
  private candidate: { ticks: number; gap88: number } | null = null

  constructor(opts: TapOptions = {}) {
    const {
      hz = TICK_STOCK_HZ,
      taps = TAPS_AVERAGED,
      minBpm = MIN_BPM,
      maxBpm = MAX_BPM,
      tolerance = TOLERANCE,
    } = opts
    if (taps < 2) throw new RangeError(`a tempo needs two taps, got ${taps}`)
    if (minBpm <= 0 || maxBpm <= minBpm) {
      throw new RangeError(`bpm window ${minBpm}-${maxBpm} is not a window`)
    }
    this.hz = hz
    this.limit = taps
    this.min88 = interval88ForBpm(maxBpm, hz)
    this.max88 = interval88ForBpm(minBpm, hz)
    this.tolerance = tolerance
  }

  /** Forget the run. The next tap is tap one. */
  reset(): void {
    this.window = []
    this.interval88 = 0
    this.lastCount = null
    this.candidate = null
  }

  estimate(): Estimate | null {
    if (this.window.length < 2 || this.interval88 === 0) return null
    const first = this.window[0]
    const last = this.window[this.window.length - 1]
    let spread88 = 0
    for (const e of this.window) {
      const fitted = (e.beat - first.beat) * this.interval88
      spread88 = Math.max(spread88, Math.abs((e.at - first.at) * ONE - fitted))
    }
    return {
      interval88: this.interval88,
      anchorTicks: (this.base + last.at) >>> 0,
      taps: this.window.length,
      beats: last.beat - first.beat,
      hz: this.hz,
      bpm: bpmOf(this.interval88, this.hz),
      intervalMs: intervalMs(this.interval88, this.hz),
      spreadMs: intervalMs(spread88, this.hz),
    }
  }

  tap(t: Tap): TapResult {
    const wrongEdge = t.edge !== undefined && t.edge !== EDGE.PRESS
    if (wrongEdge) return this.result('released', 0, 0)

    const ticks = t.ticks >>> 0
    const count = t.count
    let missed = 0
    if (count !== undefined && this.lastCount !== null) {
      const ahead = countAhead(this.lastCount, count)
      if (ahead === 0) return this.result('duplicate', 0, 0)
      // Nothing beyond half the counter can be a plausible run of lost presses, so it
      // is a press from before the last one, arriving late.
      if (ahead > 127) return this.result('stale', 0, 0)
      missed = ahead - 1
    }

    if (this.window.length === 0) {
      this.start(ticks, count)
      return this.result('first', 0, missed)
    }

    const anchor = this.window[this.window.length - 1]
    const delta = since((this.base + anchor.at) >>> 0, ticks)
    if (delta >= BACKWARDS) return this.result('stale', 0, 0)
    if (delta === 0) {
      // A count proves these are two presses inside one 20 ms tick, which is a bounce.
      // Without one, the same stamp twice is the transport repeating itself.
      this.seen(count)
      return this.result(count !== undefined ? 'bounce' : 'duplicate', 0, missed)
    }

    const d88 = delta * ONE
    if (d88 < this.min88) {
      this.seen(count)
      return this.result('bounce', 0, missed)
    }

    if (this.interval88 === 0) {
      if (d88 > this.max88) {
        this.start(ticks, count)
        return this.result('restart', 0, missed)
      }
      this.accept(ticks, 1, count)
      return this.result('measured', 1, missed)
    }

    const beats = Math.max(1, Math.round(d88 / this.interval88))
    if (beats > MAX_MISSED_BEATS) {
      this.start(ticks, count)
      return this.result('restart', 0, missed)
    }
    if (this.onGrid(d88, beats)) {
      this.accept(ticks, beats, count)
      this.candidate = null
      return this.result('measured', beats, missed)
    }

    // The standing estimate is checked first and has now refused this tap. Two
    // refused intervals that agree with each other are a new tempo; one is a stray.
    if (this.candidate) {
      const gap88 = since(this.candidate.ticks, ticks) * ONE
      const inWindow = gap88 >= this.min88 && gap88 <= this.max88
      if (inWindow && this.agrees(gap88, this.candidate.gap88)) {
        this.start(this.candidate.ticks, undefined)
        this.accept(ticks, 1, count)
        return this.result('changed', 1, missed)
      }
    }
    this.candidate = { ticks, gap88: d88 }
    this.seen(count)
    return this.result('outlier', 0, missed)
  }

  /**
   * Is this tap within tolerance of a beat of the standing grid?
   *
   * A **phase** test, not a comparison of implied intervals, and the difference is not
   * cosmetic: dividing the gap by `round(gap / interval)` lands within `1/(2 * beats)`
   * of the interval whatever the gap was, so at four beats an interval test accepts
   * anything at all. Measuring the distance to the nearest beat instead is one rule
   * that holds for every span.
   */
  private onGrid(d88: number, beats: number): boolean {
    return Math.abs(d88 - beats * this.interval88) <= this.tolerance * this.interval88
  }

  /** Do two measured intervals agree? The candidate chain's test, and relative. */
  private agrees(a: number, b: number): boolean {
    return Math.abs(a - b) <= this.tolerance * b
  }

  private start(ticks: number, count: number | undefined): void {
    this.base = ticks >>> 0
    this.window = [{ at: 0, beat: 0 }]
    this.interval88 = 0
    this.candidate = null
    this.seen(count)
  }

  private accept(ticks: number, beats: number, count: number | undefined): void {
    const last = this.window[this.window.length - 1]
    this.window.push({ at: since(this.base, ticks), beat: last.beat + beats })
    if (this.window.length > this.limit) {
      // Rebased on the way out rather than left relative to a dropped tap, so a run
      // that never stops cannot walk `at` towards the 32-bit edge.
      const dropped = this.window.shift() as Accepted
      this.base = (this.base + dropped.at) >>> 0
      for (const e of this.window) {
        e.at -= dropped.at
        e.beat -= dropped.beat
      }
    }
    const first = this.window[0]
    const now = this.window[this.window.length - 1]
    // The span over the beats it covers, which is the mean of the intervals in it:
    // only two stamps carry quantisation error, so the error falls as 1/beats.
    this.interval88 = Math.round(((now.at - first.at) * ONE) / (now.beat - first.beat))
    this.seen(count)
  }

  private seen(count: number | undefined): void {
    if (count !== undefined) this.lastCount = count
  }

  private result(verdict: Verdict, beats: number, missed: number): TapResult {
    return { verdict, estimate: this.estimate(), beats, missed }
  }
}

/**
 * Where in the beat a unit is, at some tick, given an anchor on the grid.
 *
 * In 8.8 ticks since the last beat, which is the accumulator's own state, so this is
 * how a clock is started in phase with a tap run rather than with the moment it was
 * constructed. Wrap-safe, and it does not care how many beats ago the anchor was:
 * two pairs anchored on different beats of the same grid land on the same phase.
 */
export const phase88 = (
  interval88: number,
  anchorTicks: number,
  atTicks: number,
): number => (since(anchorTicks, atTicks) * ONE) % interval88

/**
 * The fractional accumulator, which is what the firmware would run.
 *
 * One tick adds `ONE`; a beat fires when the total crosses the interval, and the
 * **remainder carries over**. That carry is the whole feature: without it the beat is
 * quantised to whole ticks and two pairs walk apart on arithmetic alone.
 *
 * Host-side it is the model, not the thing: a phone can run it to drive rhythm frames,
 * and `driftMs` runs it to put a number on the error. Nothing about it needs our
 * firmware, which is why the interesting number is available before the flash is.
 */
export class BeatClock {
  private acc: number
  /** Beats fired since construction. */
  beats = 0

  constructor(
    readonly interval88: number,
    acc88 = 0,
  ) {
    if (!Number.isInteger(interval88) || interval88 < ONE) {
      throw new RangeError(`interval88 ${interval88} is under a tick, so it never fires`)
    }
    this.acc = ((acc88 % interval88) + interval88) % interval88
  }

  /** Advance one device tick. True on the tick a beat falls on. */
  tick(): boolean {
    this.acc += ONE
    if (this.acc < this.interval88) return false
    this.acc -= this.interval88
    this.beats++
    return true
  }

  /** 0 at the beat, approaching 1 just before the next. For `beatBars`. */
  get phase(): number {
    return this.acc / this.interval88
  }

  /** The accumulator itself, in 8.8 ticks since the last beat. */
  get acc88(): number {
    return this.acc
  }
}

/** A clock already in phase with a tap run, as of `atTicks`. */
export const clockAt = (
  interval88: number,
  anchorTicks: number,
  atTicks: number,
): BeatClock => new BeatClock(interval88, phase88(interval88, anchorTicks, atTicks))

export interface Drift {
  beats: number
  /** Worst beat against the ideal grid, in milliseconds. */
  maxMs: number
  /** The last beat's error, which is what grows if the interval is quantised. */
  finalMs: number
}

/**
 * How far a clock running `run88` strays from a grid at `ideal88`, over `ticks` ticks.
 *
 * The comparison the whole module rests on. Run it with `run88` as measured and the
 * error is bounded by one tick forever; run it with `roundedToWholeTicks(run88)` and
 * `finalMs` grows without limit, past a whole beat inside thirty seconds at 128 BPM.
 * It measures nothing about the oscillator, which is the other half of the drift and
 * is unmeasurable from here: `separationMs`.
 */
export function driftMs(
  run88: number,
  ticks: number,
  hz = TICK_STOCK_HZ,
  ideal88 = run88,
): Drift {
  const clock = new BeatClock(run88)
  let maxMs = 0
  let finalMs = 0
  for (let t = 1; t <= ticks; t++) {
    if (!clock.tick()) continue
    finalMs = (t - (clock.beats * ideal88) / ONE) * tickMs(hz)
    maxMs = Math.max(maxMs, Math.abs(finalMs))
  }
  return { beats: clock.beats, maxMs, finalMs }
}

/**
 * How far apart two pairs get, when each unit's tick is within `ppm` of nominal.
 *
 * Worst case, so the two errors have opposite signs and the relative rate error is
 * `2 * ppm`. It is the number that decides whether tap tempo is a festival feature or
 * a thirty-second novelty, and **nothing in this repo knows which `ppm` to pass**.
 */
export const separationMs = (elapsedMs: number, ppm = PPM_RC): number =>
  (elapsedMs * 2 * ppm) / 1e6

/** How long two pairs stay within `ms` of each other. The inverse of `separationMs`. */
export const secondsToSeparate = (ms: number, ppm = PPM_RC): number =>
  ms / 1000 / ((2 * ppm) / 1e6)

/**
 * A unit's own tick error, from its stamps against the host's clock.
 *
 * The experiment that settles crystal-versus-RC, and it needs two button events and a
 * stopwatch rather than more disassembly. Positive means the unit's ticks are slow
 * (it counted fewer than the wall clock says it should have).
 */
export const measuredPpm = (
  ticks: number,
  hostMs: number,
  hz = TICK_STOCK_HZ,
): number => ((hostMs - ticks * tickMs(hz)) / hostMs) * 1e6

/**
 * The smallest tick error a capture of this length can resolve, given arrival jitter.
 *
 * Both stamps are read at host arrival time, so the jitter is the floor on the answer
 * and the capture length is the only lever. At 50 ms of jitter: 5 s of capture
 * resolves 1%, which is the whole crystal-or-RC question, and 20 ppm needs 40 minutes.
 */
export const ppmResolution = (hostMs: number, jitterMs = NOTICEABLE_MS): number =>
  (jitterMs / hostMs) * 1e6

/**
 * A beat as bar heights `rhythm.encode` takes, so a host can show one with no
 * firmware of ours anywhere.
 *
 * Full height on the beat, falling to nothing by the next: the smallest thing that
 * makes a grid visible across a field, and one 16-byte write rather than 24. Anything
 * richer is `rhythm.fromSpectrum` with this phase as its clock rather than a new
 * pattern language here.
 */
export function beatBars(phase: number, style: Style = 0): number[] {
  const level = Math.round(MAX_HEIGHT * (1 - Math.min(1, Math.max(0, phase))))
  return new Array(barCount(style)).fill(level)
}
