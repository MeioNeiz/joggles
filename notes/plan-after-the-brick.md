# Plan after the brick

**Situation:** unit 1 (`GLASSES-12C3EF`) is bricked by an OTA commit and waits on a
probe. Unit 2 works and is stock. The probe is ordered.
**Governing idea:** the brick blocks *delivery* of firmware, not the building of
anything else. Almost all the remaining work never needed firmware in the first place.
**Incident:** `research/brick-2026-08-08.md`. **Repair:** `research/hardware-access.md`.

## Three tracks, and only one of them is blocked

| Track | Needs | State |
| --- | --- | --- |
| **A. Client, renderer, app** | a working pair over BLE | **unblocked.** Unit 2 does all of it. Phase 0 landed 2026-08-09: the BLE sequencing is out of the CLI and behind `Transport`/`Scanner`, and `DATCP` is rate limited. `bun cli text` has not been re-run on hardware since |
| **B. SWD bring-up** | the probe | waiting on delivery |
| **C. Custom firmware on a device** | B | built and tested, no delivery route |

Track C is worth being precise about: **it is not stalled work, it is finished work
without a courier.** `firmware/joggles-v1.bin` builds reproducibly, the hook and the
extension have been disassembled out of the built image and verified instruction by
instruction, and 138 tests pass. What is missing is a way to put it on a device, and
SWD is a better one than OTA ever was.

So the sequencing is: **A now, B on delivery, C once B works.** A and B do not compete;
they use different units.

## Rules for unit 2, which is now the only working one

- **Never send it an OTA commit.** `bun run flash commit` refuses outright as of this
  session and needs `--ldrom-verified` to lift, which is a claim nobody can honestly
  make yet.
- `bun run flash stage` and `bun run flash info` remain safe and were both run against
  unit 1 with no harm. Staging commits nothing.
- **Dump it over SWD before it is ever put at risk.** A pristine 256 KB image of a
  working unit is the insurance that was missing this time. With it, a future mistake is
  an inconvenience rather than a loss.
- Everything in `notes/what-to-build.md` under "Do these first, no firmware required"
  is fair game on it today.

## The deadline, and why the brick does not threaten it

**Target: a working app by Tuesday.** Nothing on that path needs firmware.

The BLE protocol is solved and *verified on hardware*: `DATS`/`DATCP` upload works end
to end and returns `DATCPOK`, our own bitmap has been left scrolling unattended, the
rhythm channel sets all 24 columns atomically, and unit 2 is stock and healthy. The
firmware work was always **additive**, not foundational. A stock unit does everything
the app needs.

So the honest position is: the brick cost a unit and a night, and it cost **zero** days
of app progress. Losing a week would have meant losing the app; we lost neither.

## Track A: what to build now

Straight from `notes/what-to-build.md`, unchanged by the incident:

- **Sound-reactive spectrum through the rhythm channel.** Still the best festival
  feature, and the only atomic full-panel path.
- **Pre-rendered wide loops, then disconnect.** Up to 768 columns, radio off all night.
- **Text-my-glasses.** Highest delight per unit of effort.
- **Several pairs from one host.** The one-connection limit is per device, not per host.
- **A better renderer.** `DATS` reaches all 9 rows; proportional pixel fonts with real
  kerning; the 4 greyscale levels for anti-aliasing.

None of these touch firmware, and most are prerequisites for the firmware features
anyway: a tile palette needs a renderer to feed it, button-driven content needs content.
**Doing A first is what we would have wanted regardless.**

## Track B: the order of operations when the probe lands

Read-only throughout, up to step 6. Nothing below can worsen unit 1's position.

**Practise on the bricked unit, not the good one.** It is already dead, so a mistake
costs nothing, and it might simply work. The working pair is held back as a *control*,
used only if unit 1 stays silent.

1. `brew install open-ocd`. Config is already written: `research/tools/pan1020.cfg`.
2. Clip onto unit 1. Wiring map, clip pin 1 aligned to the `RST` pad:

   | Clip pin | Silkscreen | Wire to |
   | --- | --- | --- |
   | 1 | `RST` | spare jumper, free end touched to ground only when needed |
   | 2 | `EK` | probe `SC` **or** `SD`, either way round |
   | 3 | `ED` | the other of `SC` / `SD` |
   | 4 | `G` | probe `GND` |
   | 5 | `VD` | **nothing, ever** |
   | 6 | overhangs the row | nothing |

   `EK` and `ED` are clock and data in an order nobody has established. It does not
   matter: swapping SWCLK and SWDIO cannot damage anything, it just fails to enumerate.
   Try one way, run `dap info`, swap if silent.

   The probe's JST-SH is pin 1 `SC`, pin 2 `GND`, pin 3 `SD`, ground in the middle. The
   board puts ground at pad 4, after both signals, so no rigid 3-way housing can make
   the mapping. Hence loose jumpers.

   **Check the alignment before powering the glasses.** The clip is 6 pins against 5
   pads, so it can sit one position out. Slipping one way puts the probe's `GND` on
   `VD`, which shorts the 3.3 V rail to ground through the LDO. Every other
   misalignment merely fails to connect and is harmless. Clip on, eyeball pin 1 against
   `RST`, then switch on.
