/**
 * The probe-never-assume rule, as tests that fail the build when it is broken.
 *
 * Two halves, and both are needed. The first is `carried.ts`'s own arithmetic: a mixed
 * fleet is exactly the situation nobody can reproduce at a bench, since no unit here
 * carries the extension at all, so the v1-app-meets-v2-unit direction and its reverse
 * are checked here or nowhere.
 *
 * The second is source crawls, in the style of `wiring.test.ts` and `theme.test.ts`:
 * react-native does not import under bun, so what a screen renders can only be checked
 * on a handset, but what a screen is *allowed to know* can be checked here. The
 * properties are the ones this repo has already paid for elsewhere - a sentence written
 * at a call site instead of in the module that owns it (`ble-words.ts` printed a MAC),
 * and a screen doing wire work of its own (review 17, and the redesign emptying
 * `Effect.tsx` of `Glasses`). The firmware-shaped versions of both are new: a screen
 * that compares a version number, or probes on its own mount, is a screen that will one
 * day offer a control the pair cannot honour.
 */
import { jgx } from '@joggles/core'
import { expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  type Carried,
  type Remembered,
  FEATURES,
  beyondWords,
  can,
  carriedLabel,
  carriedWords,
  cleanCarried,
  fromIdentity,
  offers,
  refusedWords,
  remember,
  rememberedWords,
  reports,
  unnamedBits,
} from './carried.js'

const HERE = dirname(new URL(import.meta.url).pathname)

const read = (rel: string): string => readFileSync(resolve(HERE, rel), 'utf8')

/** Comments stripped, so a sentence in a docblock cannot pass or fail a code rule. */
const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const crew = (capabilities: number, version = 1): Carried =>
  fromIdentity({ kind: 'crew', name: 'GLASSES-TEST', version, capabilities }, 1000)

const stock = (): Carried => fromIdentity({ kind: 'stock', name: 'GLASSES-TEST' }, 1000)

/**
 * Every bit core declares, derived rather than listed.
 *
 * `jgx.CAP` gained six entries on 2026-08-20 while this file was being written, and a
 * hardcoded list turned a real property into a false failure. The forward compatibility
 * these tests are about has to hold for the tests too.
 */
const ALL = Object.values(jgx.CAP).reduce((all, bit) => all | bit, 0)

/** Two bits above everything core has a name for: what a newer firmware would set. */
const FUTURE = (() => {
  let bit = 1
  while (bit <= ALL) bit <<= 1
  return [bit, bit << 1] as const
})()

// --- The record --------------------------------------------------------------------

test('a stock unit reads as an answer, with no version and no bits to gate on', () => {
  const got = stock()
  expect(got.kind).toBe('stock')
  expect(got.version).toBe(0)
  expect(got.capabilities).toBe(0)
  expect(got.at).toBe(1000)
})

test('a crew unit keeps what it said, clamped to the u16 the wire can carry', () => {
  const got = crew(jgx.CAP.BUTTON, 3)
  expect(got).toEqual({ kind: 'crew', version: 3, capabilities: jgx.CAP.BUTTON, at: 1000 })
  // A parser bug or a corrupt file must not put a negative or a fraction in front of a
  // person, and it must never widen past the two bytes HELLO actually sends.
  expect(crew(0x1ffff, -1).capabilities).toBe(0xffff)
  expect(crew(0x1ffff, -1).version).toBe(0)
  expect(crew(1.7, 2.9).version).toBe(2)
})

// --- The gate ----------------------------------------------------------------------

test('nothing is offered until the pair has answered: null gates as no', () => {
  for (const f of FEATURES) {
    expect(can(null, f.id), f.id).toBe(false)
    expect(reports(null, f.id), f.id).toBe(false)
  }
})

test('a stock pair is offered nothing and reports nothing, and that is not a fault', () => {
  for (const f of FEATURES) {
    expect(reports(stock(), f.id), f.id).toBe(false)
    expect(can(stock(), f.id), f.id).toBe(false)
  }
  // The wording is the load-bearing half: see the sentence tests below.
  expect(carriedWords(stock())).not.toMatch(/error|fail|unsupported|broken/i)
})

test('the gate is the bitmap and never the version number', () => {
  // The whole point. A high version with no bits set gets nothing; version 1 with the
  // bit set reports it. Any implementation that compared versions would invert both.
  const ancient = crew(jgx.CAP.BUTTON, 1)
  const modern = crew(0, 99)
  expect(reports(ancient, 'button')).toBe(true)
  expect(reports(modern, 'button')).toBe(false)
  for (const f of FEATURES) expect(reports(modern, f.id), f.id).toBe(false)
})

