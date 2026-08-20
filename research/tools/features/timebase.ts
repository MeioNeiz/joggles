/**
 * The animation tick, and every timeout that counts it.
 *
 * This is the analysis half of the 50-to-100 Hz patch (`notes/what-to-build.md`,
 * "Firmware patches, ranked", where it is ranked first). The patch itself is one
 * immediate: the frequency handed to the vendor's `TIMER_Open`. The reason it has
 * never been built is the sentence next to it, "compensate the tick-counted timeouts
 * in the same patch, or the 2 s power-off becomes 1 s", and **that long press is the
 * only power switch on the device**. So the hard part is not the change, it is
 * knowing that the list of things it breaks is complete.
 *
 * Nothing here has run on silicon and nothing here writes anything. It reads an
 * image and reports addresses. `features/tick.ts` turns the report into edits.
 *
 * ## How the enumeration claims to be complete, and where it is not
 *
 * The tick is TIMER0, periodic, and its ISR is four instructions and two calls
 * (*verified* from the bytes of both builds in hand, decoded by this file rather
 * than quoted from a document). So:
 *
 *  1. **Nothing runs per tick except what those two calls reach.** The walk below
 *     follows every direct branch and both of the dispatcher's `add pc` jump tables
 *     out of them, and reports the functions it reached.
 *  2. **A tick-counted timeout is a counter incremented once per tick and compared
 *     against a limit.** Inside the reached code, every load/increment/store-back
 *     triple is a counter and every compare of a value loaded from one is a timeout.
 *     The walk carries literal-pool values, so a counter is reported with its RAM
 *     address rather than as an offset from an unknown base.
 *  3. **A limit that lives in RAM is not compensable in flash**, so for each of
 *     those the whole image is scanned for the sites that write it, and their
 *     immediates are reported instead. That is what finds the ten `SPEED` divisors,
 *     which are nowhere near the ISR.
 *
 * **Three holes, stated because a complete-looking list is worse than a short one.**
 * A counter stepped by anything other than +1 is not recognised. A counter reached
 * through a pointer chain (`ldr rN,[lit]; ldr rN,[rN]`) is reported without its
 * address and is not patched. And every `blx <reg>` in the reached code is a call
 * this walk cannot follow: they are listed in the notes, and a timeout behind one
 * would be missed. On both builds in hand they are BLE and mode-setup callbacks,
 * none of which counts ticks, but that is an argument from reading them and not a
 * proof.
 */
import type { Note } from '../ext.js'

/** TIMER0, from the vendor's own `TIMER_Open` call site. *verified* both builds. */
export const TIMER0_BASE = 0x40010000

/** `TISR`, the interrupt flag the ISR writes 1 to on its way out. */
export const TIMER_TISR = 0x08

const hex = (n: number) => '0x' + (n >>> 0).toString(16)

// --- Decoding the few forms this needs ---------------------------------------------

export interface Reader {
  base: number
  u16(a: number): number
  u32(a: number): number
  has(a: number, len?: number): boolean
  u8(a: number): number
  end: number
}

export function reader(image: Uint8Array, base: number): Reader {
  const dv = new DataView(image.buffer, image.byteOffset, image.byteLength)
  return {
    base,
    end: base + image.length,
    has: (a, len = 2) => a >= base && a - base + len <= image.length,
    u8: (a) => image[a - base],
    u16: (a) => dv.getUint16(a - base, true),
    u32: (a) => dv.getUint32(a - base, true),
  }
}

/** `ldr rT, [pc, #imm8]`: the pool address it reads, or null. */
function poolOf(r: Reader, at: number): { rt: number; pool: number } | null {
  const ins = r.u16(at)
  if ((ins & 0xf800) !== 0x4800) return null
  const pool = (((at + 4) >> 2) << 2) + (ins & 0xff) * 4
  if (!r.has(pool, 4)) return null
  return { rt: (ins >> 8) & 7, pool }
}

interface Branch {
  kind: 'b' | 'b.cond' | 'bl'
  target: number
  /** Bytes the instruction occupies. */
  len: number
}

function branchOf(r: Reader, at: number): Branch | null {
  const hi = r.u16(at)
  if ((hi & 0xf800) === 0xe000) {
    let imm = hi & 0x7ff
    if (imm & 0x400) imm -= 0x800
    return { kind: 'b', target: at + 4 + imm * 2, len: 2 }
  }
  if ((hi & 0xf000) === 0xd000 && (hi & 0x0f00) < 0x0e00) {
    let imm = hi & 0xff
    if (imm & 0x80) imm -= 0x100
    return { kind: 'b.cond', target: at + 4 + imm * 2, len: 2 }
  }
  if ((hi & 0xf800) === 0xf000 && r.has(at + 2)) {
    const lo = r.u16(at + 2)
    if ((lo & 0xd000) !== 0xd000) return null
    const s = (hi >> 10) & 1
    const i1 = 1 - (((lo >> 13) & 1) ^ s)
    const i2 = 1 - (((lo >> 11) & 1) ^ s)
    let imm =
      (s << 24) | (i1 << 23) | (i2 << 22) | ((hi & 0x3ff) << 12) | ((lo & 0x7ff) << 1)
    if (s) imm -= 1 << 25
    return { kind: 'bl', target: at + 4 + imm, len: 4 }
  }
  return null
}

// --- Finding the tick itself --------------------------------------------------------

