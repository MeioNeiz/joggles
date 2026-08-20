# Flashing a unit over SWD: the ordered procedure

**Status: this procedure has been run, and it repaired a unit.** *verified* 2026-08-20 on
`GLASSES-12C3EF`, dead since 2026-08-08: 150 pages of the donor's application written over
SWD, verified byte-identical from three separate dumps, and the unit now advertises and
accepts a BLE connection. **It is no longer an experiment.** The run and its numbers are
`research/aprom-write-2026-08-20.md`.

*Corrected 2026-08-20: this header read "the tooling exists and nothing has been flashed
with it", and said the first real run was still an experiment. Both were true when written
and are now wrong. Reading the old header as current would make a proven procedure look
untested, which is the more dangerous direction of error.*

Everything below that is still marked unproven, is. Reading a unit over SWD is *verified*
and routine as of 2026-08-19, and the **application region** is now *verified* too:
`APUEN`, `ISPCMD 0x22` and `0x21` against APROM, and 512-byte erase granularity were all
driven on silicon for the first time on 2026-08-20.
**Scope:** what to have ready, the ordered steps, the exact commands, what to do when a
step fails, and the list of things that are still guesses.
**Cost:** an hour, most of it spent reading output. The write itself is minutes.

**What to write has changed since this file was first drafted, and it matters more than
anything else here.** `research/hardfault-0xd38-2026-08-19.md`: the application in the
vendor APK is not the application this hardware runs, and `firmware/joggles-v1.bin` is
built on it, so **that image must not be flashed to anything**. The image worth writing
is another unit's, read off it over SWD, and "Donor mode" below is that.

**The delivery plan this sits inside is `notes/plan-after-the-brick.md`, Track B and
Track C.** The register-level evidence is `research/brick-2026-08-08.md`, "What SWD
actually found", and `research/hardware-access.md`, "Restoring". This file is the
procedure and only the procedure.

## Why SWD rather than OTA

The OTA commit that bricked `GLASSES-12C3EF` on 2026-08-08 ran
`stage -> CRC -> info record -> CONFIG0 -> reset -> bootloader -> copy to 0x16800`.
**SWD writes `0x16800` directly.** No staging bank, no handshake, no info record, no
`CONFIG0` write, no bootloader. Every component that failed is absent from this path.
*verified* reasoning, from the mechanism in `research/brick-2026-08-08.md`.

What SWD does not give you is the OTA path's one virtue: it needs a probe clipped on. So
a unit flashed this way is recovered the same way, and the recovery is reliable, which
`PROTECTED_REGIONS` in `ota.check` was invented to fake over the air.

## The tools, and what each of them can do

`package.json` has no script for these; run them by path.

| Command | Touches a device? | What it is |
| --- | --- | --- |
| `bun research/tools/swdflash.ts plan <image> --from <dump>` | no | the whole plan, printed. Writes nothing at all |
| `bun research/tools/swdflash.ts script <image> --from <dump> --yes` | no | emits the OpenOCD script that does the writing |
| `bun research/tools/swdflash.ts donor <a> <b> --to <dump>` | no | the same, with another unit's dump as the source |
| `tclsh research/tools/swdflash-sim.tcl <script> --preload <dump>` | no | runs that script against a simulated FMC |
| `openocd -f research/tools/pan1020.cfg -c "set ..." -f <script>` | **yes, writes flash** | the real thing |
| `bun research/tools/swdflash.ts verify <dump> <image>` | no | did it land? |
| `./research/tools/swd-recon.sh dump <out>` | reads only | the dumps everything else needs |
| `bun run dumpcheck <dump> --against <image>` | no | the fuller report on a dump |

Only one line in that table writes anything, and it is the only one that needs `openocd`.

## What the tool refuses to do, and why that is structural

*verified* by `research/tools/swdflash.test.ts`, which asserts each of these against the
generated script rather than against the generator's intentions.

