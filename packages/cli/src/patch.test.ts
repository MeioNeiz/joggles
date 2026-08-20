/**
 * The slot delivery driver, against a unit that is not there.
 *
 * `FakeUnit` below is a `Transport` that answers `UPD_*` the way
 * `research/tools/updater.ts` does, over a flash array in which **programming can only
 * clear bits**. That one detail is what makes the interesting claims testable rather
 * than asserted: idempotency, the magic word being unforgeable by a partial program,
 * and a slot that cannot validate after an interrupted transfer all fall out of it.
 *
 * **What a pass here is worth.** This is a model of the firmware, written from the same
 * design document, so it cannot witness anything about silicon and no result here may
 * be written up as a finding. What it does check is the client: the order of the frames,
 * the pacing, the gate on the slot base, and what the driver reports about each failure.
 * The firmware's own half is exercised through an ARMv6-M interpreter by
 * `research/tools/updater.test.ts`, which is a different and better witness.
 *
 * Nothing in this file needs a device, and nothing in it can reach one: `patch.ts`
 * imports its noble adapter dynamically, inside `connect`, so loading this test never
 * initialises Bluetooth.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { type Transport, jgx, protocol as p } from '@joggles/core'
import { crc32 } from '@joggles/core/src/ota.js'
import {
  Checked,
  JGX_HDR,
  LEAVES_BEHIND,
  MAX_BODY,
  type PatchDeps,
  SLOT_A,
  SLOT_B,
  SLOT_HDR_LEN,
  SLOT_SIZE,
  type SlotName,
  abort,
  commitSlot,
  inspect,
  openLink,
  readUnit,
  slotsFrom,
  transfer,
  updName,
} from './patch.js'

const HERE = dirname(new URL(import.meta.url).pathname)
const PAGE = 512
const MAGIC_WORD = 0x5358474a // 'JGXS' little-endian
const HDR = { MAGIC: 0, GEN: 4, LEN: 8, CRC: 12 } as const

// --- A unit that is not there ---------------------------------------------------------

interface Write {
  char: string
  block: Uint8Array
  withResponse: boolean
}

interface FakeOptions {
  /** Answer nothing to anything, which is what a stock unit does. */
  stock?: boolean
  version?: number
  capabilities?: number
  /** Drop the reply to these `UPD_DATA` sequence numbers, once each. */
  dropReplyFor?: number[]
  /** Stop answering entirely from this write onwards. */
  goSilentAfter?: number
  /**
   * A unit whose resident half predates the seventh `UPD_STATUS` byte, so it reports
   * which slot is LIVE and never which slot it will WRITE. The host must refuse to
   * assemble against an inverted guess rather than quietly making one.
   */
  oldResident?: boolean
}

/**
 * A `Transport` that behaves like the resident updater.
 *
 * The flash is only the two slots, so an address outside them throws rather than
 * quietly working: the firmware's guard bounds every write to `[SLOT_A, SLOT_B_END)`
 * and a driver that got past it should fail loudly here.
 */
class FakeUnit implements Transport {
  readonly writes: Write[] = []

  readonly programmed: number[] = []

  readonly erased: number[] = []

  private flash = new Uint8Array(SLOT_SIZE * 2).fill(0xff)

  private notify: ((block: Uint8Array) => void) | null = null

  private dropped = new Set<number>()

  constructor(
    private cipher: p.Cipher = p.vendor,
    private opts: FakeOptions = {},
  ) {}

  // --- flash ----------------------------------------------------------------------

  private at(addr: number): number {
    const off = addr - SLOT_A
    if (off < 0 || off + 4 > this.flash.length) throw new Error(`off-slot ${addr}`)
    return off
  }

  word(addr: number): number {
    const off = this.at(addr)
    return new DataView(this.flash.buffer).getUint32(off, true)
  }

  bytes(addr: number, len: number): Uint8Array {
    return this.flash.slice(this.at(addr), this.at(addr) + len)
  }

  /** Programming clears bits and never sets them, which is the whole argument. */
  private program(addr: number, value: number): boolean {
    const off = this.at(addr)
    const dv = new DataView(this.flash.buffer)
    const merged = (dv.getUint32(off, true) & value) >>> 0
    dv.setUint32(off, merged, true)
    this.programmed.push(addr)
    return merged === (value >>> 0)
  }

  private erasePage(addr: number): void {
    const page = addr & ~(PAGE - 1)
    this.flash.fill(0xff, this.at(page), this.at(page) + PAGE)
    this.erased.push(page)
  }

  // --- which slot -----------------------------------------------------------------

  private gen(base: number): number {
    return this.word(base + HDR.MAGIC) === MAGIC_WORD ? this.word(base + HDR.GEN) : 0
  }

  liveSlot(): { base: number; gen: number } {
    const a = this.gen(SLOT_A)
    const b = this.gen(SLOT_B)
    if (b > a) return { base: SLOT_B, gen: b }
    if (a === 0) return { base: 0, gen: 0 }
    return { base: SLOT_A, gen: a }
  }

