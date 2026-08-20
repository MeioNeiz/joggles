# Playlist: 2-10 items cycled on the power button

**This file is the judgement behind `core/src/playlist.ts`.** Asked for by Jacob
2026-08-10: "select x images/text/animations where x could be between 2-10 and set that
as the ones I cycle between" on the power button, respectful of flash wear. Built
2026-08-11 as track 18: `core/src/playlist.ts`, `playlist.test.ts` and
`cli/src/playlist.ts`. **No press has ever been sent to a device**; see "What the first
run settles".

## The verdict that shapes everything

**On stock firmware the button cannot do this.** Short press only cycles the 21
built-ins, and the saved store holds exactly one user item per type (no slot index). So
the true feature is firmware, and it is precisely the composition of two ranked patches
in `notes/what-to-build.md`: "Button drives our content" (~50-100 B, hook the press
latch at `0x2000306e`) plus "Content in the staging bank" (60-100 B), living in the
`0x20` content family `notes/firmware-design.md` already reserves. Jacob's direction for
now: **build what stock can do today, shaped so it becomes the firmware feature later.**

### The host half of the firmware feature is now built, 2026-08-20

*This section stays true about stock and was half wrong about a crew unit, so here is the
other half.* `core/src/press.ts` is the driver: `PressCycle` binds one connection's
button to one `Cycler` through `SUB.BUTTON` and `MSG.BUTTON`. It is *derived* throughout,
because no unit carries the extension and **the slot that would answer `SUB.BUTTON` cannot
exist**: a press arrives in the TIMER0 ISR, nothing in the slot framework may run outside
a command frame, and the hook is spent, so the firmware half is **SWD-only with its own
image** (`notes/patch-over-bt.md`). This paragraph's "the true feature is firmware" is
therefore still right, and it is a bigger job than the two ranked patches suggest.

Three things worth carrying forward, because each is a decision rather than code:

- **A press cannot spend an erase, structurally rather than by policy.** An advance steps
  to the next step the cycler prices `free` and steps over anything needing a `DATS`; a lap
  of nothing but costed steps does nothing and says why. `press.ts` holds no reference to
  `save` and a source crawl asserts the token is absent. Three reasons: strangers mash this
  button at a festival, a `BudgetError` inside a notification handler has nowhere to go, and
  it makes the claim checkable. `individual` mode is button-unusable by the same rule, which
  is correct rather than a gap.
- **`Cycler.forget()` exists for one case.** If `SUPPRESS_CYCLE` did not take, the
  firmware's own `set_mode` moves the panel with the host sending nothing, which is the
  "`MODE` discarded the live buffer" trap arriving with no `MODE` to see. So a forget
  precedes the advance unless suppression is confirmed **and** the event carried
  `INDEX_NONE`, a real index being the firmware saying it cycled. Residency is untouched,
  so a forget costs one 24-column redraw and never five erases.
- **The driver's own worst failure is a phone that walks away.** The subscription lives in
  the unit's RAM and a disconnect does not clear it, so a wearer can be left with a short
  press that does nothing. The 2 second hold is the only thing that makes that survivable,
  which is why no flag may ever suppress the hold and why `stop()` reports `cleared: false`
  with that sentence rather than claiming success.

## The stock design: cycling writes no flash at all

The key facts, all already in the repo:

- The live route (`SMVEW 01` + paced column writes) costs zero flash and zero budget,
  shows all 4 grey levels, and `Glasses.begin()`/`show()` already do it. Its price is
  the ~0.5 s left-to-right sweep per frame.
- Only type 1 persists and scrolls; every `DATCP` on it is five page erases of the same
  pages. `MODE 02` displays whatever type 1 content is resident, for free.
- `session.save()` returns `skipped` when the payload matches the last acknowledged
  save, and `budget.allow()` checks that duplicate **before** the 3 s interval rule, so
  a skip never throws.

So the plan:

