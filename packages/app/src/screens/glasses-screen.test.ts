/**
 * The wire facts the Glasses screen leans on, asserted against the mock device.
 *
 * Successor to `connected.test.ts` after the track 26 rewrite replaced Connected.tsx
 * with GlassesScreen.tsx. The React half is deliberately absent, as in
 * `draw.test.ts`: react-native does not import under bun, so what a screen renders
 * is checked on the handset and what it must never put on the wire is checked here.
 */
import { Glasses, content, protocol as p } from '@joggles/core'
import { MockTransport, datsDevice, opcodeOf } from '@joggles/core/src/mock-transport.js'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const attach = (t: MockTransport) =>
  Glasses.attach(t, 'GLASSES-TEST', { pacing: 0, budget: undefined })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('a command mid-save lands inside the DATS handshake, which is why busy gates it', async () => {
  const t = datsDevice()
  const g = await attach(t)
  // Long enough that the block stream is still going when the command fires.
  const piece = content.text('HELLO WORLD HELLO WORLD')

  const saving = g.save(piece.bitmap, { blockSleep: 10 })
  await sleep(30)
  await g.command(p.brightness(3))
  await saving

  // `Glasses` has no mutex between command() and save(): the LIGHT frame goes out
  // between the bulk blocks, before DATCP closes the handshake. Nobody has sent
  // that interleaving to hardware, so the screens must not be able to produce it -
  // which is why every wire-touching control gates on `busy`/`wire`.
  expect(t.to(p.CHAR_COMMAND).map(opcodeOf)).toEqual(['DATS', 'LIGHT', 'DATCP'])
})

test('probe() on a dead link rejects rather than answering, so the shell must catch', async () => {
  const t = new MockTransport()
  const g = await attach(t)
  t.write = () => Promise.reject(new Error('device disconnected'))

  // Silence is probe()'s answer for a stock unit, but a failed WRITE is a
  // rejection: with a bare .then() in the mount effect that is an unhandled
  // rejection every time a link drops before the answer lands.
  //
  // *The catch moved 2026-08-20 (track 63): the probe is the shell's now, not this
  // screen's, and `carried.test.ts` asserts both that App.tsx is the only prober and
  // that its probe is caught.*
  await expect(g.probe()).rejects.toThrow('device disconnected')
})

/**
 * Which helpers `protocol.ts` groups as reaching no handler on this firmware.
 *
 * Read out of the file rather than listed here, so a helper added to that group is
 * covered the day it appears. `protocol.ts` keeps them for decoding vendor traffic and
 * says so: sending one is a no-op, not an error, which is exactly what makes a control
 * built on one impossible to tell from a dead link.
 */
