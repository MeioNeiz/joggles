/**
 * An ARMv6-M interpreter, and a model of this part's flash controller, so firmware we
 * write can be RUN offline instead of only assembled.
 *
 * ## Why this exists
 *
 * `research/tools/thumb.ts` proves the encoder agrees with the vendor's own bytes, by
 * reassembling code already running on the device. That is a strong guarantee about
 * **encoding** and says nothing about **behaviour**: an extension can assemble
 * perfectly, pass `ota.check`, land byte for byte over SWD, and then do the wrong
 * thing. Until now the only way to find that out was to flash a unit and look.
 *
 * This runs the actual assembled bytes. `ext.test.ts` uses it to execute the
 * trampoline for a frame that is ours and a frame that is not, and to drive the whole
 * over-BT update path against a simulated flash array, which is the only offline way
 * to answer "does a failed update leave the live slot alone".
 *
 * ## What it is not
 *
 * **It is the author's model of the part, and a passing run proves the code agrees
 * with the model.** `research/swdflash-review-2026-08-20.md` says this about
 * `swdflash-sim.tcl` and it was the finding that mattered there: the simulator
 * hardcoded the same wrong assumption as the tool, so a green run was the model
 * agreeing with itself. The list below is the honest measure of what a pass is worth.
 *
 * | Not modelled | Consequence |
 * | --- | --- |
 * | time. An erase completes before the next instruction | `wait_trg`'s loop shape is exercised, its duration is not |
 * | the AHB stalling while the ISP engine is busy | the documented reason the poll exists |
 * | interrupts, so no BLE stack runs concurrently | a frame arrives with nothing else happening, which is never true on a unit |
 * | brown-out, reset, the watchdog | every failure is one a test chose to inject |
 * | whether the part accepts these opcodes at all | `APUEN` was driven on silicon 2026-08-20, the rest is from vendor code |
 * | prefetch buffers or stale reads | a flash read always returns the array |
 * | `CFGUEN`/`LDUEN` actually refusing | modelled from the same reading the firmware relies on |
 * | any peripheral a test does not supply | a `Peripheral` can stand in for one, and anything else still throws |
 *
 * The last row is the one to keep in mind: the guard that stops the updater writing
 * outside its slots is **software**, here and on silicon both, because `APUEN` enables
 * the whole of APROM and no hardware bit distinguishes one part of it from another.
 * A passing run says the guard's code is right, not that a guard is unnecessary.
 *
 * ## Coverage
 *
 * Every instruction form `thumb.ts` can emit, and nothing else. An unknown encoding
 * throws with its address and halfword rather than being skipped, so a gap shows up as
 * a failure and never as a silently wrong result.
 */

/** Flash, as the part maps it: one 256 KB array at address zero. */
export const FLASH_BYTES = 0x40000

export const SRAM_BASE = 0x20000000
export const SRAM_BYTES = 0x4000

/** From the vendor's own config writer at `abs 0x17a78`. Same map `swdflash` drives. */
export const FMC = {
  ISPCON: 0x5000c000,
  ISPADR: 0x5000c004,
  ISPDAT: 0x5000c008,
  ISPCMD: 0x5000c00c,
  ISPTRG: 0x5000c010,
  WRPROT: 0x50000100,
} as const

export const ISPCON = {
  ISPEN: 1 << 0,
  BS: 1 << 1,
  SPUEN: 1 << 2,
  APUEN: 1 << 3,
  CFGUEN: 1 << 4,
  ISPFF: 1 << 6,
} as const

export const CMD = { READ: 0x00, PROGRAM: 0x21, PAGE_ERASE: 0x22 } as const

/** Erase granularity. *verified* on silicon 2026-08-20 by the repair's own probe. */
export const PAGE = 512

const hx = (n: number) => '0x' + (n >>> 0).toString(16)

export interface FlashEvent {
  kind: 'erase' | 'program' | 'refused'
  addr: number
  /** The word written, for a program. */
  value?: number
  /** Why, for a refusal. */
  why?: string
}

/**
 * The flash controller.
 *
 * Deliberately strict in the two ways the real part is strict and the vendor's own SDK
 * is not: programming a word that is not erased **clears bits and keeps the rest**,
 * which is what NOR flash does and what makes "program without erase" silently store
 * the wrong value, and a misaligned erase address erases the page that contains it
 * rather than failing (`research/fmc-erase-program.md`, finding 6).
 */
