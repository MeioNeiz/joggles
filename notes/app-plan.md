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

Three consequences that shape the design:

- **A one-column save costs exactly as much wear as a 740-column save.** The five erases are
  hardcoded and always the same five pages, so there is no wear levelling and no benefit to
  saving smaller content. The lever is **saving less often**, never saving less.
- **An aborted upload costs zero.** Streaming blocks only fills SRAM. If the phone
  backgrounds or the user cancels before `DATCP`, no flash was touched. Cancel is safe.
- **Live draw is unlimited.** Draw all night, every stroke, no wear at all.

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

**`dats.datsComplete()` is called from exactly one function in the whole codebase**, and
that function is `session.save()`. Everything else goes through it. This is testable:
assert that `datsComplete` has one caller outside its own tests, and the build fails when
someone adds a second.

`session.save()` is wrapped by a budget guard that **throws rather than queues**, because
a queue turns a runaway into a slower runaway:

| Rule | Value | Behaviour on breach |
| --- | --- | --- |
| Identical payload | hash of the bytes plus type | **skip silently**, report "already on the glasses" |
| Minimum interval | 3 s since the last save to this device | throw, and surface it as a bug not a user error |
| Rolling hour | 30 saves | require an explicit confirmation to continue |
| Rolling day | 200 saves | refuse, and require a developer override flag |
| Lifetime, per device | counted, no cap | shown in the UI, see Visibility |

The interval and hourly numbers are deliberately far above any human pattern and far
below any loop. A person saving a message every few seconds for a whole minute is fine; a
render loop hits the interval rule on its second iteration and dies loudly.

**The guard lives in `packages/core`, not in the app**, so the CLI is covered by the same
rules and `uploadbench.ts` has to pass the override flag and print what it is about to
spend. One implementation, both hosts, and the laptop is where the loops actually get
written.

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
| Motion | anything, but full-frame changes sweep | **horizontal translation only** |
| Enter with | `SMVEW 01` | nothing, DATS does not need DIY |

**The Saved column is DATS type 1 throughout.** Type 2, the greyscale encoding, is a
third route wearing the second one's clothes: same channel and handshake, but **24
usable columns**, no flash and **no persistence past a power cycle**. Its Persists and
Flash rows read the same as Live's. *verified* 2026-08-09, `research/vendor-app-protocol.md`.
*Corrected: this said 383 columns, which is what the device accepts rather than what it
displays, and was marked derived before verify item 4 ran.*

**Size the progress bar from transfer, not from the cycle.** At 700 columns the measured
numbers are 4984 ms of transfer at the vendor's 50 ms pacing and 1081 ms at 6 ms; the
often-quoted 5.9 s and 2.0 s are connect-to-disconnect, which includes ~900 ms of
connection setup the bar should show as its own step. *verified*, `research/vendor-app-protocol.md`.

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

The sequencing logic in `packages/cli/src/glasses.ts` is the valuable part and it is
currently welded to noble. Split it, or the phone gets a second implementation of the DATS
handshake and the two drift.

    packages/core/src/transport.ts  built. Transport, Scanner, Discovered
    packages/core/src/session.ts    built. Glasses, transport-agnostic
    packages/core/src/budget.ts     built. the flash guard and the per-device ledger
    packages/core/src/sender.ts     increment 2. the coalescing live sender
    packages/cli/src/noble.ts       built. noble adapter, ~130 lines not ~60
    packages/app/                   Expo app + ble-plx adapter

```ts
export interface Transport {
  write(char: string, block: Uint8Array, withResponse: boolean): Promise<void>
  subscribe(char: string, on: (block: Uint8Array) => void): Promise<void>
  disconnect(): Promise<void>
}

/** Discovery is platform code too, and the Scan screen needs a list, not the first hit. */
export interface Scanner {
  scan(onFound: (unit: Discovered) => void): Promise<void>
  stop(): Promise<void>
  connect(id: string): Promise<Transport>
}

export interface Discovered {
  id: string    // opaque, the platform's own handle
  name: string  // advert name, which picks the cipher before the connection is open
  rssi: number
}
```

