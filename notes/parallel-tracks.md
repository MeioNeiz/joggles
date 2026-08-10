# Running several agents on this repo at once

**The one rule: one owner per file.** Two agents editing the same file is the only failure
mode that loses work rather than merely wasting it. Everything below exists to make that
rule enforceable without anyone coordinating in real time.

Written after two agents ran concurrently on 2026-08-09 and it worked, but only because
their file sets happened not to overlap. Twice a file changed underneath a read and
produced a wrong conclusion: a `grep` caught `glasses.ts` mid-rewrite and reported a
choke-point violation that did not exist, and a test run caught a half-written test file
and reported a failure that vanished on re-run. **Re-read before you conclude.**

## How this file stays usable

Three parts, changing at three different rates, and the split is what stops the file
silting up with finished work.

| Part | Changes | Is the source of truth for |
| --- | --- | --- |
| **The board** | when a track is added or closes | what a track is, and what finishes it |
| `.claude/locks/` | constantly, by every agent | where every track has got to |
| everything else | only when something goes wrong | the protocol |

- **The board says what, the locks say where.** There is no status column, deliberately: a
  row that repeats `claimed` is wrong the moment another agent writes the lock file, and
  stale context misleads worse than absent context.
- **A row leaves the board when its review closes**, not when the track goes `done`. The
  reviewer checks against the done-when, so the contract has to outlive the work. Once
  `review-N` reads `passed` or `fixed`, the row becomes one line under Landed.
- **Numbers are permanent and never reused.** `track-N` and `review-N` are named after the
  number, so recycling one silently attaches an old review to new work. A new track takes
  the next unused number, whatever gaps the closed ones left.

## The two scarce resources

Pure TypeScript work parallelises without limit: `bun test` needs nothing physical. Two
things do not parallelise at all, and both are physical.

| Resource | Why it is a singleton | Lock |
| --- | --- | --- |
| **The glasses** (unit 2) | one BLE connection per device, and it is the only working pair. Its flash budget is global and counted | `.claude/locks/glasses` |
| **The Pixel** | one screen, one Metro, one adb. Two agents installing or screenshotting see each other's app | `.claude/locks/phone` |

**Lock protocol.** Before using either, check the file exists; if it does, someone else
holds it, so do the device-free part of your work instead. To take it, write your track
name into it. Delete it when you stop. It is advisory and that is fine: the point is that
an agent about to flash a screenshot loop notices someone else is mid-upload.

    test -f .claude/locks/glasses || echo "track-5" > .claude/locks/glasses

**Only the lock holder may call `session.save()`.** Every `DATCP` is five page erases on
the one working pair, the budget guard is per device and persists, and two agents saving
in parallel is exactly the runaway the guard exists to stop.

## The board

Each track owns its files outright. If you need a change in someone else's file, write
down what you need and say so in your final report rather than reaching across.

**Ownership is per file, not per directory.** A directory in the Owns column means the
files in it today. A **new** file you create there is yours even if the directory is
listed against another track, because a file that did not exist cannot lose anyone's work.
Name it in your lock line so the next agent knows it is taken.

**Needs** is the eligibility test, and it covers both devices and other tracks.

