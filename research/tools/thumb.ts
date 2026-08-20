/**
 * Thumb-1 assembler, only the forms the firmware extension needs.
 *
 * Why hand-roll one: the extension is a few dozen instructions appended to a stock
 * image, and the alternative is an arm-none-eabi toolchain that this repo does not
 * otherwise need. Encoding a fixed instruction set is small, and unlike a toolchain
 * it can be checked against the vendor's own bytes: `thumb.test.ts` reassembles the
 * stock `LOOP` block and the notify sender from mnemonics and asserts the output is
 * byte-identical to what is in the image. That is a stronger guarantee than "it
 * built", because it proves the encoder agrees with the code already running on the
 * device.
 *
 * ARMv6-M only, which is what this Cortex-M0 executes. No IT blocks, no 32-bit
 * instructions except BL, no high registers beyond MOV/BX/BLX.
 *
 * Addresses are `abs`, i.e. flash addresses, matching the research documents.
 *
 *   const a = new Asm(0x26a24)
 *   a.push(['r4', 'lr'])
 *   a.ldrb('r0', 'r4', 3)
 *   a.bl(0x2145c)
 *   a.pop(['r4', 'pc'])
 *   const code = a.assemble()
 */

export type Reg = 'r0' | 'r1' | 'r2' | 'r3' | 'r4' | 'r5' | 'r6' | 'r7'
export type AnyReg = Reg | 'r8' | 'r9' | 'r10' | 'r11' | 'r12' | 'sp' | 'lr' | 'pc'

const REGS: Record<AnyReg, number> = {
  r0: 0, r1: 1, r2: 2, r3: 3, r4: 4, r5: 5, r6: 6, r7: 7,
  r8: 8, r9: 9, r10: 10, r11: 11, r12: 12, sp: 13, lr: 14, pc: 15,
}

/** Condition codes for B<cond>, in encoding order. */
export const COND = {
  eq: 0, ne: 1, hs: 2, lo: 3, mi: 4, pl: 5, vs: 6, vc: 7,
  hi: 8, ls: 9, ge: 10, lt: 11, gt: 12, le: 13,
} as const
export type Cond = keyof typeof COND

/** A branch or literal-pool target: a label name, or an absolute flash address. */
export type Target = string | number

const hx = (n: number) => '0x' + (n >>> 0).toString(16)

const lo = (r: AnyReg, what: string): number => {
  const n = REGS[r]
  if (n === undefined) throw new Error(`${what}: unknown register ${r}`)
  if (n > 7) throw new Error(`${what}: ${r} is not a low register`)
  return n
}

const fits = (v: number, bits: number, what: string): number => {
  if (!Number.isInteger(v) || v < 0 || v >= 1 << bits) {
    throw new Error(`${what}: ${v} does not fit in ${bits} unsigned bits`)
  }
  return v
}

type FixKind = 'b' | 'bcond' | 'bl' | 'ldrpool' | 'word'

interface Fixup {
  kind: FixKind
  /** Offset into the output buffer of the first byte of the instruction or word. */
  at: number
  target: Target
  /** Included in error messages so a bad branch names its own source line. */
  what: string
}

export class Asm {
  private readonly out: number[] = []
  private readonly labels = new Map<string, number>()
  private readonly fixups: Fixup[] = []

  /**
   * @param org flash address the first emitted byte will live at. Halfword
   * alignment is all Thumb needs; `word()` and `ldrPool()` check word alignment
   * where it actually matters. The stock `LOOP` block the hook overwrites starts
   * at `abs 0x182a6`, so demanding word alignment here would rule it out.
   */
  constructor(readonly org: number) {
    if (org % 2 !== 0) throw new Error(`org ${hx(org)} must be halfword aligned`)
  }

  /** Address the next emitted byte will occupy. */
  get pc(): number {
    return this.org + this.out.length
  }

  get size(): number {
    return this.out.length
  }

  private emit16(v: number): void {
    this.out.push(v & 0xff, (v >> 8) & 0xff)
  }

  private emit32(v: number): void {
    this.emit16(v & 0xffff)
    this.emit16((v >>> 16) & 0xffff)
  }

  label(name: string): this {
    if (this.labels.has(name)) throw new Error(`duplicate label ${name}`)
    this.labels.set(name, this.pc)
    return this
  }

  /** Resolve a label or pass an absolute address straight through. */
  private resolve(t: Target, what: string): number {
    if (typeof t === 'number') return t
    const v = this.labels.get(t)
    if (v === undefined) throw new Error(`${what}: undefined label ${t}`)
    return v
  }

  // --- data ---------------------------------------------------------------------

  byte(...vs: number[]): this {
    for (const v of vs) this.out.push(fits(v, 8, 'byte'))
    return this
  }

  half(v: number): this {
    this.emit16(fits(v, 16, 'half'))
    return this
  }