  targetSlot(): number {
    const live = this.liveSlot()
    return live.base === SLOT_A ? SLOT_B : SLOT_A
  }

  // --- the wire -------------------------------------------------------------------

  async write(char: string, block: Uint8Array, withResponse: boolean): Promise<void> {
    this.writes.push({ char, block, withResponse })
    if (this.opts.stock) return
    const deaf = this.opts.goSilentAfter
    if (deaf !== undefined && this.writes.length > deaf) return
    const plain = this.cipher.decrypt(block)
    const body = p.body(plain)
    if (String.fromCharCode(body[0]) !== jgx.OPCODE) return
    this.handle(body)
  }

  async subscribe(char: string, on: (block: Uint8Array) => void): Promise<void> {
    expect(char).toBe(p.CHAR_NOTIFY)
    this.notify = on
  }

  async disconnect(): Promise<void> {}

  private say(payload: number[]): void {
    const plain = new Uint8Array(p.BLOCK_SIZE)
    plain[0] = payload.length
    plain.set(payload, 1)
    this.notify?.(this.cipher.encrypt(plain))
  }

  private reply(code: number): void {
    this.say([jgx.MARKER, jgx.MSG.UPD_REPLY, code])
  }

  private handle(body: Uint8Array): void {
    const u16 = (i: number) => body[i] | (body[i + 1] << 8)
    switch (body[1]) {
      case jgx.SUB.HELLO:
        this.say([
          jgx.MARKER,
          jgx.MSG.HELLO_REPLY,
          (this.opts.version ?? 1) & 0xff,
          0,
          (this.opts.capabilities ?? jgx.CAP.SESSION | jgx.CAP.UPDATE) & 0xff,
          0,
        ])
        return
      case jgx.SUB.UPD_BEGIN:
        return this.begin(u16(2), (u16(4) | (u16(6) << 16)) >>> 0)
      case jgx.SUB.UPD_DATA:
        return this.data(u16(2), body.subarray(4, 4 + jgx.UPD_DATA_BYTES))
      case jgx.SUB.UPD_END:
        return this.end()
      case jgx.SUB.UPD_ABORT: {
        this.erasePage(this.targetSlot())
        this.reply(jgx.UPD.OK)
        return
      }
      case jgx.SUB.UPD_STATUS: {
        const live = this.liveSlot()
        const status = [
          jgx.MARKER,
          jgx.MSG.UPD_REPLY,
          live.base === 0 ? jgx.UPD.NO_SLOT : jgx.UPD.OK,
          live.base === SLOT_B ? 1 : 0,
          live.gen & 0xff,
          (live.gen >> 8) & 0xff,
        ]
        // The seventh byte: the slot the next UPD_BEGIN writes, which is what an image
        // has to be assembled for. The firmware says it outright rather than leaving the
        // host to invert `liveIsB`, because that inversion is the one failure the design
        // cannot catch. `oldResident` models a unit flashed before this byte existed.
        if (!this.opts.oldResident) status.push(this.targetSlot() === SLOT_B ? 1 : 0)
        this.say(status)
        return
      }
      default:
        return
    }
  }

  private begin(len: number, crc: number): void {
    if (len === 0 || len > MAX_BODY) return this.reply(jgx.UPD.BAD_LENGTH)
    const base = this.targetSlot()
    const span = (len + SLOT_HDR_LEN + PAGE - 1) & ~(PAGE - 1)
    for (let off = 0; off < span; off += PAGE) this.erasePage(base + off)
    const ok =
      this.program(base + HDR.GEN, this.liveSlot().gen + 1) &&
      this.program(base + HDR.LEN, len) &&
      this.program(base + HDR.CRC, crc)
    this.reply(ok ? jgx.UPD.OK : jgx.UPD.FMC_REFUSED)
  }

  private data(seq: number, block: Uint8Array): void {
    if (this.dropped.size < (this.opts.dropReplyFor ?? []).length) {
      if ((this.opts.dropReplyFor ?? []).includes(seq) && !this.dropped.has(seq)) {
        this.dropped.add(seq)
        return
      }
    }
    const base = this.targetSlot()
    const off = seq * jgx.UPD_DATA_BYTES
    if (off >= this.word(base + HDR.LEN)) return this.reply(jgx.UPD.BAD_SEQ)
    const dv = new DataView(block.buffer, block.byteOffset, block.byteLength)
    let ok = true
    for (let i = 0; i < jgx.UPD_DATA_BYTES; i += 4) {
      ok = this.program(base + SLOT_HDR_LEN + off + i, dv.getUint32(i, true)) && ok
    }
    this.reply(ok ? jgx.UPD.OK : jgx.UPD.FMC_REFUSED)
  }

