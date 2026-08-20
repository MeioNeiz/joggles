/**
 * The `JGX1` firmware extension: the block appended in free flash, and the one
 * dispatcher hook that reaches it.
 *
 * Architecture is `notes/firmware-design.md`. In one paragraph: the stock image is
 * patched at exactly one place, adding a single opcode `J` whose first payload byte
 * is a sub-command id. Everything we ever add is a new sub-command in free flash,
 * costing no further edits to the vendor's code. The stock firmware stays the
 * untouchable substrate that guarantees recovery over the air.
 *
 * Every address below is `abs`, i.e. a flash address, and comes from
 * `research/firmware-internals.md`. The load-bearing ones are re-asserted against
 * the stock bytes by `build-firmware.ts`, so a wrong address fails at build time
 * rather than on a device that then has to be recovered.
 *
 * ## The wire frame, and its two coordinate systems
 *
 * A command is one AES block of `[len][opcode ASCII...][args...]`, so on the wire
 * the opcode starts at index 1. The dispatcher is handed a struct pointer whose
 * frame data begins one byte in, so the same opcode byte is `[r4+2]` in the
 * disassembly. Both readings in the research documents are right; they just count
 * from different places. `ARG` below converts.
 *
 * ## Two tables, in one order that cannot be changed
 *
 * The block this file builds is **resident**: written once over SWD, never rewritten
 * over the air, and it holds `HELLO` and the five `UPD_*` handlers. Features live in a
 * **slot** in the staging bank, which is replaced over Bluetooth
 * (`notes/patch-over-bt.md`), and `slot_dispatch` below is what reaches one.
 *
 * **The resident table is consulted first, always.** That is the load-bearing half of
 * the recovery argument: a slot whose code faults cannot make a unit unreachable by the
 * commands that replace it. Until 2026-08-20 the trampoline had no slot dispatch at all,
 * so the property was vacuous rather than proven, and review 33 said so
 * (`research/patch-over-bt-review-2026-08-20.md`, section 3). It is real now, and
 * `features/slot.test.ts` executes it.
 *
 * The other half of that argument is a rule rather than code: **slot code runs only when
 * a command frame arrives.** `features/index.ts` explains why nothing here can express
 * anything else, and what it costs.
 */
import { CAP, MAGIC, MARKER, MSG, OPCODE, SUB } from '../../packages/core/src/jgx.js'
import { Asm } from './thumb.js'
import {
  emitUpdater,
  MAX_BODY as SLOT_MAX_BODY,
  SLOT_HDR,
  SLOT_HDR_LEN,
} from './updater.js'

// The wire format is defined once, in core, and the firmware is built from it. The
// alternative is two copies of the same table drifting apart, one of which is only
// discoverable by flashing a device.
export { CAP, MAGIC, MARKER, MSG, OPCODE, SUB }

// --- Stock addresses this extension depends on ------------------------------------
//
// EVERY CONSTANT IN THIS SECTION IS A PROPERTY OF THE APK BUILD, NOT OF THE HARDWARE.
// On 2026-08-19 the application in the vendor APK turned out not to be the application
// this hardware runs (`research/hardfault-0xd38-2026-08-19.md`), so on a donor image
// read off a working unit each one of them is a guess. `resolveLayout` below finds the
// same six anchors by content, refuses when the content is ambiguous, and is what a
// donor build uses; these constants are the APK's answers and the default for the
// APK-based build that predates all this.

/** End of the stock image, and the first free byte of flash. *verified.* */
export const EXT_BASE = 0x26a24

/** Application region, the whole span an image or a donor window occupies. */
export const IMAGE_BASE = 0x16800

/** OTA staging bank. Our appended block must end well below it. *verified.* */
export const STAGING_BANK = 0x29400

/**
 * The hook: four bytes, a dead compare in the dispatcher chain, replaced by one `bl`.
 *
 * Both builds end their first-letter chain with a compare that can never fire, an
 * `S` that an earlier `S` in the same chain always matches first, and its `beq`
 * targets a branch island with exactly one referrer: that compare. So the four bytes
 * are dead code and the island goes with them.
 *
 * *Corrected 2026-08-20.* The hook used to be 28 bytes replacing the whole `LOOP`
 * arm, which worked on the APK build and does not port. On the image a real unit
 * runs, that block is 32 bytes, its last four are a `bl set_mode` **shared by ten
 * other dispatcher arms**, and taking it costs `LOOP` and `LOOA` outright.
 * `research/donor-dispatcher-2026-08-20.md` is the measurement. The four-byte hook
 * costs no vendor opcode on either build and depends on neither the block's length
 * nor its entry points.
 */
export const HOOK_ADDR = 0x182a2
export const HOOK_LEN = 4

/**
 * The dispatcher epilogue on the APK build, `pop {r3,r4,r5,r6,r7,pc}`.
 *
 * *Corrected 2026-08-20: this said "every arm ends here".* Arms end at one of several
 * identical pops - eight of them on the donor build - and they are interchangeable only
 * because they are all at the same stack depth. `findHookSite` establishes uniqueness
 * within the span it scans, not across the dispatcher, and that is all the hook needs.
 */
export const EPILOGUE = 0x182c2

/** `pop {r3,r4,r5,r6,r7,pc}`, the two bytes that identify the epilogue. */
const POP_R3_R7_PC = new Uint8Array([0xf8, 0xbd])

/** `notify(r0 = payload length, r1 = payload pointer)`. *verified.* */
export const NOTIFY = 0x2145c

/** The notify sender pads to one AES block, so `[len][payload]` caps payload at 15. */
export const NOTIFY_MAX_PAYLOAD = 15

/** Dispatcher frame struct offset of wire byte `n`. See the header comment. */
export const ARG = (n: number) => n + 1

/**
 * Everything the hook and the trampoline are arithmetic on, in one image.
 *
 * All of it is found by content, because none of it survived the move from the APK
 * build to the one a real unit runs: the opcode is in `r2` on one and `r1` on the
 * other, and every address moved by a different amount.
 */
export interface HookSite {
  /** First compare of the first-letter chain. Reported, not written. */
  chainAt: number
  /** `ldrb <opReg>, [<frameReg>, #2]`, the load that feeds the chain. */
  loadAt: number
  /** Register the chain holds the opcode in. */
  opReg: number
  /** Register holding the dispatcher's frame struct pointer. */
  frameReg: number
  /** The four dead bytes the `bl` replaces. */
  callAt: number
  /** The letter that compare tests, which the chain has already answered. */
  deadImm: number
  /** Where `bx lr` lands: the instruction after the hook, unchanged from stock. */
  returnTo: number
  /** The branch island the dead compare used to reach, left unreferenced. */
  deadIsland: number
  /** `pop {r3,r4,r5,r6,r7,pc}`, where a frame that IS ours ends. */
  epilogue: number
}

/** What `findHookSite` resolves to on the APK build. Asserted in `ext.test.ts`. */
export const APK_HOOK_SITE: HookSite = {
  chainAt: 0x18286,
  loadAt: 0x18280,
  opReg: 2,
  frameReg: 4,
  callAt: HOOK_ADDR,
  deadImm: 0x53,
  returnTo: 0x182a6,
  deadIsland: 0x1837a,
  epilogue: EPILOGUE,
}

