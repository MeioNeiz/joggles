/**
 * The search rules on the spray's picker, asserted on source because react-native does
 * not import under bun and what a screen renders is checked on a handset.
 *
 * `spray.test.ts` owns the module, the pass structure and the crawls that keep this
 * feature off everybody's flash; nothing here goes near any of that. These are the four
 * decisions that live only in the picker, and they are deliberately the same four
 * `library-screen.test.ts` holds for the front door: a second search field is exactly
 * where two screens start disagreeing about what "found" means.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { expect, test } from 'bun:test'
import { NOT_SEARCHED } from '../builtins.js'

const HERE = dirname(new URL(import.meta.url).pathname)

/** Comments out, strings kept: the picker's code and its copy, as the front door's. */
const code = (): string =>
  readFileSync(resolve(HERE, 'Spray.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

test('the picker matches nothing itself: the one matcher is the library module', () => {
  // Case folding in this file is the tell that a second matcher has been written here,
  // which is how the two screens would come to disagree about the same query.
  const src = code()
  expect(src).toMatch(/import \{[^}]*\bsearch\b[^}]*\} from '\.\.\/library\.js'/)
  expect(src).not.toMatch(/toLowerCase\(/)
  expect(src).not.toMatch(/toUpperCase\(/)
})

test('search reaches your own items and never the 30 built-ins', () => {
  const src = code()
  expect([...src.matchAll(/\bsearch\(/g)]).toHaveLength(1)
  expect(src).not.toMatch(/search\([^)]*BUILTINS/)

  // Browsed instead, with the reason on screen rather than a shelf that appears to have
  // lost 30 things. The sentence is the built-ins' own, so both screens print one wording.
  expect(src).toMatch(/\bNOT_SEARCHED\b/)
  expect(NOT_SEARCHED).toMatch(/numbered, not named/)
})

test('the field is not permanent furniture and never takes focus', () => {
  // Two ways a field undoes a screen whose job is one thumb at a festival: sitting above
  // the shelf when there is nothing to search, and opening a keyboard over the tiles on
  // mount. The threshold is items, not matches, so a query cannot remove its own field.
  const src = code()
  expect(src).toMatch(/const SEARCH_FROM = /)
  expect(src).toMatch(/>= SEARCH_FROM/)
  expect(src).toMatch(/items\?\.length \?\? 0\) >= SEARCH_FROM/)

  const field = src.slice(src.indexOf('placeholder="Search'))
  expect(field.slice(0, field.indexOf('/>'))).not.toMatch(/autoFocus/)
})

test('a query narrows what is offered and never what is sent', () => {
  // The pick is state, not a row in the shelf. A query that hides the chosen tile must
  // leave the payload alone, or the button would spray something other than the thing
  // that was chosen - so the picker never clears the pick, and says the pick survived.
  const src = code()
  expect(src).not.toMatch(/setPick\(null\)/)
  expect(src).toMatch(/stays picked/)

  // The payload memo reads the pick and nothing about the query, which is that property
  // stated where it is enforced rather than only in prose.
  const memo = src.slice(src.indexOf('const payload = useMemo'))
  expect(memo.slice(0, memo.indexOf('}, ['))).not.toMatch(/\b(query|yours|q)\b/)
})

test('the spray reaches the radio only through the one door, so it cannot mix sources', () => {
  // Track 66 checked the spray for the bleed it fixed on the Glasses screen, because this
  // is the feature where mistaking a simulated pair for a stranger's would matter: the
  // consent policy is keyed on the advert name, and a spray is aimed at pairs nobody here
  // owns. It cannot mix them, and the reason is structural rather than careful: both the
  // scan and the open go through `ble.ts`'s `scanner`, which filters every advert to the
  // active source and refuses a handle from the other one. A `BleScanner` of its own, or
  // a `FakeScanner`, would each be a second door with none of that.
  const src = code()
  expect(src).toContain('scanner.scan(')
  expect(src).toContain('scanner.connect(')
  expect(src).not.toContain('new BleScanner')
  expect(src).not.toContain('new FakeScanner')
  // Not the import: `fake-glasses.test.ts` already crawls the whole package for that and
  // asserts `ble.ts` is the only file allowed to name it. Naming the module path here
  // would make this file an offender in that crawl, which is exactly the point of it.
})