| Refusal | How it is enforced |
| --- | --- |
| write outside `0x16800`-`0x29400` | the plan refuses the page, and the script's own `guard` proc re-checks every address that reaches `ISPADR` |
| write the config page or the LDROM | `ISPCON` is `0x49`, `ISPEN` \| `APUEN` \| `ISPFF`. `CFGUEN` and `LDUEN` stay clear, so the **hardware** refuses both, and the script asserts they came back clear before it writes a page |
| whole-chip erase | it is `ISPCMD 0x23` (`FMC_ISPCMD_CPERASE`, vendor `fmc.h`), not the `0x26` this repo long believed. Neither is expressible: the only two values written to `ISPCMD` are `0x21` and `0x22`, and a test fails the build if a third appears |
| program a page that was not erased | `program_word` has exactly one call site, inside `write_page`, after the erase and its blank check. They are one operation, not two used in order |
| send an image `ota.check` rejects | `ota.check` runs before a page plan exists, with the stock baseline supplied so the patch checks run too |
| run by accident | `--yes` to emit the script, and the script refuses to run unless OpenOCD is handed the image's own CRC32 as a token |
| send an image the **target unit** will not run | `ota.check` gets the `--from` dump as its reference, so `unregistered-callback` and `device-holds-more` fire. This is what refuses `joggles-v1.bin`, and `research/image-silicon-match.md` is the argument |
| copy a donor that carries the same defect | `readDonor` refuses a donor whose application is byte-identical to either APK plaintext, and one dump on its own, and two that disagree |

**`PROTECTED_REGIONS` is still enforced, and that is deliberate.**
`research/brick-2026-08-08.md` argues correctly that those regions exist only to keep OTA
recovery possible and become advisory once SWD is the delivery route. `ota.check` has an
`allowProtectedRegions` option and deliberately no CLI flag for it, and `swdflash` does
not add one. Lifting it should mean editing code, in daylight, for a specific image.

## Donor mode: repairing unit 1 from a working pair

**This is the procedure that matters now.** The other one puts an image file on a unit;
this one puts another unit's own application region across, `0x16800`-`0x293ff`, because
that region is the only surviving copy of firmware that works on this hardware. It is
blocked on one thing: a read-only dump of a healthy pair, which is
`notes/dump-healthy-unit.md`.

### The commands, in order

Everything up to step 4 writes nothing and needs no probe on the target.

    # 1. two dumps of the DONOR, from cold, and prove they agree
    ./research/tools/swd-recon.sh dump firmware/donor-2026-xx-xx-a.bin
    ./research/tools/swd-recon.sh dump firmware/donor-2026-xx-xx-b.bin
    bun run dumpcheck compare firmware/donor-2026-xx-xx-{a,b}.bin

    # 2. two dumps of the TARGET, the unit being repaired, and the same
    ./research/tools/swd-recon.sh dump firmware/unit1-before-a.bin
    ./research/tools/swd-recon.sh dump firmware/unit1-before-b.bin
    bun run dumpcheck compare firmware/unit1-before-{a,b}.bin
    ./research/tools/swd-recon.sh diag        # CONFIG0 and the LDROM word

    # 3. the plan. Writes nothing, emits nothing, says everything
    bun research/tools/swdflash.ts donor \
      firmware/donor-2026-xx-xx-a.bin firmware/donor-2026-xx-xx-b.bin \
      --to firmware/unit1-before-a.bin --config0 <word> --ldrom <word>

    # 4. the script, and the simulator, before any probe writes anything
    bun research/tools/swdflash.ts donor \
      firmware/donor-2026-xx-xx-a.bin firmware/donor-2026-xx-xx-b.bin \
      --to firmware/unit1-before-a.bin --config0 <word> --ldrom <word> --yes
    tclsh research/tools/swdflash-sim.tcl firmware/swdflash-donor-*.tcl \
      --preload firmware/unit1-before-a.bin --config0 <word> \
      --set JOGGLES_FLASH_CONFIRM=<the token it printed> --out /tmp/after.bin --quiet
    bun research/tools/swdflash.ts verify /tmp/after.bin \
      --donor firmware/donor-2026-xx-xx-a.bin --donor firmware/donor-2026-xx-xx-b.bin

    # 5. the real thing, unit on its own battery
    openocd -f research/tools/pan1020.cfg \
      -c "set JOGGLES_FLASH_CONFIRM <the token>" -f firmware/swdflash-donor-*.tcl

    # 6. read it back, then RESET THE CORE OVER SWD. Not the button: see below
    ./research/tools/swd-recon.sh dump firmware/unit1-after.bin
    bun research/tools/swdflash.ts verify firmware/unit1-after.bin \
      --donor firmware/donor-2026-xx-xx-a.bin --donor firmware/donor-2026-xx-xx-b.bin
    openocd -f research/tools/pan1020.cfg -c "init; reset run; shutdown"

    # 7. then a LONG PRESS on the unit's own button, which switches it on
    bun run packages/cli/src/scan.ts 20

