/**
 * The assembler is checked against the vendor's bytes, not against itself.
 *
 * Two blocks of stock firmware are reassembled from mnemonics and compared with
 * what is actually in the image: the `LOOP` dispatcher arm (the block the extension
 * hook overwrites) and the whole notify sender (the function the extension calls).
 * Between them they exercise every encoding the extension uses, and any mistake
 * shows up here rather than on a device that then has to be re-flashed.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import * as ota from '../../packages/core/src/ota.js'
import { Asm, bytes, showBytes } from './thumb.js'

const BASE = 0x16800
const STOCK = 'firmware/TR1906R04-10_OTA.bin'

describe('encodings that have no stock counterpart', () => {
  test('a backward conditional branch', () => {
    const a = new Asm(0x1000)
    a.label('top').nop().bcond('ne', 'top')
    expect(showBytes(a.assemble())).toBe('00 bf fd d1')
  })

  test('an unconditional branch forward', () => {
    const a = new Asm(0x1000)
    a.b('end').nop().nop().label('end').nop()
    expect(showBytes(a.assemble())).toBe('01 e0 00 bf 00 bf 00 bf')
  })

  test('a literal load resolves through Align(PC, 4)', () => {
    // The load sits at an odd halfword, so the base rounds down to 0x1004 and the
    // offset is 4, not 6. Getting this wrong reads the neighbouring word.
    const a = new Asm(0x1000)
    a.nop().ldrPool('r1', 'lit').nop().nop().label('lit').word(0xdeadbeef)
    expect(showBytes(a.assemble())).toBe('00 bf 01 49 00 bf 00 bf ef be ad de')
  })

  test('branches out of range are refused rather than truncated', () => {
    const a = new Asm(0x1000)
    a.bcond('eq', 0x2000)
    expect(() => a.assemble()).toThrow(/out of/)
  })

  test('an unaligned literal is refused', () => {
    const a = new Asm(0x1000)
    a.ldrPool('r0', 0x1002)
    expect(() => a.assemble()).toThrow(/word aligned/)
  })

  test('a register that does not exist in a low-register slot is refused', () => {
    expect(() => new Asm(0x1000).movs('r8' as never, 1)).toThrow(/low register/)
  })
})

// firmware/ is gitignored, so the byte-level checks only run where it is present.
describe.if(existsSync(STOCK))('reassembling stock firmware', () => {
  const plain = ota.plaintext(new Uint8Array(readFileSync(STOCK)))
  const at = (abs: number, len: number) => plain.slice(abs - BASE, abs - BASE + len)

  test('the LOOP dispatcher arm, abs 0x182a6, 28 bytes', () => {
    const EPILOGUE = 0x182c2
    const a = new Asm(0x182a6)
    a.cmp('r2', 0x4c) //          'L'
    a.bcond('ne', EPILOGUE)
    a.ldrb('r0', 'r4', 3)
    a.cmp('r0', 0x4f) //          'O'
    a.bcond('ne', EPILOGUE)
    a.ldrb('r0', 'r4', 4)
    a.cmp('r0', 0x4f) //          'O'
    a.bcond('ne', EPILOGUE)
    a.ldrb('r0', 'r4', 5)
    a.cmp('r0', 0x50) //          'P'
    a.bcond('ne', EPILOGUE)
    a.movs('r0', 24) //           set_mode(24)
    a.bl(0x21dd0)
    expect(showBytes(a.assemble())).toBe(showBytes(at(0x182a6, 28)))
  })

  test('the notify sender, abs 0x2145c, 76 bytes including its literal pool', () => {
    const a = new Asm(0x2145c)
    a.push(['r4', 'lr'])
    a.ldrPool('r2', 'frame')
    a.cmp('r0', 0)
    a.strb('r0', 'r2', 0)
    a.bcond('eq', 'send')
    a.subs3('r1', 'r1', 1)
    a.lsls('r3', 'r0', 31) //     odd length? copy one byte first
    a.bcond('eq', 'pairs')
    a.ldrb('r3', 'r1', 1)
    a.strb('r3', 'r2', 1)
    a.adds3('r1', 'r1', 1)
    a.adds3('r2', 'r2', 1)
    a.label('pairs')
    a.lsrs('r0', 'r0', 1)
    a.bcond('eq', 'send')
    a.label('loop')
    a.ldrb('r3', 'r1', 1)
    a.strb('r3', 'r2', 1)
    a.ldrb('r3', 'r1', 2)
    a.strb('r3', 'r2', 2)
    a.subs3('r0', 'r0', 1)
    a.adds3('r1', 'r1', 2)
    a.adds3('r2', 'r2', 2)
    a.cmp('r0', 0)
    a.bcond('ne', 'loop')
    a.label('send')
    a.ldrPool('r1', 'cipher')
    a.ldrPool('r0', 'frame')
    a.bl(0x1ca8c) //              encrypt frame -> cipher
    a.movs('r2', 0x10)
    a.ldrPool('r1', 'cipher')
    a.movs('r0', 0x0b) //         hardcoded characteristic index
    a.bl(0x192cc) //              GATT notify
    a.pop(['r4', 'pc'])
    a.half(0) //                  alignment filler before the pool
    a.label('frame').word(0x20003041)
    a.label('cipher').word(0x20003055)
    expect(showBytes(a.assemble())).toBe(showBytes(at(0x2145c, 76)))
  })

  test('bytes() parses the same hex the peek output prints', () => {
    expect(bytes('4c 2a 0b d1')).toEqual(at(0x182a6, 4))
  })
})
