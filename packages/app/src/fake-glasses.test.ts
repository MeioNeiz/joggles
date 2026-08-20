/**
 * What the simulated pair has to get right to be worth having.
 *
 * Two kinds of test, and the split matters. The behavioural ones drive a real
 * `Glasses` over the fake transport, so they check that the device model answers the
 * handshake the session actually performs rather than one written to match it. The
 * source-level crawl checks the release guard, which is the one property here that
 * no behavioural test can reach: `__DEV__` is a constant at module load, so the
 * release build's behaviour cannot be observed from inside the dev build.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Glasses, content, dats, display, protocol as p } from '@joggles/core'
import { fromIdentity } from './carried.js'
import {
  FAKE_ID_PREFIX,
  FAKE_NAMES,
  FakeScanner,
  fakeDevice,
  isFakeHandle,
  isFakeName,
  onlyFrom,
  wrongSourceWords,
} from './fake-glasses.js'
import { type Sighting, createPresence, headline, rows } from './proximity.js'

const HERE = new URL('.', import.meta.url).pathname

/**
 * A clean pair.
 *
 * The devices are module-scoped and survive a disconnect on purpose, which is the
 * behaviour residency rests on and exactly what makes tests bleed into each other.
 * Resetting here rather than dropping the persistence keeps both.
 */
const open = async (name: string = FAKE_NAMES[0]) => {
  fakeDevice(name).reset()
  const scanner = new FakeScanner(0)
  const transport = await scanner.connect(`fake:${name}`)
  return Glasses.attach(transport, name)
}

test('the fake pairs answer the scan filter the real adapter applies', async () => {
  // ble.ts admits an advert only if it starts with one of the two prefixes, so a
  // fake that failed this would simply never appear and look like a broken scan.
  for (const name of FAKE_NAMES) {
    expect(
      name.startsWith(p.NAME_PREFIX) || name.startsWith(p.CREW_NAME_PREFIX),
    ).toBe(true)
  }
})

test('fake names cannot collide with a real unit, so ledgers stay apart', () => {
  // Every store in the app is keyed on the advert name. If a fake could take a real
  // one, a simulated save would land in the real pair's wear count, which is the one
  // number in this repo that cannot be recovered once wrong.
  for (const name of FAKE_NAMES) {
    expect(name).toMatch(/^GLASSES-FA4E\d\d$/)
  }
  expect(new Set(FAKE_NAMES).size).toBe(FAKE_NAMES.length)
})

test('a scan reports both pairs with readings that move', async () => {
  const scanner = new FakeScanner(0)
  const seen: Array<{ name: string; rssi: number }> = []
  await scanner.scan((u) => seen.push({ name: u.name, rssi: u.rssi }))
  await scanner.stop()
  expect(seen.map((s) => s.name).sort()).toEqual([...FAKE_NAMES].sort())
  // Never a no-reading sentinel: proximity.usable() would drop these.
  for (const s of seen) expect(s.rssi).toBeLessThan(0)
})

test('a save runs the whole DATS handshake and the device then holds it', async () => {
  const g = await open()
  const bitmap = content.text('HI').bitmap
  const out = await g.save(bitmap)
  expect(out.status).toBe('saved')
  expect(out.committed).toBe(true)
  expect(out.reply).toBe('DATCPOK')

  // MODE 02 is what puts the saved store on the panel, and until it is sent the
  // panel is not showing the save. That ordering is the app's whole free-return path.
  await g.command(p.mode(2, 0))
  const panel = fakeDevice(FAKE_NAMES[0]).panel(0)
  expect(panel.source).toContain('saved scroll')
  expect(panel.grid.some((row) => row.some((v) => v > 0))).toBe(true)
})

test('an over-long save is refused at the announcement, before any block', async () => {
  // The ceiling is 740 columns and the device rejects the DATS, not the DATCP:
  // ERROR is verified on hardware at 1490 bytes. Asserting *where* it fails is the
  // point - a model that took 700 blocks and then said ERROR would let a UI claim
  // an upload was progressing when the device had already declined it.
  const g = await open(FAKE_NAMES[1])
  const over = content.MAX_SAVED_COLUMNS + 5
  const wide = Array.from({ length: dats.DATS_ROWS }, () => new Array(over).fill(1))
  const out = await g.save(wide)
  expect(out.committed).toBe(false)
  // The session's own wording names the stage, so this pins the failure point
  // rather than merely the failure: a refusal at DATCP would read just "ERROR".
  expect(out.reply).toBe('DATS not acknowledged: ERROR')
  // Nothing was stored, so a MODE would show whatever was there before. That is
  // exactly track 32's open defect and this is the pair a test for it can use.
  expect(fakeDevice(FAKE_NAMES[1]).panel(0).source).toBe('nothing showing')
})

