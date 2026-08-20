/**
 * The animation tick, 50 Hz to 100 Hz: the first slot feature, and the patch that
 * `notes/what-to-build.md` ranks first.
 *
 * Two halves, and the split is not a choice:
 *
 *  - **the rate and its compensations are edits to the image**, made at build time and
 *    delivered by SWD. The rate is one immediate handed to the vendor's `TIMER_Open`;
 *    every timeout that counts ticks has to double in the same image or it halves in
 *    wall-clock time, and one of those timeouts is the two-second hold that is the only
 *    power switch on the device.
 *  - **the slot half reports what the running image actually contains.** `TICK ASK`
 *    reads the rate immediate and the hold immediate back out of flash and answers with
 *    both, so `jgx.powerOffIntact()` can be evaluated against a real unit rather than
 *    trusted. `TICK SET` accepts only the rate the image is compensated for, and refuses
 *    anything that would change the length of the hold.
 *
 * **A slot cannot carry the rate change itself, and this is worth being plain about**
 * because `notes/patch-over-bt.md` lists the animation tick among the things that
 * "becomes a slot rather than a probe session". The rate lives in a vendor immediate in
 * the application region; a slot's guard bounds every flash write to the slot itself, so
 * a slot cannot edit it. A slot *could* halve the timer's compare register at run time,
 * and that is exactly what must not happen: the compensated immediates are fixed for one
 * rate, so raising the rate under them turns the two-second power-off into one second.
 * The rate is therefore build-time only, and the slot's job is to prove it landed.
 *
 * ## What doubling everything buys, since it is not what the ranking says
 *
 * `notes/what-to-build.md` says the tick patch "doubles the smoothness of everything
 * device-side". Compensated, it doubles the **resolution** and changes nothing else:
 * every built-in animation, every scroll speed and the button behave exactly as they did,
 * because every divisor doubled with the tick. What is new is that a divisor can now be
 * odd, so the smallest step in scroll rate is 10 ms rather than 20, and content whose
 * divisor we choose can move at rates stock could not express. Sub-column scroll
 * interpolation, the ranked patch below this one, is what turns that resolution into
 * visible smoothness.
 *
 * Uncompensated it would double every animation speed, which is not smoothness either.
 *
 * ## Nothing here has run on silicon
 *
 * The sites are found in an image by `timebase.ts` and the edits are asserted against
 * the bytes they replace. `research/tools/thumbsim.ts` executes the slot half and the
 * vendor's own button handler through the patched tick, which is worth much more than
 * "it assembles" and much less than "it ran": the model has no time, no interrupts and
 * no BLE stack. No unit carries any of this.
 */
import * as jgx from '../../../packages/core/src/jgx.js'
import type { Asm } from '../thumb.js'
import type { Note } from '../ext.js'
import type { Feature, FeatureContext, ImageEdit } from './index.js'
import {
  findThresholdWrites,
  findTimebase,
  walkFrom,
  type TickCompare,
  type Timebase,
  type Walk,
} from './timebase.js'

const hex = (n: number) => '0x' + (n >>> 0).toString(16)

/** The rate the patch asks for. Stock is `jgx.TICK_STOCK_HZ`. */
export const TICK_TARGET_HZ = 100

/**
 * `hold == POWER_OFF_SECONDS * hz`, as a shift: `thumb.ts` emits no multiply.
 *
 * Computed rather than written as 1, so if the hold ever stops being a power-of-two
 * number of seconds this throws while a tool is being built instead of emitting a check
 * that quietly tests the wrong thing.
 */
const HOLD_SHIFT = Math.log2(jgx.POWER_OFF_SECONDS)
if (!Number.isInteger(HOLD_SHIFT)) {
  throw new Error(`the hold is ${jgx.POWER_OFF_SECONDS} s, which is not a power of two, ` +
    'so the firmware cannot check it with a shift and this feature needs a multiply')
}

/** One immediate the patch doubles, with everything needed to say why. */
export interface Compensation {
  /** The instruction holding the limit. */
  at: number
  /** Its current value, and what it becomes. */
  from: number
  to: number
  /** `cmp` for a timeout compared in place, `movs` for one stored into a RAM limit. */
  form: 'cmp' | 'movs'
  /** The RAM slot being counted, or the RAM limit being written. */
  slot: number | null
  why: string
}

export interface TickFacts {
  timebase: Timebase
  /** The compare that measures the long press, and the ticks it counts. */
  holdAt: number
  holdTicks: number
  /** Every limit that has to move with the rate. */
  compensations: Compensation[]
  /** Counters whose meaning the walk could not settle. Reported, never patched. */
  unsettled: string[]
  walk: Walk
}