export interface Timebase {
  /** TIMER0's register base, as the image names it. */
  timer: number
  /** First instruction of the TIMER0 ISR. */
  isrAt: number
  /** The `pop`/`bx` that ends it. */
  isrEnd: number
  /** The write that clears `TISR`, which is what identifies the ISR. */
  clearAt: number
  /** What the ISR calls, in order. Everything that runs per tick is under these. */
  perTick: number[]
  /** The `bl` that opens the timer. */
  openCallAt: number
  /** The `movs rN, #hz` that carries the tick frequency. One byte, and the patch. */
  freqAt: number
  freqReg: number
  /** Ticks per second the image asks for. 50 on stock. */
  hz: number
}

/**
 * Find the tick source by content: the ISR, and the frequency immediate.
 *
 * Both are anchored on the one literal `0x40010000`. On the APK build it appears
 * twice, on the donor build twice, and in both cases one site is the ISR clearing
 * `TISR` and the other is the call that opens the timer. Everything else about the
 * two builds moved, which is why nothing here is an address.
 */
export function findTimebase(
  image: Uint8Array,
  base: number,
): { timebase: Timebase | null; notes: Note[] } {
  const r = reader(image, base)
  const notes: Note[] = []
  const fatal = (message: string) => {
    notes.push({ severity: 'fatal', message })
    return { timebase: null, notes }
  }

  const pools: number[] = []
  for (let a = base; a + 4 <= r.end; a += 4) {
    if (r.u32(a) === TIMER0_BASE) pools.push(a)
  }
  if (!pools.length) {
    return fatal(`no literal ${hex(TIMER0_BASE)} in this image, so TIMER0 is never ` +
      'named and the animation tick is not where this tool expects it. The tick has to ' +
      'be re-derived by hand before anything is patched')
  }

  const sites: { at: number; rt: number }[] = []
  for (let a = base; a + 2 <= r.end; a += 2) {
    const p = poolOf(r, a)
    if (p && pools.includes(p.pool)) sites.push({ at: a, rt: p.rt })
  }

  // The ISR: `ldr rN,[pc]` then a constant 1 stored at `[rN, #TISR]`. Nothing else in
  // either build writes that register, so the shape is the identification.
  const isrs: { clearAt: number; ldrAt: number }[] = []
  const opens: { at: number; freqAt: number; freqReg: number; hz: number; timerReg: number }[] = []
  for (const s of sites) {
    let sawOne = -1
    for (let k = 1; k <= 4; k++) {
      const at = s.at + k * 2
      if (!r.has(at)) break
      const ins = r.u16(at)
      // movs rX, #1
      if ((ins & 0xf800) === 0x2000 && (ins & 0xff) === 1) {
        sawOne = (ins >> 8) & 7
        continue
      }
      // str rT, [rN, #imm5*4]
      if ((ins & 0xf800) === 0x6000) {
        const off = ((ins >> 6) & 0x1f) * 4
        if ((ins & 7) === sawOne && ((ins >> 3) & 7) === s.rt && off === TIMER_TISR) {
          isrs.push({ clearAt: at, ldrAt: s.at })
        }
        break
      }
    }
    // The open call: the base goes to r0, one immediate goes to r2 (the frequency the
    // vendor's TIMER_Open divides the clock by) and a `bl` follows. The register the
    // frequency sits in is read out of the instruction rather than assumed, because
    // the two builds disagree about registers everywhere else.
    let freqAt = -1
    let freqReg = -1
    let hz = 0
    let toR0 = false
    for (let k = 1; k <= 5; k++) {
      const at = s.at + k * 2
      if (!r.has(at)) break
      const ins = r.u16(at)
      if ((ins & 0xf800) === 0x2000 && (ins & 0xff) > 0) {
        freqAt = at
        freqReg = (ins >> 8) & 7
        hz = ins & 0xff
        continue
      }
      // mov rD, rM (high-register form), the timer base into r0
      if ((ins & 0xff00) === 0x4600) {
        const rd = (ins & 7) | ((ins >> 4) & 8)
        const rm = (ins >> 3) & 0xf
        if (rd === 0 && rm === s.rt) toR0 = true
        continue
      }
      const b = branchOf(r, at)
      if (b?.kind === 'bl') {
        if (freqAt >= 0 && toR0) {
          opens.push({ at, freqAt, freqReg, hz, timerReg: s.rt })
        }
        break
      }
    }
  }

  if (isrs.length !== 1) {
    return fatal(`${isrs.length} places in this image clear TIMER0's TISR ` +
      `(${isrs.map((i) => hex(i.clearAt)).join(', ') || 'none'}). The ISR is what runs ` +
      'per tick and this tool will not guess which of several it is')
  }
  if (opens.length !== 1) {
    return fatal(`${opens.length} places in this image look like the call that opens ` +
      `TIMER0 with a frequency (${opens.map((o) => hex(o.at)).join(', ') || 'none'}). ` +
      'The tick rate is one immediate at that call site and there has to be exactly one')
  }
  const open = opens[0]
  const { clearAt, ldrAt } = isrs[0]

  // The ISR's own bounds. Backwards to the nearest `push {..., lr}`, forwards to the
  // `pop {..., pc}` after the TISR write. Asserted small: the whole point of the shape
  // check is that this function is four instructions and two calls.
  let isrAt = -1
  for (let a = ldrAt - 2; a >= base && a >= ldrAt - 24; a -= 2) {
    if ((r.u16(a) & 0xfe00) === 0xb400 && (r.u16(a) & 0x0100) !== 0) {
      isrAt = a
      break
    }
  }
  if (isrAt < 0) {
    return fatal(`the TISR write at ${hex(clearAt)} has no push-with-lr within 24 ` +
      'bytes before it, so the ISR\'s first instruction cannot be found and the calls ' +
      'it makes cannot be enumerated')
  }
  let isrEnd = -1
  for (let a = clearAt + 2; r.has(a) && a <= clearAt + 12; a += 2) {
    const ins = r.u16(a)
    if ((ins & 0xfe00) === 0xbc00 && (ins & 0x0100) !== 0) { isrEnd = a; break }
    if ((ins & 0xff87) === 0x4700) { isrEnd = a; break }
  }
  if (isrEnd < 0) {
    return fatal(`the TISR write at ${hex(clearAt)} is not followed by a return within ` +
      '12 bytes, so this is not the small ISR both builds in hand have')
  }

  const perTick: number[] = []
  for (let a = isrAt; a < isrEnd; ) {
    const b = branchOf(r, a)
    if (b?.kind === 'bl') {
      perTick.push(b.target)
      a += b.len
      continue
    }
    if ((r.u16(a) & 0xff87) === 0x4780) {
      notes.push({
        severity: 'fatal',
        message: `the ISR at ${hex(isrAt)} makes an indirect call at ${hex(a)}. What ` +
          'runs per tick would then be a function pointer in RAM, and nothing offline ' +
          'can enumerate the timeouts under it',
      })
      return { timebase: null, notes }
    }
    a += 2
  }
  if (!perTick.length) {
    return fatal(`the ISR at ${hex(isrAt)} calls nothing, so either it is not the ` +
      'animation tick or the tick does its work inline, and either way the enumeration ' +
      'below would be empty for the wrong reason')
  }

  notes.push({
    severity: 'warn',
    message: `tick: TIMER0 opened at ${hex(open.at)} with ${open.hz} Hz from the ` +
      `immediate at ${hex(open.freqAt)} (r${open.freqReg}); ISR ${hex(isrAt)}-` +
      `${hex(isrEnd)} clears TISR at ${hex(clearAt)} and calls ` +
      perTick.map(hex).join(', '),
  })
  return {
    timebase: {
      timer: TIMER0_BASE,
      isrAt,
      isrEnd,
      clearAt,
      perTick,
      openCallAt: open.at,
      freqAt: open.freqAt,
      freqReg: open.freqReg,
      hz: open.hz,
    },
    notes,
  }
}

