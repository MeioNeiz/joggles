# PROTECTED_REGIONS was a map of one build, and the gate asserted its arithmetic

**Confidence markers are `research/README.md`'s three**: *verified*, *derived*,
*unverified*. Every span, offset and count below is *verified* from the bytes of
`firmware/TR1906R04-10_OTA.bin`, `firmware/dump-12E69E-2026-08-19-a.bin` and `-b.bin`,
and `firmware/dump-unit1-2026-08-19-a.bin`. **Nothing here touched hardware.** No unit
was written to, no probe was used, and our own extension has never run on any silicon.

## Verdict

**On the image every pair here actually runs, five of the seven entries in
`PROTECTED_REGIONS` miss their code entirely and a sixth covers half of it.** The one
that lands right is the image head, and only because it is a position rather than a piece
of code. *verified* by resolving all seven by content on both builds.

**The worst of it is the flash driver.** That build grew a function inside it, so its tail
moved 0x110 and the static entry now ends `0x4a` bytes before the word programmer: it
protects the page-erase helper and the CRC helper and leaves **the word programmer and the
CONFIG0 writer outside it**. Two of the three sites that slid out are the two that can
change flash.

**Nothing we write lands in a protected region on either build**, so this was never a live
hazard. It was the gate's confidence that was wrong: `fwtool regions` asserted `Expected:
16`, which is the number of FMC/REGLCTL sites the APK's layout leaves outside the APK's
own region list. The donor's answer is 39. Neither number says anything about safety, and
a gate that asserts one build's arithmetic is a gate that fails on the build that matters
and then gets skipped. `research/swdflash-review-2026-08-20.md` records that happening
once already: `chooseBaseline` handed the APK returned seven spurious `protected-region`
fatals against an image nobody had edited there.

**Fixed by resolving the regions rather than looking them up.** `deriveRegions` in
`research/tools/fwtool.ts` finds all seven in whichever application image it is handed,
the way `ext.findHookSite` finds the hook. On the APK it reproduces the hand-traced spans
from the inside; on a real unit's window it reproduces nothing and resolves everything.

## What identifies each region, when the offset does not

One rule runs through all of it: **anchor on a value the code must load or a UUID the
radio must advertise, never on a byte pattern the compiler chose.** The two exceptions are
named as exceptions.

| Region | Anchor, *verified* on both builds |
| --- | --- |
| image head and startup stub | body 0, one flash page. Not found, it *is* the start; the page is the erase granularity, so it is the least of it that can be lost. Guarded by the head's first word being an address inside the application region, which is what refuses a whole 256 KB dump handed in where the window was meant |
| FMC flash driver | the one cluster of FMC-base loads that issues page erase (`ISPCMD 0x22`) and word program (`0x21`) |
| flash program primitive | the block holding a `bl` to the driver's program-only entry **and** reached from the OTA handler. Two blocks call that entry and the other is the DATS saved-content writer |
| OTA handoff and reset | the literal pool holding both section flags (`0xdbd2`, `0xdbc3`) beside the AIRCR reset key `0x05fa0004` |
| OTA handler | the literal pool holding the OTA pad seed `0x37627996` |
| OTA payload descrambler | 48 bytes of the routine itself. **The one weak signature**, and the only one that is compiler output |
| GATT table, including the fd00 OTA service | the first vendor 128-bit UUID row through the end of the `fd02` row that follows `fd01` one stride on |

### Why two mechanisms and not one

**The cluster.** The flash driver is a run of leaf functions. Every one of them is
`push {r4..}` / `bx lr` with no `lr` saved, so there is no `push {..., lr}` to find and
the epilogues are bare `bx lr` halfwords that also occur inside literal pools. Function
bounds are not readable here. What *is* readable is the run of FMC-base loads: they sit at
most **0x76 bytes apart inside the driver on both builds**, and the nearest unrelated load
is **0x326 away**, so a 0x100 gap separates them with room either side. *verified* by
measuring both.

**The pool block.** The handler and the handoff are each one function reading one literal
pool. A pool sits immediately after the code that reads it and every word in it is read
from above, so the run of consecutive read words containing the anchor is the pool, and
the earliest `ldr` into that run is where the function starts. Both ends come out of the
image. It can only under-reach, because an unread word breaks the run.

**Why the program primitive needs the handler resolved first.** Two blocks call the
driver's word programmer: the OTA path's page writer, and the DATS saved-content writer,
which costs a saved drawing rather than a way back. Nothing about their own bytes separates
them; what separates them is that the OTA handler calls one and not the other. Its start is
then the handler's own `bl` target, which is the function entry exactly, so no slack had to
be invented: the block's first FMC load is 0xe bytes further on, on both builds.

### The one anchor to distrust

`SIGNATURE.descrambler` is 48 bytes of one compiler's output. It is in there because
nothing else distinguishes that routine: it touches no FMC register, loads no OTA literal
and sits in no table. It matches exactly once on each of the two builds in hand, which is
evidence and not a guarantee. *unverified* that it survives a third build, and it is the
first thing that will fail.

Worth recording alongside it: the span `PROTECTED_REGIONS` names "OTA payload descrambler"
**does not contain the pad seed on either build**. The seed's two `ldr` sites are at APK
`0x82a0`/`0x833e` and donor `0x8650`/`0x86ea`, both inside the OTA handler, so the
descrambling proper is inline in the handler and the routine at `0x9188` is a separate
byte-shuffling loop. *verified* from the LDR sites. That is why the seed anchors the
handler and not the descrambler.

## The spans, on both builds

Body offsets throughout, which is what `PROTECTED_REGIONS` speaks in. Reproduce with
`FW=<window> bun research/tools/fwtool.ts regions`.

### The APK's `TR1906R04-10`, the container's plaintext, 66,084 bytes

Every resolved span sits **inside** its static entry, which is exactly what
`PROTECTED_REGIONS`' own docblock predicts: "Ranges are padded outwards because the exact
function ends were not all traced." That agreement is the evidence that the derivation is
right, and `fwtool.test.ts` asserts it region by region.

| Region | Static | Resolved | Padding before / after |
| --- | --- | --- | --- |
| image head and startup stub | `0x0-0x200` | `0x0-0x200` | same span |
| FMC flash driver | `0x1118-0x1322` | `0x1118-0x1318` | `0x0` / `0xa` |
| flash program primitive | `0x2840-0x28a8` | `0x284c-0x28a4` | `0xc` / `0x4` |
| OTA handoff and reset | `0x61c0-0x6290` | `0x61d2-0x628c` | `0x12` / `0x4` |
| OTA handler | `0x8100-0x8700` | `0x8226-0x8660` | `0x126` / `0xa0` |
| OTA payload descrambler | `0x9180-0x9200` | `0x9188-0x91b8` | `0x8` / `0x48` |
| GATT table, including the fd00 OTA service | `0xc1e8-0xc350` | `0xc1e8-0xc34c` | `0x0` / `0x4` |

41 FMC/REGLCTL sites, 25 inside a static region, **16 outside**. Three sites change flash:
`0x1128` (page erase), `0x125c` (word program), `0x1282` (page erase then three word
programs, the CONFIG0 writer). All three are inside the static driver span.

### The donor's `TR1906R04-12`, `GLASSES-12E69E`'s own window, both dumps agreeing

| Region | Static | Resolved | How the static entry reads |
| --- | --- | --- | --- |
| image head and startup stub | `0x0-0x200` | `0x0-0x200` | same span |
| FMC flash driver | `0x1118-0x1322` | `0x120c-0x1428` | **partial**: covers `0x116` of `0x21c` bytes, and misses `0x136c` and `0x1392`, which change flash |
| flash program primitive | `0x2840-0x28a8` | `0x2b14-0x2b6c` | misses it by `0x2d4` |
| OTA handoff and reset | `0x61c0-0x6290` | `0x6562-0x661c` | misses it by `0x3a2` |
| OTA handler | `0x8100-0x8700` | `0x85d6-0x89f4` | **partial**: covers `0x12a` of `0x41e` bytes |
| OTA payload descrambler | `0x9180-0x9200` | `0x957c-0x95ac` | misses it by `0x3fc` |
| GATT table, including the fd00 OTA service | `0xc1e8-0xc350` | `0xcc30-0xcd94` | misses it by `0xa48` |

48 sites, 9 inside a static region, **39 outside**. The three that change flash are
`0x121c`, `0x136c` and `0x1392`, and the static driver span holds only the first.

*verified* identical on `dump-12E69E-2026-08-19-b.bin`, which is a second read of the same
unit, and on `dump-unit1-2026-08-20-after.bin`, which is that donor image as it was written
onto unit 1.

## The three sites that slid, named

The APK's driver has eight FMC sites and the donor's has nine, and the extra one is the
reason the tail moved.

| Donor site | `ISPCMD` written | What it is | Inside the static span? |
| --- | --- | --- | --- |
| `0x120c` | none, an `ISPCON` read-modify-write | the unlock helper | yes |
| `0x121c` | `0x22` | page erase | yes |
| `0x124e` | `0x2d` then `0x0d` | run CRC32, read the result | yes |
| `0x12a0` | none | the unlock helper again | yes |
| `0x12b0` | `0x00` | read one word | yes |
| `0x12da` | `0x00` four times | read four words | yes |
| **`0x1350`** | **`0x04`** | **read unique ID. The function the APK's driver does not have** | **no** |
| **`0x136c`** | **`0x21`** | **word program. The primitive everything else calls** | **no** |
| **`0x1392`** | **`0x22`, then `0x21` three times** | **the CONFIG0 writer** | **no** |

Below the insertion the two builds' sites are `0xf4` apart, site for site. Above it they
are `0x110` apart, and the difference is the `0x1c` bytes of the UID reader at `0x1350`.
So `0x1322`, the hand-traced driver end, would have needed to be `0x1432` on this build.
*verified* by differencing the two site lists.

**Why this one mattered more than the other twenty-three.** The other regions being in the
wrong place makes `comparePatch` say nothing useful. This one makes it say something
false: it reports the flash driver as protected while the word programmer and the CONFIG0
writer are outside the fence, and the CONFIG0 writer is the block whose misuse
`research/config0-cbs-2026-08-20.md` is about.

### Where the other 23 went

Full accounting of the donor's 39 against the APK's 16, so the difference is not a
mystery number. *verified* by cluster.

| Block | APK sites outside | Donor sites outside | Difference |
| --- | --- | --- | --- |
| the lone REGLCTL pair at `0x93c` / `0xa30` | 1 | 1 | 0 |
| flash driver tail | 0 | 3 | +3 |
| the UID reader at `0x15a8` / `0x15ac` | 2 | 2 | 0 |
| a REGLCTL/FMC pair at donor `0x180e` with no APK counterpart | 0 | 2 | +2 |
| flash program primitive | 0 | 3 | +3 |
| the handoff's cluster | 4 of 6 | 8 of 8 | +4 |
| the OTA handler's cluster | 0 of 12 | 9 of 12 | +9 |
| three lone REGLCTL blocks around `0x9086` / `0x947a` | 4 | 4 | 0 |
| a REGLCTL/FMC pair at donor `0xa0e4` with no APK counterpart | 0 | 2 | +2 |
| the two DATS saved-content writers | 5 | 5 | 0 |
| **total** | **16** | **39** | **+23** |

## What the gate checks now

`fwtool regions` resolves the regions, prints every site with what it does through the FMC
register, prints what a build on this image would write, prints `PROTECTED_REGIONS` beside
the resolved spans, and then asks three questions. It exits non-zero on a failure.
`auditRegions` is the same thing as a function, which is what `fwtool.test.ts` drives.

| Check | What it asserts | Why it is true of any build |
| --- | --- | --- |
| `regions-resolved` | all seven resolved by content, with no fatal note | a region placed by guess is worse than a region reported missing |
| `one-flash-writer` | every `ISPCMD` that changes flash is issued from inside one block | every other caller in both images reaches flash by calling into it. Split that block and the map is no longer a map |
| `known-opcodes` | every `ISPCMD` immediate written anywhere is in the vendor's own set | anything else sets `ISPFF` and does nothing, so writing one is an operation neither we nor `PN102Series.h` can account for |
| `patch-clear` | nothing this repo's build writes overlaps a resolved region | the live hazard. The spans come from `ext.resolveLayout` and `ext.placeExtension`, so a future feature that writes somewhere new is picked up without editing the gate |
| `regions-disjoint` | no two resolved regions overlap | two anchors resolving to the same code means one of them is wrong |

**`PROTECTED_REGIONS` is printed and never fails the audit.** Two builds laying their code
out differently is not a defect, and making it one is how the old count check earned its
reputation.

**There is a third state, `n/a`, and unit 1's pre-repair dump is why.** That window carries
the tail of a longer build above a shorter one, so `ext.resolveLayout` refuses it outright
and there are no patch spans to hold against anything. Reporting that as a failure is the
same cry-wolf: it is not a hazard, it is an image no build can be based on, and the check
now says so in those words. The seven regions still resolve on it, off the live low copy.

### What the checks would catch, exercised on doctored images

Each of these is a test in `fwtool.test.ts` against a doctored copy of the donor window.
*verified* offline; nothing was flashed.

| Doctoring | What fires |
| --- | --- |
| a second block planted in the zero fill that writes `ISPCMD 0x22` | `regions-resolved` and `one-flash-writer`, with "2 separate blocks issue flash-modifying ISPCMD opcodes" |
| the page-erase immediate changed from `0x22` to `0x25` | `known-opcodes`, naming `0x25` |
| the `GLASSES-` advert prefix moved inside the resolved OTA handler | `patch-clear`, naming both the span and the region |
| the OTA pad seed zeroed | `regions-resolved`, and the OTA handler is absent rather than mislocated |
| the whole 256 KB dump handed in where the window was meant | `regions-resolved`, "not an application image" |

## The image Track C would flash passes

`firmware/joggles-v2.bin`, the donor-rebased build with the four-byte hook and the
resident updater in it, resolves all seven regions and the audit refuses nothing.
*verified* offline from the file; **it is still unflashed and has run on no silicon.**

`patch-clear` reads `n/a` on it, and that is the state working as intended rather than a
gap. The image is already patched: its hook site is spent, its AES key is ours and its
advert prefix is not `GLASSES-`, so `ext.resolveLayout` finds no site to build on and
there are no spans to hold against anything. "Nothing can be built on top of this" is a
different sentence from "this is unsafe", and the old count check could not tell them
apart. Pinned by `fwtool.test.ts`.

## What this does not do

- **It does not re-place `PROTECTED_REGIONS` itself.** That constant is in
  `packages/core/src/ota.js` and is still the APK's offsets. What `ota.check` does about
  that, as of track 64 the same day, is `comparePatch`'s `regions-off-base` **warn**: when
  both images are a build the regions were not traced on, the byte diff still runs and any
  protected-region finding in it is labelled as a label rather than a fact. That is the
  right shape and it is the complement of this work, not a substitute: the resolved spans
  live in `research/tools/fwtool.ts` and are not wired into `ota.check`, so a clean
  `comparePatch` off a donor baseline still means "no byte outside the patch changed", not
  "no protected code was touched". Wiring them in means moving the derivation into
  `packages/core`, which is a decision about that package's surface and not a bench-night
  change.
- **It does not claim the regions are the right set.** Whether patching each of these
  seven actually costs recoverability is *derived* and has never been tested, for the good
  reason that testing it means bricking a unit on purpose.
- **It does not know about the regions outside the application window.** The BLE stack, the
  bootloader, the info pages and the OTA staging bank are flash-map constants that do not
  move between builds; they are `ota.ts`'s and `swdflash.ts`'s `CANARIES`.
- **It has seen two builds.** Everything above is *verified* on `TR1906R04-10` and
  `TR1906R04-12`. That two builds agree on the shape of an anchor is the best evidence
  available offline and it is not proof about a third.

## Cross-references

- `research/swdflash-review-2026-08-20.md`: the seven spurious `protected-region` fatals
  that `chooseBaseline` used to return, which is the same defect at the other end. Picking
  the right baseline stops the false alarms; it does not move the region names onto the
  right code, and that half is what this document is about. The same misfire recurred on
  2026-08-20 as a fatal `protected-regions-off-base` that refused a correct donor-rebased
  image outright, and was corrected to the `regions-off-base` warn described above. Three
  sightings of one lesson: a region name read off the wrong build should reduce what a
  gate claims, never what it permits.
- `research/donor-dispatcher-2026-08-20.md`: where the finding was recorded as a number
  without an explanation ("on the donor it is 39, and three sites of the flash driver
  slid"). This is that explanation, and it corrects one thing about it: the flash driver's
  three are the visible part, but the whole `flash program primitive` entry and nine of the
  twelve `OTA handler` sites are outside their spans too, so 39 is not the driver alone.
- `research/fmc-erase-program.md` section 7.1: the `ISPCMD` set, and why `0x26` is not a
  command on this part. `fwtool.ts`'s table is that transcription, held to `swdflash.ts`'s
  three exported opcodes by a test.
- `research/variant-mismatch-2026-08-19.md`: why the APK's build is not the fleet's, which
  is the reason any of this matters.
- `notes/patch-over-bt.md`: what the resident half and the two slots are, and where they
  sit relative to these regions. All three are above the application window.

## Unverified

- **The descrambler's 48-byte signature on a third build.** It is compiler output. Two
  builds is not a pattern.
- **That `CLUSTER_GAP = 0x100` is right for a build we have not seen.** Measured at 0x76
  inside the driver and 0x326 to the nearest neighbour on both builds in hand. A build that
  interleaved unrelated FMC code into the driver would merge blocks and the audit would say
  nothing about it.
- **That patching any of the seven costs recoverability.** *derived* from what the code
  does, never witnessed. Nothing in this repo has ever tested it and nothing should.
- **The `0x1350` UID reader's purpose.** `ISPCMD 0x04` with the address in `r0` is the
  unique-ID read per the vendor header, *verified* from the bytes and the header. Who calls
  it and why is not traced.