test('a v1 app meets a v2 unit by counting the bits it cannot name, never by guessing', () => {
  // Bits above everything core declares. A newer firmware is entitled to set them, and
  // this app has to meet them with a true sentence rather than a guess or a crash.
  expect(FUTURE[1]).toBeLessThanOrEqual(0xffff)
  const future = crew(ALL | FUTURE[0] | FUTURE[1], 2)
  // Everything with no feature here, plus the two nobody has a name for at all. What
  // must never happen is a bit going unmentioned, or being given an invented label.
  const named = FEATURES.filter((f) => reports(future, f.id)).length
  expect(unnamedBits(future)).toBe(bitsIn(ALL) - named - 1 + 2)
  // And nothing new becomes available by accident: every offer is still off, because
  // `here` is false on all of them and an unnamed bit maps to no feature at all.
  for (const o of offers(future)) expect(o.offered, o.feature.id).toBe(false)
  expect(beyondWords(future)).toContain('more things')
})

test('the probe bit is not counted as something the app cannot do', () => {
  // It would be false, and false on every crew pair: SESSION is the HELLO that answered.
  expect(unnamedBits(crew(jgx.CAP.SESSION))).toBe(0)
  expect(beyondWords(crew(jgx.CAP.SESSION))).toBeNull()
})

/** Set bits in a mask. The minus one in the sweep above is SESSION. */
const bitsIn = (mask: number): number => {
  let rest = mask
  let n = 0
  while (rest !== 0) {
    rest &= rest - 1
    n++
  }
  return n
}

test('a v2 app meets a v1 unit by finding the bit clear, and has a sentence for it', () => {
  // The reverse direction: a unit reporting only SESSION. Every other family is absent
  // rather than broken, and each one has words rather than a blank.
  const old = crew(jgx.CAP.SESSION, 1)
  expect(unnamedBits(old)).toBe(0)
  for (const o of offers(old)) {
    expect(o.reports, o.feature.id).toBe(false)
    expect(o.offered, o.feature.id).toBe(false)
    expect(o.words.length, o.feature.id).toBeGreaterThan(20)
  }
  expect(beyondWords(old)).toBeNull()
})

test('an unknown feature id is not offered rather than throwing into a render', () => {
  // Cast because the union is closed; a stale persisted screen state or a typo in a
  // future call site is what this covers, and a render must not take the tab down.
  const bogus = 'no such feature' as Parameters<typeof can>[1]
  expect(can(crew(ALL), bogus)).toBe(false)
  expect(reports(crew(ALL), bogus)).toBe(false)
})

// --- The refusal -------------------------------------------------------------------

test('firmware over the air is refused however the pair reports it', () => {
  // `notes/app-plan.md` safety item 1 is not "later". The bit is real, the pair may
  // truthfully set it, and the answer is still no - so a control asking `can()` can
  // never be built for it by turning `here` on somewhere.
  const willing = crew(ALL)
  expect(reports(willing, 'firmwareUpdate')).toBe(true)
  expect(can(willing, 'firmwareUpdate')).toBe(false)
  const entry = FEATURES.find((f) => f.id === 'firmwareUpdate')
  expect(entry?.never).toBe(true)
  expect(entry?.here).toBe(false)
})

test('the refusal is said out loud when the bit is set, and not otherwise', () => {
  expect(refusedWords(crew(jgx.CAP.UPDATE))).toContain('never writes firmware')
  expect(refusedWords(crew(jgx.CAP.BUTTON))).toBeNull()
  expect(refusedWords(stock())).toBeNull()
  expect(refusedWords(null)).toBeNull()
})

test('a refused feature is not listed as one this app has no control for yet', () => {
  // Otherwise the dashboard would say "no control for it yet" about the one thing that
  // is never coming, which reads as a promise.
  expect(beyondWords(crew(jgx.CAP.UPDATE))).toBeNull()
  expect(beyondWords(crew(jgx.CAP.BUTTON))).toContain('button')
  // And a family bit with no feature mapped to it is counted rather than named, which
  // is what keeps the sentence true as `jgx.CAP` grows past what this app offers.
  expect(beyondWords(crew(jgx.CAP.INPUT))).toContain('1 more thing this version')
})