// --- Walking what runs per tick ------------------------------------------------------

/** Where a register's value came from, so a compare can be attributed to a counter. */
interface Prov {
  reg: number
  off: number
  size: 'b' | 'w'
  /** Resolved RAM address, when the base register held a known literal. */
  addr: number | null
  /** Has +1 been applied since the load? */
  bumped: boolean
}

interface State {
  /** Known constant per low register: a literal-pool word or a `movs` immediate. */
  lit: (number | null)[]
  prov: (Prov | null)[]
  /**
   * Registers holding a value a call returned.
   *
   * Tracked because "this increment happens once per tick" is false when the
   * increment is gated on what a subroutine answered: the power-on animation counts
   * how many times its step function reported done, not how many ticks passed, and
   * doubling that limit doubles the number of repeats.
   */
  call: boolean[]
}

const cloneState = (s: State): State => ({
  lit: [...s.lit],
  prov: s.prov.map((p) => (p ? { ...p } : null)),
  call: [...s.call],
})

const sameProv = (a: Prov | null, b: Prov | null): boolean =>
  a === b ||
  (!!a && !!b && a.reg === b.reg && a.off === b.off && a.size === b.size &&
    a.addr === b.addr && a.bumped === b.bumped)

/**
 * Meet two states: anything the two paths disagree about becomes unknown.
 *
 * This is what makes the walk terminate. Carrying one state per path is exponential
 * in the branches, and the per-tick mode driver has thirty-three arms over a function
 * with a literal pool it reloads: the first draft ran 400,000 instructions and gave
 * up. Losing a value at a join under-claims, which costs a compare that is then not
 * offered for patching, and never invents one.
 */
function meet(a: State, b: State): { state: State; changed: boolean } {
  const state: State = { lit: [], prov: [], call: [] }
  let changed = false
  for (let i = 0; i < 8; i++) {
    const lit = a.lit[i] === b.lit[i] ? a.lit[i] : null
    if (lit !== a.lit[i]) changed = true
    state.lit[i] = lit
    const prov = sameProv(a.prov[i], b.prov[i]) ? a.prov[i] : null
    if (prov !== a.prov[i]) changed = true
    state.prov[i] = prov ? { ...prov } : null
    const call = a.call[i] && b.call[i]
    if (call !== a.call[i]) changed = true
    state.call[i] = call
  }
  return { state, changed }
}

/**
 * What a counter counts, which is the whole safety question.
 *
 * `tick` is incremented on a path that runs every tick, so its limit is a duration
 * and doubling the tick rate halves it. `event` is incremented only when something
 * else fired: the button's mode index counts presses, an animation's frame index
 * counts the divisor crossing, and the power-on animation's phase counts how many
 * times its step function reported done. **Doubling an `event` limit changes what
 * the device does**: 21 built-in modes would become 42, eleven of which `set_mode`
 * rejects. `mixed` is a counter whose increment sites disagree, which is a question
 * for a person and never a patch.
 */