**Two interfaces, not one, and this was the part of the extraction that was real design
work rather than moving code.** `Glasses.open()` fused scan, connect and subscribe into
one static; `findGlasses()` resolved the *first* advert that matched a prefix and threw
the rest away; `Glasses.name` read `peripheral.advertisement.localName` straight off a
noble object. A Scan screen needs all three pulled apart: a `Scanner` the app drives, and
`Glasses.attach(transport, name)` taking a connection that is already open. The name has
to arrive as an argument because `Options.cipher` can be a function of it.

**Done.** `Glasses.open()` is gone. The CLI's one-shot is `open()` in
`packages/cli/src/glasses.ts`, which is `NobleScanner.first()` plus `connect()` plus
`attach()`, and `first()` carries a comment saying why a Scan screen must not use it. The
adapter discovers **only** the four allowed characteristics, so nothing above it ever
holds a handle on the flash-writing service; `assertChannel()` is the second check.

Characteristic UUIDs cross this boundary in their dashed form, as `protocol.ts` declares
them. Each adapter normalises: noble strips the dashes, ble-plx does not.

Everything above that line is pure TS and unit-testable against a mock transport, which is
what makes "the phone sends the same bytes as the CLI" a test rather than a hope.

Do the extraction first, on the laptop, where a bug is a stack trace and not a rebuild
cycle. `bun cli text` still working afterwards is the regression gate.

### What has already landed

Prep done on 2026-08-09, before any app code, so the next session does not re-derive it.
All of it is laptop-side and `bun test` passes with it.

| Change | Why it could not wait |
| --- | --- |
| `ota`/`dfu` out of the barrel, into `core/src/firmware.js` | safety item 1 was unenforceable while `index.ts` exported them |
| `protocol.SERVICE_OTA` deleted | it put an OTA UUID in the one module the app must import. `dfu.ts` already declared it |
| `safe-surface.test.ts` | the build-failing test safety item 1 asks for, plus the no-Node assertion the stack decision rests on |
| `dats.ts` corrected mapping, `DATS_ROWS` 9 | safety item 3. Everything that renders sits on this |
| `font.panelBitmap()` | places 5-row glyphs into 9 panel rows, so the renderer and the preview cannot disagree |
| `protocol.mode(kind, dir)`, `protocol.clear()` | safety item 5. The misnamed helpers are gone rather than deprecated |
| Ignored opcodes grouped and labelled in `protocol.ts` | so no screen is built on a control that does nothing |
| `uploadbench.ts` enforces 740 columns and prints its flash cost | it defaulted to 768, which the device rejects, and it is the loop from "Our own bench and sweep scripts" |

The three experiment scripts that called `scrollLeft(3)` now call `mode(3, 1)`. Same
behaviour, since the second byte is a boolean, and their prose no longer calls `MODE 03`
"scroll left".

### Phase 0, landed 2026-08-09

The extraction and the flash guard. Laptop-side, `bun test` at 170.

**The regression gate has not been run.** No hardware was touched in this session, so
`bun cli text` working after the extraction is *derived* from the mock and not
*verified*: the suite, a bundle resolve of every CLI entry, a `tsc --noEmit` pass and a
mock run of the exact `cmd text` sequence (`SMVEW 01`, `LEDON`, 24 column writes with
only the last acked, `STYPE` flush, disconnect - identical to before). The one piece no
mock covers is `packages/cli/src/noble.ts` itself, and its trap is that noble's second
write argument is `withoutResponse`, the inverse of `Transport.write`. Getting that
backwards is silent: writes still land, just unacked, and the last column of a frame
goes missing on disconnect. **So run `bun cli text` first, and look at the last column.**

| Change | What it means for the app |
| --- | --- |
| `core/src/transport.ts`, `core/src/session.ts` | `Glasses` no longer knows what noble is. The phone gets the DATS handshake for free rather than reimplementing it |
| `cli/src/noble.ts`, `cli/src/glasses.ts` down to 40 lines | the adapter is the only file that knows a platform. ble-plx is the same shape |
| `core/src/mock-transport.ts` + `session.test.ts` | the wire is asserted without hardware: which characteristic, how many blocks, which write is acked |
| `core/src/budget.ts` + `budget.test.ts` | the four rules, per device, over a persisted ledger |
| `choke-point.test.ts` | scans every `.ts` in the repo and fails if a second caller of `datsComplete` appears |
| `cli/src/ledger.ts`, `bun cli ledger` | the count survives invocations, and can be read without connecting |
| `uploadbench.ts` varies its payload per pass | six identical saves would be five duplicates, which the guard skips; the bench would have timed nothing |

