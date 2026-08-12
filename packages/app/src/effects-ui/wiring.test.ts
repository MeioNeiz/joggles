/**
 * Source-level crawls over the Effect creator, because react-native does not import
 * under bun and what a screen renders can only be checked on a handset.
 *
 * The properties are track 13's, carried through the track 26 rewrite; each has been
 * a real defect somewhere in this repo: a control built on an opcode the firmware
 * ignores, two screens writing their own version of what a save costs, a hardcoded
 * erase count drifting from the one *derived* number, and a screen nobody could
 * mount without hardware (review 17). The redesign strengthens the biggest one: the
 * screen no longer touches `Glasses` AT ALL - it plans with `planLoop`/`planTap` and
 * hands the plan to the shell's runner - so the allow-list of reachable session
 * members is now empty.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const here = dirname(new URL(import.meta.url).pathname)
const read = (rel: string): string => readFileSync(resolve(here, rel), 'utf8')

/** Comments stripped, so a sentence in a docblock cannot pass or fail a code assertion. */
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const SCREEN = '../screens/create/Effect.tsx'

test('the screen builds no frames and holds no session: the tap flow is its only wire', () => {
  const src = code(SCREEN)
  // Not "no ignored opcode" but the stronger thing: no opcode at all, no session
  // object, no BLE layer. A dynamic `await import()` is caught by the same strings.
  expect(src).not.toContain('protocol')
  expect(src).not.toMatch(/\bp\.\w+\(/)
  expect(src).not.toMatch(/from '\.\.?\/+ble/)
  // The word appears in UI copy ("Send to glasses"); what is banned is the session
  // object and any member access on one, the same spelling rules builtins.test.ts uses.
  expect(src).not.toMatch(/\bGlasses\b/)
  expect(src).not.toMatch(/\bglasses\s*[.[]/)
  expect(src).not.toMatch(/\bdeliver\b/)
  // What it does instead: price and check through the plan, show through the flow.
  expect(src).toContain('planLoop(')
  expect(src).toContain('flow.show(')
})

test('a rejected commit stops at deliver, and the executor still reports the wear', () => {
  // *Rewritten 2026-08-12 by tracks 32 and 34.* This used to assert that one-tap
  // re-checked the reply itself, because `deliver()` sent `MODE` after an `ERROR`
  // commit and `showing` came back true for a save the device had rejected. Track 32
  // fixed that at the source: `SaveResult.committed` is the device's own yes, and
  // `deliver()` withholds SPEED and MODE without it.
  //
  // Two properties survive the move and both matter, so both are asserted where they
  // now live rather than deleted with the old line.
  expect(code('../deliver.ts')).toContain('committed')
  // `status: 'saved'` means the pages were written whatever the device thought of the
  // result, so a rejected commit must still be reported as wear or the count on the
  // Glasses tab drifts below the truth in exactly the case someone would query.
  expect(code('../one-tap.ts')).toContain("out.status === 'saved' && out.cost.erases > 0")
})

test('the erase count keeps exactly one home, and it is not a screen', () => {
  // The UI no longer prices taps (the 2026-08-12 ruling), so the only place the
  // *derived* five-erase figure may live is deliver.ts, where the wear numbers on
  // the Glasses tab and the ledger arithmetic read it. A literal in a screen would
  // be a second copy of a hand-decode at `abs 0x218cc` with no counter to check.
  expect(code('../deliver.ts')).toContain('ERASES_PER_SAVE = 5')
  for (const screen of [SCREEN, '../screens/Library.tsx', '../screens/create/Message.tsx']) {
    const src = code(screen)
    expect(src, screen).not.toMatch(/\d+\s*page erase/)
    expect(src, screen).not.toMatch(/\*\s*5\b/)
  }
})

test('the screen prints the panel-gap sentence rather than promising a seamless loop', () => {
  expect(code(SCREEN)).toContain('PANEL_GAP_NOTE')
})

test('and says why there is nothing to set about brightness, in plan.ts words', () => {
  expect(code(SCREEN)).toContain('MONO_NOTE')
})

test('the screen offers no levels control, so a wide loop cannot arrive as a block', () => {
  // Every `levels:` in the file must be the plan's own constant: a literal would be a
  // way to override the two-levels rule, which is how a four-level loop gets
  // flattened to a near-solid block with nothing reporting it.
  const src = code(SCREEN)
  const all = src.match(/levels\s*:/g) ?? []
  const pinned = src.match(/levels\s*:\s*LEVELS\b/g) ?? []
  expect(all.length).toBe(pinned.length)
})

test('there is no width control: loops render at the ceiling', () => {
  // `notes/library.md`, "Width is not a question worth asking": every DATCP erases
  // the same five pages whatever the payload, so width only buys upload seconds and
  // the control was deleted. A `WIDTHS` import reappearing is it growing back.
  const src = code(SCREEN)
  expect(src).not.toContain('WIDTHS')
  expect(src).toContain('fx.MAX_COLUMNS')
})

test('App.tsx mounts the creators with no session required', () => {
  const app = code('../../App.tsx')
  // Rendered from the tab switch with no `glasses &&` guard: composing, drawing and
  // previewing need no device (review 17's finding, promoted to the whole app), and
  // only the tap runner asks for the connection.
  expect(app).toMatch(/case 'create':/)
  expect(app).toContain('<Create')
  expect(app).not.toMatch(/glasses\s*&&\s*<Create/)
  expect(app).toContain('<Library')
})
