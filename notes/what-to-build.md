# What to build

**This file is judgement, not findings.** Every factual claim it leans on is recorded
with its evidence and confidence in `research/`, chiefly
`research/firmware-internals.md`. Nothing here is verified by anything except argument,
so treat it as a plan to be disagreed with rather than a reference.

Written with a festival in mind: things strangers can interact with, that survive a
phone being in a pocket or dead, and that do not require babysitting.

## Handset feedback, 2026-08-11: the first session anyone used the app to show text

**Kept verbatim, because a paraphrase loses the complaint.** Jacob, holding the phone with
the glasses connected, at the point where every screen had been built and none had been
looked at. Every item below is either fixed or a board track, listed against it. This is
the intake the board's "Feedback from using it" rule points at.

| What he said | What it turned out to be | Where it went |
| --- | --- | --- |
| "why is show now greyed out?" | Motion was `Scroll`, and the reason was printed under the button in the **same grey as the cost caption** under the working button. The saved path already styled its problems red; the live path did not | **Fixed**: blocked reasons now read as blocked, and name the remedy |
| "stati also wont show rn" | `JOGGLES` is 27 columns and the live buffer holds 24, so it was refused outright | Track 23 |
| "Text thats too long should still show, just go off the screen" | Refusing was the wrong call. The window can clip; `viewport.windowAt` already applies `alive()` at the window | Track 23 |
| "you were able to make text scroll without saving it to the device first right? So it should be possible now?" | **Right, and a claim of ours was too broad.** `bun cli text` scrolls host-driven over the live channel with no flash and has run on hardware. What cannot scroll is the *device's* live buffer on its own; the phone can animate it | Track 23 |
| "The second time i try to show text it seems to turn them off" | **Real defect, and the worst kind: it made the app look like it broke the hardware.** A cleanup-only effect latched `mounted` false (Fast Refresh re-runs effects while preserving refs), so `ensureLive()` threw on every press *after* `begin()` had sent `SMVEW 01`, which clears the live buffer. Seven writes in the log, all `9600`, not one `960b` | **Fixed** in `Connected.tsx` |
| "How many saves do you think i can do?" | The app shows the **phone's** count. It read "2 saves to this unit, ever, 10 page erases" while this Mac's ledger held 11 for the same unit. "Ever" is false in a number whose only job is warning about wear | Track 24 |
| "the app feels really unintuitive right now because just showing text feels quite hard, I think the text creator should be one screen and then just a kinda grid with all the saved words where i can select them" | The screen exposes the protocol's shape rather than the task's: Motion, Direction, Speed, Ink and Panel all sit between typing a word and seeing it | Track 22 |

Later the same session, once the Effects screen was driven against a wide loop:

| What he said | What it turned out to be | Where it went |
| --- | --- | --- |
| "Left scrolling animations are seamless, right scrolling have a big gap, is this avoidable? Okay if not" — then "Neither direction was seamless, its just scrolling left i didnt see the cut off as quickly" — then **"both scrolling directions have a dead space just one direction shows it at the beginning of the animation so i saw it earlier"** | **Both directions have dead space, and the direction decides *where in the pass* it falls.** Which fits the store exactly: `[24 blank][content][24 blank]`, so a forward pass meets the trailing blank last and a backward pass meets the leading blank first. Took three goes to write down, and **both wrong versions were the same mistake** - paraphrasing an observation instead of keeping it. Version 1 turned "I saw a gap in one direction" into "direction is a variable the bracket model missed". Version 2 turned "I saw it earlier" into "the viewer did not notice", which discarded the mechanism he had actually handed over. Only version 3 has a device behaviour in it, and it *supports* the bracket model rather than impugning it | Finding plus both corrections in `research/vendor-app-protocol.md`. Yields a real default for track 25/26: prefer the direction that hides the dead space at the **end** of a pass. Gap **size** still open (one panel width or two) |
| "animations should be able to be static as well" | Fair, and cheap: an effect is already a still image whose traverse reads as motion, so static is one 24-column window and no `MODE 02`. **It also fits the live buffer, so a static effect can cost no flash at all** | Track 25 |
| "i can believe you need to save for animations, so thats maybe not a bug" | Correct, and worth recording as a retraction rather than dropping. A wide loop must be a type 1 save: the live route holds 24 columns and the device only scrolls its saved store | No action. The constraint is real |

**The lesson worth keeping.** Every one of these was invisible to the test suite, and four
of the five reviews that ran that evening had closed with "nothing screen-level has been
seen". A suite at 673 green and an app whose main action silently blanked the panel are
not in tension: nothing asserted what a person sees, because by this repo's own
convention that is checked by looking. The looking is the gap, not the tests.

## Handset feedback, 2026-08-11, second session: the whole shape of the app

Same day, 23:50, after the parallel session had landed the Library screen, the Effects
screen, nicknames and the playlist engine, most of it never seen on the handset. This
time the complaints are not about single defects but about the shape, and the verdict
was "its almost like the whole app needs a redesign". Jacob handed one session, the
Fable redesign, exclusive control of the phone and glasses to do exactly that: track 26
on the board, and every row below lands there.

