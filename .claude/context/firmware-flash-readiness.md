# Pre-flash verification of joggles-v1

An independent re-check of the v1 build before it goes near a device, plus the method
that produced it. Findings only; judgement lives in `notes/firmware-design.md`.

Everything below was re-derived from the image rather than read out of the research
docs, because the point of the exercise was to catch a doc that had drifted. Two had.

## Method: disassemble without a toolchain

macOS Command Line Tools ship `llvm-objdump`, which is enough. No `arm-none-eabi`.

    bun research/ota-codec.ts decode firmware/TR1906R04-10_OTA.bin /tmp/fw10.bin
    bun research/tools/mkelf.ts /tmp/fw10.bin /tmp/fw10.elf 0x16800
    OD=$(xcrun --find llvm-objdump)
    $OD -d --triple=thumbv6m-none-eabi --start-address=0x18240 \
        --stop-address=0x182d0 /tmp/fw10.elf

Do the same on the **built** image, not only stock. Reading back what we intend to
flash is the check that closes the loop; everything else only verifies the inputs.

## Confirmed against the built image

- **The hook round-trips.** `abs 0x182a6` in `firmware/joggles-v1.bin` disassembles as
  `cmp r2,#0x4a` / `beq 0x182ac` / `b 0x182c2` / `mov r0,r4` / `ldr r1,[pc,#4]` /
  `blx r1` / `b 0x182c2`, literal `0x00026a3d` at `0x182b4`, nops to `0x182c0`, and
  the epilogue at `0x182c2` intact. *verified*
- **The `LIGHT` back-branch lands on the branch, not in the middle of it.** `0x184a6`
  decodes as `b #-0x200` targeting `0x182aa`, and `0x182aa` in the built image is
  `b 0x182c2`. *verified*
- **Nothing else enters the replaced block.** A full sweep of the code region below
  the animation banks for `B<cond>`, `B`, `BL`/`BLX` and for any 32-bit word equal to
  an in-range address found exactly one hit: `0x184a6`. The scanner was sanity-checked
  against the epilogue, which returns ten. *verified*
- **The extension assembles as designed.** Header at `0x26a24`: entry `0x00026a3d`,
  size `0x58`, table count 1, `TABLE[0] = 0x40` resolving to `hello` at `0x26a64`.
  Trampoline reads the sub-command at `[r4+3]`, bounds-checks it, indexes the table,
  `blx`. Reply constant at `0x26a74` is `f0 00 01 00 01 00`. *verified*
- **The length gate is 4 to 20 inclusive.** `abs 0x18268`: `adds r0,#0xe0` /
  `ldrb r0,[r0,#0x1b]` reads `[r4+0xfb]`, then `cmp #0x14 / bhi` and `cmp #4 / blo`.
  `jgx.hello()` is 4 bytes, exactly on the lower bound. *verified*
- **Register safety.** The dispatcher preloads `r5` and `r1` before the compare chain,
  so a hook clobbering them looked worth checking. The `J` path goes straight to
  `pop {r3,r4,r5,r6,r7,pc}`, which restores `r5`, and `r1` is caller-saved. The
  unmatched path touches nothing stock did not. *verified*
- **The notify sender's ABI is `r0 = length, r1 = payload`.** Read instruction by
  instruction at `abs 0x2145c`: odd/even memcpy into `0x20003041`, AES into
  `0x20003055`, then send on characteristic index `0x0b`, 16 bytes. Its three vendor
  call sites are `0x1832e`, `0x1839a`, `0x183a4`, all inside the same command
  dispatcher and the same prologue our hook runs under, all with `r0 = 7`. *verified*
- **The protected-region audit is clean.** `fwtool regions` reports 16 uncovered FMC
  and REGLCTL sites, all clock/power init or the two DATS content writers. The
  `CONFIG0` program sequence at `abs 0x17aac` is inside the FMC region. *verified*

## The one thing the notify sender still cannot answer statically

Whether characteristic index `0x0b` accepts a notification outside a DATS handshake.
Nothing in the sender depends on session state, and it is called from the same context
we call it from, so the static answer is yes. The client subscribes to `CHAR_NOTIFY`,
so the CCCD is enabled. The first `HELLO` on hardware is still the real test.

## The flash client did not exist until now

The gap that mattered most: `ota.check` was described as "the gate any future BLE
write path must pass", and there was no write path. `SERVICE_OTA` was a constant
nothing used, and the ordinary client discovers only the `fff0` characteristics
(now `packages/cli/src/noble.ts`, which discovers exactly four and refuses the rest).

Now `packages/core/src/dfu.ts` (wire format, tested) and `packages/cli/src/flash.ts`
(transport, `bun run flash`). Wire details are in `research/firmware-flashing.md`
under "The exact packets"; each was read off the handler and then confirmed against
the vendor's `PanchipOtaManager`/`FileInfo`, so none rests on one source.

The trap worth remembering: **every `fd01` write begins with two bytes the device
discards**, and the research doc did not say so. It fails safe, because the CRC at
ctrl `03` catches it, but it fails at the *end* of a full transfer.

## Still not done

- Nothing has been flashed. No `bun run flash` subcommand has ever met hardware, so
  the client is verified only by unit tests and by matching the vendor app.
- Whether the unit still advertises after the rename, and whether the trampoline
  fires. Both need step 5.
- Whether the bootloader re-validates on every boot, i.e. whether a bad staged image
  can be superseded by simply staging a good one. Unchanged from the flashing doc.
