#!/usr/bin/env bash
#
# Read-only SWD session. Produces the input for `dumpcheck.ts`.
#
#   ./research/tools/swd-recon.sh probe          # step 3: is the port alive?
#   ./research/tools/swd-recon.sh ids            # CPUID and the part ID a flash
#                                                #   driver would later need
#   ./research/tools/swd-recon.sh diag           # steps 4-6: the four reads that
#                                                #   confirm or overturn the brick
#                                                #   postmortem
#   ./research/tools/swd-recon.sh dump out.bin   # step 7: all 256 KB
#
# THERE IS NO WRITE COMMAND IN THIS FILE AND NONE MAY BE ADDED. `research/
# hardware-access.md` requires read scripts and write scripts to live in separate
# files, invoked separately, so that a flash-write procedure is never loaded during
# a read session. An erase belongs in a file of its own, written on the day.
#
# Order of operations, the wiring map and the one misalignment that can damage the
# board (probe GND landing on VD) are in `notes/plan-after-the-brick.md`, "Track B".
# Read it before clipping on. Practise on the bricked unit, not the good one.
set -euo pipefail

cfg="$(dirname "$0")/pan1020.cfg"
cmd="${1:-}"

run() {
  echo "+ openocd -f $cfg -c \"$1\"" >&2
  openocd -f "$cfg" -c "$1"
}

case "$cmd" in
  probe)
    # Touches nothing: no halt, no memory access. A DPIDR of 0x0bb11477 is the
    # stock Cortex-M0 SW-DP and means the port is alive. Silence is ambiguous
    # between a bad rig and a dead chip, so swap EK/ED and try again before
    # concluding anything.
    run "init; dap info; shutdown"
    ;;
  ids)
    run "init; halt; mdw 0xE000ED00; mdw 0x50000000; mdw 0xE000EDF0; shutdown"
    echo "record 0x50000000: it is what a numicro flash driver entry needs" >&2
    ;;
  diag)
    # The whole postmortem in four reads. Expected on a unit bricked by the OTA
    # commit: 0x00300000 = 0xffffff3f, 0x00100000 = 0xffffffff, and 0x16800
    # matching stock. research/brick-2026-08-08.md.
    run "init; halt; mdw 0x00300000; mdw 0x00100000; mdw 0x0003dc00; mdw 0x16800 8; shutdown"
    ;;
  dump)
    out="${2:-}"
    if [ -z "$out" ]; then echo "usage: $0 dump <out.bin>" >&2; exit 2; fi
    if [ -e "$out" ]; then echo "refusing to overwrite $out" >&2; exit 2; fi
    run "init; halt; dump_image $out 0x00000000 0x40000; shutdown"
    echo >&2
    echo "now validate it, and pass the two words 'diag' printed for the separate" >&2
    echo "apertures, which no 0x0-0x40000 dump contains:" >&2
    echo >&2
    echo "  bun research/tools/dumpcheck.ts $out --config0 <word> --ldrom <word>" >&2
    echo >&2
    echo "then dump twice more from cold and compare, because an intermittent read" >&2
    echo "looks exactly like a device that changed underneath you:" >&2
    echo >&2
    echo "  bun research/tools/dumpcheck.ts compare $out <second> <third>" >&2
    ;;
  *)
    sed -n '2,20p' "$0" >&2
    exit 2
    ;;
esac