const encodeImm = (ins: number, imm: number) => ((ins & 0xff00) | (imm & 0xff)) >>> 0
const halfword = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff])

/**
 * Find the tick, and every limit that counts it, in one image.
 *
 * The enumeration and its three holes are `timebase.ts`. What this adds is the
 * judgement: which of those limits the patch may touch.
 *
 *  - **only counters the walk classified as counting ticks.** An `event` counter's limit
 *    is a count of something else - modes, animation frames, phases of the power-on
 *    sequence - and doubling one changes what the device does rather than when. The
 *    button's mode index is the sharp example: 21 modes would become 42, of which
 *    eleven are values `set_mode` rejects.
 *  - **only immediates that still fit.** `cmp rN,#imm8` holds 255, so a limit above 127
 *    cannot double, and the patch refuses rather than emitting a wider encoding into
 *    two bytes that are not there.
 *  - **the long press is required, not optional.** If the compare that counts it cannot
 *    be found, there is no patch at all: raising the rate without it halves the only
 *    power switch.
 */
export function resolveTick(
  image: Uint8Array,
  base: number,
): { facts: TickFacts | null; notes: Note[] } {
  const found = findTimebase(image, base)
  const notes = [...found.notes]
  if (!found.timebase) return { facts: null, notes }
  const timebase = found.timebase

  const walk = walkFrom(image, base, timebase.perTick)
  notes.push(...walk.notes)
  if (walk.notes.some((n) => n.severity === 'fatal')) return { facts: null, notes }

  const u16 = (a: number) => image[a - base] | (image[a - base + 1] << 8)
  const tickCompares = walk.compares.filter((c) => c.counter.kind === 'tick')

  // The long press, and the invariant is the identification. It counts ticks, it lives
  // in a function the ISR calls directly, and its limit is what makes the hold two
  // seconds at whatever rate the image asks for. That resolves on a stock image (100 at
  // 50 Hz) and on an already-patched one (200 at 100 Hz), without either number being
  // written down here.
  const wantHold = timebase.hz * jgx.POWER_OFF_SECONDS
  const holds = tickCompares.filter(
    (c) => c.imm === wantHold && timebase.perTick.includes(c.fn),
  )
  if (holds.length !== 1) {
    notes.push({
      severity: 'fatal',
      message: `${holds.length} compares in the code the tick ISR calls directly test a ` +
        `tick counter against ${wantHold}, which at ${timebase.hz} Hz is the ` +
        `${jgx.POWER_OFF_SECONDS} second hold that powers the unit off ` +
        `(${holds.map((h) => hex(h.at)).join(', ') || 'none'}). There has to be exactly ` +
        'one: the hold is the only power switch on the device, and doubling the tick ' +
        'without doubling it halves the hold. No tick patch without it',
    })
    return { facts: null, notes }
  }
  const hold = holds[0]

  const compensations: Compensation[] = []
  const refusals: string[] = []
  const push = (c: Compensation) => compensations.push(c)

  for (const c of tickCompares) {
    if (c.imm === null) continue //   compared against a RAM limit; handled below
    const ins = u16(c.at)
    if ((ins & 0xf800) !== 0x2800) {
      refusals.push(`${hex(c.at)} is ${hex(ins)}, not a cmp with an immediate`)
      continue
    }
    push({
      at: c.at,
      from: c.imm,
      to: c.imm * 2,
      form: 'cmp',
      slot: c.counter.addr,
      why: c.at === hold.at
        ? `the ${jgx.POWER_OFF_SECONDS} second hold that powers the unit off`
        : `ticks counted at ${c.counter.addr === null ? 'an unresolved slot' : hex(c.counter.addr)}`,
    })
  }

  // Limits that live in RAM rather than in the instruction. The ten `SPEED` divisors are
  // all of them: the handler is a chain of compares that each `movs` a divisor and
  // branch to one shared store, and none of it is anywhere near the tick.
  const ramLimits = [...new Set(
    tickCompares.map((c: TickCompare) => c.limit).filter((l): l is number => l !== null),
  )]
  for (const limit of ramLimits) {
    const writes = findThresholdWrites(image, base, limit)
    if (!writes.length) {
      notes.push({
        severity: 'fatal',
        message: `a tick counter is compared against the RAM byte at ${hex(limit)} and ` +
          'nothing in the image is written into it by a scan this tool can follow, so ' +
          'the number that limit holds cannot be compensated. It would halve',
      })
      continue
    }
    for (const w of writes) {
      for (const f of w.feeders) {
        const ins = u16(f.at)
        if ((ins & 0xf800) !== 0x2000) {
          refusals.push(`${hex(f.at)} is ${hex(ins)}, not a movs with an immediate`)
          continue
        }
        push({
          at: f.at,
          from: f.imm,
          to: f.imm * 2,
          form: 'movs',
          slot: limit,
          why: `a limit written to ${hex(limit)} at ${hex(w.at)}, which a tick counter ` +
            'is compared against',
        })
      }
    }
  }

  if (refusals.length) {
    notes.push({
      severity: 'fatal',
      message: `${refusals.length} limit(s) are not the instruction this tool expects: ` +
        refusals.join('; ') + '. Nothing is emitted, because a rate that doubles with ' +
        'one timeout left behind is a timeout that halves',
    })
    return { facts: null, notes }
  }

  const unsettled = [...new Set(
    walk.counters.filter((c) => c.kind !== 'tick')
      .map((c) => `${c.addr === null ? `${hex(c.fn)}+${c.off}` : hex(c.addr)} (${c.kind})`),
  )]

  notes.push({
    severity: 'warn',
    message: `tick: ${timebase.hz} Hz at ${hex(timebase.freqAt)}, ` +
      `${compensations.length} limit(s) counting it, the hold at ${hex(hold.at)} ` +
      `counting ${hold.imm} ticks, and ${unsettled.length} counter(s) left alone ` +
      `because they count something else: ${unsettled.join(', ')}`,
  })

  return {
    facts: { timebase, holdAt: hold.at, holdTicks: hold.imm!, compensations, unsettled, walk },
    notes,
  }
}

