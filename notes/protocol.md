# Funky Glasses+ BLE protocol

**Status: solved.** Both the command and bulk channels are reproduced
byte-for-byte against captured traffic from the real app.

Recovered from the vendor APK `com.pinkysinyeeho.funkyglassesplus` v1.1.8,
pulled from a Pixel 10 Pro and decompiled with jadx. The app is not obfuscated.

## Device

| Field | Value |
| --- | --- |
| Vendor app | `com.pinkysinyeeho.funkyglassesplus` |
| BLE advertised name | `GLASSES-{MAC}` |
| Manufacturer-data signature | `54 52 00 3A` (ASCII `TR\0:`) |
| Transport | BLE GATT, no pairing or bonding |

The app filters scan results on the manufacturer-data signature above, inside
the AD structure of type `0xFF` - see `ble/BleConfig.java`.

## GATT

| UUID | Role |
| --- | --- |
| `0000fff0-0000-1000-8000-00805f9b34fb` | service |
| `d44bc439-abfd-45a2-b575-925416129600` | command write |
| `d44bc439-abfd-45a2-b575-925416129601` | notify (device replies) |
| `d44bc439-abfd-45a2-b575-92541612960a` | bulk pixel upload |
| `d44bc439-abfd-45a2-b575-92541612960b` | bulk pixel upload |
| `00002902-0000-1000-8000-00805f9b34fb` | CCCD, to enable notifications |

**The service is `fff0`, not `fee9`.** `BleManager.UUID_SERVICE_TEXT` is `fff0` and
that is what `onServicesDiscovered` matches on; the `fee9` in `AppConfig.java` is a
stale default. The firmware declares both, twelve bytes apart in the same table, and
our `protocol.ts` uses `fff0` and connects. For what it is worth, `fee9` plus the
`d44bc439` characteristics are the Quintic QPP profile, copy-pasted across unrelated
silicon, so they imply nothing about the SoC.

Firmware OTA lives on a separate service: `fd00`, with `fd01` data and `fd02`
control. Those writes are **not** AES-encrypted. See
`research/firmware-image-format.md`.

## Encryption

**AES-128-ECB**, single hardcoded key, same key on both the command and bulk
channels. Every write is exactly one 16-byte block.

    34522a5b7a6e492c08090a9d8d2a23f8

The key is not a Java string: `csh/tiro/cc/aes.java` is a JNI shim over
`libAES.so`, and `keyExpansionDefault()` loads the constant from the native
image. Recovered by brute-forcing all 13,809 16-byte windows of the 13.8 KB
library against a known ciphertext, using the plaintext framing as the oracle -
exactly one window produced a well-formed frame (`tools/find_key.py`).

The published Shining Mask key `32672f7974ad43451d9c6c894a0e8764` does **not**
work here, despite the shared `d44bc439-...` UUID family.

## Frame format

    [len][opcode ASCII...][args...][zero padding to 16 bytes]

`len` counts opcode plus arguments, excluding padding. Opcodes are uppercase
ASCII, which is what makes a correct decryption self-evident.

Verified end to end: `enter_diy()` encrypts to `3b3eb0f5954bdabde610174b52bfcecb`,
identical to the byte sequence the real app sends.

Note the prior-art capture in `reference/ble_hacks/` labels that frame "clear
screen". It is actually `SMVEW 01` = enter DIY mode.

## Command table

Transcribed from `model/data/Agreement.java`. jadx renders the byte literals as
fastjson2 constant names; resolved values are `D`=68, `G`=71, `H`=72, `M`=77,
`N`=78.

