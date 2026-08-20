# HACKED on the panel

**One command, no flash, no hardware needed to judge it: `bun run hacked`.** It prints
four treatments of the word in a face drawn for this display and connects to nothing.
`bun run hacked notch --show` is the version that reaches the glasses, and it costs zero
page erases.

The design decisions and the arithmetic behind them are in the docblock of
`packages/cli/src/hacked.ts`, which is where they belong. This file is what that file
cannot say: what was ruled out, what was measured, and what nobody has looked at.

## The four rulings that shaped it

Jacob, 2026-08-19, in order, each one closing a door the rest of the repo leaves open:

| Ruling | What it removes | What it unlocks |
| --- | --- | --- |
| "write HACKED on the glasses" | nothing | the task |
| "i dont want the hacked scrolling" | scrolling | it must fit 24 columns |
| "def not using any default rendering style" | the `font.ts` faces | bespoke letterforms |
| "the hacked message does not need to persist" | the type 1 save | **grey, zero flash** |

The last two are the interesting pair. Without the third there was a perfectly good
answer already in the repo, and without the fourth grey would have been unaffordable.

## The stock faces were out on their own merits too

Measured with `font.fit('HACKED', face)`, not guessed:

| Face | Columns | Verdict |
| --- | --- | --- |
| `band5` | 23 | fits in 24, five rows |
| `slim5` | 21 | fits in 24, five rows, condensed |
| `band6` | 29 | does not fit |
| `tall7` | 29 | does not fit, drops "ED" |

So half the repo's faces could never have shown this word statically, and the two that
could are five rows tall **because they are built to scroll**. `fonts/band5.ts` spends
its sixth row on air so a glyph keeps every stroke while crossing the nose bridge.
Static content crosses nothing, so that row is free: the bespoke face is six rows in the
same three columns per letter, a fifth more cap height for no width at all.

## One line is the only composition that works, and here is the arithmetic

Two stacked lines were considered and they do not fit. Worth recording, because it looks
like it should work on a 9-row panel and the reason it does not is the notch rather than
the row count.

- Three letters a line needs about 7 columns each to be legible, which puts the middle
  letter of each line over columns 8 to 14.
- Rows 8, 1 and 0 are dead across exactly that span (`display.alive`), so the top line
  would lose its top row and the bottom line its bottom two, in the middle letter only.
- Pulling both lines clear of the holes leaves rows 5 to 7 and rows 2 to 4: three rows a
  line. Three-row letters at 7 columns wide are not letters.

**So: one line, rows 2 to 7, six letters, four columns each including the gap.** Every
other decision is downstream of that.

## The composition is the panel's own shape

Six letters at three columns plus a gap is 23 of 24, which leaves exactly one column of
slack, and the only real design freedom left is **where the gaps go**.

The word breaks 3 and 3: `HAC` in columns 0 to 10, `KED` in columns 13 to 23. The two
columns left over are 11 and 12, which straddle 11.5, the axis `content.centreOffset`
and `effects.mirrorFolds` both snap to. One half per lens, and the word's own break sits
on the nose bridge, where the panel has no LEDs in three of its rows.

Centring the whole word instead would put the break on column 11, one column off the
axis, and lose the lens-per-half reading. That is the entire argument for not calling
`content.centre` here.

Every treatment that decorates rows 0, 1 or 8 draws only where `alive()` says there is
an LED, so each rule arrives as two segments with a break in it, in line with the word's.
The composition breaks where the hardware breaks, which is what makes it read as
deliberate rather than as text that happened to fit.

## What grey is for here

The repo's own finding, *verified* on hardware and recorded in `notes/protocol.md`
("The steps are subtle"): three eight-column bands at levels 1, 2 and 3 read as three
increasing steps, but six-column bands at different levels were **not separable side by
side**. The level-to-brightness curve belongs to the panel module and no firmware patch
reaches it (`research/firmware-internals.md`).

Read that forwards rather than as a warning: **a single level 1 pixel beside a level 3
one will probably not read as dim, it will read as the stroke being wider.** At three
columns a letter that is the effect you want, and it is the only way to imply a stroke
the grid cannot draw. So `soften()` puts level 1 on staircase corners and nowhere else:
ten pixels in the whole word, two on the A's apex, four rounding the C, two rounding the
D, two on the steps of the K's arms. The H and the E get none, because square is what
they are supposed to be.

