# Flashing: what is safe, what is not

**Status:** the OTA state machine has been disassembled out of our own image and
cross-checked line by line against Panchip's published SDK source. The two agree.
**Verdict: an app-type OTA is reasonably safe over BLE, with no physical tools.**
The transfer is staged in a separate flash bank and the running application is
never erased, so an aborted or corrupt transfer costs nothing.
**Scope:** corrected flash map, the OTA state machine as this device implements it,
the size envelope, the safe procedure, and the one brick vector reachable over the air.
**Reproduce:** see "Reproducing the disassembly" at the end.

Offsets here are `abs`, i.e. flash addresses. `body` offsets into the deobfuscated
OTA payload relate to them by `abs = body + 0x16800`.

## Verdict

| Question | Answer | Confidence |
| --- | --- | --- |
| Can we flash a modified app image over BLE? | yes | verified |
| Does a failed or aborted transfer break the device? | no, nothing is committed | verified |
| Can we restore the stock image ourselves over BLE? | yes, while the running app answers | verified |
| Is there a signature check to defeat? | none, anywhere | verified |
| Can an OTA brick the device? | yes, two ways, both avoidable | verified |
| Are physical tools required? | no, but an SWD dump is worthwhile insurance | judgement |

The residual risk is not the transfer. It is shipping a valid-CRC image that boots
but fails to bring up BLE, because the OTA service lives in the application image.
That is a self-inflicted wound, and the mitigation is to patch the stock image in
place rather than relink a new one.

## Corrections to `firmware-image-format.md`

Three claims in that document were wrong. They are corrected here rather than
deleted, because each was reasonable from the evidence available at the time.

