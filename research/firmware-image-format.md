# Firmware and OTA container: TR1906R04

**Status:** container format solved and verified against both stock images.
**Scope:** the container and the image's identity - header fields, the obfuscation and
how it was recovered, the CRC, the load base, the SoC, and what is inside the two stock
images. The flash map, the OTA state machine and the flashing procedure belong to
`research/firmware-flashing.md` and are pointers here, not copies.
**Reproduce:** `bun research/ota-codec.ts verify firmware/*.bin`

Offset convention in this document: `body 0xNNNN` is an offset into the
deobfuscated OTA payload (after the 16-byte header); `abs 0xNNNN` is a flash
address. `abs = body + 0x16800`.

## Key facts

| Fact | Value | Confidence |
| --- | --- | --- |
| Container | 16-byte plaintext header, then XOR-obfuscated body | verified |
| Obfuscation | 128-byte repeating pad, word `n` = `rotr32(0x37627996, n)` big-endian | verified |
| Integrity | CRC-32 (poly `0xedb88320`) over the **deobfuscated** body | verified |
| Signature check | none, anywhere in the flash path | verified |
| Load base | body `0` maps to `abs 0x16800` | verified |
| SoC | Panchip PAN1020 class, ARM Cortex-M0, 256 KB flash, <=16 KB SRAM | high, die marking unverified |
| Region below `abs 0x16800` | the **BLE stack**, ~90 KB. *Was wrongly recorded here as the bootloader* | verified |
| Saved user content | `abs 0x3c000`, a `0x600`-byte (1.5 KB) buffer | derived |
| OTA service host | the application image, not a separate bootloader advertiser | verified |
| Safe to flash today | **staging yes, committing no.** *Was "yes for a patched stock app image"; a stock-over-stock commit bricked a unit on 2026-08-08.* `firmware-flashing.md`, "Incident" | verified the hard way |

## Verdict on flashing: superseded

**This section was wrong and is kept only to record the error.** Read
`research/firmware-flashing.md` instead; it disassembles the OTA handler and settles
the question.

What was claimed here: that flashing must wait on a full SWD dump, because the ~90 KB
below `abs 0x16800` was the bootloader, existed in no stock file, and there was no
evidence of a staging bank.

What is actually true. That region is the **BLE stack**, not the bootloader; the
bootloader is 8 KB at `abs 0x3dc00` and an app OTA never touches it. The stack is
published in Panchip's own SDK. And the staging bank does exist, at `abs 0x29400`:
the OTA writes there and never erases the running application, so an aborted transfer
costs nothing. The literal scan that produced "no literal points at a staging base"
missed it because the base is loaded at runtime from a const table at `abs 0x26930`
rather than appearing as an immediate.

The lesson worth keeping: absence of a literal is not absence of the thing.

**None of that makes committing safe.** Staging is verified on hardware and costs
nothing; ctrl `03` bricked `GLASSES-12C3EF` on 2026-08-08 with the stock image it was
already running. `research/firmware-flashing.md`, "Incident".

## OTA container format

### Header layout

16 bytes, little-endian. Field names come from the vendor app's
`FileInfo`/`VersionInfo` parser, so these are the vendor's own semantics.

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0 | 4 | `codeSize` | body length, always file length minus 16 |
| 4 | 4 | `crc32` | CRC-32 of the deobfuscated body |
| 8 | 2 | `appVer` | application version |
| 10 | 2 | `devVer` | device version |
| 12 | 2 | `proVer` | protocol version |
| 14 | 1 | `type` | image type/bank selector, `0x01` in both stock images |
| 15 | 1 | unused | |

CRC-32 is the standard variant: polynomial `0xedb88320`, init and final xor
`0xffffffff`.

The two stock images:

| File | codeSize | crc32 | app | dev | pro | type |
| --- | --- | --- | --- | --- | --- | --- |
| `TR1906R04-1-10_OTA.bin` | 65824 | `0x48a889e3` | 1 | 10 | 10 | 1 |
| `TR1906R04-10_OTA.bin` | 66084 | `0x04acebff` | 3 | 10 | 10 | 1 |

