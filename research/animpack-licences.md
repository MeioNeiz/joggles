# The animation pack's sources and licences

Everything bundled in `packages/app/src/animpack-data.ts` is CC0, and every licence
below was read on the pack's own OpenGameArt page, not inferred from a search result.
*verified* 2026-08-12: `animpack fetch` parses the page's License(s) field and refuses
to download a pack whose page stops saying CC0, so a re-run re-proves this table. The
harvest tool and the per-pack layout notes: `research/tools/animpack.ts`. The working
directory `research/animpack-sources/` is gitignored; source binaries are never
committed, only the converted frames and this record.

## Bundled, all CC0

| Pack | Author | Page | Taken |
| --- | --- | --- | --- |
| 8x8 Critter Pack | patvanmackelberg | https://opengameart.org/content/8x8-critter-pack | 8 walk cycles |
| 8x8 Character Pack | patvanmackelberg | https://opengameart.org/content/8x8-character-pack | 7 villager walks |
| Pixel Art Animated Slime | rvros | https://opengameart.org/content/pixel-art-animated-slime | idle, move, attack, hurt |
| Rotating Coin | puddin | https://opengameart.org/content/rotating-coin | 1 rotation |
| Explosion | Cuzco | https://opengameart.org/content/explosion | 1 sequence |
| Animated Ocean Water Tile | PokoMoko | https://opengameart.org/content/animated-ocean-water-tile | 1 loop |
| 16x16 Animated Campfire | Krial | https://opengameart.org/content/16x16-animated-campfire | 1 loop |
| Campfire Pixel Art | ArlanTR | https://opengameart.org/content/campfire-pixel-art-animated | 1 loop |
| Campfire Animation | crad | https://opengameart.org/content/campfire-animation | 1 loop |

CC0 asks for nothing, including attribution; authors are recorded anyway, per row in
the data file, because a person browsing the library deserves to know who drew a thing
and `deliver`-style honesty costs one string.

## Fetched under CC0 and yielding nothing yet

Both stay in the manifest so the convert report keeps saying why, and so the next
session does not re-derive the attempt.

- **Beating Heart** (Darsycho, https://opengameart.org/content/beating-heart-0): the
  64px soft-shaded drawing quantises to level 1 speckle and its pulse moves 1.3
  columns a frame. Rejected by the filter, correctly.
- **Pixel Art Loading Icon 2** (qubodup,
  https://opengameart.org/content/pixel-art-loading-icon-2): 68px after cropping,
  over the 64px source-size policy.

## Considered and dropped, with the reason

- **Micro Character Bases - Basics** (thkaspar): OGA-BY 3.0, attribution-required.
  The bundle is CC0 only; attribution-required licences would need the app to ship
  and display the credit, which is a feature nobody has built. Not fetched.
- **Explosion effects and more** (Soluna Software): dual CC-BY 3.0 + CC0. Taking the
  CC0 option would be legitimate; dropped anyway because there is no shortage of
  unambiguous packs and the manifest's licence column stays one word.
- **2D Spell Effects** (Mikodrak, CC0): fetched during the first harvest, then
  excluded from the manifest: frames are 98x203 to 184x85, far over the 64px policy.
  Same for **para's particle fx** (CC0, 1024px sheets), **stumpystrust's Explosion
  Sheet** (128px frames), **Mikodrak's FIRE** (81x123), **rileygombart's top-down
  zombie** (318x294), **rubberduck's magic flame** (256x300), **cethiel's Water
  Magic / Weapon Slash** (126x150), and **beast's Smoke Aura** (256px). All verified
  CC0 on their pages; all would be mush on 9 rows.
- **Tiny Characters Set** (fleurman, CC0) and **Tiny Creatures** (clint-bellanger,
  CC0): fetched, viable at 16x17, not yet cut. The characters are named F_01..M_12 in
  the source, which is a real name that tells a searcher nothing, and 24 more
  lookalike walkers would pad the count the way track 20's numbered built-ins did.
  The obvious next harvest if Jacob wants volume over variety.

## Unverified

- Whether OpenGameArt's License(s) field can disagree with a pack's own README inside
  its zip. Nothing seen so far disagrees; `PROVENANCE.txt` in each pack directory
  records what the fetch read and when.
