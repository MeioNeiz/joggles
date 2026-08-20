# Plan after the brick: the firmware-delivery plan

**Situation, as of 2026-08-20: the brick is over.** Unit 1 (`GLASSES-12C3EF`) was
**repaired on 2026-08-20** by writing a healthy pair's application region onto it over
SWD, 150 pages, `0x16800`-`0x293ff`. It advertises, connects and answers as stock.
**All three pairs work.** The run: `research/aprom-write-2026-08-20.md`.

The cause was the image, not the config: the vendor APK's application fills 22 of 26
callback slots and the app tail-calls through an uninitialised RAM pointer at
`0x20000074`. `CONFIG0` was never implicated and the config repair run first did nothing.

*Corrected 2026-08-20: this said unit 1 "is bricked" and that unit 2 was "the only
working pair". Neither is true. Earlier corrections in this same paragraph tracked the
probe landing and the first flash write; this one closes it out.*
**Governing idea:** the brick blocks *delivery* of firmware, not the building of anything
else. Almost all the remaining work never needed firmware in the first place.
**Incident, mechanism and recovery plan:** `research/brick-2026-08-08.md`. **Pads, probes
and the physical side:** `research/hardware-access.md`.

## Three tracks, and only one of them is blocked

| Track | Needs | State |
| --- | --- | --- |
| **A. Client, renderer, app** | a working pair over BLE | **unblocked, and now with three pairs rather than one.** Current state is the board in `notes/parallel-tracks.md`, which is where tracks are claimed and closed |
| **B. SWD bring-up** | the probe | **DONE, and it repaired a unit.** Port alive, 256 KB dumped, LDROM read (track 48), the config page written, and on 2026-08-20 the **whole application region erased and programmed**: `APUEN`, both write opcodes against APROM, 512-byte granularity and "a flashed unit boots" all *verified* on silicon |
| **C. Custom firmware on a device** | a rebased image | **the only track left.** The delivery route is proven; what is missing is an image that is safe to send. `joggles-v1.bin` is built on the APK application and is barred from every unit |

Track C is worth being precise about, and **what it needs has now changed twice**. It was
described here as "finished work without a courier", missing only a delivery route.
*Corrected 2026-08-19: the delivery route exists and the image is the problem. Confirmed
2026-08-20: the route is not merely available, it has carried 150 pages onto a unit and
brought it back, so the image is the only thing standing between us and Track C.*
`firmware/joggles-v1.bin` builds reproducibly and its hook and extension are verified
instruction by instruction, but it is built on the vendor APK's application image and
**no pair here runs that image**, so it must not be flashed to any unit. What Track C
needs is not a courier, it is **a rebase onto a real unit's firmware**: see
`research/hardfault-0xd38-2026-08-19.md` and CLAUDE.md, "Our firmware".

SWD is still the better route than OTA ever was, and that argument is unaffected: the
constraint table is `research/brick-2026-08-08.md`, "SWD is not just the repair, it is
the better flashing route".

So the sequencing is: **A now, B on delivery, C once B works.** A and B do not compete;
they use different units.

## Rules for unit 2, which is now the only working one

- **Never send it an OTA commit.** `bun run flash commit` refuses outright and needs
  `--ldrom-verified` to lift. That is a claim only an LDROM dump can honestly support, so
  nobody can make it yet.
- `bun run flash stage` and `bun run flash info` remain safe and were both run against
  unit 1 with no harm. Staging commits nothing.
- **Dump it over SWD before it is ever put at risk.** A pristine 256 KB image of a
  working unit is the insurance that was missing this time. With it, a future mistake is
  an inconvenience rather than a loss. **It doubles as the reference for the unit-1 diff**
  (`research/brick-2026-08-08.md`, "Next steps"), and even a single `mdw 0x00300000` on it
  would cheaply settle whether `CONFIG0 = 0xFFFFFFBF` is normal. Both need Jacob's
  agreement to clip onto working hardware, and a healthy unit needs a `RST` line the dead
  one did not (`research/hardware-access.md`, "Dumping a healthy unit is harder").
- Everything in `notes/what-to-build.md` under "Do these first, no firmware required"
  is fair game on it today.

## The deadline, and why the brick does not threaten it

**Target: a working app by Tuesday 11 August 2026.** Nothing on that path needs firmware.

The BLE protocol is solved and *verified on hardware*: `DATS`/`DATCP` upload works end to
end and returns `DATCPOK`, our own bitmap has been left scrolling unattended, and unit 2
is stock and healthy. The firmware work was always **additive**, not foundational. A stock
unit does everything the app needs.

So the honest position is: the brick cost a unit and a night, and it cost **zero** days of
app progress. Losing a week would have meant losing the app; we lost neither.

## Track A: what to build now

The list is `notes/what-to-build.md`, "Do these first, no firmware required", unchanged by
the incident and **deliberately not copied here**. A copy did live in this section until
2026-08-11, and it drifted: it still said wide loops reach 768 columns after the original
was corrected to 740 on 2026-08-09, and this file is read first. Point at a list, never
restate one.

None of it touches firmware, and most of it is a prerequisite for the firmware features
anyway: a tile palette needs a renderer to feed it, button-driven content needs content.
**Doing A first is what we would have wanted regardless.**

## Track B: the order of operations when the probe lands