  private end(): void {
    const base = this.targetSlot()
    const len = this.word(base + HDR.LEN)
    if (len === 0 || len > MAX_BODY) return this.reply(jgx.UPD.BAD_CRC)
    const seen = crc32(this.bytes(base + SLOT_HDR_LEN, len))
    if ((seen >>> 0) !== this.word(base + HDR.CRC)) return this.reply(jgx.UPD.BAD_CRC)
    const ok = this.program(base + HDR.MAGIC, MAGIC_WORD)
    this.reply(ok ? jgx.UPD.OK : jgx.UPD.FMC_REFUSED)
  }
}

// --- harness --------------------------------------------------------------------------

interface Harness {
  unit: FakeUnit
  deps: PatchDeps
  lines: string[]
  naps: number[]
}

/** So a lost reply costs 25ms rather than the real 2 seconds. */
const FAST_TIMEOUT = 25

async function harness(opts: FakeOptions = {}): Promise<Harness> {
  const unit = new FakeUnit(p.vendor, opts)
  const lines: string[] = []
  const naps: number[] = []
  const real = await openLink(unit, 'JOGGLES-FAKE01', p.vendor)
  // The clamp is the test's business, not the driver's: the frame still goes out over
  // the transport, and only the wait for an answer that will never come is shortened.
  const link = {
    name: real.name,
    ask: (frame: Uint8Array, ms: number, want: Parameters<typeof real.ask>[2]) =>
      real.ask(frame, Math.min(ms, FAST_TIMEOUT), want),
  }
  return {
    unit,
    lines,
    naps,
    deps: {
      link,
      sleep: async (ms) => {
        naps.push(ms)
      },
      log: (line) => lines.push(line),
    },
  }
}

/**
 * A slot body that looks like the real thing to everything this driver reads.
 *
 * No slot builder exists yet, so this is synthetic: `research/tools/updater.ts` builds
 * the resident half and nothing builds a slot. The fields that matter are the ones
 * `inspect` reads, and `ENTRY` is the one the gate turns on.
 */
function slotImage(
  built: SlotName | 'resident',
  bytes = 64,
  opts: { handlers?: number[]; capabilities?: number; headerSize?: number } = {},
): Uint8Array {
  const body = new Uint8Array(Math.max(bytes, JGX_HDR.TABLE + 64))
  const dv = new DataView(body.buffer)
  for (let i = 0; i < 4; i++) body[i] = jgx.MAGIC.charCodeAt(i)
  dv.setUint16(JGX_HDR.VERSION, 2, true)
  dv.setUint16(JGX_HDR.CAPABILITIES, opts.capabilities ?? jgx.CAP.CONTENT, true)
  const base = built === 'resident' ? 0x28800 : built === 'A' ? SLOT_A : SLOT_B
  const entry = built === 'resident' ? base + 0x20 : base + SLOT_HDR_LEN + 0x40
  dv.setUint32(JGX_HDR.ENTRY, (entry | 1) >>> 0, true)
  dv.setUint32(JGX_HDR.SIZE, opts.headerSize ?? body.length, true)
  const handlers = opts.handlers ?? [0x10, 0x11]
  dv.setUint16(JGX_HDR.TABLE_COUNT, Math.max(...handlers) + 1, true)
  for (const id of handlers) dv.setUint16(JGX_HDR.TABLE + id * 2, 0x40 + id, true)
  // Something recognisable in the tail, so a body in the wrong slot shows as wrong bytes.
  for (let i = JGX_HDR.TABLE + handlers.length * 2 + 64; i < body.length; i++) {
    body[i] = (i * 7 + 1) & 0xff
  }
  return body
}

/** Status, verify and transfer, which is what every send does. */
async function send(
  h: Harness,
  body: Uint8Array,
  opts: Parameters<typeof transfer>[2] = {},
) {
  const unit = await readUnit(h.deps)
  if (unit.kind !== 'crew' || !unit.slots) throw new Error('not a crew unit with slots')
  const checked = Checked.verify(body, unit.slots)
  return { checked, sent: await transfer(h.deps, checked, opts) }
}

// --- the clean loop -------------------------------------------------------------------

