/**
 * A pair of glasses that exists only on the phone.
 *
 * Built 2026-08-12 as track 40, because the repo's own convention is that what a
 * screen does is checked by looking at it, and the looking had backed up: eleven
 * tracks landed between 2026-08-11 and 2026-08-12 and not one had been driven on a
 * handset. The blockers were always physical. There is one working pair, its flash
 * budget is global and counted, and every save spends five page erases of a wear
 * budget nobody can read back. So "tap through the app twenty times to see whether
 * the Show tab is right" was never a thing anyone could actually do.
 *
 * This removes that. A fake pair scans, connects, answers the DATS handshake, takes
 * live columns and holds a saved store, so every screen in the app can be driven
 * with no hardware attached and no erase spent on the real unit.
 *
 * **What this is evidence of, and what it is not.** It models what this repo
 * *believes* the firmware does, which is exactly the set of claims that most need
 * checking. So it can never confirm one. If the fake panel and `Preview.tsx` agree,
 * that is because both read `viewport`, not because the device does; if a *derived*
 * claim in `notes/protocol.md` is wrong, this is wrong the same way and just as
 * confidently. Nothing observed here may be written up as a finding, and nothing
 * here closes a "Verify before building" item. Its whole value is the app above the
 * wire: navigation, state, wording, residency, what a tap does to a screen.
 *
 * Three properties that keep it from doing harm:
 *
 *  - **It cannot exist in a release build.** `FAKE_AVAILABLE` is `__DEV__`, the
 *    switch below refuses to turn on without it, and `fake-glasses.test.ts` asserts
 *    the guard. A phone in a field runs the real scanner whatever any stored flag
 *    says, because a persisted "use the fake" would strand someone at a festival
 *    with an app cheerfully talking to nothing.
 *  - **Fake pairs are their own devices.** They advertise `GLASSES-FA4E01/02`, and
 *    every store in this app is keyed on the advert name (ledger, nicknames,
 *    settings, residency). So a fake save writes a fake ledger entry and the real
 *    unit's wear count is untouched. That is the reason for distinct names rather
 *    than borrowing the real one.
 *  - **It speaks the wire, not the API.** Frames arrive encrypted and are decoded
 *    with `protocol`'s own cipher and framing, so the app's DATS handshake, pacing
 *    and channel discipline are all exercised for real. A fake that took method
 *    calls would prove nothing about the bytes.
 */
import { assertChannel, content, dats, display, protocol as p, viewport } from '@joggles/core'
import type { Bitmap, Discovered, Scanner, Transport } from '@joggles/core'

/** Dev builds only. `__DEV__` is false in the release bundle, which is the point. */
export const FAKE_AVAILABLE: boolean = typeof __DEV__ !== 'undefined' && __DEV__

/**
 * Names the fake pairs advertise.
 *
 * `FA4E` reads as "fake" and is not a MAC suffix any real unit will produce, so a
 * scan row, a ledger entry or a nickname belonging to a simulated pair is
 * identifiable from the name alone, long after this session is over.
 */
export const FAKE_NAMES = ['GLASSES-FA4E01', 'GLASSES-FA4E02'] as const

/** What the modelled panel is doing, for a dev view to draw. */
export interface FakePanelState {
  /** 9x24 of levels 0-3, row 0 at the bottom, as `display.Grid` orders them. */
  grid: number[][]
  /** Plain words for what put that there, e.g. "saved scroll" or "live columns". */
  source: string
  brightness: number
  speed: number
  /** Set while the panel is showing a saved scroll, so a viewer can step it. */
  scrolling: boolean
}

const ROWS = display.ROWS
const COLS = display.COLS

const blankGrid = (): number[][] =>
  Array.from({ length: ROWS }, () => new Array(COLS).fill(0))

/**
 * Payload bytes the device will take an announcement for, per DATS type.
 *
 * Read off `content`'s own constants rather than restated, so the fake and the app
 * cannot disagree about where the wall is. Both ceilings are *verified on hardware*
 * as device replies (`ERROR` at 745 columns of text, at 384 of image), which makes
 * them the strongest claims this file models: the type 2 *display* ceiling of 24 is
 * a much weaker null observation and is deliberately not enforced here, because the
 * device accepts that width and simply shows none of it.
 */
const acceptBytes = (type: number): number =>
  type === dats.TYPE_IMAGE
    ? content.IMAGE_ACCEPT_CEILING * dats.IMAGE_COLUMN_BYTES
    : content.MAX_SAVED_COLUMNS * 2