These are **different hardware variants**, not merely successive versions: the
`appVer` differs (1 versus 3) and the sizes differ by `0x104`. Their bodies are
identical from body `0x2` to `0x146b`, then diverge permanently because the larger
image shifts everything after an insertion.

The files in `firmware/` are byte-identical to `assets/TR1906R04-*_OTA.bin` inside
the APK. The app ships its firmware and never downloads any.

### Payload obfuscation

The pad is 128 bytes. Read it as 32 big-endian 32-bit words where

    word[n] = rotr32(0x37627996, n)      for n = 0..31

and apply `body[i] ^= pad[i % 128]`. Thirty-two single-bit rotations return to the
seed, which is why the period is 128 bytes. XOR is an involution, so one routine
both obfuscates and deobfuscates.

Equivalent framing, if it helps: the pad is a 16-byte key
`76 27 99 63 bb 13 cc b1 dd 89 e6 58 6e c4 f3 2c` whose four big-endian words are
rotated right by 4 bits per successive 16-byte block. Same 128 bytes either way.

The pad is identical across both stock images, so it is a fixed scrambler baked
into the device, not a per-device key.

### How the obfuscation was recovered

Whole-body entropy is 7.83 bits/byte, which looks like real encryption and is
presumably why it was previously written off. The structure shows up in
autocorrelation instead: byte match at lag 128 is 10.4%, about 26 times the 0.39%
chance rate, with a secondary spike at lag 33.

Lag 33 is the signature of a per-word one-bit rotation, because eight words of
one-bit rotation equal exactly one byte of shift. That fixes the generator shape.
Brute-forcing the remaining unknowns (32 phases, two byte orders, two polarities)
against a printable-ASCII-run oracle left exactly one candidate: entropy falls to
6.45 bits/byte and Cortex-M code appears at the top of the body.

The high entropy of the obfuscated form is explained by the pad giving each of the
128 byte positions its own permutation, flattening the histogram without adding
real entropy.

### Verification performed

Three independent checks, both images:

1. For all 128 pad positions, the modal plaintext byte is `0x00`. Zero-fill
   dominates a firmware image, so a wrong pad byte would show immediately.
2. The header CRC-32 equals CRC-32 of the deobfuscated body. The cipher-side CRC
   does not match, so this is not a framing coincidence.
3. Re-encoding the plaintext reproduces the original file byte for byte.

The app streams the still-obfuscated body verbatim and forwards the stored CRC
unchanged, computing nothing itself. Since the device accepts that CRC, **the
device must deobfuscate before verifying**, which is what proves the pad lives in
the device.

### Building a modified image

Modify the plaintext, set `codeSize` to its length, set `crc32` to
`CRC32(plaintext)`, XOR with the pad, and keep or bump the version fields. The
`encode()` function in `research/ota-codec.ts` does exactly this and is verified by
round-trip.

Anything built this way must be **linked for base `abs 0x16800`**. An image linked
for the wrong base is the single most common way parts in this family are bricked.

## Firmware internals

### SoC identification

ARM Cortex-M0, Thumb-only code (`MSR MSP`, `MOV sp`, `PUSH {..., lr}` prologues).
Definitely not a Telink TC32 part.

The part is **Panchip PAN1020 class**. The register-map literals are Nuvoton
NuMicro derived: FMC/ISPCON at `0x5000c000`, plus SYS/CLK, GPIO on a `0x40` port
stride, timer, ADC and PWM windows, and an LDROM window referenced at
`0x00101000`. Flash erases land on 512-byte boundaries, which is Nuvoton FMC page
granularity. No literal references flash at or above `0x40000`, so it is a 256 KB
part. The BLE stack is RivieraWaves/CEVA derived, betrayed by the string
`gattc_send_svc_changed_cmd_handler`. Decisively, the vendor's own Android library
contains a package named `panchip`. The die marking itself is unverified.

Other hardware facts: SRAM at `0x20000000`, at most 16 KB, with initial SP
`0x20003910` and `0x20003ffc` appearing as a literal.

