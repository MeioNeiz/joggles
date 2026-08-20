/**
 * ble-plx behind the core `Transport` and `Scanner` interfaces.
 *
 * This file is the whole of the phone's platform code. Everything above it, the DATS
 * handshake, the budget guard, the ciphers, is shared with the laptop and tested against
 * a mock, so the phone cannot grow a second implementation that drifts.
 *
 * Three things differ from noble, and all three have already cost time somewhere:
 *
 *  1. **base64, not bytes.** ble-plx takes and returns base64 strings. React Native has
 *     no `Buffer` and no reliable `btoa`, so both directions are hand-rolled below.
 *  2. **MTU is irrelevant.** Raise it if you like; still exactly one 16-byte block per
 *     write. The panel decodes the first block of a write and silently drops the rest,
 *     which looks like corruption rather than an error.
 *  3. **Permissions are this layer's problem**, asked for before the first scan rather
 *     than by the UI.
 *
 * Every write and every subscribe goes through `assertChannel`, which is the second of
 * the three layers keeping this app away from the flash-writing service. See safety
 * item 1 in `notes/app-plan.md`.
 */
import { assertChannel, protocol as p } from '@joggles/core'
import type { Discovered, Scanner, Transport } from '@joggles/core'
import { PermissionsAndroid, Platform } from 'react-native'
import { BleManager, type Device, type Subscription } from 'react-native-ble-plx'
import { fromBase64, toBase64 } from './base64.js'
import {
  FAKE_AVAILABLE,
  FakeScanner,
  isFakeHandle,
  onlyFrom,
  wrongSourceWords,
} from './fake-glasses.js'

/**
 * Ask for what Android 12+ actually needs.
 *
 * The manifest declares `BLUETOOTH_SCAN` with `neverForLocation`, so this never asks
 * for location on a modern handset. iOS grants Bluetooth through the Info.plist string
 * and the system prompt, with nothing to request here.
 */
async function requestPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true
  const wanted = [
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
  ].filter(Boolean)
  const granted = await PermissionsAndroid.requestMultiple(wanted)
  return Object.values(granted).every((v) => v === PermissionsAndroid.RESULTS.GRANTED)
}

/**
 * Hex transcript of everything on the wire, in dev builds only.
 *
 * The panel is the only real output this system has and no agent can see it, so without
 * this the answer to "did the phone send the right bytes" needs a person squinting at
 * LEDs. With it, the whole protocol up to the glass is checkable from `logs.sh`.
 *
 * Ciphertext is what goes out, so the plaintext frame is not recoverable from this line
 * alone. That is deliberate: this logs the wire, and `session.ts` logs intent.
 */
const hex = (b: Uint8Array) => [...b].map((v) => v.toString(16).padStart(2, '0')).join('')

const wire = (direction: '>' | '<', char: string, block: Uint8Array) => {
  if (!__DEV__) return
  console.log(`ble ${direction} ${char.slice(-4)} ${hex(block)}`)
}

class BleTransport implements Transport {
  private subs: Subscription[] = []

  constructor(private device: Device) {}

  async write(char: string, block: Uint8Array, withResponse: boolean): Promise<void> {
    assertChannel(char)
    const value = toBase64(block)
    wire('>', char, block)
    if (withResponse) {
      await this.device.writeCharacteristicWithResponseForService(p.SERVICE_UUID, char, value)
    } else {
      await this.device.writeCharacteristicWithoutResponseForService(p.SERVICE_UUID, char, value)
    }
  }

  async subscribe(char: string, on: (block: Uint8Array) => void): Promise<void> {
    assertChannel(char)
    const sub = this.device.monitorCharacteristicForService(
      p.SERVICE_UUID,
      char,
      (error, characteristic) => {
        // A disconnect surfaces here as an error rather than a separate event. Dropping
        // it is right: the session's own timeouts decide what a missing reply means.
        if (error || !characteristic?.value) return
        const block = fromBase64(characteristic.value)
        wire('<', char, block)
        on(block)
      },
    )
    this.subs.push(sub)
  }

  async disconnect(): Promise<void> {
    for (const sub of this.subs.splice(0)) sub.remove()
    await this.device.cancelConnection()
  }
}

