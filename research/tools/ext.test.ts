/**
 * What the extension must satisfy before it is allowed near a device.
 *
 * The tests that matter here are the ones checked against the real stock image:
 * that the hook lands on the bytes it claims to, that the two ways into that block
 * both still reach the epilogue, and that the built image passes `ota.check`. The
 * rest is layout bookkeeping.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import * as ota from '../../packages/core/src/ota.js'
import * as jgx from '../../packages/core/src/jgx.js'
import { buildExtension, buildHook, readExtension, HDR, ARG } from './ext.js'
import * as ext from './ext.js'
import { Asm, showBytes } from './thumb.js'
import { DONE, Fmc, machine } from './thumbsim.js'

const built = buildExtension({ version: 1 })

describe('the extension block', () => {
  test('starts with the magic, so a built image can be identified', () => {
    expect(String.fromCharCode(...built.code.subarray(0, 4))).toBe(jgx.MAGIC)
  })

  test('is word-aligned and fits far inside free flash', () => {
    expect(built.code.length % 4).toBe(0)
    expect(built.base + built.code.length).toBeLessThan(ext.STAGING_BANK)
  })

  test('the entry is a Thumb address inside the block', () => {
    expect(built.entry & 1).toBe(1)
    expect(built.entry & ~1).toBeGreaterThanOrEqual(built.base)
    expect(built.entry & ~1).toBeLessThan(built.base + built.code.length)
  })

  test('the header describes what is actually compiled in', () => {
    const plain = new Uint8Array(built.base - 0x16800 + built.code.length)
    plain.set(built.code, built.base - 0x16800)
    expect(readExtension(plain)).toEqual({
      magic: jgx.MAGIC,
      version: 1,
      capabilities: jgx.CAP.SESSION | jgx.CAP.UPDATE,
      entry: built.entry,
      size: built.code.length,
      subcommands: [
        jgx.SUB.HELLO, jgx.SUB.UPD_BEGIN, jgx.SUB.UPD_DATA,
        jgx.SUB.UPD_END, jgx.SUB.UPD_ABORT, jgx.SUB.UPD_STATUS,
      ],
    })
  })

  test('the HELLO reply is exactly what the client parser expects', () => {
    // The firmware answer is a constant in flash, so it can be checked against the
    // parser here rather than only on hardware.
    const block = new Uint8Array(16)
    block[0] = built.helloReply.length
    block.set(built.helloReply, 1)
    expect(jgx.parseNotification(block)).toEqual({
      type: 'hello',
      version: 1,
      capabilities: jgx.CAP.SESSION | jgx.CAP.UPDATE,
    })
  })

  test('the reply is inside the 15-byte notify ceiling', () => {
    expect(built.helloReply.length).toBeLessThanOrEqual(jgx.MAX_NOTIFY_PAYLOAD)
  })

  test('the sub-command byte is read from where the client puts it', () => {
    // ARG converts a wire index to a dispatcher struct offset. If these disagree
    // the handler dispatches on the wrong byte and nothing works.
    expect(ARG(2)).toBe(3)
    expect(jgx.hello()[2]).toBe(jgx.SUB.HELLO)
  })

  test('reading a region with no magic reports nothing rather than guessing', () => {
    expect(readExtension(new Uint8Array(0x11000))).toBeNull()
  })
})

describe('the dispatcher hook', () => {
  const hook = buildHook(built.entry)

  test('is four bytes, and they are one bl', () => {
    expect(hook.length).toBe(4)
    expect(ext.HOOK_LEN).toBe(4)
    const b = ext.branchAt(hook, ext.APK_HOOK_SITE.callAt, ext.APK_HOOK_SITE.callAt)
    expect(b?.kind).toBe('bl')
  })

  test('lands on the extension entry, with the Thumb bit off the branch', () => {
    const b = ext.branchAt(hook, ext.APK_HOOK_SITE.callAt, ext.APK_HOOK_SITE.callAt)
    expect(b?.target).toBe(built.entry & ~1)
  })

  test('any flash address encodes, because BL reaches the whole part', () => {
    // The 28-byte hook reached free flash through a literal; this one reaches it with
    // a +/-16 MB branch, and the part is 256 KB, so no address in it needs refusing.
    expect(() => buildHook(0x29000 | 1)).not.toThrow()
    expect(() => buildHook(0x00001 | 1)).not.toThrow()
  })

  test('the bytes it expects to replace are rebuilt from the decode, not sliced', () => {
    // If this came out of the image it would assert the image against itself. It comes
    // out of the register, the letter and the island `findHookSite` concluded, so
    // `patch.ts` refusing it means the decode was wrong.
    expect(showBytes(ext.hookStockBytes(ext.APK_HOOK_SITE))).toBe('53 2a 69 d0')
  })
})

// firmware/ is gitignored, so the checks against real vendor bytes only run here.
const STOCK = 'firmware/TR1906R04-10_OTA.bin'

describe.if(existsSync(STOCK))('against the stock image', () => {
  const stock = new Uint8Array(readFileSync(STOCK))
  const plain = ota.plaintext(stock)
  const at = (abs: number, len: number) => plain.slice(abs - 0x16800, abs - 0x16800 + len)

  test('the extension base is exactly the end of the stock image', () => {
    expect(ext.EXT_BASE).toBe(0x16800 + plain.length)
  })

  test('the four bytes being replaced are the dead S compare', () => {
    expect(showBytes(at(ext.HOOK_ADDR, 4))).toBe('53 2a 69 d0') //   cmp r2,#'S'; beq
    expect(showBytes(at(ext.EPILOGUE, 2))).toBe('f8 bd') //          pop {r3-r7,pc}
  })

  test('an earlier S compare in the same chain is what makes it dead', () => {
    expect(showBytes(at(0x1828a, 4))).toBe('53 2a 6f d0') //         cmp r2,#'S'; beq
  })

  test('the LIGHT arm branches into the block the hook now leaves alone', () => {
    // This used to be the reason the hook needed a branch at a fixed offset. It is
    // kept because it is the witness that the block has a second entry point, which
    // is half of why the hook stopped writing that block at all.
    expect(showBytes(at(0x184a6, 2))).toBe('00 e7')
    expect(ext.branchAt(plain, 0x16800, 0x184a6)?.target).toBe(0x182aa)
  })

  test('the notify sender is where the HELLO handler calls it', () => {
    expect(showBytes(at(ext.NOTIFY, 2))).toBe('10 b5') //               push {r4, lr}
  })

  test('our opcode collides with nothing the dispatcher already tests', () => {
    const pattern = [jgx.OPCODE.charCodeAt(0), 0x2a] //                 cmp r2, #'J'
    let hits = 0
    for (let i = 0; i + 1 < plain.length; i++) {
      if (plain[i] === pattern[0] && plain[i + 1] === pattern[1]) hits++
    }
    expect(hits).toBe(0)
  })

  test('the tail of the image is zero padding, so nothing is overwritten', () => {
    expect([...at(ext.EXT_BASE - 24, 24)].every((b) => b === 0)).toBe(true)
  })
})

// --- Finding the anchors in an image that is not the APK -------------------------

const UNIT1 = 'firmware/dump-unit1-2026-08-19-a.bin'
/** A healthy pair, read-only, 2026-08-19. THE build that would actually be flashed. */
const DONOR = 'firmware/dump-12E69E-2026-08-19-a.bin'

