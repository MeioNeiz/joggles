# The gate that would have stopped 8 August

**Status:** built and running offline in `packages/core/src/ota.ts`. No hardware
touched. **Verdict: `ota.check()` now refuses `firmware/joggles-v1.bin`, and refuses
both vendor containers, when it is given a dump of the unit they would be written to.**
It refuses them for two independent reasons, and one of them is the fault that cost
`GLASSES-12C3EF`.

**Scope:** what the two new checks are, the rule they are stated over and why it is
stated that way, how the rule is recovered from the bytes of whatever dump is supplied,
what it says about the three images we hold, and what it cannot see. The fault itself
belongs to `research/hardfault-0xd38-2026-08-19.md` and the bootloader to
`research/ldrom-2026-08-19.md`; neither is repeated here.

Offsets are `abs` flash addresses.

## What was missing

`CLAUDE.md` called `ota.check()` "the gate, and it already encodes every limit here",
and on 2026-08-08 that was true and useless. Every limit it encoded was a limit on the
*image*: its size against the flash map, its CRC, its entry vector, its section type,
its distance from stock. A stock container over a stock unit satisfies all of them,
which is exactly the commit that bricked the unit.

The question nobody asked the image was whether it belonged on **that part**. Answering
it needs the part, so the new checks take a raw SWD dump:

    ota.check(file, { reference: dump })

With no `reference` the verdict is unchanged and a `no-reference-dump` **warn** says the
question was not asked. That is deliberate: `bun run build-firmware`, `patch.ts` and
`swdflash.ts` all gate on `check()` and none of them has a dump to hand, and a gate that
turns every existing caller red is a gate that gets bypassed. The findings that come
*from* a dump are all fatal and there is no option to lift them.

## The two checks, and their findings

| Code | Severity | Fires when |
| --- | --- | --- |
| `unregistered-callback` | fatal | a callback slot the unit's stack dispatches through is one the image never writes |
| `export-out-of-range` | fatal | the image reads an export index past the end of the table this unit publishes |
| `device-holds-more` | fatal | the unit holds programmed bytes in the application region above the end of the image |
| `dangling-reference` | fatal | the image loads a literal pointing into the application region above its own end |
| `dangling-built` | warn | the same, for an address built by `movs`/`lsls` rather than stored. Trap 2, so it is reported for a human rather than acted on |
| `no-registration-api` | fatal | a dump was supplied and no export table was found in it |
| `reference-too-short` | fatal | the dump does not cover the stack plus the application region |
| `device-match` | warn | nothing above fired, said out loud so a pass is visible |
| `no-reference-dump` | warn | no dump was supplied, so none of the above ran |

## The rule, not the instance

The tempting check is "refuse any image that skips export indices 89 and 90". It would
have caught 8 August and nothing else, and it would go stale the moment a different
stack build renumbers its table. The rule implemented instead is:

> **Every function-pointer slot the running system branches through must be a slot the
> application writes.**

That is the fault stated as a class. It is decided from three shapes, all recovered from
the supplied dump at run time, with nothing about this stack hardcoded. All three are
*verified* against `firmware/dump-unit1-2026-08-19-a.bin`.

| Shape | Encoding | What it means |
| --- | --- | --- |
| leaf setter | `ldr rB,[pc,#imm]` / `str rS,[rB,#off]` / `bx lr`, literal in SRAM | the only thing that fills one slot. Six bytes |
| dispatch trampoline | `ldr rN,[pc,#imm]` / `ldr rM,[rN,#off]` / `bx rM`, literal in SRAM | how the stack calls out through a slot. No null check in front of any of them |
| export table | seeded on `setterAddress \| 1`, grown outwards while the words stay Thumb pointers into the stack | setters are reachable **only** through it, so using an export is how an application registers |

An application counts as registering a slot if it reads that setter's export entry, if
it branches to the setter directly, or if it stores to the slot itself. Three routes,
because refusing an image for taking the second or third one would be wrong.

**Deciding which exports an application reads needs a register-tracking pass**, and this
is the part that is easy to get wrong. The application never loads the table base as a
base: it loads four 64-byte-aligned addresses *inside* the table (`0x16640`, `0x16680`,
`0x166c0`, `0x16700`) and indexes off those with `ldr rX,[rB,#imm5]`, so the index only
ever exists in a register.

**And the registrar does not use a literal at all.** `abs 0x190a6` is
`movs r4,#0xb3` / `lsls r4,#9` = `0x16600`, which is trap 2 in the header of
`research/tools/fwtool.ts` verbatim, and it is where the first version of this check went
wrong: following pool loads only, it reported the fifteen registrations that registrar
makes as missing, 16 unregistered slots instead of 4. The pass now propagates constants
too, through `movs`, `lsls`, `adds` and `subs`, as well as pool loads and `mov` between
low registers, and drops a register on anything else.

Calibrated that way it reads **72 of 92** exports for the stock `TR1906R04-10`
application and leaves exactly the four slots `+0x5c`, `+0x60`, `+0x64` and `+0x68`
unregistered. Those four are what `research/hardfault-0xd38-2026-08-19.md` establishes
from the registrar instruction by instruction, and what a live SRAM capture of unit 1
shows the *original* firmware filling and this one not. That agreement is the only
calibration the pass has, and `ota.test.ts` asserts it so the trap cannot come back.

