# Phone app plan

**This file is judgement, not findings.** The facts it leans on are in `notes/protocol.md`,
`research/vendor-app-protocol.md` and `research/firmware-internals.md`, each with its own
confidence marker. Nothing here is verified by anything except argument.

**What the app is:** one phone, one pair, three things you can put on the glasses. Static
text, scrolling text, and a canvas you draw on with your finger that appears on the panel
as you draw. Everything in `notes/what-to-build.md` is downstream of these three.

**Governing constraint: this app must be incapable of bricking a unit.** Not "careful
with", not "guarded against". It never links the OTA code at all. See "Safety", which is
the part worth reading twice.

**This file is reasoning, not reference.** Every module in `packages/core/src` carries its
own docblock and that is where the detail lives; what is here is why, what was tried and
rejected, and what turned out wrong.

## Flash wear: what actually costs a cycle

Asked because the vendor app has a live draw mode, and the answer decides the whole shape
of the app. **Live drawing writes no flash at all.** Only one action does.

| Action | Flash | Where the bytes live |
| --- | --- | --- |
| Live column write on `960b` | **none** | live buffer in SRAM at `0x200036ac`, straight out to the panel's UART |
| `CLRL` (atomic clear) | **none** | same buffer |
| `SMVEW 02` "save" | **none** (*derived*) | copies the 24 live columns to SRAM `0x200030ac`. Survives a disconnect, not a power cycle |
| `DATS` announce, and every streamed block on `960a` | **none** | staged in the 1,536-byte SRAM buffer at `0x200030ac` |
| **`DATCP`** | **5 page erases plus reprogram** | flushes SRAM to `abs 0x3c000`, and the 8-byte record at `abs 0x3c800` |
| An OTA | destroys saved content | not a path this app has |

*derived* from `abs 0x218cc`, which holds **five hardcoded 512-byte page erases**, and from
the staging buffer's address being confirmed by adjacency to the live buffer.

### How much headroom is there

Endurance for this part is *unverified* and there is no way to read a cycle count off the
device, so we are designing against an unknown with no feedback. Embedded flash of this
class is typically 10,000 to 100,000 cycles. The arithmetic at the pessimistic end:

| Save rate | Time to 10,000 cycles |
| --- | --- |
| 20 per day, heavy human use | 500 days |
| 1 per minute, an impatient session | 7 days of continuous saving |
| **1 per second, a loop** | **under 3 hours** |
| **60 per second, an unpaced retry** | **under 3 minutes** |

Human-driven saving is a non-issue by three orders of magnitude. **The only realistic way
to damage a unit is an automated loop**, and the gap between those rows is why this gets
enforcement in code rather than a note asking people to be careful.

**We already run one such loop.** `packages/cli/src/uploadbench.ts` uploads at six pacing
values per invocation, so **every bench run is 6 saves, 30 page erases**, and the
bisection that established the 740-column ceiling ran it repeatedly. Estimating from what
`research/vendor-app-protocol.md` records, that is roughly 50 to 90 saves on unit 2 in one
evening: about 1% of a pessimistic 10,000-cycle budget, so no meaningful harm. It is the
shape of the problem rather than the problem, it happened without anyone counting, and
there is no way to read the counter back. The unit also did not arrive at zero, since the
vendor app writes the same five pages on every save it makes.

**Wearing this region out is not a brick.** The five pages are saved content at
`abs 0x3c000` and the record at `0x3c800`, nowhere near the application at `0x16800` or
the bootloader at `0x3dc00`. Worn out, the device still boots, still runs built-in modes
and still does live draw; what fails is persistence, presumably as `ERROR` or corrupt
content. So this guard protects a **feature**, and the `fd00` rule protects the **unit**.
Do not let the two blur: they deserve different amounts of alarm.

### The choke point

One caller (`session.save()`), one guard, and `choke-point.test.ts` fails the build if a
second caller of `datsComplete` appears. `budget.ts` `LIMITS` is the specification for the
rules. The two things about them that the code cannot say:

**It throws rather than queues**, because a queue turns a runaway into a slower runaway
and hides the bug that caused it. And the numbers are chosen to sit **far above any human
pattern and far below any loop**: a person saving a message every few seconds for a whole
minute is fine, and a render loop hits the interval rule on its second iteration and dies
loudly.

### What could cause a runaway

Ranked by how likely each is to happen here, which is not the same as how obvious it is.

| Cause | Why it bites |
| --- | --- |
| **React StrictMode double-invokes effects in dev** | a save in an effect fires **twice** on every mount. Built into the framework, silent, and the first thing to hit if save is ever wired to an effect. **This is no longer hypothetical**: on the first hardware run, `probe()` in a `useEffect` with a `[glasses]` dependency fired twice, five seconds apart, and only the wire log showed it. A dependency array does not prevent it; a latch outside React's lifecycle does. Had that been `save()` it would have been ten page erases for one tap |
| **`useEffect` with an unstable dependency** | a `Content` object rebuilt each render never compares equal, so the effect runs every render. The classic React bug, and here it writes flash |
| **Fast Refresh re-running module code** | editing a file remounts the tree. Combined with either row above, that is a save per keystroke *in the editor* |
| **Retry on `ERROR` without a ceiling** | `ERROR` is a legitimate reply to an over-long payload, so a naive retry loop retries forever at full speed |
| **Reconnect handler that "restores state"** | reconnecting after a drop and re-uploading feels correct and turns a flaky link into a save loop |
| **Autosave or draft sync** | ordinary app design, catastrophic here. There is no autosave in this app, ever |
| **A slider or text field wired to `onChange`** | brightness on change is free; save on change is not. Save is `onCommit` only, never `onChange` |
| **Tests pointed at real hardware** | a suite that saves in `beforeEach` runs hundreds of times a day. Automated tests use the mock transport, always |
| **Our own bench and sweep scripts** | already happened. See above |

