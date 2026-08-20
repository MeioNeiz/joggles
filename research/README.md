# Joggles research index

Entry point for the reverse-engineering findings. Each document below is
self-contained: read only the one that matches your task.

| Document | Covers | Read it when |
| --- | --- | --- |
| `aprom-write-2026-08-20.md` | **The repair, and the first APROM write anyone has done on this family.** `GLASSES-12C3EF` brought back from twelve days dead: the numbers, the granularity probe and why it reads the page *before* the erased one, the interrupted first pass and what `--resume` found, and the three wrong turns between "the script says DONE" and a unit that advertises | **Before flashing anything over SWD**, and before concluding a flashed unit is dead |
| `variant-mismatch-2026-08-19.md` | **No pair here runs the variant this repo assumed.** The fleet is `TR1906R04-12` and `ota.DEVICE_VERSION` was `-10` lifted from the APK, so the gate was measuring donors against the image that bricked unit 1. Plus the two identity proofs: both units share a BLE stack byte for byte, and unit 1's orphan tail is **its own original application**. The erase-block alignment arithmetic per block size | Before trusting a variant string, comparing two units, or assuming `0x16800` is safely aligned |
| `brick-2026-08-08.md` | **A stock-over-stock OTA commit bricked a unit.** Exact mechanism, why it was recoverable, and the SWD repair that recovered it on 2026-08-20 | **Before any OTA commit, without exception** |
| `firmware-flashing.md` | **Is it safe to flash?** OTA state machine, corrected flash map, size envelope, safe procedure. Staging verified on hardware; **committing is barred** | Before writing a single byte of flash |
| `firmware-internals.md` | **What the firmware is.** The UART display module, the on-board button, the real 11-opcode dispatcher, the animation engine, the `DATCP` gate and why type 2 never reaches flash, what a patch buys | Deciding whether to patch at all, or hunting a capability |
| `ldrom-2026-08-19.md` | **The bootloader, read.** What it does instruction by instruction, the four fingerprints proving it ran and completed on the bricked unit, why `CONFIG0` was never the fault, the reasoning for keeping `--ldrom-verified` barred, and **the debug console: UART0 on P1.3, QFN32 pin 11, 115200 8N1, not the panel's UART** | Before any OTA commit, before touching the config page or the info pages, and before clipping a serial adaptor to anything |
| `hardfault-0xd38-2026-08-19.md` | **Why unit 1 did not work after the config repair**, and the diagnosis the 2026-08-20 repair then confirmed by fixing it. The application never writes BLE callback slot `+0x60`; the struct the stack reads is a fossil of the pre-OTA firmware, retained in SRAM. Two boot paths, two symptoms, one cause. Why `joggles-v1.bin` must not be flashed as it stands | Before writing any application image to any unit, and before trusting the APK image as "what the hardware runs" |
| `hardware-access.md` | SWD pads, chip package, probes, dump and restore procedure | **Now the recovery route, not insurance.** See `brick-2026-08-08.md` |
| `fmc-erase-program.md` | **What erase and program actually do on this silicon.** The erase granularity settled at 512 bytes by three witnesses in our own dumps rather than by datasheet, the vendor's register-by-register erase-and-program sequence, what an interrupted write can and cannot break, why halting is enough, how long 150 pages takes, and eight things this project had assumed that are wrong | Before any write to APROM, and before adapting anyone's flash driver |
| `config0-cbs-2026-08-20.md` | **Unit 1 is the only unit here at `CBS = 11`, and it is the Track C target.** The config page read off four dumps, why "APROM without IAP mode" lands squarely on the resident updater and not on booting, the argument that it is fine and the exact limit of that argument, and why undoing it is more dangerous than the change it reverses | Before flashing our own firmware to unit 1, and before running `fmc-repair-config.sh` |
| `protected-regions-2026-08-20.md` | **The protected regions, re-derived by content, and the count that was an APK-layout artefact.** 16 sites on the APK against 39 on the donor, which three slid out of the span named for them (two of them the word programmer and the page eraser), the two resolution mechanisms the code's two shapes need, and the five checks that replaced `Expected: 16` | Before trusting any region gate, and before adding a `PROTECTED_REGIONS` entry |
| `fmc-primitives-donor-2026-08-20.md` | **The FMC register base resolved by content on both builds, and the `CBS` question closed.** The poll idiom that finds `ISPTRG` without matching an address, why the two builds' helper block is **not** a constant offset apart, whether our updater's register use is justified, and the four legs showing `CBS` does not gate application-driven ISP | Before writing FMC code, and before porting any address between the APK and the donor |
| `patch-over-bt-review-2026-08-20.md` | **The adversarial review of the update loop, before any first write.** `UPD_DATA` reaching the live slot, the fact that there is no slot dispatch at all so "resident before slot" is currently vacuous, `UPD_STATUS` naming the live slot rather than the target, and the list of claims that were attacked and held, including the four-byte hook | Before flashing our own firmware to anything |
| `numicro-fmc-upstream.md` | **The Nuvoton originals behind this FMC**, and the paper backing for the file above. This is the *late* NuMicro FMC (NUC121/NUC126 era) wearing early NUC100/M051 register names, so which upstream manual to believe depends on the question and there is a table for it. Page size across every family, OpenOCD's `numicro.c` verbatim and the four things it does that we do not, datasheet erase and program timings, the `ISPFF` conditions per generation, the exact `REGLCTL` protected list, `CONFIG0` field by field, and why a programmed word cannot be reprogrammed | Quoting a Nuvoton document for this part, or porting somebody else's NuMicro code |
| `firmware-image-format.md` | OTA container format, firmware internals, SoC identity | Inspecting or rebuilding an image. **Its flash map and risk verdict are superseded by `firmware-flashing.md`** |
| `vendor-app-protocol.md` | Saved content (`DATS`/`DATCP`), wide buffers, complete opcode inventory, hard limits. **Measured upload ceiling and pacing floor**: 740 columns not 768, 6 ms not 50 ms, both on the `960a` bulk stream only and live per-column pacing unmeasured. **Type 2 is accepted to 383 columns and never persists**, both device-side and *verified*; **that it displays only the first 24 is *derived***, one null observation by eye, and `content.MAX_IMAGE_COLUMNS` is where the code holds the line | Improving rendering, driving the display, or sizing and pacing an upload |
| `loop-gap-2026-08-10.md` | **The device appends ~24 blank columns to a scrolling type 1 save, and the preview was not showing them.** Both uploads decoded off the app's wire log, the gap measured against them by eye. Whether the 24 is unconditional or only follows a restore from flash is open, and the two looks that settle it are the first thing in the file | Previewing a scroll, sizing a client gap, or trusting a wide loop to stay seamless |
| `mode-03-2026-08-20.md` | **`MODE 03` decoded, and it is not what three of our own files said.** It is `MODE 02`'s horizontal scroll plus a vertical shift walking a 14-entry phase table, `0 +1 +2 +3 +4 +5 +4 +3 +2 +1 0 -1 -2 -1`; the second-byte variant is a **horizontal** direction, so the "mirrored bounce" never existed. Also settles that the 24 blank columns are a **prefix, not an append**, and that the two builds' mode-3 tick is byte-identical apart from one `bl` displacement | Before trusting the mode table, or any loop model that assumes a trailing bracket |
| `ota-codec.ts` | Runnable decode/encode/verify for OTA images | Inspecting or rebuilding a firmware image |
| `tools/fwtool.ts` | Analysis workbench: `peek`, `xref`, `callers`, `modes`, `render`, `regions` | Any question about the image. **Read its header before scanning by hand** |
| `tools/patch.ts` | Builds a patched image from stock: `expect`-the-old-bytes edits, appends into free flash, assertions on bytes a patch depends on | Writing any firmware patch |
| `tools/thumb.ts` | Thumb-1 assembler, checked by reassembling the vendor's own code | Writing new firmware code |
| `tools/ext.ts` | The `JGX1` extension block and the one dispatcher hook that reaches it | Adding a sub-command to our firmware |
| `tools/build-firmware.ts` | `bun run build-firmware`: stock + hook + extension + crew key + rename | Producing an image to flash |
| `tools/mkelf.ts` | Minimal ELF wrapper so llvm-objdump will disassemble the raw image | Reproducing the disassembly |
| `tools/swd-recon.sh` | The read-only OpenOCD session: `probe`, `ids`, `diag`, `dump`. **Holds no write or erase command by construction** | When the SWD probe is attached |
| `tools/dumpcheck.ts` | `bun run dumpcheck`: is a dump trustworthy, and what device state does it show? Validates by diffing `abs 0x16800` against `ota.plaintext()`, which proves the dump and the flash map at once | Reading anything `swd-recon.sh dump` produced |
| `tools/bankdump.ts` | `bun run bankdump`: the built-in images and animations as pictures. `list` re-resolves the bank inventory by walking the per-tick table and diffs it against `firmware-internals.md`, `show`/`sheet` render frames as ASCII, `emit`/`check` own the phone app's generated `builtins-data.ts`. Offline and device-free, held there by a test | Looking at what a built-in actually shows, or after any change to the banks |

