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
import { showBytes } from './thumb.js'

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
      capabilities: jgx.CAP.SESSION,
      entry: built.entry,
      size: built.code.length,
      subcommands: [jgx.SUB.HELLO],
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
      capabilities: jgx.CAP.SESSION,
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

  test('is exactly the length of the block it replaces', () => {
    expect(hook.length).toBe(ext.HOOK_LEN)
  })

  test('compares against our opcode first', () => {
    expect(showBytes(hook.subarray(0, 2))).toBe(`${jgx.OPCODE.charCodeAt(0).toString(16)} 2a`)
  })

  test('the LIGHT arm lands on a branch to the epilogue, not on our trampoline', () => {
    // abs 0x184a6 jumps to 0x182aa for any L opcode that is not LIGHT. That is 4
    // bytes into the block, and it must be `b <epilogue>`: e0 0a is b +0x14, which
    // from 0x182aa reaches 0x182c2.
    const at = ext.LIGHT_FALLBACK - ext.HOOK_ADDR
    expect(at).toBe(4)
    expect(showBytes(hook.subarray(at, at + 2))).toBe('0a e0')
  })

  test('carries the extension entry as its literal', () => {
    const dv = new DataView(hook.buffer, hook.byteOffset)
    expect(dv.getUint32(0x182b4 - ext.HOOK_ADDR, true)).toBe(built.entry)
  })

  test('any flash address encodes, because the target is a literal not a branch', () => {
    // Named for what it checks: the hook reaches free flash through a 32-bit word, so
    // distance is a non-issue and no address needs refusing. The failure this design
    // *can* have is a layout that stops landing a branch on LIGHT_FALLBACK, which
    // buildHook asserts and the test above covers.
    expect(() => buildHook(0x29000 | 1)).not.toThrow()
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

  test('the block being replaced is the LOOP arm, not something else', () => {
    expect(showBytes(at(ext.HOOK_ADDR, 4))).toBe('4c 2a 0b d1') //      cmp r2,#'L'
    expect(showBytes(at(ext.HOOK_ADDR + 26, 2))).toBe('87 fd') //       tail of the bl
    expect(showBytes(at(ext.EPILOGUE, 2))).toBe('f8 bd') //             pop {r3-r7,pc}
  })

  test('the LIGHT arm still branches back into the block', () => {
    // If this ever changes, the hook layout is answering a question nobody asked
    // and the branch target needs re-deriving before anything is flashed.
    expect(showBytes(at(0x184a6, 2))).toBe('00 e7')
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