export class Fmc {
  readonly flash: Uint8Array
  readonly events: FlashEvent[] = []
  ispcon = 0
  ispadr = 0
  ispdat = 0
  ispcmd = 0
  wrprot = 0
  /** Unlock key sequence progress. The three writes must be adjacent. */
  private keyStep = 0

  constructor(flash?: Uint8Array) {
    this.flash = flash ?? new Uint8Array(FLASH_BYTES).fill(0xff)
  }

  private word(addr: number): number {
    const a = addr >>> 0
    return (
      ((this.flash[a] | (this.flash[a + 1] << 8) | (this.flash[a + 2] << 16) |
        (this.flash[a + 3] << 24)) >>> 0)
    )
  }

  private refuse(addr: number, why: string): void {
    this.ispcon |= ISPCON.ISPFF
    this.events.push({ kind: 'refused', addr, why })
  }

  /** `ISPTRG = 1`: run whatever `ISPCMD` says. Completes before we return. */
  private trigger(): void {
    if (!(this.ispcon & ISPCON.ISPEN)) return this.refuse(this.ispadr, 'ISPEN clear')
    if (!this.wrprot) return this.refuse(this.ispadr, 'SYS_WRPROT locked')
    const addr = this.ispadr >>> 0

    // Which update-enable bit governs this address. The apertures are refused by
    // hardware; everything in the main array is APROM and `APUEN` covers all of it,
    // which is the asymmetry the guard in our firmware exists for.
    if (addr >= 0x00300000) {
      if (!(this.ispcon & ISPCON.CFGUEN)) return this.refuse(addr, 'CFGUEN clear')
    } else if (addr >= 0x00200000) {
      if (!(this.ispcon & ISPCON.SPUEN)) return this.refuse(addr, 'SPUEN clear')
    } else if (addr >= 0x00100000) {
      return this.refuse(addr, 'LDUEN clear')
    } else if (!(this.ispcon & ISPCON.APUEN)) {
      return this.refuse(addr, 'APUEN clear')
    }
    if (addr >= FLASH_BYTES && addr < 0x00100000) {
      return this.refuse(addr, 'past the end of the array')
    }

    if (this.ispcmd === CMD.READ) {
      if (addr % 4 !== 0) return this.refuse(addr, 'ISPADR[1:0] must be 00')
      this.ispdat = this.word(addr)
      return
    }
    if (this.ispcmd === CMD.PAGE_ERASE) {
      // Not an error on this part: it erases the page containing the address.
      const page = addr & ~(PAGE - 1)
      this.flash.fill(0xff, page, page + PAGE)
      this.events.push({ kind: 'erase', addr: page })
      return
    }
    if (this.ispcmd === CMD.PROGRAM) {
      if (addr % 4 !== 0) return this.refuse(addr, 'ISPADR[1:0] must be 00')
      // NOR flash clears bits and cannot set them. Programming over unerased flash
      // stores `old & new`, silently, which is why erase and program are one operation
      // everywhere in this project.
      const stored = (this.word(addr) & this.ispdat) >>> 0
      for (let i = 0; i < 4; i++) this.flash[addr + i] = (stored >>> (i * 8)) & 0xff
      this.events.push({ kind: 'program', addr, value: stored })
      return
    }
    this.refuse(addr, `ISPCMD ${hx(this.ispcmd)} is not a command this model implements`)
  }

  read(addr: number): number {
    switch (addr) {
      case FMC.ISPCON: return this.ispcon >>> 0
      case FMC.ISPADR: return this.ispadr >>> 0
      case FMC.ISPDAT: return this.ispdat >>> 0
      case FMC.ISPCMD: return this.ispcmd >>> 0
      case FMC.ISPTRG: return 0 //          never busy: nothing here takes time
      case FMC.WRPROT: return this.wrprot >>> 0
      default: throw new Error(`read of unmodelled MMIO at ${hx(addr)}`)
    }
  }