The client half of the extension protocol is `packages/core/src/jgx.ts`, and `tools/ext.ts`
imports its constants rather than restating them, so the firmware and the app cannot drift.
`notes/firmware-design.md` is the architecture and the reasoning, and its opening section
"Whose glasses these are, and why modifying them is fair" is the ethical stance behind
modifying a product we did not make: own units only, no vendor binaries redistributed, patch
in place.

`notes/protocol.md` is the transcription-and-evidence record: the AES key, the panel
geometry, the command table, and **how each of those facts was established**, capture by
capture. The wire formats themselves are owned by the docblocks in `packages/core/src` -
`protocol.ts` for frames and channels, `dats.ts` for the upload path and both payload
encodings, `display.ts` and `content.ts` for the panel and its limits. So go to the
docblocks for what a frame looks like, and to `notes/protocol.md` for why we believe it.
These documents extend and in places correct both.

**Scope boundary.** Everything in `research/` is a finding: a claim about the hardware
or the firmware, with its evidence and a confidence marker. Judgement about what to
build with it belongs in `notes/what-to-build.md` instead, so that the two do not blur.
If a section here starts recommending rather than reporting, it is in the wrong file.

## Conventions used throughout

Writing style for these documents is set by `notes/WRITING.md`. The confidence
markers below are the canonical set; do not introduce others.