**Two things the guard does that the table above does not say.** The duplicate rule only
matches a save the device *acknowledged*, so retrying after `ERROR` is not mistaken for a
no-op; and a save is counted even when the reply is `ERROR`, because the erases happen at
the device's end either way. The interval rule also reads an in-memory attempt stamp, not
just the ledger, or two saves fired at once would both pass before either recorded
anything, which is exactly the StrictMode case.

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

| Change | Why |
| --- | --- |
| `app/src/deliver.ts` + `deliver.test.ts` | the save sequence out of the `onPress` and into a function, so "DATS, blocks, DATCP, SPEED, MODE" is eight assertions against the mock rather than a person squinting at LEDs |
| `app/src/ledger.ts` | `LedgerStore` over expo-file-system, and the app's one `FlashBudget` at module scope. Per connection would reset the interval rule on every reconnect |
| `app/src/ble.ts` releases connections before scanning | **a connected peripheral does not advertise**, so a Fast Refresh left the pair invisible and it looked exactly like the glasses being off. One `BleScanner` at module scope too: it must outlive the Scan screen, because the connection it opens is handed to the screen that replaces it |
| `Preview` takes a window, not a bitmap | safety item 4 made structural: it is handed `viewport.windowAt` output, so there is no bitmap in scope to mask by mistake |
| `deliver.problems()` refuses grey | `session.save()` still announces type 1, so greyscale would flatten with nothing able to say so. Refusing beats silently dropping levels; the draw canvas is what needs the `type` argument threaded into `dats.datsStart` |

**A trap for anyone reading frames back.** `MockTransport.commands` takes the leading run
of capitals, so an argument byte that happens to be an uppercase letter joins the opcode:
`SPEED 85` is `0x55`, which is `U`, and it reads back as `SPEEDU`. `deliver.test.ts`
matches against a known opcode list instead.

#### The preview is a simulation, and that took three goes

Reported as "speeds up and slows down", then "still not smooth, slight delays", then
"slow scrolls faster than fast". Three separate causes, and only the first was the one
originally guessed at.

1. **A counted `setInterval` surges.** React Native's timers do not skip: a stalled JS
   thread fires every callback that came due together, so the message lurches several
   columns and hesitates. Counting turns a stall into a debt repaid in a burst. The step
   is now a function of time, so a stall drops a column instead.
2. **Milliseconds beat against the refresh.** 90ms is 5.4 frames at 60Hz, so steps land
   alternately 5 and 6 frames apart - each one on time, and visibly uneven, because the
   eye compares against the frames it is drawn in. The clock now measures the refresh
   period and counts **frames**, so every column move is the same number of frames after
   the last. `packages/app/src/clock.ts`, and both failures are tests.
3. **Speed did nothing.** The preview ran at a fixed rate whatever the Speed button said.
   It now runs at the device's own rate, and the screen states it: 3.8 columns per second
   at Slow, 12.5 at Fast.

Renders got cheaper on the way: styles are built once instead of per pixel per frame,
each row bails out unless its own 24 values changed, and the clock lives inside the panel
so a column step no longer re-renders the text field and four button rows with it.

**`SPEED`'s ladder has ten buckets, not six.** *verified*, disassembled from
`abs 0x183da`: it compares the argument against 10, 20, 30 ... 90 and writes a frame
divisor of 13 down to 4 to RAM `0x2000266e`, and the panel holds each column for that
many ticks of its 50 Hz clock - so a column lasts `divisor * 20ms`, 260ms down to 80ms.
*Corrected: `research/firmware-internals.md` records the ladder as comparing against "50,
60, 70, 80, 90", which is the five comparisons inside the address range it quotes; four
more sit just before it at `0x183de`-`0x183fe`.* The 3.8 to 12.5 columns per second in
the same paragraph is right, and is these two endpoints. The table is
`packages/app/src/speed.ts` and **it belongs in `packages/core/src/protocol.ts`** next to
`protocol.speed()`; it is in the app only because `protocol.ts` is not that track's file
while other agents are running.

### The content model

One representation, two encoders. The bug this prevents is code that knows which route it
is on and hardcodes an encoding to match.

