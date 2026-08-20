# The FMC register map, resolved by content on both builds

**Status: offline analysis, 2026-08-20, track 59. No hardware was touched. Nothing was
flashed. Our own firmware has still never run anywhere**, `firmware/joggles-v2.bin` is
still unflashed and `firmware/joggles-v1.bin` is still barred.

**Scope:** the open item in `notes/patch-over-bt.md`, "Open, in the order it matters":
*the FMC primitive addresses on the donor build have not been resolved ... this is a
question of finding the register base and confirming it, not of calling anything.* So:
where the FMC registers are on the image a healthy unit actually runs, how that is known
without matching an address, whether the register writes `research/tools/updater.ts`
performs are justified against that map, and what the two builds disagree about.

**Verdict: the base is `0x5000c000`, the lock register is `0x50000100`, and the five
offsets are `+0x00 ISPCON`, `+0x04 ISPADR`, `+0x08 ISPDAT`, `+0x0c ISPCMD`,
`+0x10 ISPTRG` on both builds.** All of it *verified*, twice over: from the bytes of the
donor's own application by an idiom resolver that never matches an address, and on silicon
by the 2026-08-20 SWD run, which drove exactly those five addresses 116,000 times and
brought a dead unit back. **Every constant in `updater.ts`'s FMC block is correct.** Three
of its register writes deviate from every witnessed sequence, one of its constants is
witnessed by nothing on this hardware, and one missing read-back turns a silent
lock failure into a misleading reply code. None of the three is a live bug and all three
are a handful of halfwords.

The tool is `research/tools/fmcres.ts`. `bun research/tools/fmcres.ts <image-or-dump>`.

## Verdict

| Question | Answer | Confidence |
| --- | --- | --- |
| FMC register base on the donor build | **`0x5000c000`**, from 20 `ldr` sites resolving 17 distinct literal words, 19 of which feed an ISP poll | ***verified*** from the donor's bytes |
| `SYS_REGLCTL` on the donor build | **`0x50000100`**, from 15 sites writing `0x59`/`0x16`/`0x88` to offset 0 | ***verified*** from the donor's bytes |
| The five register offsets | `0 / 4 / 8 / 0xc / 0x10`, identical on both builds | ***verified*** from bytes, and on silicon by the 2026-08-20 APROM write |
| Do the two builds put the ISP helpers at the same addresses | **No, and the delta is not even constant.** `+0xf4` up to the config reader, `+0x110` from `program_word` on | ***verified*** from bytes |
| Why | **the donor carries one 28-byte ISP primitive the APK build does not have**, plus the caller that uses it | ***verified*** from bytes |
| Are `updater.ts`'s `FMC_BASE`, `FMC_WRPROT` and `FMC_OFF` right | **Yes, all seven values, on both builds** | ***verified*** from bytes |
| Is its stated provenance right | **No.** `abs 0x17a78` is the APK build's config writer; on the donor that address is an instruction inside the hardware-CRC helper | ***verified*** from bytes |
| Are the `ISPCON` bits it sets justified | **Yes: `ISPEN`, `APUEN` and `ISPFF` are each witnessed being set by vendor code on the donor image** | ***verified*** from bytes |
| Is the bit it *preserves* justified | **No. `BS` is touched by nothing in either application image**, and `fmc_lock` discards it anyway | ***verified*** by absence |
| Does `CBS` gate application-driven ISP | **No.** The gate is `ISPEN` plus the four `*UEN` bits; `CBS` is a reset-latched address-map property and appears in no ISPFF condition | *derived*, four legs, section 5 |
| Does anything here move our firmware closer to silicon | **No.** Not one instruction of ours has executed on a device | |

## 1. How the answer is known, which is the whole point

**Nothing below matches an address.** Every answer comes from an instruction idiom, which
is why the same code answers on the vendor's APK container and on a 256 KB dump of a real
unit and is free to give different addresses for each without either being a failure. That
matters here specifically: `EXT_BASE`, the SRAM map, the hook length and the dispatcher
arms have all in turn been APK facts that read as hardware facts, and the 28-byte hook
would have cost ten opcodes on a real unit (`research/donor-dispatcher-2026-08-20.md`).