/**
 * What a caller may ask of one scan.
 *
 * `duplicates` is **iOS only** in ble-plx: CoreBluetooth otherwise reports each
 * peripheral once per scan, where Android reports every advert it hears whatever this
 * says. Off by default because it was off before, and the only caller that needs it is
 * the proximity count, which cannot tell that a pair has left without re-sightings
 * (`proximity.ts`).
 */
export interface ScanTuning {
  duplicates?: boolean
}

/**
 * One value for "no reading", because `Discovered.rssi` is a plain `number`.
 *
 * Two sentinels arrive here and both mean the same nothing: `null`, and Android's `127`
 * for a scan result whose RSSI is unavailable. Either one taken as dBm is a signal
 * **stronger than a pair in your hand**, so a reader that forgets to filter shows the
 * pair it cannot hear at the top of the list. Folding them into a single `0` means one
 * case downstream instead of two. Every reader must still refuse it: `proximity.usable()`
 * is what does that, and `signalText()` is what prints it as "no reading".
 */
const noReading = (rssi: number | null | undefined): number =>
  rssi == null || rssi >= 0 ? 0 : rssi

export class BleScanner implements Scanner {
  private manager = new BleManager()

  private prefixes = [p.NAME_PREFIX, p.CREW_NAME_PREFIX]

  /**
   * Hang up on any pair this app is still holding.
   *
   * **A connected peripheral does not advertise**, so a connection left open is a
   * pair that has vanished from the scan: the symptom is an empty list rather than
   * an error, and it looks exactly like the glasses being switched off. Fast Refresh
   * causes it every time - it replaces the JS without ever running the teardown that
   * would have disconnected - and so does a crash, which at a festival means the
   * pair is unreachable until the link times out.
   *
   * Scoped to our own service UUID, so nothing else the phone is talking to is
   * touched.
   */
  private async release(): Promise<void> {
    try {
      for (const device of await this.manager.connectedDevices([p.SERVICE_UUID])) {
        await device.cancelConnection()
      }
    } catch {
      // Best effort. A failure here means the scan comes up empty, which is the
      // state we were already in.
    }
  }

  /** Resolve once the adapter is actually on, so a scan is never started into a stall. */
  private ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sub = this.manager.onStateChange((state) => {
        if (state === 'PoweredOn') {
          sub.remove()
          resolve()
        } else if (state === 'Unsupported' || state === 'Unauthorized') {
          sub.remove()
          reject(new Error(`bluetooth is ${state}`))
        }
      }, true)
    })
  }

  /**
   * Optional per-scan tuning. Additive: the defaults are what this scanner has always
   * done, so a caller that passes nothing sees no change.
   */
  async scan(onFound: (unit: Discovered) => void, tuning: ScanTuning = {}): Promise<void> {
    if (!(await requestPermissions())) throw new Error('bluetooth permission refused')
    await this.ready()
    await this.release()
    const allowDuplicates = tuning.duplicates ?? false
    await this.manager.startDeviceScan(null, { allowDuplicates }, (error, device) => {
      if (error || !device) return
      // localName is the advert; name can be a cached GAP name, so prefer the advert.
      const name = device.localName ?? device.name ?? ''
      if (!this.prefixes.some((prefix) => name.startsWith(prefix))) return
      onFound({ id: device.id, name, rssi: noReading(device.rssi) })
    })
  }

  async stop(): Promise<void> {
    await this.manager.stopDeviceScan()
  }

  async connect(id: string): Promise<Transport> {
    await this.manager.stopDeviceScan()
    const device = await this.manager.connectToDevice(id)
    await device.discoverAllServicesAndCharacteristics()
    return new BleTransport(device)
  }
}