The pattern across all of these: **flash gets written by code nobody thought was about
saving.** Which is exactly why the enforcement is a choke point plus a rate limit, and not
a code review habit.

### Visibility

We cannot read the device's cycle count, so the app has to keep the ledger. It is cheap
and it is the only number we will ever have.

- **A per-device ledger in local storage**, keyed by MAC: lifetime saves, first and last
  timestamps, and a rolling 24-hour count. Survives app restarts, which is the point.
- **The About screen shows it plainly** for the connected unit: "1,284 saves since 12
  Aug". Not buried in a debug menu. It is the number that tells us whether any of this
  reasoning was right.
- **A save log of the last 50**, each with a timestamp, column count and payload hash. A
  runaway is then diagnosable after the fact instead of being a mystery, and duplicate
  hashes in a row are the signature of exactly the bugs listed above.
- **A loud dev-build banner** when two saves land inside the minimum interval, in addition
  to the throw. In development the interesting failure is one that got caught.
- **The CLI prints its cost before spending it.** `uploadbench` announces "this run
  performs 6 saves, 30 page erases on GLASSES-xxxx" and needs a flag to proceed.
- **Ledger export**, so the count follows a device rather than a phone. One JSON file.

### What that means for the UI

- **"Show now" and "Save to glasses" are different buttons** and the difference is
  visible without reading this document. Show now is free, instant, and gone at power off.
  Save persists with the radio off and takes a few seconds.
- **Live draw never saves.** Drawing is unlimited because it is RAM and UART only. The
  canvas gets a separate, deliberate "Save this drawing" action.
- **Cancel is genuinely free.** No flash is touched until `DATCP`, so a cancelled upload
  costs nothing and the UI can say so.

#### Built, 2026-08-11

All three, in `src/screens/Connected.tsx` over `src/deliver.ts`: the free path is Show now
through `LiveSender`, the flash path is Save to glasses through `deliver()`, and each
button carries `deliver.costOf()`'s own sentence rather than a label. Cancel is a
`SaveOpts.cancel` callback asked before every block and once more before `DATCP`, so it is
free in fact and not only in principle. The save log is `ledger-shape.ts`'s `saveLog()`
over the `recent` array the budget already kept.

Two things these bullets did not anticipate, both now in the UI:

- **Grey is a question, not a refusal.** `deliver.greyChoice()` costs both answers, because
  `savedType()` otherwise lets one dim pixel decide whether a save survives a power cycle,
  and flattening returns dim pixels at *full* brightness rather than dim ones.
- **A save discards the live buffer**, including a drawing the Draw screen left on the
  panel. Which of the two the panel is showing is `App.tsx`'s state, because Compose
  unmounts on the trip to Draw, and Compose warns once before the first `MODE` that would
  throw one away.

**None of it has been seen on a handset or a panel**: no unit was advertising on the
evening it was built, so every claim above is the wire under `bun test` plus the code.

## The two delivery routes, and everything follows from them

Every feature in this app is a choice between these. The whole content model exists to
make that choice explicit rather than accidental.

| | **Live** | **Saved** |
| --- | --- | --- |
| Channel | `960b`, per column | `960a` stream, then `DATCP` |
| Format | 3 bytes/col, 2 bits/px, **4 grey levels** | 2 bytes/col, 1 bit/px (type 1) |
| Width | **24 columns**, the panel | **740 columns** (*verified*, 745 returns `ERROR`) |
| Persists | until power cycle, at best | yes, with nothing connected |
| Needs a connection | yes, continuously | only during upload |
| Flash | none | 5 pages per `DATCP` |
| Latency | one write, ~7 to 20 ms | 1.1 to 5.0 s of transfer for 700 columns |
| Motion | anything, but full-frame changes sweep | **translation only, but two-axis** (see below) |
| Enter with | `SMVEW 01` | nothing, DATS does not need DIY |

**The Saved column is DATS type 1 throughout.** Type 2, the greyscale encoding, is a
third route wearing the second one's clothes: same channel and handshake, but **24
usable columns**, no flash and **no persistence past a power cycle**. Its Persists and
Flash rows read the same as Live's. *verified* 2026-08-09,
`research/vendor-app-protocol.md`. *Corrected: this said 383 columns, which is what the
device accepts rather than what it displays, and was marked derived before verify item 4
ran.*

**Size the progress bar from transfer, not from the cycle.** At 700 columns the measured
numbers are 4984 ms of transfer at the vendor's 50 ms pacing and 1081 ms at 6 ms; the
often-quoted 5.9 s and 2.0 s are connect-to-disconnect, which includes ~900 ms of
connection setup the bar should show as its own step. *verified*,
`research/vendor-app-protocol.md`.

***Corrected 2026-08-12, by the sitting.* This row read "horizontal translation only"
and that was too narrow.** On power-up with nothing connected, the device restored its
saved word and played it **bouncing up and down while travelling left**, which is
`MODE 03`: the vertical bounce, whose second byte is a direction, so it bounces *and*
travels (*verified* by eye, `research/vendor-app-protocol.md`, "The sitting"). So the
saved route gets two-axis motion for the same zero flash and zero radio, and **the app
exposes only `MODE 02`**. What stays true is that the device translates a buffer rather
than paging through frames, so "no frame-flip animation of our own content on stock"
still holds and is the thing that actually needs firmware.