  /** A 32-bit word. A label target resolves to its address; add 1 yourself for Thumb. */
  word(v: Target): this {
    if (this.pc % 4 !== 0) throw new Error(`word at ${hx(this.pc)} is not aligned`)
    if (typeof v === 'number') this.emit32(v >>> 0)
    else {
      this.fixups.push({ kind: 'word', at: this.out.length, target: v, what: 'word' })
      this.emit32(0)
    }
    return this
  }

  ascii(s: string): this {
    for (const c of s) {
      const n = c.charCodeAt(0)
      if (n > 0x7f) throw new Error(`ascii: ${JSON.stringify(c)} is not ASCII`)
      this.out.push(n)
    }
    return this
  }

  /** Pad with `fill` until the address is a multiple of `n`. */
  align(n = 4, fill = 0): this {
    while (this.pc % n !== 0) this.out.push(fill & 0xff)
    return this
  }

  /** Pad with `fill` until exactly `bytes` long. Fails if already past it. */
  padTo(bytes: number, fill = 0): this {
    if (this.out.length > bytes) {
      throw new Error(`padTo: already ${this.out.length} bytes, past ${bytes}`)
    }
    while (this.out.length < bytes) this.out.push(fill & 0xff)
    return this
  }

  // --- instructions -------------------------------------------------------------

  push(regs: AnyReg[]): this {
    let list = 0
    let m = 0
    for (const r of regs) {
      if (r === 'lr') m = 1
      else list |= 1 << lo(r, 'push')
    }
    this.emit16(0xb400 | (m << 8) | list)
    return this
  }

  pop(regs: AnyReg[]): this {
    let list = 0
    let p = 0
    for (const r of regs) {
      if (r === 'pc') p = 1
      else list |= 1 << lo(r, 'pop')
    }
    this.emit16(0xbc00 | (p << 8) | list)
    return this
  }

  /** movs Rd, #imm8 */
  movs(rd: Reg, imm: number): this {
    this.emit16(0x2000 | (lo(rd, 'movs') << 8) | fits(imm, 8, 'movs'))
    return this
  }

  /** mov Rd, Rm, the high-register form. Does not set flags. */
  mov(rd: AnyReg, rm: AnyReg): this {
    const d = REGS[rd]
    const m = REGS[rm]
    this.emit16(0x4600 | ((d >> 3) << 7) | (m << 3) | (d & 7))
    return this
  }

  /** adds Rdn, #imm8 */
  adds(rdn: Reg, imm: number): this {
    this.emit16(0x3000 | (lo(rdn, 'adds') << 8) | fits(imm, 8, 'adds'))
    return this
  }

  /** adds Rd, Rn, Rm */
  addsReg(rd: Reg, rn: Reg, rm: Reg): this {
    const w = 'addsReg'
    this.emit16(0x1800 | (lo(rm, w) << 6) | (lo(rn, w) << 3) | lo(rd, w))
    return this
  }

  /** adds Rd, Rn, #imm3, the three-operand form */
  adds3(rd: Reg, rn: Reg, imm: number): this {
    const w = 'adds3'
    this.emit16(0x1c00 | (fits(imm, 3, w) << 6) | (lo(rn, w) << 3) | lo(rd, w))
    return this
  }

  /** subs Rdn, #imm8 */
  subs(rdn: Reg, imm: number): this {
    this.emit16(0x3800 | (lo(rdn, 'subs') << 8) | fits(imm, 8, 'subs'))
    return this
  }

  /** subs Rd, Rn, #imm3, the three-operand form */
  subs3(rd: Reg, rn: Reg, imm: number): this {
    const w = 'subs3'
    this.emit16(0x1e00 | (fits(imm, 3, w) << 6) | (lo(rn, w) << 3) | lo(rd, w))
    return this
  }

  /** cmp Rn, #imm8 */
  cmp(rn: Reg, imm: number): this {
    this.emit16(0x2800 | (lo(rn, 'cmp') << 8) | fits(imm, 8, 'cmp'))
    return this
  }

  /** cmp Rn, Rm, low registers only */
  cmpReg(rn: Reg, rm: Reg): this {
    this.emit16(0x4280 | (lo(rm, 'cmpReg') << 3) | lo(rn, 'cmpReg'))
    return this
  }

  /** lsls Rd, Rm, #imm5 */
  lsls(rd: Reg, rm: Reg, imm: number): this {
    const w = 'lsls'
    this.emit16((fits(imm, 5, w) << 6) | (lo(rm, w) << 3) | lo(rd, w))
    return this
  }

  /** lsrs Rd, Rm, #imm5. A shift of 32 encodes as 0. */
  lsrs(rd: Reg, rm: Reg, imm: number): this {
    const w = 'lsrs'
    if (imm < 1 || imm > 32) throw new Error(`${w}: shift ${imm} out of 1..32`)
    this.emit16(0x0800 | ((imm & 31) << 6) | (lo(rm, w) << 3) | lo(rd, w))
    return this
  }

