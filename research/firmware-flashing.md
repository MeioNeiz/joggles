# Flashing: what is safe, what is not

> ## STOP. A stock-over-stock OTA bricked our unit on 2026-08-08.
>
> Everything below about *staging* held up on hardware and is still trustworthy. The
> **commit** step is not. Read "Incident: the commit that did not come back" before
> sending ctrl `03` to anything.
>
> The verdict table below was written before that happened and is left as it was, so
> the mistake is visible rather than tidied away. The rows about aborted transfers are
> still correct. The row claiming a brick is "avoidable" was wrong.

**Status:** the OTA state machine has been disassembled out of our own image and
cross-checked line by line against Panchip's published SDK source. The two agree.
**Verdict: staging is safe. Committing is not, on this variant.** The transfer is
staged in a separate flash bank and the running application is never erased, so an
aborted or corrupt transfer costs nothing. What costs everything is ctrl `03`.
**Scope:** corrected flash map, the OTA state machine as this device implements it,
the size envelope, the safe procedure, and the one brick vector reachable over the air.
**Reproduce:** see "Reproducing the disassembly" at the end.

**On the ethics of flashing a product we did not make:** `notes/firmware-design.md`, "Whose
glasses these are, and why modifying them is fair". Short version: own units only, no vendor
binaries redistributed, patch in place so a unit returns to stock, and the risks fall on us.

Offsets here are `abs`, i.e. flash addresses. `body` offsets into the deobfuscated
OTA payload relate to them by `abs = body + 0x16800`.

## Verdict

| Question | Answer | Confidence |
| --- | --- | --- |
| Can we stage an image over BLE? | yes | verified on hardware |
| Does a failed or aborted transfer break the device? | no, nothing is committed | verified on hardware |
| ~~Can we restore the stock image ourselves over BLE?~~ | **no. This was wrong** | falsified: committing stock over stock bricked the unit |
| Is there a signature check to defeat? | none, anywhere | verified |
| Can an OTA brick the device? | ~~yes, two ways, both avoidable~~ **yes, and the third way is the commit itself** | verified the hard way |
| Are physical tools required? | **yes, before the first commit, not after** | corrected |

The residual risk was described here as shipping a valid-CRC image that boots but
fails to bring up BLE. **That framing was wrong, and it is the error that cost a
unit.** It assumed the handoff back into the application always works, so the only
thing that could go wrong was the image. The handoff is the part that failed, on an
image that could not have been wrong. See "Incident" below.

## Incident: the commit that did not come back

*verified*, the expensive way, on 2026-08-08. Unit `GLASSES-12C3EF`, `TR1906R04-10`.

**What was done.** `bun run flash commit firmware/TR1906R04-10_OTA.bin --yes`: the
**stock image, byte-identical to what the unit was already running**. No patch, no
novel code. Staging completed, 3672 packets in 221s. The device's own hardware CRC over
the staging bank matched and it replied `80 03 00`. It reset itself and has not
advertised since. It still charges; the charge LED is driven by the charger IC, not the
MCU, so it says nothing about whether the MCU boots. The battery was not low.

**So the failure is in the handoff, not the image.** Nothing about the payload can be
blamed: the device verified those exact bytes itself.

**Leading hypothesis: there is nothing usable in LDROM.** `abs 0x1ca4c` writes
`CONFIG0 = 0xffffff3f`, clearing bits 7:6. On this Nuvoton-derived FMC those are `CBS`,
and `CBS = 00` means boot from LDROM. `abs 0x1ca62` then resets. From that instant the
device depends entirely on a bootloader at `0x3dc00` copying the staged image back and
handing control to APROM. **This document always listed that bootloader as unverified
and it was never checked.** If it is absent, stubbed, or does not restore `CBS`, the
unit boots into nothing, which is exactly the observed symptom.

**Two signals that were visible beforehand and were not weighted.**

| Signal | What it should have meant |
| --- | --- |
| ctrl `01` replied `app=0 dev=0 pro=0` | the unit's own OTA version struct is zeros. A subsystem that has never run in production looks like this. It was noticed, called "suspicious", and passed over |
| the vendor app refuses an OTA when the version major is >= 10, and ours reports 10 | read here as "the vendor app is not a recovery route for us". The other reading, **the vendor deliberately does not OTA these units**, is at least as well supported and was never considered |

