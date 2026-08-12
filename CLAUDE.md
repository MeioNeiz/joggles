# Joggles

LED glasses, app Funky Glasses+. Protocol solved, verified on hardware.

## Where to look

| File | What it holds |
| --- | --- |
| `notes/plan-after-the-brick.md` | **the firmware-delivery plan**: three tracks, the rules for unit 2 including the `--ldrom-verified` gate, and the SWD order of operations. For app work the current plan is `notes/parallel-tracks.md` plus `notes/app-plan.md` |
| `notes/protocol.md` | key, frames, command table, panel geometry |
| `notes/app-plan.md` | the phone app, the flash-wear numbers, and the ordered "Verify before building" list |
| `notes/what-to-build.md` | delivery routes, ranked patches, festival ideas, what we decided against |
| `notes/playlist.md` | the cycled playlist: why stock's button cannot do it, the one-reel design, and the residency defect |
| `notes/library.md` | the phone's saved content: the three things called "the library" kept apart, store-the-recipe, why width is not a question, and what the four faces are for |
| `notes/firmware-design.md` | our own firmware: architecture, wire formats, roadmap, safety envelope |
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
- `bun cli <probe|text|edge|off|bench|stress|ledger>` needs a device. `bun run
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
| `core/src/effects.ts` | wide seamless loops, computed in float and uploaded once. `fieldGap()` is the closure check with teeth; `seam()` cannot prove a loop closes |
| `core/src/motifs.ts` | named pictures drawn by arithmetic, not pasted arrays: `ww` (a W per lens, Jacob's Waluigi costume), moustache, zigzag, cap badge, and one wide `wLoop` for the device to scroll. Strokes from named vertices, so a glyph re-scales and follows the geometry constants. All inside rows 2-7, the band alive in every column |
| `core/src/font.ts` | four faces. `band5` (default), `band6` and `slim5` scroll; `tall7` is static only because it steps glyphs around the notch. **Six rows is the ceiling for anything that moves** and `DEFAULT_FONT` decides how every stored text item renders, so faces are added beside it, never over it. `fonts/fit.ts` is the registry a picker reads plus the free-or-flash boundary per font, which moves when the font does |
| `core/src/sender.ts` | `LiveSender`: a desired grid and a believed-sent grid, never a queue of writes. Get one from `Glasses.live()`, never by constructing it, and never interleave `Glasses.show()` |
| `core/src/rhythm.ts` | all 24 columns in one write, bars only. Leave DIY first or the same frame corrupts a column. `research/rhythm-channel.md` |
| `core/src/protocol.ts` | frames. Several helpers build frames the firmware **ignores**, grouped and labelled in the file: never build a UI control on one |
| `app/src/draw/` | the pad and the canvas arithmetic. The screen over them is `screens/create/DrawPanel.tsx`, which draws offline and mirrors to the panel when connected. Writes no flash and sends no `MODE` |
| `app/src/panel-runs.ts` | the merging both panel grids draw through, and the reason they do: a View per pixel is 216 per panel, the Show tab draws 40, and 9,040 Views took **7.4s** to first paint on a Pixel 10 Pro (measured 2026-08-12; the JS half of the same load was 37ms, so the count of native views was the whole cost). Merging horizontally adjacent pixels that look the same is 2.6x fewer, and what it gives up is the hairline gutter between two neighbours of one colour: a lit area becomes bars rather than dots. The **dead-LED mask lives here**, so `Preview.tsx` and `screens/Library.tsx` cannot disagree about where the panel has no LED; each keeps its own pixel size, because that is theirs. `draw/Pad.tsx` is deliberately not a caller: its pixels are touch targets. The other half of that load is the list props, which is why `initialNumToRender` carries a comment about Views rather than rows |
| `app/src/one-tap.ts` | **the redesign's centre**: `planTap` routes any showable (built-in one command; still content live and clipped, never refused; resident scroller a free `MODE` return; everything else the one flash save behind a sheet) and `runTap` executes exactly the plan shown. The only screen route to the wire; `App.tsx.tap()` is its one caller |
| `app/src/panel-session.ts` | the ONE `LiveSender` a connection is allowed, owned above every screen. `live()` is safe to race; `dropped()` after anything that takes the panel (`MODE`, `ANIM`, `IMAG`), because a taken buffer must be forgotten, never repaired |
| `app/src/settings.ts` | what persists between sittings: brightness/speed/direction defaults (applied on connect), per-pair theme colours and the remembered pair for auto-reconnect, keyed on the advert name like the ledger. `theme.ts` is the palette (eleven entries: ten hues plus a neutral, ordered round the wheel) and the context, and it holds the **lit-pixel levels** too, so the compose preview, the draw pad and the library thumbnails wear the pair's colour instead of the three greens each used to write out; level 3 is the accent and `theme.test.ts` fails the build if a grid names a lit colour of its own |
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

## Traps that fail silently

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

## Our firmware: built, not yet flashed

`bun run build-firmware` emits `firmware/joggles-v1.bin`: stock plus an 88-byte `JGX1`
extension at `abs 0x26a24`, one 28-byte dispatcher hook, the crew AES key and an advert
rename. One opcode, `J`, whose first payload byte is a sub-command, so every future
feature is a new sub-command in free flash and **no further edit to the vendor's code**.
v1 has `HELLO`; `bun cli probe` asks, and a stock unit and a wrong-keyed crew unit both
answer with silence.

`bun run flash` is the way on, and its subcommands are the safe procedure in order:
`info` writes nothing, `stage` streams but never commits, `commit --yes` is the one
barred below and `flash.ts` refuses it outright without `--ldrom-verified`, which nobody
can honestly pass until LDROM has been dumped. Design and the first-flash procedure: `notes/firmware-design.md`. Wire
formats: `core/src/jgx.ts`, `core/src/dfu.ts`. Assembler: `research/tools/thumb.ts`.
The crew key is `firmware/crew-key.json`, generated on first build and gitignored.

## Don't

- **Send OTA ctrl `03` (commit) to anything.** On 2026-08-08 a *stock over stock* commit
  bricked `GLASSES-12C3EF`: staging fine, the device's own CRC matched, it reset itself
  and never came back, so the fault is the handoff into LDROM rather than the image.
  `bun run flash stage` is still safe and was run on that unit with no harm. The whole
  persistent change is `CONFIG0 = 0xFFFFFF3F` and the repair is one erase of the config
  page at `0x00300000`: `research/brick-2026-08-08.md`, and "Incident" in
  `research/firmware-flashing.md`. Lift this bar only once LDROM has been dumped
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