describe('branch decoding', () => {
  const one = (...bytes: number[]) => ext.branchAt(new Uint8Array(bytes), 0x1000, 0x1000)

  test('B T2, forwards and backwards', () => {
    // e7fe is `b .`, the self-branch every fault handler ends in.
    expect(one(0xfe, 0xe7)?.target).toBe(0x1000)
    // e000 is `b +0`, i.e. the next instruction.
    expect(one(0x00, 0xe0)?.target).toBe(0x1004)
  })

  test('B T1 is conditional and 0xde / 0xdf are not branches at all', () => {
    const b = one(0x02, 0xd0)
    expect(b?.kind).toBe('b.cond')
    expect(b?.target).toBe(0x1008)
    expect(one(0x00, 0xde)).toBeNull()
    expect(one(0x00, 0xdf)).toBeNull()
  })

  test('a 32-bit BL round-trips against the assembler', () => {
    const a = new Asm(0x18000)
    a.bl(0x1a000)
    const code = a.assemble()
    const b = ext.branchAt(code, 0x18000, 0x18000)
    expect(b?.kind).toBe('bl')
    expect(b?.target).toBe(0x1a000)
  })
})

describe.if(existsSync(STOCK))('resolveLayout against the APK image', () => {
  const plain = ota.plaintext(new Uint8Array(readFileSync(STOCK)))
  const r = ext.resolveLayout(plain)

  test('it finds every constant this file has always hardcoded', () => {
    // The point of the test: the donor path and the APK path are one code path, so
    // resolving by content cannot quietly disagree with the addresses that have been
    // reviewed and built against since v1.
    expect(r.notes.filter((n) => n.severity === 'fatal')).toEqual([])
    expect(r.layout).not.toBeNull()
    expect(r.layout!.site).toEqual(ext.APK_HOOK_SITE)
    expect(r.layout!.notify).toBe(ext.NOTIFY)
    expect(r.layout!.aesKey).toBe(0x22b94)
    expect(r.layout!.advertName).toBe(0x2691c)
  })

  test('the hook site itself has nothing branching into it', () => {
    // CLAUDE.md's rule, run rather than remembered, on the four bytes actually written.
    const into = ext.branchesInto(plain, 0x16800, ext.HOOK_ADDR, ext.HOOK_ADDR + ext.HOOK_LEN)
    expect(into).toEqual([])
  })

  test('a branch into the four bytes is refused, not answered', () => {
    const doctored = plain.slice()
    const a = new Asm(0x18500)
    a.b(ext.HOOK_ADDR + 2)
    doctored.set(a.assemble(), 0x18500 - 0x16800)
    const bad = ext.resolveLayout(doctored)
    expect(bad.layout).toBeNull()
    expect(bad.notes.map((n) => n.message).join(' ')).toContain('land inside the four bytes')
  })

  test('a second referrer to the dead island means the compare is not dead', () => {
    const doctored = plain.slice()
    const a = new Asm(0x18500)
    a.b(ext.APK_HOOK_SITE.deadIsland)
    doctored.set(a.assemble(), 0x18500 - 0x16800)
    const bad = ext.resolveLayout(doctored)
    expect(bad.layout).toBeNull()
    expect(bad.notes.map((n) => n.message).join(' ')).toContain('referrer')
  })

  test('no dispatcher at all refuses rather than falling back to the constant', () => {
    const doctored = plain.slice()
    // Flatten the whole first-letter chain, so nothing looks like one any more.
    doctored.fill(0, 0x18280 - 0x16800, 0x182a6 - 0x16800)
    const bad = ext.resolveLayout(doctored)
    expect(bad.layout).toBeNull()
    expect(bad.notes.map((n) => n.message).join(' ')).toContain('no command dispatcher')
  })

  test('a chain with no repeated letter has no four dead bytes, and is refused', () => {
    const doctored = plain.slice()
    // Turn the second `S` into a letter the chain has not already answered.
    doctored[ext.HOOK_ADDR - 0x16800] = 0x5a //                          'Z'
    const bad = ext.resolveLayout(doctored)
    expect(bad.layout).toBeNull()
    expect(bad.notes.map((n) => n.message).join(' ')).toContain('no compare that can')
  })

  test('the epilogue is found, not assumed, and it is a pop', () => {
    expect(r.layout!.site.epilogue).toBe(ext.EPILOGUE)
    expect(showBytes(plain.slice(ext.EPILOGUE - 0x16800, ext.EPILOGUE - 0x16800 + 2)))
      .toBe('f8 bd')
  })

  test('placement on the APK image is exactly the EXT_BASE constant', () => {
    const p = ext.placeExtension({ window: plain, size: 88 })
    expect(p.place?.addr).toBe(ext.EXT_BASE)
    expect(p.place?.on).toBe('erased')
  })

  test('referencesInto finds an ldr-literal and reports raw words separately', () => {
    // 0x2145c, the notify sender, is called by BL rather than loaded, so the range
    // used here is one that is definitely loaded: the extension base itself, which
    // nothing in stock names at all.
    expect(ext.referencesInto(plain, 0x16800, ext.EXT_BASE, ext.STAGING_BANK)).toEqual([])
    const withOne = plain.slice()
    const a = new Asm(0x18600)
    a.ldrPool('r0', 'p')
    a.nop()
    a.label('p').word(ext.EXT_BASE + 8)
    withOne.set(a.assemble(), 0x18600 - 0x16800)
    const refs = ext.referencesInto(withOne, 0x16800, ext.EXT_BASE, ext.STAGING_BANK)
    expect(refs.some((x) => x.kind === 'ldr-literal' && x.value === ext.EXT_BASE + 8)).toBe(true)
    expect(refs.some((x) => x.kind === 'raw-word')).toBe(true)
  })

  test('a movs/lsls construction is caught, because trap 2 already bit once', () => {
    // `movs r4,#0xb3` / `lsls r4,r4,#9` is 0x16600, the export table, and it is how
    // the registrar at abs 0x190a4 reaches it. An address that is never a literal.
    const built = new Uint8Array(4)
    built.set(new Asm(0x18000).movs('r4', 0xb3).lsls('r4', 'r4', 9).assemble())
    const refs = ext.referencesInto(built, 0x18000, 0x16600, 0x16604)
    expect(refs).toEqual([{ at: 0x18000, kind: 'built', value: 0x16600 }])
  })
})