*Corrected: this used to read "a 26 MHz crystal, from the constant `0x018cba80`
(26,000,000) in the tail config block". **The external crystal is 16 MHz.** Our own
board was opened on 2026-08-08 and `Y1` is marked `16.000MHz`. `0x018cba80` is the
internal oscillator and PLL reference, which Panchip's SDK sets to 26 MHz while
defining the external `__HXT` as 16 MHz. Recorded rather than deleted because
"constant in the image equals crystal frequency" is the reasoning that produced it, and
it is wrong in a way worth remembering. See `hardware-access.md`, "Our own unit,
opened".*

### Where the image sits in flash

`research/firmware-flashing.md` owns the flash map: it is corrected there, evidenced
against Panchip's own `section_cfg.h`, and `research/README.md` declares that version
canonical. It is deliberately not restated here. Only the two container-side rows
matter for reading or rebuilding an image:

| Range | Size | Contents | Confidence |
| --- | --- | --- | --- |
| `abs 0x16800` | - | application load base; **body offset `0` loads here** | verified |
| `abs 0x16808` - `0x26a24` | 66 KB | the application image, i.e. the container body | verified |

The ~90 KB below `abs 0x16800` is the **BLE stack**. *Previously recorded here as the
bootloader, which was wrong*: the bootloader is 8 KB at `abs 0x3dc00`, above the
application, and an app OTA never writes it.

*Corrected: this section used to size the `0x600`-byte saved-content buffer at
`abs 0x3c000` as "512 columns at 3 bytes per column, or **768 columns** at 2 bytes per
column", and 768 was then quoted around the notes as a usable limit. It is the buffer's
capacity, not what the firmware accepts, and this was 768's last live copy. The measured
type 1 ceiling is **740 columns**: 1480 bytes returns `DATCPOK` and 745 columns returns
`ERROR`, bisected from both directions on hardware in `research/vendor-app-protocol.md`.
The firmware's own bound is 743 columns / 1486 bytes, because `DATCP` compares a counter
that starts at 48, adds 2 per column and wraps at 1536; mechanism and addresses in
`research/firmware-internals.md`, "`DATCP` is an exact-match gate".*

### How the load base was established

Scoring candidate bases by how many Thumb function pointers land on a
`push {..., lr}` prologue is decisive: base `0x16800` yields 113 strict prologue
hits (ratio 0.78), while every other candidate yields at most 13 (ratio <= 0.09).

Four independent confirmations agree:

- The word at body `0x0c` is `0x00016a01`, a Thumb entry vector resolving to body
  `0x200`, which is exactly where contiguous code begins.
- `abs 0x16800` is a clean 512-byte page boundary, matching the erase granularity.
- The AES key sits at body `0xc394`, i.e. `abs 0x22b94`.
- The word at body `0` is `0x00026904`, exactly `0x18` before the `GLASSES-`
  string at body `0x1011c` (`abs 0x2691c`), so it is a device-info block pointer.

Note that the image head is **not** a Cortex-M vector table. The first two words of the
stock head are that device-info pointer, `0x00026904`, then `0x03010100`, both *verified*
against the container, so anything that reads them as an initial SP and a reset vector
reports a failure that is not one; `research/tools/dumpcheck.ts` deliberately makes no
such claim about a dump of `abs 0x16800`. The real fields sit further in: body `0x08` is
the initial SP, body `0x0c` the entry vector, and body `0x10` begins a startup stub that
sets SP from a literal and branches to `abs 0x1f86c`.

### Notable contents