| Resolved | Idiom | Why it is unambiguous |
| --- | --- | --- |
| the base, and `ISPTRG` | `ldr rP,[rB,#T]; lsls rP,rP,#31; bne` back to the `ldr` | The unbounded poll every NuMicro flash driver spins in. 19 of them on the donor, all on one base. The only other peripheral in either image wearing the same shape is the radio block at `0x40070040`, which the tool reports rather than merges |
| `ISPCMD`, and the opcode set | a `str` of an immediate from the manual's closed opcode set, inside a sequence ending in that poll | The set is `0x00 0x04 0x0b 0x0c 0x0d 0x21 0x22 0x23 0x2d 0x2e` and "the other commands are invalid" |
| `ISPADR`, `ISPDAT` | the remaining stores to the base register, in program order | A `0x21` program writes both, so the pair is ordered by a sequence that has two rather than by a rule about which offset is lower |
| `ISPCON`, and every control bit | read-modify-write idioms: `orrs` with an immediate sets a bit, `lsrs #1; lsls #1` clears bit 0, `lsls rW,rY,#25` tests bit 6 | Resolved **before** `ISPADR`, because the config writer sets `CFGUEN` inside the sequence it triggers an erase from, so an `ISPCON` store sits between the base load and the poll |
| `SYS_REGLCTL` | three adjacent stores of `0x59`, `0x16`, `0x88` to offset 0 of one register | The manual requires them adjacent: "any different data value, different sequence or any other write to other address during these three data writing will abort the whole sequence" |
| whether the unlock is retried | `ldr; cmp #0; beq` back to the first of the three | The vendor's `do`/`while`. 12 of the donor's 15 sites have it |

**Both of `fwtool.ts`'s scanning traps are honoured, and the second one bites.** Nothing
scans for a word: a literal counts only when an `ldr rN,[pc,#imm]` resolves to it, and it
becomes the base only when a poll uses the register that load wrote. And the base is
**computed into an address** in both builds, `0x5000c000 << 6 = 0x00300000`, the config
aperture, which appears as a literal nowhere. `fmcres` reports that shift as a finding, and
only once something stores the result into the resolved `ISPADR`, which is what keeps the
poll's own `lsls #31` out of the answer.

## 2. The donor build's ISP primitives, and the delta that is not a delta

*verified* from `firmware/dump-12E69E-2026-08-19-a.bin`, confirmed byte-identical against
the `-b` dump. Addresses are `abs`. "Callers" counts BL/BLX-immediate sites.

| Primitive | Donor entry | APK entry | Delta | Callers (donor / APK) |
| --- | --- | --- | --- | --- |
| disable ISP, `ISPCON &= ~ISPEN` | `0x17a0c` | `0x17918` | `+0xf4` | 14 / 11 |
| page erase, `ISPCMD 0x22` | `0x17a1c` | `0x17928` | `+0xf4` | 4 / 4 |
| hardware CRC32, `0x2d` then `0x0d` | `0x17a4c` | `0x17958` | `+0xf4` | 1 / 1 |
| enable ISP, `ISPCON \|= ISPEN` | `0x17aa0` | `0x179ac` | `+0xf4` | 15 / 12 |
| read word, `ISPCMD 0x00` | `0x17ab0` | `0x179bc` | `+0xf4` | 3 / 3 |
| read `CONFIG0`-`3` through the `0x300000` aperture | `0x17acc` | `0x179d8` | `+0xf4` | 1 / 1 |
| **read ID, `ISPCMD 0x04`** | **`0x17b50`** | **absent** | | **1 / -** |
| program word, `ISPCMD 0x21` | `0x17b6c` | `0x17a5c` | `+0x110` | 2 / 2 |
| config-page writer, erase then program | `0x17b88` | `0x17a78` | `+0x110` | 1 / 1 |