// --- Finding the same anchors in an image that is not the APK -----------------------
//
// A donor image is a working unit's own application, read back over SWD. It is a
// different, larger build from the APK's, so every address above is suspect and has to
// be found by content. Two rules run through all of it:
//
//  - **Unique or nothing.** A signature that matches twice is refused, not
//    disambiguated. Guessing which copy is live is exactly the class of mistake that
//    produces a valid CRC, a bootable image, and a dead unit.
//  - **Scan for branches before overwriting.** `CLAUDE.md` names this and it has
//    already bitten once: the `LIGHT` arm jumps into the middle of the block the hook
//    replaces, and two of our own documents said that block had one entry point.

export type Severity = 'fatal' | 'warn'
export interface Note {
  severity: Severity
  message: string
}

const hex = (n: number) => '0x' + (n >>> 0).toString(16)

/**
 * `JGX1` as the little-endian word the firmware compares against.
 *
 * Derived from `MAGIC` rather than written out, so the block a slot is checked against
 * and the block the builder stamps cannot come to disagree.
 */
export const MAGIC_WORD =
  [...MAGIC].reduce((w, c, i) => w | (c.charCodeAt(0) << (i * 8)), 0) >>> 0

/** Every offset in `hay` where `needle` appears. */
export function occurrences(hay: Uint8Array, needle: Uint8Array, base = 0): number[] {
  const out: number[] = []
  if (needle.length === 0) return out
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer
    out.push(base + i)
  }
  return out
}

export interface Branch {
  /** Address of the branch instruction. */
  at: number
  kind: 'b' | 'b.cond' | 'bl'
  target: number
}

/**
 * Decode a branch at `addr`, or null if there is not one there.
 *
 * ARMv6-M only, which is the whole instruction set this part has: `B` T1 (conditional,
 * 8-bit), `B` T2 (11-bit) and the 32-bit `BL`. There is no `CBZ`, no `IT` and no ARM
 * state, so this is the complete set of statically resolvable branches. Everything
 * else goes through a register, which the literal scan below covers instead.
 */
export function branchAt(image: Uint8Array, base: number, addr: number): Branch | null {
  const off = addr - base
  if (off < 0 || off + 2 > image.length) return null
  const hi = image[off] | (image[off + 1] << 8)
  if ((hi & 0xf800) === 0xe000) {
    let imm = hi & 0x7ff
    if (imm & 0x400) imm -= 0x800
    return { at: addr, kind: 'b', target: addr + 4 + imm * 2 }
  }
  // 0xde is a permanently undefined instruction and 0xdf is SVC, neither a branch.
  if ((hi & 0xf000) === 0xd000 && (hi & 0x0f00) < 0x0e00) {
    let imm = hi & 0xff
    if (imm & 0x80) imm -= 0x100
    return { at: addr, kind: 'b.cond', target: addr + 4 + imm * 2 }
  }
  if ((hi & 0xf800) === 0xf000 && off + 4 <= image.length) {
    const lo = image[off + 2] | (image[off + 3] << 8)
    if ((lo & 0xd000) !== 0xd000) return null
    const s = (hi >> 10) & 1
    const i1 = 1 - (((lo >> 13) & 1) ^ s)
    const i2 = 1 - (((lo >> 11) & 1) ^ s)
    let imm =
      (s << 24) | (i1 << 23) | (i2 << 22) | ((hi & 0x3ff) << 12) | ((lo & 0x7ff) << 1)
    if (s) imm -= 1 << 25
    return { at: addr, kind: 'bl', target: addr + 4 + imm }
  }
  return null
}

/**
 * Every branch anywhere in the image whose target lands in `[lo, hi)`.
 *
 * Scanned at every halfword, so it reads data as instructions too and over-reports
 * rather than under-reports. That is the right direction: a spurious hit costs a
 * refusal that a human then reads, and a missed hit costs a unit.
 */
export function branchesInto(
  image: Uint8Array,
  base: number,
  lo: number,
  hi: number,
): Branch[] {
  const out: Branch[] = []
  for (let a = base; a + 2 <= base + image.length; a += 2) {
    const b = branchAt(image, base, a)
    if (b && b.target >= lo && b.target < hi) out.push(b)
  }
  return out
}

export interface Reference {
  at: number
  kind: 'ldr-literal' | 'raw-word' | 'built' | 'adr'
  value: number
}

/**
 * Every way the image might name an address in `[lo, hi)`.
 *
 * Three kinds, because `research/tools/fwtool.ts` documents two traps that have already
 * put wrong entries in the research docs, and both apply here:
 *
 *  - `ldr rN,[pc,#imm]` sites, resolved through the literal pool. The real references.
 *  - raw word-aligned words. Noisy: 129 words of animation bank data fall in the flash
 *    range by chance, so a hit is a question rather than an answer, and each is
 *    reported with its address so a human can judge it.
 *  - `movs`/`lsls` constructions, because an address is often computed and never
 *    appears as a literal at all. An empty result is not proof of absence.
 *  - `adr rN, #imm`, added 2026-08-20 by review. Its reach is about 1 KB, which makes
 *    it exactly the form that could name a block placed at the end of an image, and
 *    this firmware uses it: `abs 0x185fe` and `abs 0x1860a` on the donor build.
 *    `placeExtension` said "no ldr-literal, raw word or movs/lsls construction names
 *    an address in it" while not looking for the one form that reaches that far.
 */
export function referencesInto(
  image: Uint8Array,
  base: number,
  lo: number,
  hi: number,
): Reference[] {
  const out: Reference[] = []
  const dv = new DataView(image.buffer, image.byteOffset, image.byteLength)
  const u16 = (a: number) => image[a - base] | (image[a - base + 1] << 8)
  const inRange = (v: number) => v >= lo && v < hi

  for (let a = base; a + 4 <= base + image.length; a += 4) {
    const v = dv.getUint32(a - base, true)
    if (inRange(v)) out.push({ at: a, kind: 'raw-word', value: v })
  }
  for (let a = base; a + 2 <= base + image.length; a += 2) {
    const ins = u16(a)
    // adr rN, #imm8: 1010 0 ddd iiiiiiii, value Align(PC,4) + imm8*4. 0xa800 and up is
    // `add rN, sp, #imm`, which names a stack address and never a flash one.
    if ((ins & 0xf800) === 0xa000) {
      const v = ((((a + 4) >> 2) << 2) + (ins & 0xff) * 4) >>> 0
      if (inRange(v)) out.push({ at: a, kind: 'adr', value: v })
      continue
    }
    if ((ins & 0xf800) === 0x4800) {
      const pool = (((a + 4) >> 2) << 2) + (ins & 0xff) * 4
      if (pool + 4 - base > image.length) continue
      const v = dv.getUint32(pool - base, true)
      if (inRange(v)) out.push({ at: a, kind: 'ldr-literal', value: v })
      continue
    }
    // movs rN,#imm8 followed within four halfwords by lsls rN,rN,#k on the same
    // register. Deliberately shallow: it catches the shape fwtool warns about and
    // makes no claim to catch every arithmetic construction.
    if ((ins & 0xf800) === 0x2000) {
      const rd = (ins >> 8) & 7
      const imm = ins & 0xff
      for (let k = 1; k <= 4 && a + k * 2 + 2 <= base + image.length; k++) {
        const nxt = u16(a + k * 2)
        if ((nxt & 0xf800) !== 0x0000) continue
        if ((nxt & 7) !== rd || ((nxt >> 3) & 7) !== rd) continue
        const v = (imm << ((nxt >> 6) & 0x1f)) >>> 0
        if (inRange(v)) out.push({ at: a, kind: 'built', value: v })
        break
      }
    }
  }
  return out
}