| What he said | What it turned out to be | Where it went |
| --- | --- | --- |
| "Glasses and effects are weird headers and not very app like" | The nav is two bare text labels over whatever screen is up, and screens carry headings like "Wide loops". There is no navigation structure an app user would recognise | Track 26: real tabs |
| "There is too much writing everywhere when i dont need it" | Screens print the research's own epistemics at the user: "Which way Dir 1 goes is unconfirmed", seam gap numbers, ledger sentences, multi-line cost captions under every button. The writing is all true and none of it is his problem | Track 26: a copy budget. Captions get a few words; the full sentence moves behind the one step that spends flash |
| "the show now and save to glasses buttons feel a bit weird when i have to scroll to them" | Compose is one long ScrollView with ten control rows between the input and the actions | Track 26: actions pinned, controls cut to what the task needs |
| "Would be more okay if there was an area i could easily save text and things i make to on the phone" / "i need an area where its just one click, i can easily see what the animation/text is and then select it" | **Built and never mounted.** `screens/Library.tsx` (track 20) lists his saved items and all 30 built-ins with real thumbnails, and no screen in the app could reach it, so nothing he made was visible anywhere. The playlist engine (track 18) is the same story one layer down | Track 26: the library becomes the front door, one tap to show |
| "how does saving to glasses work? If i save an animation, put another thing on screen, do i have to save again before I can use it? hopefully it remembers the position or something on the device" | **The device does remember, and the app never says so.** One saved item per type, no slots; showing something live does not touch it, and one free `MODE` returns to it; only saving something different evicts it, and re-sending an identical payload is skipped free by the budget guard. Nothing in the UI models residency, so the user cannot tell a free return from a five-erase re-save | Track 26: a visible "on the glasses" state, and free returns routed as `MODE`, never `DATCP` |
| "Why do i have to select panel setting each time? Should be a default" | Brightness is mount-scoped React state; nothing persists it, nothing applies it on connect | Track 26: a settings store, defaults applied on connect |
| "The clear panel and so many other things are just not very app like" | Clear is a conditional green text link that appears and vanishes with `live` | Track 26 |
| "A lot of the current animations just seem buggy and not great. Way too much text, and the flow of saving" | Three candidates, none checked by eye: no effect has ever been seen on the panel, the `ANIM` numbering is disputed (a tap may play a different built-in than its tile, `protocol.animation`'s docblock), and 2-level flatten makes some generators near-solid | Track 26 for the flow and the text; the sitting for which animations are actually wrong |
| "Even the scrolling animations, repeat really weirdly. I dont want a space where they just kinda dont work" | The firmware's own doing, in two known parts: the device brackets a saved scroll with ~24 blank columns (`research/loop-gap-2026-08-10.md`, one open half), and direction 1 gaps where direction 0 is seamless (verified by eye earlier the same evening). The app still offers both directions as equals with an "unconfirmed" caption | Track 26: seamless direction is the default and the other says it gaps; the sitting settles the bracket's open half |

Three more arrived mid-redesign, while the rewrite was underway:

| What he said | What it turned out to be | Where it went |
| --- | --- | --- |
| "you can basically scrap a lot of the existing ui, i kinda want you to start quite fresh ... think they will be used at a festival where ease of use when i am out using them i really important" | The design brief, sharpened: the governing scenario is a dark field, one hand, seconds of attention. Big targets, one-tap show, auto-reconnect to the remembered pair, defaults already applied | Track 26: the design's framing |
| "be able to set whatever theme i want depending on what glasses im connected to to make it easier to know what im on" | Several pairs at a festival are indistinguishable in the app the way they are in a scan list. A per-pair accent colour, picked once and stored on the phone, recolours the whole app while that pair is connected | Track 26: per-pair themes in the settings store |
| "i need to be able to clear text/animation from what i saved, it should manage what is on each glasse itself as well" | Two things. Delete existed only for drawings, buried on the Draw screen; texts had no delete anywhere. And residency is per device already (the ledger is keyed on the advert name), the app just never showed it: matching each ledger's last acknowledged save against the library's own payload fingerprints names what each pair is holding | Track 26: delete on every library item; per-pair "holding" state |

**The lesson this batch adds to the last one.** The first session's lesson was that
nothing asserted what a person sees. This one is about altitude: every complaint here
was invisible at the level of a single screen's correctness, because each screen was
individually defensible and the app as a whole was still the protocol wearing a UI. The
fix is not more care per screen, it is one owner for the whole shape, which is what
single-instance mode is.

## Handset feedback, 2026-08-12: the library, the preselect grid, and controls that ask too much

Jacob, mid-redesign, after a research pass on animations. Kept verbatim per the board's
rule. **This batch is not defects: it is one theme, that the app asks the user questions
the repo already knows the answer to.** The judgement it produced is `notes/library.md`,
and the tracks are 28 and 29.

| What he said | What it turned out to be | Where it went |
| --- | --- | --- |
| "We can have bascially as many saved animation and images and stuff on the phone as we like, there should be a whole library i can search and select from to add to my preselectable ones" | Right, and the library holds less than he thinks: `library.ts` has `SavedDrawing` and `SavedText` only, so **an effect loop cannot be saved at all** and nothing made on the Effects screen can be found again. There is no search anywhere | Track 28. The rule it needs is store the recipe, not the pixels: a 736-column loop is 6,624 levels of JSON and re-renders from about five numbers |
| "The preselectable screen should be quite a space efficeint easy to use, like click and then it shows" | A third thing called "the library", and it does not exist. **Not the same as `core/src/playlist.ts`**, which is 2-10 items the *device's own button* cycles and is a firmware feature on stock. Blurring the two would build the wrong one | Track 28. `notes/library.md` keeps the three terms apart |
| "Text should probably auto scroll if it would go off the screen, and not scroll when it fits" | Correct, and it deletes the worst control in Compose. **The trap is that the boundary is also a price change**: 24 columns or fewer fits the live buffer and is free, one column wider is five page erases, and it falls mid-word (`JOGGLE` inside, `JOGGLES` at 27 columns outside) | Track 29 for the rule, track 28 for showing the boundary. Auto-motion is not permission to auto-save |
| "should be able to have different font renderes" | Cheap: `core/src/font.ts` is already a facade over `core/src/fonts/` with a `Font` type, built that way by track 7. Missing is fonts and a control, not a mechanism | Track 29 |
| "also it doesnt seem to use the space efficiently although more important that the text renders better rather than filling the vertical space" | **A ruling worth recording, because it will otherwise keep being "fixed".** `band5` uses 5 of 9 rows and that is not waste: only rows 2-7 are alive in every column, so a scrolling glyph has a 6-row band, and the sixth row is spent on air to buy mixed case. Height is available to static text only, which `tall7` already is | `notes/library.md`, "Fonts". No 9-row scrolling font |
| "Animations should auto be space efficient selecting the length and stuff seems like 'overkill' or atleast overly complex. The current ui surrounding this is just so poor" | Right, and the reason is stronger than taste: **every `DATCP` erases the same five hardcoded pages whatever the payload**, so a 120-column loop and a 736-column loop cost identical flash (`core/src/budget.ts`, *derived* from `abs 0x218cc`). Width buys upload time only, 2.0 s against 5.9 s at 700 columns. The control is a question whose answer is always the same | Track 28: delete `plan.ts`'s `WIDTHS`, render at the ceiling, show a progress bar |

**The lesson this batch adds.** The first session's was that nothing asserted what a person
sees, the second's was altitude. This one is about **controls that ask a question the repo
has already answered**: width, levels, dither and direction each have a defensible
automatic answer written down somewhere in this repo, and the screen asks the user anyway.
A control is only earned when the answer genuinely depends on taste.

## Handset feedback, 2026-08-12, second batch: first contact with the redesign

Minutes after the rewrite hot-loaded onto the Pixel, with the pair connected. Two real
defects and one governing ruling that overturns a law this repo wrote for itself.

| What he said | What it turned out to be | Where it went |
| --- | --- | --- |
| "ui feels a bit laggy" | Partly the dev client (JS dev mode, no release optimisation), partly ours: the Show tab rendered every effect recipe at its full 736 columns just to draw a 24-column tile, and fingerprinted those bitmaps on the same mount | Track 26: thumbnails render one panel wide, fingerprints cached, row data precomputed |
| "new font renderer is really bad + i cant pick my own but this should be a track i think" | It is: track 29 ("Text picks its own motion, and there are more fonts") already carries the font work, and this adds the verdict that `band5`'s look itself is not liked, not merely unchosen | Track 29, verbatim |
| "If your just showing static images do we need the name ... doesnt need to say free etiher, they are always free" | Right: the built-ins are numbered, not named, so the label carries nothing the tile does not, and a cost tag on a thing that is always free is noise | Track 26: built-ins become a bare tile grid |
| "confirmations are sometimes too extra in gernal should always be avoided. Infact showing free or anything, realistically we are never gonna damage the memory unless we go crazy, the price is also not nice to think about when using them" | **The ruling, and it overturns our own law.** "Cost stated before it is spent" was this repo's rule from the first flash-wear analysis; Jacob's judgement is that the arithmetic (500 days at 20 saves a day, pessimistically) means human taps never matter and the ceremony itself is the cost. The budget guard stays in code, where the runaway risk actually lives; the UI stops asking and stops pricing | Track 26: no send sheet, no cost tags, no replaces alert. `notes/app-plan.md` "The redesign" corrected in place |
| "The on now didnt go away when i went to a different one, or does that just mean on device?" | It meant "saved in the glasses' flash", which is true and not what a badge in a picking grid reads as. Showing and holding are different facts and the badge conflated them | Track 26: the badge follows what is showing; residency demoted to the item's own detail |
| "I need to be able to delete / hide things from this screen. I need to be able to set my kinda favourites list so when im out and about its easy to switch between" | Delete existed behind a double confirm (see ruling above); favourites are track 28's preselect grid asked for again, so the minimal version stops waiting | Track 26: long-press menu with instant delete, and a favourites grid pinned at the top of Show |
| "The green confirm button when uploading an animation for example doesnt have text in it, is a weird colour making it look not clickable" | **A real layout bug**: the shared button carried `flexGrow: 1, flexBasis: 0` for row layouts, and inside the sheet's column that collapses to zero height, leaving a thin unlabelled pill | Fixed in `ui.tsx`; the sheet it appeared in is gone anyway, per the ruling |
| "The effects page too is just weird ... teh effects there are also bad" | Two complaints. The page: fine print and a knob wall. The generators: what they look like at 2 levels on 9 rows is partly the honest preview and partly untuned defaults, and nobody has watched one on the panel | Track 26 trims the page and opens on the most legible generator; the generators themselves need the sitting's eyes, then their own track, **which is now track 31** |
| "Also the edit button is really hard to click. Cant we use that common affect where scrolling it starts to show the action and then doing it all the way and letting go does this thing" | The `⋯` link was a 14px tap target. The ask is the standard swipeable row: drag reveals the actions, a full swipe commits the primary one | Track 26: swipe rows for mine items (JS PanResponder, so no native rebuild); tiles take long-press |
| "Current when it says Device ..... was disconnected on glasses screen, its showing some weird id instead of the name" | ble-plx words its own errors with the platform handle, and every catch block in the app printed that message straight out. The handle is a MAC on Android and a per-install UUID on iOS: it is the **one** identifier the app shows nowhere else, since the nicknames, the ledger, the settings and the scan list are all keyed on the advert name | New `app/src/ble-words.ts`: the fault classified off ble-plx's own table and said in the nickname, or the advert name, at each place a BLE failure surfaces. It also caught a second defect: `App.tsx.tap()` never caught a rejection, so a link dropping mid-tap left the status line on "sending..." for good and the platform's wording went to the log instead of to the person |
| "Also need more theme colours for specific glasses" | Five hues was fewer than the crew has pairs, and the palette's own docblock defended five as "hues a thumb can tell apart" - a good argument for spacing, not for a count | `theme.ts`: eleven entries, ten hues about 30 degrees apart plus a neutral, ordered round the wheel so the row reads as a spectrum. `green` stays first because a stored `null` must keep meaning what it meant, and the swatch row now wraps |
| "The preview is also so way slower than the actual speed of the device btw, like way slower" | **The first side-by-side of preview and panel, and it contradicts a *derived* number.** The preview steps at `protocol.speedDivisor`'s rate, read out of the firmware disassembly and never timed against the panel; the other suspect is the preview's own clock dropping steps under render load. Which one is wrong decides whether the fix is core or the preview | The sitting: time one full pass of a known-width save on the panel against a stopwatch, then against the preview. Recorded here because the ladder's docblock claims the device's real rate |
| "Its also glitching out a bit ... It seems to speed up the less pixels are showing on the screen" | The diagnostic that settled the row above: render load stretched the frame-counted clock, so the marquee's rate varied with how much was lit. Not the ladder at all, or not only it | **Fixed**: `clock.ts` holds wall-time and catches up by jumping; `Preview.tsx` pre-renders every offset once so a step is a lookup |
| "Why does mine still show the name and everyting, it should be like the others" | Right: the picture is the label, and the name survives as the long-press menu's title | **Fixed**: Mine is a tile grid like the built-ins, which also supersedes the swipe rows built an hour earlier |
| "Loads of stuff is now off center and weird i feel like you can do this bette" | Partly watching intermediate states stream in over Fast Refresh, partly real: removing the button flex for the sheet bug left buttons collapsed in row containers | **Fixed**: buttons fill their column, the preview centres as the hero, grids centre |
| "There should be some way to see when something is an animation" | Tiles are stills, so a loop and a picture look identical until tapped | **Fixed**: a small motion mark on any tile that animates |
| "it seems to keep having to send the animation to the device? Surely its saved and can just be switched to?" | **The hardware's one-slot store, met in the wild.** The glasses keep exactly one saved item: re-tapping the resident one IS a free switch (the fingerprint route), but A to B to A re-uploads A because B evicted it, and no app can dodge that on stock. What can shrink it: the measured 6 ms pacing floor cuts a full-width upload from ~6 s to ~2 s (one look at the striped pattern makes it trustable, the sitting), and the playlist reel packs several loops into ONE save so cycling a chosen set is free (track 18's engine, wanting a UI) | The sitting for pacing; the reel UI is the favourites grid's natural next step, **now track 30** |
| "Back needs to work more smoothly in the app, not quit out when it should just go back" | Nothing handled Android back at all, so the system backgrounded the app from any tab | **Fixed**: back walks to the Show tab first and only leaves the app from there; swallowed mid-upload for the same reason the tab bar is |
| "can we really not have more than one saved slot?" | **On stock firmware, no**: one DATS buffer per type at fixed flash pages, no slot field anywhere in the protocol. The workable answers, nearest first: the reel (many loops in ONE save, cycling free, engine built), faster uploads (the 6 ms pacing floor, one look to trust), and genuinely multiple slots only via our own firmware's staging-bank patch, ~50x capacity, blocked on SWD delivery like everything Track C | The reel UI next, **now track 30**; the slots are `notes/playlist.md`'s firmware section |
| "Im pretty sure the panel option doesnt do anything" | `LIGHT` is one of the firmware's eleven real opcodes (dispatcher clamps 1-5, floor 1) and the taps reach the wire, so this is either steps too subtle to notice or a mode the brightness does not apply in - and nobody has ever watched for it | The sitting: sweep LIGHT 1 to 5 on a lit panel, in live, saved and built-in modes, and say what changes |