test('every family jgx declares is either mapped to a feature or simply not offered', () => {
  // Not "every family has a feature": a family with no entry is correctly invisible.
  // What must hold is that no feature names a family core does not have, which is how
  // a rename in `jgx.CAP` would otherwise become a silently dead gate.
  for (const f of FEATURES) expect(jgx.CAP[f.needs]).toBeGreaterThan(0)
  expect(new Set(FEATURES.map((f) => f.id)).size).toBe(FEATURES.length)
  expect(new Set(FEATURES.map((f) => f.needs)).size).toBe(FEATURES.length)
})

// --- The words ---------------------------------------------------------------------

test('silence never reads as a failure, in any sentence about a stock pair', () => {
  // The rule this module exists for. A stock unit does not recognise our opcode and
  // sends nothing back; a person must never be shown that as something going wrong.
  const said = [carriedWords(stock()), carriedLabel(stock()), rememberedWords(remember(stock()))]
  for (const words of said) {
    expect(words).not.toBeNull()
    expect(words).not.toMatch(/error|fail|unsupported|unavailable|problem|no answer/i)
  }
  expect(carriedWords(stock())).toContain('not a fault')
  expect(beyondWords(stock())).toBeNull()
  expect(refusedWords(stock())).toBeNull()
})

test('the probing line is a question in progress, not a verdict', () => {
  expect(carriedLabel(null)).toBe('identifying...')
  expect(carriedWords(null)).toMatch(/asking/i)
  expect(carriedWords(null)).not.toMatch(/error|fail|unknown pair/i)
})

test('every sentence is a sentence: no blanks, no dashes, no wrapping', () => {
  const every = [
    carriedWords(null),
    carriedWords(stock()),
    carriedWords(crew(ALL, 7)),
    beyondWords(crew(ALL | 0x0020, 7)),
    refusedWords(crew(jgx.CAP.UPDATE)),
    rememberedWords(remember(stock())),
    rememberedWords(remember(crew(0, 4))),
    ...FEATURES.map((f) => f.absent),
  ]
  for (const words of every) {
    expect(words).not.toBeNull()
    const text = words as string
    expect(text.length).toBeGreaterThan(20)
    expect(text.trim()).toBe(text)
    expect(text.endsWith('.')).toBe(true)
    // British English house style, and a screen cannot re-wrap a hard newline.
    expect(text).not.toMatch(/[–—]/)
    expect(text).not.toContain('\n')
  }
})

test('the version is printed and only printed', () => {
  expect(carriedLabel(crew(0, 12))).toBe('crew firmware v12')
  expect(carriedWords(crew(0, 12))).toContain('v12')
  expect(rememberedWords(remember(crew(0, 12)))).toContain('v12')
})

// --- Remembering -------------------------------------------------------------------

test('a remembered answer cannot be gated on, and the type is what stops it', () => {
  const stored: Remembered = remember(crew(ALL))
  // @ts-expect-error a Remembered is not a Carried: `remembered?: never` is the wall,
  // and this line failing to error means a stale answer can reach the gate again.
  can(stored, 'button')
  expect(stored.remembered).toBe(true)
})

test('a stored record is shape-checked, so a bad file cannot reach the dashboard', () => {
  expect(cleanCarried(null)).toBeNull()
  expect(cleanCarried('stock')).toBeNull()
  expect(cleanCarried({ kind: 'mystery', at: 1 })).toBeNull()
  expect(cleanCarried({ kind: 'crew' })).toBeNull()
  expect(cleanCarried({ kind: 'crew', at: 'yesterday' })).toBeNull()
  expect(cleanCarried({ kind: 'crew', at: 5, version: 'two', capabilities: {} })).toEqual({
    remembered: true,
    kind: 'crew',
    version: 0,
    capabilities: 0,
    at: 5,
  })
})

// --- Source crawls -----------------------------------------------------------------

/** Every source file in the app, App.tsx included. */
function sources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
      out.push(full)
    }
  }
  walk(resolve(HERE))
  out.push(resolve(HERE, '../App.tsx'))
  return out
}