**The sweep is the live route's defining limit and it is not fixable.** Each column write
pushes a whole frame to the display module, so a full-panel change shows 24 successive
frames and visibly wipes left to right. It is transmission-bound, *verified* by measuring
time-to-fill against pacing, and pacing below ~6.5 ms buys nothing because one frame takes
6.42 ms on the module's UART.

**But a sparse change is proportionally cheap, and that is exactly what drawing is.**
Touching one pixel changes one column: one 16-byte write, one frame time. The live route
is the worst possible way to play a video and the best possible way to run a paint app.

## The three features, mapped onto the routes

| Feature | Route | Why |
| --- | --- | --- |
| **Static text**, fits in 24 cols | either | live for instant preview, saved so it survives the walk home |
| **Scrolling text**, up to 740 cols | **saved** | the device scrolls it unattended with the radio off. This is the headline |
| **Live draw** | **live** | one write per touched column, no flash, instant |
| **Save a drawing** | saved, DATS **type 2** | 24 cols x 3 bytes = exactly 72 bytes, which is the vendor's own case |

### What "animation" can and cannot mean on stock firmware

Worth being blunt, because the word covers three very different things and only one of
them is free.

| Kind | How | Cost |
| --- | --- | --- |
| **Scrolling / marquee** | upload wide, `MODE 02 <dir>`, `SPEED n` | free, unattended, radio off. **Only horizontal translation** |
| **Built-in effects** | `ANIM 20-29`, `IMAG 0-10` | free, unattended, but they are the vendor's, not ours |
| **Host-driven frames** | render on the phone, stream deltas live | arbitrary motion, but sweeps if much changes, and needs the connection held |

**There is no frame-flip animation of our own content on stock.** `MODE` scrolls the saved
buffer, it does not page through frames, so an N-frame animation cannot be uploaded and
left to play. That capability is the firmware track, not this app.

The honest framing for the UI: a scrolling message is something you send and walk away
from; a drawn animation is something that plays while your phone is out and connected.

## Architecture

### One sequencer, two transports

`core/src/transport.ts` is the boundary and its docblock carries the reason for the split.
What the code cannot state is the design that was rejected:

**Two interfaces, not one, and this was the part of the extraction that was real design
work rather than moving code.** `Glasses.open()` fused scan, connect and subscribe into
one static; `findGlasses()` resolved the *first* advert that matched a prefix and threw
the rest away; `Glasses.name` read `peripheral.advertisement.localName` straight off a
noble object. A Scan screen needs all three pulled apart: a `Scanner` the app drives, and
`Glasses.attach(transport, name)` taking a connection that is already open. The name has
to arrive as an argument because `Options.cipher` can be a function of it.

### What has already landed

Prep done on 2026-08-09, before any app code. All of it names a file that exists now, so
the changelog is gone; one row survives because it records a mistake.

| Change | Why it could not wait |
| --- | --- |
| `uploadbench.ts` enforces 740 columns and prints its flash cost | it defaulted to 768, which the device rejects, and it is the loop from "Our own bench and sweep scripts" |

### Phase 0, landed 2026-08-09

The extraction and the flash guard, laptop-side.

**The one piece no mock covers is `packages/cli/src/noble.ts`**, and its trap is that
noble's second write argument is `withoutResponse`, the inverse of `Transport.write`.
Getting that backwards is silent: writes still land, just unacked, and the last column of
a frame goes missing on disconnect. **So run `bun cli text` and look at the last column.**