const ignoredHelpers = (): string[] => {
  const src = readFileSync(
    resolve(dirname(new URL(import.meta.url).pathname), '../../../core/src/protocol.ts'),
    'utf8',
  )
  const tail = src.split('--- Absent from the firmware')[1] ?? ''
  // That group runs to the end of the file, and `column` and `parseType` sit inside it
  // without belonging to it: one is the live pixel write every drawing depends on and
  // the other is a decoder. So keep only declarations that build a **named** opcode -
  // `column` builds `frame('', ...)`, with no opcode at all.
  return tail
    .split(/^export /m)
    .map((chunk) => [/^(?:const|function) (\w+)/.exec(chunk)?.[1], chunk] as const)
    .filter(([name, chunk]) => name !== undefined && /frame\('[A-Z]/.test(chunk))
    .map(([name]) => name as string)
}

test('no control on the wire-facing screens builds a frame the firmware ignores', () => {
  const here = dirname(new URL(import.meta.url).pathname)
  const ignored = ignoredHelpers()
  // Guards the extraction, because an assertion over an empty or wrong list proves
  // nothing. `leds` is the one already mistaken for a working panel switch (`LEDOFF`
  // is tabled as "panel off" in notes/protocol.md and reaches nothing), and `column`
  // is the one that must NOT be caught: banning it would ban the free path.
  expect(ignored).toEqual(
    expect.arrayContaining(['queryType', 'invert', 'stopRhythm', 'leds', 'flashlight', 'lens']),
  )
  expect(ignored).not.toContain('column')
  expect(ignored).not.toContain('parseType')

  // The three files that build or route frames after the rewrite: the device screen,
  // the delivery module, and the tap executor.
  for (const file of ['GlassesScreen.tsx', '../deliver.ts', '../one-tap.ts']) {
    const src = readFileSync(resolve(here, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const helper of ignored) {
      expect(src, `${file} calls p.${helper}, which reaches no handler`).not.toContain(
        `p.${helper}(`,
      )
    }
  }
})

test('the screens still reach the firmware helpers they are supposed to', () => {
  // The other half of the guard above: a file that called nothing at all would pass it.
  const here = dirname(new URL(import.meta.url).pathname)
  const screen = readFileSync(resolve(here, 'GlassesScreen.tsx'), 'utf8')
  const send = readFileSync(resolve(here, '../deliver.ts'), 'utf8')

  expect(screen).toContain('p.brightness(')
  expect(send).toContain('p.mode(')
  expect(send).toContain('p.speed(')
})

test('the brightness default is applied on connect, not merely stored', () => {
  // "Why do i have to select panel setting each time? Should be a default." The
  // setting would be theatre if nothing sent it: the connect path must put the
  // persisted level on the wire before handing the session up.
  const src = readFileSync(
    resolve(dirname(new URL(import.meta.url).pathname), 'GlassesScreen.tsx'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '')
  expect(src).toMatch(/brightness\(settings\.defaults\(\)\.brightness\)/)
})

/**
 * The Scan half may not keep a second model of the rows.
 *
 * Track 66's rule-enforcing half, and it is a crawl for the same reason the rest of this
 * file is: react-native does not import under bun, so what the screen renders is checked
 * on the handset and what it must never be built out of is checked here.
 *
 * The defect it prevents: this screen appended every sighting to a `Discovered[]` that
 * nothing emptied, so the header counted the pairs the active source was advertising while
 * the list held every pair any source ever had. Switching to the simulated pairs left the
 * real unit on screen at a frozen -57 dBm under a caption reading "simulated pairs only" -
 * the same wrong-provenance claim `notes/hardware-state.md` exists to stop, in a nicer
 * font. One array is the fix; this is what keeps it one.
 */
const scanHalf = (): string => {
  const src = readFileSync(
    resolve(dirname(new URL(import.meta.url).pathname), 'GlassesScreen.tsx'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '')
  // Only the scan half: the connected half legitimately holds plenty of its own state.
  const from = src.indexOf('function Scan(')
  const to = src.indexOf('function Connected(')
  expect(from).toBeGreaterThan(0)
  expect(to).toBeGreaterThan(from)
  return src.slice(from, to)
}

test('the scan rows come off the presence, not a list the screen keeps beside it', () => {
  const scan = scanHalf()
  // No second model of the field. `Discovered[]` was the shape of the one that bled.
  expect(scan).not.toMatch(/useState<Discovered\[\]>/)
  expect(scan).not.toMatch(/setUnits/)
  // And the rows are the counted pairs, re-ordered: same array, so they cannot disagree.
  // Aliased at the import, because `Connected` declares its own `rows` for the save log
  // and an unaliased import of the same name would resolve there if that local ever went.
  expect(scan).toContain('nearbyRows(near)')
  expect(scan).toMatch(/listed\.map\(/)
  expect(scan).toMatch(/headline\(near, scanning\)/)
  // The empty state and the button label have to read off the same list too, or the
  // screen can say "Nothing found" above a row.
  expect(scan).not.toMatch(/units\.length/)
  expect(scan).toMatch(/listed\.length === 0/)
})

test('a row is keyed on the advert name, which is the identity everywhere else', () => {
  // Keyed on the platform handle, one pair reissued a handle between rounds was two
  // rows; and the handle is a MAC on Android, so it must not be a React key either.
  const scan = scanHalf()
  expect(scan).toContain('key={unit.name}')
  expect(scan).not.toContain('key={unit.id}')
  expect(scan).toMatch(/editing === unit\.name/)
  expect(scan).toMatch(/busy === unit\.name/)
})

test('the simulated caption is told which source the rows came from, never its own guess', () => {
  // `SimulatedPair` remounts on every disconnect and every visit to this tab, while the
  // switch it drives is module state that outlives it. Holding `on` itself meant that one
  // switch plus one disconnect showed two simulated pairs under "Dev build: drive the app
  // with no hardware attached", offering to turn on what was already on.
  const src = readFileSync(
    resolve(dirname(new URL(import.meta.url).pathname), 'GlassesScreen.tsx'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '')
  const from = src.indexOf('function SimulatedPair(')
  const to = src.indexOf('function Connected(')
  expect(from).toBeGreaterThan(0)
  expect(to).toBeGreaterThan(from)
  expect(src.slice(from, to)).not.toMatch(/useState/)
  // The owner asks the scanner rather than assuming, and asks at mount.
  expect(scanHalf()).toContain('useState(usingFakeGlasses)')
  // The sentence that stops a simulated render being quoted as evidence sits with the
  // rows it describes, and is shown only when the rows really are simulated.
  expect(scanHalf()).toMatch(/simulated \?[\s\S]{0,200}Nothing here is evidence about the real panel/)
})