**What is probably still true.** The application region at `0x16800` is never erased by
the OTA path, which is *verified* from the disassembly. The original firmware should
still be intact. If the only damage is the boot-select bits, rewriting `CONFIG0` over
SWD revives it, and `hardware-access.md` rates that case "yes, looks dead but SWD still
answers". One command separates the cases: if SWD attaches and flash reads back as
anything other than all-`FF`, the firmware is there and this is a config fix.

**Rules that follow.**

- **Do not send ctrl `03` to a `TR1906R04-10` unit** until the LDROM has been dumped
  over SWD and confirmed to contain a bootloader that restores `CBS`.
- Staging is still safe and still worth doing: it exercises the entire data path and
  commits nothing. `bun run flash stage` was run against this unit first and left it
  completely unharmed.
- **Have SWD before the first commit, not after.** Insurance bought after the fire is
  not insurance. `hardware-access.md` said this and was treated as optional.
- An unexplained reading from a device is a stop condition, not a footnote.

## Corrected flash map

| Range | Size | Contents | Confidence |
| --- | --- | --- | --- |
| `0x00000` - `0x167ff` | 90 KB | BLE stack (SoftDevice). Not in any OTA file | verified |
| `0x16800` - `0x293ff` | 76.8 KB | application region. Stock occupies 66,084 of it, `joggles-v1` 66,172, ending at `abs 0x26a7c` | verified |
| `0x29400` - `0x3bfff` | 76.8 KB | **OTA staging bank.** Scratch, contents disposable | verified |
| `0x3c000` - `0x3c5ff` | 1.5 KB | saved user content (`DATS` uploads) | derived |
| `0x3c800` | 8 B | saved-content metadata | derived |
| `0x3d800` / `0x3da00` | 512 B each | section info page and its backup | verified |
| `0x3dc00` - `0x3fbff` | 8 KB | **bootloader**, per the SDK. Never written by an OTA | derived |
| `0x3f000` | 4 KB | **not referenced by the application at all.** See below | verified |
| `0x100000` | - | LDROM window | derived |

The vendor kept Panchip's stock layout and dropped their saved-content buffer at
`0x3c000`, immediately above the staging bank. That adjacency is the source of the
size hazard below.