Trap 1 is honoured as well: literals are resolved from `ldr`-pool sites rather than
matched as raw words, so animation bank data cannot invent a reference.

## What it says about the three images we hold

Reference: `firmware/dump-unit1-2026-08-19-a.bin`, the bricked unit. Export table found
at `abs 0x16600`, 92 entries. 30 leaf setters and 41 trampolines in the stack region, of
which **23 slots are both dispatched through and have a setter**, so 23 slots are in
scope. Each run takes 10 to 25 ms.

| Image | Body | Exports read | Slots unregistered | Programmed bytes above its end |
| --- | --- | --- | --- | --- |
| `TR1906R04-10_OTA.bin` | 66,084 | 72 | **4 of 23** | 9,895, `abs 0x26c00` to `0x293ff` |
| `TR1906R04-1-10_OTA.bin` | 65,824 | 71 | **4 of 23** | 10,155, `abs 0x26920` to `0x293ff` |
| `firmware/joggles-v1.bin` | 66,172 | 72 | **4 of 23** | 9,895, `abs 0x26c00` to `0x293ff` |

The four, identically in all three images, are `0x20000070`, **`0x20000074`**,
`0x20000078` and `0x2000007c`, i.e. struct offsets `+0x5c` to `+0x68`. `0x20000074` is
the slot the recorded exception frame came through, and the check names it without having
been told about it: it is reached by the `bx` at `abs 0x10f54`, its setter is
`abs 0x13538`, and that setter is export 90, which no image in the APK ever reads.

**`joggles-v1.bin` is refused, which is the point.** It is stock plus an 88-byte `JGX1`
extension, so it inherits the defect byte for byte, and the check says so on both counts.
Nothing in it is wrong on its own terms: `dangling-reference` does not fire, because its
extension sits inside its own body at `abs 0x26a24`.

The `device-holds-more` finding is the second, independent reason, and it is the one that
does not depend on any disassembly at all: the bootloader copies `ceil(codeSize/512)`
pages, so 9,895 bytes of whatever the unit was running survive above the end of anything
we would write, unreferenced. That is the orphan region, seen from the other end.

## What it cannot see

- **A slot with no leaf setter is out of scope, deliberately.** The interrupt table at
  `0x20000080` is written through `str r1,[r2,r0]`, a register-offset store whose index
  cannot be resolved statically, and a struct filled through a pointer argument cannot be
  either. Including them would fail every image for want of evidence rather than for
  cause. Eighteen dispatched slots fall outside the check for this reason.
- **The tracker does not follow branches.** A base register loaded in one block and used
  in another is credited to the application, so the pass errs towards *believing* a slot
  is registered. That is a false-pass direction, which is why the `unregistered-callback`
  message also reports how many of the same slots the application the unit **already
  holds** leaves unregistered: on unit 1 that is 4, i.e. the unit is running an image
  that is itself mismatched, and on a healthy unit it should read 0.
- **It says nothing about whether a slot is on the boot path.** Four unregistered slots
  is four ways to fault, not one; which of them a given boot reaches first is a
  reachability question this does not answer, and on unit 1 only `+0x60` is known to be
  on it.
- **It is not wired into the CLI.** `bun run ota-check` and `bun run flash` take no
  reference argument yet, and `packages/cli` belongs to other tracks. Until that lands
  the check runs from code and from `ota.test.ts`.

## Unverified

| Claim | Why it is not settled |
| --- | --- |
| a slot with no writer always faults when dispatched | **no, and it does not need to.** Unit 1 has two boot paths and only the cold one reads `+0x60`; a live capture caught it in Thread mode with the slot holding a pointer left by the unit's *original* firmware. The check does not depend on the fault being deterministic: an image that leaves a slot the stack branches through to whatever SRAM holds is refusable whether or not it faults every time |
| the register-tracking pass is complete | *derived*. It agrees with a hand reading of the registrar at 72 of 92 exports and four unregistered slots, and has no other calibration. It handles pool loads, `movs`/`lsls`/`adds`/`subs` and `mov`, and nothing else: a base built any other way is a false pass. It has already been wrong once in exactly that way |
| 23 is the right number of in-scope slots | *verified* as what the scan finds on this dump, *derived* as the right scope. `research/hardfault-0xd38-2026-08-19.md` counted 24 trampolines into the same struct by hand |
| a healthy unit's dump will register all 23 | *unverified*, and it is the measurement that would confirm the whole approach. Unit 2 has not been dumped |

## Reproducing

Offline, no device. `firmware/` is gitignored, so this runs only where the images are.

    bun test packages/core/src/ota.test.ts

The real-image assertions live in the `against a real unit` block and are skipped when
the dump is absent. To see the wording rather than the assertions:

```ts
import * as ota from './packages/core/src/ota.js'
const reference = new Uint8Array(
  await Bun.file('firmware/dump-unit1-2026-08-19-a.bin').arrayBuffer(),
)
const file = new Uint8Array(await Bun.file('firmware/joggles-v1.bin').arrayBuffer())
console.log(ota.report(ota.check(file, { reference })))
```

`ota.matchDevice(reference, file)` returns the derived model itself: the export table,
every in-scope slot with its setter, its export index and its trampolines, the exports
the image reads, and the orphaned range.