describe.if(existsSync(DONOR))('running the hook, on the donor build', () => {
  // Nothing in this repo has ever EXECUTED the extension. `thumb.test.ts` proves the
  // encoder agrees with the vendor's bytes, which is a claim about encoding; `ota.check`
  // is a claim about layout. Neither says the trampoline dispatches. `thumbsim.ts` runs
  // the assembled bytes, so these are the first tests of what the firmware DOES.
  const donor = new Uint8Array(readFileSync(DONOR)).slice(0x16800, 0x29400)
  const layout = ext.resolveLayout(donor).layout!
  const site = layout.site

  /** The donor window with our hook and extension in it, as flashed. */
  const image = (() => {
    const w = donor.slice()
    const place = ext.placeExtension({ window: w, size: 512, intoFill: true }).place!
    const x = buildExtension({ version: 1, base: place.addr, notify: layout.notify, site })
    w.set(buildHook(x.entry, site), site.callAt - 0x16800)
    w.set(x.code, x.base - 0x16800)
    return { window: w, ext: x }
  })()

  const FRAME = 0x20002000

  /**
   * Run the dispatcher from the hook site, exactly as the vendor's chain reaches it.
   *
   * Starting at `callAt` rather than at the trampoline is the point: the `bl` sets `lr`
   * itself, so the not-ours path returns where the real one would and carries on
   * through the vendor's own code to the epilogue.
   */
  const dispatch = (opcode: string, sub: number, r1 = 0xdeadbeef) => {
    const fmc = new Fmc()
    fmc.flash.set(image.window, 0x16800)
    const notified: { len: number; ptr: number; payload: number[] }[] = []
    const m = machine({
      fmc,
      stopAt: site.epilogue,
      hooks: new Map([[layout.notify | 1, (mm) => {
        const len = mm.r[0] >>> 0
        const ptr = mm.r[1] >>> 0
        // The reply is built on the stack now, not read out of flash: HELLO has to OR
        // the live slot's capability word into the resident one, so it cannot be a
        // constant. Read from whichever space the pointer names.
        const payload = Array.from({ length: len }, (_, i) =>
          ptr + i >= 0x20000000 ? mm.sram[ptr + i - 0x20000000] : mm.flash[ptr + i])
        notified.push({ len, ptr, payload })
      }]]),
    })
    m.sram[FRAME - 0x20000000 + 2] = opcode.charCodeAt(0)
    m.sram[FRAME - 0x20000000 + 3] = sub
    m.r[site.frameReg] = FRAME
    m.r[site.opReg] = r1 >>> 0
    m.r[15] = site.callAt
    m.r[14] = DONE
    // The dispatcher's prologue has already pushed {r3-r7,lr} by the time the chain runs.
    m.r[13] = (m.r[13] - 24) >>> 0
    m.run(site.callAt)
    return { m, notified, fmc }
  }

  test('a J frame reaches the HELLO handler and calls notify', () => {
    const { notified, m } = dispatch('J', jgx.SUB.HELLO)
    expect(notified.length).toBe(1)
    expect(notified[0].len).toBe(image.ext.helloReply.length)
    // With no slot live the reply is exactly the resident one: marker, type, version
    // and the resident capability word.
    expect(notified[0].payload).toEqual([...image.ext.helloReply])
    expect(m.r[15] >>> 0).toBe(site.epilogue)
  })

  test('and the stack is exactly where the dispatcher left it', () => {
    // The ours path ends by branching to the vendor's `pop {r3-r7,pc}`, so anything
    // left on the stack would pop into the wrong registers and return to nowhere.
    const before = machine({}).r[13]
    const { m } = dispatch('J', jgx.SUB.HELLO)
    expect(m.r[13] >>> 0).toBe((before - 24) >>> 0)
  })

  test('a frame that is not ours runs the vendor path and calls nothing', () => {
    const { notified, m } = dispatch('X', 0)
    expect(notified).toEqual([])
    expect(m.r[15] >>> 0).toBe(site.epilogue)
  })

  test('the opcode register is restored, whatever it held on the way in', () => {
    // The trampoline re-reads [frame,#2] rather than trusting the register, so the
    // vendor's chain resumes on the value it had. Garbage in the register on entry is
    // the strongest form of this: the frame is the only source of truth.
    const { m } = dispatch('X', 0, 0x00000000)
    expect(m.r[site.opReg] & 0xff).toBe('X'.charCodeAt(0))
  })

  test('an L frame that is not LIGHT still reaches LOOP, through the hook', () => {
    // The block the four-byte hook deliberately does not touch. `LOOP` is set_mode(24)
    // and it is reached only by the LIGHT arm's back-branch, so this is the path the
    // 28-byte hook would have destroyed.
    const setMode = 0x22768
    const fmc = new Fmc()
    fmc.flash.set(image.window, 0x16800)
    const modes: number[] = []
    const m = machine({
      fmc,
      stopAt: site.epilogue,
      hooks: new Map([[setMode | 1, (mm) => modes.push(mm.r[0] >>> 0)]]),
    })
    const f = FRAME - 0x20000000
    m.sram.set([0, 0, 0x4c, 0x4f, 0x4f, 0x50], f) //   .. 'L' 'O' 'O' 'P'
    m.r[site.frameReg] = FRAME
    m.r[13] = (m.r[13] - 24) >>> 0
    m.run(0x1850e) //                                  where the LIGHT arm branches back to
    expect(modes).toEqual([24])
  })

  test('LOOA still reaches set_mode(35), which the old hook would also have taken', () => {
    const setMode = 0x22768
    const fmc = new Fmc()
    fmc.flash.set(image.window, 0x16800)
    const modes: number[] = []
    const m = machine({
      fmc,
      stopAt: site.epilogue,
      hooks: new Map([[setMode | 1, (mm) => modes.push(mm.r[0] >>> 0)]]),
    })
    const f = FRAME - 0x20000000
    m.sram.set([0, 0, 0x4c, 0x4f, 0x4f, 0x41], f) //   .. 'L' 'O' 'O' 'A'
    m.r[site.frameReg] = FRAME
    m.r[13] = (m.r[13] - 24) >>> 0
    m.run(0x1850e)
    expect(modes).toEqual([35])
  })

  test('an unknown sub-command is ignored in silence, not faulted on', () => {
    const { notified, m } = dispatch('J', 0x7f)
    expect(notified).toEqual([])
    expect(m.r[15] >>> 0).toBe(site.epilogue)
  })
})