export type CounterKind = 'tick' | 'event' | 'mixed'

/** A counter: a slot incremented once per pass through the code that holds it. */
export interface Counter {
  /** RAM address, or null when the base register's value was not a known literal. */
  addr: number | null
  reg: number
  off: number
  size: 'b' | 'w'
  /** The store that writes the incremented value back. */
  at: number
  fn: number
  kind: CounterKind
  /** The compare whose outcome gates this increment, for an `event`. */
  gate?: number
}

/** A compare of a counter against a limit. The thing that has to be compensated. */
export interface TickCompare {
  /** The `cmp` instruction. */
  at: number
  reg: number
  fn: number
  counter: Counter
  /** An immediate limit, i.e. `cmp rN, #imm`. */
  imm: number | null
  /** A limit read from RAM, i.e. `cmp rN, rM` where rM came from memory. */
  limit: number | null
}

export interface Walk {
  /** Entry -> every instruction address reached in it. */
  functions: Map<number, number[]>
  /** `blx <reg>` sites: calls this walk cannot follow. */
  indirect: number[]
  /** `add pc, <reg>` jump tables, resolved. */
  tables: { at: number; tableAt: number; count: number; arms: number[] }[]
  counters: Counter[]
  compares: TickCompare[]
  notes: Note[]
}

/** Where an instruction can go next, and with what register state. */
interface Step {
  /** Fallthrough or branch successors inside the same function. */
  next: number[]
  /** Functions this instruction calls. */
  calls: number[]
  /** State after it. */
  after: State
  /** Stops the path: a return, or an unresolvable indirect jump. */
  stop: boolean
}

const RAM = 0x20000000

/** A settled walk over 66 KB costs a few thousand steps; this is a runaway guard. */
const MAX_STEPS = 2_000_000

/**
 * Walk everything reachable from `entries`, then read the register state back.
 *
 * Two passes, because the two questions want different things. The first is a
 * dataflow fixpoint: it establishes which instructions run and what each register
 * holds where they meet, and it terminates because the only move the lattice makes is
 * to forget. The second decodes each reached instruction once against the state that
 * survived, and records the counters and the compares. Recording during the first
 * pass would keep facts that were true on one path and are not true at the join.
 */