const stripped = (full: string): string =>
  readFileSync(full, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

test('the shell is the only prober in the app', () => {
  // A screen that probed on its own mount would re-ask on every tab change, so a gate
  // would answer "no" for as long as the round trip takes and a control would come and
  // go under someone's thumb. It also multiplies the frames a stock unit ignores.
  const probers = sources().filter((f) => /\.probe\(/.test(stripped(f)))
  expect(probers.map((f) => f.replace(`${resolve(HERE, '..')}/`, ''))).toEqual(['App.tsx'])
})

test('the probe is caught, because a link that drops mid-probe rejects', () => {
  // `glasses-screen.test.ts` pins the core behaviour: silence is an answer but a failed
  // write is a rejection, so a bare .then() is an unhandled rejection every time a link
  // drops before the answer lands.
  const shell = code('../App.tsx')
  expect(shell).toMatch(/\.probe\(\)[\s\S]{0,600}?\.catch\(/)
})

test('the answer is remembered on the advert name, never on a platform handle', () => {
  // The same rule `ble-words.ts` exists for: a handle is a MAC on Android and a
  // per-install UUID on iOS, and every other per-pair fact in this app is keyed on the
  // advert name. A record keyed on a handle would also be orphaned by a reinstall.
  const shell = code('../App.tsx')
  expect(shell).toMatch(/settings\.setCarried\(\s*g\.name/)
  for (const full of sources()) {
    const src = stripped(full)
    expect(src, full).not.toMatch(/setCarried\([^)]*\.id\b/)
  }
})

/** The screens, which may print what a pair is and must not work it out. */
const SCREENS = [
  '../App.tsx',
  './screens/GlassesScreen.tsx',
  './screens/Library.tsx',
  './screens/Create.tsx',
  './screens/Spray.tsx',
  './screens/AnimationPack.tsx',
  './screens/create/Message.tsx',
  './screens/create/Effect.tsx',
  './screens/create/DrawPanel.tsx',
]

test('no screen compares a firmware version: assuming is what probing replaced', () => {
  // The defect this guards is the one the mixed fleet makes inevitable. `version >= 2`
  // is wrong in both directions at once: it offers a v2 feature to a v2 unit that was
  // built without it, and withholds a v1 feature from a v1 unit that has it. The bitmap
  // is the contract; the number is decoration.
  for (const screen of SCREENS) {
    const src = code(screen)
    // The strong form, because the comparison itself is easy to hide inside a
    // parenthesised default: a screen may not GET a version at all. Both ways in are
    // shut, member access and destructuring, so there is nothing to compare with.
    expect(src, screen).not.toMatch(/\.version\b/)
    expect(src, screen).not.toMatch(/\{[^}\n]*\bversion\b[^}\n]*\}\s*=/)
    expect(src, screen).not.toMatch(/\bversion\b\s*(?:===|!==|>=|<=|>|<)/)
    expect(src, screen).not.toMatch(/(?:===|!==|>=|<=|>|<)\s*\w*\.?version\b/)
  }
})

test('no screen touches a capability bitmap or names a CAP bit', () => {
  // Gating is `can()`. A screen reading `.capabilities` is a screen with its own idea of
  // what a bit means, which is how two places come to disagree about one pair.
  for (const screen of SCREENS) {
    const src = code(screen)
    expect(src, screen).not.toMatch(/\.capabilities\b/)
    expect(src, screen).not.toMatch(/\bCAP\./)
    expect(src, screen).not.toMatch(/\bjgx\b/)
    expect(src, screen).not.toMatch(/\bsupports\(/)
  }
})

test('the dashboard prints the words and composes none of its own', () => {
  const src = code('./screens/GlassesScreen.tsx')
  expect(src).toMatch(/from '\.\.\/carried\.js'/)
  expect(src).toContain('carriedWords(')
  expect(src).toContain('carriedLabel(')
  // No sentence about firmware may be written here. `ble-words.ts` earned this rule the
  // expensive way: the wording that reached a person was the one invented at the call
  // site, and it printed a MAC.
  expect(src).not.toMatch(/['"`][^'"`\n]*firmware/i)
})

test('probing opens no route to writing firmware', () => {
  // Safety item 1 is structural in `core` (the barrel has no OTA in it, and
  // `safe-surface.test.ts` fails the build if that leaks). This is the app-side half:
  // knowing a unit could be re-patched must not put a way to do it within reach.
  for (const file of ['./carried.ts', '../App.tsx', './screens/GlassesScreen.tsx']) {
    const src = code(file)
    expect(src, file).not.toMatch(/\bfd0[012]\b/)
    expect(src, file).not.toMatch(/firmware\.js/)
    expect(src, file).not.toMatch(/\bUPD_/)
    expect(src, file).not.toMatch(/\bupd(?:Begin|Data|End|Abort|Status)\(/)
    expect(src, file).not.toMatch(/\b(?:ota|dfu)\./)
  }
})

test('carried.ts is pure: no session, no BLE, no react-native', () => {
  const src = code('./carried.ts')
  expect(src).not.toMatch(/from 'react/)
  expect(src).not.toMatch(/from '\.\/ble/)
  expect(src).not.toMatch(/\bGlasses\b/)
  expect(src).not.toMatch(/\bsave\(|\bcommand\(|\bDATCP\b/)
})