describe.if(existsSync(DONOR))('the build that would actually be flashed', () => {
  // Everything else in this file resolves the APK's site, including the describe below,
  // whose "donor window" is unit 1 BEFORE the repair and so is the APK image plus a
  // tail. Review, 2026-08-20: the one build that will ever go on a unit was the one
  // build with no test. These are its bytes.
  const window = new Uint8Array(readFileSync(DONOR)).slice(0x16800, 0x29400)
  const r = ext.resolveLayout(window)

  test('the whole hook site, every field', () => {
    expect(r.notes.filter((n) => n.severity === 'fatal')).toEqual([])
    expect(r.layout!.site).toEqual({
      chainAt: 0x184ea,
      loadAt: 0x184e4,
      opReg: 1, //                    r1 here, r2 on the APK. The reason resolving beats a constant
      frameReg: 4,
      callAt: 0x18506,
      deadImm: 0x53, //               'S'
      returnTo: 0x1850a,
      deadIsland: 0x185e2,
      epilogue: 0x1852a,
    })
  })

  test('the four bytes it will overwrite, literally', () => {
    expect(showBytes(window.slice(0x18506 - 0x16800, 0x1850a - 0x16800)))
      .toBe('53 29 6b d0') //         cmp r1,#0x53 / beq 0x185e2
    expect(showBytes(ext.hookStockBytes(r.layout!.site))).toBe('53 29 6b d0')
  })

  test('the compare that answers ahead of it is the same instruction', () => {
    // This is the check with teeth, because it reads bytes the hook does not write.
    expect(showBytes(window.slice(0x184ee - 0x16800, 0x184f0 - 0x16800))).toBe('53 29')
  })

  test('the other three anchors are where the donor keeps them', () => {
    expect(r.layout!.notify).toBe(0x21b70)
    expect(r.layout!.aesKey).toBe(0x235dc)
    expect(r.layout!.advertName).toBe(0x28688) //  ONE copy, not two
  })

  test('ten branches share the block the hook leaves alone', () => {
    // The finding that killed the 28-byte hook: its last four bytes are a
    // `bl set_mode` that ten other dispatcher arms branch straight into.
    const tail = ext.branchesInto(window, 0x16800, 0x18526, 0x1852a)
    expect(tail.map((b) => b.at)).toEqual([
      0x18632, 0x186fc, 0x18776, 0x187a4, 0x187b4,
      0x187c2, 0x187c6, 0x187ca, 0x1880c, 0x18810,
    ])
    // And the hook writes none of them.
    expect(ext.branchesInto(window, 0x16800, 0x18506, 0x1850a)).toEqual([])
  })

  test('nothing enters the chain between the two S compares', () => {
    // The check the whole deadness argument rests on.
    expect(ext.branchesInto(window, 0x16800, 0x184f0, 0x18508)).toEqual([])
  })

  test('a branch into that span is refused, which it used to not be', () => {
    const doctored = window.slice()
    const a = new Asm(0x18a00)
    a.b(0x184f2) //                   into the chain, past the live S compare
    doctored.set(a.assemble(), 0x18a00 - 0x16800)
    const bad = ext.resolveLayout(doctored)
    expect(bad.layout).toBeNull()
    expect(bad.notes.map((n) => n.message).join(' ')).toContain('enter the chain between')
  })

  test('the block goes on a page boundary, in the zero run', () => {
    const p = ext.placeExtension({ window, size: 96, intoFill: true })
    expect(p.place?.addr).toBe(0x28800)
    expect(p.place!.addr % ext.PAGE).toBe(0)
    expect(p.place?.on).toBe('zero-fill')
  })

  test('the adr in the data tail is why it is a page and not a word', () => {
    // 0x28784 holds `a5 03`, which decodes as `adr r5, #12` -> 0x28794. It is data in
    // the tail, but nothing offline can tell that, and a word-aligned placement at
    // 0x28788 put the block inside its reach.
    const reach = ext.referencesInto(window, 0x16800, 0x28788, 0x28800)
    expect(reach.some((x) => x.kind === 'adr' && x.value === 0x28794)).toBe(true)
    // A page-aligned block is out of it.
    expect(ext.referencesInto(window, 0x16800, 0x28800, ext.STAGING_BANK)).toEqual([])
  })

  test('our opcode is not a letter this dispatcher already answers', () => {
    const doctored = window.slice()
    doctored[0x184f6 - 0x16800] = jgx.OPCODE.charCodeAt(0) //  'A' arm becomes 'J'
    const bad = ext.resolveLayout(doctored)
    expect(bad.layout).toBeNull()
    expect(bad.notes.map((n) => n.message).join(' ')).toContain("already tests 'J'")
  })
})