**"Power-cycle from the unit's own button" does not work after an SWD write, and step 6
used to say to do exactly that.** *Corrected 2026-08-20, having been caught by it.* Two
things compound:

- **The script halts the core and never resumes it**, so after the write the CPU is still
  halted wherever it was. The new firmware is in flash and has never executed.
- **The button is polled by firmware** (`CLAUDE.md`). A halted or hardfaulted unit cannot
  act on a press, so the button is inert precisely when you need it.

So the core must be reset over SWD, `reset run`, which writes no flash. `ICSR` at
`0xE000ED04` is how you tell it worked: `VECTACTIVE` 3 is HardFault, 0 is Thread mode.

**Then expect the unit to be switched OFF, and to look broken.** *verified* 2026-08-20.
A repaired unit sitting in its firmware power-off state has a dark panel, does not
advertise, **and stops answering SWD** ("cannot read IDR"), because the MCU is asleep.
That is indistinguishable from the brick by eye, and `research/brick-2026-08-08.md`
describes the brick as "powered, charging, no radio, no LEDs, no button". The red charge
LED is no help either way: `research/firmware-flashing.md` records that it is driven by
the charger IC, not the MCU. **A long press is what switches it on**, and the button
responding at all is the discriminator, because the bricked unit never did.

**Expect 150 pages, 19,200 words and about 136,000 register transactions**, and roughly
**12.5 minutes** at 100 kHz. *verified* 2026-08-20: 121 pages took 10 minutes, so about
5 seconds a page, and the transaction count rose from the 97,000 an earlier draft of this
file quoted once `verify_last` began re-reading a page after every erase. It is all wire
time; the flash itself is under two seconds of it.

**Give it a timeout well past 15 minutes, or run it detached.** The first real run was
killed at page 121 of 150 by a 10-minute cap in the harness driving it, not by any fault
on the unit. That is a resumable state and `--resume` finished it in two minutes, but it
is avoidable.

**Step 3 is where the reading happens, not step 5.** It prints two things nothing else
can tell you:

- `device-match` from `ota.check`, which says whether every callback slot the **target's**
  BLE stack dispatches through is one the **donor's** application registers. On unit 1
  against its own current application that reads `unregistered-callback` and is refused;
  a healthy donor should read "all 23 dispatched callback slots are registered". **That
  line is the whole root-cause theory being tested**, offline, before a byte moves.
- every run where the two units' windows differ. See the next section for what to look
  for in it.

### What is not copied, and what would be if we found it

The two units are different physical objects and the window is written across wholesale,
so the question is real: is anything in `0x16800`-`0x293ff` the unit's rather than the
firmware's? **Nothing was found, and the docblock on `UNIT_SPECIFIC` in
`research/tools/swdflash.ts` is the full account of how hard that was looked for.** The
short version:

- Unit 1's `0x16800`-`0x26a23` is byte-identical to the vendor's generic APK plaintext,
  and the vendor's own OTA overwrites that entire span on every update. Nothing per-unit
  can live there and survive one. *verified* from the bytes.
