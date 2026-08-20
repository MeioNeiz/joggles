/**
 * The tick, and the timeouts that count it, on both images.
 *
 * Two kinds of test here and the second is the one that matters. The first pins what the
 * analysis finds, on the APK container and on a real unit's dump, so a change in either
 * the rule or an image shows up here rather than on a bench. The second **executes the
 * vendor's own button handler** through the tick, with the button held down in a model
 * of the GPIO, and measures how long the hold takes before and after the patch. That is
 * the question the whole feature turns on: the two second hold is the only power switch
 * on the device, and doubling the tick halves every timeout that counts it.
 *
 * What a pass is worth: `research/tools/thumbsim.ts`'s header lists what the model does
 * not cover, and the big ones are time, interrupts and the BLE stack. Nothing here has
 * run on silicon; no unit carries any of this.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import * as ota from '../../../packages/core/src/ota.js'
import * as jgx from '../../../packages/core/src/jgx.js'
import { machine, Fmc, DONE, type Peripheral } from '../thumbsim.js'
import {
  findThresholdWrites,
  findTimebase,
  walkFrom,
  TIMER0_BASE,
} from './timebase.js'
import { resolveTick, tickEdits, TICK_TARGET_HZ } from './tick.js'

const DONOR = 'firmware/dump-12E69E-2026-08-19-a.bin'
const STOCK = 'firmware/TR1906R04-10_OTA.bin'
const BASE = 0x16800

/** GPIO port 5's block, where the one button read in the image lives. */
const GPIO_P5 = 0x50004280
/** `GPIO_PIN_DATA(5,2)`, *verified* in `research/firmware-internals.md`. */
const BUTTON_PIN = GPIO_P5 + 0x28

const donorWindow = () =>
  new Uint8Array(readFileSync(DONOR)).slice(BASE, 0x29400)
const apkImage = () =>
  ota.plaintext(new Uint8Array(readFileSync(STOCK)))

/** Apply the tick feature's own edits, so the patched image is the shipped one. */
function patched(image: Uint8Array): Uint8Array {
  const out = image.slice()
  const facts = resolveTick(image, BASE).facts!
  for (const e of tickEdits(facts, image, BASE).edits) {
    const at = e.abs - BASE
    for (let i = 0; i < e.expect.length; i++) {
      expect(out[at + i]).toBe(e.expect[i])
      out[at + i] = e.to[i]
    }
  }
  return out
}

describe.if(existsSync(STOCK))('finding the tick in the APK image', () => {
  const image = apkImage()

  test('the ISR is two calls, and the frequency is one immediate', () => {
    const { timebase: tb } = findTimebase(image, BASE)
    expect(tb).not.toBeNull()
    expect(tb!.timer).toBe(TIMER0_BASE)
    expect(tb!.hz).toBe(jgx.TICK_STOCK_HZ)
    // The addresses this file has never hardcoded, resolved by content, and they agree
    // with `research/firmware-internals.md`'s "TIMER0 ... ISR abs 0x17ef8".
    expect(tb!.isrAt).toBe(0x17ef8)
    expect(tb!.freqAt).toBe(0x18052)
    expect(tb!.perTick).toEqual([0x2162c, 0x22030])
  })

  test('the per-tick jump table is resolved, all 33 arms', () => {
    const tb = findTimebase(image, BASE).timebase!
    const walk = walkFrom(image, BASE, tb.perTick)
    const driver = walk.tables.find((t) => t.at === 0x22048)
    expect(driver).toBeDefined()
    expect(driver!.tableAt).toBe(0x2204a)
    expect(driver!.count).toBe(33)
  })

  test('the counters are classified, and the mode index is not a duration', () => {
    const tb = findTimebase(image, BASE).timebase!
    const walk = walkFrom(image, BASE, tb.perTick)
    const kind = (addr: number) =>
      walk.counters.find((c) => c.addr === addr)?.kind
    // Incremented at the top of the button handler, before any compare: a duration.
    expect(kind(0x20003070)).toBe('tick')
    // The debouncer's stability count, likewise.
    expect(kind(0x20003088)).toBe('tick')
    // The animation frame divisor, incremented in twenty-three mode arms.
    expect(kind(0x20003728)).toBe('tick')
    // The mode index: one of its two increments happens only after the long press
    // fired, so what it counts is presses. **Doubling its 21 would give 42 modes.**
    expect(kind(0x2000306c)).toBe('mixed')
    // An animation's frame index, stepped when the divisor crosses.
    expect(kind(0x2000374d)).toBe('event')
    // The power-on sequence's phase, stepped when its step function reports done.
    expect(kind(0x20003714)).toBe('event')
  })

  test('the ten SPEED divisors are found, which one backwards look would not', () => {
    const tb = findTimebase(image, BASE).timebase!
    const walk = walkFrom(image, BASE, tb.perTick)
    const limits = [...new Set(walk.compares
      .filter((c) => c.counter.kind === 'tick')
      .map((c) => c.limit)
      .filter((l): l is number => l !== null))]
    expect(limits).toEqual([0x2000266e])
    const writes = findThresholdWrites(image, BASE, limits[0])
    expect(writes.length).toBe(1)
    // Ten `movs` reaching one shared `strb`, and they are exactly the divisors
    // `protocol.SPEED_LADDER` models, which is a cross-check on both.
    expect(writes[0].feeders.map((f) => f.imm).sort((a, b) => a - b))
      .toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  })
})