**The delta changes from `+0xf4` to `+0x110` in the middle of the block, and that is the
sharp edge.** The 28 bytes are the donor-only `ISPCMD 0x04` helper at `0x17b50`. Anybody
who ports an APK address into a donor build by adding a constant offset gets the right
answer for six helpers and lands inside the wrong function for the last two. It is the same
shape of mistake as the 28-byte hook, in the same block of the same image, and it is the
reason this document resolves rather than adjusts.

**The donor also carries the caller, and it is a part-identity check the APK build does not
make.** *verified* from bytes, at `0x1800a`-`0x18038`: unlock `REGLCTL` with the retry,
`ISPCON |= ISPEN` inline rather than through the helper, `bl 0x17b50` with
`ISPADR = 0x400068`, take bits `[19:16]` of the word that comes back, disable ISP, re-lock,
then `cmp r7, #0xb` and branch. No update-enable bit is set anywhere in it, which is
consistent with the ID commands needing only `ISPEN`. **What that field is, and what the
branch does differently when it is not `0xb`, is *unverified*** and was not chased: it is
recorded because it is an ISP call site on the hardware's own firmware with no counterpart
in the APK, and because `0x400068` is not one of the `ISPADR` values
`research/fmc-erase-program.md` finding 8 lists for the ID commands.

**The erase-and-program wrapper `research/fmc-erase-program.md` section 3 documents on the
APK build is at `0x1ee5a`-`0x1ee92` on the donor.** Same six steps in the same order, and
worth having located because it is witness 2 for the 512-byte granularity:

| Step | Donor | What |
| --- | --- | --- |
| 1 | `0x1ee6c` | `REGLCTL = 0x59, 0x16, 0x88`, read back, retry the triple until non-zero |
| 2 | `0x1ee78` | `bl 0x17aa0`, `ISPCON \|= ISPEN` |
| 3 | `0x1ee7e` | `ISPCON \|= 0x08`, `APUEN` |
| 4 | `0x1ee88` | `bl 0x17a1c`, page erase at `staging_base + offset` |
| 5 | `0x1ee8c` | `bl 0x17a0c`, `ISPCON &= ~ISPEN` |
| 6 | `0x1ee92` | `REGLCTL = 0` |

## 3. Every `ISPCON` bit this hardware's own firmware touches, and the three it never does

*verified* from the donor image. The right-hand column is where the bit position comes
from if the image is the only source.

| Bit | Name | Donor witness | Position established by |
| --- | --- | --- | --- |
| 0 | `ISPEN` | set at `0x17aa2` and `0x18020`, cleared at `0x17a0e` | the image, twice, two ways |
| 1 | **`BS`** | **none** | the CMSIS header alone |
| 2 | **`SPUEN`** | **none** | the CMSIS header alone |
| 3 | `APUEN` | set at `0x19336`, `0x1ee7e`, `0x1ef16`, `0x1eff0`, `0x1f078`, `0x21bda`, `0x21c1e` | the image, seven times, **and silicon**: the 2026-08-20 run wrote APROM with `ISPCON = 0x49` and 19,200 words landed |
| 4 | `CFGUEN` | set at `0x17b94` | the image, and silicon by the 2026-08-19 config repair |
| 5 | **`LDUEN`** | **none in either application** | the CMSIS header, plus the bootloader at `ld 0x100bd8` (`research/fmc-erase-program.md`) |
| 6 | `ISPFF` | tested by `lsls #25` at `0x17a2e`, `0x17a7e`, `0x17bae`; write-1-cleared at `0x17a34`, `0x17bb4` | the image, both ways |

**A swap of `APUEN` and `SPUEN` is disproven on silicon, not merely unlikely.** If `APUEN`
were bit 2, `ISPCON = 0x49` would have enabled the SPROM and left APROM protected, every
program would have been a pre-flight refusal, and the 2026-08-20 read-back would have
failed on the first word instead of passing 19,200 times.