| Item kind | Delivery | Flash cost |
| --- | --- | --- |
| static <= 24 cols (image, drawing, short text, grey fine) | live route: `begin()` + `show()` | none, ever |
| scrolling (text, wide effect loops), packed | ONE type 1 "reel": members concatenated with a gap between each, <= 740 cols | 1 save per playlist edit |
| scrolling, selected individually (`individual` mode) | own type 1 save per switch | 5 page erases per switch, cost stated first |

Showing the reel when it is already resident is `SPEED` then `MODE 02` (that order, per
the vendor log), no save. **In reel mode, cycling itself never writes flash**; selecting
"the scrolls" shows all scrolling members in rotation. True per-scroller selection is
the `individual` mode and it is the only thing that costs erases per press.

Grey in scrollers flattens (type 1); `Step.flattened` and `Reel.flattened` carry that so
the UI can say so, per track 12's language. Effects loops must be `levels: 2` to be reel
members, which is what `cli/src/playlist.ts` passes.

**The gap belongs to the entry, not only to the compiler.** Two verified facts pull
opposite ways: a reel of texts needs a separator or two members read as one string, and
a wide effect loop is built to close on itself so a separator turns its seam into a dark
pass. So `Entry.gap` overrides the default and `loopEntry` sets it to 0. Inside a reel
that means a loop runs straight into the next member, which is the author's call.

## Defect found on the way: residency is not what the budget tracks

**Fixed at the source on 2026-08-12 by track 32, and the fix is at the end of this
section.** The next three paragraphs are what the defect was and why the cycler is built
the way it is: read them as history, not as current behaviour.

`budget.allow()` compared only the **last** acknowledged save of any type, but the
device holds TWO stores (type 1 flash, type 2/live RAM). Any other save between two
visits to the same reel changes that "last hash", so the reel looks like new content and
a naive cycler spends five real erases putting back what is already there. The realistic
trigger is a type 2 save from the drawing screen, and it is a test:
`playlist.test.ts`, "a type 2 save between reel visits does not make the reel look new",
which also asserts that a bare `FlashBudget` over the same ledger *would* have allowed
that save.

So `Cycler` tracks type 1 residency itself and never calls `save()` when its own hash
matches. `residentHash(ledger)` seeds that belief across sessions from the ledger's last
record, and it is deliberately strict: only the very last record, and only if the device
acknowledged it. An older matching record proves nothing, because any later `DATS`
zeroes the store and a failed save spent its erases anyway. A type 2 record cannot be
mistaken for a reel, since `budget.fingerprint` mixes the DATS type into the hash. Worst
case is one redundant save at the start of a session.

**And residency needs the `DATCP` reply, not the save's status** (review-18, 2026-08-11,
fixed). `session.save()` answers `saved` for any `DATCP` it managed to send, so a dropped
block or a lost notify comes back as `saved` with `ERROR` or `TIMEOUT`; the ledger records
`ok: false` and `DATS` has already zeroed the store. `Cycler` believed the status, marked
the reel resident and made every later visit free, which would have left the panel blank
with no save left to repair it: the mirror image of the defect the module was built for,
and invisible because the press reports a cost of one save either way. It now believes
only `DATCPOK`, the same flag `residentHash` reads off the ledger.

**Done, track 32, 2026-08-12: `budget.SaveRecord` carries the DATS type**, written by
`session.save()` from the type it announced. What replaced the three paragraphs above:

- `budget.allow()` compares against the last acknowledged save **to the same store**, so
  the type 2 drawing no longer makes the reel look new. The defect this section is named
  for is fixed at the source; the test kept its name and its last assertion is now that
  a bare `FlashBudget` **agrees** with the cycler.
- `residentHash()` is `budget.storedHash(ledger, TYPE_TEXT)`, which looks through an
  acknowledged type 2 record to the type 1 one beneath it, and still stops dead at a
  commit the device did not acknowledge.