describe.if(existsSync(DONOR))('finding the tick in a real unit\'s image', () => {
  const image = donorWindow()

  test('the same shape, none of the same addresses', () => {
    const { timebase: tb } = findTimebase(image, BASE)
    expect(tb).not.toBeNull()
    expect(tb!.hz).toBe(jgx.TICK_STOCK_HZ)
    expect(tb!.isrAt).toBe(0x17fb4)
    expect(tb!.freqAt).toBe(0x1823a)
    expect(tb!.perTick).toEqual([0x21d48, 0x22a1c])
  })

  test('this build has forty-five per-tick modes, not thirty-three', () => {
    const tb = findTimebase(image, BASE).timebase!
    const walk = walkFrom(image, BASE, tb.perTick)
    const driver = walk.tables.find((t) => t.at === 0x22a34)
    expect(driver?.count).toBe(45)
  })

  test('the hold is found by the invariant rather than by an address', () => {
    const facts = resolveTick(image, BASE).facts
    expect(facts).not.toBeNull()
    expect(facts!.holdAt).toBe(0x21d6c)
    expect(facts!.holdTicks).toBe(jgx.HOLD_TICKS_STOCK)
    expect(jgx.holdSeconds(facts!.timebase.hz, facts!.holdTicks))
      .toBe(jgx.POWER_OFF_SECONDS)
  })

  test('the mode index wraps at 32 here and at 21 on the APK, and neither is touched', () => {
    const facts = resolveTick(image, BASE).facts!
    // 0x200032f0 is this build's mode index. Its limit is 32, so this build cycles
    // more modes than the APK's 21, and both are counts rather than durations.
    expect(facts.unsettled).toContain('0x200032f0 (mixed)')
    expect(facts.compensations.some((c) => c.from === 32)).toBe(false)
  })

  test('every compensation doubles, and every one still fits in eight bits', () => {
    const facts = resolveTick(image, BASE).facts!
    expect(facts.compensations.length).toBeGreaterThan(30)
    for (const c of facts.compensations) {
      expect(c.to).toBe(c.from * 2)
      expect(c.to).toBeLessThanOrEqual(0xff)
    }
    // The hold is one of them, and it is the reason the patch refuses without it.
    expect(facts.compensations.some((c) => c.at === facts.holdAt && c.to === 200)).toBe(true)
  })

  test('the edits are whole instructions, so a wrong address cannot half-land', () => {
    const facts = resolveTick(image, BASE).facts!
    const { edits, notes } = tickEdits(facts, image, BASE)
    expect(notes.some((n) => n.severity === 'fatal')).toBe(false)
    expect(edits.length).toBe(facts.compensations.length + 1)
    for (const e of edits) {
      expect(e.expect.length).toBe(2)
      expect(e.to.length).toBe(2)
      // The opcode half of the halfword never changes: same instruction, new immediate.
      expect(e.to[1]).toBe(e.expect[1])
      expect(e.abs % 2).toBe(0)
    }
    expect(edits[0].abs).toBe(facts.timebase.freqAt)
    expect(edits[0].to[0]).toBe(TICK_TARGET_HZ)
  })

  test('patching an already-patched image is refused rather than doubled again', () => {
    const once = patched(image)
    const facts = resolveTick(once, BASE).facts
    // It still resolves, because the hold is found by the invariant and the invariant
    // still holds at 100 Hz. What refuses is the edit pass.
    expect(facts).not.toBeNull()
    expect(facts!.timebase.hz).toBe(TICK_TARGET_HZ)
    expect(facts!.holdTicks).toBe(jgx.HOLD_TICKS_STOCK * 2)
    const { edits, notes } = tickEdits(facts!, once, BASE)
    expect(edits).toEqual([])
    expect(notes.some((n) => n.severity === 'fatal')).toBe(true)
  })
})

