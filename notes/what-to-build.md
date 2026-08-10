# What to build

**This file is judgement, not findings.** Every factual claim it leans on is recorded
with its evidence and confidence in `research/`, chiefly
`research/firmware-internals.md`. Nothing here is verified by anything except argument,
so treat it as a plan to be disagreed with rather than a reference.

Written with a festival in mind: things strangers can interact with, that survive a
phone being in a pocket or dead, and that do not require babysitting.

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
pacing floor are in `research/vendor-app-protocol.md`.*

**Text-my-glasses.** A QR code on your jacket pointing at a page where strangers type a
message. Queue it, approve it, upload it via `DATS`. Highest delight per unit of effort,
and your phone stays in your pocket. Needs a moderation step, which is the whole design
problem.

**Several pairs from one host.** The one-connection limit is per device, not per host, so
one phone or laptop drives four to six pairs. Messages handing off along a row of people,
group strobes, a wave.

**Name your glasses, on the host.** Two pairs in a scan list read `GLASSES-125B37` and
`GLASSES-12C3EF`, which is unusable at arm's length in a field. A nickname map on the
phone fixes it today, with no device involvement at all: no flash write, no round trip, no
firmware, and it works on stock units, which are the only kind we can currently reach.

Key it on `SessionOptions.device`, which already defaults to the advert name and carries
the last three bytes of the MAC, so a nickname follows the unit across a reinstall and
does not follow the platform handle, which is per-host. Same storage shape as
`packages/app/src/ledger.ts`, but a **separate file** from the ledger: losing a wear count
matters and losing a nickname does not, so they should not share a failure. Show the
nickname in the scan list with the advert name small underneath, because the advert name
is what every other tool and every log line will show.

This is the whole feature for now. **A name held on the device is a firmware change and is
blocked with the rest of Track C**, and even once unblocked it only buys what the host map
cannot: a name a *stranger's* phone sees. Detail and cost are under "Firmware patches,
ranked".

**Hand them over as-is.** The button already cycles 21 built-in modes with nothing
connected. Zero code. `ANIM` also reaches modes the vendor app cannot, including the
expanding bloom decoded at `abs 0x2441e`.

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
| One connection per host radio | you touch pairs one at a time, 4 to 6 concurrent at most. See the ceiling above |
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

## Controlling several of your own

Already covered by "Several pairs from one host" above and "Syncing several pairs" below:
one host holds 4 to 6 connections, one per device. Raised again here because it is a
headline goal, and with one extra point. Every unit runs the same firmware with the same
**unseeded** `rand()`, so two pairs on the same built-in mode already play byte-identical
sequences (*verified* that the seed `.data` init is zero, in `research/firmware-internals.md`).
For syncing your own pairs that determinism is a feature, not the bug the patch table
frames it as: the only missing piece is aligning start phase, which live-driving from one
host removes entirely.

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
  flagged under "Syncing several pairs", and the same five-minute hardware test settles
  it for both.

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

### Cycling beats holding, for content

The one-connection-per-device cap is usually quoted as the fleet ceiling, and for
*content distribution* it is the wrong frame. `DATS` persists, so the pattern is connect,
upload, disconnect, next pair, and the connection slot is reused. Reach becomes
throughput rather than concurrency, and the pair animates with its radio off afterwards.

**Measured, so plan against these**: a 700-column upload is a 5.9 s cycle at the vendor's
50 ms pacing and a **2.0 s cycle at 6 ms**, which is the floor. Roughly 10 pairs per
minute becoming 30. Below 6 ms nothing is won, because the device absorbs the backlog
during `DATCP` instead. Connection setup is a fixed ~880 ms and becomes the dominant term
once pacing is tuned, so the next gain is there rather than in the stream. Full table and
method: `research/vendor-app-protocol.md`.

**Not yet safe to ship at 6 ms.** `DATCPOK` only means something was stored, so the fast
pacing is verified as acknowledged and not as correct. One look at the striped pattern
settles it.

The cap only binds for things that must stay live: held connections, so four to six per
host radio, scaled with more hosts and never with a firmware trick. See "Controlling
several of your own".

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
it, get a new joke, hand them back. The most natural use of the button and it needs no
phone at all.

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
is flatly unavailable for a stranger's pair. Nor does it lift the concurrency cap, because
the BLE stack lives below `abs 0x16800` and no firmware we can write adds broadcast,
periodic advertising, mesh or a second connection (*verified* from the stack boundary in
`research/firmware-flashing.md`). Strangers' units stay stock forever and that is fine,
since stock already does everything the app needs. **The probe makes our own glasses
better, not more glasses reachable.** Scale with more hosts, or by cycling uploads.

**Tier 3, the one that is not a feature.** Experimentation gets cheap. Every firmware
idea currently costs a four-minute upload and a bricking risk, which is why this project
has spent its life on static analysis. A bad flash over SWD costs thirty seconds. The
docs are full of "worth one test" entries nobody ran because the test was not worth the
risk.

## Firmware patches, ranked

Byte costs and addresses are in `research/firmware-internals.md`. This is the ordering.

| Patch | Cost | Why it is worth it |
| --- | --- | --- |
| Animation tick 50 to 100 Hz | 1 byte | doubles the smoothness of everything device-side. Compensate the tick-counted timeouts in the same patch, or the 2 s power-off becomes 1 s |
| Notify on button press | ~10-20 B | the button currently cannot talk to the host at all. Unlocks tap tempo and every phone-side interaction |
| Seed `rand()` | ~10 B | unseeded, "random" is byte-identical on every boot and two pairs play the same sequence |
| Tile palette | ~40 B | best value. Keeps the atomic single-write path but makes the vocabulary ours |
| AES key swap plus rename | 24 B | stops anyone with the vendor app hijacking your glasses in a field full of them. The rename prefix must be **exactly** 8 bytes, see below |
| Settable name over BLE | ~40-80 B plus a flash page | per-unit names that a stranger's phone sees. Low value while the host map exists |
| Button drives our content | ~50-100 B | the only route to phone-free interaction |
| Sub-column scroll interpolation | ~40-60 B | scrolling steps whole columns at up to 12.5/s, which is visibly steppy. Blending two columns through the 4 levels fixes it |
| Battery over BLE | ~30 B | all-day event, and the value already sits in RAM |
| Content into the staging bank | 60-100 B | 1.5 KB to 76.8 KB. Biggest capability jump, largest patch |

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

Three tiers, and the third is the best idea we had.

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

Still open and worth five minutes on hardware rather than more disassembly: whether the
tick is crystal-derived or from the internal RC oscillator. At crystal accuracy two pairs
stay locked essentially all night; at RC accuracy they visibly separate within seconds.
Start both animating together and time the divergence.

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
   cadence, or removes the need for one.
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
| A frame compressor | measured at 1.3x to 2.4x. Capacity and generation are 50x and 72x |
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