/** Where every anchor the patch depends on actually is, in one particular image. */
export interface Layout {
  base: number
  site: HookSite
  /** Branches into the block between the hook and the epilogue. Reported, not written. */
  blockEntries: Branch[]
  notify: number
  /** Null when the signature was absent or ambiguous; the notes say which. */
  aesKey: number | null
  advertName: number | null
}

export interface LayoutResult {
  layout: Layout | null
  notes: Note[]
}

/**
 * Signatures, taken from the APK build and searched for in whatever image we get.
 *
 * The hook site is **not** in here, and that is the point: it used to be 28 literal
 * bytes of the APK's compiler output and none of them appear in the image a real
 * unit runs, not even a six-byte prefix. `findHookSite` looks for the shape of the
 * dispatch chain instead, which both builds share.
 */
export const SIGNATURE = {
  /**
   * The first 24 bytes of `notify`. Long enough to be unique in 66 KB and short
   * enough to survive a compiler that reordered what comes after it.
   */
  notify: new Uint8Array([
    0x10, 0xb5, 0x10, 0x4a, 0x00, 0x28, 0x10, 0x70, 0x11, 0xd0, 0x49, 0x1e, 0xc3, 0x07,
    0x03, 0xd0, 0x4b, 0x78, 0x53, 0x70, 0x49, 0x1c, 0x52, 0x1c,
  ]),
  vendorKey: new Uint8Array([
    0x34, 0x52, 0x2a, 0x5b, 0x7a, 0x6e, 0x49, 0x2c, 0x08, 0x09, 0x0a, 0x9d, 0x8d, 0x2a,
    0x23, 0xf8,
  ]),
  advertName: new Uint8Array([...'GLASSES-'].map((c) => c.charCodeAt(0))),
} as const

/** One `cmp <reg>, #<ascii>` / `b<cond> <target>` pair of the first-letter chain. */
interface ChainLink {
  at: number
  imm: number
  branch: Branch
}

/**
 * Find the four dead bytes to hook, by the shape of the dispatcher rather than by
 * its bytes.
 *
 * The shape both builds share, and the only thing this relies on:
 *
 *  1. exactly one run of six or more `cmp <opReg>, #<uppercase letter>` / `b<cond>`
 *     pairs at consecutive halfwords exists in the image, and an
 *     `ldrb <opReg>, [<frameReg>, #2]` sits within 24 bytes before it. That load is
 *     what puts the opcode in a register and the run is the first-letter chain. The
 *     run is what has to be unique; the load is an anchor, and the nearest match wins;
 *  2. somewhere in that run an immediate repeats, and the earlier of the two is a
 *     `beq`, so the later compare can never fire;
 *  3. that later compare is itself a `cmp`/`beq` pair, four bytes, and the island it
 *     branches to has exactly one referrer, which is that `beq`;
 *  4. nothing anywhere in the image branches into those four bytes;
 *  5. every branch in the chain and the length gate above it that lands on a
 *     `pop {r3,r4,r5,r6,r7,pc}` lands on the same one. That is the epilogue.
 *
 * Every one of those is a refusal when it does not hold, never a fallback. An image
 * whose dispatcher was rearranged enough to break any of them is an image whose
 * whole layout wants looking at by a person.
 */