**And our mask does not need `SPUEN` or `LDUEN`'s positions to be right.** `fmc_unlock`
computes `(old & 0x02) | 0x49`, so bits 2, 4, 5 and everything above 6 are written zero
whatever they turn out to be. That is a stronger property than the vendor's own
read-modify-write, which sets one bit and preserves whatever the rest hold, and it holds
unless an update-enable bit shares a position with `ISPEN`, `BS`, `APUEN` or `ISPFF`, which
is impossible.

**The lock register, for completeness.** 15 unlock sites on the donor against 12 on the APK;
12 retry the triple, 14 re-lock by writing zero. `updater.ts` re-locks the same way on
every exit path, which the tests already hold it to.

## 4. What the resident updater writes, and whether each write is justified

`research/tools/updater.ts` drives the registers itself and calls none of the helpers in
section 2, which is the right design: a helper address is a build fact and a register
offset is a silicon fact. Below is every register write it emits, checked against the map
rather than against the vendor's functions. `bun test research/tools/fmcres.test.ts`
asserts the first column mechanically, on both images.

| Write | Register | Justified by | Verdict |
| --- | --- | --- | --- |
| `0x59`, `0x16`, `0x88`, adjacent | `REGLCTL +0x00` | 15 donor sites, and the manual's adjacency rule. Nothing is interleaved | correct |
| `(old & 0x02) \| 0x49` | `ISPCON +0x00` | `ISPEN`, `APUEN`, `ISPFF` all witnessed; the mask zeroes every other update-enable bit whatever its position | correct, and stronger than the vendor's form |
| `addr` | `ISPADR +0x04` | 19 donor sequences | correct |
| `data` | `ISPDAT +0x08` | the `0x21` sequences, plus the result read in the `0x00` and `0x0d` ones | correct |
| `0x21` / `0x22` | `ISPCMD +0x0c` | both opcodes witnessed on both builds; `0x23` and `0x26` appear in neither | correct |
| `1` | `ISPTRG +0x10` | the poll idiom itself, 19 times | correct |
| poll `ISPTRG` bit 0, then test `ISPCON` bit 6 | | the same three instructions the vendor uses, and `ISPFF` is the only fail flag this generation has | correct |
| `0` | `ISPCON +0x00`, on lock | **nothing writes `ISPCON` wholesale in either image** | see finding 1 |
| `0` | `REGLCTL +0x00`, on lock | 14 donor sites | correct |

### Finding 1: the `BS` mask does nothing, twice over

`fmc_unlock` (`updater.ts:161`-`162`) preserves `ISPCON_BS`, and `fmc_lock`
(`updater.ts:174`) then writes `ISPCON = 0` wholesale, which clears it. So the two
instructions that preserve the bit are undone four instructions later on every exit path.
On top of that, **`BS` is the one constant in the updater's FMC block that nothing on this
hardware is witnessed touching**: no code in either application image reads or writes bit 1,
and its position comes from the CMSIS header alone.

`research/tools/swdflash.ts` has the identical pair, `ISPCON_KEEP = ISPCON.BS` on the way
in and `ISPCON_OFF = 0x00` on the way out, and it **already happened on silicon**: the
2026-08-20 repair session ended by writing `ISPCON = 0`, and the unit booted from APROM and
advertised. So this is harmless on these units, and the reason is that `CONFIG0` bit 7 is 1,
so `BS` reads 0 and zeroing it changes nothing.

**Recommendation: a comment, not a code change.** Both files reason carefully about
preserving `BS` and neither says that the lock write discards it. Changing `fmc_lock` to
clear only `ISPEN`, as the vendor does, would be closer to the witnessed sequence and
costs two halfwords; leaving it and saying so is also fine. What is not fine is the current
state, where a reader concludes the boot-select bit is being protected.

### Finding 2: the unlock is not read back, and the failure it hides reports the wrong cause

