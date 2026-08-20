/**
 * A slot, built and then delivered over the air, executed.
 *
 * The framework's refusals first, which need no image. Then the whole loop on the image
 * a real unit runs: the tick patch applied, the extension and the hook in place, a slot
 * carrying the `TICK` feature uploaded through the five `UPD_*` commands, and then
 * `TICK ASK` answered by code that arrived over Bluetooth. Every frame enters at the
 * **dispatcher's own entry**, so the vendor's length gate runs, which is the test review
 * 33 asked for.
 *
 * The two properties the design is sold on are the ones to look for below: a resident
 * handler is dispatched before any slot, and a slot that is wrong in any of the ways a
 * CRC cannot see is refused in silence rather than branched into.
 *
 * Nothing here has run on silicon. `research/tools/thumbsim.ts` models this part's FMC
 * and, now, enough of its GPIO and timer to run the vendor's own code; its header lists
 * what it does not model, and the big ones are time, interrupts and the BLE stack.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import * as ota from '../../../packages/core/src/ota.js'
import * as jgx from '../../../packages/core/src/jgx.js'
import * as ext from '../ext.js'
import { buildExtension, buildHook } from '../ext.js'
import * as upd from '../updater.js'
import { DONE, Fmc, machine, type Machine } from '../thumbsim.js'
import { buildSlot, checkFeatures, readSlot, RESIDENT_SUBS, SLOT_MAX_BODY } from './index.js'
import type { Feature } from './index.js'
import { resolveTick, tick, tickEdits } from './tick.js'

const DONOR = 'firmware/dump-12E69E-2026-08-19-a.bin'
const BASE = 0x16800
const STRUCT = 0x20002000

/** A feature that needs nothing from the image and emits one instruction per sub. */
type NoFacts = Record<string, never>
const stub = (id: string, subs: number[], capability = jgx.CAP.SYNC): Feature<NoFacts> => ({
  id,
  summary: `stub ${id}`,
  capability,
  subcommands: subs.map((s) => ({ id: s, label: `${id}_${s}` })),
  resolve: () => ({ facts: {}, notes: [] }),
  emit: (a, _ctx, _facts) => {
    for (const s of subs) {
      a.label(`${id}_${s}`)
      a.bx('lr')
    }
  },
})

describe('what a slot will not carry', () => {
  const fatals = (notes: { severity: string; message: string }[]) =>
    notes.filter((n) => n.severity === 'fatal').map((n) => n.message)

  test('a sub-command the resident half answers', () => {
    for (const sub of RESIDENT_SUBS) {
      const msgs = fatals(checkFeatures([stub('x', [sub])] as never))
      expect(msgs.length).toBe(1)
      expect(msgs[0]).toContain('the resident half answers')
    }
  })

  test('two features claiming the same sub-command, and both are named', () => {
    const msgs = fatals(checkFeatures([stub('a', [0x20]), stub('b', [0x20])] as never))
    expect(msgs.length).toBe(1)
    expect(msgs[0]).toContain("'a'")
    expect(msgs[0]).toContain("'b'")
  })

  test('two features with the same name', () => {
    const msgs = fatals(checkFeatures([stub('a', [0x20]), stub('a', [0x21])] as never))
    expect(msgs.some((m) => m.includes("called 'a'"))).toBe(true)
  })

  test('a feature that answers nothing', () => {
    expect(fatals(checkFeatures([stub('a', [])] as never)).length).toBe(1)
  })

  test('a sub-command the wire format does not license is a warning, not a refusal', () => {
    // 0x40 and up is unallocated, so `jgx.permits` refuses it and no client that asks
    // first would send it. Worth saying; not worth refusing, because the firmware is
    // where a new sub-command is tried out.
    const notes = checkFeatures([stub('a', [0x40])] as never)
    expect(fatals(notes)).toEqual([])
    expect(notes.some((n) => n.message.includes('jgx.SUB_CAP'))).toBe(true)
  })

  test('a capability bit that disagrees with the wire format is a warning', () => {
    const notes = checkFeatures([stub('t', [jgx.SUB.TICK], jgx.CAP.SEED)] as never)
    expect(notes.some((n) => n.message.includes('would check one bit'))).toBe(true)
  })

  test('a body that does not fit, with the number of bytes over', () => {
    const fat: Feature<NoFacts> = {
      ...stub('fat', [0x20]),
      emit: (a) => {
        a.label('fat_32')
        for (let i = 0; i < SLOT_MAX_BODY / 2; i++) a.bx('lr')
      },
    }
    expect(() => buildSlot([fat] as never, {
      image: new Uint8Array(16), base: BASE, notify: 0x21b70, arg: ext.ARG,
    })).toThrow(/over/)
  })

  test('a feature whose facts do not resolve is left out and said so', () => {
    const missing: Feature<NoFacts> = {
      ...stub('missing', [0x20]),
      resolve: () => ({ facts: null, notes: [{ severity: 'fatal', message: 'no anchor' }] }),
    }
    const slot = buildSlot([missing] as never, {
      image: new Uint8Array(16), base: BASE, notify: 0x21b70, arg: ext.ARG,
    })
    expect(slot.bytes).toBe(0)
    expect(fatals(slot.notes).some((m) => m.includes('could not resolve'))).toBe(true)
  })
})