test('a save at the ceiling is still accepted', async () => {
  // The other side of the wall, because a fake that refused everything wide would
  // look correct in the test above and quietly make wide loops untestable.
  const g = await open(FAKE_NAMES[1])
  const at = Array.from({ length: dats.DATS_ROWS }, () =>
    new Array(content.MAX_SAVED_COLUMNS).fill(1),
  )
  expect((await g.save(at)).committed).toBe(true)
})

test('a live column lands on the rows the encoder put it on', async () => {
  // A round trip through the real encoder: display.Grid builds the 24-bit word and
  // the device model takes it apart. Getting this backwards would draw every live
  // rendering upside down and nothing else in the app would notice.
  const g = await open()
  const grid = new display.Grid()
  grid.set(0, 3, display.PIXEL_ON)
  grid.set(8, 3, display.PIXEL_DIM)
  await g.show(grid, true)

  const panel = fakeDevice(FAKE_NAMES[0]).panel(0)
  expect(panel.source).toBe('live columns')
  expect(panel.grid[0][3]).toBe(display.PIXEL_ON)
  expect(panel.grid[8][3]).toBe(display.PIXEL_DIM)
})

test('MODE discards the live buffer, as the firmware does', async () => {
  const g = await open()
  const grid = new display.Grid()
  grid.set(2, 5, display.PIXEL_ON)
  await g.show(grid, true)
  expect(fakeDevice(FAKE_NAMES[0]).panel(0).source).toBe('live columns')

  await g.command(p.mode(1, 0))
  // The one-way door: the live work is gone, and it does not come back.
  expect(fakeDevice(FAKE_NAMES[0]).panel(0).source).not.toBe('live columns')
})

test('LIGHT is clamped to 1-5 and floors at 1, as the dispatcher does', async () => {
  const g = await open()
  await g.command(p.brightness(9))
  expect(fakeDevice(FAKE_NAMES[0]).brightness).toBe(5)
  await g.command(p.brightness(0))
  expect(fakeDevice(FAKE_NAMES[0]).brightness).toBe(1)
})

test('the fake cannot be switched on outside a dev build', () => {
  // The crawl, not a behavioural test: __DEV__ is fixed at module load, so the
  // release build's refusal is unobservable from in here. What is checkable is that
  // the guard is present and reads from __DEV__ rather than from a stored setting,
  // which is the failure worth preventing - an app in a field talking to nothing.
  const fake = readFileSync(`${HERE}fake-glasses.ts`, 'utf8')
  expect(fake).toMatch(/export const FAKE_AVAILABLE[^\n]*__DEV__/)

  const ble = readFileSync(`${HERE}ble.ts`, 'utf8')
  expect(ble).toContain('FAKE_AVAILABLE')
  // The refusal has to be in the setter, so no caller can route around it.
  expect(ble).toMatch(/if \(on && !FAKE_AVAILABLE\) return false/)
})

test('nothing in the app imports the fake outside ble.ts and a dev view', () => {
  // One door in. If a screen reached for the fake device directly it could show
  // simulated state next to real state with nothing saying which was which.
  const files = new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: HERE })
  const offenders: string[] = []
  for (const file of files) {
    if (file.startsWith('fake-glasses')) continue
    const src = readFileSync(`${HERE}${file}`, 'utf8')
    if (src.includes('fake-glasses.js')) offenders.push(file)
  }
  expect(offenders.sort()).toEqual(['ble.ts'])
})

test('a simulated pair reads as stock, because it carries no extension either', async () => {
  // The honest answer, and it matters that it is structural: the dispatch's default arm
  // discards an unmatched opcode exactly as the real firmware does, so `J` gets silence
  // and `probe()` reports stock. Nothing in the app can therefore be demonstrated
  // against a pretend crew unit, which would be a screenshot of a state no hardware has
  // ever been in. A short timeout because silence is the answer and there is nothing to
  // wait for.
  const g = await open()
  const id = await g.probe(10)
  expect(id).toEqual({ kind: 'stock', name: FAKE_NAMES[0] })
  expect(fromIdentity(id, 0).capabilities).toBe(0)
})

