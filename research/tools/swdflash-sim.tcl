# A simulated PAN1020 FMC, so a generated flash script can be run before it is run.
#
#   tclsh research/tools/swdflash-sim.tcl <script.tcl> [flags]
#
#     --preload <dump.bin>   256 KB image the simulated flash starts from
#     --config0 <hex>        word at 0x00300000. Default 0xffffffff
#     --out <after.bin>      write the simulated flash out afterwards, pass or fail
#     --erase-block <bytes>  what one ISPCMD 0x22 actually erases. Default 512
#     --busy <n>             leave ISPTRG set for n polls after every trigger
#     --reset-at <n>         the core resets after n erases: S_RESET_ST sets, S_HALT
#                            clears, which is what a watchdog or a brown-out reboot
#                            would look like to the script
#     --set NAME=VALUE       define a TCL variable, e.g. JOGGLES_FLASH_CONFIRM
#     --quiet                suppress the script's own echo output
#
# THERE IS NO HARDWARE ANYWHERE IN THIS FILE. It stubs out OpenOCD's `mww`,
# `read_memory`, `init`, `halt`, `adapter` and `shutdown` and models the flash array
# and the ISP engine in TCL, so the script under test runs to completion against
# something that behaves like the part. It is what lets `swdflash.ts` be tested with
# no probe attached, and it is worth running by hand before a real session: a script
# that fails here has no business being pointed at a device.
#
# **`--erase-block` is the reason to run this more than once.** The 512-byte page is
# *derived* and has never been measured on this part, so the default models the
# assumption and every other value models the assumption being wrong. A script that only
# passes at 512 is a script that is trusting a fact nobody has established:
#
#   tclsh swdflash-sim.tcl <script> --preload before.bin --erase-block 4096 ...
#
# must stop the run, and stop it early. `swdflash.test.ts` asserts exactly that for
# 1 KB, 2 KB, 4 KB, 8 KB, 16 KB and 32 KB. The 1 KB and 2 KB cases are the interesting
# ones: `WINDOW.start` is 2 KB aligned, so nothing outside the window moves and every
# canary reads what it read before. Only a read-back of a page already written can see
# them.
#
# The model is deliberately harsher than the silicon in three places, because those
# are the mistakes worth catching:
#
#   - **A program only clears bits.** `new = old & word`, which is what flash does.
#     So programming a page that was not erased produces wrong data here exactly as
#     it would on the device, and the script's own read-back catches it.
#   - **Update-enable bits are enforced.** An erase or program aimed at the config
#     page with CFGUEN clear, or the LDROM with LDUEN clear, sets ISPFF and changes
#     nothing, which is what the hardware does and what the whole safety argument
#     rests on.
#   - **ISPCMD 0x23 aborts the simulation.** Whole-chip erase is not modelled and
#     never will be. If a script ever issues it, this file stops and says so rather
#     than quietly showing you an erased array. It watched 0x26 until 2026-08-20,
#     which is not a command on this part: research/fmc-erase-program.md. Anything
#     outside the valid set now sets ISPFF, which is what the hardware does.
#
# What it does NOT model, and this list is the honest measure of what a passing run is
# worth. It is the author's model of the part, not the part:
#
#   - **Timing.** `sleep` is a no-op, so `wait_trg`'s 2-second ceiling is never real
#     time. `--busy` exercises the loop's shape, not its duration.
#   - **The AHB stalling while the ISP engine is busy**, which is the documented reason
#     the poll exists at all (`research/hardware-access.md`, "Poll ISPTRG after every
#     trigger"). Here a read during a busy engine just works.
#   - **Brown-out, the watchdog, a dropped SWD link.** `--reset-at` fakes the DHCSR
#     bits a reset would leave, which is the only part of it the script can see; it
#     does not model the application then running, writing flash, or re-muxing the
#     debug pins away from ICE. Everything else here is a failure the script chose.
#   - **Whether the part accepts these opcodes at all with `APUEN` set.** `APUEN` has
#     never been set on this silicon. This file asserts the Nuvoton meaning of bit 3
#     because that is the only meaning anyone has; if bit 3 is something else on a
#     Panchip die, this model and the tool are wrong together and in the same way.
#   - **Whether `CFGUEN` and `LDUEN` clear really do refuse a write.** That refusal is
#     the second of the tool's five safety layers and it is modelled here from the same
#     datasheet reading that the tool relies on. It has never been observed: the config
#     repair set `CFGUEN` because it wanted the config page, and `fmc-ladder1.sh` only
#     read. A test here that a refusal happens is a test that this file refuses.
#   - **Read paths.** `read_memory` always returns the array, so a prefetch buffer, a
#     stale AHB read after a program, or a read-locked part returning 0xff are all
#     outside the model.
#   - **The unlock keys and the re-lock.** Modelled as a three-step state machine from
#     Nuvoton's documentation. The unlock is *verified* on this part; the re-lock is not.
#
# Passing here says the script is correct against this model. It does not say the model
# is the silicon, and where the two could differ is the list above.