describe.if(existsSync(UNIT1))('resolveLayout against a real donor window', () => {
  const d = new Uint8Array(readFileSync(UNIT1))
  const window = d.slice(0x16800, 0x29400)

  test('two GLASSES- prefixes refuse rather than pick one', () => {
    // The orphan at 0x26c00 carries the older image's copy at 0x28688. Patching the
    // wrong one renames nothing and leaves the live prefix stock.
    const r = ext.resolveLayout(window)
    expect(r.layout).toBeNull()
    const said = r.notes.map((n) => n.message).join(' ')
    expect(said).toContain('appears 2 times')
    expect(said).toContain('0x28688')
  })

  test('naming one on the command line resolves it, and says so', () => {
    const r = ext.resolveLayout(window, { advertNameAt: 0x2691c })
    expect(r.layout?.advertName).toBe(0x2691c)
    expect(r.notes.some((n) => n.severity === 'warn')).toBe(true)
  })

  test('there is no erased flash in this window, so placement refuses', () => {
    // 0x28787 to 0x293ff is programmed zeros, not 0xff, so `EXT_BASE` would land the
    // block inside the orphan and the default has nowhere safe to go.
    const p = ext.placeExtension({ window, size: 88 })
    expect(p.place).toBeNull()
    // The refusal used to be a bare null, so build-firmware printed "nowhere to put
    // the extension" and nothing about why. The reason travels with it now.
    expect(p.notes.map((n) => n.message).join(' ')).toContain('no erased flash')
  })

  test('--into-fill uses the zero run, after the reference scan comes back empty', () => {
    const p = ext.placeExtension({ window, size: 88, intoFill: true })
    expect(p.place?.addr).toBe(0x28800)
    expect(p.place?.on).toBe('zero-fill')
  })

  test('--into-fill still refuses when something names the run', () => {
    const doctored = window.slice()
    const a = new Asm(0x18600)
    a.ldrPool('r0', 'p')
    a.nop()
    a.label('p').word(0x28810) //  inside the page-aligned run, not below it
    doctored.set(a.assemble(), 0x18600 - 0x16800)
    const p = ext.placeExtension({ window: doctored, size: 88, intoFill: true })
    expect(p.place).toBeNull()
    expect(p.notes.map((n) => n.message).join(' ')).toContain('name an address inside')
  })
})