/**
 * The boundary between the two sources, which track 66 found leaking.
 *
 * The defect: the Glasses screen listed a real pair among the simulated ones with its
 * last reading frozen, under a caption reading "simulated pairs only". The row half of
 * that is `proximity.ts`'s to fix. What is fixed here is the half that no list can fix,
 * because it is about which adverts arrive at all: the switch is not instant, and a scan
 * callback the platform had already queued lands after it.
 */
test('a simulated feed takes only simulated adverts, whatever arrives', () => {
  const got: string[] = []
  const keep = onlyFrom(true, (u: { name: string }) => got.push(u.name))
  for (const name of [FAKE_NAMES[0], 'GLASSES-12C3EF', FAKE_NAMES[1], 'JOGGLES-1A2B3C']) {
    keep({ name })
  }
  expect(got).toEqual([FAKE_NAMES[0], FAKE_NAMES[1]])
})

test('a real feed drops the simulated pairs, which is the other direction of the same bug', () => {
  const got: string[] = []
  const keep = onlyFrom(false, (u: { name: string }) => got.push(u.name))
  for (const name of [FAKE_NAMES[0], 'GLASSES-12C3EF', FAKE_NAMES[1], 'JOGGLES-1A2B3C']) {
    keep({ name })
  }
  expect(got).toEqual(['GLASSES-12C3EF', 'JOGGLES-1A2B3C'])
})

/**
 * The one the brief asked for: a simulated listing cannot contain a pair from a real scan.
 *
 * Asserted end to end over the two pieces that produce a listing - the source filter and
 * the presence map the rows come off - rather than on either alone, because the defect
 * lived in neither: each was right and the screen put them together wrongly.
 */
test('a simulated listing can never contain a pair from a real scan', () => {
  const presence = createPresence()
  const keep = onlyFrom(true, (u: Sighting) => presence.saw(u, 0))
  keep({ name: 'GLASSES-12C3EF', rssi: -57, id: '3C:A3:08:12:C3:EF' })
  keep({ name: FAKE_NAMES[0], rssi: -55, id: `${FAKE_ID_PREFIX}${FAKE_NAMES[0]}` })
  keep({ name: FAKE_NAMES[1], rssi: -46, id: `${FAKE_ID_PREFIX}${FAKE_NAMES[1]}` })

  const near = presence.nearby(0)
  const listed = rows(near)
  expect(listed.map((u) => u.name)).toEqual([FAKE_NAMES[0], FAKE_NAMES[1]])
  // Both halves of the screen, so neither can be right while the other is wrong.
  expect(listed).toHaveLength(near.count)
  expect(headline(near, false)).toBe('2 pairs when the scan ended')
  for (const unit of listed) {
    expect(isFakeName(unit.name)).toBe(true)
    expect(isFakeHandle(unit.id ?? '')).toBe(true)
  }
})

test('a real listing can never contain a simulated pair either', () => {
  const presence = createPresence()
  const keep = onlyFrom(false, (u: Sighting) => presence.saw(u, 0))
  keep({ name: FAKE_NAMES[0], rssi: -55, id: `${FAKE_ID_PREFIX}${FAKE_NAMES[0]}` })
  keep({ name: 'GLASSES-12C3EF', rssi: -57, id: '3C:A3:08:12:C3:EF' })

  const near = presence.nearby(0)
  expect(rows(near).map((u) => u.name)).toEqual(['GLASSES-12C3EF'])
  expect(headline(near, false)).toBe('1 pair when the scan ended')
})

test('a real handle handed to the simulated scanner is refused, and never echoed', async () => {
  // The tap nobody dared try: a leftover real row, tapped while the app is on the
  // simulated pairs. It cannot reach the radio, because `ActiveScanner` routes by which
  // scanner is active and that is this one. What it *could* do was print the handle: the
  // refusal used to interpolate the id it was handed, and on Android that id is the real
  // pair's MAC. `ble-words.ts`: a platform handle must never reach a person.
  const MAC = '3C:A3:08:12:C3:EF'
  const scanner = new FakeScanner(0)
  const failed = await scanner.connect(MAC).then(
    () => null,
    (e: unknown) => (e as Error).message,
  )
  expect(failed).not.toBeNull()
  const said = failed as string
  expect(said).not.toContain(MAC)
  // Not merely the whole string: no run of it either, and no colon-separated hex at all.
  expect(said).not.toContain('3C:A3')
  expect(said).not.toMatch(/[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){2}/)
  expect(said).toBe(wrongSourceWords(true))
  // And the wording is what a person can act on, not a diagnostic.
  expect(said).toContain('Scan again')
})