The vendor retries the whole triple in a `do`/`while` at 12 of the donor's 15 sites;
`swdflash` checks once and aborts. `fmc_unlock` does neither: it writes the three keys and
carries straight on.

What that costs is precise, and it is not corruption. `ISPCON` and `ISPTRG` are
`REGLCTL`-protected; **`ISPCMD` and `ISPADR` are not.** So with the lock still closed the
command and the address land perfectly happily, the write to `ISPTRG` is *ignored*, the
poll finds bit 0 already clear and falls straight through, `ISPFF` is clear because no
operation was ever triggered, and `fmc_op` returns success. The read-back in
`program_word` and `erase_page` is what catches it, which is exactly the argument for
never trading the read-back away. But the reply the phone gets is `FMC_REFUSED`, and
nothing was refused: nothing was triggered.

**Cost of the vendor's version: three halfwords**, `ldr r1,[r0]; cmp r1,#0; beq` back to
the first key store. Worth taking, because the resident half is the part a probe is needed
to fix and a misleading diagnosis there is expensive.

### Finding 3: `erase_page` asserts word alignment, not page alignment

`fmc_op` (`updater.ts:218`) checks `addr & 3`, which is the requirement for a 32-bit ISP
operation. A **page erase** address must additionally be 512-byte aligned, and a misaligned
one is not an `ISPFF` condition: the low bits are ignored and the containing page is erased
with success reported (`research/fmc-erase-program.md`, finding 6). `swdflash` asserts both
after track 54; `erase_page` (`updater.ts:272`) asserts neither beyond what `fmc_op` gives
it.

**Not a live bug.** Every caller is aligned by construction: `erase_span` walks from
`SLOT_A` or `SLOT_B`, both 512-aligned, in `PAGE` strides. It is the one place the two
tools' guards disagree, and the fix is `movs r0,#0xff; ...` or a compare against
`page_size - 1`, three halfwords.

### Two deviations that cost nothing and are worth knowing about

- **The store order is `ISPADR`, `ISPDAT`, `ISPCMD`, `ISPTRG`.** Every one of the 19 donor
  sequences writes `ISPCMD` **first**, then `ISPADR`, then `ISPDAT`; OpenOCD writes
  `ISPCMD`, `ISPDAT`, `ISPADR`. So ours matches no witnessed order on either build or in
  any driver. No source states an ordering requirement other than `ISPTRG` last, so this
  is *unverified* rather than wrong, and aligning with the vendor is a free reorder of
  three `str`s.
- **`fmc_op` writes `ISPDAT` even for a page erase**, with zero. The vendor never does.
  `ISPDAT` is unprotected and ignored for `0x22`, so it is harmless; recorded so nobody
  reads it as evidence that an erase takes a data word.

### One thing that looks like a defect and is not

`ISPFF` is cleared at the *start* of each command, because `ISPCON_APROM` includes bit 6
and `fmc_unlock` is called once per sub-command. So within one `UPD_BEGIN` the sixteen
erases share one `ISPFF`, and a failure on erase 3 would still read as set on erase 4. That
is conservative in the right direction and it never leaks across commands, because
`erase_span` aborts on the first failure and the next command's unlock clears the flag.

## 5. Does `CBS` gate application-driven ISP? No, and the register map closes it

Asked by the coordinator on 2026-08-20 against `research/config0-cbs-2026-08-20.md`, which
records that unit 1, the Track C target, now reads `CONFIG0 = 0xffffffff`, `CBS = 11`,
"APROM without IAP mode", where the donor and unit 1's own pre-repair dump both read
`0xffffffbf`, `CBS = 10`, "APROM with IAP mode". IAP is in-application programming, which
is exactly and only what the resident updater does.

**Answer: `CBS` is not an input to the ISP gate. The gate is `ISPEN` plus the four `*UEN`
bits, and `CBS` is a reset-latched property of the address map.** *derived*, on four
independent legs, and the residual is one cell of a table rather than the whole question.
No device was touched to establish any of it.