**Wrong: "the ~90 KB below `abs 0x16800` holds the bootloader".** That region is the
**BLE stack** (Panchip call it the SoftDevice, having borrowed Nordic's vocabulary).
The bootloader is 8 KB at `abs 0x3dc00`, at the *top* of flash. *verified* from
Panchip's `section_cfg.h`, which defines `FLASH_SOFTDEVICE_SIZE 0x00016800` and
`FLASH_BOOTLOADER_ADDR 0x0003DC00`. Our app base is not a vendor choice at all; it
is the stock SDK boundary between stack and application.

**Wrong: "there is no vendor image to restore it from".** The public SDK ships
`src/stack/softdevice/stack_1.0.0.hex`, spanning `0x0` to `0x1677c` (92,028 bytes),
which is exactly that region. *verified* by parsing the hex. Whether it is the same
stack build our unit runs is *unverified*, so it is a fallback, not a drop-in.

**Wrong: "no literal points at a staging base", concluding the staging question was
open.** There is a staging bank, at `abs 0x29400`. The base is not a literal in the
code; it is a runtime value loaded from a const table at `abs 0x26930`, which is why
scanning for literals missed it. *verified* two independent ways, below.

## Corrected flash map

| Range | Size | Contents | Confidence |
| --- | --- | --- | --- |
| `0x00000` - `0x167ff` | 90 KB | BLE stack (SoftDevice). Not in any OTA file | verified |
| `0x16800` - `0x293ff` | 76.8 KB | application region. Our image occupies 66,084 of it | verified |
| `0x29400` - `0x3bfff` | 76.8 KB | **OTA staging bank.** Scratch, contents disposable | verified |
| `0x3c000` - `0x3c5ff` | 1.5 KB | saved user content (`DATS` uploads) | derived |
| `0x3c800` | 8 B | saved-content metadata | derived |
| `0x3d800` / `0x3da00` | 512 B each | section info page and its backup | verified |
| `0x3dc00` - `0x3fbff` | 8 KB | **bootloader**, per the SDK. Never written by an OTA | derived |
| `0x3f000` | 4 KB | vendor data sector, referenced 7 times, purpose unknown | derived |
| `0x100000` | - | LDROM window | derived |

The vendor kept Panchip's stock layout and dropped their saved-content buffer at
`0x3c000`, immediately above the staging bank. That adjacency is the source of the
size hazard below.

**One unresolved overlap.** The SDK's nominal 8 KB bootloader at `0x3dc00` runs to
`0x3fbff`, which swallows the `0x3f000` sector the application uses as its own data
store. Both cannot be true as stated. Either the vendor's bootloader is smaller than
the stock reservation, or `0x3f000` is carved out of it. Until a dump settles this,
treat everything from `0x3d800` upward as untouchable, which the size limits below
already enforce.

## What the device actually does

Disassembled from `TR1906R04-10_OTA.bin`; the handler occupies `abs 0x1ea00` to
`0x1ee20`. All *verified* unless marked.

| Step | Device behaviour |
| --- | --- |
| ctrl `01` version | records the three version words, replies `80 01` plus 6 bytes. Writes no flash |
| ctrl `02 <type> <size32>` | zeroes the counters, sets a section flag from `type`, stores `size`. **Writes no flash** |
| data on `fd01` | appends to a 512-byte SRAM buffer at `0x20002970`. On each full page: descramble in RAM, erase one page at `0x29400 + offset`, program 512 bytes, `offset += 512`. ACKs `80 04` |
| ctrl `03 <crc32>` | hardware CRC-32 over `[0x29400, size)`, compared with the host's value. On match only: erase `0x3da00`, write the handoff record, read it back. Replies `80 03 00` |
| ctrl `04` | **no handler.** The dispatcher tests 1, 2 and 3 only, so this is a no-op |

Then the bootloader at `0x3dc00` reads the record and copies the staged image to its
destination on the next boot. *derived*: the application never writes below
`0x29400`, so something else must, and Panchip's SDK documents the bootloader as
responsible for validating and relocating.

Three details that matter:

- **The running application is never erased.** Erase and program only ever target
  `0x29400 + offset` and the info page at `0x3da00`. A Cortex-M0 executing in place
  could not erase itself anyway, and this design means it never tries.
- **The firmware never enables config writes.** Before each erase or program it sets
  `ISPCON` bit 3 (`APUEN`, APROM update) and nothing else. `CFGUEN` (bit 4) and
  `LDUEN` (bit 5) stay clear, so no OTA can reach `CONFIG0`, the security lock, the
  boot-select bits or the LDROM. The classic permanent brick is unreachable this way.
- **`codeSize` must be a multiple of 4.** The final partial page is written as
  `remainder >> 2` words, so up to three trailing bytes are dropped silently and the
  CRC then fails. Both stock images comply (65,824 and 66,084).

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

**Keep custom images at or below the stock 66,084 bytes.** That leaves 10,716 bytes
of headroom before anything else is touched, and there is no reason to grow the image
when the goal is patching behaviour rather than adding a subsystem.

## Safe procedure

Ordered cheapest and least committal first. Steps 1 to 3 cannot damage anything.

1. **Enumerate.** Confirm the device exposes `fd00` alongside `fff0` in one discovery
   pass. Zero risk.
2. **Read the version.** Send ctrl `01` on `fd02` and read `80 01` plus 6 bytes. This
   writes no flash and proves the OTA stack responds.
3. **Prove staging without committing.** Send ctrl `02 01 <size>`, stream a few KB of
   anything, then disconnect **without sending ctrl `03`**. Nothing is committed: the
   staging bank is scratch and the info page is untouched. The device should come back
   still reporting `TR1906R04-10`. This is the discriminating test for the whole
   staged-versus-in-place question on real hardware.
4. **Re-flash the stock image.** `firmware/TR1906R04-10_OTA.bin` matches our unit
   (version string `TR1906R04-10` at `abs 0x1e008`, `appVer 3`). Do **not** use
   `TR1906R04-1-10_OTA.bin`; that is the other hardware variant, string
   `TR1906R04-01-10`, `appVer 1`. Flashing stock over stock exercises the entire path
   with zero novel-code risk and establishes the recovery loop before it is needed.
5. **Only then patch.** Modify bytes in the decoded plaintext, keep the length
   identical, re-encode with `research/ota-codec.ts`, flash.

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

Both stock images are used as test fixtures where `firmware/` is present, so the guard
is checked against real vendor data rather than only synthetic images.

## Hard don'ts

- **Do not relink.** Build a new image from scratch and you own the BLE bring-up, the
  OTA service and the interrupt vectors. Get any of it wrong and there is no way back
  over the air. Patch the stock image in place instead: same length, same entry point.
- **Do not send `type 2`.** It aims the bootloader at the BLE stack.
- **Do not exceed 76,800 bytes**, and prefer staying at 66,084.
- **Do not remove or break the `fd00` service, the advertising, or the connection
  handling.** Those are the recovery path. Treat them as untouchable.
- **Do not power the device from a flat battery during step 4 or later.** The
  transfer itself is safe to interrupt, but the bootloader's copy on the next boot is
  not, and that window has no protection.

## Still unverified

- Whether the bootloader validates the staged image before copying, and what it does
  when the record is absent or the flag is unrecognised. This decides whether a bad
  image can be superseded by simply staging a good one.
- Whether the bootloader offers any recovery transport. Panchip's `dfu_source_t`
  enumerates `DFU_SOURCE_OTA = 1` and `DFU_SOURCE_UART = 2`, which hints at a UART
  ISP path, but no pins or entry conditions are documented for this part.
- Whether the device reboots by itself after a successful ctrl `03`, or waits for
  disconnection. The SDK resets on disconnect; our image sets an internal state to 2
  and the reboot site was not traced.
- What lives in the 4 KB sector at `0x3f000`. If it holds the BLE MAC or RF trim,
  overwriting it would be bad in a way SWD could fix but OTA could not.
- Whether `stack_1.0.0.hex` from the public SDK matches the stack our unit runs.

## Reproducing the disassembly

macOS ships `llvm-objdump` but not `objcopy`, and llvm-objdump will not read a raw
binary, so the image needs wrapping in a minimal ELF first. Both helper scripts live
in the scratchpad rather than the repo, being one-offs:

    bun research/ota-codec.ts decode firmware/TR1906R04-10_OTA.bin fw10.bin
    bun mkelf.ts fw10.bin fw10.elf 0x16800      # 40-line ELF32 wrapper
    /Library/Developer/CommandLineTools/usr/bin/llvm-objdump \
        -d --triple=thumbv6m-none-eabi fw10.elf > fw10.asm

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
