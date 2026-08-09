/**
 * The build pipeline's refusals.
 *
 * `patch.ts` exists to fail loudly on a wrong address, so most of what is worth
 * testing is what it declines to emit. The happy path is covered too, end to end:
 * stock in, our v1 image out, `ota.check` satisfied.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ota from '../../packages/core/src/ota.js'
import * as jgx from '../../packages/core/src/jgx.js'
import { build, bytes } from './patch.js'
import { buildExtension, buildHook, readExtension } from './ext.js'
import * as ext from './ext.js'

const STOCK = 'firmware/TR1906R04-10_OTA.bin'
const dir = mkdtempSync(join(tmpdir(), 'joggles-patch-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const out = (name: string) => join(dir, name)
const quiet = () => {}

const STOCK_LOOP = bytes(
  '4c 2a 0b d1 e0 78 4f 28 08 d1 20 79 4f 28 05 d1 60 79 50 28 02 d1 18 20 09 f0 87 fd',
)

describe.if(existsSync(STOCK))('building the v1 image', () => {
  const stock = new Uint8Array(readFileSync(STOCK))
  const extension = buildExtension({ version: 1 })
  const hook = buildHook(extension.entry)

  const v1 = () =>
    build({
      out: out('v1.bin'),
      stock: STOCK,
      log: quiet,
      assertions: [
        { abs: 0x184a6, expect: bytes('00 e7'), note: 'the LIGHT arm back-branch' },
      ],
      edits: [{ abs: ext.HOOK_ADDR, expect: STOCK_LOOP, to: hook, note: 'the hook' }],
      appends: [{ abs: extension.base, data: extension.code, note: 'JGX1 v1' }],
    })

  test('produces an image ota.check will pass', async () => {
    const container = await v1()
    const verdict = ota.check(container, { stock })
    expect(verdict.findings.filter((f) => f.severity === 'fatal')).toEqual([])
    expect(verdict.safe).toBe(true)
  })

  test('grows by exactly the extension, and nothing else moves', async () => {
    const container = await v1()
    const before = ota.plaintext(stock)
    const after = ota.plaintext(container)
    expect(after.length - before.length).toBe(extension.code.length)

    // Every in-place difference is inside the 28-byte hook. If an append had
    // shifted anything, this would light up across the whole image.
    for (let i = 0; i < before.length; i++) {
      if (before[i] === after[i]) continue
      const abs = i + 0x16800
      expect(abs).toBeGreaterThanOrEqual(ext.HOOK_ADDR)
      expect(abs).toBeLessThan(ext.HOOK_ADDR + ext.HOOK_LEN)
    }
  })

  test('the flashed extension reads back as the one that was built', async () => {
    const container = await v1()
    expect(readExtension(ota.plaintext(container))).toMatchObject({
      magic: jgx.MAGIC,
      version: 1,
      entry: extension.entry,
      subcommands: [jgx.SUB.HELLO],
    })
  })

  test('the hook in the flashed image points at the flashed entry', async () => {
    const plain = ota.plaintext(await v1())
    const dv = new DataView(plain.buffer, plain.byteOffset)
    expect(dv.getUint32(0x182b4 - 0x16800, true)).toBe(extension.entry)
  })
})

describe.if(existsSync(STOCK))('what the builder refuses', () => {
  test('an edit whose expected bytes are not there', async () => {
    const promise = build({
      out: out('bad-expect.bin'),
      stock: STOCK,
      log: quiet,
      edits: [{ abs: 0x182a6, expect: bytes('de ad be ef'), to: bytes('00 00 00 00'), note: 'x' }],
    })
    expect(promise).rejects.toThrow(/did not match its expectation/)
  })

  test('an assertion whose bytes have moved', async () => {
    const promise = build({
      out: out('bad-assert.bin'),
      stock: STOCK,
      log: quiet,
      assertions: [{ abs: 0x184a6, expect: bytes('de ad'), note: 'the LIGHT branch' }],
      edits: [],
    })
    expect(promise).rejects.toThrow(/did not match its expectation/)
  })

  test('an append that lands inside the stock image', async () => {
    // This is the dangerous mistake: silently rewriting real code with no `expect`
    // to catch it. Appends may only go past the end.
    const promise = build({
      out: out('overlap.bin'),
      stock: STOCK,
      log: quiet,
      edits: [],
      appends: [{ abs: 0x26000, data: new Uint8Array(4), note: 'inside the image' }],
    })
    expect(promise).rejects.toThrow(/lands inside the stock image/)
  })

  test('an append that would run past the application region', async () => {
    const promise = build({
      out: out('too-big.bin'),
      stock: STOCK,
      log: quiet,
      edits: [],
      appends: [{ abs: ext.EXT_BASE, data: new Uint8Array(20000), note: 'far too much' }],
    })
    expect(promise).rejects.toThrow(/ceiling/)
  })

  test('an edit that would run from the AES key into the S-box', async () => {
    const promise = build({
      out: out('sbox.bin'),
      stock: STOCK,
      log: quiet,
      edits: [
        {
          abs: 0x22b94,
          expect: bytes('34 52 2a 5b 7a 6e 49 2c 08 09 0a 9d 8d 2a 23 f8 63'),
          to: new Uint8Array(17),
          note: 'a 17-byte key write',
        },
      ],
    })
    expect(promise).rejects.toThrow(/refusing to emit/)
  })

  test('an edit that changes the length of what it replaces', async () => {
    const promise = build({
      out: out('resize.bin'),
      stock: STOCK,
      log: quiet,
      edits: [{ abs: 0x182a6, expect: bytes('4c 2a'), to: bytes('4c 2a 00'), note: 'x' }],
    })
    expect(promise).rejects.toThrow(/refusing to emit/)
  })
})
