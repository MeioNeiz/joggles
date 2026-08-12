# The library, and picking what shows

**This file is the judgement behind the phone's saved content: what it holds, how it is
searched, and how a thing gets from that list onto the panel in one tap.** Asked for by
Jacob 2026-08-12; the verbatim intake is in `notes/what-to-build.md`, "Handset feedback,
2026-08-12". It is deliberately about behaviour and data, not about layout: the app is
being redesigned under track 26 and the look is that track's call, not this file's.

## The four verdicts

Everything below is an argument for one of these.

| Verdict | Why |
| --- | --- |
| **Store the recipe, not the pixels** | a 736-column loop is 6,624 levels of JSON and re-renders from ~5 numbers |
| **Width is not a question worth asking** | every `DATCP` erases the same five pages whatever the payload, so a wide loop and a narrow one cost identical flash |
| **Text picks its own motion, and the app must show where the price changes** | fits in 24 columns is free, one column wider is five page erases, and that boundary falls mid-word |
| **Legibility beats filling the panel** | Jacob's direct steer, and it settles a question that would otherwise keep getting "fixed" |

## Three different things are called "the library". Keep them apart

The word is already overloaded across three modules and blurring them is how the wrong
thing gets built. `notes/WRITING.md`, "one concept, one term".

| Term | What it is | Where it lives | Costs |
| --- | --- | --- | --- |
| **The library** | everything the phone has saved, unbounded, searchable | `app/src/library.ts` + `library.json` | a local file write: free, instant, unlimited |
| **The preselect grid** | the handful pinned for one-tap showing, on the phone | does not exist yet | a tap costs whatever the item costs |
| **The playlist** | 2-10 items the **device's own button** cycles with no phone | `core/src/playlist.ts`, `notes/playlist.md` | reel mode: one save per edit, none per press |