**Leg 1, and it is absence from a list that demonstrably covers the category.** The
PAN1020 User Manual's own `CONFIG0` table documents exactly three fields: `CBS[7:6]`,
`LOCK[1]`, `DFEN[0]` (`research/numicro-fmc-upstream.md` section 9). Of those three, `LOCK`
appears in the FMC's fail-flag enumeration by name, *"Page Erase command at LOCK mode with
ICE connection"*, and `DFEN` reaches it through *"destination address is illegal, such as
over an available range"*, since `DFEN` is what changes the available range. **`CBS` appears
nowhere in a nine-condition list that enumerates both a `CONFIG0`-dependent refusal and a
mode-dependent one.** And the model is closed: *"ISP operation is not started and the ISP
fail flag will be set instead"*, so there is no documented route by which `CBS` could refuse
an operation without appearing in that list.

**Leg 2, mechanism, and it is why the updater's design already answers the question.**
Every documented consequence of `CBS` is the address map, latched at reset: which ROM is at
`0x0`, whether the LDROM is mapped at `0x100000`, whether `BS` controls boot switching, and
whether `VECMAP` remaps `0x0`-`0x1ff`. The manual's own gloss is *"When CBS[0] = 0, the
LDROM base address is mapping to 0x100000 and APROM base address is mapping to 0x0. User
could access both APROM and LDROM without boot switching."* **"IAP mode" on this family is
the arrangement in which APROM code can call the ISP routines that live in the LDROM**, and
`CBS[0] = 1` unmaps the LDROM and takes that route away. The updater calls nothing: it
drives `ISPADR`, `ISPDAT`, `ISPCMD` and `ISPTRG` itself, from APROM, which is exactly the
choice `notes/patch-over-bt.md` already made for unrelated reasons. And `GUARD` bounds every
address it hands the FMC to `[0x29400, 0x2d400)`, in the main array at `0x0`, which is
mapped under all four `CBS` encodings. **The one region whose mapping `CBS` changes is the
LDROM aperture, and the updater structurally cannot address it.**

**Leg 3: `CBS` is not read live out of the config page during an ISP operation.** *verified*
from the donor's bytes. The vendor's own OTA handoff at `0x1cdb0`-`0x1cdf8` (the routine
`ota.PROTECTED_REGIONS` calls "OTA handoff and reset", at `abs 0x1ca4c` on the APK build)
unlocks `REGLCTL` with the retry, sets `ISPEN`, reads the four config words into a stack
buffer through the `0x300000` aperture, replaces `CONFIG0` with `0xffffff3f` by
`movs r0,#0xc0; mvns r0,r0`, calls the config writer at `0x17b88`, which **erases the config
page and then programs four words into it**, and finishes with `AIRCR = 0x05fa0004`,
`SYSRESETREQ`, and a spin. Between that erase and those programs the config page reads
`CONFIG0 = 0xffffffff`, which is `CBS = 11`. **If the engine consulted the page, the
vendor's own commit path would fail on its own second word.** So `CBS` can only be a
reset-time latch, which is also how the FMC exposes it: `ISPSTS[2:1]` is a **read-only**
`CBS`, and nothing in either application image reads `ISPSTS` at all.

**Leg 4: three of the four latch-and-requester combinations are already witnessed on this
silicon, and only one is not.**

| Latched `CBS` | Who drove `ISPTRG` | Witnessed? | Evidence |
| --- | --- | --- | --- |
| `00`, LDROM with IAP | LDROM code | **yes** | the bootloader erased and programmed 130 pages of APROM on unit 1 with `CONFIG0 = 0xffffff3f` in force, then erased the config page and programmed `0xffffffbf` (`research/ldrom-2026-08-19.md`, `research/fmc-erase-program.md` witness 1) |
| `10`, APROM with IAP | APROM code | **yes** | the application stages 130 OTA pages at `0x29400` (witness 2), and its handoff path erases and programs the config page (leg 3) |
| `11`, APROM without IAP | the debugger, over the AHB-AP | **yes** | 2026-08-20: unit 1's config page was already erased, `dump-unit1-2026-08-20-partial.bin` reads `CONFIG0 = 0xffffffff`, and 150 pages of `0x16800`-`0x293ff` were erased and programmed, 19,200 words each read back twice. Unit 1 has since been through `reset run` and a power cycle and is **running the donor application, booted at `CBS = 11`** |
| `11` | **APROM code** | **no** | the only gap, and it is Track C's |