**Level 2 is unused on purpose.** With the steps as subtle as they are, a third value
buys nothing and makes the composition harder to reason about. `hacked.test.ts` fails the
build if a treatment introduces one.

## The four treatments

Renders are through `viewport.windowAt`, so the mask is applied at the window in panel
coordinates, and a blank means the panel has no LED there rather than an unlit one.
`#` is level 3, `-` is level 1, `.` is an LED that is off.

    notch                            outline
    .........      .........         ---------      ---------
    #.#.-#-.-##..#.#.###.##-         #.#.-#-.-##--#-#.###.##-
    #.#.#.#.#-...##-.#...#.#         #.#.#.#.#-...##-.#...#.#
    ###.#.#.#....#...##..#.#         ###.#.#.#....#...##..#.#
    #.#.###.#....#...#...#.#         #.#.###.#....#...#...#.#
    #.#.#.#.#-...##-.#...#.#         #.#.#.#.#-...##-.#...#.#
    #.#.#.#.-##..#.#.###.##-         #.#.#.#.-##--#.#.###.##-
    ..........    ..........         -........-    -........-
    .........      .........         ---------      ---------

    terminal                         flat
    ---------      ---------         .........      .........
    ........................         #.#..#...##..#.#.###.##.
    #.#.-#-.-##..#.#.###.##-         #.#.#.#.#....##..#...#.#
    #.#.#.#.#-...##-.#...#.#         ###.#.#.#....#...##..#.#
    ###.###.#....#...##..#.#         #.#.###.#....#...#...#.#
    #.#.#.#.#-...##-.#...#.#         #.#.#.#.#....##..#...#.#
    #.#.#.#.-##..#.#.###.##-         #.#.#.#..##..#.#.###.##.
    ..........    ..........         ..........    ..........
    ---------      ---------         .........      .........

| Treatment | Level 3 | Level 1 | The argument for it |
| --- | --- | --- | --- |
| `notch` | 66 | 10 | letters as large as 24 columns allow, one gap and it is the bridge |
| `outline` | 66 | 55 | `display.edgePixels()` traces the panel, so the notch gets drawn |
| `terminal` | 57 | 46 | a row of letter height traded for a frame the hardware broke |
| `flat` | 66 | 0 | the control, for if the soft corners come back looking like dirt |

**The recommendation is `notch`**, on the grounds that the word is the whole point and
every dim pixel added to it is a pixel competing with the word on a panel whose levels
barely separate. `outline` is the one to look at second, because it is the only one that
makes the nose notch part of the picture. `flat` exists so that a bad first look at grey
does not cost a redesign.

## Delivery, and why nothing here writes flash

The live buffer, and only the live buffer: 24 columns out on `960b`, no DATS, no `MODE`,
no page erases. The cost sentence the script prints is `app/src/deliver.ts`'s own rather
than a new one.

**It survives the disconnect.** `end('keep')` is what `packages/cli/src/verify.ts
column0` relies on and what `app/src/spray.ts` is built on, so the laptop sends it and
walks away and the glasses keep showing it until someone power-cycles them. That is
exactly the behaviour asked for, and it is the reason the persistence question stopped
mattering.

The costed alternative is deliberately **not** offered. A type 1 save would be five page
erases on a unit that has just been brought back from the dead, and it would flatten
every grey pixel, so it would buy a worse-looking word at the only price this project
actually cares about.

`--show` takes `.claude/locks/glasses` before connecting and refuses outright if someone
else holds it, printing what the lock says. `--lock-is-mine` proceeds for the holder and
**never deletes a lock it did not write**.

## Unverified

- **How level 1 beside level 3 actually reads on the panel.** Nobody has looked. The
  prediction above, that it reads as a wider stroke rather than as a dim one, is
  *derived* from the band experiment in `notes/protocol.md` and is the single thing a
  first look should settle. `flat` is the fallback if it comes back wrong.
- **Whether a six-row cap height is legible at arm's length.** Every previous scrolling
  face has been five rows and nothing of ours has been watched on the panel at all.
- **Whether the lens split reads as one word.** The break is two columns wide, which is
  twice the inter-letter gap; the theory is that the wearer's nose sits in it so the
  eye completes the word. *Unverified*, and it is the other thing to look at first.
- **`--reveal`**, which brings the letters in one batch at a time over about 1.3
  seconds and then stops. It is 24 columns arriving in six batches, not an animation the
  device runs, so it needs a connection and it ends static. Never run.