/**
 * Opcodes matched longest-first, rather than by taking the leading run of capitals.
 *
 * `mock-transport.opcodeOf` takes the capital run and its docblock records what that
 * costs: any frame whose first argument byte lands in 0x41-0x5A joins the opcode, so
 * `SPEED 70` reads back as `SPEEDF`. The app sends speeds across that whole range,
 * so a device modelled on the capital run would silently ignore most of them.
 */
const OPCODES = [
  'DATCP', 'DATS', 'SMVEW', 'LIGHT', 'SPEED', 'MODE', 'CLRL', 'IMAG', 'ANIM',
  'LOOA', 'LOOP', 'STYPE', 'EVERT', 'STOPR', 'SOUT', 'LEDON', 'LEDOFF',
].sort((a, b) => b.length - a.length)

function decode(plain: Uint8Array): { op: string; args: Uint8Array } {
  const body = p.body(plain)
  const text = String.fromCharCode(...body)
  for (const op of OPCODES) {
    if (text.startsWith(op)) return { op, args: body.subarray(op.length) }
  }
  return { op: '', args: body }
}

/**
 * One simulated unit: the panel model plus the flash store, per advert name.
 *
 * Held at module scope and keyed by name so that disconnecting and reconnecting
 * finds the same device still holding what it was given, which is the behaviour the
 * whole residency design rests on and the thing a per-connection object would
 * quietly fake away.
 */
export class FakeDevice {
  /** The DIY live buffer: what live column writes address. */
  private live = blankGrid()

  /** The type 1 store. One buffer, no slots, exactly as the firmware has it. */
  private savedText: Bitmap | null = null

  /** The type 2 store: RAM, shown on DATCPOK, discarded by any MODE. */
  private savedImage: Bitmap | null = null

  private inDiy = false

  /** An upload in flight: announced type and length, and the bytes so far. */
  private upload: { type: number; want: number; got: number[] } | null = null

  private mode: { kind: number; dir: number } | null = null

  private builtin: string | null = null

  brightness = 3

  speed = 65

  /** Rising each time the panel changes, so a React view can subscribe cheaply. */
  private listeners = new Set<() => void>()

  constructor(readonly name: string) {}

  subscribe(on: () => void): () => void {
    this.listeners.add(on)
    return () => this.listeners.delete(on)
  }

  private changed(): void {
    for (const on of this.listeners) on()
  }

  /** Apply one decrypted frame. Returns plaintext replies the device would notify. */
  handle(char: string, plain: Uint8Array): Uint8Array[] {
    if (char === p.CHAR_BULK_B) return this.bulkB(plain)
    if (char === p.CHAR_BULK_A) return this.bulkA(plain)
    if (char === p.CHAR_COMMAND) return this.command(plain)
    return []
  }

  private command(plain: Uint8Array): Uint8Array[] {
    const { op, args } = decode(plain)
    switch (op) {
      case 'DATS': {
        // [type][len hi][len lo]. **The length check is here, not at DATCP**: an
        // over-long announcement returns a clean ERROR before a single block is
        // sent, verified on hardware at 1490 bytes. Modelling the refusal at the
        // commit instead would let a test upload 700 wasted blocks and still call
        // itself a pass.
        const type = args[0] ?? dats.TYPE_TEXT
        const want = ((args[1] ?? 0) << 8) | (args[2] ?? 0)
        if (want > acceptBytes(type)) {
          this.upload = null
          return [p.frame('ERROR')]
        }
        this.upload = { type, want, got: [] }
        return [p.frame('DATSOK')]
      }
      case 'DATCP':
        return [this.complete()]
      case 'MODE': {
        // MODE is a one-way door: it switches to the type 1 flash store, and both
        // the DIY buffer and any type 2 image are gone for good.
        this.mode = { kind: args[0] ?? 1, dir: args[1] ?? 0 }
        this.inDiy = false
        this.savedImage = null
        this.builtin = null
        this.live = blankGrid()
        this.changed()
        return []
      }
      case 'SMVEW': {
        const n = args[0] ?? 0
        // 01 enters DIY and clears the live buffer, which is the behaviour that
        // made "the second time I show text it turns them off" look like dead
        // hardware on 2026-08-11.
        if (n === 1 || n === 3) {
          this.inDiy = true
          this.live = blankGrid()
        } else if (n === 0) {
          this.inDiy = false
        }
        this.changed()
        return []
      }
      case 'LIGHT':
        // The dispatcher clamps 1-5 and floors at 1.
        this.brightness = Math.min(5, Math.max(1, args[0] ?? 1))
        this.changed()
        return []
      case 'SPEED':
        this.speed = args[0] ?? 65
        this.changed()
        return []
      case 'CLRL':
        this.live = blankGrid()
        this.changed()
        return []
      case 'IMAG':
      case 'ANIM':
        // Both take the panel from the DIY buffer and from any resident type 2.
        this.builtin = `${op} ${args[0] ?? 0}`
        this.inDiy = false
        this.savedImage = null
        this.live = blankGrid()
        this.changed()
        return []
      default:
        // LEDON/LEDOFF and the rest are unmatched opcodes the firmware discards.
        return []
    }
  }

