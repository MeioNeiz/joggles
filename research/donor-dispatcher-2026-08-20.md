# The donor build's dispatcher, and a hook that costs four bytes

**Confidence markers are `research/README.md`'s three**: *verified*, *derived*,
*unverified*. Everything here is *verified* from the bytes of
`firmware/dump-12E69E-2026-08-19-a.bin` and `firmware/TR1906R04-10_OTA.bin`. Nothing
here touched hardware.

## Verdict

***Updated 2026-08-20, later the same day: everything below was written before the fix
and the fix has landed.*** `build-firmware --from-donor --into-fill` now produces an
image that passes `ota.check` with `referenceUnregistered === 0`, the four-byte hook is
implemented and **executed** by `research/tools/updater.test.ts` against a model of the
part, and the resident updater is in it. What follows is the measurement that made that
possible, kept in the tense it was written in where the reasoning is the point, with the
"not built yet" claims struck at the end.

**`build-firmware --from-donor` did not work, and the reason was not a flag.**
`ext.resolveLayout` cannot find the `LOOP` dispatcher arm in a real unit's image at
all, not even a six-byte prefix of it, so the donor rebase stops before it reaches
any of the three refusals `notes/swd-flashing.md` predicted. The donor runs a
different build, `TR1906R04-12`, and the block the hook was designed to overwrite has
a different length, a different register, and **ten branches into its last four
bytes**.

**The ten branches were found by `ext.branchesInto`, before anything was built.** That
matters more than the finding: `CLAUDE.md` has carried "never overwrite a block of
firmware without first scanning for branches into it" since the `LIGHT` arm at
`abs 0x184a6` was caught jumping into the middle of the `LOOP` block, after two of this
repo's own documents had said that block had one entry point. This is the same failure
at ten times the scale, on a build nobody had disassembled, and it was caught by pointing
the tool at the block rather than by anyone noticing. The rule works, and it only works
if it is run rather than remembered.

**The answer is a smaller hook, not a ported one.** Both builds carry a dead compare
in the dispatcher chain, four bytes, whose `beq` targets a branch island nothing else
reaches. Replacing those four bytes with one `bl` into free flash reaches the
extension, costs no vendor opcode at all, and needs no analysis of the block the old
hook was going to overwrite. It resolves by content on both builds, so one
implementation serves the APK study object and the image we would actually flash.

## The donor is a different build, and here is how different

*verified.* Both dispatchers are a flat chain of `cmp <reg>, #<ascii>` / `beq
<island>` on the opcode's first letter, in the same order, `D S L A M C I S`, with the
second `S` dead in both. Everything else moved.

| | APK, `TR1906R04-10` | Donor, `TR1906R04-12` |
| --- | --- | --- |
| image ends | `0x26a24` | `0x28790` |
| head word 0 | `0x00026904` | `0x00028670` |
| dispatcher chain | `0x18286`-`0x182a5` | `0x184ea`-`0x18509` |
| opcode register | **`r2`** | **`r1`** |
| frame pointer | `r4` | `r4` |
| opcode load | `ldrb r2, [r4, #2]` at `0x18280` | `ldrb r1, [r4, #2]` at `0x184e4` |
| dead second-`S` compare | `0x182a2`, `53 2a 69 d0` | `0x18506`, `53 29 6b d0` |
| its dead island | `0x1837a`, 1 referrer | `0x185e2`, 1 referrer |
| the `LOOP` block | `0x182a6`, **28 bytes** | `0x1850a`, **32 bytes** |
| epilogue after it | `0x182c2` | `0x1852a` |
| `LIGHT` back-branch into the block | `0x184a6` -> `0x182aa` | `0x18710` -> `0x1850e` |
| branches into the block's tail | **0** | **10** |
| `notify` | `0x2145c` | `0x21b70` |
| vendor AES key | `0x22b94` | `0x235dc` |
| `GLASSES-` prefix | `0x2691c`, 1 copy | `0x28688`, 1 copy |

The two anchors that still resolve unchanged are the frame pointer and the opcode
offset: `[r4, #2]` in both. Everything a patch would write moved.

## The ten branches, which are the thing that would have bitten

*verified.* In the donor the last four bytes of the `LOOP` block are
`bl 0x22768` at `abs 0x18526`, and it is a **shared tail**: ten other dispatcher arms
set `r0` and branch straight to it rather than carrying their own call.

    0x18632  0x186fc  0x18776  0x187a4  0x187b4
    0x187c2  0x187c6  0x187ca  0x1880c  0x18810

