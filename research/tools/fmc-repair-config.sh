#!/usr/bin/env bash
#
# THE ONLY SCRIPT IN THIS REPO THAT WRITES FLASH. Read it before running it.
# DO NOT RUN IT YET. research/config0-cbs-2026-08-20.md item 2 is not done.
#
#   ./research/tools/fmc-repair-config.sh --dry-run                 # prints the plan
#   ./research/tools/fmc-repair-config.sh --cbs-checked --yes       # writes
#
# Puts unit 1's CONFIG0 back to 0xFFFFFFBF, the value every working unit here holds,
# from the 0xFFFFFFFF the 2026-08-19 config change left it at. That restores
# CBS = 10, "APROM with IAP mode", from CBS = 11, "APROM without IAP mode".
#
# REWRITTEN 2026-08-20, AND THE DIRECTION IS THE OPPOSITE OF WHAT IT WAS. This script
# used to go 0xFFFFFFBF -> 0xFFFFFFFF, erasing CONFIG0 as a brick repair. That was run,
# it did nothing for the brick, and CONFIG0 was never implicated: research/ldrom-
# 2026-08-19.md. What actually fixed unit 1 was writing the donor's application region
# over SWD, research/aprom-write-2026-08-20.md. So the old direction is spent, and the
# only remaining reason to touch this page is to undo it.
#
# WHY IT MIGHT BE WORTH DOING, AND WHY IT IS NOT MERELY TIDYING. IAP is in-application
# programming, i.e. the running application writing flash, which is exactly and only what
# the resident updater does. Unit 1 is the Track C target and is the only unit that has
# ever run at CBS = 11. Whether CBS gates application-driven ISP is *derived* to be "no"
# and is NOT settled: research/config0-cbs-2026-08-20.md has the argument, its limit, and
# what settles it without writing anything.
#
# WHY THIS DIRECTION IS MORE DANGEROUS THAN THE ONE IT REVERSES. research/fmc-erase-
# program.md calls the CONFIG0 LOCK bit "the one permanent path" and closed, on two legs:
# CFGUEN is clear all session, and an erase cannot drive a bit to 0. BOTH LEGS ARE GONE
# HERE. Setting bit 6 to 0 is a program, and a config program needs CFGUEN set. This is
# the first operation in this project that could permanently lock the MCU, so the value
# programmed into CONFIG0 is asserted twice below and the script refuses to start without
# --cbs-checked as well as --yes.
#
# WHAT IT DOES. Read-modify-write of the whole page, which is what both the vendor's
# config writer at abs 0x17a78 and the bootloader at ld 0x100b86 do: erase, then program
# all four words. Considered and rejected: programming CONFIG0 alone with no erase, since
# going 0xFFFFFFFF -> 0xFFFFFFBF only clears bits and would avoid any window with
# CONFIG1-3 erased. Rejected because partial programming of an unerased config word is
# undocumented on this part, and a refused program that silently sets ISPFF looks
# identical to success. The erased window is recoverable by re-running; a marginal cell
# is not.
#
#   CONFIG0 0x300000  0xFFFFFFFF -> 0xFFFFFFBF   this is the change
#   CONFIG1 0x300004  0x00000000 -> 0x00000000   restored unchanged
#   CONFIG2 0x300008  0x00000000 -> 0x00000000   restored unchanged
#   CONFIG3 0x30000c  0x0003DBFF -> 0x0003DBFF   restored unchanged
#
# SAFETY: CFGUEN ONLY. ISPCON is set to ISPEN | CFGUEN | ISPFF and deliberately NOT
# APUEN and NOT LDUEN, so for the whole session the hardware refuses every erase and
# program outside the config page. The application at 0x16800 and the LDROM at 0x3dc00
# are physically unreachable by this script even if it is wrong. CFGUEN and APUEN must
# never be set in the same session, so this must not be combined with a flash write.
#
# Prerequisite: ./research/tools/fmc-ladder1.sh must pass. It confirms the FMC base,
# the unlock keys, the ISPCON bits and the trigger protocol without writing anything.
# Passed 2026-08-19: ISPDAT returned 0x20002648, matching the direct AHB read.
#
# ISPCMD Whole-chip erase is ISPCMD 0x23 (vendor fmc.h FMC_ISPCMD_CPERASE), corrected
# 2026-08-20 from the 0x26 this repo long believed, which is not a command at all.
# Neither appears in this file and neither must ever be added.
#
# ISPTRG is polled after every trigger (wait_trg below). A page erase takes
# milliseconds, and reading flash while the ISP engine is busy can stall the AHB past
# OpenOCD's timeout; an aborted session at that point would leave the page erased
# with CONFIG1-3 unrestored, a state the precondition check then refuses to resume
# from. The poll was validated read-only on 2026-08-19 with an ISPCMD 0x00 read.
#
# The RST lead is NOT needed for this one, and that is a deliberate exception. research/
# fmc-erase-program.md says a write session should hold RST, but the reasoning there is a
# half-written APPLICATION re-muxing the ICE pins. This script cannot touch the
# application, so the state it could leave behind cannot run any code at all.
#
# Run the glasses from their own battery, not the probe. research/hardware-access.md.
set -euo pipefail