**All six steps ran on 2026-08-19.** Steps 1 to 5 (read-only) passed; step 6 (the config
repair, the first flash write) ran and did not revive the unit. Results are in
`research/brick-2026-08-08.md`, "What SWD actually found" and "The config repair". The
headlines: the port is alive and unlocked, the application is byte-identical to stock, the
LDROM exists and has been read (track 48), and `CONFIG0` reads `0xFFFFFFBF`, which is the
value the bootloader writes on purpose, not the predicted `0xFFFFFF3F` and not a fault.

Read-only throughout steps 1 to 5. Step 6 wrote only the config page, with APROM and LDROM
hardware-locked, so nothing below step 6 could worsen unit 1's position.

**Practise on the bricked unit, not the good one.** It is already dead, so a mistake costs
nothing, and it might simply work. The working pair is held back as a *control*, used only
if unit 1 stays silent.

1. `brew install open-ocd`. Config is already written: `research/tools/pan1020.cfg`.
2. Clip onto unit 1, clip pin 1 aligned to the `RST` pad. The wiring map, the probe's
   JST-SH pinout and why loose jumpers are unavoidable are in
   `research/hardware-access.md`, "The debug header". **Check the alignment before
   powering the glasses**: the clip is 6 pins against 5 pads, so it can sit one position
   out, and one of the two ways it can slip is the only mistake in this entire procedure
   that damages hardware. Same section.
3. `./research/tools/swd-recon.sh probe`. A DPIDR of `0x0bb11477` means the port is alive.
   Then `swd-recon.sh ids` and record the part ID at `0x50000000`.
4. `./research/tools/swd-recon.sh diag`: the four read-only diagnostics and nothing else.
   Each expected value and what it means is the table in `research/brick-2026-08-08.md`,
   "Seeing the cause with your own eyes". Read `0x00300000` first, because it either
   confirms the postmortem end to end and makes the repair a single page erase, or
   overturns the whole document.
5. Full `dump_image` of all 256 KB, **three times from cold and compared**:
   `swd-recon.sh dump <out>` each time, then `bun run dumpcheck compare <a> <b> <c>`, then
   `bun run dumpcheck <dump.bin> --config0 <word> --ldrom <word>` on one of them. Why
   three dumps rather than one: `research/hardware-access.md`, "Dumping". What the checker
   does and deliberately does not claim, including that the words at `0x16800` are a head
   and not a vector table: `research/README.md`, the tool's own header, and
   `research/firmware-image-format.md` beside its load-base section. This will be the
   first dump of a Panchip unit that exists.
6. **Done 2026-08-19, and it did not revive the unit.** The config page was erased and
   `CONFIG1`/`CONFIG2`/`CONFIG3` reprogrammed via `research/tools/fmc-repair-config.sh`
   (the only flash-write script in the repo), verified on read-back and across a physical
   power cycle. `fmc-ladder1.sh` passed first, confirming the FMC base, the `0x59/0x16/0x88`
   unlock keys and the `ISPTRG` poll with no writes. The unit still hardfaults identically.
   `CONFIG0` was never the fault: track 48's bootloader read found the cause (a RAM
   registration-order tail call) and showed `0xFFFFFFBF` is the value the bootloader writes
   on purpose, so the repair changed a value that may never have been wrong.
   *Corrected 2026-08-19: this said "erase the config page, read back `0xFFFFFFFF`". The
   page is not otherwise blank and an erase alone loses three programmed words; and, as it
   turned out, `0xFFFFFFFF` is not confirmed to be the right `CONFIG0` at all.*
   **What to do next** is the ordered list in `research/brick-2026-08-08.md`, "Next steps":
   read `CONFIG0` on a healthy pair (one word), then optionally the working-unit diff, both
   needing Jacob's agreement to clip onto working hardware.

**Rules for unit 1's dumps.** `firmware/` is gitignored, so the dumps are not in version
control and are the only record of a pre-repair device. Keep a copy outside the repo
before any write. They are reproducible only for as long as SWD keeps working.

**If unit 1 does not answer at step 3**, that is ambiguous between a bad setup and a dead
chip. Only then attach to unit 2, read-only, in a session with no write command loaded,
purely to prove the rig works.

## Track C: the order once flashing works

~~`joggles-v1` as-is first, since it is already verified~~ **Do not. Corrected
2026-08-19: flashing `joggles-v1` as-is would brick whatever it went on**, healthy units
included, because it carries the APK image's four missing callback registrations. It is
"verified" only in the sense that its own hook and extension disassemble correctly; the
image underneath them is the wrong firmware for this hardware.

The order is now: **rebase the build onto a donor dump, prove it with
`ota.check(image, { reference })` against that same unit's dump, and only then flash.**
`referenceUnregistered` must be 0. Then the ranked patches in
`notes/what-to-build.md`, cheapest first. That list stops having a self-sealing category
the moment SWD is the delivery route: `PROTECTED_REGIONS` exists only to keep OTA recovery
possible, so over SWD the GATT table, the OTA handler, the flash driver and the
descrambler all become editable.

## The lesson worth carrying forward

**Do not commit on top of an unverified component.** Staging was verified end to end on
hardware; the bootloader was never verified at all, and the commit handed control to it.
The docs said it was unverified and it was read as a to-do rather than a stop. The other
three lessons, and the full accounting of what that session cost and produced, are in
`research/brick-2026-08-08.md`, "What should have been done".