export function findHookSite(
  image: Uint8Array,
  base = IMAGE_BASE,
): { site: HookSite | null; notes: Note[] } {
  const notes: Note[] = []
  const fatal = (message: string) => {
    notes.push({ severity: 'fatal', message })
    return { site: null, notes }
  }
  const u16 = (a: number) => image[a - base] | (image[a - base + 1] << 8)
  const end = base + image.length
  const isUpper = (c: number) => c >= 0x41 && c <= 0x5a

  // A chain is six or more `cmp <reg>, #<letter>` / `b<cond>` pairs at consecutive
  // halfwords, all on one register. Then the load that put the opcode in that register
  // is the nearest `ldrb <reg>, [<frame>, #2]` before it, which sits three instructions
  // back on both builds in hand: not a fixed gap in principle, so it is searched.
  const LOAD_LOOKBACK = 24
  const chains: { loadAt: number; opReg: number; frameReg: number; links: ChainLink[] }[] =
    []
  for (let a = base; a + 4 <= end; a += 2) {
    const first = u16(a)
    if ((first & 0xf800) !== 0x2800 || !isUpper(first & 0xff)) continue
    const opReg = (first >> 8) & 7
    const links: ChainLink[] = []
    for (let p = a; p + 4 <= end; p += 4) {
      const cmp = u16(p)
      if ((cmp & 0xf800) !== 0x2800) break
      if (((cmp >> 8) & 7) !== opReg) break
      if (!isUpper(cmp & 0xff)) break
      const branch = branchAt(image, base, p + 2)
      if (!branch || branch.kind !== 'b.cond') break
      links.push({ at: p, imm: cmp & 0xff, branch })
    }
    if (links.length < 6) continue
    // `ldrb rt, [rn, #2]` is 0111 1 00010 rn rt.
    let loadAt = -1
    let frameReg = -1
    for (let q = a - 2; q >= base && q >= a - LOAD_LOOKBACK; q -= 2) {
      const ins = u16(q)
      if ((ins & 0xf800) !== 0x7800) continue
      if (((ins >> 6) & 0x1f) !== 2) continue
      if ((ins & 7) !== opReg) continue
      loadAt = q
      frameReg = (ins >> 3) & 7
      break
    }
    if (loadAt < 0) continue
    chains.push({ loadAt, opReg, frameReg, links })
    a = links[links.length - 1].at //  do not restart inside the chain just found
  }

  if (chains.length === 0) {
    return fatal('no command dispatcher in this image: nothing looks like an ' +
      '`ldrb <reg>, [<frame>, #2]` followed by six or more compares of that register ' +
      'against uppercase letters. Either this is not an application image or the ' +
      'dispatcher has been rewritten, and the hook has to be re-derived by hand')
  }
  if (chains.length > 1) {
    return fatal(`${chains.length} places in this image look like the command ` +
      `dispatcher: ${chains.map((c) => hex(c.loadAt)).join(', ')}. This tool will not ` +
      'guess which one the radio actually reaches')
  }
  const { loadAt, opReg, frameReg, links } = chains[0]

  // The dead compare: an immediate the chain has already answered with a `beq`.
  let dead: ChainLink | null = null
  let answeredBy: ChainLink | null = null
  for (let i = 1; i < links.length && !dead; i++) {
    for (let j = 0; j < i; j++) {
      if (links[j].imm !== links[i].imm) continue
      if (branchAt(image, base, links[j].at + 2)?.kind !== 'b.cond') continue
      if ((u16(links[j].at + 2) & 0x0f00) !== 0x0000) continue //   b*eq* only
      if ((u16(links[i].at + 2) & 0x0f00) !== 0x0000) continue
      dead = links[i]
      answeredBy = links[j]
      break
    }
  }
  if (!dead || !answeredBy) {
    return fatal(`the dispatch chain at ${hex(links[0].at)} has no compare that can ` +
      'never fire, so there are no four dead bytes to put the hook in. Every letter it ' +
      'tests is reachable, which means a hook here would have to cost an opcode')
  }

  const island = dead.branch.target
  const referrers = branchesInto(image, base, island, island + 2)
  if (referrers.length !== 1 || referrers[0].at !== dead.branch.at) {
    return fatal(`the branch island at ${hex(island)}, which the dead compare at ` +
      `${hex(dead.at)} reaches, has ${referrers.length} referrer(s) ` +
      `(${referrers.map((b) => hex(b.at)).join(', ') || 'none'}) rather than only that ` +
      'compare. Something else reaches it, so it is not dead and neither is the compare')
  }
  const into = branchesInto(image, base, dead.at, dead.at + HOOK_LEN)
  if (into.length) {
    return fatal(`${into.length} branch(es) land inside the four bytes at ` +
      `${hex(dead.at)} that the hook replaces: ` +
      into.map((b) => `${hex(b.at)} -> ${hex(b.target)}`).join(', '))
  }

  // **The check the whole design rests on, and it is not the island one.**
  //
  // "This compare can never fire" is true only if the only way to reach it is by
  // falling through the earlier compare of the same letter. An island with one
  // referrer says nothing about that: it says where the branch goes, not whether
  // anything jumps in behind it. So scan the span between the two compares.
  //
  // Found by review, 2026-08-20, which planted `b <first S>` inside that span and was
  // accepted with no note. `CLAUDE.md`'s rule was being applied to the four bytes the
  // hook writes and not to the span the argument depends on.
  const interior = branchesInto(image, base, answeredBy.branch.at + 2, dead.at + 2)
  if (interior.length) {
    return fatal(`${interior.length} branch(es) enter the chain between the compare ` +
      `at ${hex(answeredBy.at)} that answers ` +
      `'${String.fromCharCode(dead.imm)}' and the dead one at ${hex(dead.at)}: ` +
      interior.map((b) => `${hex(b.at)} -> ${hex(b.target)}`).join(', ') +
      '. Reaching the dead compare would then not imply the opcode is not ' +
      `'${String.fromCharCode(dead.imm)}', so it is not dead and the hook cannot go there`)
  }

  // The two compares must be the same instruction, byte for byte. Independent of the
  // four bytes being replaced, because it reads the OTHER one, so a site misidentified
  // by one link fails here rather than being certified by an expectation rebuilt out
  // of the very bytes it is meant to check.
  if (u16(answeredBy.at) !== u16(dead.at)) {
    return fatal(`the compare at ${hex(dead.at)} and the one at ${hex(answeredBy.at)} ` +
      `that answers ahead of it are not the same instruction (${hex(u16(dead.at))} vs ` +
      `${hex(u16(answeredBy.at))}), so they do not test the same letter in the same ` +
      'register and the deadness argument does not apply')
  }

  // The resumed instruction has to consume the flags our compare leaves behind, or not
  // care. `cmp` sets NZCV, and ours compares against a different letter, so N, C and V
  // differ from stock for most operands even though Z agrees. On both builds in hand
  // `returnTo` is itself a `cmp`, which overwrites them before anything reads them.
  if ((u16(dead.at + HOOK_LEN) & 0xf800) !== 0x2800) {
    return fatal(`the instruction at ${hex(dead.at + HOOK_LEN)}, where the hook returns ` +
      `when the opcode is not ours, is ${hex(u16(dead.at + HOOK_LEN))} and not a cmp. ` +
      'The hook leaves N, C and V set from a compare against a different letter, so ' +
      'anything there that reads the flags rather than setting them would mis-dispatch')
  }

  // Our own opcode must not be a letter the vendor's chain already answers, or every
  // frame we send is eaten by an arm ahead of the hook and the unit answers nothing.
  // Register-generic, unlike the byte-pair search this replaced, which only ever ran
  // on the APK because it looked for `cmp r2` specifically.
  const taken = links.find((l) => l.imm === OPCODE.charCodeAt(0))
  if (taken) {
    return fatal(`the vendor's own dispatcher already tests ` +
      `'${OPCODE}' at ${hex(taken.at)}, so a frame with that opcode never reaches the ` +
      'hook. Pick an opcode letter this chain does not use')
  }

  // The epilogue, from whatever the chain and the length gate above it branch to.
  const pops = new Set<number>()
  for (let a = loadAt - 32; a < dead.at + 8; a += 2) {
    if (a < base) continue
    const b = branchAt(image, base, a)
    if (!b) continue
    const off = b.target - base
    if (off < 0 || off + 2 > image.length) continue
    if (image[off] === POP_R3_R7_PC[0] && image[off + 1] === POP_R3_R7_PC[1]) {
      pops.add(b.target)
    }
  }
  if (pops.size !== 1) {
    return fatal(`the dispatcher at ${hex(loadAt)} branches to ${pops.size} different ` +
      `pop {r3-r7,pc} instructions (${[...pops].map(hex).join(', ') || 'none'}). The ` +
      'hook returns a frame that IS ours straight to the epilogue, and it will not ' +
      'guess which of several that is')
  }

  const site: HookSite = {
    chainAt: links[0].at,
    loadAt,
    opReg,
    frameReg,
    callAt: dead.at,
    deadImm: dead.imm,
    returnTo: dead.at + HOOK_LEN,
    deadIsland: island,
    epilogue: [...pops][0],
  }
  notes.push({
    severity: 'warn',
    message: `hook site ${hex(site.callAt)}: the chain at ${hex(site.chainAt)} tests ` +
      `r${opReg} (loaded at ${hex(loadAt)} from [r${frameReg}, #2]) and answers ` +
      `'${String.fromCharCode(dead.imm)}' before it reaches this compare, so these four ` +
      `bytes and the island at ${hex(island)} are dead. Returns to ${hex(site.returnTo)} ` +
      `when the opcode is not ours and to the epilogue at ${hex(site.epilogue)} when it is`,
  })
  return { site, notes }
}

/** The dispatcher's own entry, and the length gate every frame passes through first. */
export interface Dispatcher {
  /** `push {r3,r4,r5,r6,r7,lr}`: where the radio's callback enters. */
  entry: number
  /** Frame struct offset the gate reads the body length from. `0xfb` on both builds. */
  lengthOff: number
  /** The bounds it enforces, inclusive. 4 to 20 on both builds. */
  minBody: number
  maxBody: number
}

/**
 * Find where the dispatcher actually starts, and what its length gate accepts.
 *
 * **This exists so a test can enter where the radio enters.** Every test of the
 * extension used to start at the hook, 30 halfwords past the gate, and review 33 found
 * what that hides: three of the five `UPD_*` frames were two bytes long, the gate drops
 * anything under four, and none of them ever reached the trampoline at all
 * (`research/patch-over-bt-review-2026-08-20.md`, section 1). The frames were fixed by
 * padding; the lasting fix is being able to run the gate.
 *
 * The shape both builds share, and each part is a refusal rather than an assumption: a
 * push with `lr` within 40 bytes before the opcode load, an `adds r0, #imm` and an
 * `ldrb rL, [r0, #imm]` that together name the length field, and two compares of that
 * register whose branches both leave for the epilogue.
 */