```ts
type Bitmap = number[][]          // [row][col], values 0-3, row 0 is the bottom
type Route = 'live' | 'saved'

interface Content {
  bitmap: Bitmap                  // 9 rows, 1 to 740 columns
  route: Route
  motion: { kind: 'static' } | { kind: 'scroll'; dir: 0 | 1; speed: number }
}
```

Renderers (text, drawing, future generators) all produce a `Bitmap` and nothing else. The
delivery layer owns every wire detail: 2bpp versus 1bpp, column width, which characteristic,
which handshake. **Greyscale survives the live route and DATS type 2; DATS type 1 flattens
to 1 bit.** Say so in the UI when a drawing with grey levels is saved as text.

#### Built, 2026-08-09

`packages/core/src/content.ts` and `viewport.ts`, plus `dats.encodeImage` for type 2.
`content.encodeSaved()` picks the type from the content and reports `flattened` so the UI
has something to say; `viewport.windowAt()` is the 24-column window with `alive()` applied
at the window, which is safety item 4 made unavoidable rather than remembered.

**The two ceilings are unrelated numbers.** *Corrected, twice:* the Width row in "The two
delivery routes" says 740 columns, which is 1480 bytes at type 1's two bytes per column,
and type 1 is the only type the bisection ever ran. This file then said type 2's ceiling
was that budget at three bytes, **493 columns**. It is not. The device buffers an image
column as a 32-bit word and wraps at 384, so type 2 stops at **383 columns** and answers
`ERROR` above it. *Corrected a third time:* 383 is what `DATCP` accepts, and only the
first **24** columns are ever displayed, so 24 is the number content is sized against.
`content.maxColumns(type)` is the figure to quote and gives 740 / 24;
`content.IMAGE_ACCEPT_CEILING` is the 383. `MAX_SAVED_BYTES` is what was measured, and it
is a type 1 measurement.

**Type 2 does not persist**, which the flash-wear budget below never accounted for. Only
type 1 reaches the flash writer; type 2 stops in RAM and is shown by mode 26, exactly as
`SMVEW 02` does. So a greyscale save survives a disconnect and not a power cycle, costs
no flash wear, and need not be charged to the ledger. Since `savedType()` picks the type
from whether the content has grey in it, one grey pixel decides which of those a save is,
and no reply from the device distinguishes them. *derived*,
`research/firmware-internals.md`.

Both gaps here are now closed. `session.save()` takes a `type` option, and type 2 above
the vendor's 72 bytes was verify item 4 and is verified: 383 columns accepted, 384
refused, no flash written, and the image on the panel with its greyscale intact.

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

This is the piece live draw actually needs, and it is worth building properly because the
naive version fails in a way that looks like broken hardware.

**The failure mode:** write-without-response has no flow control. A finger dragging across
the canvas generates touch events far faster than 7 ms per column, so a queue-everything
sender overruns the controller and columns are silently dropped, leaving stale pixels lit.
The user sees their drawing come out wrong and blames the panel.

**The design:** never queue frames, only ever a desired state.

- The UI writes into a `desired: Grid`. It never sends anything.
- One sender loop holds `lastSent: Grid`, diffs against `desired` with the existing
  `Grid.deltaFrames()`, and writes the changed columns one at a time, paced.
- New touches during a send simply update `desired`. Intermediate states are skipped, not
  queued, so a fast drag lands as one correct final frame rather than a backlog.
- **The last write of a batch goes with response**, so a frame cannot be half-delivered if
  the user disconnects immediately after. `Glasses.show()` already does this.

Two effects worth knowing. A fast scribble skips intermediate frames, which is correct and
invisible. A "fill the canvas" button touches all 24 columns and will sweep, which is the
hardware, not the sender. Clear is the exception: **`CLRL` clears the live buffer in a
single atomic write**, so make the clear button use it rather than sending 24 blank
columns.

**Built**, as `packages/core/src/sender.ts`, `LiveSender`. Two departures from the design
above, both deliberate. It picks the next column *after every write* rather than diffing a
whole frame up front, so `Grid.deltaFrames()` is not used: a touch arriving mid-batch is
picked up on the next write instead of after the batch it arrived during, and a column
touched and untouched again during one write is never sent at all. And it keeps `sent` as
what has been *acknowledged* rather than what has been handed to the transport, so
`pending` counts the write in flight. Tested against `mock-transport.ts` only.