  /** ldrb Rt, [Rn, #imm5] */
  ldrb(rt: Reg, rn: Reg, imm: number): this {
    const w = 'ldrb'
    this.emit16(0x7800 | (fits(imm, 5, w) << 6) | (lo(rn, w) << 3) | lo(rt, w))
    return this
  }

  /** strb Rt, [Rn, #imm5] */
  strb(rt: Reg, rn: Reg, imm: number): this {
    const w = 'strb'
    this.emit16(0x7000 | (fits(imm, 5, w) << 6) | (lo(rn, w) << 3) | lo(rt, w))
    return this
  }

  /** ldrh Rt, [Rn, #imm], imm a multiple of 2 up to 62 */
  /** str rt, [rn, #imm]. Word store, so `imm` must be a multiple of 4. */
  str(rt: Reg, rn: Reg, imm: number): this {
    lo(rt, 'str')
    lo(rn, 'str')
    if (imm % 4 !== 0) throw new Error(`str: offset ${imm} is not a multiple of 4`)
    this.emit16(0x6000 | (fits(imm / 4, 5, 'str') << 6) | (REGS[rn] << 3) | REGS[rt])
    return this
  }

  /** ldr rt, [rn, #imm]. Word load, so `imm` must be a multiple of 4. */
  ldr(rt: Reg, rn: Reg, imm: number): this {
    lo(rt, 'ldr')
    lo(rn, 'ldr')
    if (imm % 4 !== 0) throw new Error(`ldr: offset ${imm} is not a multiple of 4`)
    this.emit16(0x6800 | (fits(imm / 4, 5, 'ldr') << 6) | (REGS[rn] << 3) | REGS[rt])
    return this
  }

  /** ldr rt, [rn, rm]. Register offset, for indexing a table. */
  ldrReg(rt: Reg, rn: Reg, rm: Reg): this {
    this.emit16(0x5800 | (lo(rm, 'ldrReg') << 6) | (lo(rn, 'ldrReg') << 3) | lo(rt, 'ldrReg'))
    return this
  }

  /** str rt, [rn, rm]. */
  strReg(rt: Reg, rn: Reg, rm: Reg): this {
    this.emit16(0x5000 | (lo(rm, 'strReg') << 6) | (lo(rn, 'strReg') << 3) | lo(rt, 'strReg'))
    return this
  }

  /** ldrb rt, [rn, rm]. */
  ldrbReg(rt: Reg, rn: Reg, rm: Reg): this {
    this.emit16(0x5c00 | (lo(rm, 'ldrbReg') << 6) | (lo(rn, 'ldrbReg') << 3) | lo(rt, 'ldrbReg'))
    return this
  }

  /** subs rd, rn, rm. Three operands, unlike `subs(rdn, imm)`. */
  subsReg(rd: Reg, rn: Reg, rm: Reg): this {
    this.emit16(0x1a00 | (lo(rm, 'subsReg') << 6) | (lo(rn, 'subsReg') << 3) | lo(rd, 'subsReg'))
    return this
  }

  /** The 010000 data-processing group: two low registers, flags always set. */
  private dp(op: number, rd: Reg, rm: Reg, what: string): this {
    this.emit16(0x4000 | (op << 6) | (lo(rm, what) << 3) | lo(rd, what))
    return this
  }

  ands(rd: Reg, rm: Reg): this {
    return this.dp(0x0, rd, rm, 'ands')
  }

  eors(rd: Reg, rm: Reg): this {
    return this.dp(0x1, rd, rm, 'eors')
  }

  orrs(rd: Reg, rm: Reg): this {
    return this.dp(0xc, rd, rm, 'orrs')
  }

  bics(rd: Reg, rm: Reg): this {
    return this.dp(0xe, rd, rm, 'bics')
  }

  mvns(rd: Reg, rm: Reg): this {
    return this.dp(0xf, rd, rm, 'mvns')
  }

  tst(rn: Reg, rm: Reg): this {
    return this.dp(0x8, rn, rm, 'tst')
  }

  ldrh(rt: Reg, rn: Reg, imm: number): this {
    const w = 'ldrh'
    if (imm % 2 !== 0) throw new Error(`${w}: offset ${imm} is not even`)
    this.emit16(0x8800 | (fits(imm / 2, 5, w) << 6) | (lo(rn, w) << 3) | lo(rt, w))
    return this
  }

  /** ldrh Rt, [Rn, Rm] */
  ldrhReg(rt: Reg, rn: Reg, rm: Reg): this {
    const w = 'ldrhReg'
    this.emit16(0x5a00 | (lo(rm, w) << 6) | (lo(rn, w) << 3) | lo(rt, w))
    return this
  }