describe('the hook at an address that is not the APK\'s', () => {
  const site: ext.HookSite = {
    chainAt: 0x182e0, loadAt: 0x182dc, opReg: 1, frameReg: 4,
    callAt: 0x18300, deadImm: 0x53, returnTo: 0x18304, deadIsland: 0x18400,
    epilogue: 0x1831c,
  }

  test('the bl is emitted at the site, wherever the site is', () => {
    const hook = buildHook(0x287a1, site)
    expect(hook.length).toBe(4)
    expect(ext.branchAt(hook, site.callAt, site.callAt)?.target).toBe(0x287a0)
  })

  test('the expected stock bytes follow the register the site names', () => {
    // r1 rather than r2, which is the whole difference between the two builds.
    expect(showBytes(ext.hookStockBytes(site))).toBe('53 29 7d d0')
  })

  test('the trampoline reads the opcode out of the register the site names', () => {
    const one = buildExtension({ version: 1, base: 0x28788, site })
    const two = buildExtension({ version: 1, base: 0x28788, site: ext.APK_HOOK_SITE })
    expect(one.code.length).toBe(two.code.length)
    expect([...one.code]).not.toEqual([...two.code])
    // ldrb r1,[r4,#2] is 78 a1; ldrb r2,[r4,#2] is 78 a2.
    const at = (c: Uint8Array) => showBytes(c.subarray(one.entry - 1 - 0x28788,
      one.entry - 1 - 0x28788 + 2))
    expect(at(one.code)).toBe('a1 78')
    expect(at(two.code)).toBe('a2 78')
  })

  test('the extension calls notify wherever the image keeps it', () => {
    const a = buildExtension({ version: 1, base: 0x28788, notify: 0x21000 })
    const b = buildExtension({ version: 1, base: 0x28788, notify: 0x2145c })
    expect(a.code.length).toBe(b.code.length)
    expect([...a.code]).not.toEqual([...b.code])
  })
})