**Where the two outer boundaries come from.** `abs 0x16800` is not a vendor choice; it is
the stock SDK boundary between stack and application. *verified* from Panchip's
`section_cfg.h`, which defines `FLASH_SOFTDEVICE_SIZE 0x00016800` and
`FLASH_BOOTLOADER_ADDR 0x0003DC00`. So the ~90 KB below our app base is the **BLE stack**
(Panchip call it the SoftDevice, having borrowed Nordic's vocabulary), and the bootloader
is 8 KB at the *top* of flash rather than below the application.

**There is a vendor image for the stack region, if it is ever needed.** The public SDK
ships `src/stack/softdevice/stack_1.0.0.hex`, spanning `0x0` to `0x1677c` (92,028 bytes),
which is exactly that region. *verified* by parsing the hex. Whether it is the same stack
build our unit runs is *unverified*, so it is a fallback, not a drop-in.

**The staging base is not a literal anywhere in the application.** It is a runtime value
loaded from the const table at `abs 0x26930`, which is why scanning the image for literals
found nothing and left the staging question looking open for a while. Two independent
confirmations are under "Evidence for the staging base".

**The `0x3f000` overlap was a phantom, and this dissolves it.** This document
previously recorded a 4 KB "vendor data sector" at `0x3f000` "referenced 7 times", and
then an unresolved contradiction: the SDK's 8 KB bootloader at `0x3dc00` runs to
`0x3fbff` and would swallow it, so both could not be true.

**All 7 of those references are false positives.** Every one lies inside the animation
bank data at `abs 0x22df8`-`0x268f6`, i.e. they are frame bitmaps that happen to
contain the byte pattern. *verified*: the value appears as a 32-bit word 7 times, all
inside that range, and there are **zero** LDR sites loading it and zero `movs`/`lsls`
pairs constructing it. By contrast `0x3c000`, `0x3c800` and `0x29400` each have exactly
one occurrence outside bank data, in the tail `.data` initialisers at `abs 0x26988`,
`0x2698c` and `0x26930`, which is where real pointers live.

So the application does not use `0x3f000`, the SDK's 8 KB bootloader reservation stands
unchallenged, and there is no contradiction to resolve. Keep treating everything from
`0x3d800` upward as untouchable; the size limits below already enforce it, and staging
cannot reach that far in any case.

**Do not over-read this.** It establishes only that the *application image* contains no
reference. The BLE stack below `abs 0x16800` and the bootloader are outside anything we
can see, and either could still use the sector. That remains an SWD-era question, not an
OTA one.

Both scanning traps this was an instance of are canonical in the header of
`research/tools/fwtool.ts`; use it rather than grep. Claims of *absence* survive the noise,
so the peripheral-absence scan in `firmware-internals.md` is not in doubt.

## What the device actually does

Disassembled from `TR1906R04-10_OTA.bin`; the handler occupies `abs 0x1ea00` to
`0x1ee20`. All *verified* unless marked. Every row below was re-derived from bytes in
a second, independent pass and agreed, so this table can be trusted.

**Trap when re-reading it.** `abs 0x1ea14` dispatches on a byte compared against 2, 4
and 5. Those are **GATT event types**, not ctrl opcodes: 2 is the data write on
`fd01`, 4 the ctrl write on `fd02`, 5 a CCCD write. The ctrl opcode dispatcher is
further in, at `abs 0x1ebc2`, and it tests 1, 2 and 3. Reading the first one as the
opcode set produces a confident and wrong "opcode 4 exists".

| Step | Device behaviour |
| --- | --- |
| ctrl `01` version | records the three version words, replies `80 01` plus 6 bytes. Writes no flash |
| ctrl `02 <type> <size32>` | zeroes the counters, sets a section flag from `type`, stores `size`. **Writes no flash** |
| data on `fd01` | **skips the first 2 bytes of the write**, appends the rest to a 512-byte SRAM buffer at `0x20002970`. On each full page: descramble in RAM, erase one page at `0x29400 + offset`, program 512 bytes, `offset += 512`. ACKs `80 04` **on every write, not every page** |
| ctrl `03 <crc32>` | hardware CRC-32 over `[0x29400, size)`, compared with the host's value. On match only: erase `0x3da00`, write the handoff record, read it back. Replies `80 03 00` |
| ctrl `04` | **no handler.** The dispatcher tests 1, 2 and 3 only, so this is a no-op |

Then the bootloader at `0x3dc00` copies the staged image to its destination. How
control reaches it is now *verified*, see "The handoff" below; it is not the passive
"reads the record on the next boot" this document previously assumed.

Three details that matter:

- **The running application is never erased.** Erase and program only ever target
  `0x29400 + offset`, the info page at `0x3da00`, and `CONFIG0` (see below). A
  Cortex-M0 executing in place could not erase itself anyway.
- **The OTA data and commit paths never enable config writes.** All four flash sites
  inside the OTA handler (`abs 0x1eace`, `0x1eb6a`, `0x1ec46`, `0x1ecbe`) set `ISPCON`
  bit 3 (`APUEN`, APROM update) and nothing else. *verified* by auditing every one of
  the 16 sites in the image that loads the FMC base `0x5000c000`.
- **But the firmware as a whole does write `CONFIG0`,** in the handoff step that runs
  after a successful commit. The earlier claim here that "the classic permanent brick
  is unreachable" was **wrong**; see the next section.
- **`codeSize` must be a multiple of 4.** The final partial page is written as
  `remainder >> 2` words, so up to three trailing bytes are dropped silently and the
  CRC then fails. Both stock images comply (65,824 and 66,084).

### The handoff: the application reboots itself into the LDROM

*verified* from bytes, and it corrects two entries in this document.

After the CRC matches and the record is written, the application does **not** wait
passively for the next boot. It reprograms `CONFIG0` to boot from LDROM and resets:

| Site | What |
| --- | --- |
| `abs 0x1c9c8` | handoff function. Reads the record at `0x3da00` into RAM `0x20002d70` |
| `abs 0x1ca28` | gates on `record[0xc]` being `0xdbd2` or `0xdbc3`. Otherwise returns |
| `abs 0x17a78` | config writer. `ISPCON \|= 0x10` (`CFGUEN`), page-erase `0x00300000` |
| `abs 0x1ca4c` | writes `CONFIG0 = 0xffffff3f`, clearing the boot-select bits |
| `abs 0x1ca62` | `AIRCR` `SYSRESETREQ`, then spins |

`0x17a78` has exactly one caller and `0x1c9c8` has exactly one caller, so this runs
only on a successful OTA commit. *verified* by scanning every BL in the image.

That `CONFIG0` is the security lock and boot-select register is *derived*: the bit
semantics are Nuvoton's, applied to a Panchip part. What is *verified* is that the
firmware sets `CFGUEN` and erases and programs `0x00300000`.

**Consequences.**

- **The unrecoverable power window is at commit, not at the next boot.** A brown-out
  during the `CONFIG0` erase-and-program is the one case `hardware-access.md` rates
  as possibly not recoverable even by SWD. Charge the unit before flashing, and treat
  the seconds after ctrl `03` as the critical moment.
- **Whether the device reboots itself after ctrl `03` is now answered: it does.**
  This was previously listed as unverified.
- **The handoff is a patchable single point of failure.** Break `abs 0x1c9c8` and
  OTAs will stage, pass CRC and write the record, then never apply. The unit keeps
  working and can never be updated again, which is the worst kind of soft brick
  because nothing looks wrong. It is not currently in `ota.check`'s protected
  regions; see "Safeguards, in code".

### The exact packets, and the two bytes this document used to omit

*verified* twice over: read off the handler, then checked against the vendor's
`PanchipOtaManager` and `FileInfo` in `decompiled/`. Where those two agree there is no
remaining doubt about the wire format. Implemented in `packages/core/src/dfu.ts`.

| Direction | Bytes |
| --- | --- |
| ctrl `fd02` | `01 <appVer16> <devVer16> <proVer16>` |
| ctrl `fd02` | `02 <type8> <codeSize32>` |
| ctrl `fd02` | `03 <crc32>` |
| data `fd01` | `<index16> <payload...>` |
| notify `fd02` | `80 01 <6 bytes>` / `80 02 <status>` / `80 03 <status>` / `80 04` |

All multi-byte fields little-endian; `status` 0 is success.

**Every `fd01` write starts with two bytes the device throws away.** The earlier
"appends to a 512-byte SRAM buffer" row said nothing about this and was wrong by
omission. The handler computes `src = value + 2` and `n = length - 2` (`abs 0x1ea56`),
and the vendor app accounts for its own payload as `packetSize - 2`. It is a packet
index and **nothing reads it**, so its only job is to occupy those two bytes. Omit it
and the first two bytes of every packet are eaten; the CRC catches that at the *end*
of a full transfer, so the symptom is a wasted upload rather than a wrong flash.

**The stream is the container body, still obfuscated, from body offset 0.** The device
descrambles each 512-byte page itself, restarting the 128-byte pad every page. That
agrees with a single `deobfuscate()` over the whole body only because 512 is a whole
number of pads, which `dfu.test.ts` asserts rather than assumes. Sending plaintext, or
including the 16-byte file header, stages garbage.

**The `80 04` ack is per write, not per page**, which is the only flow control there
is: `fd01` is write-without-response. The vendor app sends the next packet from the
ack handler, and so do we.

### The `type` byte

`type` selects a section flag, and the flag tells the bootloader where the staged
image belongs.

| `type` | Flag written | Meaning |
| --- | --- | --- |
| 1 | `0xDBC3` | `SECTION_APP_FLAG`, destination `0x16800`. Both stock images |
| 2 | `0xDBD2` | `SECTION_SOFTDEVICE_FLAG`, destination `0x0`, the BLE stack |
| other | previous value left in SRAM | undefined |

**Our firmware diverges from the stock SDK here, in our favour.** Stock
`ota_server_task.c` redirects the *staging address* to `0x23000` for softdevice
images, which sits inside the running application and would erase it mid-transfer.
Our unit does not: the start handler never touches the staging pointer, the CRC step
hardcodes `0x29400`, and neither `0x23000` nor `0x12c00` appears anywhere in the
image. *verified.* So `type 2` will not eat the running app on this unit. It would
still tell the bootloader to overwrite the BLE stack with whatever was staged, which
is catastrophic in a slower way. **Only ever send `type 1`.**

### Evidence for the staging base

Two independent confirmations that staging is at `abs 0x29400`:

1. The const table at `abs 0x26930` holds `0x20002970` and `0x00029400` in adjacent
   words, the same pair the handler loads as (RAM page buffer, flash write base).
2. The CRC step computes the hardware CRC-32 from `0x29400` for `codeSize` bytes,
   built as the immediate `0xa5 << 10`. Stock images pass that check, so the data
   they wrote must be there.

This also matches the SDK exactly: `FLASH_APP_ADDR 0x16800 + FLASH_APP_SIZE 0x12C00`
is `0x29400`.

## The size envelope, and the one brick vector

The firmware rejects `codeSize` of 0 or `>= 0x19000` (102,400). That bound is too
generous for the actual flash layout, and it is the only way an OTA can permanently
brick this device.

| Image size | What it reaches | Outcome |
| --- | --- | --- |
| <= 66,084 (stock) | staging bank only | safe |
| <= 76,800 (`0x12c00`) | staging bank only | safe, the real ceiling |
| > 76,800 | saved user content at `0x3c000` | loses saved content, recoverable |
| > 82,944 (`0x14400`) | info page and backup | bootloader loses its handoff record |
| > 83,968 (`0x14800`) | **the bootloader at `0x3dc00`** | **unrecoverable without SWD** |
| >= 102,400 | rejected by the firmware | safe, refused |

So the device will happily accept an image that erases its own bootloader. *verified*
from the bound check at `abs 0x1ea90` against the map above.

**Keep custom images at or below the stock 66,084 bytes while the goal is patching
behaviour.** That leaves 10,716 bytes untouched, and a pure behaviour patch has no reason
to grow.

**Adding a subsystem is the exception, and it is now the normal case.** The firmware
extension appends code into exactly that headroom, so it necessarily exceeds 66,084; v1
lands at 66,172. The binding ceiling is then **76,800** from the table above, and
`research/tools/patch.ts` refuses to emit past it. `ota.check` reports `larger-than-stock`
as a warning on every such build, which is expected rather than a problem: the fatal size
findings are the ones that matter. See `notes/firmware-design.md`.

## Safe procedure

Ordered cheapest and least committal first. Steps 1 to 3 cannot damage anything.

The client is `packages/cli/src/flash.ts`, run as `bun run flash`. Its three
subcommands are exactly steps 2, 3 and 4 below, and it refuses to send any image that
has not passed `ota.check` against the stock baseline. **Step 4 is struck and `commit` is
barred in the client itself**: without a `--ldrom-verified` flag it prints the 2026-08-08
brick and exits 2 before it touches Bluetooth, and `--yes` on its own no longer gets past
it. Steps 1 to 3 are all anyone should be running today.

1. **Enumerate.** Confirm the device exposes `fd00` alongside `fff0` in one discovery
   pass. Zero risk. `bun run flash info` fails with a clear message if `fd01`/`fd02`
   are absent.
2. **Read the version.** `bun run flash info`. Sends ctrl `01` on `fd02` and reads
   `80 01` plus 6 bytes. Writes no flash and proves the OTA stack responds.
3. **Prove staging without committing.** `bun run flash stage <image> --limit 4096`.
   Sends ctrl `02 01 <size>`, streams the first few KB, then disconnects **without
   sending ctrl `03`**. Nothing is committed: the staging bank is scratch and the info
   page is untouched. The device should come back still reporting `TR1906R04-10`. This
   is the discriminating test for the whole staged-versus-in-place question on real
   hardware.
4. ~~**Re-flash the stock image.** `bun run flash commit` on the stock container, with
   `--yes`.~~ **Struck: this step bricked a unit.** The command it used to spell out here
   is the one that killed `GLASSES-12C3EF` on 2026-08-08, quoted verbatim under
   "Incident: the commit that did not come back" above and in
   `research/brick-2026-08-08.md`. Staging completed, the device's own hardware CRC over
   the staging bank matched, it replied `80 03 00`, reset itself, and has never advertised
   since. The reasoning written here was that stock over stock carries zero novel-code
   risk. That is true and it was irrelevant: the image was never the risk, the handoff
   into LDROM is.

   **The command now refuses to run.** `packages/cli/src/flash.ts` checks for a
   `--ldrom-verified` flag before it opens the Bluetooth adapter; without it, `commit`
   prints the brick, points at `research/brick-2026-08-08.md`, and returns 2 having sent
   nothing. `--yes` is still required as well, and on its own does nothing. **Only an
   LDROM dump over SWD, showing a bootloader that restores `CBS`, honestly supports
   passing that flag, and nobody has dumped it.** Do not pass it to silence the tool.

   One fact from this step is still worth having, because `stage` needs it too:
   `firmware/TR1906R04-10_OTA.bin` matches our unit (version string `TR1906R04-10` at
   `abs 0x1e008`, `appVer 3`). Do **not** use `TR1906R04-1-10_OTA.bin`; that is the other
   hardware variant, string `TR1906R04-01-10`, `appVer 1`, and `ota.check` refuses it as
   `wrong-variant`.
5. **Only then patch, and not by hand.** `bun run build-firmware` composes the image:
   stock, plus one dispatcher hook, plus the extension. Every in-place edit goes through
   `research/tools/patch.ts`, which declares the bytes it expects to overwrite and aborts
   the build on a mismatch, and that is the only layer that catches an address read out of
   a disassembly one instruction off. Then `bun run ota-check <image>` before it goes
   anywhere near a device. *Corrected: this step used to read "modify bytes in the decoded
   plaintext, keep the length identical, re-encode with `research/ota-codec.ts`, flash".
   The identical-length rule was true only before the extension existed. `joggles-v1`
   appends 88 bytes and is 66,172 against stock's 66,084, so lengths are deliberately not
   identical.* Length preservation still holds for **edits**, which is what keeps `expect`
   meaningful and stops any existing address moving; new code is **appended** past the end
   of stock instead. The binding ceiling is **76,800 bytes** and `patch.ts` refuses to emit
   past it. Flashing the result is blocked on the same bar as step 4, so today this step
   ends at `stage`.

Note that the vendor app is not a recovery route: it offers an OTA only when the
version major is under 10, and ours reports 10. Our own client has no such gate, and
the **device** does not check versions at all. *verified*: the start handler never
compares them.

## Safeguards, in code

Everything above that can be enforced mechanically is enforced in
`packages/core/src/ota.ts`. Its flash-map constants deliberately mirror Panchip's
`section_cfg.h`, names included, so the two can be diffed by eye.

    bun run ota-check <image.bin> [stock.bin]

Touches no Bluetooth and writes nothing, so it is always safe to run. It exits 1 on a
fatal finding, and `ota.check()` is the gate any future BLE write path must pass
before sending a byte.

What it refuses outright:

| Finding | Why |
| --- | --- |
| `softdevice-image`, `unknown-type` | type 2 aims the bootloader at the BLE stack; anything else leaves a stale flag |
| `erases-bootloader` | over 83,968 bytes, recoverable only by SWD |
| `erases-info-page` | over 76,800 bytes, destroys saved content and the info pages |
| `device-rejects` | at or above the device's own `0x19000` bound |
| `not-word-aligned` | trailing bytes are dropped, so the CRC then fails |
| `crc-mismatch`, `size-mismatch` | container is internally inconsistent |
| `bad-stack-pointer`, `bad-entry-vector`, `entry-out-of-range` | will not boot; an image linked for the wrong base is the classic brick |
| `wrong-variant` | the image is the other hardware revision |
| `protected-region` | the patch edits something that makes a bad flash unrecoverable |

That last one is the important one. Pass the stock image as the second argument and it
diffs the two, refusing any edit that lands in the image head, the FMC flash driver,
the OTA handler, the payload descrambler or the GATT table. Those regions are what let
us flash our way out of a mistake, so editing them is self-sealing. There is an
`allowProtectedRegions` option and deliberately no CLI flag for it: reaching it should
require editing code.

### The guard has holes, and they are in the flash path itself

*verified* by resolving every LDR in the image that loads `FMC` (`0x5000c000`) or
`SYS_REGLCTL` (`0x50000100`) and testing each against `PROTECTED_REGIONS`. **21 of the
41 sites fall outside every declared region.** Most are harmless, but three are not.

| Gap | Extent (body) | Why it matters |
| --- | --- | --- |
| **Flash program primitive** at `abs 0x1904c` | `0x284c`-`0x28a4` | **entirely unprotected.** It is the routine that writes staged pages, called three times and only from the OTA handler (`abs 0x1eaf6`, `0x1eb94`, `0x1ece6`). Patch it and the OTA can never write flash again |
| **FMC driver region stops short** | declared to `0x1290`, block runs to `0x1322` | the config writer's erase is covered but its *program* sequence at `abs 0x17aac` is not, so an edit there can write an arbitrary `CONFIG0`. That is the permanent brick |
| **Handoff and reset function** at `abs 0x1c9c8` | `0x61c8`-`0x628c` | flips the boot select and resets. Break it and OTAs stage, pass CRC, write the record, and never apply. The unit keeps working and can never be updated again |

Corrected bounds, for whenever `ota.ts` is updated:

    { name: 'FMC flash driver',        start: 0x1118, end: 0x1322 }   // was end 0x1290
    { name: 'flash program primitive', start: 0x2840, end: 0x28a8 }   // new
    { name: 'OTA handoff and reset',   start: 0x61c0, end: 0x6290 }   // new

The remaining **16** uncovered sites are `SYS_REGLCTL` writes in clock and power init,
plus the two `DATS` saved-content writers at `abs 0x214c4` and `0x21508`. Breaking those
costs saved content, not recoverability, so they are deliberately left out.
*Corrected: this said 18, which predates the three regions being added. The number the
audit prints is 16, and `fwtool regions` asserts it.*

**`ota.ts` now carries all three**, so the sentence that used to stand here, warning that
`ota-check` would pass a patch removing our own way back, no longer applies. Left as a
correction rather than deleted, because the gap was real and the reasoning that found it
(resolve every FMC and REGLCTL load, test each against the region list) is the method to
repeat whenever the regions change. `bun research/tools/fwtool.ts regions` re-runs it.

Both stock images are used as test fixtures where `firmware/` is present, so the guard
is checked against real vendor data rather than only synthetic images.

## Hard don'ts

- **Do not relink.** Build a new image from scratch and you own the BLE bring-up, the
  OTA service and the interrupt vectors. Get any of it wrong and there is no way back
  over the air. Patch the stock image in place instead: same entry point, no existing byte
  moved, new code appended past the end. *Corrected: this said "same length", which the
  extension build falsifies. Edits are length-preserving; the image as a whole is not.*
- **Do not send `type 2`.** It aims the bootloader at the BLE stack.
- **Do not exceed 76,800 bytes.** *Corrected: this also said "prefer staying at 66,084",
  which is impossible for any build carrying the extension, since 66,084 is exactly the
  stock length. It applies to pure behaviour patches only; `joggles-v1` is 66,172.*
- **Do not remove or break the `fd00` service, the advertising, or the connection
  handling.** Those are the recovery path. Treat them as untouchable.
- **Do not power the device from a flat battery during a commit.** The transfer itself is
  safe to interrupt. The window with no protection is the `CONFIG0` erase-and-program
  immediately after ctrl `03`, then the bootloader's copy on the reboot it triggers. See
  "The handoff".

## Still unverified

- Whether the bootloader validates the staged image before copying, and what it does
  when the record is absent or the flag is unrecognised. This decides whether a bad
  image can be superseded by simply staging a good one.
- Whether the bootloader offers any recovery transport. Panchip's `dfu_source_t`
  enumerates `DFU_SOURCE_OTA = 1` and `DFU_SOURCE_UART = 2`, which hints at a UART
  ISP path, but no pins or entry conditions are documented for this part.
- Whether a second staging attempt can supersede a bad one, i.e. whether the
  bootloader re-validates on every boot or only when the record says so.
- What lives in the 4 KB sector at `0x3f000`. Narrowed: the application never touches
  it (see the flash map), so this is only a question for SWD work, not for any OTA.
  Whether the stack or bootloader uses it is still unknown.
- Whether `stack_1.0.0.hex` from the public SDK matches the stack our unit runs.

## Reproducing the disassembly

macOS Command Line Tools ship `llvm-objdump`, which is enough; there is no
`arm-none-eabi` and no `objcopy`. llvm-objdump will not read a raw binary, so the image
needs wrapping in a minimal ELF first. The wrapper is `research/tools/mkelf.ts`.
*Corrected: this used to say both helpers lived in the scratchpad as one-offs. `mkelf.ts`
is in the repo, and reaching for objdump has since become routine enough that it should
be.*

    bun research/ota-codec.ts decode firmware/TR1906R04-10_OTA.bin /tmp/fw10.bin
    bun research/tools/mkelf.ts /tmp/fw10.bin /tmp/fw10.elf 0x16800
    OD=$(xcrun --find llvm-objdump)
    $OD -d --triple=thumbv6m-none-eabi --start-address=0x18240 \
        --stop-address=0x182d0 /tmp/fw10.elf

`xcrun --find` beats a hardcoded path under `/Library/Developer`, and the address window
beats dumping the whole image to a file and searching it: pass the `abs` addresses
straight through, because `mkelf.ts` sets the load address to `0x16800`.

**Do the same on the built image, not only on stock. Reading back what we intend to flash
is the check that closes the loop**; everything else only verifies the inputs. Decode
`firmware/joggles-v1.bin` the same way, since it is a container too:

    bun research/ota-codec.ts decode firmware/joggles-v1.bin /tmp/v1.bin
    bun research/tools/mkelf.ts /tmp/v1.bin /tmp/v1.elf 0x16800

Landmarks, all at `abs` addresses:

| Address | What |
| --- | --- |
| `0x17918` / `0x179ac` | FMC `ISPEN` disable / enable |
| `0x17928` | page erase, `ISPCMD 0x22`, address only |
| `0x17958` | hardware CRC-32: `ISPCMD 0x2d` to calculate, `0x0d` to read |
| `0x179bc` | word read, `ISPCMD 0x00` |
| `0x1ea00` - `0x1ee20` | the whole OTA handler |
| `0x1f988` | XOR descrambler, called as `(buf, 128 words, 0x37627996)` |
| `0x26900` | const config table: SRAM struct base, page buffer, staging base |

`0x50000100` is `SYS_REGLCTL`; the `0x59`, `0x16`, `0x88` write sequence around every
flash operation is Nuvoton's standard register unlock.

## Sources

- Panchip PAN1020 SDK, mirrored at [hao0527/BLE_APP](https://github.com/hao0527/BLE_APP)
  and [tao0804/BLE](https://github.com/tao0804/BLE). `src/application/ota/section_cfg.h`
  is the flash map; `src/platform/driver/inc/fmc.h` defines `FMC_ISPCMD_CAL_CRC32 0x2D`
  and `FMC_ISPCMD_READ_CRC32 0x0D`.
- [PAN1020 datasheet](https://www.panchip.com/static/upload/file/20191011/1570778962386423.pdf).
- [Nuvoton AN0001, code protection](https://www.nuvoton.com/export/resource-files/AN0001_NuMicro_Cortex-M_Code_Protection_EN_V1.00.pdf),
  for the `CONFIG0` LOCK and CBS semantics the FMC inherits.