export function findDispatcher(
  image: Uint8Array,
  base: number,
  site: HookSite,
): { dispatcher: Dispatcher | null; notes: Note[] } {
  const notes: Note[] = []
  const u16 = (a: number) => image[a - base] | (image[a - base + 1] << 8)
  const fatal = (message: string) => {
    notes.push({ severity: 'fatal', message })
    return { dispatcher: null, notes }
  }

  let entry = -1
  for (let a = site.loadAt - 2; a >= base && a >= site.loadAt - 40; a -= 2) {
    const ins = u16(a)
    if ((ins & 0xfe00) === 0xb400 && (ins & 0x0100) !== 0) entry = a
  }
  if (entry < 0) {
    return fatal(`no push-with-lr within 40 bytes before the opcode load at ` +
      `${hex(site.loadAt)}, so the dispatcher's own entry cannot be found`)
  }

  let addTo = -1
  let lengthOff = -1
  let lenReg = -1
  const bounds: { at: number; imm: number; cond: number }[] = []
  for (let a = entry; a < site.loadAt; a += 2) {
    const ins = u16(a)
    if ((ins & 0xf800) === 0x3000 && ((ins >> 8) & 7) === 0) addTo = ins & 0xff
    if ((ins & 0xf800) === 0x7800 && addTo >= 0 && ((ins >> 3) & 7) === 0) {
      lengthOff = addTo + ((ins >> 6) & 0x1f)
      lenReg = ins & 7
      continue
    }
    if (lenReg >= 0 && (ins & 0xf800) === 0x2800 && ((ins >> 8) & 7) === lenReg) {
      const br = branchAt(image, base, a + 2)
      if (br?.kind === 'b.cond' && br.target === site.epilogue) {
        bounds.push({ at: a, imm: ins & 0xff, cond: (u16(a + 2) >> 8) & 0xf })
      }
    }
  }
  if (lengthOff < 0) {
    return fatal(`the dispatcher at ${hex(entry)} does not compute a length field from ` +
      '`adds r0,#imm` and `ldrb rL,[r0,#imm]`, so the gate cannot be read')
  }
  const hi = bounds.find((b) => b.cond === 0x8) //   bhi: too long
  const lo = bounds.find((b) => b.cond === 0x3) //   blo: too short
  if (!hi || !lo) {
    return fatal(`the length gate at ${hex(entry)} is bounded on ` +
      `${bounds.length} side(s) rather than both, so a frame length this tool believes ` +
      'is acceptable might not be')
  }
  notes.push({
    severity: 'warn',
    message: `dispatcher ${hex(entry)}: body length at struct+${hex(lengthOff)} must be ` +
      `${lo.imm} to ${hi.imm} inclusive, or the frame never reaches the opcode compare`,
  })
  return {
    dispatcher: { entry, lengthOff, minBody: lo.imm, maxBody: hi.imm },
    notes,
  }
}

export interface ResolveOptions {
  base?: number
  /** Which `GLASSES-` to patch, when the image holds more than one. */
  advertNameAt?: number
  /** Which copy of the vendor key to patch, likewise. */
  aesKeyAt?: number
}

/**
 * Find every anchor the patch depends on, in this image, by content.
 *
 * On the APK image it resolves to the constants above, which is asserted in the tests
 * and is the point: the same code path serves both, so the donor path is not a second
 * implementation that can quietly disagree with the one that has been used.
 */
export function resolveLayout(image: Uint8Array, opts: ResolveOptions = {}): LayoutResult {
  const base = opts.base ?? IMAGE_BASE
  const notes: Note[] = []
  const fatal = (message: string) => notes.push({ severity: 'fatal', message })
  const warn = (message: string) => notes.push({ severity: 'warn', message })

  const pick = (what: string, needle: Uint8Array, chosen?: number): number | null => {
    const hits = occurrences(image, needle, base)
    if (hits.length === 1) return hits[0]
    if (hits.length === 0) {
      fatal(`no ${what} in this image. The signature is the APK build's and this image ` +
        'is a different build, so it has to be re-derived by hand before anything is ' +
        'patched')
      return null
    }
    if (chosen !== undefined && hits.includes(chosen)) {
      warn(`${what} appears ${hits.length} times (${hits.map(hex).join(', ')}); ` +
        `taking ${hex(chosen)} because it was named on the command line`)
      return chosen
    }
    fatal(`${what} appears ${hits.length} times, at ${hits.map(hex).join(', ')}. This ` +
      'tool will not guess which copy is the live one: a donor window carries the tail ' +
      'of whatever image was flashed before it, and the wrong copy patches dead bytes ' +
      'while the live ones stay stock')
    return null
  }

  const found = findHookSite(image, base)
  notes.push(...found.notes)
  const site = found.site
  const notify = pick('the notify function', SIGNATURE.notify)
  const aesKey = pick('the vendor AES key', SIGNATURE.vendorKey, opts.aesKeyAt)
  const advertName =
    pick('the GLASSES- advert prefix', SIGNATURE.advertName, opts.advertNameAt)

  // The block the old 28-byte hook would have overwritten. Nothing is written to it
  // any more, and it is reported because what is inside it is the reason: on the image
  // a real unit runs, ten dispatcher arms branch into its last four bytes.
  let blockEntries: Branch[] = []
  if (site) {
    const block = branchesInto(image, base, site.returnTo, site.epilogue)
    blockEntries = block
    if (block.length) {
      warn(`${block.length} branch(es) land inside ${hex(site.returnTo)}-` +
        `${hex(site.epilogue)}, the block between the hook and the epilogue: ` +
        block.slice(0, 4).map((b) => `${hex(b.at)} -> ${hex(b.target)}`).join(', ') +
        (block.length > 4 ? `, and ${block.length - 4} more` : '') +
        '. The hook writes none of those bytes, which is why it is four bytes and not 28')
    }
  }

  if (!site || notify === null || notes.some((n) => n.severity === 'fatal')) {
    return { layout: null, notes }
  }
  return { layout: { base, site, blockEntries, notify, aesKey, advertName }, notes }
}

// --- Where the block goes ------------------------------------------------------------

export interface Placement {
  addr: number
  /** What the bytes it lands on currently are. */
  on: 'erased' | 'zero-fill'
}

/**
 * A placement, or null with the reason.
 *
 * *Corrected 2026-08-20.* This used to be `Placement | null`, with the notes inside
 * the object, so every refusal threw away its own explanation: `build-firmware`
 * printed "there is nowhere in this image to put the extension" and nothing about
 * whether the problem was no erased flash, no zero fill, or a reference into the fill.
 */
export interface PlacementResult {
  place: Placement | null
  notes: Note[]
}

export interface PlaceOptions {
  /** The application region as the donor holds it, starting at `base`. */
  window: Uint8Array
  base?: number
  end?: number
  size: number
  /** Permit placing into a run of programmed zeros, if nothing references it. */
  intoFill?: boolean
}

const align4 = (n: number) => (n + 3) & ~3

/** Flash page, the erase granularity. *verified* on silicon 2026-08-20. */
export const PAGE = 512
const alignPage = (n: number) => (n + PAGE - 1) & ~(PAGE - 1)

/**
 * Choose an address for the extension inside one particular image.
 *
 * `EXT_BASE` is `0x26a24` because that is where the APK's image ends. A donor's does
 * not end there: unit 1's window holds 7,047 bytes of a longer build at `0x26c00` and
 * then programmed zeros to `0x293ff`, so the same constant would land the extension
 * inside live code on one image and inside data on another. This computes it instead,
 * from the bytes, and refuses rather than choosing badly.
 *
 * The preferred landing is erased flash past everything. Where there is none, the tail
 * of the region is often programmed zeros rather than `0xFF`, and `--into-fill` will
 * use that, but only after `referencesInto` comes back empty, and it says so.
 */