export function walkFrom(image: Uint8Array, base: number, entries: number[]): Walk {
  const r = reader(image, base)
  const notes: Note[] = []
  const functions = new Map<number, number[]>()
  const indirect: number[] = []
  const tables: Walk['tables'] = []
  const stateAt = new Map<number, State>()
  const fnOf = new Map<number, number>()
  const fresh = (): State => ({
    lit: Array(8).fill(null),
    prov: Array(8).fill(null),
    call: Array(8).fill(false),
  })

  const queue: { fn: number; at: number; state: State }[] = []
  const enteredFn = new Set<number>()
  const enter = (fn: number) => {
    if (enteredFn.has(fn) || !r.has(fn)) return
    enteredFn.add(fn)
    functions.set(fn, [])
    queue.push({ fn, at: fn, state: fresh() })
  }
  for (const e of entries) enter(e)

  let steps = 0
  while (queue.length) {
    const job = queue.shift()!
    if (++steps > MAX_STEPS) {
      notes.push({
        severity: 'fatal',
        message: `the walk from ${entries.map(hex).join(', ')} did not settle within ` +
          `${MAX_STEPS} steps, so what runs per tick is not established and nothing ` +
          'here may be used to build a patch',
      })
      return { functions, indirect, tables, counters: [], compares: [], notes }
    }
    const { fn, at } = job
    if (!r.has(at)) continue
    const had = stateAt.get(at)
    let state = job.state
    if (had) {
      const m = meet(had, state)
      if (!m.changed) continue
      state = m.state
    }
    stateAt.set(at, cloneState(state))
    fnOf.set(at, fn)
    const body = functions.get(fn)!
    if (!body.includes(at)) body.push(at)
    const step = advance(r, at, state, { indirect, tables, notes })
    if (notes.some((n) => n.severity === 'fatal')) {
      return { functions, indirect, tables, counters: [], compares: [], notes }
    }
    for (const c of step.calls) enter(c)
    if (step.stop) continue
    for (const n of step.next) queue.push({ fn, at: n, state: cloneState(step.after) })
  }

  // Second pass: the facts, read off the states that survived every join.
  const counters: Counter[] = []
  const pending: {
    at: number
    reg: number
    fn: number
    imm: number | null
    limit: number | null
    prov: Prov
  }[] = []
  /** Compares whose outcome is not a duration: on a call's answer, or on a counter. */
  const gates: { at: number; fn: number; onCounter: string | null }[] = []
  /** Stores of a constant into a counter's slot: the crossing that resets it. */
  const resets: { at: number; fn: number; key: string }[] = []
  const succ = new Map<number, number[]>()

  for (const [at, state] of [...stateAt].sort((a, b) => a[0] - b[0])) {
    const ins = r.u16(at)
    const fn = fnOf.get(at)!
    succ.set(at, advance(r, at, state, { indirect: [], tables: [], notes: [] }).next)
    // A store back into the slot the value was loaded from, after a +1.
    if ((ins & 0xe000) === 0x6000 && (ins & 0x0800) === 0) {
      const byte = (ins & 0x1000) !== 0
      const rt = ins & 7
      const rn = (ins >> 3) & 7
      const off = byte ? (ins >> 6) & 0x1f : ((ins >> 6) & 0x1f) * 4
      const prov = state.prov[rt]
      if (prov && prov.bumped && prov.reg === rn && prov.off === off &&
          prov.size === (byte ? 'b' : 'w')) {
        counters.push({ addr: prov.addr, reg: rn, off, size: prov.size, at, fn, kind: 'tick' })
      } else if (state.lit[rt] !== null) {
        // A constant into a slot: a counter being reset, which is what makes the
        // branch above it a crossing rather than an ordinary condition.
        const lit = state.lit[rn]
        const addr = lit === null || lit < RAM ? null : lit + off
        resets.push({
          at,
          fn,
          key: slotKey(fn, { reg: rn, off, size: byte ? 'b' : 'w', addr }),
        })
      }
      continue
    }
    if ((ins & 0xf800) === 0x2800) { //                           cmp rN, #imm8
      const rn = (ins >> 8) & 7
      const prov = state.prov[rn]
      if (prov) pending.push({ at, reg: rn, fn, imm: ins & 0xff, limit: null, prov })
      if (prov) gates.push({ at, fn, onCounter: slotKey(fn, prov) })
      else if (state.call[rn]) gates.push({ at, fn, onCounter: null })
      continue
    }
    if ((ins & 0xffc0) === 0x4280) { //                           cmp rN, rM
      const rn = ins & 7
      const rm = (ins >> 3) & 7
      const prov = state.prov[rn]
      const other = state.prov[rm]
      if (prov) {
        pending.push({ at, reg: rn, fn, imm: null, limit: other?.addr ?? null, prov })
        gates.push({ at, fn, onCounter: slotKey(fn, prov) })
      } else if (state.call[rn] || state.call[rm]) {
        gates.push({ at, fn, onCounter: null })
      }
    }
  }

  // A gate is a compare on a counter or on a call's answer, and nothing else. Filtered
  // here rather than while walking, because whether a slot is a counter is only known
  // once every increment in the reached code has been seen. Compares on plain state -
  // which mode is running, whether the panel is busy - gate nothing: the path they
  // choose still runs every tick.
  const counterKeys = new Set(counters.map(counterKey))
  const realGates = gates.filter((g) => g.onCounter === null || counterKeys.has(g.onCounter))
  classify(counters, realGates, resets, succ, functions, notes)

  const compares: TickCompare[] = []
  for (const c of pending) {
    const counter =
      counters.find((k) => k.fn === c.fn && k.reg === c.prov.reg && k.off === c.prov.off &&
        k.size === c.prov.size) ??
      counters.find((k) => c.prov.addr !== null && k.addr === c.prov.addr)
    if (counter) {
      compares.push({ at: c.at, reg: c.reg, fn: c.fn, counter, imm: c.imm, limit: c.limit })
    }
  }
  if (indirect.length) {
    notes.push({
      severity: 'warn',
      message: `${indirect.length} indirect call(s) in the code that runs per tick: ` +
        indirect.slice(0, 16).map(hex).join(', ') +
        (indirect.length > 16 ? `, and ${indirect.length - 16} more` : '') +
        '. Each is a function pointer this walk cannot follow, so the list of timeouts ' +
        'is complete only for what direct branches reach',
    })
  }
  return { functions, indirect, tables, counters, compares, notes }
}

/** One slot, named so the same RAM word is one counter across functions. */
function slotKey(
  fn: number,
  p: { reg: number; off: number; size: string; addr: number | null },
): string {
  return p.addr !== null ? hex(p.addr) : `${hex(fn)}:r${p.reg}+${p.off}${p.size}`
}

const counterKey = (c: Counter): string =>
  c.addr !== null ? hex(c.addr) : `${hex(c.fn)}:r${c.reg}+${c.off}${c.size}`

/**
 * Dominators over one function's reached instructions.
 *
 * `dom[i]` is every instruction on every path from the entry to `i`. Iterated to a
 * fixpoint, which is cheap here: the largest function either build reaches is a few
 * hundred instructions.
 */
function dominators(entry: number, body: number[], succ: Map<number, number[]>) {
  const inFn = new Set(body)
  const preds = new Map<number, number[]>()
  for (const a of body) {
    for (const n of succ.get(a) ?? []) {
      if (!inFn.has(n)) continue
      preds.set(n, [...(preds.get(n) ?? []), a])
    }
  }
  const dom = new Map<number, Set<number>>()
  for (const a of body) dom.set(a, a === entry ? new Set([entry]) : new Set(body))
  let changed = true
  while (changed) {
    changed = false
    for (const a of body) {
      if (a === entry) continue
      const ps = preds.get(a) ?? []
      if (!ps.length) continue
      let next: Set<number> | null = null
      for (const p of ps) {
        const dp = dom.get(p)!
        next = next === null ? new Set(dp) : new Set([...next].filter((x) => dp.has(x)))
      }
      next!.add(a)
      const cur = dom.get(a)!
      if (next!.size !== cur.size || [...next!].some((x) => !cur.has(x))) {
        dom.set(a, next!)
        changed = true
      }
    }
  }
  return dom
}

