/**
 * The search rules on the front door, asserted on source because react-native does
 * not import under bun and what a screen renders is checked on a handset.
 *
 * The matching itself is `library.test.ts`'s: this file holds the four decisions that
 * are only visible in the screen, and each of them is a thing the redesign would
 * otherwise lose. Jacob's 2026-08-12 ruling took every cost word, cost tag and confirm
 * sheet off this screen because the front door is a festival screen - one hand, seconds
 * of attention - and a search field is exactly the kind of addition that quietly puts
 * the ceremony back: furniture at the top of the grid, a keyboard over the tiles on
 * mount, or a query that appears to have deleted 30 built-ins.
 *
 * `builtins.test.ts` owns the older and larger crawl over the same file, which is what
 * keeps this screen off the wire. Nothing here duplicates it.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { expect, test } from 'bun:test'

const HERE = dirname(new URL(import.meta.url).pathname)

/**
 * Comments out, strings kept: the screen's code and its copy, which is what these
 * assertions are about. `builtins.test.ts` needs the strings-out view as well, because
 * its bans are on session objects that UI prose legitimately names; nothing here is.
 */
const code = (): string =>
  readFileSync(resolve(HERE, 'Library.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

test('the screen matches nothing itself: the one matcher is the library module', () => {
  // A second matcher is how the screen and the store end up disagreeing about what
  // "found" means, and case folding is the tell that one has been written here.
  const src = code()
  expect(src).toMatch(/import \{[^}]*\bsearch\b[^}]*\} from '\.\.\/library\.js'/)
  expect(src).not.toMatch(/toLowerCase\(/)
  expect(src).not.toMatch(/toUpperCase\(/)
})

test('search reaches the user\'s own items and nothing else', () => {
  // The whole of `notes/library.md`, "Search reaches our things and cannot reach the
  // built-ins", in one assertion: the only thing ever handed to the matcher is `mine`.
  // A query that reached IMAGES or ANIMATIONS would be filtering 30 tiles on labels
  // track 20 deliberately made numbers, so every search would hide most of them.
  const src = code()
  expect([...src.matchAll(/\bsearch\(/g)]).toHaveLength(1)
  expect(src).toMatch(/search\(mine, q\)/)
})

test('and the screen says why, rather than looking as though it lost them', () => {
  // The empty state is the one place a person is looking when the built-ins are not
  // where they left them, so it carries the reason and the way back.
  const said = code()
  expect(said).toMatch(/numbered, not named/)
  expect(said).toMatch(/Clear the search/)
  expect(said).toMatch(/Nothing of yours matches/)
})

test('the field is not permanent furniture and never takes focus', () => {
  // Two ways a search field undoes a one-tap screen: sitting above the grid when
  // there is nothing to search, and opening a keyboard over the tiles on mount.
  const src = code()
  expect(src).toMatch(/>= SEARCH_FROM/)
  expect(src).toMatch(/const SEARCH_FROM = /)

  // *Narrowed 2026-08-12 by track 38.* This banned the string `autoFocus` anywhere in
  // the file, which caught the rule it was written for and also a modal that exists to
  // take a name: one that did not focus would open a keyboard-shaped hole and wait.
  // The property is about the SEARCH field, so it is now asserted about the search
  // field: the input carrying the search placeholder must not take focus, while a
  // modal above the grid may.
  const search = src.slice(src.indexOf('placeholder="Search'))
  const props = search.slice(0, search.indexOf('/>'))
  expect(props).not.toMatch(/autoFocus/)
})

test('while a query is live, everything on the screen is a match', () => {
  // The favourites grid is a browsing shortcut, so it stands down: a pinned tile that
  // does not match would be the only thing in the results that is not a result.
  const src = code()
  expect(src).toMatch(/!searching && favourites\.length > 0/)
})

test('nothing about search brings the pricing or the confirmations back', () => {
  // Jacob's ruling, held against additions to this file rather than against the file
  // it was applied to. `builtins.test.ts` bans the specific ones the old screen had.
  const said = code()
  expect(said).not.toMatch(/erase/i)
  expect(said).not.toMatch(/Alert\./)
  expect(said).not.toMatch(/are you sure/i)
})

/**
 * Every control above the grid actually redraws it.
 *
 * Found by review-28, 2026-08-12: the sections memo read `group` and `only` and listed
 * neither as a dependency, so the group chips and the Moving/Still chips each lit
 * themselves and changed nothing underneath. It survived because the one path anybody
 * would try first works by accident - creating a group bumps `pinsAt` on its way past,
 * which invalidates the memo - so the feature works once and never again.
 *
 * Written as the general rule rather than as those two names, because the next control
 * added to this screen fails exactly the same way and no test would have said so. The
 * suite cannot render this screen, so a missing dependency is invisible to it; this is
 * the cheapest thing that is not.
 */
test('every piece of state the sections memo reads is a dependency of it', () => {
  const src = code()
  const open = src.indexOf('const groups = useMemo<Group[]>(')
  expect(open).toBeGreaterThan(-1)
  const close = src.indexOf('\n  }, [', open)
  expect(close).toBeGreaterThan(open)
  const body = src.slice(open, close)
  const deps = src.slice(close, src.indexOf('])', close))

  const declared = [...src.matchAll(/const \[(\w+), set\w+\] = useState/g)].map((m) => m[1])
  expect(declared.length).toBeGreaterThan(4)
  const missing = declared.filter(
    (name) => new RegExp(`\\b${name}\\b`).test(body) && !new RegExp(`\\b${name}\\b`).test(deps),
  )
  expect(missing).toEqual([])
})