`clear({ atomic: false })` writes 24 blank columns instead of `CLRL` and exists as a
hedge, but the hedge is probably unnecessary: **`SMVEW 01` clears by branching into the
middle of the `CLRL` handler**, so the two are the same instructions and we already run
them at the start of every live session (*verified* at byte level while building this,
written up in `research/firmware-internals.md`). What remains untested is `CLRL` alone,
mid-session, with the engine already stopped. Delete the option once someone has watched
that happen.

### The draw canvas

- 9 rows x 24 columns, and it spans **both lenses** with the nose bridge in the middle
  (*derived*, and settled by one hardware test, see "Verify before building").
- **Render the dead pixels as unavailable**: the middle 6 of the top row, and the
  nose-bridge notch. `display.alive()` already maps them. Users must not be able to paint
  into the void and wonder why it did not show.
- **Rows 2 to 7 are the only band alive across all 24 columns.** Mark that band in the UI,
  because anything outside it gets chewed passing the bridge.
- Brush levels 0 to 3, but **the steps are subtle** (*verified*: six-column bands were not
  separable, wider bands with dark separators were). Present grey as shading, not as four
  distinct colours, and do not build a feature that needs the user to read a level at a
  glance.

#### Built and drawn on, 2026-08-09

`packages/app/src/draw/`: `canvas.ts` is the arithmetic, `Pad.tsx` the touch surface,
`Draw.tsx` the screen. All four points above are in it, and the band is derived from
`display.alive()` rather than written down so it cannot drift from the mask.

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

Three decisions worth not re-making:

- **Touch samples are joined with Bresenham.** A drag reports one cell per frame and
  painting only what was reported draws a dotted line. Lifting the finger ends the
  stroke, or the next touch draws a line across the panel to where it started.
- **The holes are refused at paint time, not at hit-test time.** A stroke across the
  nose bridge has to come out the other side, so being over a dead pixel is a fact about
  the pixel and not about the touch.
- **The pixel grid takes no touches** (`pointerEvents="none"`). `locationX` is relative
  to whichever view was touched, so 216 touchable children would resolve every touch to
  cell 0 - which looks like a broken hit test rather than a layout mistake.

`Glasses.live()` is new in `core/src/session.ts` and is how a screen gets a sender: the
transport and the cipher are private to the session, and a screen that re-derives the
cipher on a crew unit writes frames the device silently ignores.

**Not built, and not in this track's contract: saving a drawing.** Type 2 is 24 columns
and does not persist, so "save this drawing" is a decision about what the button
promises rather than an encoder change.

## Scope, by increment

Tuesday is the target for increment 1. The architecture above is designed for all three,
so 2 and 3 add screens rather than rework.

| # | Ships | New work |
| --- | --- | --- |
| **1** | scan, connect, type text, save, scroll, brightness | scanner and transport split, ble-plx adapter, DATS path, **flash budget guard and ledger** |
| **2** | live draw, clear, show-now, save drawing as type 2 | canvas UI, DIY state machine (the coalescing sender is built) |
| **3** | wide scrolling composer, presets, built-in banks | wide-bitmap editor, `ANIM`/`IMAG` browser |

Four screens at increment 2: **Scan**, **Compose** (text), **Draw** (canvas), **Playing**
(what is on the device, direction, speed, brightness, disconnect).

**Android first, deliberately.** Sideloading an APK is minutes; iOS needs provisioning and
a free Apple account gives 7-day builds that expire. If Tuesday is real, iOS is what slips.

**Start the dev client build before the extraction, not after it.** It is the long pole and
it is mostly waiting rather than working: `expo install`, `expo prebuild`, then an EAS
build that takes 10 to 20 minutes and either produces an installable APK or does not. The
extraction is laptop work that cannot fail in an unrecoverable way. Running the build first
means a broken toolchain is discovered on Sunday evening with the fallback still open,
rather than at the Monday midday checkpoint when there is no longer an afternoon to spend.

**The fallback that de-risks the deadline.** If the native build fights back, a Bun HTTP
server on the laptop with a mobile web UI driving the existing noble transport gets a
phone-shaped remote with zero native tooling. Not the product, needs the laptop in range,
costs an afternoon. Decide by Monday midday.

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

