#!/usr/bin/env bash
#
# Validation ladder step 1, from `research/hardware-access.md`, "Restoring".
#
#   ./research/tools/fmc-ladder1.sh
#
# Reads one flash word through the FMC's ISP engine and compares it with the same
# word read directly over AHB. Agreement confirms, in one go and without writing a
# single byte of flash: the FMC base, the 0x59/0x16/0x88 unlock keys, the ISPCON
# bits, the ISPCMD encoding and the ISPTRG poll protocol.
#
# WHY THIS IS SAFE. It writes FMC *registers*, not flash. Every update-enable bit is
# left clear:
#
#   APUEN  (ISPCON bit 3) clear -> APROM erase and program are refused by hardware
#   CFGUEN (ISPCON bit 4) clear -> config page erase and program are refused
#   LDUEN  (ISPCON bit 5) clear -> LDROM erase and program are refused
#
# So even a whole-chip erase, ISPCMD 0x23 (corrected 2026-08-20 from 0x26, which is not
# a command at all), cannot take effect from this script. That is deliberate: this
# file exists to be run before anything that CAN write, and it
# must stay incapable of writing. Do not add an update-enable bit to it. An erase
# belongs in its own file.
#
# Register map and keys are *verified* from the vendor firmware's own config writer
# at abs 0x17a78, not assumed from Nuvoton: research/brick-2026-08-08.md, end of
# "Recovery plan".
set -euo pipefail

cfg="$(dirname "$0")/pan1020.cfg"

# FMC, from the vendor's own code.
ISPCON=0x5000c000   # +0
ISPADR=0x5000c004   # +4
ISPDAT=0x5000c008   # +8
ISPCMD=0x5000c00c   # +0xc
ISPTRG=0x5000c010   # +0x10
WRPROT=0x50000100

# ISPEN (bit 0) | ISPFF (bit 6, write 1 to clear a stale fail flag). Nothing else.
ISPCON_READONLY=0x41

# The word to read back. Any address will do; 0 is the APROM vector table, whose
# value we already know independently.
ADDR=${1:-0x00000000}

openocd -f "$cfg" \
  -c "adapter speed 100" \
  -c "init" \
  -c "halt" \
  -c "echo {=== direct AHB read, the reference ===}" \
  -c "mdw $ADDR" \
  -c "echo {=== WRPROT before unlock (bit 0: 0 locked, 1 unlocked) ===}" \
  -c "mdw $WRPROT" \
  -c "echo {=== unlock: 0x59 0x16 0x88 ===}" \
  -c "mww $WRPROT 0x59" \
  -c "mww $WRPROT 0x16" \
  -c "mww $WRPROT 0x88" \
  -c "mdw $WRPROT" \
  -c "echo {=== ISPCON := ISPEN|ISPFF, no update-enable bits ===}" \
  -c "mww $ISPCON $ISPCON_READONLY" \
  -c "mdw $ISPCON" \
  -c "echo {=== ISP read: ISPCMD 0x00, ISPADR, trigger ===}" \
  -c "mww $ISPCMD 0x00" \
  -c "mww $ISPADR $ADDR" \
  -c "mww $ISPTRG 0x01" \
  -c "echo {=== ISPTRG after (bit 0 clear means done) ===}" \
  -c "mdw $ISPTRG" \
  -c "echo {=== ISPDAT, which must equal the reference above ===}" \
  -c "mdw $ISPDAT" \
  -c "echo {=== ISPCON after (bit 6 set means the operation FAILED) ===}" \
  -c "mdw $ISPCON" \
  -c "echo {=== done ===}" \
  -c "shutdown"