| Command | Frame | Notes |
| --- | --- | --- |
| `STYPE` | `05 STYPE` | query panel size, reply on notify char |
| `SMVEW 01` | `06 SMVEW 01` | enter DIY mode |
| `SMVEW 03` | `06 SMVEW 03` | enter DIY, alternate |
| `SMVEW 02` | `06 SMVEW 02` | exit DIY and save |
| `SMVEW 00` | `06 SMVEW 00` | exit DIY without saving |
| `LIGHT n` | `06 LIGHT n` | brightness |
| `LEDON` / `LEDOFF` | `05` / `06` | panel on/off |
| `LIGHTON` / `LIGHTOFF` | `07` / `08` | flashlight |
| `SPEED n` | `06 SPEED n` | animation speed |
| `EVERT` | `05 EVERT` | invert display |
| `ANIM n` | `05 ANIM n` | built-in animation |
| `LOOA` | `04 LOOA` | loop animations |
| `IMAG n` | `05 IMAG n` | built-in image |
| `MODE 01` | `05 MODE 01` | static |
| `MODE 02 hi lo` | `07 MODE ...` | flashing, 16-bit rate |
| `MODE 03 n` | `06 MODE 03 n` | **mislabelled**, see "Two display paths" below |
| `MODE 04 n` | `06 MODE 04 n` | **mislabelled**, dead code in the app |
| `MODE 07` | `05 MODE 07` | "RP" mode |
| `MODE 08 n` / `MODE 09 n` | `06` | connect-roll right / left |
| `STOPR` | `05 STOPR` | stop rhythm mode |
| `SOUT` | `04 SOUT` | exit rhythm mode |
| `LEDFIRST` / `LEDSECOND` | `08` / `09` | address lens 1 or 2 |
| `SCHD on h m` | `07 SCHD ...` | scheduled on/off timer |
| `STSC` | `04 STSC` | read timer setting |
| `CALL st t` | `06 CALL ...` | incoming-call display |
| `DATS t hi lo` | `07 DATS ...` | announce a bulk upload, type + 16-bit length |
| `DATCP` | `05 DATCP` | bulk upload complete, device verifies and stores |
| `COLR` | `08 COLR ...` | colour, never emitted by the app |
| `LEVL` | `06 LEVL ...` | level, never emitted by the app |
| `POWR` | `05 POWR ...` | power, never emitted by the app |

Device replies on the notify characteristic: `DATSOK`, `DATCPOK`, `ERROR`. These
three are the only notifications the app parses, and all belong to `DATS`.

Which of these the app actually emits, and which are library dead code, is listed
in `research/vendor-app-protocol.md`. Dead in the app does not mean unsupported by
the firmware: `SMVEW 02` is dead in the app and works on our unit.

## Panel geometry - confirmed on hardware

Our unit (`GLASSES-12C3EF`) does **not** answer `STYPE`, on either
write-without-response or write-with-response, so geometry was derived
empirically instead.

| Property | Value |
| --- | --- |
| Grid | 9 rows x 24 columns |
| Origin | row 0 = bottom, column 0 = left |
| Row packing | row `r` -> bit `2*r` of the 3-byte column word |
| Bits per pixel | 2 (only the even bit is needed to light a pixel) |

The two-bits-per-pixel stride is the non-obvious part. Lighting bit `n` lands on
row `n // 2`, verified at bits 0, 11, 13, 15 and 16, and confirmed by drawing
the same box at stride 1 and stride 2: stride 2 fills the lens, stride 1 draws a
box in the bottom half only.

**The odd bit is brightness.** The panel is **4-level greyscale**, not
monochrome - pixel values 0-3. `display.Grid.set()` takes a level, and
`PIXEL_OFF/DIM/MID/ON` name the values.

Confirmed twice: alternating a filled region between `0b01` and `0b11` changes
brightness, and three eight-column bands at levels 1/2/3 read as three
increasing steps left to right.

**The steps are subtle.** A first attempt using six-column bands with one band
at level 0 read as "left quarter off, one block of brightness for the rest" -
the lit levels were not separable at that size. Wider bands with dark separator
columns made them distinguishable. Design for this: greyscale is good for
anti-aliasing and gradients, not for encoding information the wearer must read
at a glance.