So `CBS` has never gated an ISP operation in any encoding anyone has tested, and the engine,
`APUEN`, both write opcodes and the main-array address decode are all *verified* at latched
`CBS = 11`. **The residual is the requester, not the configuration**, and nothing in the
register map makes the requester visible to the FMC: a trigger is an APB write to
`0x5000c010` whether the core stored it or the AHB-AP did. The one documented input that
does distinguish them, *"with ICE connection"*, appears in exactly one condition and makes
the **debugger** the restricted party, so the 2026-08-20 run succeeded in the stricter of
the two cases.

### The failure mode the question was asked about cannot happen

The worry was: the updater is flashed, `HELLO` answers, `UPD_BEGIN` reports success, and
every erase silently sets `ISPFF` and writes nothing. **That is not reachable in the code as
written.** `erase_page` reads the whole 512-byte page back and requires every word to be
`0xffffffff`; `program_word` compares every word it writes; and `upd_begin` returns
`UPD.FMC_REFUSED` the moment `erase_span` fails. A `CBS`-gated refusal, whether or not it set
`ISPFF`, comes back as `FMC_REFUSED` on the very first frame. **The updater cannot report
success on a write that did not happen**, which is the whole reason
`research/numicro-fmc-upstream.md`'s "software read-back is the only detection mechanism
that exists" is built into both call sites. The bench cost of being wrong is one reply code,
not an afternoon.

### The cheapest confirmation is not a third unit's `CONFIG0`

`research/config0-cbs-2026-08-20.md` ranks "read `CONFIG0` on unit 3" first. That answers a
different question, whether `0xffffffbf` is the shipped value, and it needs the probe moved.
**The question above is answered by one DATS type 1 save to unit 1**, because unit 1 is now
running the stock donor application at latched `CBS = 11`, and a persisting type 1 save *is*
the vendor's own code performing in-application programming at a main-array address. If the
content survives a power cycle, the missing cell of the table is filled by the vendor's
firmware rather than by ours, with no probe, no config write and no flash of anything of
ours. It costs one erase of flash wear, which `core/src/budget.ts` already counts.

Two things make it worth doing rather than assuming. **It has never been done:**
`.joggles/ledger.json` holds records for `GLASSES-125B37` only, so no save has ever been
recorded to unit 1 by the CLI. And the write it exercises is the same primitive: the donor
application reaches the page-erase helper at `0x17a1c` from four call sites and the
program-word helper at `0x17b6c` from two, of which two erase sites are the OTA staging
writer and the remaining pair are the saved-content writers (*derived*, from `fwtool
regions`).

**No config write should be considered.** `research/config0-cbs-2026-08-20.md` is right that
restoring `0xffffffbf` means driving bit 6 to zero, which is a program under `CFGUEN` and the
first operation in this project capable of locking a part permanently. Nothing above needs
it.

## 6. What is still *derived*, and what would settle it

- **Everything about our own firmware.** Not one instruction of `updater.ts` has executed
  on silicon. `research/tools/thumbsim.ts` is an interpreter and a model of this FMC, and a
  pass there is worth much more than "it assembles" and much less than "it ran". The whole
  of section 4 is a claim about bytes, checked against a register map, and nothing more.
- **`BS`, `SPUEN` and `LDUEN`'s bit positions**, from the CMSIS header's transcription of
  an unpublished manual. `LDUEN` has the bootloader as a second source. `SPUEN` has nothing
  at all. None of the three matters to us, for the reason in section 3, and no experiment is
  worth running to close them.