| # | Track | Owns | Needs | Done when |
| --- | --- | --- | --- | --- |
| **10** | **Nicknames** | new `packages/app/src/nicknames.ts` | phone, **track 1 closed** (it owns the scan list) | a per-device nickname keyed on `SessionOptions.device`, in a **separate file from the ledger** because losing a wear count matters and losing a nickname does not. Scan list shows the nickname with the advert name small underneath. Rationale: `notes/what-to-build.md`, "Name your glasses, on the host" |
| **11** | **Hardware verification, round 2** | new probe scripts in `packages/cli/src/`, `research/vendor-app-protocol.md` | **glasses**, and **track 5 closed** | verify items 1, 2, 3, 5, 6 and 7 of `notes/app-plan.md` "Verify before building", each written up with a confidence marker. Needs track 5 closed rather than just the glasses free, because both tracks write up their answers in the same research file |
| **12** | **Compose and Connected intuitiveness** | `packages/app/App.tsx`, `src/screens/Connected.tsx`, `src/Preview.tsx`, `src/deliver.ts`, `src/ledger.ts`, `src/speed.ts`, and `core/src/protocol.ts` for the speed table move only | **review-1 closed** | the free path and the flash path are visibly different actions ("Show now" vs "Save to glasses"), the save states its cost and the unit's lifetime count; saving grey content explains the type 1 flatten and offers a choice instead of `deliver.problems()`'s bare refusal; cancel mid-upload exists and says it costs nothing; a transition that discards the DIY buffer warns once; the `SPEED` ladder moves to `core/src/protocol.ts` beside `protocol.speed()` (flagged in `notes/app-plan.md`); a save log of the last 50 (time, columns, hash) per app-plan "Visibility"; a presets row on Compose (name/pronoun badge, `notes/what-to-build.md`); no control on an ignored opcode; suite green, app `tsc` clean, `expo export` bundles |
| **13** | **Wide loops in the app** | new `packages/app/src/screens/Effects.tsx`, new `packages/app/src/effects-ui/` | **track 12 closed** (it owns `App.tsx`, which this screen wires into) | browse the core `effects` generators, choose width within the ceilings `effects.ts` exports, preview through the same 24-column viewport masking Compose uses, deliver as a type 1 save through the existing `deliver()`/budget path with the cost stated before the save; pure parts tested, suite green, `tsc` clean, `expo export` bundles |
| **14** | **Proximity greeting** | `src/screens/Scan.tsx` once free, new `packages/app/src/proximity.ts` | phone, **review-10 closed** (track 10 edits the scan list) | Scan shows a live count of nearby `GLASSES-` adverts without connecting (advert-only, `notes/what-to-build.md` "Proximity greeting"), tested against a mock scanner, no connection attempted and no flash written |
| **15** | **More effects: mirror and fire** | `core/src/effects.ts`, `core/src/effects.test.ts`, `packages/cli/src/effects-preview.ts` | none | a `mirror` wrapper that kaleidoscopes any field across the nose bridge (`notes/what-to-build.md`, "Trippy visuals"), and a fire/flame-silhouette generator rising from the bottom rows; both pass `fieldGap()` closure, respect the 736 ceiling and dither-tile snapping, are previewable via `bun run effects <name>`, tests added, suite green |
| **16** | **Loop gap: preview vs device** | new probe scripts in `packages/cli/src/`, findings in `research/` | phone + glasses | the device shows a gap between scroll-loop repeats that the preview does not; root cause named with evidence and a confidence marker, preview and device agree or the mismatch is documented where the preview lives, any encoder fix tested, suite green |
| **17** | **Saved library: drawings and text presets** | new `packages/app/src/library.ts`, `library-store.ts`, `library.test.ts`; `packages/app/src/draw/` only once **review-4 closes** | none to build the store; **review-4 closed** before the Draw screen edits | a persisted store on the phone, separate file from the ledger (losing a preset must never risk the wear count); the device cannot hold "later" content: one DATS slot, and type 2 dies at power-off, so the phone is the library. A drawing item is the 9x24 level bitmap off `Canvas.levels()`, a text item is the string plus its `content.Motion`; corrupt or half-written JSON degrades to an empty library in memory, per `ledger.ts`; the Draw screen saves the canvas to the library and loads an item back into the canvas and live buffer, no flash and no `MODE`; the library is what track 12's presets row reads, so Compose recall is that track's wiring, not this one's; pure parts bun-tested, suite green, app `tsc` clean, `expo export` bundles |

**Track 11's three answers are inputs to almost everything else**, which is why hardware
verification keeps coming back to the top of the board: whether DATS bit 7 lights row 8
decides the row mapping every renderer targets, whether `MODE 02` scrolls content narrower
than 24 columns decides whether every upload pads to 24, and whether column 0 lands on one
lens decides whether the draw canvas is one 24-wide surface or two mirrored 12-wide ones.
*Corrected: this said track 5, which took only verify item 4 before closing.*

## Landed

One line each, kept so nobody rebuilds them. State and detail are in `.claude/locks/`.