- **The advert-name suffix is not in flash.** Unit 1's SRAM holds `GLASSES-12E69E` at
  three addresses; flash holds only the eight-byte `GLASSES-` prefix. The six hex
  characters appear **nowhere** in the 256 KB dump, in either case, and nor do the three
  raw bytes in either order. `abs 0x21540` builds them with a nibble-to-hex loop over a
  struct in RAM, and that struct is filled at `abs 0xe1c` and `abs 0x143c0` from
  `ISPCMD 0x04` reads at `ISPADR 0x58` and `0x5c` - a different opcode from the flash
  read, and the main array at `0x58` holds a vector-table entry rather than a MAC. Both
  reading sites are below `0x16800` anyway. This upgrades track 47's *derived* claim as
  far as bytes can: the suffix is *verified* absent from flash.
- No calibration, serial or trim block anywhere in the window. Past the image end there
  are glyph bitmaps, 2-bit LED frame data, two RAM pointers, a second `GLASSES-` prefix
  and then programmed zeros.
- Everything genuinely per-unit that we know of is outside the window: the saved DATS
  content at `0x3c000`, the info pages, the LDROM, and the config aperture, which stays
  hardware-refused because `CFGUEN` is clear for the whole session.

**What none of that can do is compare two units**, which is the only test that settles
it, and the donor dump is the first chance anyone has had to run it. So read the diff
note in step 3. The shape to expect is a handful of long runs where two builds differ.
**Scattered single words in otherwise identical code are the signature to stop on**, and
`--keep 0x<lo>-0x<hi>` takes such a span from the target's own dump instead of the
donor's, without anyone editing code under time pressure.

### Going the other way: our firmware on a donor base

    bun run build-firmware firmware/joggles-v2.bin \
      --from-donor firmware/donor-2026-xx-xx-a.bin \
      --from-donor firmware/donor-2026-xx-xx-b.bin

then the ordinary `plan` / `script` path with that file. `build-firmware` resolves the
hook, the epilogue, `notify`, the AES key and the advert prefix **by content** in the
donor image rather than reusing the APK's addresses, and refuses when a signature is
missing or appears twice. Three things to expect on a real donor, all of them refusals
rather than surprises:

- **Two `GLASSES-` prefixes.** Unit 1's window has one at `0x2691c` and one at `0x28688`
  in the orphan. The tool will not guess; `--name-at 0x<addr>` names the live one, or
  `--stock-name` skips the rename.
- **No erased flash to put the extension in.** `EXT_BASE 0x26a24` is where the *APK's*
  image ends and means nothing on a donor. Unit 1's window runs to `0x293ff` with
  programmed zeros from `0x28787`, so the default placement refuses outright.
  `--into-fill` uses the zero run, and only after a scan for ldr-literals, raw words and
  `movs`/`lsls` constructions naming an address in it comes back empty. That leaves about
  3 KB rather than the 10 KB the APK build reports.
- **The block becomes an edit rather than an append**, because it lands inside the window
  instead of past the end of an image. `expect` still covers it.

## Before you start

1. **The unit is charged and runs on its own battery.** Never power it from the probe. A
   brown-out during an erase is the one failure `research/hardware-access.md` rates as
   possibly unrecoverable.
2. **`VD` has no wire on it.** Wiring, colours and the one clip misalignment that damages
   the board: `research/hardware-access.md`, "The debug header".
3. **You have three dumps from cold, and they agree.** `swd-recon.sh dump <out>` three
   times, then `bun run dumpcheck compare <a> <b> <c>`. Keep a copy outside the repo:
   `firmware/` is gitignored and those bytes are the only record of the unit as it was.
4. **You have the two words no dump contains.** `./research/tools/swd-recon.sh diag`
   prints `CONFIG0` at `0x00300000` and the LDROM word at `0x00100000`. Pass both to
   `swdflash` so they become canaries.
5. **Practise on unit 1.** It is already bricked, so a mistake costs nothing, and if the
   flash works it may simply come back. Unit 2 is the control.

## The procedure, for an image file