| Item | Location | Note |
| --- | --- | --- |
| AES-128 key `34522a5b7a6e492c08090a9d8d2a23f8` | body `0xc394` (`abs 0x22b94`) | in plaintext, with the AES S-box immediately after at body `0xc3a4` |
| GATT table, four `d44bc439-...` characteristics | body `0xc1e8` - `0xc2b0` | `...9600`, `...960a`, `...960b`, `...9601` in BLE byte order |
| Service UUIDs `0xfff0` and `0xfee9` | body `0xc2ec` and `0xc2f8` | both declared; the app matches on `0xfff0` |
| OTA characteristics `0xfd01`, `0xfd02` | body `0xc32c`, `0xc33c` | with `0x2800`/`0x2803`/`0x2902` declarations around them |
| Reply strings `DATSOK`, `DATCPOK`, `ERROR00` | body `0x1dbc` | stored as strings because they are transmitted |
| Version string | body `0x7808` (`abs 0x1e008`) | `TR1906R04-10`, or `TR1906R04-01-10` in the other image |
| `GLASSES-` name prefix | body `0x1011c` (`abs 0x2691c`) | advertised-name prefix |
| Hard-fault handler | body `0x142c` | with an `r0 = 0x%x` style register dump |
| Rhythm bar-height table, **not palettes** | `abs 0x22da8` | **ten** words: `0, 3, f, 3f, ff, 3ff, fff, 3fff, ffff, 3ffff`, i.e. `4^n - 1`, meaning n rows lit at level 3. *verified* from the image. *Recorded here as a "palette" of eight words, which was wrong twice over: wrong thing, wrong count.* Analysis: `firmware-internals.md`, "The rhythm channel is a full-panel atomic write" |
| Text level LUT, the real one | `abs 0x22da4` | two entries, `00 03 00 00`: the 1-bit-to-2-bit expander for uploaded text, off to level 0 and on to level 3 |
| Glyph strip and a "Cool" bitmap | body `0x10137`, `0x101c4` | 5-row glyphs, and a 7-row bitmap in 16-bit columns; factory default content |

Command opcodes (`SMVEW`, `IMAG`, `MODE`, ...) appear nowhere as ASCII, not even as
4-character fragments, so the dispatcher compares them as immediates.

The AES key's presence here independently confirms the key previously recovered by
brute-forcing `libAES.so`. The published Shining Mask key
`32672f7974ad43451d9c6c894a0e8764` appears nowhere in these images.

## How the container reaches the wire

The packets themselves, the device's state machine and the size envelope belong to
`research/firmware-flashing.md`: they are read off the disassembled handler at
`abs 0x1ea00`, cross-checked against the vendor's `PanchipOtaManager`, and implemented
in `packages/core/src/dfu.ts`. Use those three, not a copy here.

What belongs here is which bytes of the container go on the wire, and what the app does
around them:

- **The 16-byte file header is never transmitted.** Streaming starts at body `0` and the
  body goes out still obfuscated, so `codeSize` and `crc32` reach the device over the
  control channel instead. That is the same fact as "the device must hold the pad".
- The app requests **MTU 203**, giving `packetSize = 200`: each data packet is a 2-byte
  little-endian sequence index plus up to 198 firmware bytes.
- The OTA channel is the one place the app deliberately **bypasses AES**: it writes raw
  bytes to `fd01`/`fd02` and routes those notifications around the decrypt step.

*Corrected: this document listed the control opcodes as "`1` version, `2` size, `3` crc,
**`4` reset**" and drew a `04 | crc32[4]` packet described as "reset: constructed but
never sent". **The device has no `04` handler at all** - the ctrl dispatcher at
`abs 0x1ebc2` tests 1, 2 and 3 only. The vendor app does construct an `04` frame and
never sends it, which is where the entry came from, but there is nothing on the device
that would answer it. `80 04` in the other direction is the per-write ACK and is
unrelated.*

### No guard rails

The app's only gate is client-side: it reads a plaintext version string, splits on
`-`, and offers an update only when the major field is under 10. Our unit reports
`TR1906R04-10`, so **the vendor app will never offer it an OTA**, and is therefore
not a recovery route either.

Worse, the library's `compareVersion` calls `startOTA` on *every* branch, including
"same version" and "OTA version lower than device". In the live path it is not even
called: the version reply proceeds straight to `startOTA`. Since the two bundled
images are different hardware variants, the vendor app will happily flash the wrong
variant. Do not trust its checks.

## Flashing risk and recovery: not here