export function placeExtension(opts: PlaceOptions): PlacementResult {
  const base = opts.base ?? IMAGE_BASE
  const end = opts.end ?? STAGING_BANK
  const notes: Note[] = []
  const w = opts.window
  const size = opts.size

  let lastUsed = -1
  let lastData = -1
  for (let i = 0; i < w.length && base + i < end; i++) {
    if (w[i] !== 0xff) lastUsed = base + i
    if (w[i] !== 0xff && w[i] !== 0x00) lastData = base + i
  }

  const erasedAt = align4(lastUsed + 1)
  if (erasedAt + size <= end) {
    notes.push({
      severity: 'warn',
      message: `${end - erasedAt} bytes of erased flash between ${hex(erasedAt)} and ` +
        `the staging bank at ${hex(end)}; the block takes ${size} of them`,
    })
    return { place: { addr: erasedAt, on: 'erased' }, notes }
  }

  // **Page-aligned, not word-aligned.**
  //
  // Two reasons, and the second is the one that made it necessary. A block whose whole
  // point is "SWD writes this and nothing else ever does" reads better on a page
  // boundary, because a page is the erase granularity and the resident half of the
  // over-BT updater has to be a set of whole pages nothing else can reach
  // (`notes/patch-over-bt.md`). And on the donor the last data page ends in a byte pair
  // that decodes as `adr r5, #12`, naming an address 16 bytes further on: data, not
  // code, but nothing here can tell the difference, and starting at the next page puts
  // the block out of every ADR's ~1 KB reach rather than arguing about it.
  const fillAt = alignPage(lastData + 1)
  const shortfall = `the image runs to ${hex(lastUsed + 1)} and the staging bank starts ` +
    `at ${hex(end)}, which leaves ${Math.max(0, end - erasedAt)} bytes of erased flash ` +
    `for a ${size}-byte block`
  if (fillAt + size > end) {
    notes.push({
      severity: 'fatal',
      message: `nowhere to put the extension: ${shortfall}, and the last byte that is ` +
        `neither erased nor zero is at ${hex(lastData)}, so there is no zero fill to ` +
        'use either. This image has no free flash below the staging bank',
    })
    return { place: null, notes }
  }

  const refs = referencesInto(w, base, fillAt, end)
  // Said exactly, because "3,192 bytes of programmed zeros" was wrong: the run past the
  // last real byte is part erased and part zeros, and asking someone to consent to
  // --into-fill is asking them to consent to the zeros specifically.
  let erased = 0
  let zeros = 0
  for (let a = fillAt; a < end; a++) {
    const b = w[a - base]
    if (b === 0xff) erased++
    else if (b === 0x00) zeros++
  }
  const where = `${hex(fillAt)}-${hex(end)}, ${end - fillAt} bytes past the last real ` +
    `byte at ${hex(lastData)}: ${zeros} programmed zeros and ${erased} erased`
  if (!opts.intoFill) {
    notes.push({
      severity: 'fatal',
      message: `no erased flash to put the extension in: ${shortfall}. There is ${where}` +
        `, and ${refs.length === 0 ? 'nothing in the image names an address in it' :
          `${refs.length} site(s) in the image name an address in it`}. --into-fill ` +
        'uses it, and is a decision to make on purpose rather than a default: nothing ' +
        'has established that the running application never reads that zero fill',
    })
    return { place: null, notes }
  }
  if (refs.length > 0) {
    notes.push({
      severity: 'fatal',
      message: `--into-fill was asked for, and ${refs.length} site(s) in the image name ` +
        `an address inside ${where}: ` +
        refs.slice(0, 8).map((r) => `${hex(r.at)} ${r.kind} ${hex(r.value)}`).join(', ') +
        (refs.length > 8 ? `, and ${refs.length - 8} more` : '') +
        '. A raw-word hit can be a coincidence and an ldr-literal one cannot; either ' +
        'way this needs a person, not a flag',
    })
    return { place: null, notes }
  }
  notes.push({
    severity: 'warn',
    message: `placed into ${where}. No ldr-literal, adr, raw word or movs/lsls ` +
      'construction in the image names an address in it, which is the same scan that cleared the ' +
      'orphan region in research/hardfault-0xd38-2026-08-19.md. It is still a zero fill ' +
      'nobody has proved is dead',
  })
  return { place: { addr: fillAt, on: 'zero-fill' }, notes }
}

// --- The extension block ----------------------------------------------------------

/**
 * Byte offsets within the extension header. The trampoline reads `TABLE_COUNT` and
 * `TABLE` at run time; the rest is there so our tooling can read a built image back
 * and report what is in it rather than trusting a constant that can drift.
 *
 * Dispatch indexes `TABLE` from 0, so a sub-command at 0x10 costs 16 empty slots
 * ahead of it. That is 32 bytes of zeros against a two-instruction dispatch, which
 * is the right trade with 10 KB of flash free.
 *
 * **A slot's body has the same header**, so `slot_dispatch` reads its table the way the
 * trampoline reads its own and there is one layout rather than two. One field means
 * something different there: `ENTRY` holds **the address the body was assembled for**,
 * Thumb-tagged, because a slot has no trampoline and dispatch is by table. The resident
 * dispatcher compares it with where the body actually is, which is what catches a body
 * built for one slot and programmed into the other -
 * `notes/patch-over-bt.md`'s "the one failure the design does not catch".
 * `features/index.ts` stamps it.
 */
export const HDR = {
  MAGIC: 0x00,
  VERSION: 0x04,
  CAPABILITIES: 0x06,
  ENTRY: 0x08,
  SIZE: 0x0c,
  TABLE_COUNT: 0x10,
  RESERVED: 0x12,
  TABLE: 0x14,
} as const

export interface ExtOptions {
  /** Our firmware version, reported by HELLO. */
  version: number
  base?: number
  /** Address of `notify` in the image this block will live in. */
  notify?: number
  /** Registers and addresses the trampoline is arithmetic on, per image. */
  site?: HookSite
}

export interface Extension {
  /** The bytes to append at `base`. */
  code: Uint8Array
  base: number
  version: number
  capabilities: number
  /** Absolute Thumb address of the trampoline, i.e. with bit 0 set. */
  entry: number
  /**
   * The 6-byte payload a HELLO reply carries **when no slot is live**.
   *
   * With one live the capability word is this one ORed with the slot's, so a client can
   * see a slot feature at all: `jgx.permits()` refuses any sub-command whose bit is
   * clear, which would otherwise make every slot feature unusable.
   */
  helloReply: Uint8Array
}

/**
 * Assemble the extension block.
 *
 * Layout is a self-describing header first, so our tooling can read a built image
 * back and report exactly what is compiled into it rather than trusting a constant
 * that can drift. The header is data only; nothing in it is executed.
 *
 * **The capability word here is the resident half's only.** HELLO reports it ORed with
 * the live slot's, so what a unit advertises depends on what is in its slot, and
 * `Extension.helloReply` below is therefore the reply for a unit with no slot at all.
 */