/**
 * The measurement, and the reason this file exists.
 *
 * The vendor's button handler is run once per simulated tick with the button held down,
 * and what is counted is how many ticks pass before the firmware toggles its own on/off
 * flag. Everything the handler calls **except the debouncer** is stubbed, because the
 * debouncer is the only callee that reads the button and the rest reach the panel and
 * the UART; the debouncer is identified as the callee that names GPIO port 5, not by an
 * address.
 *
 * `research/firmware-internals.md` records the behaviour as *derived* and unwitnessed:
 * "the pin is P5.2 (*verified* by hand-decode); the behaviour is *derived* and
 * unwitnessed". This executes it. It stays *derived*, because a model of a GPIO
 * register is not a button.
 */
describe.if(existsSync(DONOR))('holding the button, executed', () => {
  const stock = donorWindow()

  /**
   * Run the button handler `ticks` times and report when the on/off flag moved.
   *
   * `analyse` is the image the addresses come from, which is not always the image being
   * run: `resolveTick` refuses an image whose hold is not two seconds long, and one of
   * the cases worth executing is exactly that image.
   */
  function hold(
    image: Uint8Array,
    opts: { pressed: boolean; ticks: number; analyse?: Uint8Array },
  ) {
    const facts = resolveTick(opts.analyse ?? image, BASE).facts!
    const holdCompare = facts.walk.compares.find((c) => c.at === facts.holdAt)!
    const buttonFn = holdCompare.fn
    /** The struct: the hold counter is at +4, so the flag byte is at +1. */
    const struct = holdCompare.counter.addr! - 4

    // The one callee that reads the button, found by which one names the GPIO block.
    const names = (fn: number) => (facts.walk.functions.get(fn) ?? []).some((at) => {
      const ins = image[at - BASE] | (image[at - BASE + 1] << 8)
      if ((ins & 0xf800) !== 0x4800) return false
      const pool = (((at + 4) >> 2) << 2) + (ins & 0xff) * 4 - BASE
      const v = image[pool] | (image[pool + 1] << 8) |
        (image[pool + 2] << 16) | (image[pool + 3] << 24)
      return (v >>> 0) === GPIO_P5
    })
    const callees = [...facts.walk.functions.keys()].filter((fn) => fn !== buttonFn)
    const debouncer = callees.filter(names)
    expect(debouncer.length).toBe(1)

    // Everything else the handler can reach is stubbed to return zero. What is being
    // measured is the counting, and set_mode and the panel are not part of it.
    const hooks = new Map<number, (m: never) => void>()
    for (const fn of callees) {
      if (fn === debouncer[0]) continue
      hooks.set(fn | 1, ((m: { r: Uint32Array }) => { m.r[0] = 0 }) as never)
    }

    const pin: Peripheral = {
      lo: GPIO_P5,
      hi: GPIO_P5 + 0x40,
      read: (addr) => (addr === BUTTON_PIN && opts.pressed ? 1 : 0),
      write: () => {},
    }
    const timer: Peripheral = { lo: TIMER0_BASE, hi: TIMER0_BASE + 0x40, read: () => 0, write: () => {} }

    const fmc = new Fmc()
    fmc.flash.set(image, BASE)
    const m = machine({ fmc, mmio: [pin, timer], hooks: hooks as never, stopAt: DONE })
    const flag = struct + 1 - 0x20000000
    let firedAt = -1
    for (let t = 1; t <= opts.ticks && firedAt < 0; t++) {
      m.r[15] = buttonFn
      m.r[14] = DONE
      m.run(buttonFn)
      if (m.sram[flag] !== 0) firedAt = t
    }
    // The two numbers are read out of the image being **run**, not the one analysed,
    // which is the same pair of bytes the slot half reports over the wire.
    return {
      firedAt,
      hz: image[facts.timebase.freqAt - BASE],
      holdTicks: image[facts.holdAt - BASE],
    }
  }

  test('stock: the hold takes two seconds, and nothing fires without a press', () => {
    const held = hold(stock, { pressed: true, ticks: 400 })
    // 105 ticks: four for the debouncer to latch the press and 101 more for the hold
    // counter to pass 100. So the hold a wearer feels is 2.1 s rather than 2.0, which
    // is what the model says and nothing has ever timed on a unit.
    expect(held.firedAt).toBe(105)
    expect(jgx.powerOffIntact(held.hz, held.firedAt)).toBe(true)
    expect(hold(stock, { pressed: false, ticks: 400 }).firedAt).toBe(-1)
  })

  test('patched: twice the ticks, the same two seconds', () => {
    const before = hold(stock, { pressed: true, ticks: 400 })
    const after = hold(patched(stock), { pressed: true, ticks: 800 })
    expect(after.hz).toBe(TICK_TARGET_HZ)
    expect(after.holdTicks).toBe(jgx.HOLD_TICKS_STOCK * 2)
    // Twice the ticks, to within the "increment then compare" +1 in each of the two
    // timeouts on the path, neither of which scales.
    expect(Math.abs(after.firedAt - before.firedAt * 2)).toBeLessThanOrEqual(3)
    const seconds = after.firedAt / after.hz
    expect(Math.abs(seconds - before.firedAt / before.hz)).toBeLessThanOrEqual(0.03)
    expect(jgx.powerOffIntact(after.hz, after.firedAt)).toBe(true)
    // And the app's own check on the numbers the device would report agrees.
    expect(jgx.powerOffIntact(after.hz, after.holdTicks)).toBe(true)
    expect(jgx.powerOffIntact(after.hz, jgx.HOLD_TICKS_STOCK)).toBe(false)
  })

  test('the tick alone, with nothing compensated, IS the one second failure', () => {
    // The patch this feature refuses to emit: the rate doubled and the hold left at
    // 100 ticks. Executed, so the failure the ranking warns about is a measurement
    // rather than a sentence in a document.
    const facts = resolveTick(stock, BASE).facts!
    const rateOnly = stock.slice()
    const at = facts.timebase.freqAt - BASE
    rateOnly[at] = TICK_TARGET_HZ
    const held = hold(rateOnly, { pressed: true, ticks: 800, analyse: stock })
    expect(held.hz).toBe(TICK_TARGET_HZ)
    expect(held.holdTicks).toBe(jgx.HOLD_TICKS_STOCK)
    expect(held.firedAt / held.hz).toBeLessThan(1.1)
    expect(jgx.powerOffIntact(held.hz, held.holdTicks)).toBe(false)
  })
})
