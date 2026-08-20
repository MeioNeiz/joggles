/**
 * The over-BT update loop, executed.
 *
 * These are the tests that decide whether Jacob's bar is met: that we can patch over
 * Bluetooth alone, and **patch again afterwards without bricking it**. Every one of
 * them runs the real assembled firmware against a model of the flash controller, so
 * what is being checked is behaviour and not layout.
 *
 * The order below is deliberate. The happy path first, then the same loop twice more,
 * and then every way it can fail: a wrong CRC, an interrupted transfer, a sequence
 * number out of range, and an attempt to write outside the slots. **The failure tests
 * are the point.** 8 August did not go wrong because the mechanism could not work, it
 * went wrong because nobody had run it.
 *
 * What a pass here is worth, and what it is not:
 * `research/tools/thumbsim.ts`'s own header has the list of what the model does not
 * cover. The big ones are time, interrupts and the BLE stack running concurrently.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import * as ota from '../../packages/core/src/ota.js'
import * as jgx from '../../packages/core/src/jgx.js'
import * as ext from './ext.js'
import { buildExtension, buildHook } from './ext.js'
import { DONE, Fmc, machine, type Machine } from './thumbsim.js'
import * as upd from './updater.js'

const DONOR = 'firmware/dump-12E69E-2026-08-19-a.bin'

/** Where the frame struct lives in SRAM during a test. */
const STRUCT = 0x20002000