set ::VERBOSE 1
set ::SCRIPT ""
set ::PRELOAD ""
set ::OUTFILE ""
set ::CONFIG0 0xffffffff
# What one ISPCMD 0x22 really erases. 512 is the *derived* page size the tool assumes;
# any other value is that assumption being wrong, which is the case worth simulating.
set ::ERASE_BLOCK 512
# How many polls ISPTRG stays set after a trigger, so wait_trg's loop is exercised.
set ::BUSY 0
# After this many erases the core resets: S_HALT clears and S_RESET_ST sets. -1 never.
set ::RESET_AT -1
# DHCSR as a halted core reads it: C_DEBUGEN, C_HALT, S_REGRDY, S_HALT.
set ::DHCSR 0x00030003

# --- argument parsing ---------------------------------------------------------------

set argi 0
while {$argi < [llength $argv]} {
    set a [lindex $argv $argi]
    switch -- $a {
        --preload { incr argi; set ::PRELOAD [lindex $argv $argi] }
        --out     { incr argi; set ::OUTFILE [lindex $argv $argi] }
        --config0 { incr argi; set ::CONFIG0 [lindex $argv $argi] }
        --erase-block { incr argi; set ::ERASE_BLOCK [expr {[lindex $argv $argi]}] }
        --busy    { incr argi; set ::BUSY [expr {[lindex $argv $argi]}] }
        --reset-at { incr argi; set ::RESET_AT [expr {[lindex $argv $argi]}] }
        --quiet   { set ::VERBOSE 0 }
        --set {
            incr argi
            set kv [lindex $argv $argi]
            set eq [string first "=" $kv]
            set name [string range $kv 0 [expr {$eq - 1}]]
            set ::$name [string range $kv [expr {$eq + 1}] end]
        }
        default {
            if {$::SCRIPT eq ""} { set ::SCRIPT $a } else {
                puts stderr "unexpected argument $a"
                exit 2
            }
        }
    }
    incr argi
}
if {$::SCRIPT eq ""} {
    puts stderr "usage: tclsh swdflash-sim.tcl <script.tcl> \[flags\]"
    puts stderr "  --preload dump.bin  --out after.bin  --config0 hex"
    puts stderr "  --erase-block bytes --busy n"
    puts stderr "  --set NAME=VALUE    --quiet"
    exit 2
}

# --- the flash array -----------------------------------------------------------------

set ::FLASH_WORDS 65536
set ::FLASH [list]
if {$::PRELOAD ne ""} {
    set fh [open $::PRELOAD rb]
    fconfigure $fh -translation binary
    set blob [read $fh]
    close $fh
    binary scan $blob iu* ::FLASH
    while {[llength $::FLASH] < $::FLASH_WORDS} { lappend ::FLASH 4294967295 }
} else {
    for {set i 0} {$i < $::FLASH_WORDS} {incr i} { lappend ::FLASH 4294967295 }
}