export function buildExtension(opts: ExtOptions): Extension {
  const base = opts.base ?? EXT_BASE
  const site = opts.site ?? APK_HOOK_SITE
  const capabilities = CAP.SESSION | CAP.UPDATE

  // Adding a sub-command later means one more entry here and one more handler
  // below. Nothing else in the firmware changes, which is the whole point.
  //
  // The five `UPD_*` handlers are **resident**: they live here, in the half of the
  // firmware only a probe can rewrite, and the trampoline reaches them without
  // consulting a slot. That is what makes a broken slot recoverable over the air
  // rather than with the case open (`notes/patch-over-bt.md`).
  const handlers = [
    { id: SUB.HELLO, label: 'hello' },
    { id: SUB.UPD_BEGIN, label: 'upd_begin' },
    { id: SUB.UPD_DATA, label: 'upd_data' },
    { id: SUB.UPD_END, label: 'upd_end' },
    { id: SUB.UPD_ABORT, label: 'upd_abort' },
    { id: SUB.UPD_STATUS, label: 'upd_status' },
  ]
  const tableCount = Math.max(...handlers.map((h) => h.id)) + 1

  const a = new Asm(base)
  a.ascii(MAGIC)
  a.half(opts.version)
  a.half(capabilities)
  a.word(0) //               ENTRY, filled in once the trampoline has an address
  a.word(0) //               SIZE, likewise
  a.half(tableCount)
  a.half(0) //               reserved
  if (a.size !== HDR.TABLE) throw new Error(`header is ${a.size} bytes, expected 0x14`)

  // One u16 offset from `base` per sub-command, 0 meaning "not compiled in".
  for (let i = 0; i < tableCount; i++) a.half(0)
  a.align(4)

  // --- trampoline -----------------------------------------------------------------
  //
  // Entered by `bl` from inside the vendor's dispatch chain, on EVERY frame the chain
  // did not match, so the first thing it does is decide whether the frame is ours and
  // the cheapest exit is the one for frames that are not.
  //
  // The opcode is re-read from the frame rather than taken from the register the chain
  // left it in, because that register is `r2` on the APK build and `r1` on the image a
  // real unit runs. Re-loading writes back the value it already held, so the resumed
  // chain is bit-identical to stock.
  //
  // Nothing is pushed. A frame that IS ours ends by branching to the vendor's own
  // `pop {r3,r4,r5,r6,r7,pc}`, which unwinds the dispatcher's frame, so the stack has
  // to be exactly as the dispatcher left it. `r4`-`r7` are the dispatcher's callee-saved
  // set and are restored by that pop; `r0`-`r3` and `lr` are ours to clobber.
  const opReg = `r${site.opReg}` as const
  const frameReg = `r${site.frameReg}` as const
  a.label('entry')
  a.ldrb(opReg, frameReg, ARG(1)) //             the opcode, wire index 1
  a.cmp(opReg, OPCODE.charCodeAt(0))
  a.bcond('ne', 'not_ours')
  a.ldrPool('r3', 'ext_base') //                 our own base address
  a.ldrb('r0', frameReg, ARG(2)) //              sub-command, wire index 2
  a.ldrh('r1', 'r3', HDR.TABLE_COUNT)
  a.cmpReg('r0', 'r1')
  a.bcond('hs', 'try_slot') //                   past the resident table: ask the slot
  a.lsls('r2', 'r0', 1) //                       r0 keeps the sub-command for `try_slot`
  a.adds('r2', HDR.TABLE)
  a.ldrhReg('r2', 'r3', 'r2') //                 table[sub], an offset from base
  a.cmp('r2', 0)
  a.bcond('eq', 'try_slot') //                   resident slot empty: ask the slot
  a.addsReg('r2', 'r2', 'r3')
  a.adds('r2', 1) //                             Thumb bit
  a.mov('r0', frameReg) //                       arg 0 is the frame struct pointer
  a.blx('r2')
  a.b('done')
  // **Resident first, and this is the order the whole recovery argument rests on.**
  // A sub-command is offered to the live slot only after the resident table has been
  // asked and had nothing for it, so no slot can shadow `HELLO` or any `UPD_*`, however
  // its table is filled in. Review 33 pointed out that until now this was vacuous
  // rather than true: there was no slot dispatch at all, so nothing could be ordered
  // against (`research/patch-over-bt-review-2026-08-20.md`, section 3).
  a.label('try_slot')
  a.mov('r1', frameReg)
  a.bl('slot_dispatch') //                       r0 = sub-command, r1 = frame struct
  a.label('done')
  a.ldrPool('r0', 'epilogue')
  a.bx('r0') //                                  ours, handled or not: end the frame
  a.label('not_ours')
  a.bx('lr') //                                  resume the vendor's chain, unchanged
  a.align(4)
  a.label('ext_base').word(base)
  a.label('epilogue').word((site.epilogue | 1) >>> 0)

  // --- slot dispatch ---------------------------------------------------------------
  //
  // `slot_dispatch(r0 = sub-command, r1 = frame struct)`. Reads the live slot's own
  // `JGX1` header the same way the trampoline reads its own, and calls the handler its
  // table names.
  //
  // **Five refusals, all silent, and each is a way a slot can be wrong without being
  // corrupt.** A slot's CRC says its bytes arrived; it says nothing about whether the
  // header means anything, and a bad offset here is a `blx` into whatever it lands on.
  //
  //  - no slot validates, so there is nothing to ask;
  //  - the body is not a `JGX1` block;
  //  - **the body was assembled for the other slot.** `notes/patch-over-bt.md` calls
  //    that "the one failure the design does not catch": slot code is
  //    position-dependent, and a slot built for A and programmed into B has a valid
  //    magic and a valid CRC and simply branches somewhere absurd. It is caught now,
  //    because the body's `entry` word carries the base it was built for and this
  //    compares it with where the body actually is;
  //  - the table has no entry for this sub-command;
  //  - the offset it does have is outside the body the slot header declares.
  a.label('slot_dispatch')
  a.push(['r4', 'r5', 'r6', 'lr'])
  a.mov('r4', 'r0') //                           sub-command
  a.mov('r5', 'r1') //                           frame struct
  a.bl('live_slot') //                           r0 = slot base or 0, r1 = generation
  a.cmp('r0', 0)
  a.bcond('eq', 'slot_done')
  a.mov('r6', 'r0')
  a.ldr('r1', 'r6', SLOT_HDR.LEN) //             the body length the slot declares
  a.ldrPool('r0', 'slot_max_body')
  a.cmpReg('r1', 'r0')
  a.bcond('hi', 'slot_done') //                  erased or stale header
  a.cmp('r1', HDR.TABLE + 2) //                  smaller than a header and one entry
  a.bcond('lo', 'slot_done')
  a.adds('r6', SLOT_HDR_LEN) //                  the JGX1 body itself
  a.ldr('r0', 'r6', HDR.MAGIC)
  a.ldrPool('r2', 'body_magic')
  a.cmpReg('r0', 'r2')
  a.bcond('ne', 'slot_done')
  a.ldr('r0', 'r6', HDR.ENTRY) //                the base this body was assembled for
  a.mov('r2', 'r6')
  a.adds('r2', 1) //                             Thumb-tagged, as the resident's is
  a.cmpReg('r0', 'r2')
  a.bcond('ne', 'slot_done') //                  built for the other slot
  a.ldrh('r0', 'r6', HDR.TABLE_COUNT)
  a.cmpReg('r4', 'r0')
  a.bcond('hs', 'slot_done')
  a.lsls('r2', 'r4', 1)
  a.adds('r2', HDR.TABLE)
  a.ldrhReg('r2', 'r6', 'r2') //                 table[sub], an offset from the body
  a.cmp('r2', 0)
  a.bcond('eq', 'slot_done')
  a.cmpReg('r2', 'r1') //                        inside the declared body
  a.bcond('hs', 'slot_done')
  a.addsReg('r2', 'r2', 'r6')
  a.adds('r2', 1)
  a.mov('r0', 'r5')
  a.blx('r2')
  a.label('slot_done')
  a.pop(['r4', 'r5', 'r6', 'pc'])

  // `slot_caps() -> r0 = the live slot's capability word, or 0`. Next to the dispatcher
  // so the magic check exists once: HELLO reports these bits ORed with the resident
  // ones, and a header that is not a `JGX1` block contributes nothing.
  a.label('slot_caps')
  a.push(['lr'])
  a.bl('live_slot')
  a.cmp('r0', 0)
  a.bcond('eq', 'slot_caps_none')
  a.ldr('r1', 'r0', SLOT_HDR_LEN + HDR.MAGIC)
  a.ldrPool('r2', 'body_magic')
  a.cmpReg('r1', 'r2')
  a.bcond('ne', 'slot_caps_none')
  // The same assembled-for check the dispatcher makes. A body that will never be
  // entered must not advertise what it carries, or a client asks for a feature that
  // answers nothing: found by the test for the wrong-slot case, which passed on the
  // dispatch and failed on HELLO.
  a.ldr('r1', 'r0', SLOT_HDR_LEN + HDR.ENTRY)
  a.mov('r2', 'r0')
  a.adds('r2', SLOT_HDR_LEN + 1)
  a.cmpReg('r1', 'r2')
  a.bcond('ne', 'slot_caps_none')
  a.ldrh('r0', 'r0', SLOT_HDR_LEN + HDR.CAPABILITIES)
  a.pop(['pc'])
  a.label('slot_caps_none')
  a.movs('r0', 0)
  a.pop(['pc'])
  a.align(4)
  a.label('slot_max_body').word(SLOT_MAX_BODY)
  a.label('body_magic').word(MAGIC_WORD)

  // --- HELLO ----------------------------------------------------------------------
  //
  // **The capability word is the resident one OR the live slot's**, which is why this
  // is no longer a constant in flash. `packages/core/src/jgx.ts` gives every feature its
  // own bit and `permits()` refuses to send a sub-command whose bit is clear, so a
  // capability word that reported only the resident half would make every slot feature
  // permanently unusable by a client that obeys it. The slot's own `JGX1` header carries
  // its capabilities, so one read answers "what does this unit actually have".
  //
  // The magic is checked before the word is trusted: a slot whose header is not a `JGX1`
  // block contributes nothing rather than a garbage bitmap.
  a.label('hello')
  a.push(['r4', 'lr'])
  a.bl('slot_caps')
  a.mov('r4', 'r0')
  a.ldrPool('r0', 'hello_caps_word')
  a.orrs('r4', 'r0')
  a.push(['r4']) //                              second payload word
  a.ldrPool('r0', 'hello_head')
  a.push(['r0']) //                              first, so the two are in address order
  a.movs('r0', 6) //                             payload length, well under 15
  a.mov('r1', 'sp')
  a.bl(opts.notify ?? NOTIFY)
  a.pop(['r0'])
  a.pop(['r1'])
  a.pop(['r4', 'pc'])
  a.align(4)
  a.label('hello_head').word(
    (MARKER | (MSG.HELLO_REPLY << 8) | ((opts.version & 0xffff) << 16)) >>> 0,
  )
  a.label('hello_caps_word').word(capabilities)
  const helloReply = new Uint8Array([
    MARKER,
    MSG.HELLO_REPLY,
    opts.version & 0xff,
    (opts.version >> 8) & 0xff,
    capabilities & 0xff,
    (capabilities >> 8) & 0xff,
  ])
  a.align(4)

  // --- the resident updater -------------------------------------------------------
  emitUpdater(a, {
    base,
    notify: opts.notify ?? NOTIFY,
    arg: ARG,
    marker: MARKER,
    replyType: MSG.UPD_REPLY,
  })
  a.align(4)
  a.label('end')

  const code = a.assemble()
  const entry = a.addressOf('entry')
  const size = a.addressOf('end') - base

  // Fill in what could only be known once the code had been laid out: the entry,
  // the total size, and one table slot per handler.
  const dv = new DataView(code.buffer)
  dv.setUint32(HDR.ENTRY, (entry | 1) >>> 0, true)
  dv.setUint32(HDR.SIZE, size, true)
  for (const h of handlers) {
    dv.setUint16(HDR.TABLE + h.id * 2, a.addressOf(h.label) - base, true)
  }

  if (base + size > STAGING_BANK) {
    throw new Error(`extension runs past the staging bank at ${STAGING_BANK}`)
  }
  return { code, base, version: opts.version, capabilities, entry: entry | 1, helloReply }
}