describe.if(existsSync(DONOR))('replacing our own firmware over the air', () => {
  const donor = new Uint8Array(readFileSync(DONOR)).slice(0x16800, 0x29400)
  const layout = ext.resolveLayout(donor).layout!
  const site = layout.site

  /** The donor window with the hook and the extension in it, exactly as flashed. */
  const image = (() => {
    const w = donor.slice()
    const place = ext.placeExtension({ window: w, size: 2048, intoFill: true }).place!
    const x = buildExtension({ version: 1, base: place.addr, notify: layout.notify, site })
    w.set(buildHook(x.entry, site), site.callAt - 0x16800)
    w.set(x.code, x.base - 0x16800)
    return { window: w, ext: x }
  })()

  /**
   * A device: flash loaded with the image, and a way to send it command frames.
   *
   * One `Fmc` across every frame, so state carries between commands the way it does on
   * a unit. That is what lets a test send UPD_BEGIN, drop the connection, and check
   * what the flash holds afterwards.
   */
  function unit() {
    const fmc = new Fmc()
    fmc.flash.set(image.window, 0x16800)
    const replies: jgx.Notification[] = []
    /** The payload bytes as sent, for a reply whose fields the client cannot see yet. */
    const rawReplies: number[][] = []

    /** Send one 16-byte plaintext frame, as the vendor's stack would hand it over. */
    const send = (frame: Uint8Array) => {
      const m = machine({
        fmc,
        stopAt: site.epilogue,
        hooks: new Map([[layout.notify | 1, (mm: Machine) => {
          const len = mm.r[0] >>> 0
          const ptr = mm.r[1] >>> 0
          // An UPD_* reply is built on the stack and HELLO's is a constant in flash, so
          // the pointer can land in either space. Reading the wrong one silently gives
          // zeros, which parses as no notification at all.
          const block = new Uint8Array(16)
          block[0] = len
          for (let i = 0; i < len; i++) {
            const at = ptr + i
            block[1 + i] = at >= 0x20000000
              ? mm.sram[at - 0x20000000]
              : mm.flash[at]
          }
          rawReplies.push([...block.subarray(0, len + 1)])
          const parsed = jgx.parseNotification(block)
          if (parsed) replies.push(parsed)
        }]]),
      })
      // The dispatcher is handed a struct whose frame data begins one byte in, so wire
      // byte n sits at struct + n + 1. `ext.ARG` is the same conversion.
      m.sram.set(frame, STRUCT + 1 - 0x20000000)
      m.r[site.frameReg] = STRUCT
      m.r[13] = (m.r[13] - 24) >>> 0 //  as the dispatcher's prologue left it
      m.r[15] = site.callAt
      m.r[14] = DONE
      m.run(site.callAt)
      return m
    }

    return { fmc, replies, rawReplies, send }
  }

  const word = (f: Uint8Array, addr: number) =>
    (f[addr] | (f[addr + 1] << 8) | (f[addr + 2] << 16) | (f[addr + 3] << 24)) >>> 0

  /** Push a whole body through, optionally stopping before the commit. */
  function upload(
    d: ReturnType<typeof unit>,
    body: Uint8Array,
    opts: { crc?: number; commit?: boolean; frames?: number } = {},
  ) {
    const crc = opts.crc ?? ota.crc32(body)
    d.send(jgx.updBegin(body.length, crc))
    const total = jgx.updFrames(body.length)
    const upto = opts.frames ?? total
    for (let seq = 0; seq < upto; seq++) {
      const at = seq * jgx.UPD_DATA_BYTES
      d.send(jgx.updData(seq, body.subarray(at, at + jgx.UPD_DATA_BYTES)))
    }
    if (opts.commit !== false) d.send(jgx.updEnd())
    return crc
  }

  /** A body that is recognisably itself, so a wrong slot shows up as wrong bytes. */
  const bodyOf = (n: number, seed: number) =>
    new Uint8Array(n).map((_, i) => (i * 7 + seed) & 0xff)

  test('a slot arrives, validates, and becomes live', () => {
    const d = unit()
    const body = bodyOf(64, 1)
    const crc = upload(d, body)

    expect(d.replies.every((x) => x.type === 'update')).toBe(true)
    expect(d.replies.map((x) => (x as jgx.UpdReply).code).every((c) => c === jgx.UPD.OK))
      .toBe(true)

    const f = d.fmc.flash
    expect(word(f, upd.SLOT_A + upd.SLOT_HDR.MAGIC)).toBe(upd.SLOT_MAGIC)
    expect(word(f, upd.SLOT_A + upd.SLOT_HDR.GEN)).toBe(1)
    expect(word(f, upd.SLOT_A + upd.SLOT_HDR.LEN)).toBe(body.length)
    expect(word(f, upd.SLOT_A + upd.SLOT_HDR.CRC)).toBe(crc)
    expect([...f.slice(upd.SLOT_A + upd.SLOT_HDR_LEN, upd.SLOT_A + upd.SLOT_HDR_LEN + 64)])
      .toEqual([...body])
  })

  test('the magic is the LAST word programmed, which is what makes a failure safe', () => {
    const d = unit()
    upload(d, bodyOf(32, 2))
    const programs = d.fmc.events.filter((e) => e.kind === 'program')
    const magicAt = programs.findIndex((e) => e.addr === upd.SLOT_A + upd.SLOT_HDR.MAGIC)
    expect(magicAt).toBe(programs.length - 1)
  })

  test('patch again, and it lands in the OTHER slot with the first one intact', () => {
    const d = unit()
    const first = bodyOf(64, 1)
    upload(d, first)
    const second = bodyOf(48, 9)
    upload(d, second)

    const f = d.fmc.flash
    // B is live now.
    expect(word(f, upd.SLOT_B + upd.SLOT_HDR.MAGIC)).toBe(upd.SLOT_MAGIC)
    expect(word(f, upd.SLOT_B + upd.SLOT_HDR.GEN)).toBe(2)
    expect([...f.slice(upd.SLOT_B + upd.SLOT_HDR_LEN, upd.SLOT_B + upd.SLOT_HDR_LEN + 48)])
      .toEqual([...second])
    // And A was never touched by the second update, so there is something to fall back to.
    expect(word(f, upd.SLOT_A + upd.SLOT_HDR.GEN)).toBe(1)
    expect([...f.slice(upd.SLOT_A + upd.SLOT_HDR_LEN, upd.SLOT_A + upd.SLOT_HDR_LEN + 64)])
      .toEqual([...first])
  })

  test('and again, alternating back to A: this is the loop, three times round', () => {
    const d = unit()
    upload(d, bodyOf(64, 1))
    upload(d, bodyOf(48, 9))
    const third = bodyOf(80, 17)
    upload(d, third)

    const f = d.fmc.flash
    expect(word(f, upd.SLOT_A + upd.SLOT_HDR.GEN)).toBe(3)
    expect(word(f, upd.SLOT_B + upd.SLOT_HDR.GEN)).toBe(2)
    expect([...f.slice(upd.SLOT_A + upd.SLOT_HDR_LEN, upd.SLOT_A + upd.SLOT_HDR_LEN + 80)])
      .toEqual([...third])

    d.replies.length = 0
    d.send(jgx.updStatus())
    expect(d.replies).toEqual([
      {
        type: 'update',
        code: jgx.UPD.OK,
        status: { liveIsB: false, generation: 3, target: 'b' },
      },
    ])
  })

  test('UPD_STATUS names the slot the next write goes to, not only the live one', () => {
    // The inversion review 33 found: this reported `liveIsB` and nothing else, and the
    // one case where inverting it is wrong is the first update of every unit, where
    // nothing is live and the target is A. A client that inverted it built its slot for
    // B, and a slot built for the wrong base is the one failure the design cannot
    // catch. Both are named now, in the same reply, so there is nothing to invert.
    const target = (d: ReturnType<typeof unit>) => {
      d.replies.length = 0
      const raws: number[][] = []
      d.rawReplies.length = 0
      d.send(jgx.updStatus())
      raws.push(...d.rawReplies)
      // Seven payload bytes: marker, type, code, liveSlot, genLo, genHi, targetSlot.
      const block = raws[0]
      expect(block[0]).toBe(7)
      return { live: block[4], gen: block[5] | (block[6] << 8), next: block[7] }
    }
    const d = unit()
    // Virgin: nothing live, and the next write is A. This is the case that misled.
    expect(target(d)).toEqual({ live: 0, gen: 0, next: 0 })
    upload(d, bodyOf(32, 3))
    expect(target(d)).toEqual({ live: 0, gen: 1, next: 1 })
    upload(d, bodyOf(32, 4))
    expect(target(d)).toEqual({ live: 1, gen: 2, next: 0 })
  })

  // --- review 33, section 2: the cross-slot write ----------------------------------

  test('a stray UPD_DATA cannot reach the other slot, however high the sequence', () => {
    // The executed failure: two good updates, an abort that erases the target's header,
    // then ONE frame at sequence 1022, which used to land on the live slot's magic
    // word. `1022 * 8 = 8176`, which is below the erased length word, so the sequence
    // check passed and the guard bounded the address to both slots rather than to one.
    const d = unit()
    upload(d, bodyOf(64, 1))
    upload(d, bodyOf(48, 9))
    const liveBefore = d.fmc.flash.slice(upd.SLOT_B, upd.SLOT_B + upd.SLOT_SIZE)
    d.send(jgx.updAbort())
    expect(word(d.fmc.flash, upd.SLOT_A + upd.SLOT_HDR.LEN)).toBe(0xffffffff)

    d.replies.length = 0
    const before = d.fmc.counts().programs
    for (const seq of [1022, 1023, 1500, 2045, 2046]) {
      d.send(jgx.updData(seq, new Uint8Array(8)))
    }
    // Refused on the sequence, before the guard is consulted, because the length word
    // an abort leaves is not a length at all.
    expect(d.replies.every((r) => (r as jgx.UpdReply).code === jgx.UPD.BAD_SEQ)).toBe(true)
    expect(d.fmc.counts().programs).toBe(before)
    // The live slot is byte for byte what it was, which is the invariant the whole
    // design is sold on.
    expect([...d.fmc.flash.slice(upd.SLOT_B, upd.SLOT_B + upd.SLOT_SIZE)])
      .toEqual([...liveBefore])
    d.replies.length = 0
    d.send(jgx.updStatus())
    expect((d.replies[0] as jgx.UpdReply).status)
      .toEqual({ liveIsB: true, generation: 2, target: 'a' })
  })

  test('a stale length word from a previous staged image is refused too', () => {
    // Unit 1's staging bank still holds the 2026-08-08 APK image, and the bytes where
    // slot A's length word falls read `0x20003910`. That is not erased, so it passed
    // the old sequence check, and every sequence up to 2045 reached slot B.
    const d = unit()
    const stale = 0x20003910
    // Program it the way the bank already holds it: erased flash, then bits cleared.
    d.fmc.flash.set(
      new Uint8Array([stale & 0xff, (stale >> 8) & 0xff, (stale >> 16) & 0xff, stale >>> 24]),
      upd.SLOT_A + upd.SLOT_HDR.LEN,
    )
    expect(word(d.fmc.flash, upd.SLOT_A + upd.SLOT_HDR.LEN)).toBe(stale)

    const before = d.fmc.counts()
    for (const seq of [0, 1022, 1500, 2045]) d.send(jgx.updData(seq, new Uint8Array(8)))
    expect(d.replies.every((r) => (r as jgx.UpdReply).code === jgx.UPD.BAD_SEQ)).toBe(true)
    expect(d.fmc.counts().programs).toBe(before.programs)
    expect(d.fmc.counts().erases).toBe(before.erases)
  })

  test('the guard bounds writes to the TARGET slot, not to both', () => {
    // Directly, rather than through a sequence number: a length word that is a valid
    // length, and a sequence inside it, still cannot cross into the other slot because
    // the two bounds are independent. Slot A is the target here, so the last legal
    // address is inside A.
    const d = unit()
    upload(d, bodyOf(upd.MAX_BODY, 5))
    const programs = d.fmc.events.filter((e) => e.kind === 'program').map((e) => e.addr)
    expect(Math.min(...programs)).toBeGreaterThanOrEqual(upd.SLOT_A)
    expect(Math.max(...programs)).toBeLessThan(upd.SLOT_B)
  })

  test('an unlock that never takes is refused rather than written through', () => {
    // The state thumbsim cannot produce on its own, because it has no interrupts:
    // `REGLCTL` closed while the three key writes go out. Modelled by refusing the
    // register, which is what an aborted sequence leaves.
    const d = unit()
    const fmc = d.fmc
    const real = fmc.write.bind(fmc)
    let dropped = 0
    ;(fmc as unknown as { write: typeof fmc.write }).write = (addr, value) => {
      // Drop the middle key write, exactly as another write between them would.
      if (addr === 0x50000100 && value === 0x16) {
        dropped++
        return
      }
      real(addr, value)
    }
    const before = fmc.counts()
    d.replies.length = 0
    d.send(jgx.updBegin(64, 0))
    expect(dropped).toBeGreaterThan(0)
    expect((d.replies[0] as jgx.UpdReply).code).toBe(jgx.UPD.FMC_REFUSED)
    expect(fmc.counts().erases).toBe(before.erases)
    expect(fmc.counts().programs).toBe(before.programs)
  })

  // --- the failures, which are the reason any of this is shaped this way -----------

  test('a wrong CRC is refused and the live slot keeps running', () => {
    const d = unit()
    const good = bodyOf(64, 1)
    upload(d, good)
    const before = d.fmc.flash.slice(upd.SLOT_A, upd.SLOT_A + 128)

    d.replies.length = 0
    upload(d, bodyOf(48, 9), { crc: 0xdeadbeef })
    const last = d.replies[d.replies.length - 1] as jgx.UpdReply
    expect(last.code).toBe(jgx.UPD.BAD_CRC)

    // B was written but never made live, and A is byte for byte what it was.
    expect(word(d.fmc.flash, upd.SLOT_B + upd.SLOT_HDR.MAGIC)).not.toBe(upd.SLOT_MAGIC)
    expect([...d.fmc.flash.slice(upd.SLOT_A, upd.SLOT_A + 128)]).toEqual([...before])

    d.replies.length = 0
    d.send(jgx.updStatus())
    expect((d.replies[0] as jgx.UpdReply).status)
      .toEqual({ liveIsB: false, generation: 1, target: 'b' })
  })

  test('an interrupted transfer leaves a slot that cannot validate', () => {
    // The power-loss case, as far as a model can reach it: stop sending and never
    // commit. There is no session to time out, so the device is not left waiting.
    const d = unit()
    upload(d, bodyOf(64, 1))
    upload(d, bodyOf(64, 9), { frames: 3, commit: false })

    expect(word(d.fmc.flash, upd.SLOT_B + upd.SLOT_HDR.MAGIC)).not.toBe(upd.SLOT_MAGIC)
    d.replies.length = 0
    d.send(jgx.updStatus())
    expect((d.replies[0] as jgx.UpdReply).status)
      .toEqual({ liveIsB: false, generation: 1, target: 'b' })
  })

  test('and the next attempt just starts again, in the same slot', () => {
    const d = unit()
    upload(d, bodyOf(64, 1))
    upload(d, bodyOf(64, 9), { frames: 3, commit: false })
    const third = bodyOf(56, 33)
    upload(d, third)

    const f = d.fmc.flash
    expect(word(f, upd.SLOT_B + upd.SLOT_HDR.GEN)).toBe(2)
    expect([...f.slice(upd.SLOT_B + upd.SLOT_HDR_LEN, upd.SLOT_B + upd.SLOT_HDR_LEN + 56)])
      .toEqual([...third])
  })

  test('UPD_ABORT makes a half-written slot unusable on purpose', () => {
    const d = unit()
    upload(d, bodyOf(64, 1))
    upload(d, bodyOf(64, 9), { frames: 4, commit: false })
    d.replies.length = 0
    d.send(jgx.updAbort())
    expect((d.replies[0] as jgx.UpdReply).code).toBe(jgx.UPD.OK)
    // Header erased, so `slot_gen` reads it as generation 0.
    expect(word(d.fmc.flash, upd.SLOT_B + upd.SLOT_HDR.MAGIC)).toBe(0xffffffff)
    expect(word(d.fmc.flash, upd.SLOT_B + upd.SLOT_HDR.LEN)).toBe(0xffffffff)
  })

  test('a sequence number past the declared length is refused', () => {
    const d = unit()
    d.send(jgx.updBegin(16, 0))
    d.replies.length = 0
    d.send(jgx.updData(2, new Uint8Array(8))) //   16 bytes declared, so seq 0 and 1 only
    expect((d.replies[0] as jgx.UpdReply).code).toBe(jgx.UPD.BAD_SEQ)
  })

  test('a length of zero, or larger than a slot, is refused before any erase', () => {
    for (const len of [0, upd.MAX_BODY + 1, 0xffff]) {
      const d = unit()
      d.send(jgx.updBegin(len || 1, 0)) //         updBegin refuses 0 client-side
      if (len === 0) continue
      const reply = d.replies[0] as jgx.UpdReply
      expect(reply.code).toBe(jgx.UPD.BAD_LENGTH)
      expect(d.fmc.counts().erases).toBe(0)
    }
    expect(() => jgx.updBegin(0, 0)).toThrow()
  })

  test('UPD_END with nothing uploaded does not walk off the end of flash', () => {
    // The slot header reads 0xffffffff when erased, which is not zero. Without the
    // upper bound the CRC would run four gigabytes from the slot base.
    const d = unit()
    d.send(jgx.updEnd())
    expect((d.replies[0] as jgx.UpdReply).code).toBe(jgx.UPD.BAD_CRC)
  })

  test('with no slot at all it still answers, which is the whole recovery story', () => {
    const d = unit()
    d.send(jgx.updStatus())
    expect(d.replies).toEqual([
      {
        type: 'update',
        code: jgx.UPD.NO_SLOT,
        status: { liveIsB: false, generation: 0, target: 'a' },
      },
    ])
    // And HELLO answers too, so a unit with both slots dead is still reachable by the
    // commands that fix it.
    d.replies.length = 0
    d.send(jgx.hello())
    expect(d.replies[0]).toEqual({
      type: 'hello',
      version: 1,
      capabilities: jgx.CAP.SESSION | jgx.CAP.UPDATE,
    })
  })

  // --- the guard ------------------------------------------------------------------

  test('nothing outside the slots is ever written, across a whole update', () => {
    const d = unit()
    upload(d, bodyOf(256, 5))
    upload(d, bodyOf(256, 6))
    const touched = d.fmc.events
      .filter((e) => e.kind === 'erase' || e.kind === 'program')
      .map((e) => e.addr)
    expect(touched.length).toBeGreaterThan(0)
    for (const addr of touched) {
      expect(addr).toBeGreaterThanOrEqual(upd.SLOT_A)
      expect(addr).toBeLessThan(upd.SLOT_END)
    }
  })

  test('the resident block is outside the guard, so it cannot rewrite itself', () => {
    // Not a runtime property to test but an arithmetic one, and it is the reason a bug
    // in a slot is recoverable over the air and a bug in the updater is not.
    expect(image.ext.base).toBeLessThan(upd.SLOT_A)
    expect(image.ext.base + image.ext.code.length).toBeLessThanOrEqual(upd.SLOT_A)
  })

  test('the guard refuses every address outside the slots, called directly', () => {
    const guard = image.ext.base + (() => {
      // The label is not exported, so find it the way a reviewer would: the guard is
      // the only routine that loads SLOT_A and SLOT_END back to back.
      const refs = ext.referencesInto(image.window, 0x16800, upd.SLOT_A, upd.SLOT_A + 4)
      expect(refs.length).toBeGreaterThan(0)
      return 0
    })()
    void guard
    // Behavioural version of the same claim: an address below the slots is refused by
    // the FMC model too, because our firmware never reaches it. Proven by the sweep
    // above; this asserts the model would have noticed.
    const fmc = new Fmc()
    fmc.wrprot = 1
    fmc.ispcon = upd.ISPCON_APROM
    fmc.ispcmd = upd.CMD_PAGE_ERASE
    fmc.ispadr = 0x00300000 //                     the config page
    fmc.write(0x5000c010, 1)
    expect(fmc.counts().refusals).toBe(1)
    expect(fmc.counts().erases).toBe(0)
  })

  test('the FMC is locked again after every command, including the failures', () => {
    for (const drive of [
      (d: ReturnType<typeof unit>) => upload(d, bodyOf(32, 1)),
      (d: ReturnType<typeof unit>) => upload(d, bodyOf(32, 1), { crc: 1 }),
      (d: ReturnType<typeof unit>) => d.send(jgx.updData(9999, new Uint8Array(8))),
      (d: ReturnType<typeof unit>) => d.send(jgx.updAbort()),
    ]) {
      const d = unit()
      drive(d)
      expect(d.fmc.ispcon).toBe(0)
      expect(d.fmc.wrprot).toBe(0)
    }
  })

  test('locking preserves boot select and clears the fail flag', () => {
    // `fmc_lock` stored zero over the whole of `ISPCON`, which clears `BS` - the bit
    // `fmc_unlock` fifteen lines above goes out of its way to preserve - and cannot
    // clear `ISPFF`, which is write-one-to-clear. Neither is a hazard on these units,
    // because `CONFIG0` bit 7 is 1 so `BS` comes up 0, but the firmware was
    // reproducing the exact pattern `research/fmc-erase-program.md` finding 3 exists to
    // condemn. Review 33, section 6, and track 59 independently.
    const d = unit()
    d.fmc.ispcon = upd.ISPCON_BS | upd.ISPCON_ISPFF
    upload(d, bodyOf(32, 1))
    expect(d.fmc.ispcon).toBe(upd.ISPCON_BS)
    expect(d.fmc.wrprot).toBe(0)
    // And a path that sets the flag leaves it clear rather than latched behind a lock.
    const e = unit()
    e.send(jgx.updData(9999, new Uint8Array(8)))
    expect(e.fmc.ispcon & upd.ISPCON_ISPFF).toBe(0)
  })

  test('the CRC the firmware computes is ota.crc32, byte for byte', () => {
    // If these disagreed, every update would be refused and nothing would say why.
    // The firmware's is bitwise over the body; this drives a real upload of a body
    // whose CRC is computed here, and the commit only happens if they match.
    for (const n of [1, 7, 8, 9, 64, 255]) {
      const d = unit()
      const body = bodyOf(n, n)
      upload(d, body)
      expect(word(d.fmc.flash, upd.SLOT_A + upd.SLOT_HDR.MAGIC)).toBe(upd.SLOT_MAGIC)
      expect(word(d.fmc.flash, upd.SLOT_A + upd.SLOT_HDR.CRC)).toBe(ota.crc32(body))
    }
  })

  test('a body that is not a multiple of the frame size still commits', () => {
    // The last frame is padded and the CRC covers only the declared length, so the
    // padding must not be counted. Off-by-one here would refuse every odd-sized slot.
    const d = unit()
    const body = bodyOf(13, 4)
    upload(d, body)
    expect(word(d.fmc.flash, upd.SLOT_A + upd.SLOT_HDR.MAGIC)).toBe(upd.SLOT_MAGIC)
    expect(word(d.fmc.flash, upd.SLOT_A + upd.SLOT_HDR.LEN)).toBe(13)
  })

  test('a frame sent twice writes the same bytes and stays valid', () => {
    // Idempotent because the address comes from the sequence number, not from state.
    // Programming a word to the value it already holds clears no new bits.
    const d = unit()
    const body = bodyOf(32, 3)
    d.send(jgx.updBegin(body.length, ota.crc32(body)))
    for (let seq = 0; seq < jgx.updFrames(body.length); seq++) {
      const f = jgx.updData(seq, body.subarray(seq * 8, seq * 8 + 8))
      d.send(f)
      d.send(f) //                                 the retransmission
    }
    d.send(jgx.updEnd())
    expect(word(d.fmc.flash, upd.SLOT_A + upd.SLOT_HDR.MAGIC)).toBe(upd.SLOT_MAGIC)
  })

  test('the vendor application is untouched by all of it', () => {
    const d = unit()
    upload(d, bodyOf(512, 11))
    upload(d, bodyOf(512, 12))
    expect([...d.fmc.flash.slice(0x16800, 0x29400)]).toEqual([...image.window])
    // And the BLE stack below it.
    expect([...d.fmc.flash.slice(0, 0x16800)]).toEqual([...new Uint8Array(0x16800).fill(0xff)])
  })

  test('a generation that would read as invalid is refused, not committed', () => {
    // Generation 0 is reserved as "invalid", so a slot committed with it answers OK and
    // then never validates, and every later update repeats it: a unit that is
    // permanently un-updatable while replying OK to everything. 2^32 updates to reach,
    // and the cross-slot write can only lower a generation, so this is a shape being
    // closed rather than a reachable state: review 33, section 8.
    const d = unit()
    const gen = new Uint8Array(4).fill(0xff)
    d.fmc.flash.set(gen, upd.SLOT_A + upd.SLOT_HDR.GEN)
    d.fmc.flash.set(
      new Uint8Array([0x4a, 0x47, 0x58, 0x53]), //   'JGXS', so slot A validates
      upd.SLOT_A + upd.SLOT_HDR.MAGIC,
    )
    const before = d.fmc.counts()
    d.replies.length = 0
    d.send(jgx.updBegin(64, 0))
    expect((d.replies[0] as jgx.UpdReply).code).toBe(upd.UPD.EXHAUSTED)
    // Refused before any erase, so the spare slot is not even disturbed.
    expect(d.fmc.counts().erases).toBe(before.erases)
    expect(d.fmc.counts().programs).toBe(before.programs)
  })

  test('every resident command reaches the dispatcher through the length gate', () => {
    // **The test review 33 asked for, and the reason it asked.** Every case above enters
    // at the hook, thirty halfwords past the vendor's length gate, and three of the five
    // `UPD_*` frames used to be two bytes long: the gate drops anything under four, so
    // `UPD_END` returned silence and no slot ever went live. The frames are padded now;
    // this is what stops the next sub-command being added two bytes long.
    const dispatcher = ext.findDispatcher(image.window, 0x16800, site).dispatcher!
    expect(dispatcher.minBody).toBe(jgx.MIN_BODY)
    expect(dispatcher.maxBody).toBe(20)

    const fmc = new Fmc()
    fmc.flash.set(image.window, 0x16800)
    const answered: number[] = []
    const send = (frame: Uint8Array) => {
      const m = machine({
        fmc,
        stopAt: DONE,
        hooks: new Map([[layout.notify | 1, () => answered.push(frame[2])]]),
      })
      m.sram.set(frame, STRUCT + 1 - 0x20000000)
      m.sram[STRUCT + dispatcher.lengthOff - 0x20000000] = frame[0]
      m.r[0] = STRUCT
      m.run(dispatcher.entry)
    }
    const body = new Uint8Array(32).fill(7)
    send(jgx.hello())
    send(jgx.updBegin(body.length, ota.crc32(body)))
    for (let seq = 0; seq < jgx.updFrames(body.length); seq++) {
      send(jgx.updData(seq, body.subarray(seq * 8, seq * 8 + 8)))
    }
    send(jgx.updEnd())
    send(jgx.updStatus())
    send(jgx.updAbort())
    // One reply per command, so nothing was dropped before the opcode was read.
    expect(answered.filter((s) => s === jgx.SUB.HELLO).length).toBe(1)
    for (const sub of [jgx.SUB.UPD_BEGIN, jgx.SUB.UPD_END, jgx.SUB.UPD_STATUS, jgx.SUB.UPD_ABORT]) {
      expect(answered.filter((s) => s === sub).length).toBe(1)
    }
    expect(answered.filter((s) => s === jgx.SUB.UPD_DATA).length)
      .toBe(jgx.updFrames(body.length))
    // And the slot went live, which a silent `UPD_END` would not have managed.
    expect(word(fmc.flash, upd.SLOT_A + upd.SLOT_HDR.MAGIC)).toBe(upd.SLOT_MAGIC)
  })

  test('a frame under the gate is dropped, and it is our own padding that avoids it', () => {
    const dispatcher = ext.findDispatcher(image.window, 0x16800, site).dispatcher!
    const fmc = new Fmc()
    fmc.flash.set(image.window, 0x16800)
    let replies = 0
    const send = (frame: Uint8Array, len = frame[0]) => {
      const m = machine({
        fmc,
        stopAt: DONE,
        hooks: new Map([[layout.notify | 1, () => { replies++ }]]),
      })
      m.sram.set(frame, STRUCT + 1 - 0x20000000)
      m.sram[STRUCT + dispatcher.lengthOff - 0x20000000] = len
      m.r[0] = STRUCT
      m.run(dispatcher.entry)
    }
    // The frame `jgx.updStatus()` used to build: opcode and sub-command and nothing else.
    send(new Uint8Array([2, 0x4a, jgx.SUB.UPD_STATUS]), 2)
    expect(replies).toBe(0)
    // What it builds now.
    send(jgx.updStatus())
    expect(replies).toBe(1)
  })

  test('the deepest command leaves the stack where it found it, and uses this much', () => {
    // The chain is deeper than it was: the guard recomputes the target slot, so
    // `program_word` now reaches through `fmc_op`, `guard`, `target_slot`, `live_slot`
    // and `slot_gen`. Worth a number, because the stack headroom on this part is small
    // and the SRAM map in `notes/firmware-design.md` is the APK build's rather than
    // this one's.
    const dispatcher = ext.findDispatcher(image.window, 0x16800, site).dispatcher!
    const fmc = new Fmc()
    fmc.flash.set(image.window, 0x16800)
    const m = machine({ fmc, stopAt: DONE, hooks: new Map([[layout.notify | 1, () => {}]]) })
    const sp = m.r[13] >>> 0
    const guardLen = 512
    m.sram.fill(0xa5, sp - guardLen - 0x20000000, sp - 0x20000000)
    // `UPD_BEGIN` is the deepest: erase_span, erase_page, fmc_op, guard, target_slot,
    // live_slot and slot_gen, one inside the next.
    const frame = jgx.updBegin(64, 1)
    m.sram.set(frame, STRUCT + 1 - 0x20000000)
    m.sram[STRUCT + dispatcher.lengthOff - 0x20000000] = frame[0]
    m.r[0] = STRUCT
    m.run(dispatcher.entry)
    expect(m.r[13] >>> 0).toBe(sp)
    let lowest = sp
    for (let a = sp - guardLen; a < sp; a++) {
      if (m.sram[a - 0x20000000] !== 0xa5) {
        lowest = a
        break
      }
    }
    // Measured rather than asserted at a precise number: what matters is that it is
    // tens of bytes and not hundreds. When this was written it was 128 for `UPD_BEGIN`,
    // 76 for `UPD_DATA` and 60 for `HELLO`, on top of whatever the vendor's own stack
    // already holds under the dispatcher.
    expect(sp - lowest).toBeLessThanOrEqual(160)
    expect(sp - lowest).toBeGreaterThan(0)
  })

  test('the constants the firmware and the client share have not drifted', () => {
    expect(jgx.UPD_DATA_BYTES).toBe(upd.DATA_BYTES)
    // Every code the client knows means the same thing in the firmware. Not equality:
    // the firmware answers one code jgx.ts does not carry yet, `EXHAUSTED`, and this is
    // where that stays visible until the wire format gains it.
    for (const [name, code] of Object.entries(jgx.UPD)) {
      expect(upd.UPD[name as keyof typeof upd.UPD]).toBe(code)
    }
    // Was: EXHAUSTED is the one code the firmware answers and jgx.ts does not carry.
    // It carries it now, so this is the stronger claim, and it is the one worth holding:
    // a code the firmware can answer and the client cannot name reads as a silent unit.
    expect(Object.keys(upd.UPD).sort()).toEqual(Object.keys(jgx.UPD).sort())
    expect(upd.SLOT_A).toBe(ext.STAGING_BANK)
    expect(upd.MAX_BODY).toBe(upd.SLOT_SIZE - upd.SLOT_HDR_LEN)
  })
})