  private bulkA(plain: Uint8Array): Uint8Array[] {
    // The DATS stream: [n][up to 15 payload bytes].
    if (this.upload === null) return []
    this.upload.got.push(...p.body(plain))
    return []
  }

  private bulkB(plain: Uint8Array): Uint8Array[] {
    const body = p.body(plain)
    // A live column is [index][3 bytes]; a rhythm frame is [0d][style][12 bars].
    if (body.length !== 4) return []
    const index = body[0]
    if (index >= COLS) return []
    const word = (body[1] << 16) | (body[2] << 8) | body[3]
    for (let r = 0; r < ROWS; r++) this.live[r][index] = (word >> (2 * r)) & 0b11
    this.inDiy = true
    this.changed()
    return []
  }

  /**
   * Finish an upload.
   *
   * A `DATCP` with no `DATS` in front of it answers ERROR, which is what a cancelled
   * upload leaves behind: `SaveOpts.cancel` stops before the commit and sends nothing
   * to tidy up, deliberately, so the next handshake has to be the thing that recovers.
   *
   * Nothing here re-checks the length. The device took the announcement or it did
   * not, and answering DATCPOK to a payload that never fitted is precisely the shape
   * of track 32's open defect: `deliver()` sends `MODE` on anything that is not
   * `refused`, so a wrong ERROR here would hide it and a wrong DATCPOK would invent it.
   */
  private complete(): Uint8Array {
    const up = this.upload
    this.upload = null
    if (up === null) return p.frame('ERROR')
    const payload = new Uint8Array(up.got)
    if (up.type === dats.TYPE_IMAGE) {
      this.savedImage = dats.decodeImage(payload)
      // A type 2 displays on DATCPOK by itself, with no MODE.
      this.mode = null
      this.builtin = null
      this.inDiy = false
      this.changed()
      return p.frame('DATCPOK')
    }
    this.savedText = dats.decodeBitmap(payload)
    this.changed()
    return p.frame('DATCPOK')
  }

  /**
   * What the panel shows at `now`, as levels.
   *
   * The scroll is stepped off the wall clock through `viewport.frames(..., { loop:
   * 'panel' })`, the same model `Preview.tsx` calls since track 36, and at
   * `protocol.msPerColumn(speed)`. **Both of those are the app's belief**: the
   * bracket is half-open (`research/loop-gap-2026-08-10.md`) and the ladder is
   * *derived* from the disassembly and contradicted by the one side-by-side anyone
   * has done ("the preview is way slower than the actual speed of the device").
   * So this agrees with the preview by construction and neither is a witness.
   */
  panel(now: number): FakePanelState {
    const base = {
      brightness: this.brightness,
      speed: this.speed,
      scrolling: false,
    }
    // DIY is checked first because it is a state the device is *in*, not a thing it
    // is showing: a live column write pulls the panel back off a saved scroll, and
    // the saved store is what shows when DIY is not up. Getting this the other way
    // round makes the draw pad look dead the moment anything has ever been saved.
    if (this.inDiy) {
      return { ...base, grid: this.live.map((r) => [...r]), source: 'live columns' }
    }
    if (this.builtin !== null) {
      return { ...base, grid: blankGrid(), source: `built-in ${this.builtin}` }
    }
    if (this.savedImage !== null) {
      return {
        ...base,
        grid: viewport.windowAt(this.savedImage, 0),
        source: 'saved image (type 2, RAM)',
      }
    }
    if (this.mode !== null && this.savedText !== null) {
      const scroll = this.mode.kind === 2 || this.mode.kind === 3
      if (!scroll) {
        return {
          ...base,
          grid: viewport.windowAt(this.savedText, 0),
          source: 'saved store, static',
        }
      }
      const dir = this.mode.dir === 1 ? 1 : 0
      const steps = viewport.frames(this.savedText, { kind: 'scroll', dir }, {
        loop: 'panel',
      })
      const at = Math.floor(now / p.msPerColumn(this.speed)) % Math.max(1, steps.length)
      return {
        ...base,
        grid: viewport.windowAt(steps[at], 0),
        scrolling: true,
        source: `saved scroll (${this.mode.kind === 3 ? 'MODE 03 bounce' : 'MODE 02'})`,
      }
    }
    return { ...base, grid: blankGrid(), source: 'nothing showing' }
  }