- **Offsets** are stated as `body 0xNNNN` (an offset into the *deobfuscated* OTA
  payload, i.e. after the 16-byte container header) or `abs 0xNNNN` (an address in
  the device's flash). The relationship is fixed: `abs = body + 0x16800`.
  Published third-party analyses use `0x10000` as the base and are wrong by
  `0x6800`, so absolute addresses quoted elsewhere will not match.
  **Do the conversion mechanically, not in your head.** It has been got wrong once
  already, writing body `0x51c8` for `abs 0x1c9c8` instead of `0x61c8`, which put a
  protected region 64 KB from the function it was meant to guard. `ota.check` still
  passed, the tests still passed, and only re-running
  `bun research/tools/fwtool.ts regions` caught it. Any new `PROTECTED_REGIONS` entry
  should be checked that way before it is trusted. *Updated 2026-08-20, track 58: the
  regions now **resolve by content** in whichever image is handed in, so a hand-converted
  offset is no longer the thing that can be wrong, and the audit asserts five properties
  true of any build rather than a count. The hazard this bullet describes was real and the
  conversion rule still applies everywhere else.*
- **Confidence** is labelled explicitly: *verified* means checked against bytes or
  running hardware, *derived* means inferred from firmware literals or app code,
  *unverified* means plausible but untested.
- **Two scanning traps, both of which have already produced wrong entries here.**
  First, animation bank data is `abs 0x22df8`-`0x268f6`, 22.9% of the image, and
  129 of its words look like flash addresses by chance, so a "referenced N times"
  claim from an unfiltered scan is worthless. Second, addresses are often computed
  rather than stored: the button GPIO `0x500042a8` is never a literal, it is
  `0x50004280 + 0x28`, so an empty search is not proof of absence. `tools/fwtool.ts`
  handles both; use it rather than grepping.
- Every factual claim about the OTA container is reproducible with
  `bun research/ota-codec.ts verify firmware/*.bin`.

## Current state in one paragraph

The display protocol is solved and verified on hardware. The OTA container format is
also solved: the payload is XOR-obfuscated with a fixed 128-byte pad, not encrypted
with a key we lack, and the header CRC-32 covers the deobfuscated body, so valid
modified images can be built. **Staging an app image over BLE is safe and *verified* on
hardware; committing one is barred and has already cost a unit.** The OTA writes to a
separate bank at `abs 0x29400` and never erases the running application, so `bun run
flash stage` costs nothing if it aborts. The `03` control write that commits is a
different matter: on 2026-08-08 a *stock over stock* commit bricked `GLASSES-12C3EF`,
staging fine and the device's own CRC matching, and it reset itself and never came back.
`packages/cli/src/flash.ts` refuses `commit` outright without `--ldrom-verified`, which
nobody can honestly pass until the LDROM has been dumped over SWD.
`research/brick-2026-08-08.md` is the postmortem and "Incident: the commit that did not
come back" in `firmware-flashing.md` is the same event from the flash side.

*Corrected 2026-08-11: this paragraph read "**flashing an app image over BLE is now
judged reasonably safe**" and "we can re-flash stock ourselves at any time", and it
contradicted this file's own first two index rows. The brick falsified both, and the
second one exactly: re-flashing stock ourselves is the capability that was lost, and the
image committed was byte-identical stock. The judgement is kept here rather than deleted
because it is why the bar in `flash.ts` is worded as a claim about evidence rather than
another `--yes`. What the earlier verdict got right, and still holds, is the two mistakes
it overturned, both corrected in `firmware-flashing.md`: the region below `abs 0x16800`
is the BLE stack rather than the bootloader, and the staging bank does exist.*

Better rendering still requires no firmware changes at all: the device already stores and
scrolls buffers far wider than the panel.

**Every open gate that could be closed without hardware now is.** The animation banks,
both frame formats and the complete mode map are decoded; the button section including
the P5.2 pin is hand-checked; the AES key is confirmed as one buffer for both directions
(with the S-box hazard immediately after it); the notify sender is confirmed callable
outside the `DATS` context, with a 15-byte payload ceiling; the dispatcher's register
contract and the cheapest hook are settled; and the SRAM budget is confirmed. The OTA
state machine was re-derived independently and agreed. What remains needs hardware: the
column-0 lens test, the crystal-versus-RC tick, and whether the bootloader validates a
staged image before copying it.

The application region is now disassembled too, in `firmware-internals.md`, and it
changes what patching is for. **The MCU does not drive the LEDs**: the panel is a
separate module on UART1, so greyscale depth and brightness curve are beyond any
patch's reach. What the teardown did find is an **on-board button** the firmware
already polls, a **rhythm channel that updates all 24 columns in one write** (the only
path with no sweep artefact), and that most of the "unverified opcodes" list is simply
**absent** from the firmware. Patching is now worth doing for interaction and capacity,
not for image quality.
