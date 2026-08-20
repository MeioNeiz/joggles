/**
 * The resident updater: the firmware that lets us replace our own code over Bluetooth,
 * again and again, without a probe.
 *
 * The design and the argument for it are `notes/patch-over-bt.md`. In one paragraph:
 * this code is written **once** over SWD and can never be rewritten over the air, and
 * every feature lives in one of two **slots** in the OTA staging bank which this code
 * replaces alternately. So a failed update is not a state to recover from, it is a slot
 * whose magic word never landed, with the previously live slot untouched.
 *
 * ## The one property every line here serves
 *
 * **A failed update must leave a unit that still answers the next update.** Three
 * things make that true and all three are structural rather than careful:
 *
 *  - **The updater is not in a slot.** It cannot erase the pages it executes from,
 *    which is the classic FMC hazard, because it never writes them. `guard` bounds
 *    every address that reaches `ISPADR` to **the one slot being written**, and the
 *    resident block is outside that bound. *Corrected 2026-08-20: it bounded them to
 *    both slots, and review 33 executed a single frame that used the slack to clear the
 *    live slot's magic.*
 *  - **`HELLO` and every `UPD_*` are resident**, and `ext.ts`'s trampoline dispatches
 *    them before it ever consults a slot's table. A slot whose code faults cannot make
 *    a unit unreachable by the commands that replace it.
 *  - **The magic word is programmed last.** Flash programming only clears bits, so a
 *    partially programmed word holds a strict superset of the target's `1` bits and
 *    therefore cannot equal the magic unless the program completed. Power loss at any
 *    earlier point leaves a slot that fails validation. *derived* from how NOR flash
 *    programs, not measured on this part.
 *
 * ## No state between frames, deliberately
 *
 * The write address comes from the sequence number, the length and CRC live in the slot
 * header in flash, and which slot is being written is recomputed from the two
 * generations every time. So there is no session to lose, no timeout to get wrong, and
 * no claim on the 1,536-byte `DATS` buffer, whose address on the donor build nobody has
 * re-derived (the stack top alone moved from `0x20003910` to `0x20003470`).
 *
 * ## What is *unverified* here
 *
 * Everything about the silicon. `research/tools/thumbsim.ts` executes these bytes
 * against a model of the FMC and `updater.test.ts` drives every path through it, which
 * is worth much more than "it assembles" and much less than "it ran". Specifically
 * unmeasured: whether a burst of page erases survives a live BLE connection (the
 * vendor's own OTA does the same thing, which is the evidence), and the magic-word
 * atomicity argument above.
 *
 * **The model has no interrupts, and that is the gap that matters here.** A lapsed
 * `REGLCTL` unlock is the one failure it cannot produce, because the abort condition is
 * another write landing between the three key writes and only an interrupt can do that.
 * `fmc_unlock` therefore reads the register back and retries, which is what the vendor
 * does, rather than relying on a test that cannot exist.
 *
 * **`CBS` does not gate this.** Track 59 settled it from the vendor's own OTA handoff,
 * which erases the config page and then programs four words into it while the page reads
 * `CBS = 11`: if the ISP engine consulted `CBS`, the vendor's commit path would fail on
 * its own second word. And a `CBS`-gated refusal could not have been silent anyway,
 * because `erase_page` reads the whole page back requiring all ones and `upd_begin`
 * answers `FMC_REFUSED` the moment `erase_span` fails.
 */
import { Asm } from './thumb.js'

/**
 * The FMC.
 *
 * Both values are *verified* against the bytes of the donor image and of the APK
 * container by `research/tools/fmcres.ts`, which resolves the whole register block by
 * content: `research/fmc-primitives-donor-2026-08-20.md`.
 *
 * *Corrected 2026-08-20: this cited "the vendor's own config writer at `abs 0x17a78`",
 * which is the APK build's address and lands inside the hardware-CRC helper on the
 * donor, where the config writer is at `0x17b88`. `FMC_WRPROT` had no cited source at
 * all, and the config writer could not have been it, because it never touches
 * `REGLCTL`. The two builds' helper blocks are also not a constant distance apart, +0xf4
 * for six helpers and +0x110 for two, so nothing here may be ported by arithmetic.*
 */
export const FMC_BASE = 0x5000c000
export const FMC_WRPROT = 0x50000100

/**
 * How many times to re-issue the `REGLCTL` key sequence before giving up.
 *
 * The vendor retries at 12 of the donor's 15 unlock sites. Bounded rather than
 * unbounded, because this runs inside an ATT callback.
 */
export const UNLOCK_TRIES = 4

export const FMC_OFF = { ISPCON: 0, ISPADR: 4, ISPDAT: 8, ISPCMD: 12, ISPTRG: 16 } as const

/** `ISPEN | APUEN | ISPFF`. `CFGUEN`, `LDUEN` and `SPUEN` stay clear. */
export const ISPCON_APROM = 0x49
/** Boot select. Read-modify-written rather than decided, as the vendor does. */
export const ISPCON_BS = 0x02
export const ISPCON_ISPFF = 0x40

export const CMD_PROGRAM = 0x21
export const CMD_PAGE_ERASE = 0x22