  /**
   * ldr Rt, <target>: the PC-relative literal load.
   *
   * The target must be a word-aligned address holding the literal, at most 1020
   * bytes ahead. Place it yourself with `word()`; this assembler has no automatic
   * pool, because in a hand-laid-out extension knowing where every byte went
   * matters more than the convenience.
   */
  ldrPool(rt: Reg, target: Target): this {
    lo(rt, 'ldrPool')
    this.fixups.push({ kind: 'ldrpool', at: this.out.length, target, what: 'ldrPool' })
    this.emit16(0x4800 | (REGS[rt] << 8))
    return this
  }

  b(target: Target): this {
    this.fixups.push({ kind: 'b', at: this.out.length, target, what: 'b' })
    this.emit16(0xe000)
    return this
  }

  bcond(cond: Cond, target: Target): this {
    this.fixups.push({ kind: 'bcond', at: this.out.length, target, what: `b${cond}` })
    this.emit16(0xd000 | (COND[cond] << 8))
    return this
  }

  /** bl <target>. The target is a Thumb address; do not set bit 0 yourself. */
  bl(target: Target): this {
    this.fixups.push({ kind: 'bl', at: this.out.length, target, what: 'bl' })
    this.emit32(0)
    return this
  }

  blx(rm: AnyReg): this {
    this.emit16(0x4780 | (REGS[rm] << 3))
    return this
  }

  bx(rm: AnyReg): this {
    this.emit16(0x4700 | (REGS[rm] << 3))
    return this
  }

  nop(): this {
    this.emit16(0xbf00)
    return this
  }

  // --- fixups -------------------------------------------------------------------

  /** Resolve every branch and literal load. Throws if any is out of range. */
  assemble(): Uint8Array {
    const buf = new Uint8Array(this.out)
    const put16 = (at: number, v: number) => {
      buf[at] = v & 0xff
      buf[at + 1] = (v >> 8) & 0xff
    }
    for (const fx of this.fixups) {
      const site = this.org + fx.at
      const dest = this.resolve(fx.target, `${fx.what} at ${hx(site)}`)
      const where = `${fx.what} at ${hx(site)} -> ${hx(dest)}`
      if (fx.kind === 'word') {
        const dv = new DataView(buf.buffer)
        dv.setUint32(fx.at, dest >>> 0, true)
        continue
      }
      if (fx.kind === 'ldrpool') {
        // ARM ARM: the base is Align(PC, 4) where PC is the instruction address + 4.
        const base = ((site + 4) >> 2) << 2
        const off = dest - base
        if (dest % 4 !== 0) throw new Error(`${where}: literal is not word aligned`)
        if (off < 0 || off > 1020) throw new Error(`${where}: offset ${off} out of range`)
        put16(fx.at, (buf[fx.at] | (buf[fx.at + 1] << 8)) | (off >> 2))
        continue
      }
      const off = dest - (site + 4)
      if (off % 2 !== 0) throw new Error(`${where}: odd branch offset`)
      if (fx.kind === 'bcond') {
        if (off < -256 || off > 254) throw new Error(`${where}: ${off} out of +/-256`)
        put16(fx.at, (buf[fx.at + 1] << 8) | ((off >> 1) & 0xff))
        continue
      }
      if (fx.kind === 'b') {
        if (off < -2048 || off > 2046) throw new Error(`${where}: ${off} out of +/-2 KB`)
        put16(fx.at, 0xe000 | ((off >> 1) & 0x7ff))
        continue
      }
      // BL, the 32-bit encoding. Range is +/-16 MB, ample inside one 256 KB flash.
      if (off < -(1 << 24) || off >= 1 << 24) throw new Error(`${where}: out of BL range`)
      const imm25 = off & 0x1ffffff
      const s = (imm25 >>> 24) & 1
      const i1 = (imm25 >>> 23) & 1
      const i2 = (imm25 >>> 22) & 1
      const imm10 = (imm25 >>> 12) & 0x3ff
      const imm11 = (imm25 >>> 1) & 0x7ff
      put16(fx.at, 0xf000 | (s << 10) | imm10)
      put16(fx.at + 2, 0xd000 | (((1 - i1) ^ s) << 13) | (((1 - i2) ^ s) << 11) | imm11)
    }
    return buf
  }

  /** Address of a label, for callers that need to record it. */
  addressOf(name: string): number {
    const v = this.labels.get(name)
    if (v === undefined) throw new Error(`undefined label ${name}`)
    return v
  }
}

/** Parse "15 28 3f" into bytes. Shared with patch.ts's expectation strings. */
export const bytes = (s: string): Uint8Array =>
  new Uint8Array(s.trim().split(/\s+/).map((x) => parseInt(x, 16)))

/** Render bytes as "15 28 3f", for assertion failure messages. */
export const showBytes = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ')