/**
 * The edits: the rate, and every limit that counts it.
 *
 * Whole halfwords, not the immediate byte alone. The expectation is then the entire
 * instruction, so an address that is off by two bytes fails the `patch.ts` check instead
 * of quietly rewriting the low byte of something else.
 */
export function tickEdits(
  facts: TickFacts,
  image: Uint8Array,
  base: number,
): { edits: ImageEdit[]; notes: Note[] } {
  const notes: Note[] = []
  const u16 = (a: number) => image[a - base] | (image[a - base + 1] << 8)
  const { timebase } = facts

  if (timebase.hz !== jgx.TICK_STOCK_HZ) {
    notes.push({
      severity: 'fatal',
      message: `this image already asks TIMER0 for ${timebase.hz} Hz, so it is not ` +
        'stock and doubling it again would take the tick to ' +
        `${timebase.hz * 2} Hz and halve every timeout that was compensated for ` +
        `${timebase.hz}. Build from a stock image`,
    })
    return { edits: [], notes }
  }

  const tooWide = facts.compensations.filter((c) => c.to > 0xff)
  if (tooWide.length) {
    notes.push({
      severity: 'fatal',
      message: `${tooWide.length} limit(s) cannot double: ` +
        tooWide.map((c) => `${hex(c.at)} holds ${c.from} and ${c.to} does not fit in an ` +
          `8-bit immediate (${c.why})`).join('; ') +
        '. The patch is all or nothing, because a rate that doubles with one timeout ' +
        'left behind is a timeout that halves',
    })
    return { edits: [], notes }
  }

  const freqIns = u16(timebase.freqAt)
  const edits: ImageEdit[] = [{
    abs: timebase.freqAt,
    expect: halfword(freqIns),
    to: halfword(encodeImm(freqIns, TICK_TARGET_HZ)),
    note: `animation tick ${timebase.hz} -> ${TICK_TARGET_HZ} Hz, the frequency handed ` +
      `to TIMER_Open at ${hex(timebase.openCallAt)}`,
  }]

  for (const c of facts.compensations) {
    const ins = u16(c.at)
    edits.push({
      abs: c.at,
      expect: halfword(ins),
      to: halfword(encodeImm(ins, c.to)),
      note: `${c.form} ${c.from} -> ${c.to}: ${c.why}`,
    })
  }

  const ms = (ticks: number, hz: number) => (ticks * 1000) / hz
  notes.push({
    severity: 'warn',
    message: `the hold at ${hex(facts.holdAt)} stays ` +
      `${ms(facts.holdTicks, timebase.hz)} ms: ${facts.holdTicks} ticks at ` +
      `${timebase.hz} Hz becomes ${facts.holdTicks * 2} at ${TICK_TARGET_HZ} Hz`,
  })
  return { edits, notes }
}