describe('a slot arrives and goes live', () => {
  test('one update lands in A at generation 1, byte for byte', async () => {
    const h = await harness()
    const body = slotImage('A', 200)
    const { checked, sent } = await send(h, body)
    expect(sent.status).toBe('transferred')
    expect(sent.framesSent).toBe(jgx.updFrames(body.length))

    // Nothing is live until the magic lands, which is the property the design rests on.
    expect(h.unit.word(SLOT_A + HDR.MAGIC)).not.toBe(MAGIC_WORD)
    const done = await commitSlot(h.deps, checked, sent)
    expect(done.status).toBe('live')

    expect(h.unit.word(SLOT_A + HDR.MAGIC)).toBe(MAGIC_WORD)
    expect(h.unit.word(SLOT_A + HDR.GEN)).toBe(1)
    expect(h.unit.word(SLOT_A + HDR.LEN)).toBe(body.length)
    expect(h.unit.word(SLOT_A + HDR.CRC)).toBe(crc32(body))
    expect([...h.unit.bytes(SLOT_A + SLOT_HDR_LEN, body.length)]).toEqual([...body])
  })

  test('the magic is the last word programmed', async () => {
    const h = await harness()
    const body = slotImage('A', 120)
    const { checked, sent } = await send(h, body)
    await commitSlot(h.deps, checked, sent)
    expect(h.unit.programmed.at(-1)).toBe(SLOT_A + HDR.MAGIC)
    expect(h.unit.programmed.filter((a) => a === SLOT_A + HDR.MAGIC).length).toBe(1)
  })

  test('patch again, and the driver is told to build for the other slot', async () => {
    const h = await harness()
    const first = slotImage('A', 96)
    const one = await send(h, first)
    await commitSlot(h.deps, one.checked, one.sent)

    const state = await readUnit(h.deps)
    expect(state.kind === 'crew' && state.slots).toMatchObject({
      live: 'A',
      generation: 1,
      next: 'B',
      nextBase: SLOT_B,
      nextGeneration: 2,
    })

    const second = slotImage('B', 96)
    const two = await send(h, second)
    const done = await commitSlot(h.deps, two.checked, two.sent)
    expect(done.status).toBe('live')
    expect(h.unit.word(SLOT_B + HDR.GEN)).toBe(2)
    // A is untouched, which is the "patch again without bricking it" half of the bar.
    expect(h.unit.word(SLOT_A + HDR.GEN)).toBe(1)
    expect([...h.unit.bytes(SLOT_A + SLOT_HDR_LEN, first.length)]).toEqual([...first])
  })

  test('and again, alternating back to A', async () => {
    const h = await harness()
    for (const slot of ['A', 'B', 'A'] as SlotName[]) {
      const { checked, sent } = await send(h, slotImage(slot, 80))
      expect((await commitSlot(h.deps, checked, sent)).status).toBe('live')
    }
    const state = await readUnit(h.deps)
    expect(state.kind === 'crew' && state.slots?.live).toBe('A')
    expect(h.unit.word(SLOT_A + HDR.GEN)).toBe(3)
    expect(h.unit.word(SLOT_B + HDR.GEN)).toBe(2)
  })

  test('nothing outside the target slot is ever written', async () => {
    const h = await harness()
    const { checked, sent } = await send(h, slotImage('A', 300))
    await commitSlot(h.deps, checked, sent)
    for (const addr of [...h.unit.programmed, ...h.unit.erased]) {
      expect(addr).toBeGreaterThanOrEqual(SLOT_A)
      expect(addr).toBeLessThan(SLOT_A + SLOT_SIZE)
    }
  })

  test('an odd-sized body commits, and the padding is not counted', async () => {
    const h = await harness()
    const body = slotImage('A', 205)
    expect(body.length % jgx.UPD_DATA_BYTES).not.toBe(0)
    const { checked, sent } = await send(h, body)
    expect((await commitSlot(h.deps, checked, sent)).status).toBe('live')
    expect(h.unit.word(SLOT_A + HDR.LEN)).toBe(body.length)
  })
})

// --- the wire ------------------------------------------------------------------------

describe('what goes on the wire', () => {
  test('one 16-byte block per ATT write, on the command channel, acked', async () => {
    const h = await harness()
    const { checked, sent } = await send(h, slotImage('A', 64))
    await commitSlot(h.deps, checked, sent)
    expect(h.unit.writes.length).toBeGreaterThan(8)
    for (const w of h.unit.writes) {
      expect(w.block.length).toBe(p.BLOCK_SIZE)
      expect(w.char).toBe(p.CHAR_COMMAND)
      expect(w.withResponse).toBe(true)
    }
  })

  test('the frames go out in order, and the sequence number is the address', async () => {
    const h = await harness()
    const body = slotImage('A', 64)
    await send(h, body)
    const seqs = h.unit.writes
      .map((w) => p.body(p.vendor.decrypt(w.block)))
      .filter((b) => b[1] === jgx.SUB.UPD_DATA)
      .map((b) => b[2] | (b[3] << 8))
    expect(seqs).toEqual([...seqs.keys()])
  })

  test('every frame is paced by protocol.PACING_MS', async () => {
    const h = await harness()
    const body = slotImage('A', 64)
    const { sent } = await send(h, body)
    expect(h.naps.length).toBe(sent.frames)
    expect(new Set(h.naps)).toEqual(new Set([p.PACING_MS]))
  })

  test('a frame sent twice is harmless: the address comes from the seq', async () => {
    const h = await harness({ dropReplyFor: [3] })
    const body = slotImage('A', 200)
    const { checked, sent } = await send(h, body)
    expect(sent.status).toBe('transferred')
    // Frame 3 went out twice: once unanswered, once retried.
    const three = h.unit.writes
      .map((w) => p.body(p.vendor.decrypt(w.block)))
      .filter((b) => b[1] === jgx.SUB.UPD_DATA && b[2] === 3)
    expect(three.length).toBe(2)
    expect((await commitSlot(h.deps, checked, sent)).status).toBe('live')
    expect([...h.unit.bytes(SLOT_A + SLOT_HDR_LEN, body.length)]).toEqual([...body])
  })
})