export const PAGE = 512

/**
 * Where the slots live: the OTA staging bank, outside the application region.
 *
 * Three consequences, all wanted. `swdflash` refuses every address outside
 * `0x16800`-`0x29400`, so the SWD tool structurally cannot write a slot and this code
 * structurally cannot write the resident block: the two delivery routes have disjoint
 * targets. The bank is scratch by design. And a vendor OTA staging over it costs us
 * both slots and leaves a unit that still answers `HELLO` and still takes an update.
 */
export const SLOT_A = 0x29400
export const SLOT_SIZE = 0x2000 //                 8 KB, 16 pages
export const SLOT_B = SLOT_A + SLOT_SIZE
export const SLOT_END = SLOT_B + SLOT_SIZE

/** `JGXS`, programmed last, and the only thing that makes a slot live. */
export const SLOT_MAGIC = 0x5358474a //            'J' 'G' 'X' 'S' little-endian

/** Slot header: magic, generation, body length, body CRC-32. The body is a JGX1 block. */
export const SLOT_HDR = { MAGIC: 0, GEN: 4, LEN: 8, CRC: 12 } as const
export const SLOT_HDR_LEN = 16

/** Bytes of slot body one `UPD_DATA` frame carries. Two words, so writes stay aligned. */
export const DATA_BYTES = 8

/** Largest body a slot can hold. */
export const MAX_BODY = SLOT_SIZE - SLOT_HDR_LEN

/**
 * Reply codes in an `UPD_*` notification.
 *
 * The first six are `packages/core/src/jgx.ts`'s `UPD`, which is the authority. `0x06`
 * is **not in jgx.ts yet** and needs adding there: it is the answer to an update that
 * would commit generation 0, which is reserved as "invalid" (section 8 of
 * `research/patch-over-bt-review-2026-08-20.md`). A client that does not know it reads
 * an unfamiliar number rather than mistaking it for `OK`.
 */
export const UPD = {
  OK: 0x00,
  BAD_LENGTH: 0x01,
  BAD_SEQ: 0x02,
  BAD_CRC: 0x03,
  FMC_REFUSED: 0x04,
  NO_SLOT: 0x05,
  EXHAUSTED: 0x06,
} as const

export interface UpdaterOptions {
  /** Where the extension block starts, so literals can be reached. */
  base: number
  /** `notify(r0 = length, r1 = pointer)` in the image this lands in. */
  notify: number
  /** Frame struct offset of wire byte `n`. */
  arg: (n: number) => number
  /** First byte of one of our notifications. */
  marker: number
  /** Notification type for an `UPD_*` reply. */
  replyType: number
}


/**
 * Emit every resident routine, into an `Asm` that already holds the JGX1 header.
 *
 * Labels the caller needs: `upd_begin`, `upd_data`, `upd_end`, `upd_abort`,
 * `upd_status` are the sub-command handlers, each `(r0 = frame struct) -> void`.
 */