/**
 * The slot half: `TICK`, which reads the image's own immediates back and reports them.
 *
 * `ASK` answers `MSG.TICK` with the rate and the hold count. `SET` answers the same when
 * the rate asked for is the one this image is compensated for, and `MSG.ACK` with
 * `STATUS.REFUSED` when it is not. **Both numbers are read out of flash at the moment of
 * asking**, from the vendor's own `movs` and `cmp` immediates, so what comes back is
 * what the running image contains rather than what a build script believed.
 *
 * The invariant is checked in the firmware, not only in the app: `SET` refuses unless
 * the hold count is exactly `POWER_OFF_SECONDS` times the rate. So an image whose tick
 * was raised without its compensations refuses every rate change and reports the truth,
 * and `jgx.powerOffIntact()` on the reply says the same thing on the phone.
 */
function emitTick(a: Asm, ctx: FeatureContext, facts: TickFacts): void {
  const { arg } = ctx
  a.label('tick')
  a.push(['r4', 'r5', 'r6', 'lr'])
  a.mov('r4', 'r0') //                           the frame struct
  a.ldrPool('r5', 'tick_freq_at')
  a.ldrb('r5', 'r5', 0) //                       the rate this image asks for
  a.ldrPool('r6', 'tick_hold_at')
  a.ldrb('r6', 'r6', 0) //                       ticks the hold counts
  a.ldrb('r0', 'r4', arg(3)) //                  ASK or SET
  a.cmp('r0', jgx.SET)
  a.bcond('ne', 'tick_report') //                anything else is a read
  a.ldrb('r0', 'r4', arg(4)) //                  the rate asked for
  a.cmp('r0', 0)
  a.bcond('eq', 'tick_bad_arg')
  a.cmpReg('r0', 'r5')
  a.bcond('ne', 'tick_refused') //               not the rate this image can run
  // **The power switch, checked rather than assumed.** The compensations are fixed for
  // one rate, so a rate whose hold is not POWER_OFF_SECONDS long is a rate this image
  // must not run at, whatever the phone asked for.
  a.lsls('r0', 'r5', HOLD_SHIFT)
  a.cmpReg('r0', 'r6')
  a.bcond('ne', 'tick_refused')

  a.label('tick_report')
  a.lsrs('r0', 'r6', 8) //                       hold, high byte: payload byte 4
  a.push(['r0'])
  a.movs('r0', 0xff)
  a.ands('r0', 'r6')
  a.lsls('r0', 'r0', 24) //                      hold, low byte
  a.lsls('r1', 'r5', 16) //                      the rate
  a.orrs('r0', 'r1')
  a.ldrPool('r1', 'tick_head')
  a.orrs('r0', 'r1')
  a.push(['r0'])
  a.movs('r0', 5)
  a.mov('r1', 'sp')
  a.bl(ctx.notify)
  a.pop(['r0'])
  a.pop(['r1'])
  a.pop(['r4', 'r5', 'r6', 'pc'])

  a.label('tick_bad_arg')
  a.movs('r0', jgx.STATUS.BAD_ARG)
  a.b('tick_ack')
  a.label('tick_refused')
  a.movs('r0', jgx.STATUS.REFUSED)
  a.label('tick_ack')
  a.lsls('r0', 'r0', 24)
  a.ldrPool('r1', 'tick_ack_head')
  a.orrs('r0', 'r1')
  a.push(['r0'])
  a.movs('r0', 4)
  a.mov('r1', 'sp')
  a.bl(ctx.notify)
  a.pop(['r1'])
  a.pop(['r4', 'r5', 'r6', 'pc'])

  a.align(4)
  a.label('tick_head').word((ctx.marker | (jgx.MSG.TICK << 8)) >>> 0)
  a.label('tick_ack_head').word(
    (ctx.marker | (jgx.MSG.ACK << 8) | (jgx.SUB.TICK << 16)) >>> 0,
  )
  // The two vendor immediates this feature reads, as addresses. A slot is assembled for
  // one image as well as for one slot: these are that image's, and the resident
  // dispatcher's assembled-for check is what stops a body being run anywhere else.
  a.label('tick_freq_at').word(facts.timebase.freqAt)
  a.label('tick_hold_at').word(facts.holdAt)
}

/** The feature, ready to be put in a slot. */
export const tick: Feature<TickFacts> = {
  id: 'tick',
  summary: 'the animation tick at 100 Hz, every timeout that counts it compensated, ' +
    'and a report of both so the hold can be checked rather than trusted',
  capability: jgx.CAP.TICK,
  subcommands: [{ id: jgx.SUB.TICK, label: 'tick' }],
  resolve: resolveTick,
  edits: tickEdits,
  emit: emitTick,
}