cfg="$(dirname "$0")/pan1020.cfg"

ISPCON=0x5000c000
ISPADR=0x5000c004
ISPDAT=0x5000c008
ISPCMD=0x5000c00c
ISPTRG=0x5000c010
WRPROT=0x50000100

CONFIG_PAGE=0x00300000

# ISPEN (bit 0) | CFGUEN (bit 4) | ISPFF (bit 6, write 1 to clear). No APUEN, no LDUEN.
ISPCON_CFG=0x51

CMD_PROGRAM=0x21
CMD_PAGE_ERASE=0x22

# Single-quoted so the shell leaves the TCL variables alone, which is why ISPTRG's
# address is hardcoded rather than taken from the constant above. Bounded at ~2s.
WAIT_TRG='proc wait_trg {} {
  for {set i 0} {$i < 2000} {incr i} {
    if {([lindex [read_memory 0x5000c010 32 1] 0] & 1) == 0} { return }
    sleep 1
  }
  echo {ISPTRG stuck busy, aborting}
  shutdown error
}'

# Expected pre-state. Unit 1 has read this in three dumps since the 2026-08-20 repair,
# including after a power cycle, so it is the state the part boots in. The script refuses
# to run against anything else: a device reading 0xffffffbf is already correct and needs
# nothing, and any other value is not a unit this script understands.
EXPECT_CONFIG0=0xffffffff
ALREADY_CORRECT=0xffffffbf

# The one word that could permanently lock the part. Asserted twice below, and nothing
# computes it: it is written out so a diff shows it changing.
RESTORE_CONFIG0=0xffffffbf
RESTORE_CONFIG1=0x00000000
RESTORE_CONFIG2=0x00000000
RESTORE_CONFIG3=0x0003dbff

# Guard 1, on the literal. CONFIG0 bit 1 is LOCK and must stay 1; 0 locks the chip with
# no way back. This is belt and braces over guard 2 and costs nothing.
if [ $(( RESTORE_CONFIG0 & 0x2 )) -ne 2 ]; then
  echo "REFUSING: RESTORE_CONFIG0 has the LOCK bit clear. That is permanent." >&2
  exit 3
fi

# Guard 2, on the whole value. There is exactly one word this script is allowed to
# program into CONFIG0. If someone edits the constant, it stops here.
if [ "$RESTORE_CONFIG0" != "0xffffffbf" ]; then
  echo "REFUSING: RESTORE_CONFIG0 is $RESTORE_CONFIG0, not 0xffffffbf." >&2
  echo "This script programs one value into CONFIG0 and that is not it." >&2
  exit 3
fi

want_write=0
cbs_checked=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      cat <<EOF
DRY RUN. Nothing will be written.

  precondition   CONFIG0 must currently read $EXPECT_CONFIG0
                 (if it reads $ALREADY_CORRECT there is nothing to do)
  unlock         $WRPROT <- 0x59, 0x16, 0x88
  enable         $ISPCON <- $ISPCON_CFG   (ISPEN|CFGUEN|ISPFF; APROM and LDROM stay locked)
  erase          ISPCMD $CMD_PAGE_ERASE at $CONFIG_PAGE
  verify         all four config words read 0xffffffff
  program        CONFIG0 <- $RESTORE_CONFIG0   <-- the change, and the LOCK-bit risk
                 CONFIG1 <- $RESTORE_CONFIG1
                 CONFIG2 <- $RESTORE_CONFIG2
                 CONFIG3 <- $RESTORE_CONFIG3
  verify         all four read back as programmed, ISPCON bit 6 clear

  This restores CBS = 10, "APROM with IAP mode", which every working unit holds.
  It is the first CONFIG0 program in this project. Read the header before --yes.
EOF
      exit 0
      ;;
    --cbs-checked) cbs_checked=1 ;;
    --yes) want_write=1 ;;
    *) echo "unknown argument: $arg" >&2 ; exit 2 ;;
  esac
done

if [ "$want_write" -ne 1 ]; then
  echo "refusing to run without --yes. Try --dry-run first." >&2
  exit 2
fi