The ble-plx adapter does three things noble does not: base64 in and out of every write
(hand-rolled, 20 lines, no dependency), permissions before the first scan, and **still
exactly one 16-byte block per write** no matter what MTU was negotiated.

## Safety: where to be careful

Ranked by what it costs when you get it wrong. The first is a dead unit.

### 1. The app must never speak to `fd00`. Design it out, do not guard it

`GLASSES-12C3EF` was bricked on 2026-08-08 by an OTA commit of the **stock image over
stock**, which the device's own CRC verified before it reset itself and never came back.
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

Five page erases per call regardless of payload size, no wear levelling, and no way to
read the remaining cycles off the device. Reasoning, numbers and the runaway causes are in
"Flash wear" at the top of this file. **It is the second-worst thing this app can do to a
unit and the only one it does on purpose**, so it ships with enforcement rather than
intent.

Acceptance criteria for the increment that first sends `DATCP`, all of them:

- [x] `datsComplete()` has exactly one caller in the codebase, and a test asserts it
- [x] the guard enforces identical payload, 3 s interval, 30/hour, 200/day.
      *Corrected: this line used to say "throws on identical payload", which contradicts
      the table above. A duplicate **skips**, because writing flash to store what is
      already stored is the thing worth avoiding, and the table is the specification*
- [x] the guard lives in `packages/core`, so the CLI obeys it too
- [x] no save is reachable from a React effect, a timer, or a retry without a ceiling.
      The app's only save is `deliver()` called from one `onPress`; it does not retry,
      and the button refuses for `LIMITS.intervalMs` afterwards so an impatient double
      tap is a busy button rather than a thrown guard
- [x] the per-device ledger persists and the About screen shows the lifetime count.
      `packages/app/src/ledger.ts` over expo-file-system, keyed by advert name, holding
      the app's one `FlashBudget` at module scope so a reconnect cannot mint a fresh
      allowance. The count is on the Compose screen, not behind a menu. *verified*: one
      save from the phone, `{"lifetime":1,...,"ok":true}` read back off the handset
- [x] `uploadbench.ts` prints its cost and requires a flag

Everything else the app does, including the whole of live draw, writes no flash at all.

### 3. The DATS row mapping was wrong in `dats.ts`. Fixed, and still needs one upload

**Done in code.** `encodeBitmap` mapped row `r` to bit `r` for rows 0 to 6 and to bit `r+1`
above, which is the 7+7 reading from `notes/protocol.md`. `research/firmware-internals.md`
corrects that, corroborated from two independent firmware paths:

| Upload bit | Panel row |
| --- | --- |
| 0 to 6 | rows 1 to 7 |
| 7 | **row 8** |
| 15 | **row 0** |
| 8 to 14 | nothing |

Under the old mapping a 9-row bitmap drew **one row too high** and **silently discarded
rows 7 and 8**. It never bit us because every upload so far has been text, and the font is
five rows (`font.HEIGHT`), so the only symptom was a one-row offset nobody would question.
*Corrected: an earlier version of this file said seven-row text, which is the DATS format's
old imagined half rather than anything we have ever rendered.*

`dats.ts` now encodes and decodes the corrected mapping, `DATS_ROWS` is 9 rather than 14,
and `dats.test.ts` asserts each of the four rows of that table separately instead of the
old 7+7 shape.

**It is still *derived*.** Two firmware paths agree and no hardware has confirmed it, so
the verify list keeps its place at number 1. If row 8 does not light, `dats.ts` and its
test are what change, and nothing built on top of them has to move.

**Rows are panel rows now, which makes placement someone's job.** `font.textBitmap` returns
only the five rows the glyphs occupy; feeding that straight to `encodeBitmap` puts text at
rows 0 to 4, and rows 0 and 1 are the nose notch. `font.panelBitmap(text)` places them at
`BASELINE`, giving rows 2 to 6, inside the band that is alive across all 24 columns. **The
preview must call the same helper**, or the phone shows text the panel will not draw.

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
`scrollRight` built `MODE 04`, which the argument parser rejects outright. `protocol.mode(kind,
dir)` replaces both, plus `modeStatic` and `modeFlash`: kind 1 static, 2 horizontal, 3
vertical, and `dir` is a boolean the firmware tests only for zero versus non-zero.