The preselect grid and the playlist are not the same feature and must not share a screen
control. The grid is the phone driving the glasses and works today. The playlist is the
device cycling on its own, and on stock firmware the button reaches only the 21 built-ins,
so true per-item cycling is a firmware feature (`notes/playlist.md`, "The verdict that
shapes everything"). A user who pins six things to the grid has not changed what the
button does, and the app must not imply otherwise.

## What the library has to hold, and the rule that keeps it small

Today `library.ts` holds two kinds, `SavedDrawing` (216 levels) and `SavedText` (a string
plus a `Motion`). Neither an effect loop nor a built-in can be saved at all, which is why
nothing generated on the Effects screen can be found again.

**The rule: store what regenerates the content, never the content.** A drawing has no
recipe, so its 216 levels are the recipe and that is fine at ~600 bytes. An effect does
have one, and storing its output instead would put 6,624 numbers in `library.json` per
item for something that re-renders in milliseconds from a generator name, a knob bag and
a width. A built-in is one integer.

| Kind | What is stored | Rough size |
| --- | --- | --- |
| `drawing` | the 9x24 levels, as now | ~600 B |
| `text` | the string, and the font, and nothing about motion (see below) | tens of B |
| `effect` | generator name, the knob bag `effects-ui/catalogue.ts` already produces, width | ~100 B |
| `builtin` | `kind` and the `arg`, which is what `builtins.commandFor()` takes | ~40 B |

An `effect` entry rendering to a different bitmap later is a feature, not a bug: a
generator improved in `core/src/effects.ts` improves every saved loop. The risk it carries
is that a saved effect is only as reproducible as its options bag, so **an option renamed
in `effects.ts` silently changes every stored item that used it**. `revive()` is already
the trust boundary for exactly this class of problem and an unknown generator name must
drop the entry rather than throw, the same stance `library.ts` takes today.

## Search reaches our things and cannot reach the built-ins

Search over the user's own items is easy and mostly already possible: name, and for a text
item the string itself, which is usually the same thing. Kind and a date are filters
rather than search terms.

**The built-ins are the hard half, and the blocker is deliberate.** Track 20 numbered the
30 built-in banks rather than naming them, because a name read off an offline render is a
guess about content nobody has watched, and a confident wrong name beside a real
thumbnail is worse than a number (`app/src/builtins.ts`). That decision is right and it
means there is no text to match on. Three honest options, in order of preference:

1. **Browse, do not search, the built-ins.** 30 tiles with real thumbnails is a grid a
   thumb can scan in seconds. Search covers the user's own items only, and the empty state
   says so.
2. **Name them once somebody has watched them on the panel.** This is a hardware sitting,
   not a code change, and it also settles the disputed `ANIM` numbering that means a tile
   may play a different animation than it shows (`protocol.animation`'s docblock).
3. Tag them by shape offline from the thumbnails, for example "symmetric", "full", "sparse".
   Cheap, honest, and weak: nobody searches for "sparse".

Take 1 now and 2 after the sitting. Do not invent names from the renders.

**One structural fact that helps: 11 of the 30 built-ins are exactly symmetric about the
nose bridge** (9 mirrored, 2 straight copies), *verified* by walking `builtins-data.ts`.
The panel is two 9x9 fully-alive squares with a 6-row bridge between them, so per-eye is
the shape the vendor already designs to and is a real filter if a filter is wanted.

## The preselect grid: one tap, and the tap has a price

The ask is "one click, i can easily see what the animation/text is and then select it".
The picture is the label, exactly as the built-ins grid already argues: a thumbnail beats
a name at this size, and every kind above can render one with no hardware attached.

What the grid cannot do is hide the cost, because the costs differ by a factor that
matters:

| Item | Route | Cost per tap |
| --- | --- | --- |
| drawing, or text that fits 24 columns | live buffer | **free**, no flash, no `MODE` |
| built-in | `IMAG`/`ANIM` | **free**, but it takes the panel from the DIY buffer and any resident type 2 |
| the item already resident on this pair | `MODE` | **free** |
| anything scrolling and not resident | type 1 `DATS` | **five page erases** |

`app/src/deliver.ts` already prices all of this and prints the sentences; the grid needs
the *state*, not new pricing. Track 26 already owns "a visible on-the-glasses state", and
this is the same fact seen from the library: a tile that is currently resident on the
connected pair shows a free return, and every other scrolling tile shows a save. Residency
is per device because the ledger is keyed on the advert name, so the grid changes meaning
when you connect a different pair.

## Text decides its own motion, and the boundary is not where a user expects

**The rule: `font.textWidth(text) > 24` scrolls, anything shorter is static.** Motion stops
being a control. That is right and it removes the single worst offender in the current
Compose flow.

**The trap, and it is the whole reason this section exists.** The two sides of that
boundary do not merely look different, they cost different amounts:

- 24 columns or fewer fits the live buffer, so it is free and writes no flash, ever.
- One column wider must be a type 1 save, which is five page erases.

So typing one more character silently turns a free action into a flash write, and it
happens mid-word: `JOGGLE` is inside, `JOGGLES` is 27 columns and outside (*verified*, the
27 columns are off the app's decoded wire log). An auto rule that says nothing is a rule
that spends flash without asking.

The app therefore has to show the boundary rather than hide it, and the cheapest honest
way is a live column count against the panel's 24 while typing, with the price attached to
the action rather than to the keystroke. **Auto-motion is not permission to auto-save.**

Two smaller consequences of the same rule:

- The motion choice also picks the font, because `tall7` is static only: it steps glyphs
  around the nose notch and cannot survive being scrolled past fixed holes
  (`core/src/font.ts`, and `fonts/place.ts` reports drops rather than clipping).
- A stored `text` item should keep the string and the font and **not** the motion, since
  the motion is now derived. A stored motion would go stale the moment the font changed.

## Fonts: more of them is cheap, and legibility beats filling the panel

The seam already exists. `core/src/font.ts` is a facade over `core/src/fonts/` with a
`Font` type and a `DEFAULT_FONT`, built that way by track 7, so a third font is data plus
one registry entry and no architecture. What is missing is fonts and a control, not a
mechanism.

**The ruling to record, because it will otherwise keep being "fixed".** Jacob, 2026-08-12:
*"it doesnt seem to use the space efficiently although more important that the text renders
better rather than filling the vertical space"*. The panel is 9 rows and `band5` uses 5 of
them, which reads as waste and is not:

- Only rows 2 to 7 are alive in every column, so a scrolling glyph has a 6-row band and no
  more. A taller scrolling font gets chewed passing the nose bridge.
- The sixth row of that band is spent on air, deliberately: 5 rows of cap height with one
  row clear buys mixed case, and legibility at this size comes from lowercase far more
  than from a sixth row (`notes/what-to-build.md`, "A better renderer").

So a 9-row scrolling font is not an improvement anybody has failed to build, and this is
the note that says so. Height is available to *static* text only, which is what `tall7` at
7 rows already is.

Where the real gains are, in order: a condensed face, so more characters fit inside the
free 24-column budget and more text stays on the free route; a wider face for short words
where legibility at distance beats character count; and per-font kerning, which `band5`
already has as an ink profile.

*Built 2026-08-12 as track 29, two faces beside `band5`, and three things this paragraph
guessed came out differently.* **The condensed gain is a twentieth, not the step change
the ranking implies**: `slim5` measures 95% of `band5` over a corpus of real messages and
a tenth less on capitals, because the 3-column lowercase was already at the floor and only
the stem letters (C E F J L, `l`, M N W) had columns to give back. It is still worth
having, and the honest way to sell it is per string rather than per font: `JOGGLES` is 27
columns in `band5` and exactly 24 in `slim5`, which is this file's own example flipping
from five page erases to free. **The wider face came out taller instead.** The ceiling for
anything that moves is six rows and not five, since rows 2 to 7 are all alive, so `band6`
spends the sixth row on an x-height of 4 rather than on air and is the one that answers
"renders better"; it costs 122% of `band5`'s width, which is 5 characters in the free line
where `band5` gives 7. A bold 5-row face was sketched and dropped without being written:
2-column stems eat the counters at this size, so `O` `D` `Q` collapse into one block, and
the panel's answer for distance is height, which `band6` takes to its ceiling. **Per-font
kerning is per-font measurement, not per-font tables.** All three scrolling faces keep
empty `pairs`, and `slim5`'s docblock records why its own table stays empty rather than
copying `band5`'s reasoning: at `spacing: 1` an entry has one bit of freedom, and the
letters that usually need one are the ones now drawn with no overhang to tuck into.
Which face keeps a given message free is `core/src/fonts/fit.ts`, so no screen has to
hardcode a boundary that moves with the font.

## Width is not a question worth asking

The Effects screen offers five widths (`effects-ui/plan.ts`, `WIDTHS`). Jacob's verdict is
that this is overkill. He is right, and the reason is stronger than taste.

**Every `DATCP` erases the same five hardcoded 512-byte pages whatever the payload size**,
so there is no wear levelling and no benefit to saving less (`core/src/budget.ts`,
*derived* from `abs 0x218cc`). A 120-column loop and a 736-column loop cost **identical**
flash. The only thing width buys is upload time, and that is measured: 700 columns is
about 2.0 s connect-to-disconnect at the 6 ms pacing floor against 5.9 s at the vendor's
50 ms (*verified* 2026-08-09, `research/vendor-app-protocol.md`).

So the control is a question whose answer is always the same. **Render at the ceiling and
show a progress bar.** Two footnotes for whoever deletes it:

- The ceiling for a dithered loop is 736, not 740: widths snap down to the 8-column dither
  tile (`effects.seamlessWidth`).
- If per-eye pairing is wanted, the ceiling is **720**, the largest multiple of 24 that
  fits. Content with a 12-column period shows pixel-identical images on both lenses at
  every scroll offset, because panel column `c` and column `c + 12` read content 12 apart.
  24 is the lowest common multiple of the dither tile and that 12-column eye pitch.

Duration is the thing a person actually cares about, and it is width divided by the scroll
rate, so if any control survives it should be labelled in seconds and it should have a
default rather than a prompt.

## The same argument applies to everything else on that screen

Not just width. The Effects screen asks for levels, dither, direction and a per-generator
knob bag, and three of those four have a defensible automatic answer already written down
somewhere in the repo:

| Control | Automatic answer | Where the reasoning is |
| --- | --- | --- |
| Levels | 2 for anything wider than the panel; there is no choice to make | `core/src/effects.ts`, and `plan.ts` already pins it |
| Dither | per generator, and two of them already override the default | `effects-ui/catalogue.ts` |
| Direction | the one that hides the dead space at the **end** of the pass | `research/vendor-app-protocol.md`, "Both scroll directions gap" |
| The knob bag | genuinely a taste control, and the only one worth a thumb | `effects-ui/catalogue.ts` |

## Unverified

- **Nothing in this file has been driven on a handset.** The preselect grid does not exist,
  and the library screen it would sit beside was built under track 20 and has never been
  mounted where a user could reach it.
- **The per-eye 12-column pairing is arithmetic, not a sighting.** The proof is that column
  `c` and column `c + 12` read the same content at every offset; nobody has watched two
  lenses show the same motif. A field with a 12-column period is also only *nearly*
  byte-exact, because quantisation ties and the dither tile both perturb it: measured at 38
  differing cells in 2,160 for `stripes` at `dither: 'none'` and 0 at `'ordered'`. Tiling a
  rendered 12-column block is the construction that is exact by design.
- **`font.textWidth` deciding motion assumes the width it reports is the width that
  renders.** That property is tested in core and has never been checked against the panel,
  and it is the same DATS row mapping that verify item 1 of `notes/app-plan.md` still owes.