The vendor's own frame data only ever uses `0b00` or `0b11`, so greyscale is
capability their app never exercises. Independent confirmation of the whole
encoding: our `Grid` reproduces `AnimData.getAnim1()` frame 1's column word
`262128` (= rows 2-8 at full level) exactly.

The vendor's own `parseType()` knows only 5x36, 12x48, 14x56 and 16x64, none of
which match. This model is simply outside the table, which is consistent with it
not answering `STYPE` at all.

### The panel is not a rectangle

Two physical gaps, mapped by drawing a full border and noting what was missing:

    #########......#########   top row: middle 6 pixels absent
    #........######........#
    #......................#
    #......................#
    #......................#
    #......................#
    #.........####.........#
    #........#....#........#   nose-bridge notch, 2 rows tall,
    #########......#########   6 wide at the bottom

`display.alive(row, col)` encodes this; `display.edge_pixels()` traces the true
silhouette. Confirmed correct against the hardware.

Practical consequence: **rows 2-7 are the only band alive across all 24
columns**, so text lives there. That is a 6-row band, hence the 5-row font.

## Bulk pixel format

One 16-byte block per display column, same encryption:

    [04][column index][3 bytes column bitmap][zero padding]

24 columns per write batch in the reference capture. Three bytes gives 24 bits
of vertical resolution, enough for any of the panel sizes above. Row 6 of the
capture sets 14 consecutive bits, consistent with a 14-row panel.

Verified: `column(0, 030000)` encrypts to `dde2655d6e7a9923a30db0f1f9e97ce4`,
identical to the capture.

## Hardware quirks that cost real time

**One 16-byte block per ATT write. Never batch.** MTU is 185, so 11 blocks fit
in a single write, but the panel decodes only the FIRST block and silently
discards the remainder. Batching 11 blocks per write updated columns 0, 11 and
22 and lost the other 21, which looks like corruption rather than an error.
Throughput comes from pacing, not from larger writes.

**Write-without-response has no flow control.** 24 back-to-back column writes
overrun the controller and some are dropped, leaving those columns showing the
previous frame - stuck LEDs during animation. Roughly 20 ms between writes is
enough. `client.Glasses.show()` handles both of these.

**Leaving DIY mode restores the saved image.** `SMVEW 00` hands the display back
to whatever was stored from the vendor app, so our frame vanishes and the old
message reappears looking like stray pixels. Stay in DIY (`end(mode="keep")`)
to keep a drawn frame up; use `LEDOFF` for a genuinely dark panel.

**No double buffering, and it cannot be fixed by going faster.** Columns land
one at a time, so a streamed full-panel update visibly sweeps left to right.

The wipe is transmission-bound, confirmed by measuring time-to-fill against
pacing: 468ms at 18ms, 165ms at 6ms, 58ms at 2ms - exactly 24 x pacing. But it
stays *visible* even at the fast end, because a high-contrast full-panel change
at ~2.4ms per column still reads as motion.

Practical consequences:
- Do not stream full frames for anything that should appear at once
- Send only changed columns (`Grid.deltaFrames()`); a sparse update sweeps
  proportionally less because it touches fewer columns
- For animation that must look clean, upload via DATS and let the firmware
  render from local memory - no transmission artefact, and no connection

The panel itself is a fast multiplexed matrix; it is not the limitation.

**A dead-looking rightmost column means dropped writes, not dead hardware.**
Unacked writes still queued when the connection drops are discarded, and the
casualty is the last column of the frame. Column 23 is fine; `AnimData`'s 295
frames are all 24 columns wide.

Handled in code: `Glasses.show()` sends its final write WITH response, so a frame
cannot be half-delivered. `commandRaw()` is deliberately unacked - callers
driving whole frames through it must `flush()` themselves. *verified* by the right
column being absent before the fix and present after.

**No mirroring.** Confirmed with an asymmetric glyph: column 0 really is the
left edge, and text renders the right way round with no flip needed.


## Two display paths: DIY buffer vs saved content