## Handset feedback, 2026-08-12, during the sitting: what the device does unprompted

Jacob, watching the panel with nothing connected, at the start of the first hardware
sitting since 2026-08-09. Kept verbatim per the board's rule. **This is the first table
here whose rows are about the device rather than the app**, because it is the first time
anyone has watched the glasses decide something for themselves.

| What he said | What it turned out to be | Where it went |
| --- | --- | --- |
| "Bass is bouncing up and down moving left" (on power-up, nothing connected), then "our word, built in animation, before i restarted it, it was static Bass" | **The device restores our saved word and plays it under a built-in animation of its own choosing.** Before the power cycle the same word was static; after it, it bounces vertically while travelling left. So the saved store is not merely scrolled: what animates it is a mode the device picked, and the app never sent one | `research/vendor-app-protocol.md`. It corrects `notes/app-plan.md`'s "Motion: **horizontal translation only**" for the saved route, which is now too narrow |
| "mode3 vertical bounce is a built in animation i believe, always bounces up and down and a direction" | **The reading that reconciles it**: `MODE 03` is the vertical bounce and its second byte is a direction, so it bounces *and* travels, which is exactly what the panel showed. Our own `protocol.ts` had this half-right and half-wrong: `scrollLeft` used to build `MODE 03 s` for a horizontal scroll, which is why the helper was deleted | `research/vendor-app-protocol.md`. **`MODE 03` is a motion the app does not offer**, and it costs the same nothing that `MODE 02` does |
| "text should be centered if its static, like centered horizontally" | `content.text()` right-pads a static piece to 24 columns (`pad(bitmap, COLS)`), so a short word sits hard against the left lens and looks like a rendering fault rather than a choice | Track 35, and it is one line plus a test in `core/src/content.ts` |

## Jacob's asks, 2026-08-12 overnight: a costume, and finding things fast

Left in `.claude/locks/night-plan` for the session that woke at 04:09, kept verbatim per
this file's own rule. **Both are about the festival rather than about the protocol**,
which is the first time that has been true of anything in this file.