**Read "Donor mode" first.** This section is the original image-file procedure and every
command in it still works, but the image it names, `firmware/joggles-v1.bin`, is the one
that must not be flashed to anything. Kept because the shape of the procedure is right
and because `swdflash` now refuses that image out loud when it is given a dump, which is
worth seeing: run step 2 on it and read the `unregistered-callback` finding.

Steps 1 to 4 write nothing and can be run anywhere, with no probe attached. Step 6 is the
only one that writes.

### 1. Build the image, and check it on its own

    bun run build-firmware
    bun run ota-check firmware/joggles-v1.bin firmware/TR1906R04-10_OTA.bin

`build-firmware` already runs `ota.check` and refuses to emit an image that fails, so
this is a second look rather than a new one. The image needs no change for SWD:
`firmware/joggles-v1.bin` is the same container the OTA path would have carried, and
`swdflash` writes `ota.plaintext()` of it.

### 2. Read the plan

    bun research/tools/swdflash.ts plan firmware/joggles-v1.bin \
      --from firmware/dump-unit1-2026-08-19-a.bin \
      --config0 0xffffffbf --ldrom 0x20000610

Nothing is written and no script is emitted. Read the output in full. It prints the
destination span, the page counts, every region that will not be touched with the canary
word that proves it, and the precondition words. **If the region list or the canary
values look wrong, stop here**: the dump is of a different unit, or of a unit that has
changed since.

### 3. Emit the script

    bun research/tools/swdflash.ts script firmware/joggles-v1.bin \
      --from firmware/dump-unit1-2026-08-19-a.bin \
      --config0 0xffffffbf --ldrom 0x20000610 --yes

It writes `firmware/swdflash-joggles-v1.tcl`, prints the exact `openocd` command, and
stops. The script is self-contained: the data, the preconditions and the canaries are all
in the text, so it cannot silently pick up a different image later, and it can be read in
full before it is run. It is 200 KB and worth skimming: the procs at the top are the
whole safety argument, and the body after `init` is the plan you just read.

### 4. Dry-run it against the simulator

    tclsh research/tools/swdflash-sim.tcl firmware/swdflash-joggles-v1.tcl \
      --preload firmware/dump-unit1-2026-08-19-a.bin --config0 0xffffffbf \
      --set JOGGLES_FLASH_CONFIRM=0x3114eab0 --out /tmp/after.bin --quiet
    bun research/tools/swdflash.ts verify /tmp/after.bin firmware/joggles-v1.bin

`swdflash-sim.tcl` models the flash array and the ISP engine in TCL and stubs out every
OpenOCD command, so this runs the **actual script** with no probe and no device. It takes
under a second. Expect `130 page erases, 16543 words programmed`, `flash touched from
0x00016800 to 0x00026bff`, `ISPFF raised 0 time(s)`, and then `MATCHES byte for byte`.

A script that fails here has no business being pointed at a device. Note the token in
`--set`: it is the image CRC and the tool prints it.

### 5. Attach, and confirm the port is alive before anything else

    ./research/tools/swd-recon.sh probe

`DPIDR 0x0bb11477` means the port is up. Silence is ambiguous between a bad rig and a
dead chip; swap `EK` and `ED` and try again before concluding anything.

**On a healthy unit, expect to need `RST`.** `P4.6` and `P4.7` mux to UART1 a few
milliseconds after boot, so a running application can steal the SWD pins. Unit 1
hardfaults early and never claims them, which is why no reset lead was needed there.
*derived*; the healthy case has not been tried.

### 6. Run it

    openocd -f research/tools/pan1020.cfg \
      -c "set JOGGLES_FLASH_CONFIRM 0x3114eab0" \
      -f firmware/swdflash-joggles-v1.tcl

**`-c` must come before `-f`.** OpenOCD processes them in command-line order, so with the
order reversed the script runs before the token is defined and refuses.

The script prints seven numbered sections. Sections 1 and 2 read the preconditions and
the canaries **before** `SYS_WRPROT` is unlocked, so an abort there leaves the FMC locked
and nothing written. Section 5 is the pages, one line each. Section 6 re-reads the
canaries. **Do not power off until it says `DONE`.**