Established on hardware, and it corrects an earlier misreading of the command
table.

The device is **not** a dumb frame buffer. There are two separate things:

1. **DIY live buffer** - what `SMVEW 01` puts us into. Bulk column writes land
   here and show immediately. `SMVEW 02` saves it, and the content survives:
   drawing "JOM", saving, and disconnecting leaves "JOM" on screen.
2. **Stored content, displayed by the `MODE` family** - a different slot. On our
   unit it holds "WOWo", saved earlier from the vendor app.

Sending any `MODE` command while in DIY switches away from the live buffer to
the stored content. Every early test did this and threw the drawing away.

**`MODE`'s second byte is not speed.** Speed has its own opcode (`SPEED n`). Treat
the earlier "scroll left at speed n" labelling in the command table as **wrong**.

It is not a slot index either, at least not as the app uses it. The app emits
`getContentCommand(mode, dir)` -> `06 MODE <mode> <dir>` with `mode` 1 static, 2
horizontal scroll, 3 vertical scroll, and `dir` only ever 0 or 1. The
`getRollToLeft/RightCommand` variants that suggested a count are dead code, as is
`SPEED`'s neighbour set. So in the app the second byte is a **direction flag**.

That leaves a genuine tension: cycling `MODE 01 <n>` for n=0..7 produced different
displays on our unit. Both can hold if the firmware reads the byte more liberally
than the app ever writes it. Unresolved, and worth a careful sweep.

The device animates stored content by itself, with nothing connected: `MODE 03`
produced text bouncing left-to-right unattended. So upload-once-then-disconnect
is viable in principle, once we know how to get our content into the slot the
`MODE` commands read.

**How to get content into that slot: the `DATS`/`DATCP` handshake.** This is the
app's real persist-to-device path and it was missing from this document entirely:

    DATS <type> <len16>   on ...9600      07 44 41 54 53 tt hh ll
    -> DATSOK             on ...9601
    stream len bytes      on ...960a      [count][up to 15 data bytes] per block
    DATCP                 on ...9600      05 44 41 54 43 50
    -> DATCPOK            on ...9601      or ERROR

`type` is 1 for text and 2 for a DIY image; those are the only values the app
uses. Length is 16-bit, so up to 65535 bytes may be announced. All three reply
strings sit in the firmware image at body offset `0x1dbc`, which confirms the
handshake is firmware-side. There is no slot argument: one buffer per type.

Note that `SMVEW 02` is **dead code in the app** (zero callers), yet our hardware
test shows the device honours it. Dead in the app does not mean absent from the
firmware, so the dead-code list below is a menu to try, not a list to discount.

### Buffer width

Writing column indices 0..49 corrupted the display rather than extending it, so
the **DIY live buffer** is very likely 24 columns, matching the panel.

The **saved store is wider, and this is now proven.** The app's text path
concatenates 2-byte glyph columns into one flat buffer with no truncation, ships
it in a single `DATS 01 <len>`, and only then sends one `MODE` command. Its
40-character input cap works out at roughly 200 columns, about 8 times the panel,
in around 400 bytes. So wide device-side scrolling is real; the earlier failure
was writing wide into the live buffer instead of uploading to the saved store.

Untested and the obvious next experiment: `DATS` type 2 with a length greater than
72 bytes, then drive it with `MODE`, watching `...9601` for `DATCPOK` versus
`ERROR`. That also gives us a working request/response probe, which matters
because our unit never answers `STYPE`.

### Cross-checking against a live capture

The semantics above were recovered by reading the app's own code, which is the
authority on what it emits. An HCI capture is still the way to confirm ordering
and timing on the wire:

    adb shell settings put global bluetooth_hci_log 1
    # drive the app: type a message, save it, set it scrolling
    adb bugreport bug.zip     # btsnoop_hci.log is inside; no root needed

Decrypt each 16-byte write with the key and the sequence is self-explanatory. Note
the OTA channels are the one exception: those writes are **not** encrypted.

## Channel routing