The extraction's regression gate was a mock run of the exact `cmd text` sequence and not
hardware, so "`bun cli text` still works" is *derived*: `SMVEW 01`, `LEDON`, 24 column
writes with only the last acked, `STYPE` flush, disconnect, identical to before. `Glasses`
has since driven real hardware through this adapter (track 5's `type2.ts`, 2026-08-09),
which exercised the DATS path rather than those 24 live writes, so the last-column check
still stands.

### Phase 1, landed 2026-08-09: the phone writes flash

Increment 1's headline. Scan, connect, probe, compose, save, scroll, brightness, all on
`GLASSES-125B37`. *verified* on hardware, and this is the transcript the wire log gave
back, decrypted:

    > DATS 01 0066     announce type 1, 102 bytes
    < DATSOK
    > 960a x7          15+15+15+15+15+15+12 = 102, so the announce matched the stream
    > DATCP
    < DATCPOK
    > SPEED 50
    > MODE 02 00       horizontal, direction 0

**The panel itself is still unwatched.** Verify item 3 asked for `MODE 02 <dir>` on our
own content in both directions; direction 0 has been *sent* and acknowledged, and nobody
has yet looked at the glasses to see it move. Item 5, `MODE 02` on content narrower than
the panel, is untouched by this: `content.text` pads every upload to at least 24 columns,
so the case has been hedged rather than answered.

**A trap for anyone reading frames back**: `opcodeOf` mis-splits any frame whose first
argument byte is an uppercase letter, so tests match against a known opcode list instead.
The rule is in `core/src/mock-transport.ts`.

#### The preview is a simulation, and that took three goes

Reported as "speeds up and slows down", then "still not smooth, slight delays", then
"slow scrolls faster than fast". Three separate causes, and only the first was the one
originally guessed at. All three are written up where they were fixed:
`packages/app/src/clock.ts` for the timing pair, `Preview.tsx` for the render cost, and
`core/src/protocol.ts` for the device's real rate. Both timing failures are tests.
*Corrected 2026-08-11: the rate pointer said `packages/app/src/speed.ts`. The ladder moved
to `protocol.ts` beside `protocol.speed()` so the CLI shares it; `speed.ts` now holds only
the three presets and re-exports.*

### The content model

One representation, two encoders, in `core/src/content.ts`. The UI consequence, which is
the part the encoders cannot state: **greyscale survives the live route and DATS type 2,
and DATS type 1 flattens it to 1 bit**, so say so when a drawing with grey levels is
saved as text.

#### Built, 2026-08-09

**Type 2's ceiling was wrong three times, and each wrong number had its own reason.**
**493** came from dividing type 1's measured 1480-byte budget by three bytes a column, and
that budget was only ever measured at type 1's stride. **383** is the real accept ceiling,
since the device buffers an image column as a 32-bit word and wraps at 384: right about
`DATCP` and wrong about the panel. **24** is what actually displays, and is therefore what
content is sized against. `content.maxColumns(type)` gives 740 / 24, and
`content.IMAGE_ACCEPT_CEILING` is the 383.

### The connection state machine

Two device-side modes that are mutually destructive, which is the single most common way
to lose work on this hardware.

    Disconnected -> Connected -> DIY (live draw)     via SMVEW 01
                              -> Playing (saved)     via MODE

- **Any `MODE` command while in DIY discards the live buffer.** Every early test did this
  and threw the drawing away.
- **`SMVEW 00` restores the saved image**, which looks exactly like stray pixels appearing
  from nowhere. Default to staying in DIY.
- **`SMVEW 02` clobbers the SRAM copy of saved content** at `0x200030ac`, the same buffer
  DATS stages into. The flash copy is untouched and returns on reboot.

The app models this explicitly and warns once before a transition that discards. It does
not try to be clever about restoring, because it cannot.

### The coalescing live sender

Built as `packages/core/src/sender.ts`, whose docblock has the failure mode it exists to
avoid and the two places it departs from the design sketched here. What does not belong
in code is why an option nobody has needed is still there:

`clear({ atomic: false })` writes 24 blank columns instead of `CLRL` and exists as a
hedge, but the hedge is probably unnecessary: **`SMVEW 01` clears by branching into the
middle of the `CLRL` handler**, so the two are the same instructions and we already run
them at the start of every live session (*verified* at byte level while building this,
written up in `research/firmware-internals.md`). What remains untested is `CLRL` alone,
mid-session, with the engine already stopped. Delete the option once someone has watched
that happen.

### The draw canvas

- **Render the dead pixels as unavailable**: the middle 6 of the top row, and the
  nose-bridge notch. Users must not be able to paint into the void and wonder why it did
  not show. Mark the rows 2 to 7 band too, because anything outside it gets chewed
  passing the bridge. `display.alive()` is the only source for both, so neither can drift.
- Brush levels 0 to 3, but **the steps are subtle** (*verified*: six-column bands were not
  separable, wider bands with dark separators were). Present grey as shading, not as four
  distinct colours, and do not build a feature that needs the user to read a level at a
  glance.

#### Built and drawn on, 2026-08-09

**A finger has been on it, and the wire log says so.** *Corrected: this section said the
screen had never been rendered, which was true for about half an hour.*
`packages/app/.expo/dev/logs/start.log` decodes with the vendor key as one clean
session: `SMVEW 01` and `LEDON` **once** - so `begin()` did not double-fire the way
`probe()` once did - then **210 live column writes over 48.7 seconds**, then `CLRL`
alone, then the probe that belongs to the Compose screen. No `MODE` while in DIY, so
nothing discarded the drawing under the person drawing it.

Two things in that are evidence about this code rather than about the link:

- **21 of the 24 columns and all 9 rows were written.** A hit test that had gone wrong
  the way `pointerEvents` goes wrong resolves every touch to cell 0, so the spread is
  what says the touch coordinates are the pad's and not a child pixel's.
- **4.3 writes per second**, two orders off the pacing floor, so the coalescing was
  never under load. A fast scribble is still untested against real timing.

**What it does not prove is the panel.** Nobody has said what appeared, so whether row 8
of the pad is the top row of the glasses, whether the three greys separate, and whether
`CLRL` blanked anything are all still unwitnessed. The wire is checked below it: 25
tests over the hit test, the stroke interpolation and the columns that reach the wire,
plus `tsc` and an `expo export` that proves Metro resolves the `.tsx` files.

**Not built, and not in this track's contract: saving a drawing.** Type 2 is 24 columns
and does not persist, so "save this drawing" is a decision about what the button
promises rather than an encoder change.

*Decided, 2026-08-11, by track 17: the button promises the phone, not the glasses.*
`packages/app/src/library.ts` keeps drawings and text presets in `library.json`, and Load
replays a drawing through the live columns. The device was never a candidate. A type 2
save would show a 24-column drawing whole and with its greys, but track 5 settled that it
dies at power-off and that any later `MODE` discards it for good, and there is one buffer
per type, so the glasses can hold exactly one drawing until they are switched off. Type 1
is the one that lasts and it flattens the grey a drawing is mostly made of. The increment
2 row below, "save drawing as type 2", therefore describes a save that keeps nothing.

## Scope, by increment

Increments 1 and 2 have shipped, on and before 2026-08-11. The architecture above was
designed for all three, so 3 adds screens rather than rework.

| # | Ships | New work |
| --- | --- | --- |
| **1** | scan, connect, type text, save, scroll, brightness | scanner and transport split, ble-plx adapter, DATS path, **flash budget guard and ledger** |
| **2** | live draw, clear, show-now, save drawing as type 2 | canvas UI, DIY state machine (the coalescing sender is built) |
| **3** | wide scrolling composer, presets, built-in banks | wide-bitmap editor, `ANIM`/`IMAG` browser |

Four screens at increment 2: **Scan**, **Compose** (text), **Draw** (canvas), **Playing**
(what is on the device, direction, speed, brightness, disconnect).

**Android first, deliberately.** Sideloading an APK is minutes; iOS needs provisioning and
a free Apple account gives 7-day builds that expire. Increments 1 and 2 ran on a Pixel and
iOS is untouched, which is the trade taken on purpose.

## The redesign, 2026-08-11

Track 26, single-instance. The intake is the second feedback table in
`notes/what-to-build.md`; the verdict driving it is "its almost like the whole app needs
a redesign". Everything above this section still holds underneath: the routes, the
budget, the safety rules. What changes is the shape a person meets.

**The governing scenario is a festival, not a desk.** Jacob, mid-redesign: "think they
will be used at a festival where ease of use when i am out using them i really
important". So the design target is a dark field, one hand, a few seconds of attention:
big touch targets, one tap from opening the app to something on the glasses, the
remembered pair reconnected without ceremony, and defaults already applied. Anything
that only matters at a desk (tuning an effect, reading the wear log) may cost more taps.

**The organising decision: the library is the front door.** The app opens on everything
showable, mine and the built-ins, each with a thumbnail, and one tap shows it. Creating
anything is a detour that ends back in the library. Before this the app opened on the
protocol: a compose form whose controls were the wire's parameters (Motion, Direction,
Speed, Ink, Panel) and whose captions were the research's own doubts.