**The same table has more traps than that one.** The firmware handles exactly eleven
opcodes; the helpers transcribed from the vendor app's table are a much longer list, and
the extras reach no handler at all. `queryType`, `invert`, `stopRhythm`, `leds` and
`flashlight` build frames the device silently discards, and there is no lens select, so
`lens()` never did anything. They are grouped and labelled in `protocol.ts` rather than
deleted, because the decoders still have to name what the vendor app sends. **No UI control
may be built on one**: a Playing screen with an LED on/off toggle ships a dead button, and
`LEDOFF` in particular reads as "the panel should go dark" and does nothing. The atomic
clear is `CLRL`, now `protocol.clear()`.

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

Unit 2 is the only working pair. `notes/plan-after-the-brick.md` sets the rules: no OTA
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
2. **Light column 0 only, see which lens it lands on.** Decides whether the draw canvas is
   one 24-wide surface across both eyes or two mirrored 12-wide ones. It is the difference
   between one canvas and two, so it is a UI decision, not a detail.
3. **`MODE 02 <dir>`** horizontal scroll on our own uploaded content, both directions.
4. ~~**DATS type 2 at exactly 72 bytes**, then over 72.~~ **Done, 2026-08-09, and the
   answer is no.** Over 72 is *accepted* to 383 columns, `ERROR` from 384 (device
   replies, solid), but **only the first 24 columns are ever displayed** (read off the
   panel by eye, and a null observation: caveat and the harder test in
   `research/firmware-internals.md`), so a greyscale drawing cannot be wider than the
   panel. Wide drawings have to go as type 1 and lose their grey. Three more things the
   item did not ask, all of which shape the screen: the image **displays on `DATCPOK`
   with no `MODE`**; any `MODE` after it switches to the type 1 flash store **with no way
   back**, so a drawing screen must not send one; and type 2 **writes no flash**, so it
   does not survive a power cycle. What type 2 is actually good for is a whole 24-column
   greyscale frame with **no left-to-right sweep**, which no other path offers for
   arbitrary pixels. `bun run packages/cli/src/type2.ts` reproduces all of it.
5. **`MODE 02` on content narrower than the panel.** Upload 10 columns and scroll them.
   Nothing says the firmware handles content shorter than one screen, and "HI" is the
   first thing anyone will type on Tuesday. If it misbehaves, the fix is to pad every
   upload to 24 columns, which is a renderer decision and cheaper to make now than to
   retrofit through the content model.
6. **`CLRL` alone, mid-session, with the panel lit.** The clear button is one write and
   the whole draw screen's "start again". Enter DIY, draw a few columns with
   `LiveSender`, send `clear()`, watch. It is the same code `SMVEW 01` runs, so the
   expected answer is yes; if it is no, `clear({ atomic: false })` is already the
   fallback and the option stops being a hedge and becomes the default.
   **The send half happened on 2026-08-09** and the item still stands: the draw screen's
   clear button put `CLRL` on the wire by itself, 56 seconds into a session with 210
   columns drawn and the panel therefore lit (`packages/app/.expo/dev/logs/start.log`).
   Nobody said what the panel did, which is the entire question, so this stays open and
   the next person to try it needs only to look.
7. **How low live pacing goes.** 18 ms per column is copied from `Glasses`, never
   measured, and it is 430 ms for a whole-panel change against ~168 ms at the ~6.5 ms
   floor the firmware implies. Bisect `LiveSender`'s `pacing` with alternate columns lit
   so a dropped write shows, and read the end state rather than the sweep. Full method in
   `research/vendor-app-protocol.md`, "The live channel has no measured pacing floor".

## Deliberately not in this app

| Idea | Why not |
| --- | --- |
| Anything OTA or firmware | see safety item 1. Not "later", **never in this app** |
| Frame-flip animation of our own content, unattended | `MODE` scrolls, it does not page. Firmware track |
| The rhythm channel | the best festival feature and a whole audio pipeline. Its own increment |
| Multiple pairs at once | one connection per device is fine, but fleet UI is an app of its own |
| The crew key | vendor key only until there is a crew unit to speak to |
| A frame compressor | measured at 1.3x to 2.4x. Not worth it, see `notes/what-to-build.md` |