# The config page is a separate aperture and no 0x0-0x40000 dump contains it.
set ::CONFIG [list]
for {set i 0} {$i < 128} {incr i} { lappend ::CONFIG 4294967295 }
lset ::CONFIG 0 [expr {$::CONFIG0 & 0xffffffff}]

# --- what the run is judged on -------------------------------------------------------

set ::STAT(erases) 0
set ::STAT(programs) 0
set ::STAT(reads) 0
set ::STAT(lowest) -1
set ::STAT(highest) -1
set ::STAT(violations) [list]
set ::STAT(ispff) 0
# Every word the run erased or programmed, so an over-erase can be reported as what it
# is rather than only as the read-back that noticed it.
set ::STAT(lostbelow) 0
set ::STAT(lostabove) 0
set ::WINDOW_LO 0x00016800
set ::WINDOW_HI 0x00029400

proc violation {msg} {
    lappend ::STAT(violations) $msg
    puts stderr "SIMULATOR VIOLATION: $msg"
}

proc touched {addr} {
    if {$::STAT(lowest) < 0 || $addr < $::STAT(lowest)} { set ::STAT(lowest) $addr }
    if {$addr > $::STAT(highest)} { set ::STAT(highest) $addr }
}

# --- address decode ------------------------------------------------------------------

# Returns a two-element list {space index}. The LDROM aperture at 0x00100000 is an
# alias of 0x0003dc00 in the main array, *verified* 2026-08-19, so it decodes there.
proc decode {addr} {
    set a [expr {$addr & 0xffffffff}]
    if {$a >= 0x00300000 && $a < 0x00300200} {
        return [list config [expr {($a - 0x00300000) / 4}]]
    }
    if {$a >= 0x00100000 && $a < 0x00102400} {
        return [list flash [expr {(($a - 0x00100000) + 0x0003dc00) / 4}]]
    }
    if {$a < 0x00040000} { return [list flash [expr {$a / 4}]] }
    return [list none 0]
}

proc peek {addr} {
    lassign [decode $addr] space idx
    switch -- $space {
        flash  { return [lindex $::FLASH $idx] }
        config { return [lindex $::CONFIG $idx] }
        default { return 4294967295 }
    }
}

proc poke {addr value} {
    lassign [decode $addr] space idx
    switch -- $space {
        flash  { lset ::FLASH $idx [expr {$value & 0xffffffff}] }
        config { lset ::CONFIG $idx [expr {$value & 0xffffffff}] }
        default { violation "write to unmapped [format 0x%08x $addr]" }
    }
}

# Which update-enable bit does this address need? ISPCON bit 3 APUEN, 4 CFGUEN,
# 5 LDUEN. The LDROM lives at 0x3dc00 in the array and needs LDUEN, not APUEN.
proc enable_bit_for {addr} {
    set a [expr {$addr & 0xffffffff}]
    if {$a >= 0x00300000 && $a < 0x00300200} { return [list 0x10 CFGUEN] }
    if {$a >= 0x00100000 && $a < 0x00102400} { return [list 0x20 LDUEN] }
    if {$a >= 0x0003dc00 && $a < 0x00040000} { return [list 0x20 LDUEN] }
    if {$a < 0x00040000} { return [list 0x08 APUEN] }
    return [list 0 UNMAPPED]
}

# --- the ISP engine ------------------------------------------------------------------

set ::REG(ISPCON) 0
set ::REG(ISPADR) 0
set ::REG(ISPDAT) 0
set ::REG(ISPCMD) 0
set ::REG(ISPTRG) 0
set ::REG(WRPROT) 0
set ::UNLOCK_STEP 0
set ::UNLOCKED 0

proc isp_fail {why} {
    set ::REG(ISPCON) [expr {$::REG(ISPCON) | 0x40}]
    incr ::STAT(ispff)
    if {$::VERBOSE} { puts "  \[sim\] ISPFF set: $why" }
}