So the donor's block is 32 bytes of which only 28 are spendable, and the boundary is
not marked by anything a reader would notice: `image[hookAddr + 28]` is not the
epilogue, it is the shared call, and the epilogue is four bytes further on. The APK
build has **zero** branches to the same instruction, because its compiler did not
merge those tails. A hook ported by address, or by "the block runs to the next `pop`",
takes ten opcodes out with it.

**This is the second time this exact shape has been found in this dispatcher, and the
first time it was one branch rather than ten.** `CLAUDE.md` already carries the rule
("Overwrite a block of firmware without first scanning for branches into it") from the
`LIGHT` arm's back-branch. `ext.branchesInto` is what found both, and on the donor it
was pointed at the block before anything was built, which is the order that rule
exists to force.

## The hook that costs four bytes

*verified* against both images.

Both chains end with a compare that can never fire. In the APK, `cmp r2, #0x53` at
`abs 0x182a2`; in the donor, `cmp r1, #0x53` at `abs 0x18506`. An earlier `S` compare
in the same chain always matches first (`0x1828a` and `0x184ee`), so the second one is
dead code and so is the branch island it targets, which has exactly one referrer: the
dead compare itself. Nothing branches into the four bytes.

Replace those four bytes with a single `bl` to the extension entry:

    0x18506:  bl <ext entry>          ; was  cmp r1,#0x53 / beq 0x185e2

`bl` reaches +/-16 MB and the extension sits about 66 KB away, so no branch island and
no literal pool are needed. `lr` is free to clobber: the dispatcher's prologue is
`push {r3,r4,r5,r6,r7,lr}` and every path returns through `pop {r3,r4,r5,r6,r7,pc}`,
so `lr` is dead from the prologue onwards.