test('an iOS-shaped handle is refused the same way, since neither is a simulated one', async () => {
  const UUID = '4B7E1C2A-9D3F-4A11-8C64-0F2E6A5B7D19'
  const scanner = new FakeScanner(0)
  const said = await scanner.connect(UUID).then(
    () => '',
    (e: unknown) => (e as Error).message,
  )
  expect(said).toBe(wrongSourceWords(true))
  expect(said).not.toContain(UUID)
  expect(said).not.toContain('4B7E')
})

test('the refusal wording takes no handle at all, which is why it cannot regress', () => {
  // A type-level guarantee rather than a scrub: there is nothing to interpolate. Both
  // arms name the source and neither takes an id.
  expect(wrongSourceWords(true)).toContain('simulated glasses')
  expect(wrongSourceWords(false)).toContain('real glasses')
  expect(wrongSourceWords(true)).not.toBe(wrongSourceWords(false))
})

test('a simulated handle still opens, so the guard has not closed the door', async () => {
  // The other side of the wall. A guard that refused everything would pass every test
  // above and make the simulated pair useless.
  const scanner = new FakeScanner(0)
  const transport = await scanner.connect(`${FAKE_ID_PREFIX}${FAKE_NAMES[0]}`)
  expect(transport).not.toBeNull()
  await transport.disconnect()
})

/**
 * No thrown message in this app may carry a scanner handle.
 *
 * The general form of the leak above, and the reason it is a crawl rather than a scrub in
 * `pairWords`: an Android handle is separable by shape and an iOS one is not, since it is
 * a UUID and so is the service UUID that `ble-words.test.ts` deliberately keeps in its
 * sentence. So the enforceable rule is upstream - a message never gets an id in the first
 * place - and there are no exceptions to it today.
 */
const errorArguments = (src: string): string[] => {
  const out: string[] = []
  const opens = /(?:new\s+)?Error\(/g
  for (let m = opens.exec(src); m !== null; m = opens.exec(src)) {
    let depth = 1
    let i = m.index + m[0].length
    const from = i
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth += 1
      else if (src[i] === ')') depth -= 1
      i += 1
    }
    out.push(src.slice(from, i - 1))
  }
  return out
}

test('nothing in the app puts a scanner handle into a thrown message', () => {
  const files = [
    ...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: HERE }),
    '../App.tsx',
  ].filter((f) => !f.includes('.test.'))
  const offenders: string[] = []
  for (const file of files) {
    const src = readFileSync(`${HERE}${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const arg of errorArguments(src)) {
      // An id interpolated into a template, or concatenated onto a string. A library
      // item's own `id` is not a handle, but no thrown message carries one of those
      // either, so the rule needs no exception list and gains no hole from being blunt.
      if (/\$\{[^}]*\bid\b[^}]*\}/.test(arg) || /\+\s*\w*\bid\b/.test(arg)) {
        offenders.push(`${file}: Error(${arg.slice(0, 60)})`)
      }
    }
  }
  expect(offenders).toEqual([])
  // Guards the crawl: the extraction has to be finding something.
  const found = errorArguments(readFileSync(`${HERE}ble.ts`, 'utf8'))
  expect(found.length).toBeGreaterThan(1)
})

test('the source filter and the handle guard are both wired into the one door', () => {
  // `ble.ts` imports react-native and cannot run under bun, so the wiring is read rather
  // than driven. Both halves matter: without the filter a queued advert from the source
  // just left joins this one's list, and without the guard a handle from that source is
  // handed to whichever scanner is now active.
  const ble = readFileSync(`${HERE}ble.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  expect(ble).toContain('onlyFrom(this.simulated, onFound)')
  expect(ble).toMatch(/isFakeHandle\(id\) !== this\.simulated/)
  expect(ble).toContain('wrongSourceWords(this.simulated)')
  // The scan must hand the *filtered* callback to both scanners, not just to one.
  expect(ble).not.toMatch(/at\.scan\(onFound/)
})