- **A record with no type reads as unknown, never as type 1.** Every ledger written
  before this day is full of them, on this Mac and on the Pixel, so a fresh session
  reading an old ledger claims no residency and pays one redundant save for it. The
  alternative was an "on the glasses" badge over content nobody can prove is there.
- What `Cycler` still keeps is the half the guard cannot do: it never calls `save()` at
  all when its own hash matches, so a revisit builds no payload and spends no interval,
  and it can state the cost of a press **before** the press.

*The paragraph that stood here said the phone still dropped the type on reload, so the
whole section read as unknown for ever there. It landed under track 34, and stricter
than the line suggested: `app/src/ledger-shape.ts`'s `cleanRecord` keeps `type` only
when it is 1 or 2, because `budget.storedHash` reads an unrecognised number as a save to
some other store and would answer questions about a store that does not exist.*

**The wire had the same defect as the residency, and nobody looked, review-32,
2026-08-19.** `Cycler` believed only `DATCPOK` when deciding what the device holds, and
then sent `SPEED` and `MODE` regardless of it. So a commit answered `ERROR` or `TIMEOUT`
switched the panel to a store the same `DATS` had just zeroed, and reported a normal
press with a cost of one save. It is the defect track 32 was written to fix, fixed in
`app/src/deliver.ts` and left standing twenty lines away in `core/src/playlist.ts`,
which the same track owned. Two things let it survive: the test for this case asserted
residency and cost but never the log, and `StepResult` had no field that could carry the
answer, so `App.tsx` said *"On the glasses"* for a press that changed nothing. Both are
fixed: `MODE` now goes out only on `skipped || committed`, and `StepResult.showing`
carries it, because `cost` cannot - a rejected commit costs a full save and shows
nothing.

## Why type 2 is not used for cycling

Type 2 would show a static 24-col frame atomically (no sweep) with no flash, but
`session.save()` charges it to the flash budget today, and its own docblock defers
relaxing that to whoever owns this feature. The live route costs nothing, dodges the
question, and dodges the "MODE is a one-way door away from type 2" trap entirely.
Revisit only if the sweep looks bad on hardware; the fix is a separate non-flash meter
in `budget.ts`, not an exemption.

## What was built

`core/src/playlist.ts`, and its own docblock is where the detail lives.

- `Entry {label, bitmap, motion, gap?}` plus `textEntry`, `imageEntry`, `loopEntry`.
  Every one passes `gap: 0` into `content.text`, so the gap lives in one place.
  *Corrected: this said `content.text`'s own default would otherwise be a second gap on
  top. It is `content.SCROLL_GAP`, which is 0, so passing 0 changes nothing today; what
  `content.text` does add unconditionally is padding to a full panel width, which is why
  a 3-letter scroller is a 24-column reel member and `Reel.offsets` counts it.*
- `check()` returns sentences: count bounds, the panel width for statics, the type 1
  ceiling for the reel, `SPEED` range, **members that disagree on speed or direction**,
  which one `SPEED` and one `MODE` cannot honour, and **a mode that is neither `reel` nor
  `individual`** (review-18: every rule in `check` is per mode, so an unrecognised one
  reported nothing wrong and then crashed three frames into `compile`).
- `compile()` gives `steps` plus at most one `Reel`, whose `hash` is
  `budget.fingerprint(dats.encodeBitmap(bitmap), TYPE_TEXT)`: the exact bytes
  `session.save()` will send, so residency is a string comparison against the ledger.
- `Cycler` over a structural `Driver` slice of `Glasses` (`begin`/`show`/`command`/
  `save`), with `costOf`, `costs()` and `upcoming` so a UI states the cost before the
  press. A `BudgetError` propagates and the index does not move; nothing retries.
- `cli/src/playlist.ts`: `preview` needs no device, `run --yes` cycles on n/p/space.
  Standalone, not wired into `cli/src/index.ts`. `bun run playlist`.