# The gate, in the shape flash.ts uses for --ldrom-verified: a flag that asserts a piece
# of homework was done, so the dangerous path cannot be reached by muscle memory. Item 2
# is "resolve from the register map whether CBS gates application-driven ISP at all",
# which is offline and needs no device. If the answer is that it does not, this write has
# no purpose and should not happen.
if [ "$cbs_checked" -ne 1 ]; then
  echo "REFUSING: --cbs-checked not given." >&2
  echo "research/config0-cbs-2026-08-20.md item 2 has to be settled first. If CBS does" >&2
  echo "not gate application-driven ISP, this write buys nothing and risks the LOCK bit." >&2
  exit 2
fi

# Enforce the precondition with a read before anything is unlocked.
echo "checking precondition..." >&2
actual="$(openocd -f "$cfg" -c "adapter speed 100" -c "init" -c "halt" \
  -c "mdw $CONFIG_PAGE" -c "shutdown" 2>&1 \
  | sed -n 's/^0x00300000: \([0-9a-f]*\).*/\1/p' | tail -1)"

if [ -z "$actual" ]; then
  echo "FAILED: could not read CONFIG0. Is the probe attached, and the unit switched" >&2
  echo "off? SWD stops answering while the unit is awake. notes/hardware-state.md." >&2
  exit 1
fi
if [ "0x$actual" = "$ALREADY_CORRECT" ]; then
  echo "Nothing to do: CONFIG0 already reads $ALREADY_CORRECT." >&2
  exit 0
fi
if [ "0x$actual" != "$EXPECT_CONFIG0" ]; then
  echo "FAILED: CONFIG0 reads 0x$actual, expected $EXPECT_CONFIG0." >&2
  echo "Refusing to write. Nothing has been changed." >&2
  exit 1
fi
echo "precondition ok: CONFIG0 = 0x$actual" >&2

openocd -f "$cfg" \
  -c "adapter speed 100" \
  -c "init" \
  -c "halt" \
  -c "$WAIT_TRG" \
  -c "echo {=== 1. precondition: CONFIG0 must be $EXPECT_CONFIG0 ===}" \
  -c "mdw $CONFIG_PAGE 4" \
  -c "echo {=== 2. unlock ===}" \
  -c "mww $WRPROT 0x59" -c "mww $WRPROT 0x16" -c "mww $WRPROT 0x88" \
  -c "mdw $WRPROT" \
  -c "echo {=== 3. ISPCON := ISPEN|CFGUEN|ISPFF. APROM and LDROM stay hardware-locked ===}" \
  -c "mww $ISPCON $ISPCON_CFG" \
  -c "mdw $ISPCON" \
  -c "echo {=== 4. page erase of the config page ===}" \
  -c "mww $ISPCMD $CMD_PAGE_ERASE" \
  -c "mww $ISPADR $CONFIG_PAGE" \
  -c "mww $ISPTRG 0x01" \
  -c "wait_trg" \
  -c "mdw $ISPTRG" \
  -c "echo {=== 5. after erase: expect ffffffff x4, and ISPCON bit 6 clear ===}" \
  -c "mdw $CONFIG_PAGE 4" \
  -c "mdw $ISPCON" \
  -c "echo {=== 6. program CONFIG0. THE ONE IRREVERSIBLE STEP: LOCK must stay 1 ===}" \
  -c "mww $ISPCMD $CMD_PROGRAM" -c "mww $ISPADR 0x00300000" \
  -c "mww $ISPDAT $RESTORE_CONFIG0" -c "mww $ISPTRG 0x01" \
  -c "wait_trg" \
  -c "mdw $CONFIG_PAGE" \
  -c "echo {=== 7. restore CONFIG1 ===}" \
  -c "mww $ISPCMD $CMD_PROGRAM" -c "mww $ISPADR 0x00300004" \
  -c "mww $ISPDAT $RESTORE_CONFIG1" -c "mww $ISPTRG 0x01" \
  -c "wait_trg" \
  -c "echo {=== 8. restore CONFIG2 ===}" \
  -c "mww $ISPCMD $CMD_PROGRAM" -c "mww $ISPADR 0x00300008" \
  -c "mww $ISPDAT $RESTORE_CONFIG2" -c "mww $ISPTRG 0x01" \
  -c "wait_trg" \
  -c "echo {=== 9. restore CONFIG3 ===}" \
  -c "mww $ISPCMD $CMD_PROGRAM" -c "mww $ISPADR 0x0030000c" \
  -c "mww $ISPDAT $RESTORE_CONFIG3" -c "mww $ISPTRG 0x01" \
  -c "wait_trg" \
  -c "echo {=== 10. final: expect ffffffbf 00000000 00000000 0003dbff ===}" \
  -c "mdw $CONFIG_PAGE 4" \
  -c "echo {=== 11. ISPCON, bit 6 set means something FAILED ===}" \
  -c "mdw $ISPCON" \
  -c "echo {=== done. reset run, check ICSR, then long-press to switch on ===}" \
  -c "shutdown"