proc isp_trigger {} {
    set cmd $::REG(ISPCMD)
    set addr $::REG(ISPADR)
    set ::REG(ISPTRG) 0

    if {$cmd == 0x23} {
        puts stderr ""
        puts stderr "SIMULATOR STOP: the script issued ISPCMD 0x23, WHOLE-CHIP ERASE."
        puts stderr "It is not modelled and never will be. Nothing generated by"
        puts stderr "swdflash.ts can reach this; something has been edited by hand."
        exit 3
    }
    if {!$::UNLOCKED} { isp_fail "SYS_WRPROT is locked"; return }
    if {($::REG(ISPCON) & 0x01) == 0} { isp_fail "ISPEN clear"; return }

    lassign [enable_bit_for $addr] bit name
    if {$bit == 0} { isp_fail "unmapped address [format 0x%08x $addr]"; return }
    if {($::REG(ISPCON) & $bit) == 0} {
        isp_fail "$name clear, so [format 0x%08x $addr] is not writable"
        return
    }

    if {$cmd == 0x00} {
        set ::REG(ISPDAT) [peek $addr]
    } elseif {$cmd == 0x21} {
        # Program. Flash can only drive bits from 1 to 0, which is why a program
        # without a preceding erase produces wrong data rather than an error.
        # Modelled faithfully, so the script's own read-back catches it.
        poke $addr [expr {[peek $addr] & $::REG(ISPDAT)}]
        touched $addr
        incr ::STAT(programs)
    } elseif {$cmd == 0x22} {
        # Page erase. The block is whatever --erase-block says, aligned down, because
        # 512 is *derived* and a real FMC erases whatever its array is organised in.
        set blk $::ERASE_BLOCK
        set base [expr {$addr - ($addr % $blk)}]
        for {set o 0} {$o < $blk} {incr o 4} {
            set a [expr {$base + $o}]
            if {[peek $a] != 4294967295} {
                if {$a < $::WINDOW_LO} { incr ::STAT(lostbelow) }
                if {$a >= $::WINDOW_HI && $a < 0x00040000} { incr ::STAT(lostabove) }
            }
            poke $a 4294967295
        }
        touched $base
        touched [expr {$base + $blk - 1}]
        incr ::STAT(erases)
        if {$::RESET_AT >= 0 && $::STAT(erases) >= $::RESET_AT} {
            # S_HALT clears and S_RESET_ST sets, and OpenOCD would have resumed the
            # application by now. Nothing else here models what the application does.
            set ::DHCSR [expr {($::DHCSR & ~0x00020000) | 0x02000000}]
        }
    } else {
        isp_fail [format "unknown ISPCMD 0x%02x" $cmd]
    }
}

# --- OpenOCD stubs -------------------------------------------------------------------

proc echo {msg} { if {$::VERBOSE} { puts $msg } }
# No time passes here, so wait_trg's 2-second ceiling is untested by construction.
proc sleep {ms} {}
proc init {} {}
proc halt {} {}
proc reset {args} {}
proc adapter {args} {}
proc targets {args} {}

proc mww {addr value} {
    # switch compares as strings, and every address arrives here in a different
    # notation depending on how the script wrote it, so the dispatch is numeric.
    set a [expr {$addr & 0xffffffff}]
    set v [expr {$value & 0xffffffff}]
    switch -- [format 0x%08x $a] {
        0x50000100 {
            set ::REG(WRPROT) $v
            # The documented three-write sequence. Anything else re-locks.
            if {$::UNLOCK_STEP == 0 && $v == 0x59} { set ::UNLOCK_STEP 1 ; return }
            if {$::UNLOCK_STEP == 1 && $v == 0x16} { set ::UNLOCK_STEP 2 ; return }
            if {$::UNLOCK_STEP == 2 && $v == 0x88} {
                set ::UNLOCK_STEP 0
                set ::UNLOCKED 1
                return
            }
            set ::UNLOCK_STEP 0
            set ::UNLOCKED 0
            return
        }
        0x5000c000 {
            # ISPFF is write-1-to-clear; every other bit is a plain store.
            set keep [expr {$::REG(ISPCON) & 0x40}]
            if {$v & 0x40} { set keep 0 }
            set ::REG(ISPCON) [expr {($v & ~0x40) | $keep}]
            return
        }
        0x5000c004 { set ::REG(ISPADR) $v ; return }
        0x5000c008 { set ::REG(ISPDAT) $v ; return }
        0x5000c00c { set ::REG(ISPCMD) $v ; return }
        0x5000c010 {
            set ::REG(ISPTRG) $v
            if {$v & 1} {
                isp_trigger
                # --busy: the engine claims to still be running for n polls, so the
                # script's wait_trg loop is exercised rather than short-circuited.
                set ::BUSY_LEFT $::BUSY
                if {$::BUSY > 0} { set ::REG(ISPTRG) 1 }
            }
            return
        }
    }
    violation "mww to [format 0x%08x $a], which is neither the FMC nor SYS_WRPROT.\
Only the ISP engine may write memory."
}