Time is *unmeasured*. It is roughly 84,000 register transactions over CMSIS-DAP at
100 kHz, so somewhere between two minutes and half an hour, and nobody knows which.

### 7. Power-cycle and read it back

Use the unit's own button, not the probe. Then dump it again and check:

    ./research/tools/swd-recon.sh dump firmware/after-flash.bin
    bun research/tools/swdflash.ts verify firmware/after-flash.bin firmware/joggles-v1.bin
    bun run dumpcheck firmware/after-flash.bin --against firmware/joggles-v1.bin \
      --config0 <word> --ldrom <word>

`verify` reports the `JGX1` header the unit is now carrying. `dumpcheck` adds the region
census and the landmarks.

### 8. Then, and only then, ask the device

    bun cli probe

A crew unit advertises as `JOGGLES-<MAC6>` and answers `HELLO` with its version and
capability bitmap. A stock unit answers `J` with silence, which is how the two are told
apart. If it advertises but does not answer `HELLO`, the image is on the device and the
hook is not working, which is a firmware bug and not a flashing one.

## When it fails

The script stops at the first failure and says which address and what it read. It never
carries on past a bad verify.

| Where it stopped | What it means | What to do |
| --- | --- | --- |
| section 1, a precondition | this is not the unit the dump came from, or it changed | **nothing was written.** Re-dump and regenerate |
| section 3, `SYS_WRPROT` still locked | the unlock keys did not take on this part | stop. This falsifies the one thing `fmc-ladder1.sh` proved, so re-run the ladder |
| section 4, `CFGUEN` or `LDUEN` set | `ISPCON` does not behave as documented | stop, and do not retry. The safety argument is void |
| a page erase, `ISPFF` set | the FMC refused the erase | the unit is mid-flash. Re-dump, then `script --resume` against the new dump |
| `check_erased` after an erase | the erase did nothing, or read back stale | as above, and suspect the rig before the silicon |
| a program, `ISPFF` set | as for the erase | as above |
| `check_words` after a page | the page programmed wrong | as above. This is the read-back doing its job |
| **the granularity probe** | **the erase block is larger than 512 bytes** | **stop. Do NOT `--resume`, see below.** One page was erased and nothing programmed |
| **`verify_last` after an erase** | **the erase reached backwards over the page before it**, so the block is 1 KB or larger | **stop. Do NOT `--resume`.** Same reason |
| `check_halted`, `S_HALT` clear or `S_RESET_ST` set | the target reset mid-run | stop. The application has run and may have re-muxed the debug pins. Assert `RST` and re-attach |
| the final whole-window read-back | the window does not match the image even though every page verified | stop. Something erased a page after it was written; this is the last line of defence and it firing means an earlier one did not |
| section 6, a canary moved | something wrote outside the window | **stop and write down exactly what changed.** Nothing in the script can do this, so either the model is wrong or the tool is |

*The section numbers above were written when the script had seven sections. Reviewed and
extended 2026-08-20 (`research/swdflash-review-2026-08-20.md`); it now has nine, and the
four rows in bold are checks that did not exist before that review.*

### `--resume` is NOT safe after a granularity failure

**Everywhere else in this section, `--resume` is the right answer. After the granularity
probe or `verify_last` fires, it is the wrong one and it will make things worse.**

`--resume` skips pages a fresh dump shows are already correct. That reasoning assumes one
erase touches one page. If the block is larger, every page it writes erases its
neighbours, so resuming walks the same destruction across the window a second time while
reporting success for each page as it goes. **The failure mode is a tool that certifies a
half-erased image**, which is exactly what the 2026-08-20 review found the pre-review
script would do at a 1 KB block: exit 0, print "Every word written was read back and
matched", and leave 39,297 of 76,800 bytes erased.

If either of those two checks fires, the tool cannot write this part at 512-byte pages at
all and needs one erase per block with every page in the block programmed. That is a
different tool. Stop, re-dump, and record the block size you observed.