// --- the failures --------------------------------------------------------------------

describe('a wrong CRC', () => {
  test('is refused at UPD_END and the live slot keeps running', async () => {
    const h = await harness()
    const first = slotImage('A', 96)
    const one = await send(h, first)
    await commitSlot(h.deps, one.checked, one.sent)
    const before = [...h.unit.bytes(SLOT_A, 128)]

    const two = await send(h, slotImage('B', 96), { badCrc: true })
    expect(two.sent.status).toBe('transferred')
    const done = await commitSlot(h.deps, two.checked, two.sent)
    expect(done.status).toBe('refused')
    expect(done.code).toBe(jgx.UPD.BAD_CRC)
    expect(done.leaves).toContain('never programmed')

    // B has a body and no magic; A is byte-identical and still live.
    expect(h.unit.word(SLOT_B + HDR.MAGIC)).not.toBe(MAGIC_WORD)
    expect([...h.unit.bytes(SLOT_A, 128)]).toEqual(before)
    const state = await readUnit(h.deps)
    expect(state.kind === 'crew' && state.slots?.live).toBe('A')
    expect(state.kind === 'crew' && state.slots?.generation).toBe(1)
  })
})

describe('an interrupted transfer', () => {
  test('leaves a slot that cannot validate, and no commit is possible', async () => {
    const h = await harness()
    const body = slotImage('A', 400)
    const { checked, sent } = await send(h, body, { stopAfter: 3 })
    expect(sent.status).toBe('stopped')
    expect(sent.framesSent).toBe(3)
    expect(sent.leaves).toContain('magic was never programmed')
    expect(h.unit.word(SLOT_A + HDR.MAGIC)).not.toBe(MAGIC_WORD)

    // Structural, not a check at the call site: a partial transfer cannot be committed.
    await expect(commitSlot(h.deps, checked, sent)).rejects.toThrow(/refusing to commit/)
    const state = await readUnit(h.deps)
    expect(state.kind === 'crew' && state.slots?.live).toBe(null)
  })

  test('and the next attempt just starts again, in the same slot', async () => {
    const h = await harness()
    const body = slotImage('A', 400)
    await send(h, body, { stopAfter: 3 })
    const { checked, sent } = await send(h, body)
    expect(sent.status).toBe('transferred')
    expect((await commitSlot(h.deps, checked, sent)).status).toBe('live')
    expect([...h.unit.bytes(SLOT_A + SLOT_HDR_LEN, body.length)]).toEqual([...body])
  })

  test('or resumes without a second erase, because the header survived', async () => {
    const h = await harness()
    const body = slotImage('A', 400)
    const first = await send(h, body, { stopAfter: 3 })
    const erasesAfterBegin = h.unit.erased.length

    const resumed = await transfer(h.deps, first.checked, { resumeFrom: 3 })
    expect(resumed.status).toBe('transferred')
    expect(h.unit.erased.length).toBe(erasesAfterBegin)
    expect((await commitSlot(h.deps, first.checked, resumed)).status).toBe('live')
    expect([...h.unit.bytes(SLOT_A + SLOT_HDR_LEN, body.length)]).toEqual([...body])
  })

  test('a lost reply that never comes back is reported, not committed', async () => {
    // Silent from the fifth write on: HELLO, UPD_STATUS, UPD_BEGIN, then frames.
    const h = await harness({ goSilentAfter: 4 })
    const body = slotImage('A', 400)
    const { checked, sent } = await send(h, body)
    expect(sent.status).toBe('silent')
    expect(sent.leaves).toContain('unanswered 3 times')
    await expect(commitSlot(h.deps, checked, sent)).rejects.toThrow(/refusing to commit/)
    expect(h.unit.word(SLOT_A + HDR.MAGIC)).not.toBe(MAGIC_WORD)
  })
})

describe('an out-of-range sequence', () => {
  test('is refused as BAD_SEQ, and the body it already holds is unharmed', async () => {
    const h = await harness()
    const body = slotImage('A', 96)
    const { checked, sent } = await send(h, body, { overrun: true })
    expect(sent.overrunCode).toBe(jgx.UPD.BAD_SEQ)
    expect(sent.status).toBe('transferred')
    expect((await commitSlot(h.deps, checked, sent)).status).toBe('live')
    expect([...h.unit.bytes(SLOT_A + SLOT_HDR_LEN, body.length)]).toEqual([...body])
  })

  test('a body larger than a slot never reaches an erase', async () => {
    const h = await harness()
    const body = slotImage('A', MAX_BODY + 8)
    const found = inspect(body)
    expect(found.problems.join(' ')).toContain('past the')
    // The gate refuses it, so UPD_BEGIN is never built and BAD_LENGTH is never needed.
    const state = await readUnit(h.deps)
    const slots = state.kind === 'crew' ? state.slots! : null
    expect(() => Checked.verify(body, slots!)).toThrow(/past the/)
    expect(h.unit.erased.length).toBe(0)
  })
})