Settled from the app's characteristic map.

| Characteristic | Role |
| --- | --- |
| `...9600` | commands, including `DATS` and `DATCP` |
| `...9601` | notify, device replies |
| `...960a` | `DATS` bulk stream, count-prefixed blocks |
| `...960b` | live/real-time: per-column DIY writes and rhythm frames |

So the `[04][column][3 bytes]` format documented above is the **live** format on
`...960b`. The `DATS` stream on `...960a` is a different encoding: a flat
concatenation of columns, 2 bytes per column for text and 3 for a DIY image.


## DATS/DATCP: storing content wider than the panel

**This is the mechanism the vendor app uses for real messages**, and it is
entirely separate from the DIY column path. Source of truth is
`model/data/TextAgreement.java`, confirmed against a full HCI capture.

### Handshake

    app -> cmd char (9600)   [07]["DATS"][01][len_hi][len_lo]
    dev -> notify (9601)     "DATSOK"
    app -> data char (960a)  [len][up to 15 payload bytes]   xN, ~50ms apart
    app -> cmd char          [05]["DATCP"]
    dev -> notify            "DATCPOK"  or  "ERROR"

Length is 16-bit big-endian (`Agreement.int2Bytes` = `[i/256, i%256]`).

**Data chunks are framed, not raw.** Each 16-byte block is `[length][15 bytes of
payload]`. Reassembly must strip that prefix; concatenating the full 16 bytes
shifts the whole bitmap and produces convincing-looking garbage.

Note the characteristic split: commands go to `9600` (`writeCharacteristic`),
bulk data to **`960a`** (`writeCharacteristicBy2`). Our DIY code uses `960b`,
which the reference capture used. Both bulk characteristics exist.

### Payload format

16-bit little-endian per display column, 14 rows:

    bits 0-6   rows 0-6
    bit  7     unused
    bits 8-14  rows 7-13
    bit  15    unused

This is a **different pixel encoding from the DIY path**, which uses 3 bytes per
column at bit stride 2. Do not mix them up.

Verified end to end: a captured 178-byte upload reassembles into 89 columns that
render as "ZZZ HELLO WORLD ZZZ" in the low 7 bits, the high field empty.

### Why this matters

The `MODE` commands display DATS-uploaded content, not the DIY buffer. That is
why every attempt to make `MODE 03` scroll our DIY drawing failed. To get our
own content animating standalone we must upload it via DATS, not by drawing
columns.

## Research gap: model/data/ was under-searched

`Agreement.java` was found by grepping for AES usage and read in isolation. Its
own directory was never listed, and it contains most of the protocol:

| File | Contents |
| --- | --- |
| `TextAgreement.java` | the DATS/DATCP upload protocol above |
| `DiyAgreement.java` | the DIY column protocol |
| `Text1456.java` | the vendor's font, `getStringBytes()` |
| `AnimData.java` | built-in animation bitmaps, 65 KB |
| `ImageData.java` | built-in image bitmaps |

The HCI capture only rediscovered what was already in the decompiled source.
When something looks undocumented, list the directory before inferring from
traffic.


## App-side preview data in model/data/

*derived*, decoded from the vendor APK.

These arrays are **not** the device's content banks. Per
`research/vendor-app-protocol.md`, `AnimData`/`ImageData` are app-side preview
thumbnails rendered locally and never uploaded; the real banks are
firmware-resident. Their value here is different: the previews are drawn in the
device's exact encoding, so they independently confirm our geometry.

### AnimData.java - preview frames

13 animations, sparsely numbered `getAnim1`..`getAnim19`, 295 frames total, between
2 and 58 frames each. Each frame is `int[24]` - one 24-bit column word per display
column, in exactly the DIY encoding.

This is strong independent confirmation of our geometry, from data we did not
derive: **every frame is 24 columns**, and the highest bit used across all 295 is
17, giving rows 0-8. Panel is 9 x 24, as measured.