| What he said | What it turned out to be | Where it went |
| --- | --- | --- |
| "I am gonna dress up as Walwuiji, luigi's brother, so I defintely need some waluwuiji themed images and or animations. But like at least a W W for each eye and if you think of other things for that theme put that in" | **The first content request this project has had**, and it is well inside what the panel does: a `W` per lens is 12 columns each, which is exactly the per-eye half, and the theme has more in it than the letter (the moustache, the overalls' zigzag, the upside-down triangle of the cap badge). Nothing here needs firmware, hardware or a save: a still goes down the free live route | Track 37, a themed motif set in core with the app able to show and keep them |
| "I really think as you are developing you should think about the user experiance, like how easy it will be to add to favourites, and how easy it will be to use favourites. Maybe even groups of favourites. And or add search to whatever you come up with for find stuff but even on the main gallery thing it should be easy to find images" | Favourites exist (track 26) and search exists over the user's own items (track 28), but **adding to favourites is a long-press away and the built-ins are 30 unnamed tiles with no way to narrow them**. Groups are new. The honest problem is that the gallery's built-ins cannot be searched by name because they have none, so "easy to find images" there means something other than a text box | Track 38 |

**The trap in the second one, worth naming before anyone builds it.** Search over the
built-ins was ruled out on purpose (`notes/library.md`, and track 28 shipped the empty
state that says so) because they are numbered, not named, and an invented name is a guess
a user then searches for and fails to find. Jacob is not asking to undo that: he is asking
for the gallery to be *navigable*. Those are different features, and the answer is
structure (groups, filtering by what a tile does, recently used) rather than a text box
that lies about what it can reach.

## Jacob's ask, 2026-08-12: the motion mark, asked for a second time

| What he said | What it turned out to be | Where it went |
| --- | --- | --- |
| "animations should have a tiny icon on them showing if they are animated or not in the show screen" | **A row in the second-batch table above already reads Fixed** ("There should be some way to see when something is an animation"), so this is the same want arriving again against a build that claims to answer it. What exists is a 9px `▸` at `INK.dim` in the bottom corner of a 104x53 tile, added inside track 38 and **never rendered on a handset**: the phone sat at the biometric bouncer for that whole session. Either it is too faint to read or it was never seen, and nobody can tell which from here | Track 41 |

**A re-ask against a Fixed row is worth more than a fresh one**, because it says the fix
missed rather than that the feature is missing, and the two want different work. Reading
the built mark for this found two things no test covers, both of which would keep it
wrong however large the glyph gets:

- ~~**One built-in animation is marked still.**~~ *Corrected within the hour, 2026-08-12:
  this called it a defect and it is not one, and the label was wrong too.* `builtinTile`
  derives `moves` from `b.frames > 1`, and `anim-6` ("Animation **7**", since `labelFor`
  numbers from `arg + 1`) does hold exactly one frame, so it gets no mark. But **a bank
  holding one frame does not animate**: `frames > 1` is the fact and `kind === 'animation'`
  is only the drawer it is filed in, so the mark is right to stay off it. The real work is
  that nothing in the code says this, which is why it read as a bug on sight and will
  again.
- **The mark tests for scroll, not for motion.** `mineTile` reads
  `pieceFor(item).motion.kind === 'scroll'`, so the vertical bounce track 39 is adding
  will read as still on the day it lands, which is the same class of drift as the preview
  disagreeing with the panel.

## The decision that governs everything: how frames reach the panel

Pick this first. Every creative idea below is really a choice of delivery route, and the
routes have very different costs.

| Route | Patch? | Full panel atomic? | Cost |
| --- | --- | --- | --- |
| Upload via `DATS`, let `MODE` scroll it | no | yes, device renders locally | best battery, no radio, but motion is whole-column scroll only |
| Rhythm channel, 24 bar heights in one write | no | **yes** | needs a live connection. Bars only |
| Live per-column streaming | no | **no, sweeps** | avoid for anything full-frame |
| On-device generation | yes | yes | free CPU, no radio, no drift. Needs the mode-table patch |
| Tile palette (repoint the rhythm table) | yes, ~40 B | yes | near-arbitrary frames at 100 fps. Best value patch |

The trap to avoid is live per-column streaming. Each column write pushes a whole frame to
the display module, so a full-frame update shows 24 successive frames and visibly wipes.
It is not fixable by going faster.

## Do these first, no firmware required

**Sound-reactive spectrum through the rhythm channel.** The single best festival feature.
People interact by shouting at you, there is no handover and no phone friction, and it is
the only path that updates the whole panel atomically, so it will look like a real LED
product rather than a wiping panel. Feed it from a phone FFT to start.

**Pre-rendered wide loops, then disconnect.** Compute the effect on the phone with real
floating point, dither it, upload up to **740** columns, drop the connection. Roughly a 40
to 60 second seamless loop with the radio off all night. This is the battery-friendly way
to have good visuals. *Corrected 2026-08-09: this said 768, which is the buffer's capacity
rather than what the firmware accepts. 745 columns returns `ERROR`. Measured ceiling and
pacing floor are in `research/vendor-app-protocol.md`.* 740 is the type 1 ceiling; **a
dithered effect loop, which is what this bullet is about, reaches 736**, because widths
snap down to the 8-column dither tile (`core/src/effects.ts`).

**Text-my-glasses.** A QR code on your jacket pointing at a page where strangers type a
message. Queue it, approve it, upload it via `DATS`. Highest delight per unit of effort,
and your phone stays in your pocket. Needs a moderation step, which is the whole design
problem.

**Several pairs from one host.** The one-connection limit is per device, not per host, so
one host drives several pairs at once. The ceiling is argued under "Controlling other
people's glasses". Messages handing off along a row of people, group strobes, a wave.

**Name your glasses, on the host. Built 2026-08-11 as track 10**,
`packages/app/src/nicknames.ts`, whose docblock holds the mechanics. The judgement that
put it first: two pairs in a scan list read `GLASSES-125B37` and `GLASSES-12C3EF`, which is
unusable at arm's length in a field, and a phone-held map fixes that with no device
involvement at all, on stock units, which are the only kind we can currently reach. **A
name held on the device is a firmware change worth almost nothing while the host map
exists**: it is blocked with the rest of Track C, and even unblocked it buys only what the
map cannot, a name a *stranger's* phone sees ("Firmware patches, ranked"). Still open: the
scan row and the inline editor have never been rendered on a handset.

**Hand them over as-is.** The button already cycles 21 built-in modes with nothing
connected. Zero code. `ANIM` also reaches modes the vendor app cannot, including the
expanding bloom decoded at `abs 0x2441e`.

**One library to pick from, mine and the system's, sorted apart.** Asked for by Jacob
2026-08-11: show every animation and every text as a browsable library, with the things
he has added separated from the ones already on the glasses. Today there is no such view
anywhere. The 21 built-ins are reachable only by cycling the button or by guessing a
`MODE`/`ANIM` index, and everything he has made lives in `packages/app/src/library.ts`
with no screen that lists both.

**The two halves are genuinely different things, which is why the split he asked for is
the right shape rather than mere tidiness.** The system half is a set of indexes into the
read-only `IMAG` and `ANIM` banks: nothing to store, nothing to upload, and showing one
is a single command that writes no flash. Our half is phone-held JSON, and the device
cannot hold "later" content at all, since there is one `DATS` buffer per type and no slot
index. So they differ in where they live, what a tap costs, and what can be deleted. A
list that presented them as one undifferentiated set would be lying about all three.

**Real thumbnails for the built-ins are available and nobody has extracted them.** The
banks are in the firmware image we have already decoded, which is how the expanding bloom
at `abs 0x2441e` got named, so `research/tools/fwtool.ts` can lift the frames and render
each built-in as a genuine preview instead of a row reading "Mode 14". That is the
difference between a library and a list of numbers, and it needs no hardware: it is an
offline pass over `firmware/`, checked against `research/firmware-internals.md`. Until
someone does it, the only honest preview of a built-in is to send it and look.

**The trap this feature walks straight into.** Browsing means sending `MODE` repeatedly,
and `MODE` is a one-way door away from a type 2 image and discards the DIY live buffer.
So a catalogue that previews on the device destroys whatever the user was drawing, with
no warning, as a side effect of browsing. Whoever builds it owes the same treatment
track 12 gives the save path: state what a tap costs before it costs it, and never let
browsing throw away work. Picking is also the natural front end for the cycled playlist
in `notes/playlist.md`: that module takes entries, and this is where you choose them.

**A better renderer.** All app-side. `DATS` reaches all 9 rows, not the 7 the vendor font
uses, so we have a 28% taller canvas for free. Hand-drawn proportional pixel fonts with
real kerning beat downsampling a TTF, because 5-pixel cap height is exactly where hinting
dies. Emoji at 9x9 works for the simple ones, and the 4 greyscale levels earn their keep
anti-aliasing curves even though they are poor at encoding information.

Design constraint for any renderer: only rows 2 to 7 are alive across all 24 columns, so
a 6-row band is safe everywhere while using all 9 rows means content gets chewed passing
the nose bridge. That argues for two fonts, a safe 6-row one for scrolling and a taller
one for static content positioned around the gaps.

*Built 2026-08-09 as `band5` and `tall7`, and the scrolling one came out 5 rows rather
than the 6 this paragraph asked for. The band is 6 rows and a 6-row font would fill it
exactly, which leaves nothing for the dot on an `i` or a comma; 5 rows of cap height with
one row of air buys mixed case, and legibility at 24 columns comes from lowercase far
more than from a sixth row. The taller one is 7 rows, not 9: rows 0 and 8 are both
notched, so a 9-row glyph has almost no position that clears them, whereas 7 rows only
has to dodge one 4-column hole and still fits 4 to 5 characters. Descenders were dropped
for the same reason the scrolling font stays in the band.*

## Controlling other people's glasses

**The rule this whole section is written under, ahead of any capability: put content on
glasses someone is wearing only with their agreement, keep it temporary, and never write
their flash.** Everything below is what the radio makes *possible*; what we actually build is
bounded by that rule, spelled out in "Consent is the governing constraint" below. The
covert-persistent path is documented only to bound the possible and to say what a crew unit
must defend against, never as a plan.

New goal, and the useful realisation is that it is the *inverse* of the AES key-swap
patch. The shared vendor key and open `GLASSES-` name that the security note treats as a
vulnerability are exactly what let one app drive a stranger's pair.

Two flavours, and they pull different ways on the key:

| Flavour | Firmware? | Key | Constraint |
| --- | --- | --- | --- |
| Opportunistic stranger | none, works on stock | vendor key, shared by every unit | their phone must be disconnected; BLE range |
| Defined crew | yes | shared group key, renamed advert | crew flashes our image; vendor app locked out |

*derived* from the app shipping one global key and the firmware declaring one `GLASSES-`
prefix. Not yet exercised against a second person's unit on hardware.

Because we want both, the app has to speak **two keys**: the vendor key to drive
strangers on stock, the group key to drive crew. `packages/core/aes.ts` already isolates
the cipher, so the key is a per-connection parameter, not a rewrite. Strangers stay on
the vendor key forever because we cannot reflash them.

**The ceiling that bounds this at festival scale.** The BLE stack lives below
`abs 0x16800` and is outside the patchable region, so no firmware we can write adds
connectionless broadcast, periodic-advertising receive, mesh, or a second connection.
Controlling a crowd is therefore one connection per pair, roughly 4 to 6 per host radio.
Scale it with more hosts (the beat-box), never with a firmware trick, and the glasses are
peripheral-only so they cannot relay to each other either. *verified* from the stack
boundary in `research/firmware-flashing.md`.

### At a festival: what reaching a stranger's pair actually costs

*Recorded 2026-08-09, extending the section above from a capability claim into an
operational plan.*

The capability is real on stock. The operational reality is what decides whether it is
worth building, and it is harsher than the capability suggests.

| Constraint | Effect on the ground |
| --- | --- |
| Their phone holds the slot | one connection per device, so you cannot connect while their vendor app is open. Usually it is not, once the glasses are handed out, but you do not control that |
| One connection per host radio | you touch pairs one at a time, never a crowd at once. See the ceiling above |
| BLE range | roughly 10 m line of sight, much less through bodies. You must be beside the person |
| Discovery in dense RF | a field of `GLASSES-` adverts is indistinguishable, so targeting a *specific* stranger's pair is guesswork. You get "some nearby pair", not "that person's" |

The honest summary: reaching a stranger's pair is easy, reaching *a chosen person's* pair
in a crowd is not, and reaching *many* is one-at-a-time cycling. The scale story is the
beat-box holding a handful, never a crowd takeover.

### Consent is the governing constraint, and also the better engineering

Two ways to reach someone else's glasses, and the plan commits to the first:

| Route | How it feels | Why it is also more robust |
| --- | --- | --- |
| **Opt-in** (a QR "have a go", the crew key, they hand it over) | a gift or a shared toy | they close their app for you, so the slot is yours cleanly and nothing grabs it back |
| **Covert** (connecting to a stranger's stock pair unasked) | tampering with something on their face | fragile: their app reclaims the slot on any reconnect, range is a body away, and it is the fast route to being asked to leave |

The project already leans opt-in everywhere it matters: "hand them over as-is", "heckle
mode", the 60 second grant in "hand-over mode", and "text-my-glasses" behind a QR and a
moderation step. Keep it there. The covert path is documented only because it bounds what
is *possible*, and because a crew unit has to defend against it, which is the whole point
of the key swap. It is not the thing to build. Putting content on a wearable someone did
not choose is the one interaction on this entire list that turns from party trick to
harassment, so gate every "control someone else" feature behind an explicit opt-in and the
same content check the text feature already needs.

### At a festival: spraying a temporary image at nearby pairs

*Asked for by Jacob 2026-08-12, kept verbatim per the board's feedback rule. This is the one
concrete festival use of the section above, deliberately built as its temporary, no-flash,
low-stakes version.*

> "update all the glasses around us except the ones we have specifically connected to
> (Unless we mark as such) to show whatever we want, it should keep scanning and doing this,
> although wary of battery life"

and, on what it does to the wearer:

> "I think at a festival all it will do is tempoarily show an image so it wont cause any
> damage, wont cause any harm. I think people will find it really funny"

**What makes it fair is the delivery route, not just the intent: temporary, no flash, and
undone by the wearer in one action.** A 24-column image goes over the live buffer (`960b`),
and `SMVEW 02` copies it to SRAM so it survives the disconnect but not a power cycle
(*derived*, `notes/app-plan.md` flash table). No `DATCP`, so **zero page erases on anyone's
unit**, and the wearer clears it by power-cycling, pressing the button, or letting their own
app reconnect. The flash-wear rules that govern the rest of the app do not arise, because
nothing is saved.

**There is no broadcast; it is connect, push, disconnect, one pair at a time.** BLE is one
connection per device and the stack that would allow connectionless broadcast or mesh is
below `abs 0x16800`, unpatchable (*verified*, the ceiling under this heading). "Everyone
around us" is a scan-and-cycle at roughly 10 to 30 pairs a minute; "that person's pair" is
guesswork in a field of identical `GLASSES-` adverts.

**The "except the ones we've connected to, unless marked" half is small, and it is the
consent-respecting part.** Everything is keyed on the advert name already (nicknames,
settings, ledger, residency), so an include/exclude flag on that key, defaulting your own
remembered pairs out, is one store. It also lets a wearer be excluded on request in one tap.

| Design rule | Why |
| --- | --- |
| Push once per newly-seen pair, never re-push on a timer | a timed re-push is a nuisance to the wearer, and for any saved content it is the "no save loops" rule seen from here. Dedupe on advert name plus payload hash, as the ledger already does |
| Static 24-column image only, not scrolling | scrolling needs a type 1 flash save; the temporary route holds 24 columns |
| Long rescan interval, radio idle between passes | the battery worry Jacob flagged. Connect-push-disconnect is far kinder than a held connection |
| Strobe and content check on what is sent | the real harm vector is the content, not the device: keep full-field flashing out of 5 to 30 Hz (`notes/app-plan.md`, safety item 7), and it points at strangers, so it gets the same content check the text feature needs |

**Consent still governs, and the temporary route is how the design honours it**, not a way
around it: an unasked pair shows something for a moment and can always clear it, the plan
still leans on your own handed-out fleet and on opt-in ("Consent is the governing
constraint" above), and nothing here persists on a stranger's device or writes anything they
cannot undo.

**Built the same day, as track 42**, on "Yes build it into the app please". `app/src/spray.ts`
plus `screens/Spray.tsx`, off the Glasses tab: pick a picture, turn it on, and every pair in
range that is not yours shows it once. Every design rule above is in it, and three of them are
enforced rather than intended, by crawls and by a mock pair whose `save` throws: no flash, no
second `LiveSender`, no platform handle on screen. Two things the section above did not decide
and the code had to. **A spray lets your own pair go**, because `BleScanner.scan` calls
`release()` and a spray running beside a held pair would cancel it while the app still claimed
it was connected. And **built-ins are offered beside your own pictures**, because `ANIM n`
costs one command, keeps animating with the phone away, and is the better walk-by trick than
a still.

**What the code does NOT do, and it is the half that decides whether any of this works**: it
sends no `SMVEW 02`. `end('keep')` disconnects and leaves DIY alone, exactly as the CLI's
broadcast does, and it rests on the panel module holding its last frame (*derived*, `CLAUDE.md`'s
mental model). This section says `SMVEW 02` copies the buffer to SRAM, which is a second
*derived* route to the same hope; nobody has watched either. **So the first hardware question
is whether a sprayed picture survives the disconnect at all**, and it needs two pairs. Until
then the feature is written, tested and unwitnessed.

## Reaching other makes of glasses

*Recorded 2026-08-09, from "connect to other similar glasses, and what will that take".
This is the biggest genuine gap in the plan: everything else assumes a second unit of
**our** model.*

**Conclusion first: the protocol does not port, but the content model does.** Nothing
about `fff0`/`9600`, the `DATS` handshake, the two-byte discard, the 24-column geometry or
the AES key is shared with another vendor's product. What ports is everything above the
wire: `content.Bitmap`, the renderer, the fonts, the dither, the effects. So reaching a
new make is **a new driver behind the same `Transport`/`Scanner` interface, not a new
project**, and most of the work is one reconnaissance pass plus one decode per family.
*derived* from the transport abstraction in `core/src/transport.ts` already isolating the
wire from the sequencing.

### The commodity BLE-LED landscape

These products are cheap modules with a phone app bolted on, and they cluster into a
handful of app ecosystems rather than each being unique. That clustering is what makes
"support other makes" a finite job. *unverified* for anything but our own unit: every row
below is confirmed only by scanning the specific device in front of you.

| Family / signature | Transport signature | Protocol status |
| --- | --- | --- |
| Ours (Funky Glasses+) | service `fff0`, name `GLASSES-`, bespoke framing | *verified*, fully in this repo |
| Nordic UART Service devices | service `6e400001-...`, TX `...0002` / RX `...0003` | standard serial pipe; the byte format on top is per-app |
| HM-10 / generic BLE-serial | service `ffe0`, char `ffe1` | same, a serial bridge; format per-app |
| LED name badges (11x44 and kin) | various, many app names | community-reverse-engineered for several apps (*unverified* which advert maps to which) |
| Pixel displays (iDotMatrix, Divoom-style) | vendor-specific | open community protocols exist; displays not glasses, but the same pipeline reaches them |

The point of the table is the shape, not the exact UUIDs, which you read off the real
device. Most of these are a **serial pipe** (`NUS`, `ffe0`) with a vendor byte format on
top, and the format is the only unknown. Ours is unusual in using a bespoke service with a
real handshake; many are simpler than that.

### The interop pipeline, per family

Same five steps every time, and only step 3 is real work:

| Step | What it is | Cost |
| --- | --- | --- |
| 1. Catalogue | passive scan: advertised name, service UUIDs, manufacturer data. No connection, harmless | minutes, and it is the festival-prep step |
| 2. Identify | map the signature to a known family, or mark it unknown | a lookup |
| 3. Acquire the format | reuse a known/community protocol, **or** run the RE this repo already did: decompile the app, capture the phone's BLE HCI snoop log, find the write char, decode the framing | hours to days if unknown, near zero if known |
| 4. Write the driver | a `Transport` adapter plus an encoder from `content.Bitmap` to that make's frames. Geometry and packing are per-make | about a day per family once the format is known |
| 5. Verify | one unit on the bench: does a known bitmap land the right way up | one session |

Step 3 is the whole cost, and it is precisely the pipeline that produced this repo, so it
is known work rather than research. The reusable output is a **per-family driver** chosen
at connect time, the same way `aes.ts` already makes the key a per-connection parameter
instead of a rewrite.

### What does not port, so do not plan on it

- **Firmware.** Our extension, the crew key, the hook and the `ota.check` limits are all
  PAN1020-and-our-image specific. Another make has a different SoC and its own OTA, if any.
  Treat every other make as stock-only forever, exactly as we treat strangers' units of our
  own model.
- **Geometry.** 9x24 spanning two lenses is ours. A name badge is 11x44, a mask is
  something else again. The renderer must take dimensions as a parameter; the fixed 24 in
  `viewport.ts` does not port.
- **The rhythm channel, `DATS`, the button.** All bespoke. A new make has its own
  atomic-frame story, or none at all.

### At a festival specifically

You cannot reverse-engineer on-site: step 3 needs the app, a laptop and quiet. So the
festival plan is **catalogue in the field, build drivers at home, arrive supporting the
makes you already met.** A first festival is a scanning trip that tells you which families
are actually present; a later one is when the drivers exist. The range, one-connection and
phone-holds-the-slot constraints from the section above apply unchanged, and so does the
consent rule: other people's glasses of any make are still other people's, so the opt-in
framing is the plan and the covert path is only the bound on what is possible.

## Pushing our own content to several pairs from a phone

*Recorded 2026-08-09, from the question "can I upload an image or scrolling text, in
sync, from my phone to other glasses of the same model?". Distinct from "Syncing several
pairs" below, which is about tempo and phase for on-device animation. This is about
content we uploaded.*

**Yes for the content, qualified for the sync.** Separating those two is the whole
answer, because they have different costs and only one of them needs firmware.

| Goal | Possible on stock? | Cost |
| --- | --- | --- |
| Same image or text on N pairs of this model | **yes** | nothing new. `DATS`/`DATCP` per pair |
| Started roughly together, each looping | **yes** | one trigger write per pair |
| Frame-accurate lockstep on uploaded content | **no** | needs live driving (bars only) or the set-phase patch |

The content half is already *verified on hardware*: `Glasses.save()` does the full
`DATS` handshake and returns `DATCPOK`, and our own bitmap has been left scrolling
unattended. Reaching a *stranger's* pair needs nothing beyond that, because every stock
unit shares one vendor key and the `GLASSES-` prefix (*derived*, and still not exercised
against a second person's unit). Their phone must be disconnected first.

### Why lockstep is the hard half

Once `DATS` content is playing, **the scroll runs on the device's own timer and the host
is out of the loop.** Two things then pull the pairs apart:

- **Start skew.** The trigger writes go out one per pair, so first to last is N round
  trips, tens of ms each.
- **Drift.** Each pair advances on its own 50 Hz tick. Whether that tick is crystal or
  RC derived is *unverified* and it decides everything: at crystal accuracy they hold all
  night, at RC accuracy they visibly separate within seconds. Same open question already
  flagged under "Syncing several pairs", and one hardware test settles it for both, but
  that test needs two working pairs: see "Cheap experiments".

There is **no set-phase command on stock**, so re-aligning means re-triggering, which
means holding the connection or reconnecting. That is the constraint, not bandwidth.

### The shapes that dodge the problem entirely

Worth listing because most of what we actually want is in here:

- **A static sliced banner.** "One image across several pairs" works with *zero* sync,
  because nothing moves. Six pairs as one 144-column still image needs only six uploads.
- **Independent loops.** Each pair scrolling its own content, no relationship between
  them. Drift is invisible when there is nothing to compare against.
- **The rhythm channel, live.** The devices keep no time at all on this path, so drift
  cannot exist by construction and skew is just connection-interval jitter. Bars only.

The version that genuinely needs tight sync is **scrolling one image across a row of
people**, where a slice arriving late is obvious. Treat that as a firmware-era feature.

### Fleet reach is upload throughput, not held connections

*Renamed 2026-08-11 from "Cycling beats holding, for content". This section is about moving
one connection slot from pair to pair; `notes/playlist.md` is about rotating items on one
device's button. Nothing is shared, and the word "cycling" was naming both.*

The one-connection-per-device cap is usually quoted as the fleet ceiling, and for
*content distribution* it is the wrong frame. `DATS` persists, so the pattern is connect,
upload, disconnect, next pair, and the connection slot is reused. Reach becomes
throughput rather than concurrency, and the pair animates with its radio off afterwards.

**Measured, so plan against these**: a 700-column upload takes 5.9 s per pair at the
vendor's 50 ms pacing and **2.0 s at 6 ms**, which is the floor. Roughly 10 pairs per
minute becoming 30. Below 6 ms nothing is won, because the device absorbs the backlog
during `DATCP` instead. Connection setup is a fixed ~880 ms and becomes the dominant term
once pacing is tuned, so the next gain is there rather than in the stream. Full table and
method: `research/vendor-app-protocol.md`.

**Not yet safe to ship at 6 ms.** `DATCPOK` only means something was stored, so the fast
pacing is verified as acknowledged and not as correct. One look at the striped pattern
settles it.

The cap only binds for things that must stay live, meaning held connections. Scale those
with more hosts and never with a firmware trick: the ceiling is argued under "Controlling
other people's glasses".

## The rhythm channel takes 24 numbers, not audio

Worth stating plainly because the vendor's naming misleads. The handler takes 24 bar
heights of 0 to 9 and nothing about it is audio. The phone FFT is one source, and
honestly a mediocre one at a festival: the phone is in a pocket, muffled, and hears the
crowd rather than the music.

Better audio sources:

- **A pre-analysed track driven off a clock.** Beats live audio outright when you know
  what is playing, because there is no attack lag and no noise floor, so bars land exactly
  on the beat.
- **The phone's own playing audio**, if the music is coming from the phone. Perfect
  signal, zero ambient noise. Rarely true at a festival.
- **A mic that is not in a pocket.** See hosts, below.

Non-audio sources, since it is just 24 numbers:

- dancing intensity from the phone's accelerometer, or step cadence
- heart rate from a watch
- a countdown draining, or a progress bar for anything
- a two-person tug-of-war
- RSSI proximity to a friend's glasses

## Which host drives it

Nothing says the host has to be a phone. The glasses are peripheral-only and take one
connection, so *something* must be central, but that something can be a phone, a laptop,
a Pi or a microcontroller.

**The beat box is probably the right answer for a festival.** An ESP32 with an I2S mic is
a few pounds, sits on a lapel where it can actually hear, drains no phone battery, needs
no app running, and can hold connections to several pairs at once as the group's timing
master.

The hard part of that build is beat tracking on ambient crowd audio: trackers take a few
seconds to lock and slip when the DJ changes tempo. **The mitigation uses both halves of
the idea together.** Take the button **taps as ground truth for tempo**, because a human
tapping along is a far better beat detector than any algorithm on a noisy field
recording, and use the **mic only to correct phase drift** between resyncs. That plays to
the strength of each.

## More festival concepts

Collected so they are not lost. Roughly ordered by delight per unit of work.

**Animated eyes.** Two roughly 9-wide eyes with the nose bridge between them: blinking,
looking around, pupils dilating, winking on a button press. Reads far better at distance
than text does, and at 216 pixels a face is one of the few things that survives the
resolution. Depends on the column-0 lens test.

**Heckle mode.** A press cycles a random one-liner from an uploaded list. Strangers press
it, get a new joke, hand them back. The most natural use of the button.

*Corrected 2026-08-11: this said "it needs no phone at all", which read as needing no
firmware either, and both are wrong. On stock a short press only cycles the 21 built-ins,
and the saved store holds exactly one user item per type with no slot index, so there is no
uploaded list for a press to reach. It is a firmware feature: "Button drives our content"
plus "Content into the staging bank" from the ranked table below, both blocked on SWD
delivery. `notes/playlist.md` is the same idea worked through, including what stock can do
today in its place.*

**Now playing, or a set-times countdown.** Scrolling artist name, or minutes until the
next act. Practical and very festival.

**Proximity greeting.** The app scans for other `GLASSES-` advertisements and shows a
count, or a matching symbol when a friend's pair is nearby. Advertisement-only, so no
connection needed and it costs nothing.

**Photo and GIF import.** 24 by 9 with 4 levels plus a good dither handles simple images
better than you would expect, and an animated GIF maps straight onto stored frames. Good
for handing someone a recognisable thing rather than an abstract effect.

**Bouncing disc.** The DVD screensaver: a disc tracking across the panel, bouncing off
the edges, with the corner hit as the payoff. It is the cheapest generated animation
there is, four bytes of state, so it is the natural first thing to draw once a mode of
ours can render at all. It cannot come from `DATS`: a scrolled wide buffer only ever
slides sideways one column per step, so the only bounce it encodes is a zigzag
travelling leftwards, not a disc off the walls. On-device generation or the tile palette.

Three things decide whether it reads:

- **Nine rows is the constraint, not 24 columns.** A 3-row disc has 7 vertical positions,
  and 4 if confined to the safe rows 2 to 7. Hold position in 8.8 fixed point and
  anti-alias the disc across the 4 brightness levels, as for sub-column scroll
  interpolation, or it steps visibly. A 2x2 dot with a fading trail may read better at
  this size than anything recognisable as a disc.
- **The corner hit is frequent here, which kills the joke.** With unit velocity each axis
  is a triangle wave, so both hit a wall together every lcm of the two travel spans: a
  2x2 disc on the full panel gives a 22 by 7 field, so 154 ticks, near enough 3 s at the
  50 Hz tick (*derived*, arithmetic only). Invert it. Run a velocity ratio that
  essentially never corners, then script the hit on a button press or a beat drop and
  flash the panel when it lands.
- **The nose bridge eats the disc** as it crosses. Either treat the bridge as a wall and
  bounce two mirrored discs, one per lens, or accept the chew.

Looping is free with integer velocity: the path is exactly periodic, so a pre-rendered
version has no seam to hide.

**Two-player games**, with the phone as controller and two people's glasses as displays.
A showdown, a tug-of-war, a reaction duel. Fun but the most setup friction of anything
here, so treat it as a stretch goal.

**Name or pronoun badge.** Unglamorous, genuinely useful, five minutes of work.

## Second wave of concepts

Added 2026-08-08. All app-side unless marked, so none of them wait on firmware.

**Live captioning.** Phone speech-to-text into a scrolling line. The panel faces
outward, so it captions *you* for the person in front of you. Genuinely useful in a
field where nobody can hear anything, an accessibility feature by accident, and the
single most "how did you do that" thing on this list. Latency and profanity are the two
design problems.

**Live translation.** The same pipeline with a translate step. International crowd,
and the payoff is enormous relative to the work once captioning exists.

**Auto now-playing.** The existing "now playing" entry assumes you type the artist.
Song identification from the mic closes the loop, and it fails gracefully: no match,
show something else.

**One image across several pairs.** "Several pairs from one host" is already listed as
handover and waves, but the stronger version is treating six pairs as **one 144-column
display**. Render a single wide image, slice it per device, and a line of people becomes
a banner. Alignment is a human problem, not a technical one, and imperfect alignment
still reads.

**Landscape on the rhythm channel.** The channel is a height map, so a scrolling
mountain silhouette, a city skyline or a waveform are all native to it and none of them
look like an EQ. Same atomic single-write path, completely different character.

**Temporal dithering on bar heights.** Heights are integers 0 to 9, which is coarse for
a spectrum. The rhythm channel is the one atomic path, so frames can be pushed fast
enough to alternate between 3 and 4 and perceive 3.5. Doubles the effective vertical
resolution of every height-map effect for free. *unverified*, and it depends on how fast
the channel actually accepts consecutive writes.

**Heart rate without a watch.** Finger over the phone camera and flash gives a usable
PPG pulse. The existing note assumes a watch; this needs nothing but the phone, and a
panel pulsing in time with your heartbeat is a better party trick than a spectrum.

**Applause meter.** Mic level as bar height, held with a slow decay. Point it at a crowd
and they will compete with it. Costs nothing once the mic pipeline exists for audio.

**Find-my-friend arrow.** Proximity greeting is already listed; the directional version
needs both phones sharing location and shows an arrow plus distance. The honest version
is RSSI-only, which gives warmer/colder rather than a bearing.

**Hand-over mode.** A QR on the arm grants a stranger 60 seconds of control from their
own phone, then it expires. Turns "look at my glasses" into "have a go", which is a
different and better interaction. Needs the moderation design from text-my-glasses.

**Set-list scripting.** A timeline that swaps pre-rendered content at track boundaries,
uploaded in advance and driven off a clock. Combines with the pre-analysed-track idea:
the whole night as a script rather than a live reaction.

**Attract mode.** What they do when nothing is connected and nobody is looking. Low
brightness, slow, cheap. It is what they will spend most of the night doing.

## What SWD unlocks that OTA never could

*Recorded 2026-08-08, after the brick. The distinction matters: most of the firmware
work was never blocked by capability, only by delivery.*

**Tier 1, blocked-not-impossible.** Everything under "Firmware patches, ranked" fits in
free flash and was fine over OTA. Since the commit path is barred it is all undeliverable
today, and SWD is the only route back to it. About 250 bytes of code for the whole list.

**Tier 2, genuinely SWD-only.** These touch regions OTA can never edit, because OTA
recovery needs the running app to keep BLE alive:

| Change | Why it matters |
| --- | --- |
| Bigger ATT writes | kills the "one 16-byte block per write" gotcha, the most limiting constraint in the project. Uploads stop being 15 payload bytes at a time |
| Radio parameters | connection interval lives in the untouched 90 KB stack below `0x16800` and sets the floor on live latency |
| Atomic arbitrary frames | today the rhythm channel is the only non-sweeping full-panel path and it is **bars only**. Arbitrary atomic frames turns these from "plays uploaded animations" into "a display you can stream to": video, a camera feed, anything |
| Delete the OTA service | frees flash and removes the brick vector |
| Relink | `notes/firmware-design.md` is an extension framework *because* relinking had no way back. With SWD it does |

**What SWD does not unlock: reach.** Recorded 2026-08-09 because it is a natural and
expensive assumption, and it is wrong. The probe is per-device *physical* access: case
open, clip on five 2.54 mm pads, one unit at a time. That is the opposite of scale, and it
is flatly unavailable for a stranger's pair. Nor does it lift the concurrency cap, which no
firmware we can write reaches at all: the argument is the ceiling under "Controlling other
people's glasses". Strangers' units stay stock forever and that is fine, since stock already
does everything the app needs. **The probe makes our own glasses better, not more glasses
reachable.** Scale with more hosts, or with upload throughput.

**Tier 3, the one that is not a feature.** Experimentation gets cheap. Every firmware
idea currently costs a four-minute upload and a bricking risk, which is why this project
has spent its life on static analysis. A bad flash over SWD costs thirty seconds. The
docs are full of "worth one test" entries nobody ran because the test was not worth the
risk.

## Firmware patches, ranked

Byte costs and addresses are in `research/firmware-internals.md`, which calls its own
numbers estimates not to plan around. This is the ordering, and nothing else.

| Patch | Why it is worth it |
| --- | --- |
| Animation tick 50 to 100 Hz | **doubles the time resolution, not the smoothness** (*corrected 2026-08-20 by building it*: compensated, the patch is behaviour-neutral by construction, so nothing looks smoother. Smoothness is the sub-column interpolation row below). Compensate the tick-counted timeouts in the same patch, or the 2 s power-off becomes 1 s: measured in the simulator at 1.05 s uncompensated against 2.09 s with. **Build-time image edit, not a slot** |
| Notify on button press | the button currently cannot talk to the host at all. Unlocks tap tempo and every phone-side interaction |
| Seed `rand()` | unseeded, "random" is byte-identical on every boot and two pairs play the same sequence. Which is a feature when the two pairs are yours: see "Syncing several pairs" |
| Tile palette | best value. Keeps the atomic single-write path but makes the vocabulary ours |
| AES key swap plus rename | stops anyone with the vendor app hijacking your glasses in a field full of them. The rename prefix must be **exactly** 8 bytes, see below |
| Settable name over BLE | per-unit names that a stranger's phone sees. Low value while the host map exists, and it costs a flash page as well as code |
| Button drives our content | the only route to phone-free interaction |
| Sub-column scroll interpolation | scrolling steps whole columns at up to 12.5/s, which is visibly steppy. Blending two columns through the 4 levels fixes it |
| Battery over BLE | all-day event, and the value already sits in RAM |
| Content into the staging bank | 1.5 KB to 76.8 KB. Biggest capability jump, largest patch |

Everything above fits comfortably in the 10,716 free bytes, and they are independent, so
they can go in one image.

### Renaming, build time and run time

**Build time works and is already wired**, `bun run build-firmware --name JOGGLES-`. It
sets one prefix for every unit flashed with that image; the last six characters stay the
unit's MAC, so units remain distinguishable. Its one trap is that the prefix must be
**exactly 8 bytes**: the boot code writes the MAC suffix at a fixed offset of 8 and the
advert length is a hardcoded 14, so a shorter prefix padded with NUL makes the whole fleet
advertise the same truncated name. The builder now refuses anything else. Disassembly:
`research/firmware-internals.md`, "The advert name is 14 fixed bytes". *verified*, and it
corrects an earlier note that called those 8 bytes free padding.

**Run time, meaning a name the user types and the glasses keep**, is a real firmware
feature and worth about what it costs:

| Piece | Cost | Note |
| --- | --- | --- |
| `J` sub-command `SETNAME`, 14 bytes of payload | small | but the notify frame ceiling is 15 bytes, so the name arrives in one write and there is no room for much else |
| Write RAM `0x20002604` and re-advertise | small | the live name is RAM, not flash, so the change itself is cheap. Restarting the advert means calling into the BLE stack, which is the one area the recovery guarantee says not to touch |
| Persist across a power cycle | a flash page plus a boot hook | the boot path always rebuilds the name from `abs 0x2691c` plus the MAC, so persistence needs its own page and a hook after scatterload. It is also a flash write on a device whose wear we cannot read |

**Blocked either way.** Both need an image on a device, and delivery is what the brick
took: `bun run flash commit` is barred until LDROM has been dumped over SWD
(`notes/plan-after-the-brick.md`, Track B). So the honest ordering is the host-side
nickname now, the build-time prefix on the first flash whenever that happens, and
`SETNAME` only if someone can name a thing it buys that the host map does not.

## Syncing several pairs

**Start from the fact that costs nothing: every unit runs the same firmware with the same
unseeded `rand()`, so two pairs on the same built-in mode already play byte-identical
sequences** (*verified* that the seed `.data` init is zero, in
`research/firmware-internals.md`). For syncing your **own** pairs that determinism is a
feature, not the bug "Firmware patches, ranked" frames it as, and the only missing piece is
aligning start phase, which live-driving from one host removes entirely.

For everything else, three tiers, and the third is the best idea we had.

**Stream everything.** Drive all pairs live from the rhythm channel. The devices keep no
time at all, so drift cannot exist by construction and skew is just connection-interval
jitter, realistically 15 to 50 ms. That is well inside a beat at any tempo. Costs a
permanent connection and constant radio.

**Local tempo plus periodic resync.** Each pair animates on its own and the host nudges
phase every few seconds. Battery-friendly, needs the set-phase patch.

**Tap the beat in on both pairs.** Tap the same beats on each and they end up locked to
the same tempo *and* phase, with no phone, no host, no radio and nothing to drift apart
except the crystal. This quietly removes the need for all the resync machinery above.

Note that **simply pressing both buttons at the same instant is worse than BLE**, and it
is worth knowing why before trying it. Human simultaneity across two buttons is 50 to
100 ms, so you do not beat connection-interval skew. Worse, each pair keeps its **own**
mode counter that wraps at 21, so unless they already happen to sit on the same index,
pressing both advances them to *different* modes, and matching them up means cycling one
as many as 21 times. It also only reaches the built-in modes, not our own content. Keep it
as the fallback for when the phone is dead, not as the plan.

One detail decides whether tap tempo works or looks broken. The tick is 50 Hz, so 20 ms
resolution, and at 128 BPM a beat is 23.4 ticks. Storing that as whole ticks is about a
2% tempo error, which accumulates past a full beat within thirty seconds. **Use a
fractional accumulator** (interval in 8.8 fixed point, add per tick, advance on
crossover). A few bytes, and it removes quantisation drift entirely. Averaging four taps
brings the measurement resolution well under 20 ms, so capture is not the problem.

Still open, and settled by hardware rather than more disassembly: whether the tick is
crystal-derived or from the internal RC oscillator. At crystal accuracy two pairs stay
locked essentially all night; at RC accuracy they visibly separate within seconds. The test
is "Start two pairs animating together and time the divergence" under "Cheap experiments",
and it is **blocked**, for the reason recorded there.

## Interaction through the button

The firmware is already shaped for this: a short press drives a 33-entry mode dispatcher
and there is a separate per-tick driver with its own table, so adding an interactive mode
is adding cases to two tables rather than inventing plumbing. The debounced state, press
mask and release mask are all sitting in RAM.

Worth building: press to advance or trigger, hold-to-charge, press-timing reaction games,
tap counters, a random oracle. All of these work when the phone is dead, which is the
point.

Two cautions. The 2 second hold is the **only** power switch, so do not break it. And if
strangers are mashing the button they will eventually switch your glasses off, which is
worth designing around.

## Trippy visuals

At 216 pixels detail is hopeless and motion is everything. What reads: full-field
brightness modulation, travelling and interfering waves, particle trails, fire from the
bottom, and above all symmetry.

**Mirror across the nose bridge.** The 24 columns are one canvas with the bridge in the
middle, so rendering the right half as a mirror of the left gives a kaleidoscope for the
price of a mirrored index. Symmetry is much of why psychedelic visuals read as
psychedelic and it survives at any resolution, so it does more work here than detail ever
could.

*Corrected 2026-08-11, by the review of track 15, which built this in `core/src/effects.ts`
as `mirror`: a mirrored index is the wrong price, because it never mirrors across the
bridge. The panel's dead-LED map is symmetric about **x = 11.5**, so the bridge is the gap
**between** columns 11 and 12, and any fold axis sitting on a column centre misses it:
**87 of 92 widths never mirrored at all**. The shipped fix adds half a column of fold
phase, snaps the fold count to a divisor of the width (`mirrorFolds`), and defaults to
`dither: 'none'`, because ordered dither's thresholds are tied to the panel column and so
cannot themselves be mirrored. Symmetry still earns its place here; it is simply not free,
and none of it has yet been seen on the panel.*

**Quantisation is a feature.** Two or three summed sine sources quantised to 4 levels
produces moving contour bands, which is the classic plasma look. Fighting the
quantisation would be the mistake.

**Hold off on temporal dithering.** Faking more levels by alternating frames is tempting,
but at the 50 Hz tick that is 25 Hz alternation, and these sit in peripheral vision where
flicker is most visible. Even at 100 Hz, test before committing.

**Strobe safety.** Keep full-field flashing out of roughly 5 to 30 Hz, or keep it
low-contrast. You will be pointing this at strangers in a dark field.

## Storage: do not build a compressor

This was measured rather than guessed, and the numbers are in
`research/firmware-internals.md`. Every lossless frame-compression scheme lands between
1.3x and 2.4x on real data, the 2.7x option is lossy because the firmware's own
animations do use the intermediate levels, and delta encoding barely helps because 10 of
24 columns change per frame in anything interesting.

The two real levers are **capacity**, where repointing at the staging bank is 50x on its
own, and **generation**, where storing the bloom as one radius byte per frame is 72x and
plasma is effectively unbounded. With roughly 1,200 spare cycles per pixel the CPU is
idle anyway.

Design rule: **generate the fast content, store the slow content.** Stored frames at
100 fps exhaust even the staging bank in under half a minute, whereas 25 fps gets one to
two minutes and looks fine.

Compression's only good argument is upload time, not space: 76.8 KB over `DATS` is about
102 seconds of waiting, which 2.4x would cut to roughly 42.

**The endgame, if we want "advanced animations":** a tiny animation bytecode rather than a
codec. Ops like fill-rect, shift, fade-all, mirror, invert, wait-N-ticks, loop, and
plasma-with-parameters, each a byte or two, so a whole animation is tens of bytes. An
interpreter fits in 500 to 1500 of the free bytes. It composes with everything else: a
button press selects the next program, the staging bank holds hundreds, and a seeded
`rand()` varies them per boot.

## Practical constraints to design around

- **Battery.** Streaming keeps the radio and UART busy all night. Upload-and-disconnect
  is far kinder. Brightness dominates LED draw, and low brightness is what you want in a
  dark field anyway.
- **One connection per device.** Close the vendor app, and only one host at a time.
- **Pacing floor is ~6.5 ms**, because one frame takes 6.42 ms on the module's UART.
  Pacing faster buys nothing.
- **An OTA destroys anything in the staging bank**, so flashing means re-uploading
  content.
- **`DATS` validates less than it should, but it does check length.** *Corrected
  2026-08-09: this said "validates nothing today". An over-long announcement returns a
  clean `ERROR`, verified at 1490 bytes, so the oversize case is caught. The specific
  claim about lengths past 1536 wrapping silently is untested, not disproved.* What is
  still true: `DATCPOK` does not mean the content is correct, only that something was
  stored. See `research/vendor-app-protocol.md`.

## Cheap experiments, in the order worth doing them

None of these risks the hardware, and each settles something that changes the plan.

1. **Light column 0 only** and see which lens it lands on. Settles whether 24 columns
   span both lenses, which decides whether "scroll across both eyes" and the mirror
   kaleidoscope already work.
2. **Start two pairs animating together and time the divergence.** Sets the resync
   cadence, or removes the need for one. *Not cheap and not runnable, recorded
   2026-08-11: it needs two working pairs and there was one. **Unblocked 2026-08-20: unit 1
   was repaired, so there are three working pairs and this test can now be run.** This
   sits behind the SWD probe and the repair (`notes/plan-after-the-brick.md`, Track B),
   not behind five spare minutes. Every other passage that calls it a five-minute test
   defers to this entry.*
3. **Tap UART1 TX (P2.4, 115200) with a USB-serial adapter.** About £3. The display
   module is an undocumented third party and we know only two of its commands. This is
   the only route to more brightness steps or more greyscale levels, and it carries none
   of the risk of an SWD session.
4. **`DATS` type 2 with a payload over 72 bytes**, watching for `DATCPOK` versus `ERROR`.
   Also our only working request/response probe.
5. **`LOOP` versus `LOOA`** on the wire.
6. ~~Decode all 19 built-in animation banks offline.~~ **Done**, no hardware needed. The
   inventory, both frame formats and every mode's bank are in
   `research/firmware-internals.md`. The three pointers that "produced noise" were a
   second 27-byte 1bpp format, not headers. Pick the keep-list from that table.

## Deliberately not doing

Recorded so nobody re-derives them.

| Idea | Why not |
| --- | --- |
| Improve greyscale separation, or add levels | the display module owns the curve. No patch reaches it |
| Double buffering | every update is already one atomic packet |
| On-device sound reactivity, without hardware work | no microphone, and no I2C or SPI to attach a digital one to. See the surgery option below before writing this off entirely |
| Accelerometer or gesture effects | no accelerometer, and no bus to add one |
| Real flow control for write-without-response | the drops happen below `abs 0x16800`, outside the patchable region |
| A frame compressor | see "Storage: do not build a compressor" above. Measurements: `research/firmware-internals.md` |
| Relinking the firmware | owning BLE bring-up removes the recovery path. Patch in place |
| The 11x multi-block write | blocked: the loop is ~25 bytes but the ATT write length is not in the display callback's event struct, and the GATT core is below `abs 0x16800`. The speculative-decrypt-with-a-magic-marker trick in `research/` might sidestep it |

## Ambitious, for after the festival

**Standalone sound reactivity, with soldering.** The firmware half is genuinely plausible:
`TIMER1` and `TIMER2` are completely unreferenced, so there is a free timebase for a
few-kHz sampling loop doing envelope or crude multi-band detection, and the rhythm bar
tables already exist to render into. The 50 Hz animation tick is far too slow for that,
but a free timer is not.

What it needs is an electret mic and preamp soldered to a spare ADC pin, and **I could not
confirm from the firmware that a spare ADC channel has a pin broken out** on this board.
The ADC is configured with a channel mask of exactly 1, and settling whether there is a
usable second channel needs the PAN1020 datasheet and a look inside the glasses. Treat it
as the winter project, not the festival plan.

**Drive the display module directly.** Since the panel is a separate UART device, an ESP32
could in principle drive it and bypass the PAN1020 entirely, with WiFi and no frame-rate
ceiling worth speaking of. Absurd overkill, recorded because it is the one path with no
protocol limits at all.
