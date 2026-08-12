/**
 * Source-level crawls over the imported-animation browser.
 *
 * react-native does not import under bun, so what a screen renders can only be checked on
 * a handset. What CAN be checked here is the shape the redesign insists on, and each
 * property below has been a real defect in this repo before: a screen owning a session
 * (review 17, nothing could be mounted without hardware), two screens writing their own
 * version of what a route costs, and a control built on an opcode the firmware ignores.
 *
 * `effects-ui/wiring.test.ts` is the same crawl over the Effect creator and the spelling
 * rules here are lifted from it deliberately, so the two screens are held to one standard.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const here = dirname(new URL(import.meta.url).pathname)
const read = (rel: string): string => readFileSync(resolve(here, rel), 'utf8')

/** Comments stripped, so a sentence in a docblock cannot pass or fail a code assertion. */
const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const SCREEN = './AnimationPack.tsx'

test('the screen holds no session, no sender and no opcode: it plans and hands up', () => {
  const src = code(SCREEN)
  // Not a bare `/\bGlasses\b/` the way `wiring.test.ts` can afford: this screen names the
  // Glasses tab in its own copy ("connect on the Glasses tab"), so the ban has to be the
  // two things that would actually be a session - importing the class, and reaching a
  // member on one - rather than the word.
  expect(src).not.toMatch(/import\s*\{[^}]*\bGlasses\b/)
  expect(src).not.toMatch(/\bGlasses\s*[.[(]/)
  expect(src).not.toMatch(/\bglasses\s*[.[]/)
  expect(src).not.toMatch(/\bPanelSession\b/)
  expect(src).not.toMatch(/\bLiveSender\b/)
  expect(src).not.toMatch(/\bFramePlayer\b/)
  expect(src).not.toContain('protocol')
  expect(src).not.toMatch(/from '\.\.?\/+ble/)
  expect(src).not.toMatch(/\bdeliver\b/)
  // What it does instead: two callbacks the shell owns.
  expect(src).toContain('onPlay(')
  expect(src).toContain('flow.show(')
  expect(src).toContain('anim.filmstripPiece(')
})

test('no flash number and no cost sentence is written here', () => {
  const src = code(SCREEN)
  // The wording for both routes comes from core, verbatim. A screen that phrased it
  // again could promise frame playback from a store that pans.
  expect(src).toContain("anim.routeWords(preview, 'live')")
  expect(src).toContain("anim.routeWords(preview, 'filmstrip')")
  expect(src).not.toMatch(/\berases?\b/)
  expect(src).not.toMatch(/\bpage erases\b/)
})

test('the honest word for the saved route reaches the screen, not just the docblock', () => {
  // `routeWords` is what prints it, so the property belongs to core. Asserted from here
  // as well because this is the screen where a person decides between the two, and the
  // difference between "plays" and "pans" is the whole decision.
  const words = read('../../../core/src/anim.ts')
  expect(words).toContain('pan across the frames rather than cutting between them')
})

test('search is always on, unlike the library front door', () => {
  const src = code(SCREEN)
  expect(src).toContain('TextInput')
  // `Library.tsx` reveals its box only past `SEARCH_FROM` items. Here the pack is
  // hundreds of rows from the first render, so a threshold would be wrong.
  expect(src).not.toContain('SEARCH_FROM')
  expect(src).toContain('animations.search(')
})

test('the grid draws one frame per tile and never a timer per tile', () => {
  const src = code(SCREEN)
  expect(src).toContain('animations.thumbOf(')
  // One preview loop exists, in the sheet. Two would mean the grid animates.
  expect(src.match(/setTimeout/g) ?? []).toHaveLength(1)
})

test('the screen renders with nothing connected, which is review 17 promoted', () => {
  const src = code(SCREEN)
  // Both actions gate on `connected`, and nothing about mounting does.
  expect(src).toContain('disabled={!connected || busy}')
  expect(src).not.toMatch(/if\s*\(\s*!connected\s*\)\s*return/)
})

test('provenance is on the sheet, because a CC0 claim has to be checkable', () => {
  const src = code(SCREEN)
  expect(src).toContain('chosen.licence')
  expect(src).toContain('chosen.pack')
  expect(src).toContain('chosen.author')
})

test('the shell forwards the progress callback instead of feeding it to the key slot', () => {
  // Found 2026-08-12 while wiring this screen onto `useTapFlow`. The helper calls its
  // `onTap` with the progress callback THIRD; `App.tsx`'s `tap` takes the library key
  // third. Screens declaring `onTap` as two parameters therefore silently sent the
  // callback into `key`, leaving `progress` undefined - so track 34's upload bar never
  // moved on the Create tab, and `showing` was handed a function.
  const shell = code('../../App.tsx')
  expect(shell).toContain('tap(what, plan, null, progress)')
  // The two flow-driven screens (Create and this one) take the adapter. Library keeps
  // the raw `tap`, deliberately: it never goes through the flow and passes a real key.
  expect(shell.match(/onTap=\{tapWithProgress\}/g) ?? []).toHaveLength(2)
  expect(shell.match(/onTap=\{tap\}/g) ?? []).toHaveLength(1)
})

test('a tap stops the frame loop first, so nothing writes through a dropped sender', () => {
  const shell = code('../../App.tsx')
  expect(shell).toContain('if (playingPack !== null) await stopPack()')
  // And a disconnect tears the player down before the session it writes through.
  expect(shell).toMatch(/await player\.current\?\.stop\(\)[\s\S]{0,200}session\.current = null/)
})