3. `./research/tools/swd-recon.sh probe`. A DPIDR of `0x0bb11477` means the port is
   alive. Then `swd-recon.sh ids` and record the part ID at `0x50000000`.
4. **Read `0x00300000`.** This is the whole postmortem in one word: **expect
   `0xFFFFFF3F`**. If it reads that, the diagnosis is confirmed end to end and the
   repair is a single page erase.
5. **Read `0x16800`** and diff against `ota.plaintext()` of the stock container. Intact
   means the fault is purely boot-select. Blank or garbage means the bootloader ran and
   half-wrote APROM, which is still fixable but needs a full reflash.
6. **Read `0x00100000` and `0x0003dc00`.** The LDROM question. Whichever is blank says
   where the boot went, and nobody on this hardware family has ever looked.

   Steps 4 to 6 are one command, `./research/tools/swd-recon.sh diag`, which is the
   four reads from `research/brick-2026-08-08.md` and nothing else.
7. Full `dump_image` of all 256 KB, three times from cold, compared. First dump of a
   Panchip unit that exists. `swd-recon.sh dump <out>` each time, then
   `bun run dumpcheck compare <a> <b> <c>`: repeat reads that disagree mean the rig is
   unreliable, and that failure looks exactly like a device changing underneath you.
8. **Only then:** erase the config page, read back `0xFFFFFFFF`, reset, see if it
   advertises. No script in `research/tools/` will do this; `swd-recon.sh` is read-only
   by construction and an erase belongs in a file of its own, written on the day.

**If unit 1 does not answer at step 3**, that is ambiguous between a bad setup and a
dead chip. Only then attach to unit 2, read-only, in a session with no write command
loaded, purely to prove the rig works.

**The checker is written**, so step 5 is not a diff by hand:

    bun run dumpcheck <dump.bin> --config0 <word> --ldrom <word>

`research/tools/dumpcheck.ts` diffs the dump's `0x16800` region against
`ota.plaintext(firmware/TR1906R04-10_OTA.bin)`, which proves the dump is good and
confirms the flash map in the same comparison, far stronger than a vector-table sanity
check. It also censuses every region for erased pages, decodes `CONFIG0` (`0xFFFFFF3F`
is called out by name as the brick signature), and reports whether the staging bank
still holds the image that was staged. Exit code answers only "can this dump be
trusted", so a bricked unit with an intact application exits 0.

Two things it does **not** do, both deliberate: it never talks to a device, and it
makes no claim about the `0x16800` words being a vector table. They are not. The
application image begins with a head whose first two words in stock are `0x00026904`
and `0x03010100` (*verified* against the container), so judging them as SP and reset
vector reports a failure that is not one.

## Track C: what unlocks, and it is more than we had

SWD writes `0x16800` directly, so the staging bank, the CRC handshake, the info record,
the `CONFIG0` change and the bootloader are all absent from the path. The component that
bricked unit 1 is not involved.

It also dissolves the constraint that shaped the whole firmware design.
`PROTECTED_REGIONS` exists because OTA recovery needs the running app to bring up BLE
and expose `fd00`. Over SWD it does not, so the GATT table, the OTA handler, the flash
driver and the descrambler all become editable, and the ranked patch list in
`notes/what-to-build.md` stops having a self-sealing category.

Order once flashing works: `joggles-v1` as-is first, since it is already verified, then
the ranked patches, cheapest first.

## What this session actually cost

One unit, and a lesson that is cheap at the price if it is written down: **do not commit
on top of an unverified component.** Staging was verified end to end on hardware. The
bootloader was never verified at all, and the commit handed control to it. The docs said
it was unverified and it was read as a to-do rather than a stop.

Against that, the same session produced the OTA transport, the `fd00` wire format with
the 2-byte packet header nobody had recorded, the first opening of one of these units,
the 16 MHz crystal correction, and a firmware image proven correct by disassembling what
we actually built. None of that is lost.