| # | Track | What it produced |
| --- | --- | --- |
| **1** | App shell and BLE | `packages/app/App.tsx` (one connection, Scan/Connected/Draw switched on it), `src/ble.ts` (ble-plx behind core's `Transport`/`Scanner`, one manager for the whole app), `src/screens/`. Done-when all seen on hardware 2026-08-09, and the Draw wiring ran from the Pixel that night. Re-review fixed 3 defects, the one that matters being a live brightness row mid-save: `Glasses` has no `command()`/`save()` mutex, so a tap put `LIGHT` inside the DATS handshake (`screens/connected.test.ts`). Every wire-touching control now gates on `busy`. Dir 1 and all panel-side looks still need eyes |
| **2** | Renderer and content model | `core/src/content.ts` and `viewport.ts`: one `Bitmap` representation, both encoders, the 24-column window with `alive()` applied **at the window**, DATS type 2. `font.ts` untouched, which is why track 7 can own it |
| **3** | Coalescing live sender | `core/src/sender.ts`: desired-state diffing, no queue, `CLRL` clear. Review found 3 defects and fixed them. **Never run on hardware**, and its `CLRL` clear is still *derived* |
| **4** | Draw canvas | `packages/app/src/draw/`: `canvas.ts` arithmetic (holes refused at paint, Bresenham stroke joining, the vertical flip), `Pad`, `Draw`; plus `Glasses.live()` and the dead-pump `onError` review-3 asked for. Review passed, no defects: probes drove a 120Hz scribble on a slow link, clear mid-scribble, link death mid-stroke, all 216^2 `line()` pairs and fractional-pitch hit tests. If `CLRL` is a no-op, Resend all repairs via 24 column writes. **The 2026-08-09 hardware run proved the wire only**: row orientation, grey separation and `CLRL`'s panel effect are track 11's |
| **5** | Hardware verification | Verify item 4 settled on hardware: type 2 is **accepted to 383 columns, displays only the first 24, and writes no flash**; it shows itself on `DATCPOK` and any later `MODE` discards it for good. `content.MAX_IMAGE_COLUMNS` is 24 and `IMAGE_ACCEPT_CEILING` the 383. Repro `packages/cli/src/type2.ts`. **Items 1, 2, 3, 5, 6 and 7 were not touched and are track 11** |
| **6** | Firmware | `research/tools/`: `build-firmware.ts`, `ext.ts`, `thumb.ts`, `patch.ts`, plus `swd-recon.sh` (read-only OpenOCD, no write command in it) and `dumpcheck.ts` (validates a dump by diffing `abs 0x16800` against `ota.plaintext()`). Image built, **never flashed**; the hook and extension are hand-decoded only. Delivery still blocked on the SWD probe |
| **7** | Fonts and text rendering | `core/src/font.ts` as a facade over new `core/src/fonts/`, every old signature kept. `band5` scrolls: 5 rows at baseline 2, mixed case, ink-profile kerning that cannot collide by arithmetic. `tall7` is static only: 7 rows, `fonts/place.ts` steps glyphs around the notch and **reports drops in `StaticPlacement.dropped`, never clips**. U/V and 0/O made distinct. `bun run packages/cli/src/fontsheet.ts` prints both. Review passed with two test-side fixes; nothing font-side has run on hardware |
| **8** | Effects and wide loops | `core/src/effects.ts`: 5 generators (plasma, stripes, wave, ripple, starfield) as a field plus a render of it, ordered 8x8 dither, `levels: 2` or `4`. Ceiling **736**, not 740: widths snap down to the dither tile. `bun run effects <name>` previews any of them scrolling in the terminal with nothing attached. Review found 6 defects and fixed them; the one that matters is that **`seam()` cannot prove a loop closes**, so `fieldGap()` does it on the field before quantising |
| **9** | Rhythm channel | `core/src/rhythm.ts` + `packages/cli/src/rhythm.ts`: the one atomic full-panel write, on `960b`. Frame resolved as `[0d][style][12]`: the board's unknown byte was a handler offset read as a wire offset (`research/rhythm-channel.md`, cross-checked against the image by review-9). 4 styles, both bar tables, host-side 0-9 clamp because the firmware **blanks** overrange bars, pure `fromSpectrum` mapper plus `smooth`. Review fixed 3 defects (Infinity blanked instead of saturating, bad style crashed deep, CLI argv unvalidated). **All of it *derived*: no hardware session has run.** Graduate with `bun run rhythm send 0 --yes`, leaving DIY first |

## Picking your own track

So a prompt can be "do the next bit of work" without two agents choosing the same thing.
Claims use the same directory as the device locks, because a file either exists or does
not, where a shared status table has to be read and written and can be raced.

**`.claude/locks/track-N` exists means that track is taken.** First line is the state,
`claimed` or `done`, then a line of what is actually happening. **Claim with `set -C`**,
which makes the write fail instead of overwriting when someone got there first:

    (set -C; printf 'claimed\nscan screen and probe\n' > .claude/locks/track-1) || echo taken

A plain `>` truncates whatever was there, and `test -f` then `>` is two steps with a gap
between them. *verified* in zsh: the second writer gets `file exists` and the first
writer's line survives.

**Pick the lowest-numbered track on the board that is eligible.** Eligible means both:

1. No `.claude/locks/track-N` file exists.
2. Everything in its Needs column is satisfied: a named device has no lock file, and a
   named track has a **closed review**, meaning `review-N` reads `passed` or `fixed`.

If nothing is eligible, say so and stop rather than inventing work or reaching into
someone else's files. A device being held is a normal answer, not a failure.

**When you finish, write `done` as the first line** and leave the file. Deleting it makes
the track look unclaimed and someone will redo it. Release the device lock separately, by
deleting it, as soon as you stop using the hardware rather than when the track ends.

### Two agents claimed track 4 twenty seconds apart, 2026-08-09

Which is the collision this whole directory exists to avoid, arriving through the
claim protocol rather than around it. Both read the board, both ran `test -f`, both
saw nothing, and the second `>` silently replaced the first's line - so the shared
state named one owner while two agents built. Both then started on
`core/src/sender.ts`, which for a few minutes carried **two `onError` declarations**
and did not compile. `set -C` above is the fix; the rest is what to do when it
happens anyway.

- **The loser writes nothing to `track-N`.** This scheme has no slot for a yielded
  claim, and inventing one puts a second writer on the file all over again.
- **Split by what each has already built, not by who claimed first.** Track 4 ended
  as `core/src/sender.ts` to one agent and `packages/app/src/draw/` to the other,
  which is the file boundary the board already draws.
- **Say it out loud, agent to agent.** The locks are a claim protocol, not a channel:
  one line each and nobody re-reads them. This was settled by messaging the other
  sessions directly, and finding which one held the track took four tries.

## Adding a track

Because the board is meant to be refilled, not just drained. Add one when work is real
enough to have a done-when, not to park an idea: unbuilt ideas belong in
`notes/what-to-build.md`, which is where these tracks came from in the first place.

- **Take the next unused number.** Never reuse a closed one, never renumber a live one.
- **One owner per file, so carve by file and not by feature.** If two candidate tracks
  want the same file, they are one track, or one of them Needs the other closed.
- **The done-when is a contract a reviewer can check item by item**, so make it a list of
  observable things. "Better fonts" is not one; "kerned proportional font, `textWidth()`
  agrees with what renders, tested" is.
- **Say where the reasoning lives** rather than repeating it here. A row that has to
  explain itself is a row that wanted a section in `notes/` instead.

**Not tracks yet, and why**, so nobody re-derives the decision:

| Idea | Blocked on |
| --- | --- |
| Text-my-glasses (strangers type a message via a QR code) | a hosting and moderation decision from Jacob, not code. Highest delight per unit of effort once decided |
| Tapping UART1 TX at 115200 to learn the display module | a £3 USB-serial adapter nobody has bought. The only route to more brightness steps or greyscale levels |
| Several pairs from one host | only one working pair exists, so nothing can be verified. Unblocks when unit 1 is repaired over SWD |

## Shared files, and how not to collide on them

`CLAUDE.md`, `notes/app-plan.md`, `package.json` and `packages/core/src/index.ts` are
touched by everyone and owned by no one.

- **Re-read immediately before editing.** It will have changed since you last looked.
- **One small edit at the end of your track**, not a running commentary as you go.
- **Never rewrite a section you did not write.** Correct it in place with a note saying it
  was wrong, per `notes/WRITING.md`, or leave it and say so in your report.
- `core/src/index.ts` is append-only in practice: add your exports, touch no others.

## Standing rules, which every track inherits

These are in `CLAUDE.md` too, and they are repeated here because a fresh agent reads one
file and starts typing.

- **Never write to the `fd00` OTA service.** It bricked a unit on 2026-08-08. The app
  cannot reach it by construction, and `safe-surface.test.ts` fails the build if that
  changes.
- **`bun run test` must be green when you stop.** 283 tests as of 2026-08-09; the number
  only goes up, so treat it as a floor rather than an expected value. If you find it red on
  arrival, another agent is mid-write; re-run before believing it.
- **No save loops.** Never call `session.save()` from an effect, a timer, or a retry
  without a ceiling. See "Flash wear" in `notes/app-plan.md`.
- Findings go in `research/` with a confidence marker; judgement goes in `notes/`.
- Do not touch another track's files, unless you are reviewing that track and it is `done`
  ("Reviewing a track"). Do not run `git commit` unless asked.

## Reviewing a track

A track is not finished when it is `done`, it is finished when someone other than its
author has checked it. Reviews run in their own instance, one per track, because the agent
that wrote the code is the worst judge of whether its tests assert the right thing.

**`.claude/locks/review-N` is the review's own file**, and it exists so the reviewer never
writes `track-N`. Two instances sharing one status file is the collision the whole
directory exists to avoid, and it has already happened once: the track-3 review overwrote
track 3's own description line. First line is the state, then a line of the outcome.

    printf 'claimed\nreading sender.ts against its done-when\n' > .claude/locks/review-3

| State | Means |
| --- | --- |
| `claimed` | a review is in progress |
| `passed` | checked, nothing to change |
| `fixed` | defects found, fixed, suite green |

**Only review a track whose `track-N` reads `done`.** A `claimed` track is mid-write, and
this file's own opening records two wrong conclusions drawn from reading a file that
changed underneath. Worse if it holds a device lock: track 5 reviewed mid-flight would be
read while its answers were still arriving from the glasses. There is no ordering between
reviews otherwise: any `done` track with no `review-N` is fair game, lowest number first.

**A track that carries on after being reviewed needs reviewing again.** Track 1 was checked
while still `claimed` and landed another phase the same afternoon. Set `review-N` back to
`claimed` when you pick it up again: the outcome line is the current state, not a history.

**The reviewer owns the files of the track it is reviewing**, and this is the one exception
to one-owner-per-file. A `done` track has no live owner, so the reviewer may fix what it
finds rather than writing it up for nobody. What it may not touch: `track-N` itself, and
any file belonging to a track that is still `claimed`. Anything the reviewer cannot fix for
that reason goes in the outcome line and in its final report.

**Closing a review is what retires a row.** On `passed` or `fixed`, move the track's row
off the board into Landed as one line, keeping only what a future agent needs in order not
to rebuild it. The lock files stay where they are.

What a review is, beyond reading the diff:

- **The done-when, item by item.** It is in the board and it is the contract.
- **`bun test` green, and the count the track claimed.** Re-run it if it is red on arrival.
- **Whether the tests assert the property the file exists for**, not just the happy path.
  Track 3's coalescing is the example: it needed a transport that holds a write open, or
  "an update arrived mid-write" is not a state a test can be in.
- **Probe the edges the tests miss, in the scratchpad, before touching the code.** A probe
  written against the unfixed code and passing afterwards proves the fix; a test written
  after the fix only proves it matches itself. All three track-3 defects came out this way.
- **Anything *derived* that the code then trusts as if it were verified.** This repo's
  recurring failure. `CLRL` is the live one: it is the default clear path, and the sender
  marks all 24 columns known-blank on the strength of a disassembled handler nobody has
  sent to hardware, so if it is a no-op the panel stays lit and nothing repairs it. It is
  item 6 of the verify list and belongs to track 11.
- **Shared-file edits the track made**, which should be additive, per "Shared files" above.

## Kickoff prompts

One line, and it is the same line every time:

    Read notes/parallel-tracks.md, claim the next eligible track, and run it to its
    done-when.

To aim an agent at something specific instead, name it:

    Read notes/parallel-tracks.md, claim and run Track 5.

Reviews are always aimed, never picked up by the generic prompt, because "the next bit of
work" should build before it audits:

    Read notes/parallel-tracks.md, claim and review Track 3.

A cold agent needs nothing else. Everything it must not do is in "Standing rules" above.