  write(addr: number, value: number): void {
    const v = value >>> 0
    switch (addr) {
      case FMC.WRPROT: {
        // The three unlock writes must be adjacent: "any different data value,
        // different sequence or any other write to another address during these three
        // data writings will abort the whole sequence."
        const want = [0x59, 0x16, 0x88][this.keyStep]
        if (v === want) {
          this.keyStep++
          if (this.keyStep === 3) {
            this.wrprot = 1
            this.keyStep = 0
          }
        } else {
          this.keyStep = 0
          if (v === 0x00) this.wrprot = 0
        }
        return
      }
      case FMC.ISPCON: {
        // ISPFF is write-one-to-clear; every other bit is plain.
        const clearing = v & ISPCON.ISPFF
        this.ispcon = ((v & ~ISPCON.ISPFF) | (clearing ? 0 : this.ispcon & ISPCON.ISPFF)) >>> 0
        this.keyStep = 0
        return
      }
      case FMC.ISPADR: this.ispadr = v; this.keyStep = 0; return
      case FMC.ISPDAT: this.ispdat = v; this.keyStep = 0; return
      case FMC.ISPCMD: this.ispcmd = v; this.keyStep = 0; return
      case FMC.ISPTRG:
        this.keyStep = 0
        if (v & 1) this.trigger()
        return
      default: throw new Error(`write of unmodelled MMIO at ${hx(addr)}`)
    }
  }

  /** Words the run erased, programmed or was refused, for a test to assert on. */
  counts(): { erases: number; programs: number; refusals: number } {
    return {
      erases: this.events.filter((e) => e.kind === 'erase').length,
      programs: this.events.filter((e) => e.kind === 'program').length,
      refusals: this.events.filter((e) => e.kind === 'refused').length,
    }
  }
}

/** A call the interpreter intercepts instead of executing. */
export type Hook = (m: Machine) => void

/**
 * A peripheral other than the FMC, so the vendor's own code can be run.
 *
 * The FMC is modelled in full because our firmware drives it. Everything else in the
 * `0x4xxxxxxx` and `0x5xxxxxxx` space threw, which was right while the only code being
 * executed was ours, and is what stops the **vendor's** code being run at all: the
 * button handler reads `GPIO_PIN_DATA(5,2)` and the tick ISR clears TIMER0's interrupt
 * flag. Both are needed to answer "does the two second hold still take two seconds
 * after the tick patch", which is the one question about that patch worth executing.
 *
 * Deliberately dumb: a span, a reader and a writer. Anything a test does not supply
 * still throws with its address, so a gap is a failure rather than a zero.
 */
export interface Peripheral {
  lo: number
  hi: number
  read?(addr: number): number
  write?(addr: number, value: number): void
}

export interface MachineOptions {
  fmc?: Fmc
  /** Address -> what to do instead of running the code there. Returns via `lr`. */
  hooks?: Map<number, Hook>
  /** Peripherals other than the FMC, for running the vendor's code. */
  mmio?: Peripheral[]
  /** Reaching this address stops the run. Defaults to a sentinel. */
  stopAt?: number
  maxSteps?: number
}

/** The address a run returns to when it is finished. Never executed. */
export const DONE = 0x0f000001

export class Machine {
  readonly r = new Uint32Array(16)
  n = false
  z = false
  c = false
  v = false
  readonly fmc: Fmc
  readonly sram = new Uint8Array(SRAM_BYTES)
  readonly hooks: Map<number, Hook>
  readonly mmio: Peripheral[]
  readonly stopAt: number
  readonly maxSteps: number
  steps = 0
  /** Every hook address reached, in order, so a test can assert what was called. */
  readonly calls: number[] = []

  constructor(opts: MachineOptions = {}) {
    this.fmc = opts.fmc ?? new Fmc()
    this.hooks = opts.hooks ?? new Map()
    this.mmio = opts.mmio ?? []
    this.stopAt = opts.stopAt ?? DONE
    this.maxSteps = opts.maxSteps ?? 2_000_000
  }

  get flash(): Uint8Array {
    return this.fmc.flash
  }

  // --- memory ---------------------------------------------------------------------

  private space(addr: number): { buf: Uint8Array; off: number } | null {
    if (addr < FLASH_BYTES) return { buf: this.fmc.flash, off: addr }
    if (addr >= SRAM_BASE && addr < SRAM_BASE + SRAM_BYTES) {
      return { buf: this.sram, off: addr - SRAM_BASE }
    }
    return null
  }

  /** The peripheral covering this address, if a test supplied one. */
  private device(addr: number): Peripheral | undefined {
    return this.mmio.find((d) => addr >= d.lo && addr < d.hi)
  }

