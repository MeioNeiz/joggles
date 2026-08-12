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
import { FAKE_NAMES, FakeScanner, fakeDevice } from './fake-glasses.js'

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