// --- the gate ------------------------------------------------------------------------

describe('an image built for the wrong slot base', () => {
  test('is refused before a single byte goes out', async () => {
    const h = await harness()
    // Slot A is live, so the unit will write B next. An A image is now wrong.
    const one = await send(h, slotImage('A', 96))
    await commitSlot(h.deps, one.checked, one.sent)
    const writesBefore = h.unit.writes.length

    const state = await readUnit(h.deps)
    const slots = state.kind === 'crew' ? state.slots! : null
    expect(() => Checked.verify(slotImage('A', 96), slots!)).toThrow(
      /built for slot A .*next write goes to slot B/s,
    )
    // The two reads above are HELLO and UPD_STATUS. Nothing else went out.
    expect(h.unit.writes.length).toBe(writesBefore + 2)
    expect(h.unit.erased.filter((a) => a >= SLOT_B).length).toBe(0)
  })

  test('the resident image is refused with a reason of its own', async () => {
    const found = inspect(slotImage('resident', 96))
    expect(found.builtFor).toBe(null)
    expect(found.problems.join(' ')).toContain('resident image')
    expect(found.problems.join(' ')).toContain('probe')
  })

  test('a headerless blob is refused, because there is nothing to check', async () => {
    const junk = new Uint8Array(64).fill(0xa5)
    const found = inspect(junk)
    expect(found.problems.join(' ')).toContain('not JGX1')
    expect(found.builtFor).toBe(null)
  })

  test('an empty file and a stub are both refused', () => {
    expect(inspect(new Uint8Array(0)).problems.join(' ')).toContain('empty')
    expect(inspect(new Uint8Array(8)).problems.join(' ')).toContain('too short')
  })

  test('a truncated file is refused by its own header', () => {
    const body = slotImage('A', 96, { headerSize: 4096 })
    expect(inspect(body).problems.join(' ')).toContain('truncated')
  })

  test('an image whose only handlers are resident ones says so', () => {
    const found = inspect(slotImage('A', 96, { handlers: [0x01, 0x05] }))
    expect(found.problems).toEqual([])
    expect(found.notes.join(' ')).toContain('never be reached')
    expect(found.notes.join(' ')).toContain('answers nothing')
  })

  test('an image claiming UPDATE is noted, since that bit is resident', () => {
    const found = inspect(slotImage('A', 96, { capabilities: jgx.CAP.UPDATE }))
    expect(found.notes.join(' ')).toContain('resident half')
  })

  test('inspect agrees with the firmware about frames and CRC', () => {
    const body = slotImage('A', 205)
    const found = inspect(body)
    expect(found.crc).toBe(crc32(body))
    expect(found.frames).toBe(Math.ceil(body.length / jgx.UPD_DATA_BYTES))
  })
})

// --- what a unit says ----------------------------------------------------------------