**Every pair is its own thing on this phone.** Three per-pair facts, all keyed on the
advert name the ledger already uses: a nickname (built, track 10), an accent colour
that recolours the whole app while that pair is connected, so a glance says which pair
you are driving, and what that pair is holding, which is the residency model below
applied per device. Deleting is a first-class action on every library item, not a
privilege of drawings.

**Navigation is three tabs, not headers.**

| Tab | What it is | Needs a pair? |
| --- | --- | --- |
| **Library** | the front door: my saved things, then the built-ins. One tap shows one | only to show |
| **Create** | Message, Draw or Effect. Each ends in Show plus Keep (save to the library) | only to show |
| **Glasses** | find and connect, brightness, what the panel is doing, wear, disconnect | is the pair |

Library and Create browse, compose, draw and save with nothing connected, because a
library you cannot look at without hardware is not a library (review 17's lesson,
promoted to the whole app).

**One tap, and what a tap may cost.** The routing is a pure planner, not screen logic:

- A free tap just goes. Built-ins are one command; a static that fits the panel goes
  live; content already resident in flash returns with `SPEED` then `MODE` and no save.
- A tap that writes flash also just goes. *Corrected 2026-08-12, by Jacob's ruling on
  the handset: this said a flash tap opens a cost sheet, keeping the repo's law that
  cost is stated before it is spent. That law was written against the runaway table in
  "Flash wear", and the same table says human taps never matter: 500 days at 20 saves a
  day, pessimistically. The ceremony was the cost. The budget guard stays in code,
  where the actual risk (loops) lives; the UI neither asks nor prices, and the wear
  numbers live on the Glasses tab for whoever wants them.*
- Cancel stays free to the last block inside `deliver()`, but with no sheet there is
  no cancel affordance in normal use, deliberately: an upload is seconds long.

**Residency: the device remembers one saved thing, and the app now says so.** The
ledger's last acknowledged type 1 record (the same `residentHash` reading the playlist
uses) drives an "on the glasses" badge in the library, and drives the router above: a
tap on the resident item is free and says so. This answers, in the UI, the question
Jacob asked in words: save an animation, show something else, and the animation is
still in flash; one free command returns to it; only saving something different evicts
it, and re-sending the identical thing is skipped free.

**Defaults persist.** A third phone store, `settings.json`, same temp-and-rename policy
as the other two: panel brightness, scroll speed, and nothing else until something
earns its place. Brightness is applied once on connect, so "why do I have to select
panel setting each time" stops being true.

