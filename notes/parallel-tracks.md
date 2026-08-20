# Running several agents on this repo at once

**The one rule: one owner per file.** Two agents editing the same file is the only failure
mode that loses work rather than merely wasting it. Everything below exists to make that
rule enforceable without anyone coordinating in real time.

Written after two agents ran concurrently on 2026-08-09 and it worked, but only because
their file sets happened not to overlap. Twice a file changed underneath a read and
produced a wrong conclusion: a `grep` caught `glasses.ts` mid-rewrite and reported a
choke-point violation that did not exist, and a test run caught a half-written test file
and reported a failure that vanished on re-run. **Re-read before you conclude.**

## Single-instance mode, 2026-08-11: read this before claiming anything

Jacob handed one session, the Fable redesign, exclusive control of the phone, the
glasses and the whole of `packages/app`, after a second handset session that evening
found the app wanting end to end (verbatim intake: `notes/what-to-build.md`, "Handset
feedback, 2026-08-11, second session"). Until Jacob lifts this:

- ~~**Both device locks are held by `fable-redesign`**~~ **Lifted 2026-08-12**, Jacob:
  "nothing has control of the phone or glasses right now". Both lock files were deleted
  rather than left to read as held by an idle session, which is worse than absent.
  Normal lock protocol applies again: take one, write your track name in it, delete it
  when you stop. What has **not** been lifted is the file half, below.
- ~~**Track 26 is the redesign** and owns every file under `packages/app`.~~ **Released
  2026-08-12**, Jacob: "I have released it, you do what you think is best". So
  `packages/app` is carved by file again, per the normal rule, and the rows that were
  waiting on track 26 closing are eligible. **Track 26's row stays on the board**: its
  done-when is still his verdict on the handset, and that verdict has not been given.
  Tracks 22, 23, 24 and 25 are folded into it. *Their rows came off the board on
  2026-08-12, once each had been checked item by item against what shipped: what
  landed, and the one item deliberately dropped, is a line each under Landed.*
- **review-13 was interrupted mid-review** by this takeover, and never closed. Its
  findings are in `.claude/locks/review-13`; the one that mattered became track 27, and
  its subject (`screens/Effects.tsx`) no longer exists, so *the row retired unreviewed
  on 2026-08-12 and the Landed line says so.* Nothing else in this repo closes that way.
- **Track 11's sitting plan stands** and runs inside the redesign's first hardware
  sitting, with Jacob watching the panel. The plan and the parked state are in
  `.claude/locks/track-11`, unchanged.
- Pure-core tracks that touch nothing in `packages/app` and no device may still be
  worked under the normal rules, but check with Jacob first: the point of this mode is
  one pair of hands on everything the redesign touches.

**Where that has got to, 2026-08-12.** The redesign was built, hot-loaded onto the Pixel
and driven by Jacob with the pair connected, which produced a second intake batch
(`notes/what-to-build.md`, "second batch: first contact with the redesign") whose fixes
landed inside track 26 the same day. Two consequences for anyone reading the board cold:

- **The app has now been seen**, which was the standing caveat on everything above. What
  has still never been seen is **the panel**: no effect, no scroll of ours, no `LIGHT`
  step and no `CLRL` has been watched by a human, so every panel-side claim in this repo
  is exactly where it was on 2026-08-09. That is the sitting, and it is track 11's row.
- **Jacob's ruling on confirmations overturned a law of this repo**, and it retires
  done-when items rather than merely restyling screens: the UI neither prices nor
  confirms a save, so any row that says "with the cost stated before the save" is
  answered by deleting the sentence, not by writing one. The guard stays in `budget.ts`.

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
| **The glasses** | one BLE connection per device. **Three working pairs as of 2026-08-20**, unit 1 having been repaired, but each pair's flash budget is global and counted, and the lock is still one-at-a-time because the ledger is keyed per advert name | `.claude/locks/glasses` |
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
| **26** | **The app redesign, single-instance** | everything under `packages/app`, plus `notes/app-plan.md` "The redesign" section | **nothing: Jacob cleared the way, 2026-08-11**, and it holds both device locks | *Restated 2026-08-12, after first contact.* The build is done and **both** intake tables are answered item by item, the 08-11 "second session" one and the 08-12 "second batch" one, including the ruling that deleted the send sheet and every cost tag. Suite 731 green, `tsc` clean, `expo export` bundles. What is left is the half a board cannot check: **the sitting**, Jacob on the handset with the pair connected, which is also where tracks 11 and 16 get their eyes. **Was it fixed is Jacob's call, not a reviewer's**, and until that call `packages/app` stays owned here. Two things to clear before `review-26` reads the code: the `one-tap.ts` head and `Tap.grey` still describe the deleted cost sheet, and `Library.tsx`'s docblock still says "Mine rows swipe" after tiles superseded them, which is the stale-fact failure `notes/WRITING.md` names |
| **11** | **Hardware verification, round 2, and the redesign's sitting** | `packages/cli/src/verify.ts`, `research/vendor-app-protocol.md` | **glasses** (held by `fable-redesign`, so this runs inside its sitting) and **a human watching the panel** | verify items 1, 2, 3, 5, 6 and 7 of `notes/app-plan.md` "Verify before building", each written up with a confidence marker, run in the order in `.claude/locks/track-11`: **step 1 comes before anything that saves**, or track 16's question is destroyed by the save that answers item 1. **Four observations added 2026-08-12**, all from first contact and all in `notes/what-to-build.md`, second batch: time one full pass of a known-width save against the preview, because *"the preview is way slower than the actual speed of the device"* contradicts `protocol.speedDivisor`, which is *derived* from the disassembly and has never been timed; sweep `LIGHT 1` to `5` on a lit panel in live, saved and built-in modes, because *"im pretty sure the panel option doesnt do anything"* and nobody has ever watched for it; settle which `ANIM` base is real, since track 20's contradiction decides whether 19 built-in tiles play something other than their picture; and take track 16's two looks while the panel is up |
| **16** | **Loop gap: preview vs device** | `packages/cli/src/loopgap.ts`, `core/src/content.ts`, `viewport.ts`, `dats.ts` (+tests), `app/src/Preview.tsx` (marquee walk only), `research/loop-gap-2026-08-10.md` | **two looks at the panel by eye**: one power cycle, then one re-save in a session. No BLE for the first, no flash for either | *Restated 2026-08-12: the code half landed and only the looking is left*, so what closes this is the two looks at the top of `research/loop-gap-2026-08-10.md` plus the write-up. **Its files are finished and reviewable now**, which matters to somebody else: track 27 waits on `content.ts`, so run `review-16` against the landed half rather than holding it hostage to a panel nobody has looked at. ***`review-16` closed `fixed` 2026-08-12 against the code half only**, so `content.ts` is free for 27 and 35; **the row stays until the two looks happen**, and the file they are written against was corrected by that review: the store no longer holds the 27-column word, and the clean subject is the 240-column loop of 23:46 whose own blank run is 0* |
| **31** | **The generators are worth looking at** | `core/src/effects.ts`, `packages/app/src/effects-ui/catalogue.ts` | **the sitting** (track 11), because this is a judgement about what the panel shows and nobody has ever seen one | *"The effects page too is just weird ... teh effects there are also bad"* and *"a lot of the current animations just seem buggy and not great"*, both verbatim in `notes/what-to-build.md`. Track 26 trimmed the page; this is the generators themselves. **It cannot start before eyes**, and that is the point of the row: what a generator looks like flattened to 2 levels on 9 rows with the dead pixels in it is not derivable from the field, and every default in `catalogue.ts` was chosen against a terminal preview. Done when each generator's default knob bag has been chosen against the panel, anything that reads as noise at 2 levels either gains a legible default or leaves `EFFECT_NAMES` with the reason recorded, and `bun run effects <name>` still previews what the panel gets. The registry rules (closure, the 736 ceiling, the level rules) are `effects.ts`'s and stay |
| **36** | **The preview stops re-implementing the loop model** | `packages/app/src/Preview.tsx` | nothing: `packages/app` was released 2026-08-12, and `review-16` closed the model it consumes | Found by `review-16`, 2026-08-12. Track 16 built `viewport.frames(bitmap, motion, { loop })` as the one place the panel's 24-column bracket is modelled, and **`Preview.tsx` walks the loop inline instead, so `frames({ loop })` has zero production callers**. The switch that exists to hold one model holds it in one place and the app uses the other. The whole point of that constant was that a preview disagreeing with the panel is a bug nobody sees, which is what it was the first time (`research/loop-gap-2026-08-10.md`). So: `Preview.tsx` calls `viewport.frames` with `loop: 'panel'`, the inline walk goes, and a test asserts the screen and the model agree frame for frame rather than asserting each separately. Watch the pre-rendered offsets added on 2026-08-12 for the clock fix: this must not undo them, since *"it seems to speed up the less pixels are showing"* was that render cost. Suite green, `tsc` clean, `expo export` bundles |
| **35** | **Static text sits in the middle** | `core/src/content.ts` (+ tests) | **`review-16` closed**, because it owns `content.ts` today. **Whoever takes track 27 should take this too**: same file, one owner per file, and 27 is waiting on the same review | *"text should be centered if its static, like centered horizontally"*, Jacob during the sitting, 2026-08-12, verbatim in `notes/what-to-build.md`. `content.text()` ends a static piece with `pad(bitmap, COLS)`, which right-pads, so `HI` sits hard against the left lens. Centre it horizontally in the 24-column panel, leave scrolling pieces alone (a scroller's left edge is where the pass begins and centring it would shift the whole loop), and decide what an odd remainder does rather than letting `Math.floor` decide silently. The dead-pixel mask is applied at the window by `viewport`, not here, so centring must not try to dodge the notch: that is `fonts/place.ts`'s job for `tall7` and it already does it. Pure bun tests, suite green |
| **34** | **An upload says how far it has got** | `packages/app/src/screens/tap-flow.tsx`, `ui.tsx` and whichever screen shows the bar | **track 32 closed** (it owns the `SaveOpts` hook this consumes) and **track 28 closed** (it owns `screens/Library.tsx`) | The UI half of the row above. A full-width loop is ~5 s of transfer at the vendor's pacing and the app currently says only "sending...", which is why a save that is working reads as a save that is stuck. Show blocks against total, on the surface the tap came from, and **no cost words anywhere near it**, per Jacob's ruling. Nothing here may retry, cancel silently, or call `deliver()` a second time: the choke point and `one-tap`'s single-executor rule are untouched. Suite green, `tsc` clean, `expo export` bundles |
| **33** | **Text picks its font on the handset** | `packages/app/src/screens/create/Message.tsx` and the `text` item's stored shape in `library.ts` | **track 26 closed** and **track 29 closed** | The other half of *"i cant pick my own"*. One control on Message, defaulting to whatever `font.DEFAULT_FONT` is, the choice stored on the item so reopening it renders the same, and **the width boundary recomputed per font**, because the 24-column line between free and five erases moves when the font does and that is the one number on that screen doing real work. An item saved before this existed has no font and must render as `band5` for ever rather than following the default, or every old text item changes shape the day the default does |
| **37** | **Waluigi, and motifs that are not text or noise** | new `core/src/motifs.ts` (+ tests), and a Create-tab surface for it | nothing | *"I am gonna dress up as Walwuiji ... i defintely need some waluwuiji themed images and or animations. But like at least a W W for each eye"*, Jacob overnight 2026-08-12, verbatim in `notes/what-to-build.md`. **The first content request this project has had, and the panel is well suited to it**: a `W` per lens is 12 columns, which is exactly the per-eye half the geometry already gives (`research/vendor-app-protocol.md` proves the halves are the same content at every offset only by arithmetic, so build the pair by construction rather than by tiling). Deliver: a `WW` still, and at least three more of the theme (the moustache, the overalls' zigzag, the cap badge's inverted triangle), each a `content.Bitmap` from a named function rather than a pasted array, so a motif can be re-rendered at a different size and cannot rot into a magic literal. **A still is free**: 24 columns fits the live buffer, so showing one writes no flash, which is the route the app must take for it. At least one **animated** member, which on stock means a wide loop that translates (`MODE 02`) or bounces (`MODE 03`, track 39), because the device cannot page frames. Motifs are `Showable` through the existing planner, keepable to the library like any other item, and no new route to the wire. Pure bun tests for the geometry (a `W` occupies its own lens and does not cross the bridge, and `display.alive()` is respected at panel coordinates), suite green, `tsc` clean, `expo export` bundles |
| **38** | **Favourites you can actually build and use in a field** | `packages/app/src/settings.ts`, `screens/Library.tsx`, and a new grouping module | **track 30 closed** if it lands first, since both touch the Show tab's top | *"how easy it will be to add to favourites, and how easy it will be to use favourites. Maybe even groups of favourites. And or add search to whatever you come up with ... but even on the main gallery thing it should be easy to find images"*, Jacob overnight, verbatim. Today: favourites are a flat string list, added only through a long-press menu, and the 30 built-ins are unnamed tiles with no way to narrow them. **Groups**, named by the user, an item in more than one, and a group is what a festival needs rather than one long row. **Adding is one gesture from the tile**, not a menu two levels down. **The gallery becomes navigable without lying**: filter by what a tile *does* (moves or is still; picture, drawing, message, effect) and by recently shown, which are facts the app already holds, rather than a text box over the built-ins. **Search over the built-ins stays refused, deliberately**, and the empty state track 28 shipped says why: they are numbered rather than named and an invented name is a guess a user searches for and fails to find (`notes/library.md`). Say that difference in the row's own docblock, because "add search to whatever you come up with" reads as a request to undo it and it is not. Suite green, `tsc` clean, `expo export` bundles |
| **39** | **The saved store can bounce, and the app never says so** | `core/src/content.ts` motion model, `core/src/protocol.ts` if `mode()` needs it, and the Create surfaces that pick motion | **track 35 closed** (it owns `content.ts`'s motion branch) | The sitting, 2026-08-12: on power-up the device restored our saved word and played it **bouncing up and down while travelling left**, which is `MODE 03` with a direction in its second byte (*verified* by eye, *derived* as to the byte). So **the saved route has two-axis motion for the same zero flash, zero radio and no connection held**, and the app offers only `MODE 02`. This is free capability sitting in an opcode we already send, and `notes/app-plan.md`'s "horizontal translation only" was corrected in place for it. Deliver: `Motion` grows the bounce as a first-class kind rather than a raw opcode, `content.modeArgs` maps it, one control wherever direction is chosen, and the preview shows it, or the preview goes back to disagreeing with the panel, which is the exact failure `review-16` has just finished cleaning up. **What is not known and must not be assumed**: whether the bounce respects `SPEED`, whether it brackets its buffer with blanks the way the horizontal scroll does, and what it does to content taller than the alive band. Ship it labelled as behaviour, not as provenance, and put those three in the next sitting |

| **41** | **A tile says whether it moves, and is believed** | `packages/app/src/screens/Library.tsx` (the `Tile` mark and the three `moves` computations), plus `packages/app/src/builtins.ts` if the built-in source of the fact moves there | **track 38 closed** (it owns `Library.tsx` today and it is the track that built the mark). Not the sitting: this is a legibility question about a phone screen, not about the panel | *"animations should have a tiny icon on them showing if they are animated or not in the show screen"*, Jacob 2026-08-12, verbatim in `notes/what-to-build.md`. **This is a re-ask against a row that already reads Fixed**, and the row is honest: a 9px `▸` at `INK.dim` in the corner of a 104x53 tile exists today. It has also **never been rendered on a handset**, so whether it is too faint or simply unseen is not knowable from the source, and that is the first thing this track must not assume. **The size half already landed**, 2026-08-12, at Jacob's direct request and outside the Needs gate below: he looked at the phone and said *"its there, just small"*, so the mark is now a 17px badge with its own backing and a **border-drawn** triangle rather than a codepoint, because Android's font fallback can serve a glyph as tofu, as a colour emoji or at a size of its own choosing. Seen on the Pixel and confirmed legible. What is left is everything else in this row. Deliver: (1) **both states readable, not one** - the ask is "animated or not", and an absent glyph is indistinguishable from a glyph that failed to render, so a still tile must say still rather than say nothing; (2) the mark sized and contrasted against the real tile deliberately, with the reason in the docblock, since 9px at `INK.dim` was never a decision anyone defended; (3) **the source defect that no glyph size fixes**: `mineTile` reads `motion.kind === 'scroll'`, so track 39's vertical bounce will read as still on the day it lands; derive it from "not static" instead. *Corrected 2026-08-12, an hour after this row was written: it named a second defect in `builtinTile`, that `moves` comes from `b.frames > 1` and `anim-6` holds one frame so a built-in animation is marked still. That is **not** a defect. A bank with one frame does not animate, `frames > 1` is the fact and `kind === 'animation'` is only the drawer it sits in, so the mark is right to stay off it. What the track should do is **say so in the code**, because it read as a bug on sight and will again;* (4) one test walking every tile source (built-ins, motifs, mine) that asserts the mark agrees with the piece's own motion, so the three computations cannot drift apart again. **Do not over-claim on the panel's behalf**: whether a built-in animation plays anything other than its picture is track 20's unsettled `ANIM` base contradiction and belongs to track 11, so the mark states what the bank holds, which is a fact, and must not be worded as a promise about what the glasses do. Suite green, `tsc` clean, `expo export` bundles |

| **40** | **Fake glasses, so the app can be driven with no hardware** | `packages/app/src/fake-glasses.ts` (+tests), the scanner switch in `ble.ts`, the dev row in `screens/GlassesScreen.tsx` | nothing | *Built 2026-08-12 on Jacob's instruction, "for development make sure you can kinda spawn fake glasses to test things".* **Done, unreviewed.** A simulated pair scans, connects, answers the DATS handshake, takes live columns and holds a saved store, so every screen can be driven with no hardware and no erase spent on the one working unit. What a reviewer should check hardest is not the model but its three guards: it cannot exist in a release build (`FAKE_AVAILABLE` is `__DEV__`, and the setter refuses rather than a stored flag the release ignores), fake pairs are their own devices (`GLASSES-FA4E01/02`, so a simulated save cannot land in the real pair's wear count), and only `ble.ts` may import it. **And the thing it must never become**: it models what this repo *believes* the firmware does, reading `viewport.frames` and `protocol.msPerColumn`, so it agrees with `Preview.tsx` by construction and **is not a witness to anything**. Nothing seen against it may be written up as a finding or close a verify item. `.claude/locks/track-40` has the two modelling corrections that came out of it |

| **42** | **The spray: a picture on every pair around you, and no flash on any of them** | NEW `packages/app/src/spray.ts`, `spray-store.ts`, `screens/Spray.tsx` (+tests), the entry mode in `screens/GlassesScreen.tsx`, `savedDevices()` in `ledger.ts`, this row, the CLAUDE.md code-map row and the "what shipped" line in `notes/what-to-build.md` | nothing | *Built 2026-08-12, Jacob: "Yes build it into the app please", against the design already written up in `notes/what-to-build.md`, "At a festival: spraying a temporary image at nearby pairs".* **Done, unreviewed.** Pick a picture, turn it on, and every pair in range that is not yours shows it once over the live buffer. What a reviewer should check is not the loop but the five properties the tests exist to hold: **no flash** (`SprayPair` has no `save`, and a crawl refuses every name the save path goes by, comments stripped so the docblock may still explain itself), **no second `LiveSender`** (the shell owns the one, so a spray uses `Glasses.show`), **consent by default** (`ours` is every pair you have named, saved to or last opened; `never` beats `always`; `already` beats `ours` so a marked pair gets one push per picture and not one per pass), **no platform handle in any event**, and **the radio resting between passes**. Two decisions to push on: the spray **lets your own pair go**, because `BleScanner.scan` calls `release()` and a spray running beside a held pair would drop it with the app still claiming it; and `done` is a nuisance record rather than a consent record, so unlike the CLI a pair is remembered only once it has actually shown something. **The open half is the one that decides whether the feature works at all**: nothing has confirmed the panel keeps the frame after we disconnect. `.claude/locks/track-42` says what to look at first, and it needs two pairs |

**Track 11's three answers are inputs to almost everything else**, which is why hardware
verification keeps coming back to the top of the board: whether DATS bit 7 lights row 8
decides the row mapping every renderer targets, whether `MODE 02` scrolls content narrower
than 24 columns decides whether every upload pads to 24, and whether column 0 lands on one
lens decides whether the draw canvas is one 24-wide surface or two mirrored 12-wide ones.
*Corrected: this said track 5, which took only verify item 4 before closing.*

**Where the board stands, 2026-08-12 07:00**, after one overnight session took the whole
list. *Replaces the "what is actually workable" table written at 02:00, which is spent:
everything it listed as blocked has since been unblocked or built.*

**Eight rows were built between 04:09 and 07:00 and every one of them is `done` in its
lock and unreviewed.** That is the whole backlog now: 27, 30, 33, 34, 35, 36, 37 and 38,
plus 28, 29 and 32 from the night before. **Nothing on this board needs building before
those are checked** by someone who did not write them, which is what "a track is not
finished when it is `done`" means, and eleven unreviewed tracks is the largest that
number has ever been.

*Updated 2026-08-12 morning: **29, 27, 28 and 30 are closed** (`passed`, then three
`fixed`), leaving seven: 32, 33, 34, 35, 36, 37, 38. **Every review so far has found
something the suite could not**, which is the whole argument for doing them before
anything else gets built: 29 a raw `Fit.dropped` printed at a person, 27 its own guard
reading the unflattened bitmap, 28 two chip rows on the front door that did nothing at
all, 30 two done-when items that were simply absent. Two patterns worth carrying into the
rest: **a review keeps finding its neighbour's bug**, 29 finding track 33's and 28 finding
track 38's, because tracks share files; and **the done-when is worth reading literally**,
since 30's two misses were both items no test could ever have caught.*

*Updated 2026-08-19, a week later, by review-32. **Nothing app-side has been built or
reviewed since that morning**: the whole week went on the SWD recovery of unit 1, and the
unreviewed count went **up**, because tracks 40, 42, 43, 46, 49 and 50 landed `done` from
the firmware and animation sessions. So the advice at the bottom of this section held for
a week and still holds. **`review-32` is closed `fixed`** and it found the pattern this
file already names: **a review keeps finding its neighbour's bug, and this time the
neighbour was the same track's other file.** Track 32 fixed `MODE`-after-a-rejected-commit
in `deliver.ts` and left the identical thing in `playlist.Cycler` twenty lines from the
residency check it did fix. Worth carrying: **an assertion that names the right defect can
still miss it** - the test for that exact case checked residency and cost and never looked
at the log, so the wire was wrong and green for a week.*

| Still open | Why, and what it needs |
| --- | --- |
| **11**, **16**, **31** | eyes on a panel. The no-flash half of the sitting ran on 2026-08-12 and answered items 2, 3, 6 and 7; what is left needs **one save** (items 1 and 5) and a person watching, so it waits for Jacob |
| **26** | his verdict on the handset, which no reviewer can give |
| **39** | `MODE 03`, the two-axis motion the sitting found. Needs track 35 closed, which is done but unreviewed |
| **41** | *added after this snapshot, 2026-08-12 daytime.* The motion mark on a Show tile, asked for a second time. Needs track 38 closed, since 38 owns `Library.tsx` and is the track that built the mark being re-asked for |
| the reviews | `review-33` through `review-38`, plus 40, 42, 43, 46, 49 and 50, and they are the work. *`review-32` closed `fixed` 2026-08-19* |

**What a fresh agent should do**, in this order: pick the lowest-numbered `done` track
with no `review-N` and review it. Do not start a new feature: the ratio of built to
checked is the risk on this board now, not the length of the list.

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
| **10** | Nicknames | `packages/app/src/nicknames.ts` (pure store, persistence injected as a `TextFile`) + `nicknames-store.ts` (own `nicknames.json`, **never** the ledger's, now enforced by two source-level tests) + the Scan list's two-line row and inline rename editor. Keyed on the advert name that `SessionOptions.device` defaults to, so a nickname can never become the ledger key. Nothing on the wire, no flash. Review fixed 4: the 40-unit cap left a trailing space and split emoji into a lone surrogate, a map read by truthiness answered `Object.prototype` for an advert named `__proto__`, re-sighting rotated row order under the open editor, and a 40-char nickname pushed the RSSI and rename link off the row. *Corrected 2026-08-11: this said the nickname row and the editor were still unrendered on a handset. Both were rendered on the Pixel under track 14, a seeded 40-char nickname ellipsising while keeping the RSSI and the `rename` link on the row, the editor opening pre-filled and committing through the keyboard's done key, and `nicknames.json` written while `ledger.json` kept its earlier mtime: the two-file split witnessed on disk.* |
| **15** | Mirror and fire | `core/src/effects.ts`: `mirror` kaleidoscopes any field or named effect, `fire` is a leaning flame silhouette; both in `EFFECTS`/`FIELDS` so the registry walk holds them to closure, the 736 ceiling and the level rules. `bun run effects mirror|fire`, `--inner` picks what to mirror. Review fixed 4 defects, the one that matters being that **mirror never mirrored across the bridge**: the panel is symmetric about x = 11.5 and the folds put every axis on a column centre, so 87 of 92 widths never lined up. Half a column of fold phase plus `mirrorFolds` snapping fixes it, and mirror defaults to `dither: 'none'` because ordered dither's column-tied thresholds cannot be mirrored. `fire` at `levels: 2` needs `dither: 'none'` or the dither eats a third of its columns. **Nothing here has run on the panel** |
| **12** | Compose and Connected intuitiveness | `screens/Connected.tsx` over new `src/deliver.ts`: Show now (outline, free) and Save to glasses (filled, five erases), each printing `costOf()`'s own sentence, with the unit's lifetime count and a last-50 save log under them. Grey is a **costed question** (`greyChoice`), not a refusal: flatten to type 1, or keep it as type 2 which gets **no `MODE`** because `MODE` discards the image it just displayed. Cancel is `SaveOpts.cancel` in `core/src/session.ts`, asked before every block and once more before `DATCP`, so an abandoned upload spends no flash and records no save; the three-second interval is still spent, deliberately, or a loop could cancel out of the rate limit. The `SPEED` ladder moved to `protocol.speedDivisor` beside `protocol.speed()`. `ledger.ts` split into a validated parse (`ledger-shape.ts`) and a verified temp-and-rename (`ledger-write.ts`, whose `writeThroughTemp` track 21 reuses). Review fixed 5: **a damaged `window` dropped the hour and day rules while the records still proved them**, `lifetime` under-counted a day of saves as fifty, the rename fallback fired only on a throw so a quiet no-op stopped wear counting for ever, Cancel was offered on paths with no `DATCP`, and the once-only discard warning could be burned with nothing to discard. **Nothing screen-level has been seen**: `Connected.tsx` needs an open session and no sitting has had one |
| **14** | Proximity greeting | `packages/app/src/proximity.ts` (+ 29 tests): a `Presence` keyed on the advert name, a 12s freshness window, EWMA-smoothed RSSI, a band split, and the `headline`/`bandLine`/`friendLine`/`signalText` wording. `feed()` pipes ONE scan into both the count and the scan rows, because a second `startDeviceScan` replaces the first rather than running beside it, and the count lives in a ref published on a 1s tick so it can never reorder a row (review-10's defect). Advert-only is **structural**: `feed` takes an `AdvertSource` that has no `connect`, held there by two source-level crawls. `ble.ts` gained an additive `ScanTuning` and now folds both no-reading sentinels (`null`, Android `127`) into one `0`, since either taken as dBm outranks a pair in your hand. Seen on the Pixel 2026-08-11 with zero wire lines in the log, and it closed review-10's open item by rendering the nickname row and inline editor for the first time. Review fixed 5, the two that matter being that **the 127 guard only covered the first sample** (a pair still reported with no usable RSSI kept its old band for ever, so `read` now has its own clock beside `seen`) and that **12s buys one missed low-power report, not the two the docblock claimed**. Unwitnessed: the count falling, a second pair, and the `no reading` row text |
| **17** | Saved library: drawings and text presets | `packages/app/src/library.ts` (`SavedDrawing`/`SavedText`, `revive()` as the trust boundary, `Library` over an injected `LibraryStore`, `nextDrawingName`) + `library-store.ts` (its own `library.json`, **never** the ledger's, pinned by two source-level tests) + `Canvas.load()` and the Draw screen's Saved section: save is a local file write that works with the glasses off, Load replays through the live columns, Delete sits behind an Alert, and library failures go to their own `libTrouble` so a library that will not write cannot disable the pad. No flash, no `MODE`. Review fixed 3, the one that matters being that **a delete racing the first read was undone in memory and written back by the next save** (`held()` cached the array, not the load), the shape any second screen over the singleton produces. The expo-file-system glue is *verified* on-device, via `ledger.json` making the five identical calls. **The Saved section is still unseen: `App.tsx` mounts Draw only with an open session**, so it needs a connected sitting, and a `library.json` of deliberately awkward fixtures is planted on the Pixel for that look |
| **18** | Playlist: 2-10 items on one button | `core/src/playlist.ts` + `cli/src/playlist.ts`: statics go live, every scroller is packed into ONE type 1 reel, so a revisit is `SPEED` then `MODE 02` and a nine-press cycle spends exactly one `DATCP`. `Cycler` tracks type 1 residency itself because `budget.allow()` compares the last save of **any** type, and believes it only once `DATCP` answered `DATCPOK`. `costOf`/`costs`/`upcoming` price a press before it happens, a `BudgetError` propagates with the index unmoved, `individual` mode is opt-in at five erases per press. Review fixed 2: a failed `DATCP` marked the reel resident for ever, and an unrecognised `mode` skipped every reel rule then crashed inside `compile`. **Nothing has run on hardware**: the first `run --yes` settles the five items in `notes/playlist.md`, "What the first run settles", the fifth being whether the wrap gap looks about twice the joins, which if it does lets `REEL_GAP` come off the final member. Open, needing `session.ts`: a DATS type on `budget.SaveRecord`, which must read the last **type 1** record and treat a missing type as unknown |
| **21** | Atomic writes for the phone's two stores | `library-store.ts` writes through `library.json.writing` and renames, reusing review-12's `writeThroughTemp` so both phone stores share one policy and differ only in their closures over expo-file-system, plus `library-store.test.ts`, which drives the **real** store under `mock.module('expo-file-system')` over a breakable in-memory filesystem. Review fixed 3, the one that matters being that **the in-place fallback destroyed the library it protects**: on storage that refuses the bytes without killing the app, the tear went through the recovery path and left 20 characters where a library had been, unseen because the fake modelled every tear as process death. A three-state `reached` now refuses the fallback in that one state only. Two deliberate divergences from `ledger.ts`, both of which `ledger.ts` should take (track 24). The library's ledger crawl was narrowed to admit the shared import and came out **stronger**: 7 of 8 injected violations red, up from 4, after closing review-14's dynamic-import hole here too. **`nicknames.test.ts` still has that hole**, and the same three lines fix it. **Nothing has run outside bun**: a `library.json.writing` left on a phone is how a no-op rename will announce itself |
| **20** | One library to pick from, mine and the system's | `app/src/builtins.ts` + generated `builtins-data.ts` (30 built-ins with real thumbnails) + `screens/Library.tsx` (three headed groups over a `SectionList`, because a tile is 216 views and 30 built-ins would lay out 6,480 at once; **ready to mount and it must be reachable with `glasses === null`**, which is what has kept Draw unseen) + `research/tools/bankdump.ts`, offline, which re-resolves the bank inventory by walking the per-tick dispatch table and **diffs itself against `firmware-internals.md`**: all 20 rows agree, banks contiguous `0x22f06`-`0x268f6`. Thumbnails pick the frame with the most edges, because frame 0 opens on a 2x2 block and "most ink" picks the fully-lit frame that shows least. `commandFor` is pinned byte-for-byte against the vendor app's own frames, an independent source from the firmware decode. **Found a contradiction worth one look**: `IMAG n` decodes end to end, but `ANIM n` = mode n + 5 disagrees with the vendor app sending `ANIM 20-29`, which under that reading are modes 25-34: the image mode, the type 2 mode, six oddments and two values `set_mode` refuses. One reading is wrong, no further disassembly can say which, and `protocol.animation`'s docblock now says so. Nothing rendered on a handset, nothing sent to glasses |
| **19** | White screen on the handset | Solved: the dev launcher only remembered `http://192.168.1.119:8081`, the Mac's LAN address from 2026-08-09, and `adb reverse` maps only `localhost:8081`, so no tunnel could rescue it. Fixed with one `exp+joggles://expo-development-client/?url=...localhost:8081` deep link; plain launches auto-connect after. Both earlier suspects refuted: the `exp+joggles` intent filter already exists (`app.json` needs no `scheme`) and the `SplashScreenManager` `ClassNotFoundException` is caught and harmless. **A white screen is the dev launcher, not a dead app**: its home is white Compose and blank for ~1s, ours is `#111`. The durable recipe and all four look-alike faults are in `.claude/context/android-dev.md`; the write-up that was `notes/white-screen-2026-08-10.md` was folded into it and deleted, because a solved dev-loop problem belongs where someone with an adb question will look. Landed with no review, deliberately: it changed no product code, so there is no contract for a reviewer to check |
| **13** | Wide loops in the app | `packages/app/src/effects-ui/` (`catalogue.ts`, `plan.ts` and their tests) is the part that survived: which knobs a thumb gets per generator, and one loop priced and checked through `deliver.costOf` unmodified. **Its screen did not survive**: `screens/Effects.tsx` was deleted by the redesign and replaced by `screens/create/Effect.tsx`. **Retired unreviewed on 2026-08-12**, the only row in this file that has been: `review-13` was interrupted mid-review by single-instance mode and its subject no longer exists. What it found before it stopped is still worth reading (`.claude/locks/review-13`), and its headline defect, a 736-column loop with nothing lit offered for five page erases, became **track 27** because a screen fix would not have survived the rewrite either. It also found, and could not fix, the `deliver()` `ERROR`-then-`MODE` defect that is now **track 32** |
| **22** | Showing text is one screen | Delivered inside track 26 as `screens/create/Message.tsx` plus the library front door: typing a word and showing it is one screen with no Motion, Direction, Speed, Ink or Panel row between them, and the saved words are the tile grid on Show. Every item of its done-when holds except the one Jacob's ruling struck: there is no "one costed action", because nothing on the screen prices anything |
| **23** | Long text shows, and scrolls without saving | Half delivered, half **deliberately dropped**, and the dropped half is the useful record. Delivered: **wide content clips instead of being refused**, in `one-tap.planTap`, through `viewport.windowAt` at offset 0 so `alive()` applies at the window and a dead-pixel hole cannot travel with a glyph; emptiness is still refused. Dropped: **the host-driven marquee** (`marquee.ts` was never written). Its whole value was scrolling without spending flash, and two things ate that: text now picks its own motion so a long message just scrolls, and Jacob's ruling that human taps cannot realistically wear the flash out removed the reason to avoid the save. It also cost the connection held and ~2.3 columns/sec against the device's 7.1. **Revisit only if the sitting finds the device's own scroll unusable**, which is the one outcome that brings it back |
| **24** | The wear count stops lying | Delivered inside track 26. The wording stopped claiming a total it cannot know (`ledger-shape.wearWords`, and the count moved to the Glasses tab where the redesign put it) rather than reconciling across clients, which is unreadable from the device at all. Both defects review-21 confirmed are fixed: `ledger.ts` no longer discards `writeThroughTemp`'s outcome, and it no longer reports "counting in memory only" before the fallback has been tried. Endurance stays *unverified*, so no percentage is claimed anywhere |
| **30** | Several things on one pair, without an upload each time | `app/src/reel.ts` over `core/src/playlist.ts`: the favourites commit as ONE type 1 save through a Cycle link on the Favourites header, after which moving between members is `SPEED` + `MODE` and no flash. `entriesFor` reuses `one-tap.pieceFor` so an effect renders once for the whole app; `reelDriver`'s live half goes through `PanelSession` and never `Glasses.show`, the app being allowed exactly one `LiveSender`; `cyclerFor` seeds `Cycler` from the ledger hash, which is what makes the first press of an already-held reel free. `App.tsx` keys the `Cycler` ref on `id:at` per item, so **editing** a member rebuilds it and not just adding one. Review fixed 2, both done-when items nobody had noticed were missing: **nothing could say which items the pair's reel holds**, because `one-tap.residentItem` matches a single item's fingerprint and a reel's hash is the packed payload's, so a committed reel read as the pair holding nothing (now `reel.reelResident`, kept beside the reel, with `residentItem` untouched); and **the screen never said the pair's own button walks the same set**, which is the feature working with the phone in a pocket and the one line a festival actually needs. Reported not fixed: with a reel up, tapping a member from the Mine grid re-plans as a fresh save, correct but unexplained. **Never run on hardware**, engine included |
| **32** | A failed commit stops pretending, and residency knows its type | Three things. **`SaveResult.committed`** (`reply === 'DATCPOK'`), additive exactly as `SaveOpts.cancel` was, because `status: 'saved'` has to keep meaning "the erases were spent" - `budget.count()` is called on it. `deliver()` gates `SPEED`+`MODE` on `skipped || committed`, so a commit answered `ERROR` no longer switches the panel to the saved store and calls it success. **`budget.SaveRecord.type`**, written only by `session.save()` from the type it announced, over one private walk (`decider`) with two questions on it: `holds()` for the duplicate check, which an untyped record can still answer soundly because `fingerprint` mixes the type in, and `storedHash()` for residency, which answers only over a record that names its store, so an old typeless ledger reads **unknown** rather than type 1. `allow()` moved with it, which is the decision worth knowing: had only residency become type-aware, one-tap's free `return` route would have predicted "free" while the guard spent five real erases. **`SaveOpts.progress(sent, total)`**, blocks not bytes, `(0, total)` on `DATSOK` then one per block, never for `DATCP`, and a throw from it is swallowed where a throw from `cancel` is not. Review-32 fixed 1, and it was **the same defect in the same track's other file**: `playlist.Cycler` believed `committed` for residency and then sent `SPEED`+`MODE` regardless, so a rejected reel commit switched the panel to a store its own `DATS` had just zeroed while `App.tsx` said "On the glasses". The test for that case had asserted residency and cost but never the log. `StepResult.showing` now carries the answer, because `cost` cannot: a rejected commit costs a full save and shows nothing |
| **29** | More fonts, and one worth reading | `core/src/fonts/`: **band6** (4-wide capitals across the full 6-row band, visibly the legible one) and **slim5** (genuinely condensed, C/E/F/J/L two columns), both **beside** `band5` and never over it, so `DEFAULT_FONT` and `LEGACY_FONT` still read `band5` and no stored text item changes shape. A `Font` carries `label` and `note`, which is what track 33's picker shows. slim5 puts JOGGLES at exactly 24 columns against band5's 27, so this repo's own price-boundary example flips from five erases to free. **No 9-row scrolling face**, and `font.ts` carries the argument: scrolling visits every column, so a glyph outside rows 2-7 loses a stroke crossing the bridge. Review passed, having probed rather than read: every face through `content.text` into `viewport.hidden` (zero lit pixels on a dead LED in any face, which no test asserted end to end) and all 3,844 glyph pairs per scrolling face (no overlaps; both new faces ship an empty `pairs` table and rest entirely on track 7's ink-profile arithmetic). It found one defect in a **neighbour**, track 33: `Fit.dropped` is the characters a static face could not seat, not a sentence, and `Message.tsx` printed it bare, so choosing tall7 and typing JOGGLES showed the word "LES" in red with nothing to read it by |
| **28** | The library is searchable | `app/src/library.ts`'s `search(items, query)`: an item's name plus a text item's body and **nothing else**, terms ANDed and order-free, a blank query meaning search is off rather than nothing matched. The 30 built-ins are browsed and never searched **by construction**, being `Builtin`s and not `SavedItem`s, and the screen says why rather than looking as though it lost them. The field appears at nine saved items or while a query is live, never autofocuses, and the favourites grid and both built-in sections step aside while one is. `effects-ui/plan.ts`'s `WIDTHS` ladder **deleted** rather than unexported, the no-width default now `fx.MAX_COLUMNS`. Review fixed 1, and it was **track 38's feature in this track's file**: the sections memo read `group` and `only` and listed neither as a dependency, so the group chips and the Moving/Still chips lit themselves and changed nothing below them. Creating a group bumps `pinsAt` on the way past, so the first one worked and every switch after it did not, which is why it survived. A crawl now holds the general rule (every `useState` the memo reads is a dependency of it), proved by injection. **Still unrendered**: the phone sat at the biometric bouncer all session |
| **27** | Nothing spends flash to show nothing | `core/src/content.ts`: a dark type 1 save is refused by `check`, **on the erase-spending path only**, with `EncodeOptions.blank: 'clear'` as the named escape. The escape exists because there is no erase-store command in this protocol, so writing something dark over the store is the only way to empty it. Scoped by `savedType`: live costs nothing and a dark type 2 lands in RAM, so neither is refused. The found combination (`mirror` + inner `ripple` + folds 10 + no dither, dark at every width) is covered **by name** through `fx.EFFECTS`, and `plan.ts` filters core's sentence so a blank loop prints the one that names which knob fills the panel. Review fixed 1: **the rule read `content.bitmap` while the encoder writes `flatten(bitmap, threshold)`**, so a threshold above every level in the content walked straight through the guard and produced an all-zero type 1 payload, five erases for a dark panel. Latent rather than live, since nothing passes a threshold today, but the `threshold` docblock sends callers at exactly that pair of options |
| **25** | Static effects, and the direction that does not gap | Delivered inside track 26. **Static** is the Effect screen's Still option: one 24-column window through the live buffer, which is the only zero-erase way to put a generated picture on the panel. **Direction** defaults to the one that puts the dead space at the *end* of a pass (left-scrolling, `MODE 02 00`, *derived*), the other is offered as behaviour and not as an epistemic caption, and nothing in the app implies a wide loop can be seamless on stock. **One item went to the sitting rather than being built**: at the slowest `SPEED`, is the dark pass about one panel width or about two. One means a single bracket is walked, two means both, and it is track 16's question from the other side |
| **58** | Protected regions, by content | `research/tools/fwtool.ts` `deriveRegions`: all seven regions resolve **by content** in whichever image is handed in, two mechanisms because the code has two shapes (a cluster for the leaf-function flash driver, a literal pool for the handler and handoff). The finding: `Expected: 16` was an **APK-layout number**. 16 sites there, **39 on the donor**, and two of the three that slid out of the span named for them are the word programmer and the page eraser. The gate now asserts five properties true of any build. `research/protected-regions-2026-08-20.md` |
| **59** | FMC primitives on the donor | `research/tools/fmcres.ts`: base `0x5000c000` and `SYS_REGLCTL 0x50000100` found by the **poll idiom**, not by matching an address, and identical on both builds. Two things worth more than the answer: the two builds' FMC helper block is **not a constant offset apart** (`+0xf4` for six helpers, `+0x110` for the word programmer and config writer, because the donor carries a 28-byte `ISPCMD 0x04` helper the APK lacks), and **`CBS` does not gate application-driven ISP** - the vendor's own OTA handoff erases the config page then programs it, so between those steps it runs at `CBS = 11` |
| **60** | Slot framework, and the tick | `research/tools/features/`: **slot dispatch, which did not exist at all**, so "the resident half answers before any slot" had been vacuous. Resident table first, executed. Plus the 100 Hz tick as a **build-time image edit** (a slot cannot carry it: the rate is an immediate in the vendor's `TIMER_Open`), with all 44 compensations found by walking the TIMER0 ISR rather than by grepping. Long press measured in the simulator at **2.09 s compensated against 1.05 s without**. Fixed every review-33 finding. The rule that keeps the guarantee true: **no slot feature may run outside a command frame**, which is also why button-notify cannot be a slot |
| **61** | The wire contract | `core/src/jgx.ts`: `TICK`, `SEED`, `TILE_DEF`, `TILE_FRAME`, `SMOOTH`, `BUTTON`, `BATTERY`, and six capability bits, each in its reserved family. Found that `updEnd`/`updAbort`/`updStatus` built **2-byte bodies**, which the dispatcher's 4-to-20 length gate drops before the `J` compare, so **an update would have hung on its own commit in silence**. Settled the rule track 63 needed: a family bit does **not** imply its feature bits and nothing may gate on one |
| **62** | `bun cli patch` | `packages/cli/src/patch.ts`: the client that actually pushes a slot, which did not exist. Subcommands are the safe procedure in order, and the wrong-slot-base check cannot be skipped because `Checked`'s constructor is private and nothing reaches the wire without its output. 46 tests against a fake unit whose flash models bits-only-clear, so idempotency and magic atomicity fall out rather than being asserted. **Never pointed at hardware** |
| **63** | The app probes, never assumes | `app/src/carried.ts`: one caught `probe()` per connection owned by the shell, remembered per advert name, gating on the **bitmap and never the version**. A stock pair's silence is worded as an answer and a test fails the build if any sentence about one reads as an error. Last sitting's answer is deliberately **not assignable** to the gate, because a unit can be reflashed between sittings |
| **64** | The gates, attacked | `ota.check` **refused the correctly rebased image and passed the APK-derived one**, because the expectation defaulted to the APK's version string; `comparePatch` diffed across image bases for eight fatals of which every one was wrong; the callback-slot check 2026-08-08 lacked had **never actually run**, being a warn on every path with no CLI passing a reference. `safe-surface` knew only `from '...'`, so five violation spellings walked past it, and `choke-point` **never scanned `.tsx`**, leaving all thirteen screens invisible. New `firmware-doors.test.ts` is the doorway allowlist those two needed |
| **65** | CONFIG0, and the config script turned round | Unit 1 is the only unit ever to run at `CBS = 11`, "APROM without IAP", and IAP is the one thing the resident updater needs. Closed the same day by track 59. Two corrections of my own worth keeping: the failure would **not** have looked like success (`erase_page` reads back and demands all-ones, so the cost of being wrong was one reply code), and the reversal is the **first `CONFIG0` program** this project would perform, which is when both legs of the "LOCK bit is unreachable" argument disappear |
| **66** | The simulated list bled real pairs | `GlassesScreen.tsx` kept its own array of sightings that nothing ever emptied, while the header came off a presence rebuilt each round: two views of one field on two update rules, so a **real pair was listed under "Simulated pairs only. Nothing here is evidence about the real panel."** Rows derive from the presence now, so they cannot disagree. Second defect: tapping the stale row could not reach a real transport but **threw a message carrying the pair's MAC**, because `pairWords` only rewrites a handle following the word "device". The refusal takes no id at all now, and a crawl fails the build if any thrown message in the app interpolates one |
| **67** | The button advances the playlist | `core/src/press.ts`: **a press cannot spend an erase, structurally** - it steps to the next step priced free and over anything needing a `DATS`, holds no reference to `save`, and a crawl asserts the token is absent. Three reasons, and the first is that strangers mash this button at festivals. `Cycler.forget()` is the one addition to `playlist.ts`, for the case where suppression did not take and the firmware moved the panel with the host sending nothing |
| **68** | Tap tempo | `core/src/tempo.ts`: the beat as 8.8 fixed point in **device ticks**, integer throughout, because whole ticks are ~2% out and a full beat adrift inside thirty seconds. Found two design defects while building: judging a multi-beat gap by its **implied interval** accepts any gap past four beats, which had silently killed tempo-change detection, and taking beat indices from the press counter would have read a contact bounce as a beat. `separationMs`/`measuredPpm` turn the open crystal-or-RC question into a **ten-second experiment** |
| **69** | Tiles and interpolation | `core/src/tiles.ts` and `subcolumn.ts`. A palette is 16 entries of 3 bytes against a 15-byte ceiling, so it is four writes and **not atomic while a frame is**: `Palette` has no half-defined value and `Painter` refuses to draw until every entry **the frame uses** is acknowledged. Masking spends entries, so identical content either side of the notch is two tiles. The interpolation preview models the **level** and says plainly it does not model brightness |
| **70** | `MODE 03`, verified then built | Step 1 gated step 2, and it earned it: `MODE 03` is real on both builds, byte-identical over 210 bytes, but the second byte is a **horizontal** direction and the "mirrored vertical bounce" three of our files described **never existed**. Also settled that the 24 blank columns are a **prefix, not an append** (`DATCP` records `ncols = bytes/2 + 24`, confirmed off two units' flash), which resolves `loop-gap-2026-08-10.md`'s open half. `core/src/bounce.ts` says the swing **clips rather than wraps**, so only rows 2 and 3 survive every phase and no font here does |
| **review 33** | The update loop, attacked | Found `UPD_DATA` could reach the live slot (reachable on unit 1 from its first command, because its staging bank still holds the brick image), that there was **no slot dispatch at all**, and that `UPD_STATUS` reported the live slot where every caller needed the target. Its lasting value is the other half: the four-byte hook **held**, re-derived from bytes across all 256 KB with indirect references as well as branches, and the 2 s long press cannot be broken by this loop |
| **review 34** | Pre-flash gate on the rebuilt image | The image was rebuilt after track 60, so the design review 33 cleared is **not** the design in the file: 1,103 bytes differ and the resident half grew 980 to 1,228 bytes. Re-attacks review 33's own findings against the rebuilt bytes and reviews the brand-new slot dispatch. **This is the gate the first flash waits on** |

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

### Feedback from using it

Added 2026-08-11, the first evening anyone drove the app on a handset with the glasses
connected. Seven complaints in one session produced two defect fixes and three tracks, and
**not one of them was visible to the suite**: it was 673 green throughout, while the app's
main action silently blanked the panel. That is not a contradiction, because this repo
checks what a screen renders by looking at it. The looking is the gap.

So feedback gets the same discipline as a finding, and the same route as any other work:

- **Raw feedback lands in `notes/what-to-build.md`, verbatim, dated, with who saw it.**
  Keep the words. "Just showing text feels quite hard" is the complaint; "improve Compose
  ergonomics" is a paraphrase that has already lost it, and the paraphrase is what gets
  built by mistake.
- **Then carve tracks off it**, per "Adding a track" above. A complaint is not a track
  until it has a done-when a reviewer can check item by item.
- **Say which item each track answers**, so the person who reported it can tell whether
  the thing they minded was the thing that got built.
- **A defect goes straight to a fix, a want goes to a track.** "The second time I show
  text it turns them off" is a bug and was fixed inside the hour. "The text creator should
  be one screen" is a design direction and belongs on the board where it can be argued
  with before anyone types.
- **A track can be reserved for a named person.** Put the reservation in **Needs**, since
  that is the eligibility test every agent already reads, and no generic "claim the next
  eligible track" prompt will take it.

**Read the feedback before building the fix.** Two of the seven were misdiagnosed on the
first guess, including by an agent that had the source open: the greyed button was blamed
on width when it was motion, and the blank panel looked like dead hardware when it was a
latched ref. The wire log settled both in minutes and the guesses did not.

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

- **Never write to the `fd00` OTA service.** It bricked a unit on 2026-08-08, and
  repairing that unit on 2026-08-20 took a probe, a donor dump and 150 page erases. How that is
  enforced is in `CLAUDE.md`; the prohibition is repeated here because it is the one
  mistake that cost hardware.
- **`bun run test` must be green when you stop.** 1110 tests as of 2026-08-19; the number
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
