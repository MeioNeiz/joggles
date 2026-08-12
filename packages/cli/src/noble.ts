/**
 * The laptop's BLE adapter: noble/CoreBluetooth behind `Scanner` and `Transport`.
 *
 * All the platform knowledge lives here and nothing above it knows what noble is.
 * The phone's adapter is the same shape over ble-plx, which is what lets one
 * sequencer drive both.
 *
 * Three noble quirks it absorbs:
 *
 *  - UUIDs come back with the dashes stripped, where `protocol.ts` declares them
 *    dashed.
 *  - `writeAsync`'s second argument is `withoutResponse`, the inverse of what
 *    `Transport.write` takes. Getting this backwards is silent: writes still land,
 *    just unacked, and the last column of a frame goes missing on disconnect.
 *    **This is the one file no mock covers** - `MockTransport` stands in for
 *    everything above it, and nothing can stand in for this - so a change in here is
 *    only checked by running `bun cli text` on hardware and looking at the last
 *    column. That is why the trap is written here rather than in a notes file.
 *  - Scanning needs the adapter powered on, which it may not be yet at import time.
 */
import noble from '@abandonware/noble'
import { type Discovered, type Scanner, type Transport, assertChannel } from '@joggles/core'
import { protocol as p } from '@joggles/core'

/** noble strips dashes from UUIDs. */
const flat = (uuid: string) => uuid.replace(/-/g, '')

/** Resolve once the adapter is usable, or throw saying what state it is stuck in. */
async function poweredOn(): Promise<void> {
  if (noble._state === 'poweredOn') return
  await new Promise<void>((resolve, reject) => {
    noble.once('stateChange', (state: string) => {
      if (state === 'poweredOn') resolve()
      else reject(new Error(`bluetooth adapter is ${state}`))
    })
  })
}

export class NobleScanner implements Scanner {
  private seen = new Map<string, any>()

  private onDiscover: ((peripheral: any) => void) | null = null

  async scan(onFound: (unit: Discovered) => void): Promise<void> {
    await poweredOn()
    // Restarting a scan without this leaves the previous listener attached, and the
    // old callback keeps firing into whatever screen has since been closed.
    if (this.onDiscover) await this.stop()
    this.onDiscover = (peripheral: any) => {
      const name: string = peripheral.advertisement?.localName ?? ''
      this.seen.set(peripheral.id, peripheral)
      onFound({ id: peripheral.id, name, rssi: peripheral.rssi })
    }
    noble.on('discover', this.onDiscover)
    // Duplicates on, so a unit that appears late still shows up and its rssi moves.
    await noble.startScanningAsync([], true)
  }

  async stop(): Promise<void> {
    if (this.onDiscover) noble.removeListener('discover', this.onDiscover)
    this.onDiscover = null
    await noble.stopScanningAsync().catch(() => {})
  }

  async connect(id: string): Promise<Transport> {
    const peripheral = this.seen.get(id)
    if (!peripheral) throw new Error(`${id} was never seen advertising`)
    await this.stop()
    return connectTo(peripheral)
  }

  /**
   * Wait for the first advert matching a prefix, then stop.
   *
   * A convenience, not part of `Scanner`: it is what a one-shot CLI wants and what
   * a Scan screen must not do, because a list of units is the whole point there.
   */
  async first(prefixes: string[], timeoutMs: number): Promise<Discovered> {
    const unit = await new Promise<Discovered>((resolve, reject) => {
      const timer = setTimeout(async () => {
        await this.stop()
        reject(new Error('glasses not found - powered on? still held by the phone?'))
      }, timeoutMs)
      this.scan((found) => {
        if (!prefixes.some((prefix) => found.name.startsWith(prefix))) return
        clearTimeout(timer)
        resolve(found)
      }).catch(reject)
    })
    // Stop before connecting: CoreBluetooth is happier not doing both at once, and
    // the discovered peripherals stay in `seen` either way.
    await this.stop()
    return unit
  }
}

/**
 * Open a connection and discover exactly the four glasses channels.
 *
 * Discovering only those four is deliberate: this adapter never holds a handle on
 * the flash-writing service, so no bug above it can reach one. `assertChannel` is
 * the belt to that pair of braces. The OTA path in `flash.ts` keeps its own noble
 * code for exactly this reason, rather than being handed a back door here.
 */
async function connectTo(peripheral: any): Promise<Transport> {
  await peripheral.connectAsync()
  const wanted = [p.CHAR_COMMAND, p.CHAR_NOTIFY, p.CHAR_BULK_A, p.CHAR_BULK_B]
  const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
    [],
    wanted.map(flat),
  )
  const found = new Map<string, any>()
  for (const uuid of wanted) {
    const c = characteristics.find((ch: any) => ch.uuid === flat(uuid))
    if (c) found.set(uuid, c)
  }
  if (!found.has(p.CHAR_COMMAND) || !found.has(p.CHAR_BULK_B)) {
    await peripheral.disconnectAsync()
    throw new Error('expected characteristics not found')
  }

  const characteristic = (char: string) => {
    assertChannel(char)
    const c = found.get(char)
    if (!c) throw new Error(`${char} is not present on this device`)
    return c
  }

  return {
    async write(char, block, withResponse) {
      await characteristic(char).writeAsync(Buffer.from(block), !withResponse)
    },
    async subscribe(char, on) {
      const c = characteristic(char)
      c.on('data', (buf: Buffer) => on(new Uint8Array(buf)))
      await c.subscribeAsync()
    },
    async disconnect() {
      await peripheral.disconnectAsync()
    },
  }
}

/**
 * The raw noble peripheral, for the one caller that needs more than the four
 * channels: `flash.ts`, which is the OTA path and is barred from this adapter.
 */
export function findPeripheral(timeoutMs: number, prefixes: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      await noble.stopScanningAsync().catch(() => {})
      reject(new Error('glasses not found - powered on? still held by the phone?'))
    }, timeoutMs)

    const onDiscover = async (peripheral: any) => {
      const name: string = peripheral.advertisement.localName ?? ''
      if (!prefixes.some((prefix) => name.startsWith(prefix))) return
      clearTimeout(timer)
      noble.removeListener('discover', onDiscover)
      await noble.stopScanningAsync()
      resolve(peripheral)
    }

    noble.on('discover', onDiscover)
    poweredOn()
      .then(() => noble.startScanningAsync([], false))
      .catch(reject)
  })
}