proc read_memory {addr width count args} {
    incr ::STAT(reads) $count
    set a [expr {$addr & 0xffffffff}]
    switch -- [format 0x%08x $a] {
        0x50000100 { return [list [expr {$::UNLOCKED ? 1 : 0}]] }
        0x5000c000 { return [list $::REG(ISPCON)] }
        0x5000c004 { return [list $::REG(ISPADR)] }
        0x5000c008 { return [list $::REG(ISPDAT)] }
        0x5000c00c { return [list $::REG(ISPCMD)] }
        0x5000c010 {
            set out $::REG(ISPTRG)
            if {[info exists ::BUSY_LEFT] && $::BUSY_LEFT > 0} {
                incr ::BUSY_LEFT -1
                if {$::BUSY_LEFT == 0} { set ::REG(ISPTRG) 0 }
            }
            return [list $out]
        }
    }
    if {$a == 0xe000edf0} {
        set out $::DHCSR
        # S_RESET_ST is sticky and clears on read, which is what makes one read per
        # page enough to notice a reset that happened between two of them.
        set ::DHCSR [expr {$::DHCSR & ~0x02000000}]
        return [list $out]
    }
    set out [list]
    for {set i 0} {$i < $count} {incr i} { lappend out [peek [expr {$a + $i * 4}]] }
    return $out
}

proc report {code} {
    # Written on failure too: after an aborted run the half-written array is the thing
    # worth looking at, and refusing to produce it made every failure opaque.
    if {$::OUTFILE ne ""} {
        set fh [open $::OUTFILE wb]
        fconfigure $fh -translation binary
        puts -nonewline $fh [binary format i* $::FLASH]
        close $fh
    }
    puts ""
    puts "simulator: [set ::STAT(erases)] page erases, [set ::STAT(programs)] words\
programmed, [set ::STAT(reads)] words read"
    if {$::STAT(lowest) >= 0} {
        puts [format "simulator: flash touched from 0x%08x to 0x%08x" \
            $::STAT(lowest) $::STAT(highest)]
    } else {
        puts "simulator: no flash was written"
    }
    puts "simulator: ISPFF raised [set ::STAT(ispff)] time(s)"
    if {$::ERASE_BLOCK != 512} {
        puts "simulator: erase block was [set ::ERASE_BLOCK] bytes, not the 512 the\
tool assumes"
    }
    # What the session left behind. A run that aborted with the FMC still unlocked is
    # a run that handed a writable flash to whatever resumes the core next.
    puts "simulator: left SYS_WRPROT [expr {$::UNLOCKED ? {UNLOCKED} : {locked}}],\
ISPCON [format 0x%02x $::REG(ISPCON)]"
    if {$::STAT(lostbelow) > 0 || $::STAT(lostabove) > 0} {
        puts "simulator: DESTROYED [set ::STAT(lostbelow)] words below the window and\
[set ::STAT(lostabove)] above it"
    }
    foreach v $::STAT(violations) { puts "simulator: VIOLATION $v" }
    if {[llength $::STAT(violations)] > 0} { exit 4 }
    exit $code
}

proc shutdown {args} {
    if {[llength $args] > 0 && [lindex $args 0] eq "error"} { report 1 }
    report 0
}

# --- run it --------------------------------------------------------------------------

source $::SCRIPT
report 0