Pixel levels across the whole bank: 62753 off, 17851 full, and 288 each of levels
1 and 2. The intermediate values are confined to `getAnim19`, whose column words
are `0x3AAAB` - an alternating pattern giving level `0b10` on most rows, i.e. a
deliberately dimmed effect. So the firmware supports greyscale and the vendor uses
it, just rarely.

`ImageData.java` holds 11 static previews, matching the app store's "11 preset
patterns". Again previews, not the uploaded bank.

Caveat: jadx rewrote some integer literals as same-valued library constants
(`HttpStatus.SC_*`, `Opcodes.*`, `PointerIconCompat.*`). 315 were skipped when
decoding, so counts are lower bounds. Resolve them before treating the bank as
complete.

### Text1456.java - the vendor font

`getStringBytes()` concatenates a per-character byte array (`get_A()`, `get_0()`,
...), falling back to rasterising the character via Android `Canvas` when it is not
in the table. That fallback is how it handles CJK.

37 glyphs extracted, variable width 2-7 columns, most 5. Encoding is the DATS
format: 16-bit little-endian per column.

**The vendor font only uses bits 0-6.** The union of every bit set across all
glyphs is `0b1111111`, so rows 7-13 of the DATS format are never touched by their
text renderer. Their text is 7 rows tall on a 9-row panel.

This does not prove rows 7-8 are unreachable through DATS - only that the vendor
never uses them. *unverified*, and worth one hardware test, because it decides
whether uploaded graphics can use the full panel height or only 7 of 9 rows.

## Open questions

Answered since the last pass:

- [x] **Which bulk characteristic is live.** Both, for different jobs: see the
      routing table above.
- [x] **Whether DIY mode must be entered before bulk writes are accepted.** Not for
      `DATS` uploads: the text path never enters DIY. DIY is for the live channel.
- [x] **Text: device font or app rasterisation?** The app rasterises, at 12x12 from
      bundled TTFs plus a hardcoded glyph table, and uploads columns. The firmware
      does carry a small 5-row glyph strip and a "Cool" bitmap for its own built-in
      content, so both exist but serve different purposes. Our own rasteriser is
      free to do better for a 6-row band.
- [x] **Our unit's panel size via `STYPE`.** No route through the app: it never
      sends `STYPE`, and its `parseType` only knows 5x36, 12x48, 14x56 and 16x64,
      none of which match 9x24. Empirical mapping stays the only option.

Still open:

- [ ] Bit order within the 3-byte column: MSB-first assumed, unverified
- [ ] `MODE` second byte: direction in the app, but n=0..7 differ on hardware
- [ ] `DATS` type 2 with a payload wider than 72 bytes
- [ ] `LEDFIRST`/`LEDSECOND` lens select, and the odd bit's meaning
- [ ] `COLR`, `LEVL`, `POWR`: real opcodes in the app's tables, never emitted
- [ ] **A third service, `ae00`.** A GATT dump of a device in this family shows
      `ae00` alongside `fff0` and `fd00`, with `ae01` write-without-response and
      `ae02` notify. `ae02` answered a raw ping with
      `0153c83c1af70dade3829bda9a972c60cc`. Absent from the Panchip SDK and from our
      own notes, and nobody has investigated it. Free to enumerate, zero risk
- [ ] **`TIME`**, an opcode captured as ciphertext by a mask project with no known
      meaning. Not in our command table. Related: that project reports `DATCP` can
      carry a unix timestamp argument, which we send bare

## Further reading

- `research/vendor-app-protocol.md` - the `DATS`/`DATCP` subsystem in full, the
  complete live-versus-dead opcode inventory, `IMAG`/`ANIM` bank ranges, and every
  hard limit with its source.
- `research/firmware-image-format.md` - the OTA container (solved: XOR pad plus a
  CRC-32 over the deobfuscated body, no signature), what is inside the firmware,
  and why flashing is still not safe.
- `research/ota-codec.ts` - decode, encode and verify OTA images.