/**
 * Decide what each counter counts.
 *
 * **The rule, and it is the load-bearing judgement in this file.** An increment is
 * *gated* when it happens only because a compare went one way, and the compare was
 * either on another counter or on what a subroutine returned. A gated increment
 * counts those outcomes, not ticks. So a counter every one of whose increments is
 * ungated counts ticks; one with a gated increment counts events; one with both is
 * `mixed` and is left alone.
 *
 * Worked on the APK build: the button's tick counter is incremented as the fourth
 * instruction of the handler, before any compare, so it is ungated and its 100 is a
 * duration. The mode index next to it is incremented only after that compare fired,
 * so it counts long presses and its 21 is a count of modes. An animation's divisor is
 * incremented before its own compare, so it is a duration; the frame index below it is
 * incremented only after the divisor crossed, so it is not.
 *
 * A counter's own compare never gates it, or every divisor in the image would read as
 * an event counter.
 */
/** The two ways out of the conditional branch that acts on a compare at `at`. */
function branchesOf(at: number, succ: Map<number, number[]>): number[] {
  for (const a of [at + 2, at + 4]) {
    const next = succ.get(a)
    if (next && next.length >= 2) return next
  }
  return []
}

function classify(
  counters: Counter[],
  gates: { at: number; fn: number; onCounter: string | null }[],
  resets: { at: number; fn: number; key: string }[],
  succ: Map<number, number[]>,
  functions: Map<number, number[]>,
  notes: Note[],
): void {
  const doms = new Map<number, Map<number, Set<number>>>()
  const domsOf = (fn: number) => {
    if (!doms.has(fn)) doms.set(fn, dominators(fn, functions.get(fn) ?? [], succ))
    return doms.get(fn)!
  }
  const verdicts = new Map<string, { tick: number; event: number; gate?: number }>()

  for (const c of counters) {
    const key = counterKey(c)
    const dom = domsOf(c.fn)
    const above = dom.get(c.at) ?? new Set<number>()
    let gate: number | undefined
    for (const g of gates) {
      if (g.fn !== c.fn) continue
      if (g.onCounter !== null && g.onCounter === key) continue //  its own compare
      // Gated when a successor of the compare's branch is on every path to the
      // increment. The compare itself dominating it is not enough: a compare in a
      // straight line before an increment says nothing about which way it went, and
      // the instruction that forks is the `b<cond>` after it rather than the `cmp`.
      const branches = branchesOf(g.at, succ)
      if (branches.length < 2) continue
      // Only the edge on which the compared counter is **reset** gates anything.
      // Crossing a divisor is an event; being on the other side of one is not, and
      // this is the distinction that decides whether the twenty-three sites that
      // step an animation's divisor are read as durations or as event counts. A
      // call's answer has no counter to reset, so either of its edges gates.
      const crossing = g.onCounter === null
        ? branches
        : branches.filter((b) =>
            resets.some((x) => x.fn === g.fn && x.key === g.onCounter && (dom.get(x.at)?.has(b) ?? false)))
      if (crossing.some((b) => b !== c.at && above.has(b))) {
        gate = g.at
        break
      }
    }
    const v = verdicts.get(key) ?? { tick: 0, event: 0 }
    if (gate === undefined) v.tick++
    else {
      v.event++
      v.gate = gate
    }
    verdicts.set(key, v)
  }

  for (const c of counters) {
    const v = verdicts.get(counterKey(c))!
    c.kind = v.event === 0 ? 'tick' : v.tick === 0 ? 'event' : 'mixed'
    if (c.kind !== 'tick') c.gate = v.gate
  }
  const mixed = [...new Set(counters.filter((c) => c.kind === 'mixed').map(counterKey))]
  if (mixed.length) {
    notes.push({
      severity: 'warn',
      message: `${mixed.length} counter(s) have both gated and ungated increments ` +
        `(${mixed.join(', ')}), so what they count is not established and no limit of ` +
        'theirs will be compensated',
    })
  }
}