The trampoline re-reads the opcode from the frame rather than trusting the register,
which is what makes one implementation serve both builds:

    entry:  ldrb <opreg>, [<framereg>, #2]
            cmp  <opreg>, #'J'
            bne  not_ours
            ...handler, free to clobber r0-r3...
            ldr  r0, =<epilogue>|1
            bx   r0                    ; ours: straight to pop {r3-r7,pc}
    not_ours:
            bx   lr                    ; back to the instruction after the hook

`<opreg>` and `<framereg>` are read out of the `ldrb` that feeds the chain, so the
`r2`-versus-`r1` difference between the builds is resolved rather than assumed. The
re-load writes the register back with the value it already held, so the fall-through
path continues bit-identical to stock.

**What the fall-through lands on is why the site is the right one.** `bx lr` returns
to the instruction after the hook, which in both builds is the dead second-`L`
compare (`cmp r?, #0x4c`) whose branch always goes to the epilogue. That is exactly
what stock does with an unmatched opcode. The other candidate site, the `LOOP` block
itself, would have returned into the middle of the `LOOP` letter checks, so a frame
like `XOOP` would newly be treated as `LOOP`.

### What it costs, against what the 28-byte hook cost

| | 28-byte block hook | 4-byte `bl` hook |
| --- | --- | --- |
| vendor bytes changed | 28 (27 differing) | 4 |
| opcodes lost | `LOOP` on the APK; `LOOP` **and `LOOA`** on the donor | none |
| depends on the block having one entry point | yes, and the donor has two | no |
| depends on the block's length | yes, and it differs per build | no |
| depends on the opcode register | yes | no, it re-loads from the frame |
| runs on frames that are not ours | no | yes, one compare and a `bx lr` |

The last row is the whole cost: every command frame whose opcode is not one of
`D S L A M C I` now runs four extra instructions. At 26 MHz against a 6.42 ms frame
budget that is not measurable.

`LOOA` is a donor-build opcode with no APK counterpart: `L O O A` calls
`set_mode(35)`, where `LOOP` calls `set_mode(24)`. The 28-byte hook would have taken
both.

## The tail nobody erased is not an older image, it is this one

***Corrected 2026-08-20.*** `notes/swd-flashing.md`, "The tail nobody erased", reads
the 7,047 bytes at `0x26c00`-`0x28786` in unit 1's bricked dump as the survival of "an
earlier, longer factory image". *verified* wrong: it is the tail of **the image the
donor runs**, `TR1906R04-12`, which is 76,720 bytes against the APK container's 66,084.
Three witnesses:

- the donor's own application occupies `0x16800`-`0x28790`, so 73,616 bytes, and its
  bytes in `0x26c00`-`0x28786` are the same bytes;
- the repair found 20 of the 150 pages, exactly that span, already matching the donor
  **before** anything was written (`research/aprom-write-2026-08-20.md`);
- `GLASSES-` appears once in the donor at `0x28688`, and unit 1's bricked window held
  it twice, at `0x2691c` in the APK image and at `0x28688` in the tail.

Two consequences. The **second `GLASSES-` prefix that `notes/swd-flashing.md` tells a
donor build to expect does not exist on a donor**: it was an artefact of unit 1's
bricked window carrying two images at once, and `--name-at` is not needed. That bullet,
under "Three things to expect on a real donor", is the stale line in that file. And the
reading that "whoever flashed the current image erased only the pages it needed" was
right about the mechanism and wrong about which image was older: the shorter one was
newer, and it was the 2026-08-08 OTA.

**This is a re-derivation, not a discovery, and the earlier one deserves the credit.**
`research/variant-mismatch-2026-08-19.md`, "What the orphan tail is, and the correction
it forces", established the same thing a day earlier and *verified*, and
`notes/swd-flashing.md` had already been corrected to match. What is genuinely new here
is the `GLASSES-`-appears-once witness and the `--name-at` consequence.

## Free flash on a donor image

*verified* from `firmware/dump-12E69E-2026-08-19-a.bin`.

| Span | Size | State |
| --- | --- | --- |
| `0x2878c`-`0x287ff` | 116 B | erased, `0xff` |
| `0x28800`-`0x293ff` | 3,072 B | programmed zeros, 6 whole pages |
| `0x29400`-`0x3bfff` | 76,800 B | OTA staging bank, **not blank on this unit** |

So the extension has about **3.1 KB inside the application window**, against the
10,628 bytes `build-firmware` reports on the APK image, and reaching it needs
`--into-fill` because six of those pages are zeros rather than erased. `EXT_BASE
0x26a24` lands in the middle of live code on this image and `ext.placeExtension`
refuses it, which is correct.

The staging bank holds a previous staged image on the donor, so it is not free by
inspection, but it is scratch by design and it is outside the application region.
That is where anything larger than 3 KB has to live.

## What this changed in the tools, as built

`research/tools/ext.ts` used to resolve the hook by 28 literal bytes of the APK's
compiler output, none of which appear in this build. `findHookSite` now resolves it
structurally, and the five checks it makes are the argument rather than decoration:

| Check | What it is for |
| --- | --- |
| exactly one chain of six or more `cmp <reg>,#<letter>` / `b<cond>` pairs | so a false positive elsewhere in the image cannot be chosen |
| an `ldrb <reg>,[<frame>,#2]` within 24 bytes before it | that is what makes the register the opcode |
| the two compares of the repeated letter are the **same halfword** | reads bytes the hook does not write, so it is evidence rather than a tautology |
| **nothing branches into the span between them** | the deadness argument, and it was missing from the first version |
| the island has exactly one referrer, and nothing enters the four bytes | the rule from `CLAUDE.md`, run |

**The first version of this got the fourth one wrong**, and review caught it: it checked
the island's referrers and presented that as proof the compare could never fire, which it
is not. An island with one referrer says where a branch goes, not whether anything jumps
in behind it. Planting `b <first S compare>` in the span was accepted with no complaint.

`hookStockBytes` is also **not** the check it was first documented as. It re-encodes the
four bytes from fields decoded out of those same four bytes, so it cannot fail: fuzzing
4,000 mutated dispatcher regions accepted 2,129 sites and found zero disagreements. It
is a shape assertion. The halfword comparison above is the content one.

## Struck: what has been built since this was written

- ~~Nothing in this document has been built yet.~~ All of it is, and
  `bun run build-firmware --from-donor --into-fill` passes.
- ~~The `bl` hook has not been assembled or asserted against an image.~~ Assembled,
  asserted against the donor's bytes, and **executed**:
  `research/tools/thumbsim.ts` is an ARMv6-M interpreter and a model of this FMC, and
  `ext.test.ts` runs the trampoline for a frame that is ours and one that is not. It
  also runs the vendor's own `LOOP` and `LOOA` arms through the hooked dispatcher and
  gets `set_mode(24)` and `set_mode(35)`, which is a check on the interpreter as much
  as on the hook.
- The extension is **980 bytes** now rather than 96, because the resident updater is in
  it: `notes/patch-over-bt.md`.

## Open

- **Nothing here has run on silicon.** Every claim is from two images and a model.
- **The staging bank's contents on the donor are unidentified.** 150 used pages that
  are not the reference image, and nobody has asked what they are. It matters more than
  it did: the slots live there.
- **`PROTECTED_REGIONS` is an APK-layout map and is misaligned on this build.** 16
  FMC/REGLCTL sites fall outside every protected region on the APK, which is the number
  `fwtool regions` asserts is expected; on the donor it is 39, and three sites of the
  flash driver alone have slid out of the span named for it. Nothing we write lands in
  one either way, so this is the gate's confidence being wrong rather than a hazard.