**A stop part way through is not a brick, it is an unfinished flash.** The probe is still
attached and the application region is the only thing touched. Dump the unit, then:

    bun research/tools/swdflash.ts script firmware/joggles-v1.bin \
      --from firmware/after-partial.bin --resume --yes

`--resume` skips the pages the new dump already shows correct, reads them back to prove
it, and rewrites only the rest. A one-page repair is one erase and 128 words. It works
the same way on a donor run, with the new dump as `--to`:

    bun research/tools/swdflash.ts donor <donor-a.bin> <donor-b.bin> \
      --to firmware/after-partial.bin --resume --yes

**"Going back to stock" no longer means the vendor container.** An earlier draft of this
file said to write `firmware/TR1906R04-10_OTA.bin`, and on a working unit that is the
2026-08-08 brick performed deliberately: that image is the one whose application does not
match this hardware's BLE stack. `swdflash` now refuses it when it is given the target's
dump. **Going back means going back to what the unit itself was running**, which is the
donor procedure above with the unit's own pre-flash dump as the donor:

    bun research/tools/swdflash.ts donor <before-a.bin> <before-b.bin> \
      --to <dump-taken-now.bin> --yes

That is also why "three dumps from cold, kept outside the repo" is the first rule in this
file. Those bytes are the only way back.

## What is still unproven, in the order it matters

**Most of this list was settled on 2026-08-20 by the run that repaired
`GLASSES-12C3EF`.** Items 1 to 5 are struck through with what settled them. Items 6 and 7
stand. `research/aprom-write-2026-08-20.md` is the run.

1. ~~**That `ISPCMD 0x22` erases and `0x21` programs from an external debugger.**~~
   **Settled twice.** The config repair drove both opcodes through `CFGUEN` on
   2026-08-19, and the repair drove both against **APROM through `APUEN`** on
   2026-08-20: 151 page erases and 19,200 words programmed, every word read back, and
   `ISPCON` bit 6 never set once. `APUEN` had never been driven on this family before
   that run, and it unlocks the application region exactly as `CFGUEN` unlocked the
   config page.
2. ~~**That a 512-byte page is the erase granularity.**~~ ***verified* 2026-08-20.**
   Not by assumption but by a probe built for it: one page is erased before any other,
   and the whole of its **predecessor** is then read back. It passed in both sessions of
   the repair. The probe page is chosen so that a block of up to 32,768 bytes could not
   leave the window, and so that every block size from 1 KB up contains the page read
   back, which is what makes a pass meaningful. **Note the earlier advice in this file
   was to read the page *after* the one erased; that is the wrong direction.** The
   dangerous spill at the bottom of the window is *backwards*: `0x16800` is 2 KB aligned
   but not 4 KB aligned, so a 4 KB block would take 2 KB of live BLE stack, and a 1 KB or
   2 KB block would take the previously written page while touching nothing outside the
   window at all. `research/variant-mismatch-2026-08-19.md` has the arithmetic per block
   size.
3. ~~**That the CPU being halted is enough.**~~ **Settled in practice, 2026-08-20.** The
   canary at `0x0` and the whole below-window sweep were unchanged across a
   136,000-transaction session, and the BLE stack was byte-identical afterwards over all
   92,160 bytes. That does not prove there is no DMA on this part, only that nothing
   disturbed flash across one long real session. *verified* as an observation, still
   *unverified* as a general claim.
4. ~~**That the part tolerates a write session this long.**~~ ***verified* 2026-08-20.**
   About 136,000 register transactions across the two sessions, roughly 12.5 minutes of
   wire time for 150 pages at 100 kHz, no faults and no read-back mismatches. The one
   interruption was a 10-minute timeout in the harness driving OpenOCD, not the silicon.
5. ~~**That a flashed unit boots.**~~ ***verified* 2026-08-20, and it is the whole
   point.** `GLASSES-12C3EF`, dead since 2026-08-08, boots the donor's application, comes
   out of HardFault into Thread mode, responds to its button, advertises as
   `GLASSES-12C3EF` and accepts a BLE connection. **What is verified is a donor image, not
   `joggles-v1`**, which remains barred and unrun: `notes/firmware-design.md`'s "these
   bytes are the bytes this document describes" still says nothing about that image's
   behaviour on a device.
