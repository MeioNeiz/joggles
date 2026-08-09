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

  async scan(onFound: (unit: Discovered) => void): Promise<void> {
    if (!(await requestPermissions())) throw new Error('bluetooth permission refused')
    await this.ready()
    await this.release()
    await this.manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (error || !device) return
      // localName is the advert; name can be a cached GAP name, so prefer the advert.
      const name = device.localName ?? device.name ?? ''
      if (!this.prefixes.some((prefix) => name.startsWith(prefix))) return
      onFound({ id: device.id, name, rssi: device.rssi ?? 0 })
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
 */
export const scanner = new BleScanner()