*Corrected: the design sketch said `compile()` returns one step per entry. It does not
in `reel` mode, and could not usefully: every scroller shares the one reel, so a press
per scroller would be identical on the wire and on the panel. They collapse into a
single step where the first scroller sat, and `individual` mode is where one press means
one scroller.*

*Also corrected, in `mock-transport.ts` rather than here: `opcodeOf` splits on the first
non-uppercase byte, so it reads `SPEED 70` as the opcode `SPEEDF` (70 is `F`). It is
fine for the opcodes the existing tests assert and wrong for `SPEED` at 65-90;
`playlist.test.ts` matches against a known opcode list instead. Nothing was changed in
`mock-transport.ts`.*

## What the first run settles

Nothing here has run on hardware, and the wire it builds is `session.ts`'s, which has.
What one `bun run playlist run --yes` session decides, in order of what would be most
surprising:

1. That the reel reads as separate items rather than one long string. The 24-column gap
   between members is a guess at what looks like a break (*unverified*). **Look at the
   wrap as well as the joins**: the last member carries the same gap, and the device
   brackets the record with its own 24, so the break before the first member should look
   about twice the others. If it does, the bracket is there in the saving session and
   `REEL_GAP` on the final member can go; if the two look the same, it is not, and
   dropping it would have run the last member into the first.
2. That a press from a scrolling step back to a static one reads as a switch rather than
   a flicker. It is `SMVEW 01` then 24 paced column writes, so the panel sweeps left to
   right over about half a second (*derived* from the pacing, never watched).
3. That `MODE 02` picks up the reel just saved, without a power cycle. A 32-column block
   looped seamlessly in the saving session on 2026-08-10 (*verified*), but that was one
   save and one `MODE`, not a save with `SPEED` in between.
4. That `SPEED` before `MODE` is the order that takes effect. Copied from the vendor log
   (*derived*).

Not settled and not this track's: whether the blank bracket joins the loop always or only
after a power cycle (track 16), and everything on `notes/app-plan.md`'s "Verify before
building" list.

*Corrected: this called it "the 48-column bracket" rejoining the loop. The record does
hold 48, 24 blank columns each side of the content, but a scroll resuming at the content
walks only the trailing set, so what a loop meets is 24, one screen width. Measured by
eye 2026-08-11 against a payload verified off the app's wire log:
`research/loop-gap-2026-08-10.md`.*

## The firmware version this is shaped for (blocked on SWD delivery)

Entries map 1:1 to page-aligned slots in the 76.8 KB staging bank; the reel concept
disappears since the device can hold all 10 scrollers. Select is a `J` sub-command in the
`0x20` family, and the button hook at the press latch advances an index in RAM and
repoints the display's content pointers (the read side already scales, u16 ncols), so
**a press writes no flash**; the index resets to item 1 at power-on by design. Slot
upload rewrites only that slot's pages. Any OTA wipes the bank, so playlists re-upload
after a flash. Never touch the 2 s long-press power-off. Detail:
`research/firmware-internals.md` "Content in the staging bank" and the button section;
the sub-command framing is `notes/firmware-design.md`.

`Cycler` is the seam that survives that change: `Driver` is four methods, and the
firmware version replaces what they send without moving `Entry`, `check` or `compile`.

## State

Done: the design above, `core/src/playlist.ts` (+ 43 tests), `cli/src/playlist.ts`, the
barrel export and `bun run playlist`. Track 18's board row went to the orchestrating
session, which owns `notes/parallel-tracks.md`. Reviewed 2026-08-11 (review-18): two
defects fixed, both above, and the tests went 41 -> 43.

Still open, and it needs a file neither track 18 nor its review owned: the DATS type on
`budget.SaveRecord` (above). *Corrected: this also listed the "Reserved seams: playlist"
pointer in `notes/firmware-design.md` as not done. The orchestrating session landed it on
2026-08-11, as its own section plus a v2 roadmap row naming the playlist advance.*