describe.if(existsSync(DONOR))('the tick feature, delivered to a real unit\'s image', () => {
  const stock = new Uint8Array(readFileSync(DONOR)).slice(BASE, 0x29400)

  /** The window with the tick patch in it, which is what would be flashed. */
  const window = (() => {
    const out = stock.slice()
    const facts = resolveTick(stock, BASE).facts!
    for (const e of tickEdits(facts, stock, BASE).edits) {
      out.set(e.to, e.abs - BASE)
    }
    return out
  })()

  const layout = ext.resolveLayout(window).layout!
  const site = layout.site
  const dispatcher = ext.findDispatcher(window, BASE, site).dispatcher!

  /** That window plus the hook and the resident extension, exactly as flashed. */
  const image = (() => {
    const w = window.slice()
    const place = ext.placeExtension({ window: w, size: 2048, intoFill: true }).place!
    const x = buildExtension({ version: 1, base: place.addr, notify: layout.notify, site })
    w.set(buildHook(x.entry, site), site.callAt - BASE)
    w.set(x.code, x.base - BASE)
    return { window: w, ext: x }
  })()

  const slotFor = (slotBase: number) => buildSlot([tick] as never, {
    image: window,
    base: BASE,
    slotBase,
    notify: layout.notify,
    arg: ext.ARG,
  })

  /** A device: flash as flashed, and frames entering where the radio enters. */
  function unit() {
    const fmc = new Fmc()
    fmc.flash.set(image.window, BASE)
    const replies: jgx.Notification[] = []
    const raw: number[][] = []

    const send = (frame: Uint8Array) => {
      const m = machine({
        fmc,
        stopAt: DONE,
        hooks: new Map([[layout.notify | 1, (mm: Machine) => {
          const len = mm.r[0] >>> 0
          const ptr = mm.r[1] >>> 0
          const block = new Uint8Array(16)
          block[0] = len
          for (let i = 0; i < len; i++) {
            const at = ptr + i
            block[1 + i] = at >= 0x20000000 ? mm.sram[at - 0x20000000] : mm.flash[at]
          }
          raw.push([...block.subarray(0, len + 1)])
          const parsed = jgx.parseNotification(block)
          if (parsed) replies.push(parsed)
        }]]),
      })
      // Wire byte n sits at struct + n + 1, and the gate reads the body length from a
      // separate field at struct + 0xfb rather than from the wire byte.
      m.sram.set(frame, STRUCT + 1 - 0x20000000)
      m.sram[STRUCT + dispatcher.lengthOff - 0x20000000] = frame[0]
      m.r[0] = STRUCT
      m.run(dispatcher.entry)
      return m
    }
    return { fmc, replies, raw, send }
  }

  /** The whole over-the-air loop for one slot body. */
  function upload(d: ReturnType<typeof unit>, body: Uint8Array, crc: number) {
    d.send(jgx.updBegin(body.length, crc))
    for (let seq = 0; seq < jgx.updFrames(body.length); seq++) {
      const at = seq * jgx.UPD_DATA_BYTES
      d.send(jgx.updData(seq, body.subarray(at, at + jgx.UPD_DATA_BYTES)))
    }
    d.send(jgx.updEnd())
  }

  test('every frame the client builds passes the vendor length gate', () => {
    // The bug review 33 found was three frames of two bytes each, dropped before the
    // opcode was read. Every builder, checked against the gate this image actually has.
    const frames = [
      jgx.hello(), jgx.updBegin(64, 0), jgx.updData(0, new Uint8Array(8)),
      jgx.updEnd(), jgx.updAbort(), jgx.updStatus(),
      jgx.tickAsk(), jgx.tickSet(100),
    ]
    for (const f of frames) {
      expect(f[0]).toBeGreaterThanOrEqual(dispatcher.minBody)
      expect(f[0]).toBeLessThanOrEqual(dispatcher.maxBody)
    }
  })

  test('a slot arrives over the air and its handler answers', () => {
    const slot = slotFor(upd.SLOT_A)
    expect(slot.notes.some((n) => n.severity === 'fatal')).toBe(false)
    const d = unit()
    upload(d, slot.body, slot.crc)
    expect(d.replies.every((r) => r.type === 'update' && r.code === jgx.UPD.OK)).toBe(true)

    d.replies.length = 0
    d.send(jgx.tickAsk())
    expect(d.replies.length).toBe(1)
    const r = d.replies[0]
    expect(r.type).toBe('tick')
    if (r.type !== 'tick') throw new Error('not a tick report')
    // Read out of the running image's own immediates, not out of the slot.
    expect(r.hz).toBe(100)
    expect(r.holdTicks).toBe(jgx.HOLD_TICKS_STOCK * 2)
    expect(jgx.powerOffIntact(r.hz, r.holdTicks)).toBe(true)
  })

  test('the resident handlers still answer with a slot live, which is the whole rule', () => {
    const slot = slotFor(upd.SLOT_A)
    const d = unit()
    upload(d, slot.body, slot.crc)
    d.replies.length = 0
    d.send(jgx.hello())
    d.send(jgx.updStatus())
    expect(d.replies[0].type).toBe('hello')
    expect(d.replies[1].type).toBe('update')
    // HELLO now reports the resident capabilities OR the live slot's, so a client can
    // see a slot feature at all: `jgx.permits` refuses anything whose bit is clear.
    const hello = d.replies[0]
    if (hello.type !== 'hello') throw new Error('not a hello')
    expect(jgx.supports(hello.capabilities, jgx.CAP.SESSION)).toBe(true)
    expect(jgx.supports(hello.capabilities, jgx.CAP.UPDATE)).toBe(true)
    expect(jgx.supports(hello.capabilities, jgx.CAP.TICK)).toBe(true)
    expect(jgx.permits(hello.capabilities, jgx.SUB.TICK)).toBe(true)
    expect(jgx.permits(hello.capabilities, jgx.SUB.SEED)).toBe(false)
  })

  test('with no slot at all, HELLO reports only what the resident half has', () => {
    const d = unit()
    d.send(jgx.hello())
    const hello = d.replies[0]
    if (hello.type !== 'hello') throw new Error('not a hello')
    expect(hello.capabilities).toBe(jgx.CAP.SESSION | jgx.CAP.UPDATE)
    expect(jgx.permits(hello.capabilities, jgx.SUB.TICK)).toBe(false)
    // And the sub-command it does not have is ignored in silence, not faulted on.
    d.replies.length = 0
    d.send(jgx.tickAsk())
    expect(d.replies).toEqual([])
  })

  test('a slot built for the other slot is refused, not branched into', () => {
    // The failure `notes/patch-over-bt.md` calls the one the design cannot catch: a
    // body assembled for B, programmed into A, with a valid magic and a valid CRC.
    const wrong = slotFor(upd.SLOT_B)
    const d = unit()
    upload(d, wrong.body, wrong.crc)
    // It goes live: the slot header is correct, and that is exactly the problem.
    d.replies.length = 0
    d.send(jgx.updStatus())
    const status = d.replies[0]
    if (status.type !== 'update') throw new Error('not an update reply')
    expect(status.code).toBe(jgx.UPD.OK)
    // And its handler is never entered, because the body says which base it was built
    // for and the dispatcher checks it.
    d.replies.length = 0
    d.send(jgx.tickAsk())
    expect(d.replies).toEqual([])
    // HELLO does not advertise its capabilities either, for the same reason it is not
    // entered: nothing in it is trusted.
    d.send(jgx.hello())
    const hello = d.replies[0]
    if (hello.type !== 'hello') throw new Error('not a hello')
    expect(jgx.supports(hello.capabilities, jgx.CAP.TICK)).toBe(false)
  })

  test('a table offset outside the body is refused', () => {
    const slot = slotFor(upd.SLOT_A)
    const body = slot.body.slice()
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength)
    // Point the TICK entry past the end of the body, which is what a corrupt table or a
    // body from a different build would look like.
    dv.setUint16(ext.HDR.TABLE + jgx.SUB.TICK * 2, slot.bytes + 8, true)
    const d = unit()
    upload(d, body, ota.crc32(body))
    d.replies.length = 0
    d.send(jgx.updStatus())
    expect((d.replies[0] as jgx.UpdReply).code).toBe(jgx.UPD.OK)
    d.replies.length = 0
    d.send(jgx.tickAsk())
    expect(d.replies).toEqual([])
  })

  test('a body that is not a JGX1 block at all is refused', () => {
    const body = new Uint8Array(64).fill(0xa5)
    const d = unit()
    upload(d, body, ota.crc32(body))
    d.replies.length = 0
    d.send(jgx.tickAsk())
    expect(d.replies).toEqual([])
    d.send(jgx.hello())
    const hello = d.replies[0]
    if (hello.type !== 'hello') throw new Error('not a hello')
    expect(hello.capabilities).toBe(jgx.CAP.SESSION | jgx.CAP.UPDATE)
  })

  test('TICK SET takes the rate the image is compensated for, and refuses the other', () => {
    const slot = slotFor(upd.SLOT_A)
    const d = unit()
    upload(d, slot.body, slot.crc)

    d.replies.length = 0
    d.send(jgx.tickSet(100))
    expect(d.replies[0].type).toBe('tick')

    d.replies.length = 0
    d.send(jgx.tickSet(50))
    const ack = d.replies[0]
    expect(ack.type).toBe('ack')
    if (ack.type !== 'ack') throw new Error('not an ack')
    expect(ack.sub).toBe(jgx.SUB.TICK)
    // 50 Hz against a 200-tick hold would be a four second power-off, so it is refused
    // for breaking an invariant rather than for being a bad argument.
    expect(ack.code).toBe(jgx.STATUS.REFUSED)

    d.replies.length = 0
    d.send(jgx.subFrame(jgx.SUB.TICK, jgx.SET, 0))
    expect((d.replies[0] as jgx.Ack).code).toBe(jgx.STATUS.BAD_ARG)
  })

  test('on a stock-tick image the same slot refuses 100 and reports 50', () => {
    // The same slot body, on an image whose tick was never patched. The firmware reads
    // the image rather than trusting the build, so it reports the truth and refuses the
    // rate it has no compensations for.
    const stockLayout = ext.resolveLayout(stock).layout!
    const stockDisp = ext.findDispatcher(stock, BASE, stockLayout.site).dispatcher!
    const w = stock.slice()
    const place = ext.placeExtension({ window: w, size: 2048, intoFill: true }).place!
    const x = buildExtension({
      version: 1, base: place.addr, notify: stockLayout.notify, site: stockLayout.site,
    })
    w.set(buildHook(x.entry, stockLayout.site), stockLayout.site.callAt - BASE)
    w.set(x.code, x.base - BASE)
    const slot = buildSlot([tick] as never, {
      image: stock, base: BASE, slotBase: upd.SLOT_A, notify: stockLayout.notify, arg: ext.ARG,
    })

    const fmc = new Fmc()
    fmc.flash.set(w, BASE)
    const replies: jgx.Notification[] = []
    const send = (frame: Uint8Array) => {
      const m = machine({
        fmc,
        stopAt: DONE,
        hooks: new Map([[stockLayout.notify | 1, (mm: Machine) => {
          const len = mm.r[0] >>> 0
          const ptr = mm.r[1] >>> 0
          const block = new Uint8Array(16)
          block[0] = len
          for (let i = 0; i < len; i++) {
            const at = ptr + i
            block[1 + i] = at >= 0x20000000 ? mm.sram[at - 0x20000000] : mm.flash[at]
          }
          const parsed = jgx.parseNotification(block)
          if (parsed) replies.push(parsed)
        }]]),
      })
      m.sram.set(frame, STRUCT + 1 - 0x20000000)
      m.sram[STRUCT + stockDisp.lengthOff - 0x20000000] = frame[0]
      m.r[0] = STRUCT
      m.run(stockDisp.entry)
    }
    send(jgx.updBegin(slot.body.length, slot.crc))
    for (let seq = 0; seq < jgx.updFrames(slot.body.length); seq++) {
      const at = seq * jgx.UPD_DATA_BYTES
      send(jgx.updData(seq, slot.body.subarray(at, at + jgx.UPD_DATA_BYTES)))
    }
    send(jgx.updEnd())
    replies.length = 0
    send(jgx.tickAsk())
    const r = replies[0]
    if (r.type !== 'tick') throw new Error('not a tick report')
    expect(r.hz).toBe(jgx.TICK_STOCK_HZ)
    expect(r.holdTicks).toBe(jgx.HOLD_TICKS_STOCK)
    replies.length = 0
    send(jgx.tickSet(100))
    expect((replies[0] as jgx.Ack).code).toBe(jgx.STATUS.REFUSED)
  })

  test('the slot header says what it is, and what it was built for', () => {
    const slot = slotFor(upd.SLOT_B)
    const head = readSlot(slot.body)!
    expect(head.magic).toBe(ext.MAGIC)
    expect(head.assembledFor).toBe((upd.SLOT_B + upd.SLOT_HDR_LEN) | 1)
    expect(head.size).toBe(slot.bytes)
    expect(head.capabilities).toBe(jgx.CAP.TICK)
    expect(head.subcommands).toEqual([jgx.SUB.TICK])
    // One feature, and it is small: the point of the accounting is that the next one
    // knows what is left.
    expect(slot.headroom).toBeGreaterThan(7000)
    expect(slot.frames).toBe(jgx.updFrames(slot.bytes))
  })

  test('the tick patch moves no vendor opcode: LOOP and LOOA still reach set_mode', () => {
    // Every edit is one immediate inside one halfword, so the dispatcher arms the
    // 28-byte hook would have destroyed are still there and still reachable. Executed
    // on the patched image, which is the one that would be flashed.
    const setMode = 0x22768
    for (const [word, mode] of [['LOOP', 24], ['LOOA', 35]] as const) {
      const fmc = new Fmc()
      fmc.flash.set(image.window, BASE)
      const modes: number[] = []
      const m = machine({
        fmc,
        stopAt: site.epilogue,
        hooks: new Map([[setMode | 1, (mm) => modes.push(mm.r[0] >>> 0)]]),
      })
      m.sram.set([0, 0, ...[...word].map((c) => c.charCodeAt(0))], STRUCT - 0x20000000)
      m.r[site.frameReg] = STRUCT
      m.r[13] = (m.r[13] - 24) >>> 0
      m.run(0x1850e) //                              the LIGHT arm's back-branch target
      expect(modes).toEqual([mode])
    }
  })

  test('and the patch changed nothing but immediates', () => {
    const facts = resolveTick(stock, BASE).facts!
    const edited = new Set(tickEdits(facts, stock, BASE).edits.map((e) => e.abs))
    let differ = 0
    for (let i = 0; i < stock.length; i++) {
      if (stock[i] === window[i]) continue
      differ++
      // Every differing byte is the low byte of an instruction an edit named.
      expect(edited.has(BASE + i)).toBe(true)
    }
    expect(differ).toBe(edited.size)
  })
})
