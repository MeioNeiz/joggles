# Joggles

LED glasses, app Funky Glasses+. Protocol solved, verified on hardware.

## Where to look

| File | What it holds |
| --- | --- |
| **`notes/hardware-state.md`** | **read this first if you are touching a device.** Which physical pair is which by advert suffix, which holds what, where the dumps and backups are with their hashes, and what has been written to what. Written 2026-08-19 after a filename asserted a provenance nobody had checked and two sessions built a model on it. **All three pairs work as of 2026-08-20** |
| `notes/plan-after-the-brick.md` | **the firmware-delivery plan**: three tracks, the rules for unit 2 including the `--ldrom-verified` gate, and the SWD order of operations. Tracks A and B are done and unit 1 is repaired; **Track C, our own firmware on a real unit, is what is left**. For app work the current plan is `notes/parallel-tracks.md` plus `notes/app-plan.md` |
| `research/aprom-write-2026-08-20.md` | **the repair, and the first APROM write on this family**: the numbers, the granularity probe, and the three wrong turns between "the script says DONE" and a unit that advertises. Read it before flashing anything |
| `notes/dump-healthy-unit.md` | the runbook for reading a *working* pair over SWD, self-contained enough to follow at the bench. Also the record that connect-under-reset turned out to be a fallback rather than a prerequisite |
| `notes/hacked.md` | the one-command display script and the bespoke letterform drawn for this panel: static, 3 columns a letter, the word split across the nose bridge so the notch becomes the gap. `bun run hacked` |
| `notes/protocol.md` | key, frames, command table, panel geometry |
| `notes/app-plan.md` | the phone app, the flash-wear numbers, and the ordered "Verify before building" list |
| `notes/what-to-build.md` | delivery routes, ranked patches, festival ideas, what we decided against |
| `notes/playlist.md` | the cycled playlist: why stock's button cannot do it, the one-reel design, and the residency defect |
| `notes/library.md` | the phone's saved content: the three things called "the library" kept apart, store-the-recipe, why width is not a question, and what the four faces are for |
| **`notes/patch-over-bt.md`** | **how we replace our own firmware over Bluetooth and then do it again**: the resident half a probe alone can rewrite, the two slots that carry every feature, and what each failure leaves behind. Also what it unblocks, and what stays SWD-only |
| **`research/patch-over-bt-review-2026-08-20.md`** | **the adversarial review of the update loop, and read it before flashing our own firmware to anything.** It found a live bug (`UPD_DATA` reaching the live slot) and a structural gap (there was no slot dispatch at all, so the design's central safety claim was vacuous), both **fixed by track 60**. Its lasting value is the other half: the claims it attacked and could NOT break, including the four-byte hook re-derived from bytes across all 256 KB and the 2 s long press |
| `notes/firmware-design.md` | our own firmware: architecture, wire formats, roadmap, safety envelope. **Its "The hook itself" section is the superseded 28-byte design**; the hook is four bytes, `research/donor-dispatcher-2026-08-20.md` |
| `notes/from-a-phone.md` | **changing this project with no Mac and no cable**: the CI-builds-the-APK route, what a cloud container cannot reach (no SDK, no adb, no Bluetooth), the rendering bug that route let through, and what still needs somebody holding the glasses |
| `research/README.md` | index of the teardown. `firmware-internals.md` is what the firmware actually is, tiered by trust in its Provenance section |

Findings go in `research/` with a confidence marker, judgement in `notes/`. **How to
write either: `notes/WRITING.md`.** **Working alongside other agents:
`notes/parallel-tracks.md`**, and `.claude/locks/` is where each track has got to.

**Every module in `packages/core/src` carries its reasoning in its own docblock**, which
is where the detail lives. This file is pointers plus the traps that bite everywhere.

## Working rules

- Bun + TS only. No Python, no Go. `packages/core` is pure TS with zero deps,
  `packages/cli` is noble/CoreBluetooth, `packages/app` is Expo and has its own
  `CLAUDE.md`. `bun test` green when you stop; the count only goes up
- **The `@joggles/core` barrel has no OTA in it.** `ota`/`dfu` sit behind
  `core/src/firmware.js`, so reaching `fd00` is an explicit import and the phone app
  cannot do it by accident. `safe-surface.test.ts` fails the build if that leaks, or if
  anything the barrel reaches imports Node (React Native has no `Buffer`)
- `bun cli <probe|text|edge|off|bench|speed|stress|ledger>` needs a device. `speed`
  steps through every `SPEED` bucket and then past the top of the ladder, on one flash
  write, and is what turns the ladder from *derived* into *verified*. `bun run
  <ota-check|build-firmware|flash|dumpcheck>` is the firmware side. `bun run effects
  <name>` and `bun run packages/cli/src/fontsheet.ts` need nothing attached. Env setup
  (macOS Bluetooth permission, noble `trustedDependencies`): README
- Firmware analysis is `research/tools/fwtool.ts`, **not grep**: its header explains the
  two scanning traps that have already put wrong entries in the docs. Edits go through
  `research/tools/patch.ts`, which refuses any patch whose expected old bytes do not
  match. Pre-flash verification: "Safe procedure" in `research/firmware-flashing.md`
  (steps 1-3 only, step 4 is struck) and "Reviewed 2026-08-09" in
  `notes/firmware-design.md`

## Mental model

Renders on-device. Upload once, let it animate, radio off; don't stream. The saved store
and the DIY live buffer are separate things, and the `MODE` family shows the saved store.
Wide buffers work: app limits are not device limits.

**The MCU does not drive the LEDs.** The panel is a separate module on UART1 at 115200,
fed one atomic 74-byte frame at a time, so greyscale depth and the level-to-brightness
curve are the module's and unreachable by any firmware patch, and ~6.4ms per frame is
the real floor. There is an on-board button the firmware polls: short press cycles
built-in modes, 2s long press powers off. The pin is P5.2 (*verified* by hand-decode);
the behaviour is *derived* and unwitnessed.

Service `fff0`, not `fee9`. Channels: `9600` commands | `9601` notify | `960a` DATS
upload stream | `960b` live columns and rhythm. Save is `DATS <type> <len16>` ->
`DATSOK` -> 15-byte blocks on `960a` -> `DATCP` -> `DATCPOK`, one buffer per type and no
slot index. `IMAG` and `ANIM` banks are read-only built-ins.

9 rows x 24 columns spanning both lenses, row 0 bottom, col 0 left. Dead LEDs at the
top-row middle six and the nose notch (`display.alive()`). Rows 2-7 is the only band
alive in every column, which is why a scrolling font is 5 or 6 rows and never 9, and why
the tall one is placed rather than scrolled. Packing differs per
channel: `notes/protocol.md`, and the `dats.ts` docblock for the DATS row mapping.

## Code map

| File | What it is, and the thing not to get wrong |
| --- | --- |
| `core/src/session.ts` | `Glasses`, all sequencing, transport-agnostic through `transport.ts`. `Glasses.attach(transport, name)`; the CLI's `open()` lives in `cli/src/glasses.ts` |
| `core/src/budget.ts` | flash wear, plus the only record of what the device is holding. `session.save()` is the only caller of `dats.datsComplete()` and `choke-point.test.ts` fails the build if a second appears. Duplicate payloads skip; 3s apart, 30/hour or 200/day **throw** rather than queue. Every `SaveRecord` says which store it hit, so the skip and `storedHash()` are **per DATS type**, and a record with no type reads as unknown rather than as type 1. `bun cli ledger` |
| `core/src/content.ts` | the one `Bitmap` plus both encoders. **Render to a `Bitmap`, never straight to bytes** |
| `core/src/viewport.ts` | the 24-column window, with `alive()` applied **at the window**: masking a wide bitmap draws a hole that travels with the glyph. Also `LoopModel`: a saved scroll has two loops, `'uploaded'` and the panel's 24-longer one |
| `core/src/playlist.ts` | 2-10 items cycled with no flash per press: statics live, all scrollers packed into one type 1 reel. `Cycler` tracks type 1 residency **itself**, which since track 32 is so a press can be priced before it happens and so a revisit builds nothing at all: the budget's duplicate check is per store now, and no longer re-erases a reel because a drawing went out after it. `notes/playlist.md` |
| `core/src/press.ts` | **the button drives the playlist**, host side: `PressCycle` binds one connection's button to one `Cycler` over `SUB.BUTTON`/`MSG.BUTTON`. **A press cannot spend an erase**, structurally: it steps to the next step priced `free` and over anything needing a `DATS`, holds no reference to `save`, and a crawl asserts the token is absent. `Cycler.forget()` is called before an advance unless suppression is confirmed AND the event carried `INDEX_NONE`, because an unsuppressed press is the `MODE`-discards-the-live-buffer trap with no `MODE` to see. **No flag may ever suppress the 2 s hold**: the subscription lives in the unit's RAM and survives a disconnect, so the hold is what saves a wearer whose phone walked off. All *derived*: the firmware half is **SWD-only**, since a press arrives in the TIMER0 ISR and no slot may run outside a command frame |
| `core/src/tiles.ts` | the tile palette, host side: 16 entries of 3 bytes against a **15-byte notify ceiling**, so a palette is four `TILE_DEF` writes and **is not atomic** while a frame is. `Palette` has no half-defined value and `Painter` keeps a believed-word per entry (the `sender.ts` shape), so `frame()` throws until every entry **the frame uses** is acknowledged. `TILE_FRAME` gets no reply by design, so a lost ACK is handled by re-sending the same step. Masking happens at the window, and it **spends entries**: identical content either side of the notch is two tiles |
| `core/src/subcolumn.ts` | sub-column scroll interpolation, host side. It models the **level** the firmware would ask for, never brightness: the curve belongs to the panel module, so half way is not half light. Two *derived* findings worth knowing: the device's sub-steps are **uneven at most speeds** (an even four-way split exists at only 3 of 10 speed buckets), and the panel's UART is never the binding constraint. Type 1 is one bit per pixel, so `scrollFrames` flattens and refuses grey content |
| `core/src/tempo.ts` | tap tempo: the beat as `interval88`, 8.8 fixed point in **device ticks**, plus an anchor tick. Integer and in ticks throughout, because a float millisecond is where quantisation creeps back, and whole ticks alone would be ~2% out and a full beat adrift inside 30s. A tap lands on the standing grid or it does not (`onGrid`), which is one rule for every span: judging a multi-beat gap by its implied interval accepts **any** gap past 4 beats, and that killed tempo-change detection in the first draft. One stray tap can never move the tempo, two agreeing ones can. Open, and it decides what this is worth: whether the tick is crystal or RC, which `separationMs`/`measuredPpm` make a **ten-second experiment** |
| `core/src/effects.ts` | wide seamless loops, computed in float and uploaded once. `fieldGap()` is the closure check with teeth; `seam()` cannot prove a loop closes |
| `core/src/motifs.ts` | named pictures drawn by arithmetic, not pasted arrays: `ww` (a W per lens, Jacob's Waluigi costume), moustache, zigzag, cap badge, and one wide `wLoop` for the device to scroll. Strokes from named vertices, so a glyph re-scales and follows the geometry constants. All inside rows 2-7, the band alive in every column |
| `core/src/font.ts` | five faces. `band6` (default since track 34), `band5`, `caps5` and `slim5` also scroll; `tall7` is static only because it steps glyphs around the notch. `caps5` is capitals only and exists because the lineup had no face that was both narrow and unambiguous: dropping lowercase removes half of `band5`'s one-pixel pairs by construction, and the five capital ones are solved by hand, giving 0 collisions at 17% less width than `band6`. **Six rows is the ceiling for anything that moves.** `DEFAULT_FONT` is what a **new** message starts as; what a **stored** item with no face recorded renders in is `LEGACY_FONT`, pinned to `band5` for ever, and the two are separate on purpose (*corrected 2026-08-14: this said `DEFAULT_FONT` decides how every stored item renders, which is what kept the default on the less legible face*). `band6` is default because it is the only face with **no two letters or digits one pixel apart**: `band5` has ten such pairs, `slim5` fifteen, and one pixel is a coin toss on a scrolling panel. It costs 21% width, which moved 2 of 34 sample messages off the free 24 columns. `font.test.ts` holds the default to that standard; `fonts/fit.ts` is the registry a picker reads plus the free-or-flash boundary per font |
| `core/src/sender.ts` | `LiveSender`: a desired grid and a believed-sent grid, never a queue of writes. Get one from `Glasses.live()`, never by constructing it, and never interleave `Glasses.show()` |
| `core/src/rhythm.ts` | all 24 columns in one write, bars only. Leave DIY first or the same frame corrupts a column. `research/rhythm-channel.md` |
| `core/src/protocol.ts` | frames. Several helpers build frames the firmware **ignores**, grouped and labelled in the file: never build a UI control on one. Also the `SPEED` ladder, which **saturates**: ten buckets, 91 and above are all divisor 4, so **12.5 columns/second is the fastest the panel scrolls** and a bigger argument is a number the firmware stopped reading. `SPEED_STEPS` is one argument per bucket and the phone's speed row is generated from it. Only the tick patch at `abs 0x18052` moves the ceiling, and that needs SWD. Why streaming and a narrower font are not the way round it: "How fast the panel scrolls" in `notes/protocol.md` |
| `app/src/draw/` | the pad and the canvas arithmetic. The screen over them is `screens/create/DrawPanel.tsx`, which draws offline and mirrors to the panel when connected. Writes no flash and sends no `MODE` |
| `app/src/panel-runs.ts` | the merging both panel grids draw through, and the reason they do: a View per pixel is 216 per panel, the Show tab draws 40, and 9,040 Views took **7.4s** to first paint on a Pixel 10 Pro (measured 2026-08-12; the JS half of the same load was 37ms, so the count of native views was the whole cost). Merging horizontally adjacent pixels that look the same is 2.6x fewer, and what it gives up is the hairline gutter between two neighbours of one colour: a lit area becomes bars rather than dots. The **dead-LED mask lives here**, so `Preview.tsx` and `screens/Library.tsx` cannot disagree about where the panel has no LED; each keeps its own pixel size, because that is theirs. `draw/Pad.tsx` is deliberately not a caller: its pixels are touch targets. The other half of that load is the list props, which is why `initialNumToRender` carries a comment about Views rather than rows |
| `app/src/one-tap.ts` | **the redesign's centre**: `planTap` routes any showable (built-in one command; still content live and clipped, never refused; resident scroller a free `MODE` return; everything else the one flash save behind a sheet) and `runTap` executes exactly the plan shown. The only screen route to the wire; `App.tsx.tap()` is its one caller |
| `app/src/panel-session.ts` | the ONE `LiveSender` a connection is allowed, owned above every screen. `live()` is safe to race; `dropped()` after anything that takes the panel (`MODE`, `ANIM`, `IMAG`), because a taken buffer must be forgotten, never repaired |
| `app/src/settings.ts` | what persists between sittings: brightness/speed/direction defaults (applied on connect), per-pair theme colours and the remembered pair for auto-reconnect, keyed on the advert name like the ledger. `theme.ts` is the palette (eleven entries: ten hues plus a neutral, ordered round the wheel) and the context, and it holds the **lit-pixel levels** too, so the compose preview, the draw pad and the library thumbnails wear the pair's colour instead of the three greens each used to write out; level 3 is the accent and `theme.test.ts` fails the build if a grid names a lit colour of its own |
| `app/src/carried.ts` | **what a pair turned out to be**: one caught `probe()` per connection, owned by `App.tsx` and nowhere else, remembered per advert name, plus the capability gate and the only wording of it. `can()` gates on the **bitmap, never the version**, so a v1 app is safe against a v2 unit and the reverse; bits the app has no name for are counted and never labelled. A stock pair's silence is an **answer**, not a failure, and a test fails the build if any sentence about one reads as an error. Last sitting's answer is deliberately not assignable to the gate, because a unit can be reflashed between sittings, and `firmwareUpdate` is refused however the bit reads. Every crew branch is unreachable today: no unit carries the extension, so the only branch a real pair can produce is the stock one, and **that has not been looked at on a handset either** |
| `app/src/ble-words.ts` | ble-plx's failures said in the name on the screen. **A platform handle must never reach a person**: it is a MAC on Android and a per-install UUID on iOS, and nothing else in the app is keyed on it. `pairWords(e, name)` is the only wording of a caught BLE error, and the name comes from `App.tsx`'s `pairName` or the row the tap was on |
| `app/src/proximity.ts` | the Scan count of pairs nearby, from adverts only: it holds `scan`/`stop` and cannot connect. A missing RSSI arrives as `0` or `127`, which is **stronger** than any real reading, so use `signalText`/`bandOf` rather than the number |
| `app/src/spray.ts` | **other people's pairs**: one still picture at everything in range that is not yours, over the live buffer, so **no flash is spent on anybody's unit** and the wearer clears it with a power cycle. `decide()` is the whole consent policy (`never` beats `always`, `already` beats `ours`, crew skipped for want of a key), `runSpray` is scan-drain-rest, and the wire is four injected functions so the passes run under `bun test`. It builds **no `LiveSender`** (the shell owns the one) and no event carries a platform handle. The screen is `screens/Spray.tsx`, off the Glasses tab, and starting one **lets your own pair go**, because a scan calls `release()`. **Unwitnessed where it counts**: nothing has confirmed the panel keeps the frame after the disconnect, and `SMVEW 02` is still unsent (`notes/what-to-build.md`, "spraying a temporary image at nearby pairs"; the CLI's text version is `cli/src/broadcast.ts`) |
| `app/src/builtins.ts` | the 11 built-in pictures and 19 built-in animations, with a real thumbnail each, lifted from the firmware image offline by `research/tools/bankdump.ts` (`bun run bankdump list\|sheet\|check`) into generated `builtins-data.ts`. `commandFor()` is the only place the addressing lives: `IMAG n` is frame n of one bank, `ANIM n` is mode n + 5, and **that mapping is *derived* and disagrees with what the vendor app sends** (`research/firmware-internals.md`, "`IMAG n` is mode 25"). Showing one writes no flash but takes the panel from the DIY buffer and any resident type 2 image, which is what `TAKES_THE_PANEL` says (*corrected 2026-08-12: this said `screens/Library.tsx` asks before, and it no longer does. Jacob's confirmations ruling took the question off the screen, `builtins.test.ts` now asserts the screen never names that sentence, and nothing imports it*) |
| `app/src/library.ts` | the phone's own saved content: `SavedDrawing`/`SavedText`/`SavedEffect`, **the recipe and never the rendered pixels**, `revive()` the trust boundary, over `library-store.ts` and its own `library.json`. `search()` matches an item's name and a text item's body and **nothing else**: the 30 built-ins are browsed and never searched, because track 20 numbered rather than named them and a name invented off an offline render is a guess a user would then search for and fail to find. `screens/Library.tsx` says that on the empty state instead of looking as though it lost them (`notes/library.md`) |
| `app/src/reel.ts` | the phone's side of `playlist.ts`: the favourites committed as ONE type 1 save, after which switching between members is `SPEED` + `MODE` and no flash. `planReel` says whether the pair already holds this exact set (free to resume); `reelDriver` routes the live half through `PanelSession`, never `Glasses.show`, because the app is allowed exactly one `LiveSender`. The answer to "can we really not have more than one saved slot?" |
| `app/src/deliver.ts` | the three ways content reaches the panel and what each costs, as `costOf()` sentences the UI prints verbatim. `showNow` is free; `deliver()` type 1 is the app's only flash write; type 2 keeps the grey and gets **no `MODE`**, because `MODE` is what discards it. Grey is a costed choice (`greyChoice`), never a bare refusal, and `SaveOpts.cancel` makes an upload free to abandon right up to `DATCP`. **`MODE` goes out only on `SaveResult.committed` or a skip**: `status: 'saved'` means the erases were spent, not that the device took it. The `SPEED` ladder is `protocol.speedDivisor`, not the app's |
| `app/src/effects-ui/` | the phone's side of `core/src/effects.ts`: `catalogue.ts` is which knobs a thumb gets per generator, `plan.ts` prices and checks one loop. **Rendered at 2 levels always**, and not as a preference: a wide loop with grey in it is either a type 2 the device shows 24 columns of or a flatten that lights every dim pixel, and the flatten is the silent default, so there is no levels control (`plan.MONO_NOTE` is that sentence, on the screen, added by review 13 because it existed only in docblocks). `plan.problems` refuses exactly one thing core does not, a loop with **nothing lit**: `offered.test.ts` walks all 1332 combinations the buttons reach and one of them rendered 736 dark columns under an enabled button. The screen is `screens/create/Effect.tsx` since the redesign: no width control and, since track 28, **no `WIDTHS` ladder to import back** - a loop with no width named renders at `fx.MAX_COLUMNS` (`notes/library.md` "Width is not a question worth asking"; the widths still walked in the tests are the ones a stored recipe can carry), a free Still option through the live buffer, and **no session at all** - it plans and the shell runs - which `wiring.test.ts` holds it to |
| `app/App.tsx` | **rewritten 2026-08-12, track 26**: three tabs (Show, the library front door; Create, Message/Draw/Effect; Glasses, scan/auto-reconnect/per-pair dashboard). Owns the one connection, the one `PanelSession`, `live` (unsaved panel work), `resident` (the pair's last acknowledged type 1 hash), the library items and `tap()`, the sole `runTap` caller. Every screen mounts with nothing connected (review 17's lesson, promoted to the whole app); the tab bar gates on `wire` mid-upload. The accent colour is the connected pair's theme |

**What has actually run on hardware.** The save path has: track 5's `bun run
packages/cli/src/type2.ts` drove `Glasses` on 2026-08-09, after the transport
extraction. `rhythm.ts` has not. **`LiveSender` and the draw screen have**, on
2026-08-09 from the Pixel: `SMVEW 01`/`LEDON`, then 210 live column writes over 49s
across 21 of the 24 columns and all 9 rows, then `CLRL` alone on a lit panel
(*Corrected: this said the draw screen had never been rendered on a handset. The wire
log is `packages/app/.expo/dev/logs/start.log`, and it decodes with the vendor key.*)
**What that proves is the wire, not the panel**: nobody has said what the drawing or
the clear looked like, so the row orientation, the greys and `CLRL`'s effect are all
still unwitnessed.

**The firmware side has run too, as of 2026-08-20.** The whole SWD write path drove real
silicon: 150 pages erased and programmed through the FMC's ISP registers, 19,200 words,
every one read back twice, and `GLASSES-12C3EF` came back from twelve days dead. `APUEN`,
both write opcodes against APROM, **512-byte erase granularity** and "a flashed unit
boots" all moved from *derived* to *verified* in that run. **What is verified is a donor
image, not ours**: `joggles-v1.bin` has still never run anywhere and is still barred.
`research/aprom-write-2026-08-20.md`.

## Traps that fail silently

- **A freshly flashed unit looks exactly like a bricked one, and the button is how you
  tell them apart.** Three things stack up, all *verified* 2026-08-20 by walking into
  them. The write script **halts the core and never resumes it**, so when it prints
  `DONE` the new firmware has never executed and `ICSR` still shows the *old*
  HardFault. **The on-board button is polled by firmware**, so "power-cycle from the
  unit's own button" is a no-op on a halted or faulted unit. And a repaired unit then
  sits switched **off**: dark panel, no advert, **and SWD stops answering** ("cannot
  read IDR") because the MCU sleeps. That is the same picture as the brick. So:
  `reset run` over SWD, check `ICSR` at `0xE000ED04` (`VECTACTIVE` 3 is HardFault, 0 is
  Thread), then a **long press** to switch it on. The red charge LED is driven by the
  charger IC, not the MCU, and tells you nothing either way
- ONE 16-byte block per ATT write. The panel decodes the first and drops the rest with
  no error, which reads as corruption
- Write-without-response has no flow control: pace the writes or columns go stale. One
  frame costs 6.42ms on the module's UART, so streamed full frames sweep visibly; use
  DATS for clean motion. **The pacing floor is measured now**: 6ms dropped nothing on
  2026-08-12 (12 columns of 12, by eye), and `protocol.PACING_MS` is 10, keeping headroom
  because BLE negotiates its interval per connection and a dropped column is silent
- **Only DATS type 1 persists**, and `savedType()` picks the type from whether the
  content has grey in it, so **one grey pixel decides whether a save lasts**. Type 1
  holds 740 columns; type 2 is accepted to 383 and displays 24
- **A type 2 image displays on `DATCPOK` by itself, and `MODE` is a one-way door away
  from it**: `MODE 01`/`02` switch to the type 1 flash store and nothing switches back
- `MODE` sent while in DIY switches to saved content and discards the live buffer.
  `SMVEW 00` restores the saved image, which looks like stray pixels; default
  `end('keep')`
- `LEDOFF`/`LEDON` are **not implemented** and `LIGHT` floors at level 1. `CLRL` is the
  atomic clear, undocumented and never sent by the vendor app
- `CHAR_BULK_A`/`_B` are not interchangeable: A is the DATS stream, B is live
- BLE is one connection per device, but one phone can hold several devices
- **The device appends ~24 blank columns to a scrolling type 1 save, so the panel's
  loop is 24 columns longer than the bitmap.** A preview that walks the bitmap alone
  shows no gap where the panel shows a full screen of it: that was a real bug, fixed in
  `app/src/Preview.tsx` by walking `viewport.frames(..., { loop: 'panel' })`. A client
  gap **adds** to the device's, which is why `content.SCROLL_GAP` is 0: it is what
  yields the one screen width, and 24 yields two. Measured off the app's wire log plus
  one look at the panel; whether the 24 survives without a restore from flash is the
  open half: `research/loop-gap-2026-08-10.md`

**What is still unproven, and the order to settle it in**: the seven-item list in
`notes/app-plan.md`, "Verify before building". The three *derived* claims the code already
leans on are **the DATS row mapping**, which every rendered pixel sits on (verify item 1),
`CLRL` clearing the panel, and type 2 showing only its first 24 columns (one null
observation by eye).

## Our firmware: built, and it must not be flashed to anything

**`firmware/joggles-v1.bin` MUST NOT GO ON ANY UNIT.** *verified on silicon* 2026-08-19,
against a dump of the healthy `GLASSES-12E69E`. It is built on the vendor APK's
application image, and **no pair here runs that image**: a healthy unit populates 26
callback slots, the APK's registrar fills 22, and the four it omits (`+0x5c` to `+0x68`,
RAM `0x20000070`-`0x2000007c`) are exactly what the application later branches through.
That is what bricked `GLASSES-12C3EF` on 2026-08-08, at the `bx` at `abs 0x10f54`.
`ota.check(image, { reference })` refuses it against a healthy dump, naming that
instruction. `research/hardfault-0xd38-2026-08-19.md` and `research/image-silicon-match.md`.

*Corrected 2026-08-19: this section was headed "built, not yet flashed" and read as work
waiting for a courier. The image is not merely undelivered, it is unsafe, and the bar
covers healthy units too rather than just the broken one.*

**The rebase is done, and it is `firmware/joggles-v2.bin`.** A 256 KB dump of `12E69E`
is `firmware/dump-12E69E-2026-08-19-*.bin` (gitignored, backed up outside the repo) and
is the only copy of the correct firmware that exists off-device.

    bun run build-firmware firmware/joggles-v2.bin \
      --from-donor firmware/dump-12E69E-2026-08-19-a.bin \
      --from-donor firmware/dump-12E69E-2026-08-19-b.bin --into-fill

It passes `ota.check` with the donor's own dump as the reference: `device-match: all 23
dispatched callback slots are registered`, `referenceUnregistered === 0`, no fatal
findings. **That is the check 2026-08-08 did not have**, and it is the one that refuses
`joggles-v1.bin`. *Still unflashed, and nothing goes on a unit without Jacob.*

*Corrected 2026-08-20 by track 64, and this paragraph was **false when written**. The gate
**refused** the correctly rebased image and passed the APK-derived one, exactly backwards:
`expect` defaulted to `DEVICE_VERSION`, which is the APK's `TR1906R04-10`, so v2's honest
`-12` read as the wrong variant. A dump now sets the expectation, and the sentence above is
true as of that fix and pinned by tests against both real images. Two more of the same
kind: `comparePatch` diffed v2 against a stock of a **different build** and produced eight
fatals of which every one was wrong, while the same-variant case failed **silently**; and
the "check 2026-08-08 did not have" had never actually run, because it was a warn on every
path and no CLI passed a reference at all.*

**`bun run ota-check <image> --reference <dump>` is how you actually run the gate**, added
2026-08-20, and until it existed the silicon half was unreachable from a terminal. Both
directions are now checked and this is the command to use before anything is flashed:

    bun run ota-check firmware/joggles-v2.bin --reference firmware/dump-12E69E-2026-08-19-a.bin

v2 passes, with `device-match: all 23 dispatched callback slots are registered`. v1 is
REFUSED with three fatals, one of them `unregistered-callback` naming the `bx at 0x10f54`
and saying "This is the 2026-08-08 brick". `--for-commit` promotes the unanswered questions
to fatal and is what any caller about to reach the wire passes. One trap it now handles
rather than inflicting: the **defaulted** stock baseline is the APK's `-10`, so on a
donor-rebased `-12` image it is ignored with a note instead of becoming a fatal, because a
gate that refuses the honest image is how someone learns to skip it. An **explicit**
`--stock` of the wrong build is still fatal, since that is a false assertion rather than a
bad guess.

**Everything about the donor build had to be re-derived, and one of them would have cost
ten opcodes.** `research/donor-dispatcher-2026-08-20.md`: the donor is `TR1906R04-12`,
73,616 bytes, and the APK is `TR1906R04-10`. The opcode is in `r1` rather than `r2`, the
`LOOP` block is 32 bytes rather than 28, and **its last four bytes are a `bl set_mode`
that ten other dispatcher arms branch into**, so the old 28-byte hook would have silently
taken ten commands out. `ext.branchesInto` found that before anything was built, which is
what the "scan for branches first" rule is for. The hook is **four bytes** now: one `bl`
over a compare that can never fire, costing no vendor opcode on either build.

**The delivery route is no longer theoretical.** On 2026-08-20 that donor image was
written onto `GLASSES-12C3EF` over SWD, 150 pages, and the unit came back. So Track C
needs a rebased image and nothing else. *verified* on silicon by that run, none of it
before: `APUEN`, `ISPCMD 0x22` and `0x21` against APROM, **512-byte erase granularity**,
that a ~136,000-transaction session survives (~12.5 min at 100 kHz), and that a flashed
unit boots. `research/swdflash-review-2026-08-20.md` is the adversarial review that had
to happen first, and its finding is the reason to read it before flashing anything: the
tool as it stood would, on one wrong assumption, have reported success while leaving half
the window erased.

`bun run build-firmware` emits an image: stock plus a `JGX1` extension in free flash,
**one four-byte dispatcher hook**, the crew AES key and an advert rename. One opcode,
`J`, whose first payload byte is a sub-command, so every future feature is a new
sub-command in free flash and **no further edit to the vendor's code**. `bun cli probe`
asks `HELLO`; a stock unit and a wrong-keyed crew unit both answer with silence.

On the donor base that is 1,228 bytes at `abs 0x28800`, page-aligned, in the 3,072 bytes of
programmed zeros at the top of the window (`--into-fill`, and the placement is
page-aligned rather than word-aligned because an `adr` in the data tail names an address
16 bytes past it). `EXT_BASE 0x26a24` is where the *APK's* image ends and means nothing
on a real unit.

**The extension can now replace itself over Bluetooth, and that is what the 1,228 bytes
are.** `notes/patch-over-bt.md`: a **resident** half written once over SWD that can never
be rewritten over the air, plus two **slots** in the OTA staging bank at `0x29400` and
`0x2b400` carrying every feature and replaced alternately. `HELLO` and the five `UPD_*`
sub-commands are resident and are dispatched before any slot, so a slot whose code faults
cannot make a unit unreachable by the commands that replace it. *That ordering was
**vacuous** until 2026-08-20: review 33 found there was no slot dispatch at all, so nothing
above the resident table was ever reached and the guarantee had nothing to guard. Track 60
built it, resident table first, and executed it in the simulator. The rule that keeps it
true is that **no slot feature may run outside a command frame** (no ISR, no per-tick
hook), which is why notify-on-button-press cannot be a slot and stays SWD-only.* The magic
word is
programmed last, so a failed update is not a state to recover from, it is a slot whose
magic never landed with the live slot untouched. **A bug in the resident half is
probe-only**, which is why the probe stays on unit 1 and why that half is deliberately
boring.

**The firmware is executed offline, not just assembled.** `research/tools/thumbsim.ts` is
an ARMv6-M interpreter plus a model of this FMC, and `updater.test.ts` drives the whole
loop through it: three updates round the A/B pair, a wrong CRC, an interrupted transfer,
an out-of-range sequence, and a sweep proving nothing outside the slots is ever written.
It also runs the vendor's own `LOOP` and `LOOA` arms through the hooked dispatcher and
gets `set_mode(24)` and `set_mode(35)`, which checks the interpreter as much as the hook.
**What a pass is worth**: the model does not cover time, interrupts, or the BLE stack
running concurrently, and its own header says so.

`bun run flash` is the way on, and its subcommands are the safe procedure in order:
`info` writes nothing, `stage` streams but never commits, `commit --yes` is the one
barred below and `flash.ts` refuses it outright without `--ldrom-verified`. **LDROM was
dumped on 2026-08-19 and has now been read** (track 48, `research/ldrom-2026-08-19.md`):
the answer is still **no** to `--ldrom-verified`, because the bootloader has no recovery
entry point (no radio, no GPIO/button, transmit-only UART), so nothing makes a commit
survivable. **SWD is the delivery route and it is fully proven**: on 2026-08-20 it erased
and programmed all 150 pages of the application region and brought a dead unit back
(`research/aprom-write-2026-08-20.md`). That is what makes the OTA bar affordable rather
than painful: there is a working way on that does not involve the bootloader. Design and
the first-flash procedure: `notes/firmware-design.md`. Wire
formats: `core/src/jgx.ts`, `core/src/dfu.ts`. Assembler: `research/tools/thumb.ts`.
The crew key is `firmware/crew-key.json`, generated on first build and gitignored.

## Don't

- **Send OTA ctrl `03` (commit) to anything.** On 2026-08-08 a *stock over stock* commit
  bricked `GLASSES-12C3EF`. **Repaired 2026-08-20 over SWD** by writing a healthy pair's
  application region across; it advertises again and answers as stock. The cause, found by
  track 48 and track 47: **the vendor APK's application is not the application these units
  run.** It is 7,532 bytes smaller and its registrar fills 22 of 26 callback slots, so the
  app tail-calls through an uninitialised RAM pointer at `0x20000074`. `CONFIG0` was never
  implicated; `0xFFFFFFBF` is what the bootloader writes on purpose, and the config repair
  run first did nothing. `research/brick-2026-08-08.md`, `research/ldrom-2026-08-19.md`,
  `research/hardfault-0xd38-2026-08-19.md`, `research/variant-mismatch-2026-08-19.md`.
  **The bar stays down and the repair does not lift it.** The bootloader has no recovery
  entry point at all (no radio, no button, transmit-only UART), so a commit that hands to
  it is exactly as unsurvivable as it was; what changed is that SWD can now undo one
- Send any image that has not passed `ota.check()` (`bun run ota-check <image>`). It is
  the gate and it already encodes every limit here
- Relink the firmware, exceed **76,800 bytes** (the application region), or send OTA
  `type 2`. Flashing a *patched stock* app image over BLE is otherwise safe: the OTA
  stages at `0x29400` and never erases the running app. What is not safe is an image
  that fails to bring up BLE, since the OTA service lives in the app, and anything over
  ~84 KB, which erases the bootloader. Read `research/firmware-flashing.md` first
- **Overwrite a block of firmware without first scanning for branches into it.** The
  `LIGHT` arm at `abs 0x184a6` jumps into the middle of the `LOOP` block, and two of our
  own documents said that block had one entry point
- Commit vendor binaries: `apk/`, `decompiled/`, `native/`, `firmware/`