  /**
   * Forget everything, as a battery pull would not.
   *
   * For tests, and for a dev view that wants a clean pair. Deliberately **not** what
   * a disconnect does: a pair that forgot its store on disconnect would make every
   * free `MODE` return look like it worked when the real thing had evicted it.
   */
  reset(): void {
    this.live = blankGrid()
    this.savedText = null
    this.savedImage = null
    this.upload = null
    this.inDiy = false
    this.mode = null
    this.builtin = null
    this.brightness = 3
    this.speed = 65
    this.changed()
  }
}

const devices = new Map<string, FakeDevice>()

export function fakeDevice(name: string): FakeDevice {
  const got = devices.get(name)
  if (got) return got
  const made = new FakeDevice(name)
  devices.set(name, made)
  return made
}

/** Every fake pair that has been created, for a dev view to list. */
export const fakeDevices = (): FakeDevice[] => [...devices.values()]

/**
 * The wire half: encrypt, decrypt, and a delay so an upload takes visible time.
 *
 * The delay is why the progress bar and the tab-bar latch are testable at all. Track
 * 34's bar exists because "it seems to keep having to send the animation" was five
 * silent seconds; a transport that replied instantly would render that bar for one
 * frame and prove nothing about it.
 */
class FakeTransport implements Transport {
  private listeners = new Map<string, (block: Uint8Array) => void>()

  private cipher = p.vendor

  constructor(
    private device: FakeDevice,
    private latencyMs: number,
  ) {}

  async write(char: string, block: Uint8Array, _withResponse: boolean): Promise<void> {
    // The same guard the real adapter applies, so the fake cannot be used to reach
    // a channel the app is forbidden from addressing.
    assertChannel(char)
    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs))
    }
    const replies = this.device.handle(char, this.cipher.decrypt(block))
    const notify = this.listeners.get(p.CHAR_NOTIFY)
    for (const frame of replies) notify?.(this.cipher.encrypt(frame))
  }

  async subscribe(char: string, on: (block: Uint8Array) => void): Promise<void> {
    this.listeners.set(char, on)
  }

  async disconnect(): Promise<void> {
    this.listeners.clear()
  }
}

/**
 * A scanner that finds the fake pairs and nothing else.
 *
 * RSSI drifts, because a fixed number would hide `proximity.ts`'s whole job: the
 * EWMA smoothing, the band split and the 12s freshness window are only visible when
 * the readings move. It never emits the two no-reading sentinels, which is a
 * deliberate gap: those are `ble.ts`'s to fold and are covered in bun.
 */
export class FakeScanner implements Scanner {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private latencyMs = 3) {}

  async scan(onFound: (unit: Discovered) => void): Promise<void> {
    await this.stop()
    let tick = 0
    const emit = () => {
      tick += 1
      FAKE_NAMES.forEach((name, i) => {
        // A slow wander between about -45 and -85 dBm, out of phase per pair.
        const swing = Math.sin((tick + i * 7) / 6)
        onFound({
          id: `fake:${name}`,
          name,
          rssi: Math.round(-65 + swing * 20),
        })
      })
    }
    emit()
    this.timer = setInterval(emit, 1200)
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  async connect(id: string): Promise<Transport> {
    await this.stop()
    const name = id.replace(/^fake:/, '')
    if (!FAKE_NAMES.includes(name as (typeof FAKE_NAMES)[number])) {
      throw new Error(`no such simulated pair: ${name}`)
    }
    // A real connect is a fixed ~880 ms and it is the dominant term once pacing is
    // tuned, so the connect ceremony reads as it does in the field.
    await new Promise((r) => setTimeout(r, 400))
    return new FakeTransport(fakeDevice(name), this.latencyMs)
  }
}
