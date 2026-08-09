# Joggles research index

Entry point for the reverse-engineering findings. Each document below is
self-contained: read only the one that matches your task.

| Document | Covers | Read it when |
| --- | --- | --- |
| `brick-2026-08-08.md` | **A stock-over-stock OTA commit bricked a unit.** Exact mechanism, why it is probably recoverable, the SWD repair | **Before any OTA commit, without exception** |
| `firmware-flashing.md` | **Is it safe to flash?** OTA state machine, corrected flash map, size envelope, safe procedure. Staging verified on hardware; **committing is barred** | Before writing a single byte of flash |
| `firmware-internals.md` | **What the firmware is.** The UART display module, the on-board button, the real 11-opcode dispatcher, the animation engine, the `DATCP` gate and why type 2 never reaches flash, what a patch buys | Deciding whether to patch at all, or hunting a capability |
| `hardware-access.md` | SWD pads, chip package, probes, dump and restore procedure | **Now the recovery route, not insurance.** See `brick-2026-08-08.md` |
| `firmware-image-format.md` | OTA container format, firmware internals, SoC identity | Inspecting or rebuilding an image. **Its flash map and risk verdict are superseded by `firmware-flashing.md`** |
| `vendor-app-protocol.md` | Saved content (`DATS`/`DATCP`), wide buffers, complete opcode inventory, hard limits. **Measured upload ceiling and pacing floor**: 740 columns not 768, 6 ms not 50 ms, both on the `960a` bulk stream only and live per-column pacing unmeasured. **Type 2 is accepted to 383 columns, displays only the first 24, and never persists** | Improving rendering, driving the display, or sizing and pacing an upload |
| `ota-codec.ts` | Runnable decode/encode/verify for OTA images | Inspecting or rebuilding a firmware image |
| `tools/fwtool.ts` | Analysis workbench: `peek`, `xref`, `callers`, `modes`, `render`, `regions` | Any question about the image. **Read its header before scanning by hand** |
| `tools/patch.ts` | Builds a patched image from stock: `expect`-the-old-bytes edits, appends into free flash, assertions on bytes a patch depends on | Writing any firmware patch |
| `tools/thumb.ts` | Thumb-1 assembler, checked by reassembling the vendor's own code | Writing new firmware code |
| `tools/ext.ts` | The `JGX1` extension block and the one dispatcher hook that reaches it | Adding a sub-command to our firmware |
| `tools/build-firmware.ts` | `bun run build-firmware`: stock + hook + extension + crew key + rename | Producing an image to flash |
| `tools/mkelf.ts` | Minimal ELF wrapper so llvm-objdump will disassemble the raw image | Reproducing the disassembly |
| `tools/swd-recon.sh` | The read-only OpenOCD session: `probe`, `ids`, `diag`, `dump`. **Holds no write or erase command by construction** | When the SWD probe is attached |
| `tools/dumpcheck.ts` | `bun run dumpcheck`: is a dump trustworthy, and what device state does it show? Validates by diffing `abs 0x16800` against `ota.plaintext()`, which proves the dump and the flash map at once | Reading anything `swd-recon.sh dump` produced |

The client half of the extension protocol is `packages/core/src/jgx.ts`, and `tools/ext.ts`
imports its constants rather than restating them, so the firmware and the app cannot drift.
`notes/firmware-design.md` is the architecture and the reasoning.

`notes/protocol.md` remains the day-to-day protocol reference (key, frame format,
geometry, command table). These documents extend and in places correct it.

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
  should be checked that way before it is trusted.
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
modified images can be built. **Flashing an app image over BLE is now judged
reasonably safe**, because the OTA has been disassembled and is staged: it writes to
a separate bank at `abs 0x29400` and never erases the running application, so an
aborted transfer costs nothing and we can re-flash stock ourselves at any time. The
earlier "not safe yet" verdict rested on two mistakes, both corrected in
`firmware-flashing.md`: the region below `abs 0x16800` is the BLE stack rather than
the bootloader, and the staging bank does exist. Better rendering still requires no
firmware changes at all: the device already stores and scrolls buffers far wider than
the panel.

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