- **Whether the ISP register write order matters.** No source addresses it. It would be
  settled by one erase with the stores in our order, which is a bench operation nobody
  should spend a session on; matching the vendor is cheaper than measuring.
- **What `ISPCMD 0x04` with `ISPADR = 0x400068` returns**, and what the donor build does
  when bits `[19:16]` are not `0xb`. Read-only, one `mdw` through the FMC on a unit already
  under the probe, and it would say whether the firmware a real unit runs is gated on a part
  revision. Not needed for anything in flight.
- **Whether a 16-page erase burst survives a live BLE connection.** Unchanged by this work.
  The vendor's own OTA does the same thing, which is the evidence, and it is *derived*.

## Reproducing this

Offline, no device. The dumps and the APK container are gitignored; copies are outside the
repo.

    bun research/tools/fmcres.ts firmware/dump-12E69E-2026-08-19-a.bin
    bun research/ota-codec.ts decode firmware/TR1906R04-10_OTA.bin /tmp/fw10.bin
    bun research/tools/fmcres.ts /tmp/fw10.bin
    bun test research/tools/fmcres.test.ts

The tests that always run assemble a vendor-shaped primitive, sometimes at a base that is
not the FMC's and sometimes with all five offsets permuted, and require the resolver to
return what was assembled. That is the only way to tell resolving from asserting. The rest
need `firmware/` and are skipped without it.

For the disassembly in section 2:

    bun -e 'const a=new Uint8Array(await Bun.file("firmware/dump-12E69E-2026-08-19-a.bin")\
      .arrayBuffer()); await Bun.write("/tmp/donor.bin", a.slice(0x16800,0x29400))'
    bun research/tools/mkelf.ts /tmp/donor.bin /tmp/donor.elf 0x16800
    OD=$(xcrun --find llvm-objdump)
    $OD -d --triple=thumbv6m-none-eabi --start-address=0x17a00 --stop-address=0x17bd0 \
       /tmp/donor.elf                                  # the nine primitives
    $OD -d --triple=thumbv6m-none-eabi --start-address=0x17ffc --stop-address=0x18048 \
       /tmp/donor.elf                                  # the donor-only ID check
    $OD -d --triple=thumbv6m-none-eabi --start-address=0x1ee40 --stop-address=0x1eea0 \
       /tmp/donor.elf                                  # the staging erase wrapper

`fwtool.ts` gives the same literal and caller counts: `FW=/tmp/donor.bin bun
research/tools/fwtool.ts xref 0x5000c000` and `... callers 0x17a1c 0x17a1e`.

## Sources

- `research/fmc-erase-program.md`, which outranks this file on anything about behaviour:
  it is the on-silicon evidence for the 512-byte granularity, the `ISPFF` semantics, the
  watchdog and the misaligned-erase trap. This file is the register map on the donor build,
  which that one establishes on the APK build and in the LDROM.
- `research/numicro-fmc-upstream.md` for the paper behind the map: the `REGLCTL` protected
  list, the unlock-sequence adjacency rule, the closed opcode set, and the fact that
  `ISPCMD` and `ISPADR` are outside the lock while `ISPCON` and `ISPTRG` are inside it,
  which is what finding 2 turns on.
- `research/aprom-write-2026-08-20.md` for the silicon leg: the 150 pages, the 19,200
  words and the double read-back that make the five offsets and `APUEN` *verified* on this
  part rather than on a header.
- `research/donor-dispatcher-2026-08-20.md` for why an address ported from the APK build is
  never trusted here, and `research/variant-mismatch-2026-08-19.md` for what the two builds
  are.
- `research/swdflash-review-2026-08-20.md` for the guard asymmetry the updater's `GUARD`
  inherits: `APUEN` enables the whole of APROM and no hardware bit distinguishes the
  application region from the BLE stack below it.