**The copy budget.** A control's caption is a few words. The one full sentence appears
on the step that spends flash, and nowhere else. The research's epistemics never reach
the screen: uncertainty is phrased as behaviour ("Right to left repeats cleanly; left
to right shows a gap"), never as provenance ("unconfirmed", seam numbers, hash lines).
The provenance stays in `research/` where it belongs. The wear count moves to the
Glasses tab, small, with the save log behind a tap.

**Direction: default to the one that hides the dead space.** Watched by eye 2026-08-11
and written down correctly on the third try (`notes/what-to-build.md`, second table):
both directions carry the store's blank bracket as a dead pass, and direction only
decides where in the pass it falls. So the default is the direction that puts the dead
space at the end of a pass rather than the start, the other is offered as behaviour
("the pause comes first"), and no epistemic caption. Removing the dead space entirely
is firmware work, not app work.

**What stays the same underneath, deliberately.** `deliver()` remains the only route to
the wire for content and `wiring.test.ts`'s invariant survives the move; the budget
choke point is untouched; browsing still writes no flash; Draw still never sends
`MODE`; the discard warning still fires once before the first save that throws away a
live panel. The redesign is screens plus a few small pure modules (settings, the tap
planner, residency), not a protocol change.

**What this redesign cannot fix, and who does.** "Animations seem buggy" needs eyes on
the panel: no effect has ever been watched, the `ANIM` numbering is disputed, and the
loop bracket's open half is track 16's two looks. All of that is the hardware sitting,
which single-instance mode schedules with Jacob watching.

### Built, 2026-08-12

All of the above landed in one pass, plus three rulings from `notes/library.md` that
arrived mid-build and were folded in rather than queued: text picks its own motion
with the 24-column price boundary shown while typing, the effects width control was
deleted (loops render at the ceiling; duration is the label), and no 9-row scrolling
font. The mid-session asks landed too: per-pair accent themes, delete on every
library item, per-pair residency ("holding" on the Glasses tab and the badge in the
library), and auto-reconnect to the remembered pair.

State and file-by-file detail: `.claude/locks/track-26`. Suite 720 green, `tsc`
clean, `expo export` bundles. **Nothing has been seen on a handset**: every claim is
the wire under bun plus the code, which by this repo's own convention means the
looking is still owed, and it is the first item of the sitting.

## The stack decision

**React Native via Expo with a custom dev client, plus `react-native-ble-plx`.** One
codebase for both platforms, and the only option that reuses `packages/core` unchanged.

| Option | Verdict |
| --- | --- |
| **Expo dev client + `react-native-ble-plx`** | **chosen.** JS, so `packages/core` imports as-is. Config plugin writes both platforms' permissions |
| Bare RN CLI + `react-native-ble-plx` | same runtime, more setup by hand. Fall back only if the Expo plugin fights us |
| Flutter + `flutter_blue_plus` | rejected. Ports AES, DATS and the font to Dart, which is exactly what we do not want twice |
| Capacitor / Web Bluetooth | rejected. iOS has no Web Bluetooth in WKWebView |
| Two native apps | rejected. Double the work for a hobby controller |

`packages/core` was already written for this: `aes.ts` implements AES-128-ECB by hand with
the comment "React Native ships no crypto at all", and the package has zero dependencies
and no `Buffer` or `node:` imports anywhere. *verified*, and now enforced rather than
grepped: `safe-surface.test.ts` fails the build if anything the barrel reaches imports
Node. That assertion is load-bearing for this whole row of the table.

**Expo Go will not work.** BLE is native, so it needs a dev build on the device from day
one. Budget for that; it is the most likely thing to eat a day.

## Safety: where to be careful

Ranked by what it costs when you get it wrong. The first is a dead unit.

### 1. The app must never speak to `fd00`. Design it out, do not guard it

`GLASSES-12C3EF` was bricked on 2026-08-08 by an OTA commit of the **stock image over
stock**, which the device's own CRC verified before it reset itself and never came back.
**It was repaired on 2026-08-20** over SWD: `research/aprom-write-2026-08-20.md`.
The payload cannot have been at fault. The handoff into LDROM is. Full postmortem:
`research/brick-2026-08-08.md`.

Three layers, so that no single mistake reaches the radio. **The first and third are
done**, before the app exists, because they were cheap and because the barrel made the
first one impossible as originally written:

- **`ota` and `dfu` are out of the `@joggles/core` barrel** and live behind
  `packages/core/src/firmware.js`. *This was necessary, not tidying:* `index.ts` re-exported
  both, so "do not import them into `packages/app`" was unenforceable while importing
  `@joggles/core` at all pulled them in. `flash.ts` and `ota-check.ts` now import the
  firmware entry explicitly, which is the only place that decision is made.
- **Allowlist in the transport adapter.** A frozen set of four characteristic UUIDs
  (`9600`, `9601`, `960a`, `960b`), throwing on anything else, at the one place every byte
  passes through. Not a check at each call site. Increment 1 needs only three of them:
  `960b` earns its place when live draw lands.
- **A test that fails the build**: `packages/core/src/safe-surface.test.ts` crawls relative
  imports out from the barrel and asserts no reachable module is `ota.ts`/`dfu.ts`, names
  an `fd00`/`fd01`/`fd02` literal, or imports Node. It crawls rather than reading the
  export list because the risk is a transitive import three modules down.
  *`protocol.ts` used to declare `SERVICE_OTA` and has been stripped of it; `dfu.ts`
  already had the same constant, so nothing was lost.*

Nothing in this app needs firmware. Stock units do all three features, so this costs zero.

### 2. `DATCP` is a flash write. One caller, rate limited, counted

**It is the second-worst thing this app can do to a unit and the only one it does on
purpose**, so it ships with enforcement rather than intent. Reasoning, numbers and the
runaway causes are in "Flash wear" at the top of this file; the rules themselves are
`budget.ts` `LIMITS`, `session.save()` and `choke-point.test.ts`.

Acceptance criteria for the increment that first sends `DATCP`. All ticked, and the list
has moved into `budget.ts` except for the two entries that record something it cannot:

- [x] *Corrected: this list used to say the guard "throws on identical payload", which
      contradicted its own rate table. A duplicate **skips**, because writing flash to
      store what is already stored is the thing worth avoiding, and the rate rules are
      the specification*
- [x] the per-device ledger persists and the About screen shows the lifetime count, on
      the Compose screen rather than behind a menu. *verified*: one save from the phone,
      `{"lifetime":1,...,"ok":true}` read back off the handset

Everything else the app does, including the whole of live draw, writes no flash at all.

### 3. The DATS row mapping was wrong in `dats.ts`. Fixed, and still needs one upload

**Done in code**, and the mapping table is `dats.ts`. `encodeBitmap` used to map row `r`
to bit `r` for rows 0 to 6 and to bit `r+1` above, which is the 7+7 reading from
`notes/protocol.md`; `research/firmware-internals.md` corrects it from two independent
firmware paths.

Under the old mapping a 9-row bitmap drew **one row too high** and **silently discarded
rows 7 and 8**. It never bit us because every upload so far has been text, and the font is
five rows (`font.HEIGHT`), so the only symptom was a one-row offset nobody would question.
*Corrected: an earlier version of this file said seven-row text, which is the DATS format's
old imagined half rather than anything we have ever rendered.*

**It is still *derived*.** Two firmware paths agree and no hardware has confirmed it, so
the verify list keeps its place at number 1. If row 8 does not light, `dats.ts` and its
test are what change, and nothing built on top of them has to move.

### 4. The preview masks at panel coordinates, and the content scrolls through them

`display.alive()` maps physical holes: the middle 6 of the top row, the nose notch at rows
0 and 1. Those are **fixed panel positions**, so applying the mask to a 740-column bitmap
masks in content coordinates and draws a hole that travels with the glyph. The panel does
the opposite: content moves and the holes stay.

So the Compose preview is a 24-column viewport animating over the bitmap with `alive()`
applied to the window, not a mask over the whole thing. The draw canvas has no such
problem, because there the content genuinely is 24 columns and the coordinates coincide.

### 5. `protocol.ts` `scrollLeft`/`scrollRight` emitted the wrong command

**Done in code.** `scrollLeft(s)` built `MODE 03 s`, which is the **vertical** bounce, and
`scrollRight` built `MODE 04`, which the argument parser rejects outright.
`protocol.mode(kind, dir)` replaces both.

**The same table has more traps than that one.** The firmware handles exactly eleven
opcodes; the helpers transcribed from the vendor app's table are a much longer list, and
the extras reach no handler at all. They are grouped and labelled in `protocol.ts` rather
than deleted, because the decoders still have to name what the vendor app sends. **No UI
control may be built on one**: a Playing screen with an LED on/off toggle ships a dead
button, and `LEDOFF` in particular reads as "the panel should go dark" and does nothing.
The atomic clear is `CLRL`, now `protocol.clear()`.

### 6. Do not let the OS kill the app mid-handshake

Between `DATSOK` and `DATCPOK` the device holds an open upload. No flash is at risk, the
recovery path is *unverified*, and a reconnect means "assume nothing, re-upload". Keep the
screen awake for the few seconds a save takes.

**Do not send `DATCP` on teardown.** *Corrected: this file used to advise exactly that.* It
contradicts two of this document's own rules: `DATCP` is the flash write, so teardown would
spend a cycle to salvage nothing, and it would commit a truncated buffer over content the
user had already saved. It also puts a second caller on `datsComplete()`, which the choke
point forbids. Backgrounding mid-stream costs nothing; just disconnect.

### 7. Strobe safety, because this points at strangers

Keep full-field flashing out of roughly 5 to 30 Hz, or keep it low contrast.

**There is no strobe opcode to expose.** *Corrected: this item used to say `MODE 02 <rate>`,
"the flashing mode, 16-bit rate", stays unexposed. `MODE 02` is horizontal scroll, which is
the headline feature of increment 1, and the second byte is a direction, not a rate. The
mistake came from `protocol.modeFlash`, a name transcribed from the vendor app's table for
a command the firmware does not implement.* The `MODE` parser accepts 1, 2 and 3 and
nothing else.

The risk is therefore entirely in content **we** render and stream: a live-draw animation
loop alternating bright and dark full frames is a strobe built out of legal writes. So the
rule is on the sender, not on an opcode. The draw canvas has no animate-my-drawing button
until someone has thought about the rate limit.

### 8. Test against unit 2 only, and know what unit 2 is

*Corrected 2026-08-20: unit 2 was the only working pair; unit 1 was repaired and there
are now three.* `notes/plan-after-the-brick.md` sets the rules: no OTA
commit ever, and it is the control for the SWD work. An app that cannot reach `fd00` is
automatically compliant, which is the whole argument for layer 1.

Also **one connection per device**: the vendor app holding the unit is the most common
"the app is broken" report and it is not a bug. Detect it and say so.

### 9. The traps that produce plausible wrong output rather than errors

| Trap | Symptom |
| --- | --- |
| More than one 16-byte block per ATT write | columns 0, 11 and 22 update, the other 21 go stale. Looks like corruption |
| Masking a wide bitmap with `alive()` | a dead-pixel hole that travels with the text. See safety item 4 |
| Building a control on an opcode the firmware ignores | the button does nothing, and nothing errors. See safety item 5 |
| Queueing live writes instead of coalescing | dropped columns, stale pixels, looks like dead hardware |
| Concatenating DATS blocks without stripping the length prefix | the bitmap shifts and still looks like a bitmap |
| Sending any `MODE` while in DIY | the live buffer is discarded and the saved image appears |
| Trusting `DATCPOK` | it means something was stored, not that it was correct |
| Announcing a length that does not match the bytes sent | *unverified*. Compute the length from the payload, never from the text |

## Platform gotchas worth pre-loading

| Thing | Detail |
| --- | --- |
| Android 12+ | `BLUETOOTH_SCAN` with `neverForLocation`, plus `BLUETOOTH_CONNECT`. Runtime prompt |
| Android 11 and below | scanning needs `ACCESS_FINE_LOCATION`, which users find alarming. Explain it in the prompt |
| iOS | `NSBluetoothAlwaysUsageDescription` or the app is rejected, and scanning silently returns nothing |
| Metro + `.js` specifiers | `packages/core` imports `./protocol.js` from TypeScript source. Metro does not remap that. A `resolveRequest` hook in `metro.config.js` rewriting relative `.js` to `.ts` is the fix |
| Metro + workspaces | needs `watchFolders` at the repo root and `nodeModulesPaths`, or `@joggles/core` resolves to nothing |
| Backgrounding during live draw | iOS suspends the app and the connection goes quiet. Treat resume as "resend the whole frame", which is 24 writes and one sweep |

## Verify before building, in this order

None of these risks hardware. All seven change what gets written. Items 1, 3 and 5 are one
connection's work between them, and so are 6 and 7. *Was five; 6 and 7 were added when the
live sender was built and turned out to rest on two figures nobody has measured.*

1. **DATS bit 7 lights row 8.** Decides the renderer's row mapping. See safety item 3.
   `dats.ts` already encodes the corrected mapping, so the test is now `bun run
   packages/cli/src/upload.ts` with a bitmap whose only set pixel is row 8: if the top row
   lights, the mapping is settled and the code needs no change.
2. ~~**Light column 0 only, see which lens it lands on.**~~ **Done, 2026-08-12: ONE
   column, at the leftmost edge**, so the panel is a single 24-wide surface across both
   eyes and the draw canvas is right as built. Two mirrored 12-wide surfaces would have
   lit a column on each lens. *One ambiguity survives*: "leftmost" was reported without
   saying whether the glasses were worn or held facing, which swaps left and right, so
   **which end** column 0 sits at is still *derived*. `research/vendor-app-protocol.md`,
   "The sitting".
3. ~~**`MODE 02 <dir>`** horizontal scroll on our own uploaded content, both
   directions.~~ **Done, 2026-08-12: dir 0 travels left, dir 1 travels right**, both
   watched, and dir 1 had never been sent to a device before that evening. Both show the
   panel go fully dark between passes, which is the blank bracket on content restored
   from flash with no save in the session. **The bracket's size is still open** and this
   look cannot settle it: the payload in flash carries a 10-column blank run of its own,
   so what was seen is content blanks plus the device's. The clean subject is the
   240-column loop already on the wire from 2026-08-11 23:46.
4. ~~**DATS type 2 at exactly 72 bytes**, then over 72.~~ **Done, 2026-08-09, and the
   answer is no.** Over 72 is accepted to 383 columns and `ERROR` from 384, but **only the
   first 24 columns are ever displayed**, so a greyscale drawing cannot be wider than the
   panel and wide drawings go as type 1 and lose their grey. The verdict, the three things
   the item did not ask, and the null-observation caveat are in
   `packages/core/src/content.ts` and `research/vendor-app-protocol.md`; `bun run
   packages/cli/src/type2.ts` reproduces all of it.
5. **`MODE 02` on content narrower than the panel.** Upload 10 columns and scroll them.
   Nothing says the firmware handles content shorter than one screen, and "HI" is the
   first thing anyone will type. If it misbehaves, the fix is to pad every upload to 24
   columns, which is a renderer decision and cheaper to make now than to retrofit through
   the content model.
6. ~~**`CLRL` alone, mid-session, with the panel lit.**~~ **Done, 2026-08-12: the panel
   went dark and stayed dark.** Three bars drawn, then `CLRL` alone with nothing after
   it. So the draw screen's clear works, `LiveSender` marking all 24 columns blank
   afterwards is true rather than hopeful, and `clear({ atomic: false })` stops being a
   hedge worth keeping. **Not established: whether it clears at once or wipes across**,
   so the word "atomic" in that path is still *derived*.
7. ~~**How low live pacing goes.**~~ **Done, 2026-08-12: 6 ms holds, 12 of 12 columns,
   nothing dropped.** So the 18 ms copied into `Glasses` is three times more
   conservative than the hardware needs: a whole-panel live change is 144 ms rather than
   430 ms, and on the bulk path the same headroom is a ~2 s full-width upload rather
   than ~6 s, which is the wait behind "it seems to keep having to send the animation to
   the device". **Record it as a bound, not a constant**: BLE negotiates its interval per
   connection, so take most of the win and keep headroom rather than sitting on the
   measured edge. Nothing below 6 ms was tried.

## Deliberately not in this app

| Idea | Why not |
| --- | --- |
| Anything OTA or firmware | see safety item 1. Not "later", **never in this app** |
| Frame-flip animation of our own content, unattended | `MODE` scrolls, it does not page. Firmware track |
| The rhythm channel | the best festival feature and a whole audio pipeline. Its own increment |
| Multiple pairs at once | one connection per device is fine, but fleet UI is an app of its own |
| The crew key | vendor key only until there is a crew unit to speak to |
| A frame compressor | measured at 1.3x to 2.4x. Not worth it, see `notes/what-to-build.md` |