  ld32(addr: number): number {
    const a = addr >>> 0
    if (a % 4 !== 0) throw new Error(`unaligned word read at ${hx(a)}`)
    const s = this.space(a)
    if (!s) {
      const d = this.device(a)
      if (d?.read) return d.read(a) >>> 0
      return this.fmc.read(a)
    }
    const { buf, off } = s
    return ((buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0)
  }

  st32(addr: number, value: number): void {
    const a = addr >>> 0
    if (a % 4 !== 0) throw new Error(`unaligned word write at ${hx(a)}`)
    const s = this.space(a)
    if (!s) {
      const d = this.device(a)
      if (d?.write) return d.write(a, value >>> 0)
      return this.fmc.write(a, value)
    }
    // A plain store to flash is not how flash works. Anything writing the array has to
    // go through the FMC, so this catches a bug that would otherwise look like success.
    if (s.buf === this.fmc.flash) {
      throw new Error(`plain store to flash at ${hx(a)}: flash is written through the FMC`)
    }
    const { buf, off } = s
    for (let i = 0; i < 4; i++) buf[off + i] = (value >>> (i * 8)) & 0xff
  }

  ld16(addr: number): number {
    const s = this.space(addr >>> 0)
    if (!s) {
      const d = this.device(addr >>> 0)
      if (d?.read) return d.read(addr >>> 0) & 0xffff
      throw new Error(`halfword read of MMIO at ${hx(addr)}`)
    }
    return s.buf[s.off] | (s.buf[s.off + 1] << 8)
  }

  ld8(addr: number): number {
    const s = this.space(addr >>> 0)
    if (!s) {
      const d = this.device(addr >>> 0)
      if (d?.read) return d.read(addr >>> 0) & 0xff
      throw new Error(`byte read of MMIO at ${hx(addr)}`)
    }
    return s.buf[s.off]
  }

  st8(addr: number, value: number): void {
    const s = this.space(addr >>> 0)
    if (!s) {
      const d = this.device(addr >>> 0)
      if (d?.write) return d.write(addr >>> 0, value & 0xff)
      throw new Error(`byte write of MMIO at ${hx(addr)}`)
    }
    if (s.buf === this.fmc.flash) {
      throw new Error(`plain store to flash at ${hx(addr)}`)
    }
    s.buf[s.off] = value & 0xff
  }

  // --- flags ----------------------------------------------------------------------

  private setNZ(v: number): number {
    const r = v >>> 0
    this.n = (r & 0x80000000) !== 0
    this.z = r === 0
    return r
  }

  private addWithCarry(x: number, y: number, carryIn: number): number {
    const ux = x >>> 0
    const uy = y >>> 0
    const sum = ux + uy + carryIn
    const r = sum >>> 0
    this.c = sum > 0xffffffff
    const sx = ux | 0
    const sy = uy | 0
    const sr = r | 0
    this.v = sx >= 0 === sy >= 0 && sr >= 0 !== sx >= 0
    return this.setNZ(r)
  }

  private cond(code: number): boolean {
    switch (code) {
      case 0: return this.z //                    eq
      case 1: return !this.z //                   ne
      case 2: return this.c //                    hs / cs
      case 3: return !this.c //                   lo / cc
      case 4: return this.n //                    mi
      case 5: return !this.n //                   pl
      case 6: return this.v //                    vs
      case 7: return !this.v //                   vc
      case 8: return this.c && !this.z //         hi
      case 9: return !this.c || this.z //         ls
      case 10: return this.n === this.v //        ge
      case 11: return this.n !== this.v //        lt
      case 12: return !this.z && this.n === this.v // gt
      case 13: return this.z || this.n !== this.v // le
      default: throw new Error(`condition ${code} is not a branch condition`)
    }
  }

  // --- execution ------------------------------------------------------------------

  /** Start executing at `entry` (Thumb address), with `lr` set to stop the run. */
  run(entry: number): void {
    this.r[15] = (entry & ~1) >>> 0
    this.r[14] = this.stopAt >>> 0
    while (true) {
      const pc = this.r[15] >>> 0
      if ((pc | 1) === (this.stopAt | 1)) return
      if (++this.steps > this.maxSteps) {
        throw new Error(`ran ${this.steps} instructions without reaching the end`)
      }
      const hook = this.hooks.get(pc) ?? this.hooks.get(pc | 1)
      if (hook) {
        this.calls.push(pc | 1)
        hook(this)
        this.r[15] = (this.r[14] & ~1) >>> 0
        continue
      }
      this.step()
    }
  }

  step(): void {
    const pc = this.r[15] >>> 0
    const ins = this.ld16(pc)
    this.r[15] = (pc + 2) >>> 0
    const rd3 = ins & 7
    const rn3 = (ins >> 3) & 7
    const rm3 = (ins >> 6) & 7

    // --- shifts and add/sub, 000xxx ---
    if ((ins & 0xe000) === 0x0000) {
      const op = (ins >> 11) & 3
      if (op === 0) { //                        lsls rd, rn, #imm5
        const sh = (ins >> 6) & 0x1f
        const val = this.r[rn3] >>> 0
        if (sh > 0) this.c = ((val >>> (32 - sh)) & 1) !== 0
        this.r[rd3] = this.setNZ(sh === 0 ? val : (val << sh) >>> 0)
        return
      }
      if (op === 1) { //                        lsrs rd, rn, #imm5
        const sh = ((ins >> 6) & 0x1f) || 32
        const val = this.r[rn3] >>> 0
        this.c = ((val >>> (sh - 1)) & 1) !== 0
        this.r[rd3] = this.setNZ(sh === 32 ? 0 : val >>> sh)
        return
      }
      if (op === 2) { //                        asrs rd, rn, #imm5
        const sh = ((ins >> 6) & 0x1f) || 32
        const val = this.r[rn3] | 0
        this.c = ((val >> (sh - 1)) & 1) !== 0
        this.r[rd3] = this.setNZ(sh === 32 ? (val < 0 ? 0xffffffff : 0) : (val >> sh) >>> 0)
        return
      }
      // 00011 opc: adds/subs, register or 3-bit immediate
      const sub = (ins & 0x0200) !== 0
      const imm = (ins & 0x0400) !== 0
      const operand = imm ? rm3 : this.r[rm3] >>> 0
      this.r[rd3] = sub
        ? this.addWithCarry(this.r[rn3], ~operand >>> 0, 1)
        : this.addWithCarry(this.r[rn3], operand, 0)
      return
    }

    // --- movs / cmp / adds / subs with 8-bit immediate, 001xxx ---
    if ((ins & 0xe000) === 0x2000) {
      const op = (ins >> 11) & 3
      const rdn = (ins >> 8) & 7
      const imm8 = ins & 0xff
      if (op === 0) { this.r[rdn] = this.setNZ(imm8); return } //         movs
      if (op === 1) { this.addWithCarry(this.r[rdn], ~imm8 >>> 0, 1); return } // cmp
      if (op === 2) { this.r[rdn] = this.addWithCarry(this.r[rdn], imm8, 0); return } // adds
      this.r[rdn] = this.addWithCarry(this.r[rdn], ~imm8 >>> 0, 1) //     subs
      return
    }

    // --- data processing, 010000 ---
    if ((ins & 0xfc00) === 0x4000) {
      const op = (ins >> 6) & 0xf
      const a = this.r[rd3] >>> 0
      const b = this.r[rn3] >>> 0
      switch (op) {
        case 0x0: this.r[rd3] = this.setNZ(a & b); return //              ands
        case 0x1: this.r[rd3] = this.setNZ((a ^ b) >>> 0); return //      eors
        case 0x2: { //                                                    lsls rd, rs
          const sh = b & 0xff
          if (sh > 0 && sh < 32) this.c = ((a >>> (32 - sh)) & 1) !== 0
          else if (sh === 32) this.c = (a & 1) !== 0
          else if (sh > 32) this.c = false
          this.r[rd3] = this.setNZ(sh >= 32 ? 0 : (a << sh) >>> 0)
          return
        }
        case 0x3: { //                                                    lsrs rd, rs
          const sh = b & 0xff
          if (sh > 0 && sh <= 32) this.c = ((a >>> (sh - 1)) & 1) !== 0
          else if (sh > 32) this.c = false
          this.r[rd3] = this.setNZ(sh >= 32 ? 0 : a >>> sh)
          return
        }
        case 0x5: this.r[rd3] = this.addWithCarry(a, b, this.c ? 1 : 0); return // adcs
        case 0x6: this.r[rd3] = this.addWithCarry(a, ~b >>> 0, this.c ? 1 : 0); return // sbcs
        case 0x8: this.setNZ(a & b); return //                            tst
        case 0x9: this.r[rd3] = this.addWithCarry(0, ~b >>> 0, 1); return // rsbs (negs)
        case 0xa: this.addWithCarry(a, ~b >>> 0, 1); return //            cmp
        case 0xc: this.r[rd3] = this.setNZ((a | b) >>> 0); return //      orrs
        case 0xd: this.r[rd3] = this.setNZ(Math.imul(a, b) >>> 0); return // muls
        case 0xe: this.r[rd3] = this.setNZ((a & ~b) >>> 0); return //     bics
        case 0xf: this.r[rd3] = this.setNZ(~b >>> 0); return //           mvns
        default: throw new Error(`data-processing op ${op} at ${hx(pc)} not modelled`)
      }
    }

    // --- high-register mov / cmp / bx / blx, 010001 ---
    if ((ins & 0xfc00) === 0x4400) {
      const op = (ins >> 8) & 3
      const rdHi = (ins & 7) | ((ins >> 4) & 8)
      const rmHi = (ins >> 3) & 0xf
      if (op === 0) { //                        add rd, rm (no flags)
        const v = ((rdHi === 15 ? pc + 4 : this.r[rdHi]) + this.r[rmHi]) >>> 0
        if (rdHi === 15) this.r[15] = (v & ~1) >>> 0
        else this.r[rdHi] = v
        return
      }
      if (op === 1) { this.addWithCarry(this.r[rdHi], ~this.r[rmHi] >>> 0, 1); return } // cmp
      if (op === 2) { //                        mov rd, rm
        const v = rmHi === 15 ? (pc + 4) >>> 0 : this.r[rmHi] >>> 0
        if (rdHi === 15) this.r[15] = (v & ~1) >>> 0
        else this.r[rdHi] = v
        return
      }
      // bx / blx rm
      const target = this.r[rmHi] >>> 0
      if (ins & 0x0080) this.r[14] = (this.r[15] | 1) >>> 0 //   blx: lr = return
      this.r[15] = (target & ~1) >>> 0
      return
    }

    // --- ldr rt, [pc, #imm8], 01001 ---
    if ((ins & 0xf800) === 0x4800) {
      const rt = (ins >> 8) & 7
      const pool = ((((pc + 4) >> 2) << 2) + (ins & 0xff) * 4) >>> 0
      this.r[rt] = this.ld32(pool)
      return
    }

    // --- load/store, register offset, 0101 ---
    if ((ins & 0xf000) === 0x5000) {
      const addr = (this.r[rn3] + this.r[rm3]) >>> 0
      switch ((ins >> 9) & 7) {
        case 0: this.st32(addr, this.r[rd3]); return //           str
        case 1: this.st8(addr, this.r[rd3] & 0xff); return //     strb via strh slot guard
        case 2: this.st8(addr, this.r[rd3] & 0xff); return //     strb
        case 4: this.r[rd3] = this.ld32(addr); return //          ldr
        case 5: this.r[rd3] = this.ld16(addr); return //          ldrh
        case 6: this.r[rd3] = this.ld8(addr); return //           ldrb
        default: throw new Error(`register-offset op at ${hx(pc)} not modelled`)
      }
    }

    // --- load/store word and byte, immediate offset, 011x ---
    if ((ins & 0xe000) === 0x6000) {
      const imm5 = (ins >> 6) & 0x1f
      const byte = (ins & 0x1000) !== 0
      const load = (ins & 0x0800) !== 0
      const addr = (this.r[rn3] + (byte ? imm5 : imm5 * 4)) >>> 0
      if (load) this.r[rd3] = byte ? this.ld8(addr) : this.ld32(addr)
      else if (byte) this.st8(addr, this.r[rd3] & 0xff)
      else this.st32(addr, this.r[rd3])
      return
    }

    // --- load/store halfword, immediate offset, 1000 ---
    if ((ins & 0xf000) === 0x8000) {
      const addr = (this.r[rn3] + ((ins >> 6) & 0x1f) * 2) >>> 0
      if (ins & 0x0800) this.r[rd3] = this.ld16(addr)
      else {
        const s = this.space(addr)
        if (!s || s.buf === this.fmc.flash) throw new Error(`strh to ${hx(addr)}`)
        s.buf[s.off] = this.r[rd3] & 0xff
        s.buf[s.off + 1] = (this.r[rd3] >>> 8) & 0xff
      }
      return
    }

    // --- adr rd, #imm8, 10100 ---
    if ((ins & 0xf800) === 0xa000) {
      this.r[(ins >> 8) & 7] = ((((pc + 4) >> 2) << 2) + (ins & 0xff) * 4) >>> 0
      return
    }

    // --- push / pop, 1011x10x ---
    if ((ins & 0xfe00) === 0xb400) { //          push
      const list = ins & 0xff
      let sp = this.r[13] >>> 0
      if (ins & 0x0100) { sp -= 4; this.st32(sp, this.r[14]) }
      for (let i = 7; i >= 0; i--) {
        if (!(list & (1 << i))) continue
        sp -= 4
        this.st32(sp, this.r[i])
      }
      this.r[13] = sp >>> 0
      return
    }
    if ((ins & 0xfe00) === 0xbc00) { //          pop
      const list = ins & 0xff
      let sp = this.r[13] >>> 0
      for (let i = 0; i < 8; i++) {
        if (!(list & (1 << i))) continue
        this.r[i] = this.ld32(sp)
        sp += 4
      }
      if (ins & 0x0100) {
        this.r[15] = (this.ld32(sp) & ~1) >>> 0
        sp += 4
      }
      this.r[13] = sp >>> 0
      return
    }
    if ((ins & 0xff00) === 0xbf00) return //     nop and its hint siblings

    // --- sign and zero extends, 1011 0010 ---
    //
    // Not emitted by `thumb.ts`, so nothing of ours needs them, and they are all over
    // the vendor's code: `uxtb r0, r0` after every byte increment. Added when running
    // the vendor's own button handler through the tick hit one four instructions into
    // the long-press path. Neither flags nor carry: these do not set them.
    if ((ins & 0xff00) === 0xb200) {
      const v = this.r[rn3] >>> 0
      switch ((ins >> 6) & 3) {
        case 0: this.r[rd3] = ((v << 16) >> 16) >>> 0; return //  sxth
        case 1: this.r[rd3] = ((v << 24) >> 24) >>> 0; return //  sxtb
        case 2: this.r[rd3] = v & 0xffff; return //               uxth
        default: this.r[rd3] = v & 0xff; return //                uxtb
      }
    }

    // --- add/sub sp, #imm7, 1011 0000 ---
    if ((ins & 0xff00) === 0xb000) {
      const off = (ins & 0x7f) * 4
      this.r[13] = ((ins & 0x0080) ? this.r[13] - off : this.r[13] + off) >>> 0
      return
    }

    // --- conditional branch, 1101 ---
    if ((ins & 0xf000) === 0xd000) {
      const code = (ins >> 8) & 0xf
      if (code >= 0xe) throw new Error(`${hx(ins)} at ${hx(pc)} is udf or svc, not a branch`)
      let imm = ins & 0xff
      if (imm & 0x80) imm -= 0x100
      if (this.cond(code)) this.r[15] = (pc + 4 + imm * 2) >>> 0
      return
    }

    // --- unconditional branch, 11100 ---
    if ((ins & 0xf800) === 0xe000) {
      let imm = ins & 0x7ff
      if (imm & 0x400) imm -= 0x800
      this.r[15] = (pc + 4 + imm * 2) >>> 0
      return
    }

    // --- bl, 32-bit ---
    if ((ins & 0xf800) === 0xf000) {
      const lo = this.ld16((pc + 2) >>> 0)
      if ((lo & 0xd000) !== 0xd000) {
        throw new Error(`32-bit ${hx(ins)} ${hx(lo)} at ${hx(pc)} is not BL`)
      }
      const s = (ins >> 10) & 1
      const i1 = 1 - (((lo >> 13) & 1) ^ s)
      const i2 = 1 - (((lo >> 11) & 1) ^ s)
      let off =
        (s << 24) | (i1 << 23) | (i2 << 22) | ((ins & 0x3ff) << 12) | ((lo & 0x7ff) << 1)
      if (s) off -= 1 << 25
      this.r[15] = (pc + 4) >>> 0
      this.r[14] = (this.r[15] | 1) >>> 0
      this.r[15] = (((pc + 4 + off) >>> 0) & ~1) >>> 0
      return
    }

    throw new Error(`unimplemented instruction ${hx(ins)} at ${hx(pc)}`)
  }
}

/** A machine with a stack, ready to call something. */
export function machine(opts: MachineOptions & { sp?: number } = {}): Machine {
  const m = new Machine(opts)
  m.r[13] = (opts.sp ?? SRAM_BASE + SRAM_BYTES - 0x40) >>> 0
  return m
}