/** One instruction: where it goes, what it calls, and the state it leaves behind. */
function advance(
  r: Reader,
  at: number,
  state: State,
  sink: { indirect: number[]; tables: Walk['tables']; notes: Note[] },
): Step {
  const ins = r.u16(at)
  const after = cloneState(state)
  const forget = (regs: number[]) => {
    for (const i of regs) {
      after.lit[i] = null
      after.prov[i] = null
      after.call[i] = false
    }
  }

  const b = branchOf(r, at)
  if (b?.kind === 'bl') {
    // The callee may clobber r0-r3 and returns in r0, so keeping their provenance
    // across a call would attribute a compare to a counter the callee never touched.
    forget([0, 1, 2, 3])
    after.call[0] = true
    return { next: [at + b.len], calls: [b.target], after, stop: false }
  }
  if (b?.kind === 'b.cond') return { next: [at + 2, b.target], calls: [], after, stop: false }
  if (b?.kind === 'b') return { next: [b.target], calls: [], after, stop: false }
  if ((ins & 0xfe00) === 0xbc00 && (ins & 0x0100) !== 0) {
    return { next: [], calls: [], after, stop: true } //          pop {..,pc}
  }
  if ((ins & 0xff87) === 0x4700) return { next: [], calls: [], after, stop: true } // bx
  if ((ins & 0xff87) === 0x4780) { //                             blx rN
    if (!sink.indirect.includes(at)) sink.indirect.push(at)
    forget([0, 1, 2, 3])
    after.call[0] = true
    return { next: [at + 2], calls: [], after, stop: false }
  }
  if ((ins & 0xff87) === 0x4487 && ((ins >> 3) & 0xf) !== 15) { //  add pc, rN
    const t = resolveTable(r, at)
    if (!t) {
      sink.notes.push({
        severity: 'fatal',
        message: `the jump table at ${hex(at)} does not have the shape this tool can ` +
          'resolve, so what runs per tick under it is unknown and the enumeration ' +
          'cannot claim to be complete',
      })
      return { next: [], calls: [], after, stop: true }
    }
    if (!sink.tables.some((x) => x.at === t.at)) sink.tables.push(t)
    return { next: t.arms, calls: [], after, stop: false }
  }

  const p = poolOf(r, at)
  if (p) {
    after.lit[p.rt] = r.u32(p.pool)
    after.prov[p.rt] = null
    after.call[p.rt] = false
    return { next: [at + 2], calls: [], after, stop: false }
  }
  if ((ins & 0xf800) === 0x2000) { //                             movs rD, #imm8
    const rd = (ins >> 8) & 7
    after.lit[rd] = ins & 0xff
    after.prov[rd] = null
    after.call[rd] = false
    return { next: [at + 2], calls: [], after, stop: false }
  }
  if ((ins & 0xe000) === 0x6000) { //                             ldr/ldrb/str/strb imm
    const load = (ins & 0x0800) !== 0
    const byte = (ins & 0x1000) !== 0
    const rt = ins & 7
    const rn = (ins >> 3) & 7
    const off = byte ? (ins >> 6) & 0x1f : ((ins >> 6) & 0x1f) * 4
    if (load) {
      const lit = after.lit[rn]
      after.prov[rt] = {
        reg: rn,
        off,
        size: byte ? 'b' : 'w',
        addr: lit === null || lit < RAM ? null : lit + off,
        bumped: false,
      }
      after.lit[rt] = null
      after.call[rt] = false
    }
    return { next: [at + 2], calls: [], after, stop: false }
  }
  if ((ins & 0xfe00) === 0x1c00) { //                             adds rD, rN, #imm3
    const rd = ins & 7
    const rn = (ins >> 3) & 7
    const imm3 = (ins >> 6) & 7
    const prov = state.prov[rn]
    after.lit[rd] = state.lit[rn] === null ? null : state.lit[rn]! + imm3
    after.prov[rd] = imm3 === 1 && prov ? { ...prov, bumped: true } : null
    after.call[rd] = imm3 === 0 && state.call[rn]
    return { next: [at + 2], calls: [], after, stop: false }
  }
  if ((ins & 0xf800) === 0x3000) { //                             adds rDN, #imm8
    const rd = (ins >> 8) & 7
    const imm8 = ins & 0xff
    const prov = state.prov[rd]
    if (after.lit[rd] !== null) after.lit[rd] = after.lit[rd]! + imm8
    after.prov[rd] = imm8 === 1 && prov ? { ...prov, bumped: true } : null
    if (imm8 !== 0) after.call[rd] = false
    return { next: [at + 2], calls: [], after, stop: false }
  }
  const written = writtenReg(ins)
  if (written !== null && written < 8) forget([written])
  return { next: [at + 2], calls: [], after, stop: false }
}

/** Which low register an instruction writes, for the conservative forget above. */
function writtenReg(ins: number): number | null {
  if ((ins & 0xe000) === 0x0000) return ins & 7 //                  shifts, add/sub
  if ((ins & 0xfc00) === 0x4000) { //                               data processing
    const op = (ins >> 6) & 0xf
    return op === 0x8 || op === 0xa ? null : ins & 7 //             tst and cmp write nothing
  }
  if ((ins & 0xfc00) === 0x4400) {
    const op = (ins >> 8) & 3
    if (op === 1) return null //                                    cmp high
    return (ins & 7) | ((ins >> 4) & 8)
  }
  if ((ins & 0xf000) === 0x5000) return ((ins >> 9) & 7) >= 4 ? ins & 7 : null
  if ((ins & 0xf000) === 0x8000) return ins & 0x0800 ? ins & 7 : null
  if ((ins & 0xf800) === 0xa000) return (ins >> 8) & 7
  return null
}

/**
 * Resolve the compiler's `add pc` jump table.
 *
 * The five-instruction idiom both builds emit:
 *
 *     movs rT, rIdx        ; the index
 *     add  rT, pc          ; rT = idx + (here + 4)
 *     ldrb rT, [rT, #4]    ; the byte table starts at that + 4
 *     adds rT, rT, rT      ; halfwords
 *     add  pc, rT          ; targets are relative to (here + 4)
 *
 * The count comes from the bound check above it, `cmp rIdx, #n` with an unsigned
 * branch past the table, because reading one arm too many walks into the arms
 * themselves.
 */