/**
 * One scanner, and so one `BleManager`, for the whole app.
 *
 * It has to outlive the Scan screen, because the connection it opens is handed to a
 * screen that replaces it: destroying the manager on unmount would kill the
 * connection that unmounting was caused by. Module scope also stops a re-render
 * spawning a second native manager.
 *
 * **It delegates rather than being a `BleScanner` outright**, so that dev builds can
 * point the whole app at a simulated pair (`fake-glasses.ts`, track 40) without any
 * screen knowing. A `let` export would have done it in one line and is what this
 * nearly was: live bindings across Metro's module wrapper are not something to bet a
 * festival on, and every call site reads `scanner.x()`, so a delegate costs nothing
 * and cannot half-work.
 *
 * The real manager is built lazily. Constructing a `BleManager` asks the platform for
 * the adapter, and a dev session driving the fake pair should not have to answer a
 * Bluetooth prompt to do it.
 */
class ActiveScanner implements Scanner {
  private real: BleScanner | null = null

  private fake: Scanner | null = null

  /** Never true in a release build: `useFakeGlasses` refuses to set it. */
  private faking = false

  private active(): Scanner {
    if (this.faking && this.fake !== null) return this.fake
    this.real ??= new BleScanner()
    return this.real
  }

  /** Whether the app is currently talking to a simulated pair. */
  get simulated(): boolean {
    return this.faking && this.fake !== null
  }

  /**
   * Point the app at the fake pairs, or back at the radio.
   *
   * Refused unless `FAKE_AVAILABLE`, which is `__DEV__`. That is deliberately a
   * hard refusal rather than a stored preference the release build ignores: the
   * failure this guards against is someone at a festival whose app is confidently
   * driving a pair that does not exist, which looks exactly like working.
   */
  async useFake(on: boolean, make: () => Scanner): Promise<boolean> {
    if (on && !FAKE_AVAILABLE) return false
    await this.active().stop().catch(() => {})
    this.faking = on
    if (on) this.fake ??= make()
    return this.simulated
  }

  /**
   * One source's adverts and only one source's.
   *
   * `onlyFrom` is what makes "simulated pairs only" a fact rather than a caption. A
   * scan callback queued by the platform before `useFake` stopped it arrives after the
   * flip, and without this it joins the new source's list: track 66 found a real pair
   * sitting in the simulated list with its last reading frozen, counted by neither the
   * header nor the footer. Applied here because this is the only place that knows which
   * source is active, and so the three consumers cannot each get it half right.
   */
  scan(onFound: (unit: Discovered) => void, tuning: ScanTuning = {}): Promise<void> {
    const at = this.active()
    const mine = onlyFrom(this.simulated, onFound)
    return at instanceof BleScanner ? at.scan(mine, tuning) : at.scan(mine)
  }

  stop(): Promise<void> {
    return this.active().stop()
  }

  /**
   * Refuse a handle from the source the app is not on.
   *
   * The row list cannot hold one any more, so this is the second layer rather than the
   * fix. It is worth having because of what the tap would otherwise be: in simulated
   * mode a real handle reaches the radio if this class ever routes by anything other
   * than `faking`, and "the app opened the real pair while every word on the screen said
   * simulated" is the one outcome here that is worse than a wrong list.
   */
  connect(id: string): Promise<Transport> {
    if (isFakeHandle(id) !== this.simulated) {
      return Promise.reject(new Error(wrongSourceWords(this.simulated)))
    }
    return this.active().connect(id)
  }
}

export const scanner = new ActiveScanner()

/** Turn the simulated pair on or off. Returns whether it is now on. */
export const useFakeGlasses = (on: boolean): Promise<boolean> =>
  scanner.useFake(on, () => new FakeScanner())

/**
 * Whether the app is on the simulated pairs right now.
 *
 * A screen has to ask rather than remember. `SimulatedPair` used to hold the answer in
 * its own `useState(false)`, and that component remounts on every disconnect and every
 * visit to the tab, so after one switch the screen listed two simulated pairs while its
 * own caption offered to "use simulated glasses". Same defect as the stale rows, in the
 * one line that was supposed to label them.
 */
export const usingFakeGlasses = (): boolean => scanner.simulated

/**
 * Re-exported so screens reach the fake through this file and never directly.
 *
 * One door in is what stops a screen showing simulated state beside real state with
 * nothing saying which is which, and `fake-glasses.test.ts` holds it: the only
 * module in the app allowed to import `fake-glasses.js` is this one.
 */
export { FAKE_AVAILABLE } from './fake-glasses.js'