6. **That `--blank-tail` is safe on a real unit.** Unchanged, and the repair did not use
   it. See the next section. What the repair did establish is what the tail *is*, which
   makes the caution cheaper to keep: it is unit 1's own original application.
7. **That re-locking `SYS_WRPROT` by writing `0x00` works.** *derived* from Nuvoton, and
   the simulator reports the session leaving `SYS_WRPROT` locked and `ISPCON` `0x00`.
   Nothing on hardware read the register back afterwards. Nothing depends on it: a power
   cycle clears it anyway.

## The tail nobody erased

**Settled 2026-08-20, and it is not what this section originally said.** Those 7,047
bytes at `0x26c00`-`0x28786` are **the tail of the unit's OWN firmware**, the
`TR1906R04-12` build that every healthy pair runs, which reaches `0x28790`. The 2026-08-08
OTA overwrote only the first 66,084 bytes of it with the APK's smaller `-10` image and
left the rest standing. *verified*: it is byte-identical to the donor dump, and when the
repair ran it found those 20 pages **already matching the donor before it wrote
anything**. `research/variant-mismatch-2026-08-19.md` and
`research/donor-dispatcher-2026-08-20.md`.

*Corrected: this section called it "an earlier, longer factory image" of unknown
provenance, programmed before the current one and partly erased. The blob is real and the
byte offsets below are right, but its identity was guessed and the guess was wrong. It is
not older, it is not a different product's, and it is not junk: it is the surviving upper
third of the application these glasses are supposed to run. The observation that its
first 32 bytes also appear `0x9fe` lower inside the image stands and was the clue.*

*derived* originally, 2026-08-19, from `firmware/dump-unit1-2026-08-19-a.bin`. Unit 1's
application region held content past the end of its then-running image at `0x26c00` to
`0x28786`, with zeros beyond to `0x293ff`, while the image itself ended at `0x26a24` and
`0x26a24`-`0x26c00` read erased.

**This applies to a unit an OTA has truncated, not to a healthy one.** On a healthy pair
there is no tail, because the application simply runs that far. Unit 1 no longer has one
either: the repair wrote the whole window.

Three consequences, and the first two only ever applied to a truncated unit:

- **`--blank-tail` erases it, and the default is not to.** Nothing has proved the running
  application never reads `0x26c00`, and the cheap assumption is the expensive one on
  this project. Leave it unless there is a reason.
- **`dumpcheck` will report it after a flash** as "beyond the reference". That is the
  correct report and not a failed flash.
- **The free-flash figure in `build-firmware` counts it as free.** It prints 10,628 bytes
  left between the end of `joggles-v1` and the staging bank, and 7,047 of those are this
  blob. An extension that grows past `0x26c00` overwrites it, which is probably fine and
  has never been checked.

## What can still permanently kill a unit

Unchanged from `research/hardware-access.md`, "What can permanently kill it", and none of
these is reachable from the script this tool emits. They are here because the script is
not the only thing anyone will ever type.

| Action | Recoverable? |
| --- | --- |
| `ISPCMD 0x23`, whole-chip erase (*corrected 2026-08-20 from `0x26`, which is not a command at all*) | no, and it destroys the firmware you wanted |
| writing the `CONFIG0` LOCK bit | only by whole-chip erase |
| disabling the debug port in config | no |
| erasing factory trim or RF calibration, wherever it lives | no |
| brown-out mid-erase with `CFGUEN` set | possibly not |
| erasing the bootloader at `0x3dc00` | not without another probe session |
| programming a page without erasing it first | yes, but the write silently stores wrong data |

The standing rule stands: **never write a register whose semantics you have not read in a
datasheet or extracted from vendor code.** Every register this tool writes came out of the
vendor's own code at `abs 0x17a78`, and the last row of that table is the one this tool
exists to make impossible.
