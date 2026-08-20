/**
 * The wording, and the one property that matters: no platform handle reaches a screen.
 *
 * The strings below are ble-plx's own, copied from its error table, because the whole
 * module is a translation of that table and a paraphrase would test nothing.
 */
import { expect, test } from 'bun:test'
import { faultOf, messageOf, pairWords } from './ble-words.js'

const MAC = '3C:A3:08:12:C3:EF'
const UUID = '4B7E1C2A-9D3F-4A11-8C64-0F2E6A5B7D19'

test('a dropped link is said in the name the person is looking at', () => {
  expect(pairWords(new Error(`Device ${MAC} was disconnected`), 'Rufus')).toBe(
    'Rufus disconnected.',
  )
  // iOS hands out a per-install UUID rather than a MAC, and it is no more readable.
  expect(pairWords(new Error(`Device ${UUID} was disconnected`), 'GLASSES-12C3EF')).toBe(
    'GLASSES-12C3EF disconnected.',
  )
  expect(faultOf(new Error(`Device ${MAC} is not connected`))).toBe('dropped')
})

test('a pair that was never there says why, which is not the same fault', () => {
  expect(pairWords(new Error(`Device ${MAC} not found`), 'Rufus')).toBe(
    'Rufus did not answer. It may be off, or out of range.',
  )
})

test('one connection per device is said as such', () => {
  expect(pairWords(new Error(`Device ${MAC} is already connected`), 'Rufus')).toBe(
    'Rufus is already connected. Another app on this phone may be holding it.',
  )
})

test('no name to hand still beats a handle', () => {
  expect(pairWords(new Error(`Device ${MAC} was disconnected`), null)).toBe(
    'The glasses disconnected.',
  )
  expect(pairWords(new Error(`Device ${MAC} was disconnected`), '   ')).toBe(
    'The glasses disconnected.',
  )
})

test('a fault about something other than the pair keeps its own subject', () => {
  // "not found" here is the service, on a pair that answered: calling that out of
  // range would send someone walking towards glasses that are already in their hand.
  const raw = new Error(`Service 0000fff0-0000-1000-8000-00805f9b34fb for device ${MAC} not found`)
  expect(faultOf(raw)).toBe('other')
  const said = pairWords(raw, 'Rufus')
  expect(said).toBe('Service 0000fff0-0000-1000-8000-00805f9b34fb for Rufus not found')
  expect(said).not.toContain(MAC)
})

test('text that is not about a device at all is left exactly as it is', () => {
  // This app throws its own sentences too, and they are already in the right words.
  for (const text of ['bluetooth permission refused', 'bluetooth is Unauthorized']) {
    expect(pairWords(new Error(text), 'Rufus')).toBe(text)
  }
  // ble-plx names no device in these two, so there is nothing to rename and no honest
  // sentence about the pair to invent.
  expect(pairWords(new Error('Operation timed out'), 'Rufus')).toBe('Operation timed out')
  expect(pairWords(new Error('Operation was cancelled'), 'Rufus')).toBe('Operation was cancelled')
})

test('the handle never survives any of ble-plx that carries one', () => {
  const table = [
    `Device ${MAC} was disconnected`,
    `Device ${MAC} is not connected`,
    `Device ${MAC} not found`,
    `Device ${MAC} is already connected`,
    `Device ${MAC} connection failed`,
    `Characteristic 0000fff2-0000-1000-8000-00805f9b34fb write failed for device ${MAC}`,
    `Device ${MAC} MTU change failed`,
  ]
  for (const text of table) {
    const said = pairWords(new Error(text), 'Rufus')
    expect(said, text).not.toContain(MAC)
    expect(said, text).toContain('Rufus')
  }
})

test('a thrown non-error still says something, because catch blocks get anything', () => {
  expect(messageOf('plain string')).toBe('plain string')
  expect(messageOf(new Error('Error: doubled up'))).toBe('doubled up')
  // A BleError arrives as an object with a message; anything without one stringifies.
  expect(pairWords({ message: `Device ${MAC} was disconnected` }, 'Rufus')).toBe(
    'Rufus disconnected.',
  )
})

test('faultOf is not fooled by a second call, which a stateful regex would be', () => {
  const raw = new Error(`Device ${MAC} was disconnected`)
  expect(faultOf(raw)).toBe('dropped')
  expect(faultOf(raw)).toBe('dropped')
})

test('a bare handle is scrubbed even in a sentence that never says "device"', () => {
  // Track 66. `FakeScanner.connect` threw "no such simulated pair: <id>", and for a scan
  // row left over from the real source that id was the real pair's MAC. Nothing in it
  // matches ble-plx's "Device <handle>" phrasing, so the rename had nothing to catch and
  // printed the handle - the one thing this file exists to prevent. The app's own thrown
  // sentences are exactly the ones ble-plx's wording does not describe.
  const said = pairWords(new Error(`no such simulated pair: ${MAC}`), 'Rufus')
  expect(said).not.toContain(MAC)
  expect(said).not.toContain('3C:A3')
  expect(said).toBe('no such simulated pair: Rufus')
})

test('scrubbing a bare handle is by MAC shape only, and leaves a service UUID alone', () => {
  // Shape separates an Android handle from everything else this app handles, because
  // every UUID here is dash-separated in 8-4-4-4-12 groups and a colon-MAC cannot be
  // anything but a device. **An iOS handle is not separable that way**: it is a UUID, and
  // so is the service UUID the test above deliberately keeps in its sentence. So position
  // is all that covers iOS, and the belt for the rest is upstream - no thrown message in
  // the app carries an id, which `fake-glasses.test.ts` crawls for.
  const service = '0000fff0-0000-1000-8000-00805f9b34fb'
  expect(pairWords(new Error(`Service ${service} unavailable`), 'Rufus')).toBe(
    `Service ${service} unavailable`,
  )
  // A clock time is not a handle either: three groups, not six.
  expect(pairWords(new Error('gave up at 12:34:56'), 'Rufus')).toBe('gave up at 12:34:56')
})