describe('reading a unit', () => {
  /**
   * The normal case, not the edge.
   *
   * No pair has been flashed, so every unit that exists answers a HELLO with silence
   * and this is what the tool will actually meet the first time somebody runs it.
   */
  test('a stock unit answers nothing, and that is a result', async () => {
    const h = await harness({ stock: true })
    const state = await readUnit(h.deps)
    expect(state.kind).toBe('stock')
    // One write, one HELLO. Nothing else is attempted against silence.
    expect(h.unit.writes.length).toBe(1)
  })

  test('a stock unit is a refusal, and no slot can be built against one', async () => {
    const h = await harness({ stock: true })
    const state = await readUnit(h.deps)
    expect(state.kind === 'stock' && 'slots' in state).toBe(false)
    // There is no `SlotState` to verify against, so the type system alone stops a
    // transfer here: `Checked.verify` cannot be called without one.
    await expect(send(h, slotImage('A', 96))).rejects.toThrow(/not a crew unit/)
    expect(h.unit.erased.length).toBe(0)
    expect(h.unit.programmed.length).toBe(0)
  })

  test('a crew unit with no slot reports NO_SLOT and would be written at A', async () => {
    const h = await harness()
    const state = await readUnit(h.deps)
    expect(state.kind).toBe('crew')
    expect(state.kind === 'crew' && state.slots).toMatchObject({
      live: null,
      generation: 0,
      next: 'A',
      nextBase: SLOT_A,
      nextGeneration: 1,
    })
  })

  test('a unit that does not declare UPDATE is not asked about slots', async () => {
    const h = await harness({ capabilities: jgx.CAP.SESSION })
    const state = await readUnit(h.deps)
    expect(state.kind === 'crew' && state.canUpdate).toBe(false)
    expect(state.kind === 'crew' && state.slots).toBe(null)
    expect(h.unit.writes.length).toBe(1)
  })

  test('a reply with no slot state is a problem, not a guess', () => {
    expect(slotsFrom({ type: 'update', code: jgx.UPD.OK }).problem).toContain(
      'without the slot state',
    )
    expect(
      slotsFrom({
        type: 'update',
        code: jgx.UPD.OK,
        status: { liveIsB: false, generation: 0 },
      }).problem,
    ).toContain('generation 0')
    expect(
      slotsFrom({
        type: 'update',
        code: jgx.UPD.FMC_REFUSED,
        status: { liveIsB: false, generation: 1 },
      }).problem,
    ).toContain('FMC_REFUSED')
  })

  test('UPD_ABORT is reachable on its own, and answers', async () => {
    const h = await harness()
    const one = await send(h, slotImage('A', 96))
    await commitSlot(h.deps, one.checked, one.sent)
    await send(h, slotImage('B', 96), { stopAfter: 2 })

    expect(await abort(h.deps)).toEqual({ code: jgx.UPD.OK })
    // B's header is erased, so it can never validate. A is still live.
    expect(h.unit.word(SLOT_B + HDR.GEN)).toBe(0xffffffff)
    const state = await readUnit(h.deps)
    expect(state.kind === 'crew' && state.slots?.live).toBe('A')
  })

  test('a commit whose reply is lost is resolved by reading back', async () => {
    const h = await harness()
    const body = slotImage('A', 96)
    const { checked, sent } = await send(h, body)
    // A link that answers nothing, so UPD_END and the UPD_STATUS after it both go
    // unanswered. Ambiguity is reported as ambiguity rather than as either outcome.
    const deaf = { ...h.deps, link: { name: 'deaf', ask: async () => null } }
    const done = await commitSlot(deaf, checked, sent)
    expect(done.status).toBe('silent')
    expect(done.leaves).toContain('nothing readable')
    expect(h.unit.word(SLOT_A + HDR.MAGIC)).not.toBe(MAGIC_WORD)
  })

  test('every code has a name, taken from jgx.UPD rather than restated', () => {
    for (const [name, code] of Object.entries(jgx.UPD)) {
      expect(updName(code)).toBe(name)
    }
    expect(updName(0x7f)).toContain('unknown')
  })
})

// --- the properties the file exists to hold ------------------------------------------

const SOURCE = readFileSync(resolve(HERE, 'patch.ts'), 'utf8')