export function emitUpdater(a: Asm, opts: UpdaterOptions): void {
  const { arg } = opts

  // --- reply --------------------------------------------------------------------
  // `reply(r0 = code)`: `[marker][type][code]`, built in a register and pushed.
  //
  // **On the stack, not in a buffer.** There is no writable RAM address this code can
  // name: the SRAM map in `notes/firmware-design.md` is the APK build's and the donor's
  // differs (the stack top alone moved from `0x20003910` to `0x20003470`). A word of
  // stack costs nothing, and the vendor's sender copies out of the pointer it is given.
  a.label('reply')
  a.push(['lr'])
  a.lsls('r0', 'r0', 16) //                      code into byte 2
  a.ldrPool('r1', 'reply_hdr') //                marker | type << 8
  a.orrs('r0', 'r1')
  a.push(['r0'])
  a.movs('r0', 3)
  a.mov('r1', 'sp')
  a.bl(opts.notify)
  a.pop(['r1']) //                               balance the payload word
  a.pop(['pc'])

  // --- fmc_unlock ---------------------------------------------------------------
  // `fmc_unlock() -> r0 = 0 if the register is open`. The three key writes must be
  // adjacent: "any different data value, different sequence or any other write to other
  // address during these three data writing will abort the whole sequence." Nothing may
  // come between them, which is why the address register is loaded first.
  //
  // **Read back and retry, because an interrupt is exactly the "other write".** The BLE
  // stack and TIMER0 are both interrupt-driven and the vendor's own staging writer at
  // `abs 0x1eabe` loops on the three writes until `REGLCTL` reads non-zero. The first
  // draft of this wrote the keys and moved on, which review 33 found
  // (`research/patch-over-bt-review-2026-08-20.md`, section 5): thumbsim models no
  // interrupts, so no test could reach it, and on silicon a locked register makes the
  // `ISPTRG` write a no-op that `ISPFF` may not report. The retry is bounded, and a
  // failure is returned rather than spun on: an unbounded loop inside an ATT callback
  // would sit there until the watchdog reset the part.
  a.label('fmc_unlock')
  a.push(['r4', 'lr'])
  a.movs('r4', UNLOCK_TRIES)
  a.label('unlock_try')
  a.ldrPool('r0', 'wrprot_addr')
  a.movs('r1', 0x59)
  a.str('r1', 'r0', 0)
  a.movs('r1', 0x16)
  a.str('r1', 'r0', 0)
  a.movs('r1', 0x88)
  a.str('r1', 'r0', 0)
  a.ldr('r1', 'r0', 0)
  a.cmp('r1', 0)
  a.bcond('ne', 'unlock_took')
  a.subs('r4', 1)
  a.bcond('ne', 'unlock_try')
  a.movs('r0', 1)
  a.pop(['r4', 'pc'])
  a.label('unlock_took')
  // `ISPCON` read-modify-write, preserving boot select rather than deciding it. Storing
  // the register wholesale is finding 3 of `research/fmc-erase-program.md`.
  a.ldrPool('r0', 'fmc_addr')
  a.ldr('r1', 'r0', FMC_OFF.ISPCON)
  a.movs('r2', ISPCON_BS)
  a.ands('r1', 'r2')
  a.movs('r2', ISPCON_APROM)
  a.orrs('r1', 'r2')
  a.str('r1', 'r0', FMC_OFF.ISPCON)
  a.movs('r0', 0)
  a.pop(['r4', 'pc'])

  // --- fmc_lock -----------------------------------------------------------------
  // On every exit path, success or not. An abort that left `ISPEN | APUEN` set with the
  // write protection open would leave the application running on writable flash.
  //
  // Read-modify-write, for the two reasons review 33 gives (section 6). Storing zero
  // over the whole register clears `BS`, which `fmc_unlock` fifteen lines above goes out
  // of its way to preserve, and it cannot clear `ISPFF`, which is write-one-to-clear, so
  // a command that set the fail flag left it set behind a lock.
  a.label('fmc_lock')
  a.ldrPool('r0', 'fmc_addr')
  a.ldr('r1', 'r0', FMC_OFF.ISPCON)
  a.movs('r2', ISPCON_BS)
  a.ands('r1', 'r2')
  a.movs('r2', ISPCON_ISPFF)
  a.orrs('r1', 'r2') //                          write one to clear it
  a.str('r1', 'r0', FMC_OFF.ISPCON)
  a.ldrPool('r0', 'wrprot_addr')
  a.movs('r1', 0)
  a.str('r1', 'r0', 0)
  a.bx('lr')

  // --- guard --------------------------------------------------------------------
  // `guard(r0 = addr) -> r0 = 0 if the address is inside the slot being written`.
  //
  // **The only thing between this updater and the whole of APROM.** `APUEN` enables the
  // entire array and no hardware bit distinguishes the application region from the BLE
  // stack below it, so the config page and the LDROM are refused by silicon and
  // everything else is refused here or not at all
  // (`research/swdflash-review-2026-08-20.md`). The resident block is deliberately
  // outside these bounds, so this code cannot rewrite itself even if asked to.
  //
  // **The bound is the target slot, not both slots.** It was `[SLOT_A, SLOT_END)` until
  // review 33 executed the consequence
  // (`research/patch-over-bt-review-2026-08-20.md`, section 2): with a length word
  // `UPD_BEGIN` never wrote, which is what `UPD_ABORT` and a freshly flashed unit both
  // leave, one `UPD_DATA` frame at sequence 1022 programs the **other** slot's magic,
  // and sequences up to 2045 clear all 8 KB of it. That is the live slot on every unit
  // that has taken two updates, and the invariant this whole design is sold on is that
  // the live slot is untouched from beginning to end.
  //
  // The target is recomputed here rather than passed in, so there is still exactly one
  // call site for `ISPADR` and exactly one guard on it. It is stable for the whole of an
  // update: `UPD_BEGIN` erases the target's header and programs its generation but never
  // its magic, so the target stays invalid, so it stays the target, until `UPD_END`
  // programs the magic as the last word of all.
  a.label('guard')
  a.push(['r4', 'lr'])
  a.mov('r4', 'r0')
  a.bl('target_slot')
  a.cmpReg('r4', 'r0')
  a.bcond('lo', 'guard_bad')
  a.ldrPool('r1', 'slot_size')
  a.addsReg('r0', 'r0', 'r1')
  a.cmpReg('r4', 'r0')
  a.bcond('hs', 'guard_bad')
  a.movs('r0', 0)
  a.pop(['r4', 'pc'])
  a.label('guard_bad')
  a.movs('r0', 1)
  a.pop(['r4', 'pc'])

  // --- fmc_op -------------------------------------------------------------------
  // `fmc_op(r0 = cmd, r1 = addr, r2 = data) -> r0 = 0 if ISPFF stayed clear`.
  //
  // **The one call site that reaches `ISPADR`, and the guard is on it.** Word alignment
  // is checked here too: a misaligned erase address is not an error on this FMC, it
  // silently erases the page that contains it (`research/fmc-erase-program.md`,
  // finding 6), so an arithmetic slip would erase a neighbour rather than fail.
  // The store order here is ADR, DAT, CMD, TRG, which matches no witnessed vendor
  // sequence (the vendor writes `ISPCMD` first) and is free either way: only "`ISPTRG`
  // last" is documented as required. `ISPDAT` is written even for a page erase, which
  // the vendor never does and the engine ignores. Both noted by track 59 rather than
  // changed, because changing them would be a change with no evidence behind it.
  a.label('fmc_op')
  a.push(['r4', 'r5', 'r6', 'lr'])
  a.mov('r4', 'r0')
  a.mov('r5', 'r1')
  a.mov('r6', 'r2')
  a.mov('r0', 'r5')
  a.bl('guard')
  a.cmp('r0', 0)
  a.bcond('ne', 'fmc_op_bad')
  a.movs('r0', 3)
  a.ands('r0', 'r5')
  a.bcond('ne', 'fmc_op_bad')
  a.ldrPool('r0', 'fmc_addr')
  a.str('r5', 'r0', FMC_OFF.ISPADR)
  a.str('r6', 'r0', FMC_OFF.ISPDAT)
  a.str('r4', 'r0', FMC_OFF.ISPCMD)
  a.movs('r1', 1)
  a.str('r1', 'r0', FMC_OFF.ISPTRG)
  a.label('fmc_wait')
  a.ldr('r1', 'r0', FMC_OFF.ISPTRG)
  a.lsls('r1', 'r1', 31)
  a.bcond('ne', 'fmc_wait')
  // `ISPFF` is the only fail flag this FMC generation has and it reports pre-flight
  // refusals only: no verify flag, no blank check, no busy bit distinct from `ISPGO`
  // (`research/numicro-fmc-upstream.md`). Read-back is the real check and the two
  // callers below both do it.
  a.ldr('r0', 'r0', FMC_OFF.ISPCON)
  a.movs('r1', ISPCON_ISPFF)
  a.ands('r0', 'r1')
  a.pop(['r4', 'r5', 'r6', 'pc'])
  a.label('fmc_op_bad')
  a.movs('r0', 1)
  a.pop(['r4', 'r5', 'r6', 'pc'])

  // --- program_word -------------------------------------------------------------
  // `program_word(r0 = addr, r1 = value) -> r0 = 0 if it read back`.
  //
  // Program and verify are one operation with one call site, because on this part
  // software read-back is the only way to know a program took at all.
  a.label('program_word')
  a.push(['r4', 'r5', 'lr'])
  a.mov('r4', 'r0')
  a.mov('r5', 'r1')
  a.movs('r0', CMD_PROGRAM)
  a.mov('r1', 'r4')
  a.mov('r2', 'r5')
  a.bl('fmc_op')
  a.cmp('r0', 0)
  a.bcond('ne', 'program_bad')
  a.ldr('r0', 'r4', 0)
  a.cmpReg('r0', 'r5')
  a.bcond('ne', 'program_bad')
  a.movs('r0', 0)
  a.pop(['r4', 'r5', 'pc'])
  a.label('program_bad')
  a.movs('r0', 1)
  a.pop(['r4', 'r5', 'pc'])

  // --- erase_page ---------------------------------------------------------------
  // `erase_page(r0 = page addr) -> r0 = 0 if the whole page reads back erased`.
  //
  // Reading the page back is not belt and braces: an erase that did nothing sets no
  // flag, and this is also what would notice a granularity larger than one page.
  a.label('erase_page')
  a.push(['r4', 'r5', 'lr'])
  a.mov('r4', 'r0')
  // Page alignment, asserted here rather than trusted: a misaligned erase address is
  // not an error on this FMC, it silently erases the page that contains it, so an
  // arithmetic slip would take out a neighbour. `fmc_op` checks word alignment, which
  // this is 128 times stricter than; `swdflash` has asserted both since track 54 and
  // track 59 pointed out that this half was missing. A shift rather than a mask,
  // because 511 does not fit in a `movs` immediate: the low nine bits end up in the top
  // nine, and the flags say whether they were all zero.
  a.lsls('r0', 'r4', 32 - 9)
  a.bcond('ne', 'erase_bad')
  a.movs('r0', CMD_PAGE_ERASE)
  a.mov('r1', 'r4')
  a.movs('r2', 0)
  a.bl('fmc_op')
  a.cmp('r0', 0)
  a.bcond('ne', 'erase_bad')
  a.movs('r5', 0)
  a.label('erase_check')
  a.ldrReg('r0', 'r4', 'r5')
  a.mvns('r0', 'r0') //                          zero exactly when the word was all ones
  a.bcond('ne', 'erase_bad')
  a.adds('r5', 4)
  a.ldrPool('r0', 'page_size')
  a.cmpReg('r5', 'r0')
  a.bcond('lo', 'erase_check')
  a.movs('r0', 0)
  a.pop(['r4', 'r5', 'pc'])
  a.label('erase_bad')
  a.movs('r0', 1)
  a.pop(['r4', 'r5', 'pc'])

  // --- erase_span ---------------------------------------------------------------
  // `erase_span(r0 = base, r1 = bytes) -> r0 = 0 if every page erased`.
  //
  // A subroutine rather than a loop inside `upd_begin`, so its error path unwinds its
  // own registers. The first draft did it inline and left the stack unbalanced on the
  // way out, which would have popped a return address that was a saved register.
  a.label('erase_span')
  a.push(['r4', 'r5', 'r6', 'lr'])
  a.mov('r4', 'r0')
  a.mov('r5', 'r1')
  a.movs('r6', 0)
  a.label('erase_span_loop')
  a.addsReg('r0', 'r4', 'r6')
  a.bl('erase_page')
  a.cmp('r0', 0)
  a.bcond('ne', 'erase_span_bad')
  a.ldrPool('r0', 'page_size')
  a.addsReg('r6', 'r6', 'r0')
  a.cmpReg('r6', 'r5')
  a.bcond('lo', 'erase_span_loop')
  a.movs('r0', 0)
  a.pop(['r4', 'r5', 'r6', 'pc'])
  a.label('erase_span_bad')
  a.movs('r0', 1)
  a.pop(['r4', 'r5', 'r6', 'pc'])

  // --- crc32 --------------------------------------------------------------------
  // `crc32(r0 = addr, r1 = length) -> r0`. Reflected CRC-32, polynomial `0xEDB88320`,
  // which is `ota.crc32`'s, so the phone can compute the value the device will find.
  //
  // Ours rather than the FMC's hardware CRC (`ISPCMD 0x2d`, driven by the vendor at
  // `abs 0x17958`): that would be free, but nobody has measured its polynomial on this
  // part, so the phone could not produce a matching value without a session on silicon.
  // Bitwise costs about 15 ms over 8 KB at 26 MHz, which nothing here is racing.
  a.label('crc32')
  a.push(['r4', 'r5', 'r6', 'r7', 'lr'])
  a.mov('r4', 'r0')
  a.addsReg('r5', 'r4', 'r1')
  a.ldrPool('r6', 'crc_init')
  a.ldrPool('r7', 'crc_poly')
  a.label('crc_byte')
  a.cmpReg('r4', 'r5')
  a.bcond('hs', 'crc_done')
  a.ldrb('r0', 'r4', 0)
  a.adds('r4', 1)
  a.eors('r6', 'r0')
  a.movs('r1', 8)
  a.label('crc_bit')
  a.movs('r0', 1)
  a.ands('r0', 'r6')
  a.lsrs('r6', 'r6', 1)
  a.cmp('r0', 0)
  a.bcond('eq', 'crc_nopoly')
  a.eors('r6', 'r7')
  a.label('crc_nopoly')
  a.subs('r1', 1)
  a.bcond('ne', 'crc_bit')
  a.b('crc_byte')
  a.label('crc_done')
  a.ldrPool('r0', 'crc_init')
  a.eors('r6', 'r0')
  a.mov('r0', 'r6')
  a.pop(['r4', 'r5', 'r6', 'r7', 'pc'])

  // --- which slot ---------------------------------------------------------------
  // `slot_gen(r0 = base) -> r0 = generation, or 0 when the slot does not validate`.
  //
  // Generation 0 is reserved and never written, so "invalid" and "older than anything"
  // are the same answer and there is no second return value to get wrong.
  a.label('slot_gen')
  a.push(['r4', 'lr'])
  a.mov('r4', 'r0')
  a.ldr('r0', 'r4', SLOT_HDR.MAGIC)
  a.ldrPool('r1', 'slot_magic')
  a.cmpReg('r0', 'r1')
  a.bcond('ne', 'slot_gen_none')
  a.ldr('r0', 'r4', SLOT_HDR.GEN)
  a.pop(['r4', 'pc'])
  a.label('slot_gen_none')
  a.movs('r0', 0)
  a.pop(['r4', 'pc'])

  // `live_slot() -> r0 = base or 0, r1 = its generation`. Equal generations, which
  // should not happen, take the lower address: deterministic, and `upd_status` reports
  // both so it is visible rather than hidden.
  a.label('live_slot')
  a.push(['r4', 'r5', 'r6', 'lr'])
  a.ldrPool('r4', 'slot_a_addr')
  a.mov('r0', 'r4')
  a.bl('slot_gen')
  a.mov('r5', 'r0')
  a.ldrPool('r6', 'slot_b_addr')
  a.mov('r0', 'r6')
  a.bl('slot_gen')
  a.cmpReg('r0', 'r5')
  a.bcond('hi', 'live_is_b')
  a.cmp('r5', 0)
  a.bcond('eq', 'live_none')
  a.mov('r0', 'r4')
  a.mov('r1', 'r5')
  a.pop(['r4', 'r5', 'r6', 'pc'])
  a.label('live_is_b')
  a.mov('r1', 'r0')
  a.mov('r0', 'r6')
  a.pop(['r4', 'r5', 'r6', 'pc'])
  a.label('live_none')
  a.movs('r0', 0)
  a.movs('r1', 0)
  a.pop(['r4', 'r5', 'r6', 'pc'])

  // `target_slot() -> r0 = base to write, r1 = the generation to give it`. The one that
  // is not live, which with nothing live at all is A.
  a.label('target_slot')
  a.push(['r4', 'lr'])
  a.bl('live_slot')
  a.adds('r1', 1)
  a.ldrPool('r4', 'slot_a_addr')
  a.cmp('r0', 0)
  a.bcond('eq', 'target_is_a')
  a.cmpReg('r0', 'r4')
  a.bcond('eq', 'target_is_b')
  a.label('target_is_a')
  a.mov('r0', 'r4')
  a.pop(['r4', 'pc'])
  a.label('target_is_b')
  a.ldrPool('r0', 'slot_b_addr')
  a.pop(['r4', 'pc'])

  // --- UPD_BEGIN ----------------------------------------------------------------
  // `[J][0x01][lenLo][lenHi][crc0][crc1][crc2][crc3]`
  //
  // Erases the target slot's pages and programs generation, length and CRC. **Not the
  // magic**, which `upd_end` writes only once the body has been read back and its CRC
  // agrees. So an update that stops anywhere before that leaves a slot which fails
  // validation, and the live slot is untouched from beginning to end.
  a.label('upd_begin')
  a.push(['r4', 'r5', 'r6', 'r7', 'lr'])
  a.mov('r7', 'r0')
  // Length, u16 little-endian, by byte loads: nothing guarantees the frame struct is
  // word-aligned and an unaligned word load faults on a Cortex-M0.
  a.ldrb('r5', 'r7', arg(3))
  a.ldrb('r0', 'r7', arg(4))
  a.lsls('r0', 'r0', 8)
  a.orrs('r5', 'r0')
  a.cmp('r5', 0)
  a.bcond('eq', 'begin_bad_len')
  a.ldrPool('r0', 'max_body')
  a.cmpReg('r5', 'r0')
  a.bcond('hi', 'begin_bad_len')
  a.bl('target_slot')
  a.mov('r4', 'r0')
  a.mov('r6', 'r1')
  // Generation 0 is reserved as "invalid", so committing one would be a slot that
  // answers `OK` and then never validates, with every later update repeating it and the
  // unit permanently un-updatable while replying `OK` to everything. It takes 2^32
  // updates to reach and the cross-slot write review 33 found can only lower a
  // generation, never raise one, so this is a shape being closed rather than a
  // reachable state: `research/patch-over-bt-review-2026-08-20.md`, section 8.
  a.cmp('r6', 0)
  a.bcond('eq', 'begin_exhausted')
  a.bl('fmc_unlock')
  a.cmp('r0', 0)
  a.bcond('ne', 'begin_fmc_bad')
  a.mov('r1', 'r5')
  a.ldrPool('r0', 'page_round') //               SLOT_HDR_LEN + PAGE - 1, one literal
  a.addsReg('r1', 'r1', 'r0')
  a.ldrPool('r0', 'page_mask')
  a.ands('r1', 'r0')
  a.mov('r0', 'r4')
  a.bl('erase_span')
  a.cmp('r0', 0)
  a.bcond('ne', 'begin_fmc_bad')
  a.mov('r0', 'r4')
  a.adds('r0', SLOT_HDR.GEN)
  a.mov('r1', 'r6')
  a.bl('program_word')
  a.cmp('r0', 0)
  a.bcond('ne', 'begin_fmc_bad')
  a.mov('r0', 'r4')
  a.adds('r0', SLOT_HDR.LEN)
  a.mov('r1', 'r5')
  a.bl('program_word')
  a.cmp('r0', 0)
  a.bcond('ne', 'begin_fmc_bad')
  a.mov('r0', 'r7')
  a.adds('r0', arg(5))
  a.bl('load32le')
  a.mov('r1', 'r0')
  a.mov('r0', 'r4')
  a.adds('r0', SLOT_HDR.CRC)
  a.bl('program_word')
  a.cmp('r0', 0)
  a.bcond('ne', 'begin_fmc_bad')
  a.movs('r0', UPD.OK)
  a.b('begin_reply')
  a.label('begin_bad_len')
  a.movs('r0', UPD.BAD_LENGTH)
  a.b('begin_reply')
  a.label('begin_exhausted')
  a.movs('r0', UPD.EXHAUSTED)
  a.b('begin_reply')
  a.label('begin_fmc_bad')
  a.movs('r0', UPD.FMC_REFUSED)
  a.label('begin_reply')
  a.push(['r0'])
  a.bl('fmc_lock')
  a.pop(['r0'])
  a.bl('reply')
  a.pop(['r4', 'r5', 'r6', 'r7', 'pc'])

  // --- UPD_DATA -----------------------------------------------------------------
  // `[J][0x02][seqLo][seqHi][d0..d7]`
  //
  // The write address comes from the sequence number and nothing else, so a frame is
  // idempotent and there is no session to lose. The declared length bounds it before
  // the guard is ever consulted, so a slot cannot be written past what `upd_begin` said.
  a.label('upd_data')
  a.push(['r4', 'r5', 'r6', 'r7', 'lr'])
  a.mov('r7', 'r0')
  a.bl('target_slot')
  a.mov('r4', 'r0')
  a.ldrb('r5', 'r7', arg(3))
  a.ldrb('r0', 'r7', arg(4))
  a.lsls('r0', 'r0', 8)
  a.orrs('r5', 'r0')
  a.lsls('r6', 'r5', 3) //                       seq * 8. A shift, because 8 is a power of two
  a.ldr('r0', 'r4', SLOT_HDR.LEN)
  // **The declared length is a word out of flash and it is not trustworthy.** Two
  // ordinary states leave one `UPD_BEGIN` never wrote: `UPD_ABORT`, whose whole job is
  // to erase the header, and a unit whose staging bank still holds whatever was staged
  // before. On unit 1 that word reads `0x20003910`, so every sequence number up to 2045
  // passed this check and reached the other slot. Bounded against `MAX_BODY` here as
  // well as by the guard on the write itself, which is now the target slot rather than
  // both: `research/patch-over-bt-review-2026-08-20.md`, section 2.
  a.ldrPool('r1', 'max_body')
  a.cmpReg('r0', 'r1')
  a.bcond('hi', 'data_bad_seq')
  a.cmpReg('r6', 'r0')
  a.bcond('hs', 'data_bad_seq')
  a.mov('r0', 'r4')
  a.adds('r0', SLOT_HDR_LEN)
  a.addsReg('r6', 'r6', 'r0')
  a.bl('fmc_unlock')
  a.cmp('r0', 0)
  a.bcond('ne', 'data_fmc_bad')
  a.movs('r5', 0)
  a.label('data_word')
  a.mov('r0', 'r7')
  a.adds('r0', arg(5))
  a.addsReg('r0', 'r0', 'r5')
  a.bl('load32le')
  a.mov('r1', 'r0')
  a.mov('r0', 'r6')
  a.addsReg('r0', 'r0', 'r5')
  a.bl('program_word')
  a.cmp('r0', 0)
  a.bcond('ne', 'data_fmc_bad')
  a.adds('r5', 4)
  a.cmp('r5', DATA_BYTES)
  a.bcond('lo', 'data_word')
  a.movs('r0', UPD.OK)
  a.b('data_reply')
  a.label('data_bad_seq')
  a.movs('r0', UPD.BAD_SEQ)
  a.b('data_reply')
  a.label('data_fmc_bad')
  a.movs('r0', UPD.FMC_REFUSED)
  a.label('data_reply')
  a.push(['r0'])
  a.bl('fmc_lock')
  a.pop(['r0'])
  a.bl('reply')
  a.pop(['r4', 'r5', 'r6', 'r7', 'pc'])

  // --- UPD_END ------------------------------------------------------------------
  // `[J][0x03]`
  //
  // **The commit, and the only thing in the file that can make a slot live.** CRC the
  // body, compare with what `upd_begin` recorded, and only then program the magic.
  a.label('upd_end')
  a.push(['r4', 'r5', 'lr'])
  a.bl('target_slot')
  a.mov('r4', 'r0')
  a.ldr('r5', 'r4', SLOT_HDR.LEN)
  a.cmp('r5', 0)
  a.bcond('eq', 'end_bad_crc')
  // An erased header reads 0xffffffff, which is not zero. Without this the CRC would
  // walk four gigabytes from the slot base.
  a.ldrPool('r0', 'max_body')
  a.cmpReg('r5', 'r0')
  a.bcond('hi', 'end_bad_crc')
  a.mov('r0', 'r4')
  a.adds('r0', SLOT_HDR_LEN)
  a.mov('r1', 'r5')
  a.bl('crc32')
  a.ldr('r1', 'r4', SLOT_HDR.CRC)
  a.cmpReg('r0', 'r1')
  a.bcond('ne', 'end_bad_crc')
  a.bl('fmc_unlock')
  a.cmp('r0', 0)
  a.bcond('ne', 'end_locked')
  a.mov('r0', 'r4')
  a.ldrPool('r1', 'slot_magic')
  a.bl('program_word')
  a.push(['r0'])
  a.bl('fmc_lock')
  a.pop(['r0'])
  a.cmp('r0', 0)
  a.bcond('ne', 'end_fmc_bad')
  a.movs('r0', UPD.OK)
  a.b('end_reply')
  a.label('end_bad_crc')
  a.movs('r0', UPD.BAD_CRC)
  a.b('end_reply')
  a.label('end_locked')
  // The unlock never took, so nothing was written and nothing needs locking. Kept as
  // its own label rather than folded into `end_fmc_bad`, because that path has already
  // called `fmc_lock` and calling it twice would be harmless but would read as if the
  // two states were the same one.
  a.bl('fmc_lock')
  a.label('end_fmc_bad')
  a.movs('r0', UPD.FMC_REFUSED)
  a.label('end_reply')
  a.bl('reply')
  a.pop(['r4', 'r5', 'pc'])

  // --- UPD_ABORT ----------------------------------------------------------------
  // Erase the target slot's first page, so its header can never validate. One page,
  // because the magic is in it and the magic is what makes a slot live.
  a.label('upd_abort')
  a.push(['r4', 'lr'])
  a.bl('target_slot')
  a.mov('r4', 'r0')
  a.bl('fmc_unlock')
  a.cmp('r0', 0)
  a.bcond('ne', 'abort_locked')
  a.mov('r0', 'r4')
  a.bl('erase_page')
  a.push(['r0'])
  a.bl('fmc_lock')
  a.pop(['r0'])
  a.cmp('r0', 0)
  a.bcond('eq', 'abort_ok')
  a.label('abort_locked')
  a.movs('r0', UPD.FMC_REFUSED)
  a.b('abort_reply')
  a.label('abort_ok')
  a.movs('r0', UPD.OK)
  a.label('abort_reply')
  a.bl('reply')
  a.pop(['r4', 'pc'])

  // --- UPD_STATUS ---------------------------------------------------------------
  // `[marker][type][code][liveSlot][genLo][genHi][targetSlot]`, seven payload bytes.
  //
  // **Both slots are named, because the difference between them is where an inversion
  // used to live.** `notes/patch-over-bt.md` says this command "tells the phone which
  // slot it is about to write", and until review 33 it reported the **live** slot, which
  // is the other one. The inversion is right in every case but the first update of every
  // unit, where nothing is live and the target is A, and a client that inverted the
  // boolean built its slot for B. Slot code is position-dependent and a slot built for
  // the wrong base has a valid CRC and a valid magic, so that is the one failure this
  // design cannot catch, reached through the one command every unit runs first:
  // `research/patch-over-bt-review-2026-08-20.md`, section 4.
  //
  // The byte is appended rather than replacing anything, so a client that only knows the
  // six-byte reply reads exactly what it read before.
  a.label('upd_status')
  a.push(['r4', 'r5', 'r6', 'lr'])
  a.bl('live_slot')
  a.mov('r4', 'r0')
  a.mov('r5', 'r1')
  a.bl('target_slot')
  a.mov('r6', 'r0')
  // Second payload word first, so the two pushes leave them in address order.
  a.ldrPool('r0', 'slot_b_addr')
  a.cmpReg('r6', 'r0')
  a.bcond('eq', 'status_target_b')
  a.movs('r0', 0)
  a.b('status_target')
  a.label('status_target_b')
  a.movs('r0', 1)
  a.label('status_target')
  a.lsls('r0', 'r0', 16) //                      targetSlot into byte 2 of word 2
  a.movs('r1', 0xff)
  a.ands('r1', 'r5')
  a.orrs('r0', 'r1') //                          gen low byte
  a.lsrs('r1', 'r5', 8)
  a.movs('r2', 0xff)
  a.ands('r1', 'r2')
  a.lsls('r1', 'r1', 8) //                       gen high byte
  a.orrs('r0', 'r1')
  a.push(['r0'])
  a.ldrPool('r0', 'slot_b_addr')
  a.cmpReg('r4', 'r0')
  a.bcond('eq', 'status_is_b')
  a.movs('r0', 0)
  a.b('status_code')
  a.label('status_is_b')
  a.movs('r0', 1)
  a.label('status_code')
  a.lsls('r0', 'r0', 24) //                      liveSlot into byte 3
  a.cmp('r4', 0)
  a.bcond('ne', 'status_have')
  a.movs('r1', UPD.NO_SLOT)
  a.b('status_word')
  a.label('status_have')
  a.movs('r1', UPD.OK)
  a.label('status_word')
  a.lsls('r1', 'r1', 16)
  a.orrs('r0', 'r1')
  a.ldrPool('r1', 'reply_hdr')
  a.orrs('r0', 'r1')
  a.push(['r0'])
  a.movs('r0', 7)
  a.mov('r1', 'sp')
  a.bl(opts.notify)
  a.pop(['r0'])
  a.pop(['r1'])
  a.pop(['r4', 'r5', 'r6', 'pc'])

  // --- load32le -----------------------------------------------------------------
  // `load32le(r0 = ptr) -> r0`. Byte loads, because the frame struct's alignment is not
  // ours to assume and an unaligned word load faults on this core.
  a.label('load32le')
  a.push(['r4', 'lr'])
  a.mov('r4', 'r0')
  a.ldrb('r0', 'r4', 0)
  a.ldrb('r1', 'r4', 1)
  a.lsls('r1', 'r1', 8)
  a.orrs('r0', 'r1')
  a.ldrb('r1', 'r4', 2)
  a.lsls('r1', 'r1', 16)
  a.orrs('r0', 'r1')
  a.ldrb('r1', 'r4', 3)
  a.lsls('r1', 'r1', 24)
  a.orrs('r0', 'r1')
  a.pop(['r4', 'pc'])

  // --- literals -----------------------------------------------------------------
  a.align(4)
  a.label('fmc_addr').word(FMC_BASE)
  a.label('wrprot_addr').word(FMC_WRPROT)
  a.label('slot_a_addr').word(SLOT_A)
  a.label('slot_b_addr').word(SLOT_B)
  a.label('slot_size').word(SLOT_SIZE)
  a.label('slot_magic').word(SLOT_MAGIC)
  a.label('page_size').word(PAGE)
  a.label('page_mask').word((~(PAGE - 1)) >>> 0)
  a.label('page_round').word(SLOT_HDR_LEN + PAGE - 1)
  a.label('max_body').word(MAX_BODY)
  a.label('crc_init').word(0xffffffff)
  a.label('crc_poly').word(0xedb88320)
  a.label('reply_hdr').word(opts.marker | (opts.replyType << 8))
}