/**
 * The one edit to the vendor's code: four bytes, one `bl` into the extension.
 *
 * It replaces a compare that can never fire, so no opcode is lost and no block with
 * entry points in it is overwritten. `bl` reaches +/-16 MB and the extension is tens
 * of kilobytes away, so no branch island and no literal pool are needed. `lr` is free:
 * the dispatcher's prologue pushes it and every path returns through
 * `pop {r3,r4,r5,r6,r7,pc}`, so nothing reads it again.
 *
 * The trampoline decides what happens next, and the two answers are `bx lr`, which
 * resumes the vendor's chain at the instruction after these four bytes, and a branch
 * to the epilogue, which is what a handled frame does.
 */
export function buildHook(entryThumb: number, where: HookSite = APK_HOOK_SITE): Uint8Array {
  const a = new Asm(where.callAt)
  a.bl(entryThumb & ~1)
  const code = a.assemble()
  if (code.length !== HOOK_LEN) {
    throw new Error(`hook is ${code.length} bytes, must be exactly ${HOOK_LEN}`)
  }
  return code
}

/**
 * The four bytes the hook expects to be replacing, rebuilt from the decode.
 *
 * **On its own this expectation cannot fail, and saying otherwise was wrong.**
 * *Corrected 2026-08-20 by review.* Every field it re-encodes was decoded from the
 * same four bytes and the decode is bijective, so the re-encode reproduces the bits
 * it read. Fuzzing 4,000 mutated dispatcher regions accepted 2,129 sites and found
 * zero where this differed from the image. It is a shape assertion, not a content one:
 * it catches a `patch.ts` caller pointing at the wrong address, and nothing else.
 *
 * **What actually checks the site is in `findHookSite`**, and it is the halfword
 * comparison against the OTHER compare of the same letter, plus the chain-interior
 * scan. Those read bytes the hook does not write, which is what makes them evidence.
 * The 28-byte hook this replaced carried 28 literal bytes of vendor output and did
 * not need the distinction; this one does.
 */
export function hookStockBytes(where: HookSite): Uint8Array {
  const a = new Asm(where.callAt)
  a.cmp(`r${where.opReg}` as 'r0', where.deadImm)
  a.bcond('eq', where.deadIsland)
  return a.assemble()
}

/** Read a built image back and report what the header says is in it. */
export function readExtension(plain: Uint8Array, base = EXT_BASE, imageBase = 0x16800) {
  const off = base - imageBase
  if (off + HDR.TABLE > plain.length) return null
  const magic = String.fromCharCode(...plain.subarray(off, off + 4))
  if (magic !== MAGIC) return null
  const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)
  const count = dv.getUint16(off + HDR.TABLE_COUNT, true)
  const subcommands: number[] = []
  for (let i = 0; i < count; i++) {
    if (dv.getUint16(off + HDR.TABLE + i * 2, true) !== 0) subcommands.push(i)
  }
  return {
    magic,
    version: dv.getUint16(off + HDR.VERSION, true),
    capabilities: dv.getUint16(off + HDR.CAPABILITIES, true),
    entry: dv.getUint32(off + HDR.ENTRY, true),
    size: dv.getUint32(off + HDR.SIZE, true),
    subcommands,
  }
}