The risk analysis, the size envelope and the safe procedure are
`research/firmware-flashing.md`; the SWD recovery route, the brick modes and what is
unrecoverable are `research/hardware-access.md`. Two items are kept below: one because
it is a recorded error, one because it is the probe a reader of *this* file wants.

**One claim made here was not merely wrong but dangerous, so it is kept verbatim:**

> "OTA writes start at `abs 0x16800` and go *upward*, away from the bootloader, so
> even an oversized image cannot reach it by overrunning."

Writes start at `abs 0x29400`, and the bootloader sits *above* them at `abs 0x3dc00`.
The firmware accepts any `codeSize` below `0x19000` (102,400) while only 83,968 bytes
separate the staging base from the bootloader, so **an oversized image erases the
bootloader**. The binding ceiling is **76,800 bytes**, the size of the application
region, and `ota.check()` enforces it. *Corrected: this passage also said "keep images at
or below the stock 66,084 bytes", which is no longer right as a rule - our own
`firmware/joggles-v1.bin` is 66,172 bytes by design, appending an extension into the
headroom above stock.*

**Safe probe:** anything on the display service (`0xfff0` with the `d44bc439-...`
characteristics) writes no flash. Worst case is a garbled panel, fixed by redrawing or
`SMVEW 00`.

*Falsified.* This section used to say "**do not send OTA opcode `02` (size)** unless
committed to completing a correct transfer", calling it "the point at which the device
most plausibly erases". Ctrl `02` writes no flash at all - *verified* from the handler,
which only zeroes the counters, sets a section flag from `type` and stores the size - and
staging without committing is now the *recommended* safe test on hardware. **The
dangerous opcode is ctrl `03`, the commit**, which bricked a unit on 2026-08-08. The old
wording pointed a reader's caution at the wrong opcode, which is worse than pointing it
nowhere.

## Prior art, and what is new here

The XOR descrambling is **not** novel: `Blato58/MaskApp` published a working
decryption script for these exact two files, along with Ghidra scripts and around
230 named functions. Its command table and its identification of flash persistence
at `abs 0x3c000` are sound and were corroborated independently here.

What this repository adds:

- The **correct load base** `abs 0x16800`. MaskApp and other public analyses assume
  `0x10000` and are wrong by `0x6800`, so every absolute address they publish is
  offset. Their conclusion that the AES key, palettes and animation tables lie
  "outside the OTA image" is an artefact of that error: all three are inside it.
- Decoding of the **container header fields** and verification that the CRC-32
  covers the deobfuscated body, which no public tool checks.
- A verified **re-packer** (scramble plus CRC plus header), which does not exist
  publicly.
- The `DATS`/`DATCP` upload subsystem traced end to end from app source, documented
  in `research/vendor-app-protocol.md`.
- The **disassembled OTA state machine**, in `research/firmware-flashing.md`. No
  public project has touched the `fd00` path.

The two halves of the container have been solved separately in public and never
together. `Jhan-vasquez-dev/shining-glasses` documents exactly our header layout,
naming the same fields from `com.cdbwsoft.library.panchip.FileInfo`, then records a
careful dead end: it never found the XOR key. `Blato58/MaskApp` decoded the payload
but never named the header fields past the first word. The derivation of the pad from
the seed `0x37627996` appears nowhere public at all.

Nobody has published a flash dump of any Panchip unit in this family, and nobody has
flashed modified firmware to one. One repo, `tayred06/shining-mask-controller`, claims
to have done so; its own logs show every probe going unanswered, and its "flasher"
writes to the display characteristics rather than the OTA service. Treat its success
claims as false.

Note on UUID provenance, since it misleads people: `0xfee9` plus the
`d44bc439-...` characteristics are the **Quintic QPP** transparent-serial profile
from the QN902x SDK, copy-pasted by Chinese firmware houses onto unrelated silicon
(it appears on Telink parts, LED masks, a toy car and a medicine cooler). It implies
nothing about the SoC. Telink's own OTA profile is the `00010203-0405-...-1910`
family, which this device does not use.