function resolveTable(
  r: Reader,
  addPcAt: number,
): { at: number; tableAt: number; count: number; arms: number[] } | null {
  if (!r.has(addPcAt - 8, 10)) return null
  const addToPc = r.u16(addPcAt - 6) //     add rT, pc
  const ldrb = r.u16(addPcAt - 4)
  const dbl = r.u16(addPcAt - 2)
  if ((addToPc & 0xff78) !== 0x4478) return null
  if ((ldrb & 0xf800) !== 0x7800) return null
  if ((dbl & 0xfe00) !== 0x1800) return null
  const tableAt = addPcAt - 6 + 4 + ((ldrb >> 6) & 0x1f)
  const targetBase = addPcAt + 4
  // The bound: the nearest `cmp rN, #n` before the idiom, followed by an unsigned
  // higher-or-same branch. Without it the arm count is a guess.
  let count = -1
  for (let a = addPcAt - 8; a >= r.base && a >= addPcAt - 40; a -= 2) {
    const ins = r.u16(a)
    if ((ins & 0xf800) !== 0x2800) continue
    const nxt = r.u16(a + 2)
    if ((nxt & 0xff00) !== 0xd200) continue //   bhs
    count = ins & 0xff
    break
  }
  if (count <= 0 || count > 0x80) return null
  const arms: number[] = []
  for (let i = 0; i < count; i++) {
    if (!r.has(tableAt + i, 1)) return null
    const byte = r.u8(tableAt + i)
    const target = targetBase + byte * 2
    if (!r.has(target)) return null
    if (!arms.includes(target)) arms.push(target)
  }
  return { at: addPcAt, tableAt, count, arms }
}

// --- Limits that live in RAM ---------------------------------------------------------

export interface ThresholdWrite {
  /** The store that puts the value in RAM. */
  at: number
  size: 'b' | 'w'
  /**
   * Every `movs rT, #imm` that reaches that store with the value in it.
   *
   * More than one, always, on this compiler: the `SPEED` handler is a chain of ten
   * `cmp`/`movs` pairs that all branch to **one** shared `strb`. A scan that looked
   * only at the instructions before the store found the last of the ten and reported
   * it as the only one, which would have compensated one bucket of the speed ladder
   * and left nine running at double rate.
   */
  feeders: { at: number; imm: number }[]
}

/**
 * Every site in the image that writes a constant to `addr`.
 *
 * For a timeout whose limit is a RAM byte rather than an immediate, this is where the
 * number actually is. It is what finds the ten `SPEED` divisors, which sit in the
 * command handler and are nowhere near the tick.
 *
 * The store is found by a tight local pattern: the base register's literal must be
 * loaded within eight instructions before it, with nothing else writing that register
 * in between. The values are then found by asking which `movs` instructions **reach**
 * that store, either by falling into it or by branching straight to it, which is sound
 * in a way a backwards window is not.
 */
export function findThresholdWrites(
  image: Uint8Array,
  base: number,
  addr: number,
): ThresholdWrite[] {
  const r = reader(image, base)
  const out: ThresholdWrite[] = []
  const WINDOW = 8
  for (let a = base; a + 2 <= r.end; a += 2) {
    const ins = r.u16(a)
    if ((ins & 0xe000) !== 0x6000 || (ins & 0x0800) !== 0) continue //  stores only
    const byte = (ins & 0x1000) !== 0
    const rt = ins & 7
    const rn = (ins >> 3) & 7
    const off = byte ? (ins >> 6) & 0x1f : ((ins >> 6) & 0x1f) * 4
    let baseLit: number | null = null
    for (let k = 1; k <= WINDOW; k++) {
      const at = a - k * 2
      if (at < base) break
      const p = poolOf(r, at)
      if (p && p.rt === rn) {
        baseLit = r.u32(p.pool)
        break
      }
      if (writtenReg(r.u16(at)) === rn) break //   something else produced the base
    }
    if (baseLit === null || baseLit + off !== addr) continue

    const feeders: { at: number; imm: number }[] = []
    const isMovs = (at: number) => {
      const m = r.u16(at)
      return (m & 0xf800) === 0x2000 && ((m >> 8) & 7) === rt
    }
    if (a - 2 >= base && isMovs(a - 2)) feeders.push({ at: a - 2, imm: r.u16(a - 2) & 0xff })
    for (let b = base; b + 4 <= r.end; b += 2) {
      if (!isMovs(b)) continue
      const br = branchOf(r, b + 2)
      if (br?.kind === 'b' && br.target === a) feeders.push({ at: b, imm: r.u16(b) & 0xff })
    }
    out.push({ at: a, size: byte ? 'b' : 'w', feeders })
  }
  return out
}

/**
 * Every site outside the per-tick code that reads one of its counters.
 *
 * The third leg of the completeness argument: a counter incremented per tick can be
 * read anywhere, and a reader elsewhere in the image is measuring time in ticks just
 * as much as the ISR is. Reported rather than patched, because what a reader does
 * with the value is not something this scan can know.
 */
export function findCounterReaders(
  image: Uint8Array,
  base: number,
  addr: number,
  exclude: Set<number>,
): { at: number; size: 'b' | 'w' }[] {
  const r = reader(image, base)
  const out: { at: number; size: 'b' | 'w' }[] = []
  for (let a = base; a + 2 <= r.end; a += 2) {
    const ins = r.u16(a)
    if ((ins & 0xe000) !== 0x6000 || (ins & 0x0800) === 0) continue //  loads only
    const byte = (ins & 0x1000) !== 0
    const rn = (ins >> 3) & 7
    const off = byte ? (ins >> 6) & 0x1f : ((ins >> 6) & 0x1f) * 4
    for (let k = 1; k <= 8; k++) {
      const at = a - k * 2
      if (at < base) break
      const p = poolOf(r, at)
      if (!p || p.rt !== rn) continue
      if (r.u32(p.pool) + off === addr && !exclude.has(a)) out.push({ at: a, size: byte ? 'b' : 'w' })
      break
    }
  }
  return out
}
