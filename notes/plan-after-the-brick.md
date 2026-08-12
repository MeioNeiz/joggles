# Plan after the brick: the firmware-delivery plan

**Situation, as of 2026-08-11:** unit 1 (`GLASSES-12C3EF`) is bricked by an OTA commit.
The probe is ordered and **has not landed. No SWD session has been attempted, and no
recovery tried.** Unit 2 works, is stock, and is the only working pair.
**Governing idea:** the brick blocks *delivery* of firmware, not the building of anything
else. Almost all the remaining work never needed firmware in the first place.
**Incident, mechanism and recovery plan:** `research/brick-2026-08-08.md`. **Pads, probes
and the physical side:** `research/hardware-access.md`.

## Three tracks, and only one of them is blocked

| Track | Needs | State |
| --- | --- | --- |
| **A. Client, renderer, app** | a working pair over BLE | **unblocked.** Unit 2 does all of it. Current state is the board in `notes/parallel-tracks.md`, which is where tracks are claimed and closed |
| **B. SWD bring-up** | the probe | waiting on delivery |
| **C. Custom firmware on a device** | B | built and tested, no delivery route |

Track C is worth being precise about: **it is not stalled work, it is finished work
without a courier.** `firmware/joggles-v1.bin` builds reproducibly, and the hook and the
extension have been disassembled out of the built image and verified instruction by
instruction. What is missing is a way to put it on a device, and SWD is a better one than
OTA ever was: the argument, with the constraint table, is
`research/brick-2026-08-08.md`, "SWD is not just the repair, it is the better flashing
route".

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
  an inconvenience rather than a loss.
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

Read-only throughout, up to step 5. Nothing below can worsen unit 1's position.

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
6. **Only then:** erase the config page, read back `0xFFFFFFFF`, reset, see if it
   advertises. No script in `research/tools/` will do this; `swd-recon.sh` is read-only by
   construction and an erase belongs in a file of its own, written on the day.

**If unit 1 does not answer at step 3**, that is ambiguous between a bad setup and a dead
chip. Only then attach to unit 2, read-only, in a session with no write command loaded,
purely to prove the rig works.

## Track C: the order once flashing works

`joggles-v1` as-is first, since it is already verified, then the ranked patches in
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