/**
 * Comments stripped, so a docblock may still name what the code must not do.
 *
 * The same shape `spray.test.ts` and the barrel's Node crawl use. This file's own
 * docblock explains that the OTA path is unreachable, which is the opposite of a
 * violation.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the driver cannot reach the path that bricked a unit', () => {
  test('it names no OTA characteristic and imports no OTA client', () => {
    expect(CODE).not.toMatch(/fd0[0-2]/i)
    expect(CODE).not.toMatch(/\bdfu\b/)
    expect(CODE).not.toMatch(/firmware\.js/)
    // The CRC is the one thing it takes from the OTA analysis module.
    expect(CODE).toMatch(/import \{ crc32 \} from '@joggles\/core\/src\/ota\.js'/)
  })

  test('it writes on the command channel and nowhere else', () => {
    expect([...CODE.matchAll(/p\.CHAR_[A-Z_]+/g)].map((m) => m[0]).sort()).toEqual([
      'p.CHAR_COMMAND',
      'p.CHAR_NOTIFY',
    ])
    // jgx.ts is where the rule lives, and `CHANNEL` is its answer: a `J` frame on
    // `960b` is in the length range a stock unit's rhythm handler acts on, so it would
    // draw garbage rather than be ignored. This is the assertion that the channel this
    // file writes to is the one that rule names.
    expect(p.CHAR_COMMAND.endsWith(jgx.CHANNEL)).toBe(true)
  })

  test('noble is imported dynamically, so check needs no adapter', () => {
    expect(CODE).toMatch(/await import\('\.\/noble\.js'\)/)
    expect(CODE).not.toMatch(/^import .*noble/m)
  })
})

describe('the wrong-slot-base check cannot be skipped', () => {
  test('each UPD_* frame has exactly one call site', () => {
    for (const helper of ['updBegin', 'updData', 'updEnd', 'updAbort', 'updStatus']) {
      const uses = [...CODE.matchAll(new RegExp(`jgx\\.${helper}\\(`, 'g'))]
      expect(uses.length, `${helper} call sites`).toBe(helper === 'updData' ? 2 : 1)
    }
  })

  test('a unit that will not name its target slot is refused, not guessed at', async () => {
    // The firmware names the slot it will WRITE in a seventh UPD_STATUS byte. A unit
    // predating that byte reports only which slot is LIVE, and inverting that is how a
    // host walks into the one failure the design cannot catch: a body built for the
    // wrong base has a valid CRC and valid magic and branches into nothing. So the
    // fallback is a refusal, and this test is here because the check is invisible when
    // every fake unit answers correctly.
    const h = await harness({ oldResident: true })
    const state = await readUnit(h.deps)
    if (state.kind !== 'crew' || !state.slots) throw new Error('expected a crew unit')
    expect(state.slots.targetFromDevice).toBe(false)
    // It still REPORTS: reading an old unit is fine, it is assembling against a guess
    // that is not.
    expect(state.slots.next).toBe('A')

    expect(() => Checked.verify(slotImage('A', 96), state.slots!)).toThrow(
      /did not say which slot it will write next/,
    )

    // And the same unit with the byte present is accepted, so the refusal is about the
    // missing byte and not about anything else in this image.
    const ok = await harness()
    const okState = await readUnit(ok.deps)
    if (okState.kind !== 'crew' || !okState.slots) throw new Error('expected a crew unit')
    expect(okState.slots.targetFromDevice).toBe(true)
    expect(() => Checked.verify(slotImage('A', 96), okState.slots!)).not.toThrow()
  })

  test('the only way to hold a Checked is a private constructor', () => {
    expect(CODE).toMatch(/private constructor\(/)
    expect([...CODE.matchAll(/new Checked\(/g)].length).toBe(1)
  })

  test('transfer and commit take a Checked, never bytes', () => {
    const takes = (fn: string) =>
      new RegExp(`export async function ${fn}\\(\\s*deps: PatchDeps,\\s*checked: Checked`)
    expect(CODE).toMatch(takes('transfer'))
    expect(CODE).toMatch(takes('commitSlot'))
  })

  test('there is no override flag anywhere in the file', () => {
    for (const escape of ['force', 'no-check', 'skip-check', 'ignore', 'unsafe']) {
      expect(CODE.toLowerCase(), `escape hatch ${escape}`).not.toContain(escape)
    }
  })

  test('the target slot comes from the device and nothing else names one', () => {
    // `Checked.verify` reads `slots.next`, and `SlotState` is only built by `slotsFrom`,
    // which parses a reply. A base named by a person would show up as a literal here.
    const literals = [...CODE.matchAll(/0x2[9b]400/g)].map((m) => m[0])
    expect(literals).toEqual(['0x29400'])
    expect(CODE).toMatch(/export const SLOT_A = 0x29400/)
  })
})

describe('the failure table is the design document, not an invention', () => {
  const NOTE = readFileSync(resolve(HERE, '../../../notes/patch-over-bt.md'), 'utf8')
  /** The note is markdown, so its emphasis is not part of the claim. */
  const plain = (s: string) => s.replace(/[`*]/g, '')

  test('every row appears in notes/patch-over-bt.md', () => {
    for (const row of LEAVES_BEHIND) {
      expect(plain(NOTE), row.failure).toContain(plain(row.failure))
      expect(plain(NOTE), row.state).toContain(plain(row.state))
    }
  })

  test('all seven rows are there', () => {
    expect(LEAVES_BEHIND.length).toBe(7)
  })
})

describe('the slot geometry agrees with the firmware that answers', () => {
  const FIRMWARE = readFileSync(
    resolve(HERE, '../../../research/tools/updater.ts'),
    'utf8',
  )
  const EXT = readFileSync(resolve(HERE, '../../../research/tools/ext.ts'), 'utf8')

  test('the four slot numbers are the ones updater.ts assembles for', () => {
    expect(FIRMWARE).toContain(`export const SLOT_A = 0x${SLOT_A.toString(16)}`)
    expect(FIRMWARE).toContain(`export const SLOT_SIZE = 0x${SLOT_SIZE.toString(16)}`)
    expect(FIRMWARE).toContain(`export const SLOT_HDR_LEN = ${SLOT_HDR_LEN}`)
    expect(FIRMWARE).toContain('export const SLOT_B = SLOT_A + SLOT_SIZE')
    expect(FIRMWARE).toContain('export const MAX_BODY = SLOT_SIZE - SLOT_HDR_LEN')
    expect(SLOT_B).toBe(0x2b400)
    expect(MAX_BODY).toBe(SLOT_SIZE - SLOT_HDR_LEN)
  })

  test('the block header offsets are ext.ts HDR', () => {
    const declared = EXT.match(/export const HDR = \{[^}]+\}/)![0]
    for (const [name, off] of Object.entries(JGX_HDR)) {
      expect(declared, name).toContain(`${name}: 0x${off.toString(16).padStart(2, '0')}`)
    }
  })

  test('a body of the largest legal size still fits the frame count', () => {
    expect(jgx.updFrames(MAX_BODY)).toBe(MAX_BODY / jgx.UPD_DATA_BYTES)
    expect(MAX_BODY).toBeLessThanOrEqual(0xffff)
  })
})
