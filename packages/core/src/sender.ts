/**
 * Live pixels, sent as a desired state rather than as a queue of frames.
 *
 * Write-without-response has no flow control. A finger dragging across a canvas
 * produces touch events far faster than one column per pacing interval, so a
 * sender that queues every frame overruns the controller, columns are dropped
 * silently, and stale pixels stay lit. The user sees a wrong drawing and blames
 * the panel. `notes/app-plan.md`, "The coalescing live sender", is the reasoning.
 *
 * So there is no queue anywhere in this file. There is one `desired` grid that
 * callers overwrite as often as they like, one `sent` grid holding what the device
 * is believed to show, and a pump that repeatedly writes the single next column
 * where the two differ. Intermediate states are skipped rather than stored: fifty
 * touches during one write land as one correct final frame.
 *
 * Two consequences worth knowing before reading the code:
 *
 *  1. **The next column is chosen after every write, not once per frame.** That is
 *     why this does not use `Grid.deltaFrames()`, which decides a whole frame's
 *     worth up front. A touch arriving mid-batch is picked up on the next write,
 *     not after the batch it arrived during.
 *  2. **The last write of a batch is acked**, so a frame cannot be half-delivered
 *     if the caller disconnects immediately after. Everything before it is
 *     unacked, which is what makes the batch fast.
 *
 * It does not put the unit into DIY mode and does not take it out: `Glasses.begin()`
 * sends `SMVEW 01`, and this writes pixels to whatever mode the unit is in. What it
 * does own is the live buffer, for its whole lifetime. Do not interleave
 * `Glasses.show()` with it: that keeps its own idea of what was last sent, and the
 * two would each skip columns the other had changed.
 */
import { type Bitmap, toGrid } from './content.js'
import { COLS, Grid, ROWS } from './display.js'
import * as p from './protocol.js'
import type { Transport } from './transport.js'

const timer = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** One column's live frame: `[04][index][3 bytes]`, big-endian, two bits per pixel. */
function columnFrame(grid: Grid, c: number): Uint8Array {
  const w = grid.columnWord(c)
  return p.column(c, new Uint8Array([(w >> 16) & 0xff, (w >> 8) & 0xff, w & 0xff]))
}

export interface SenderOptions {
  /**
   * Delay between column writes. 18ms matches `Glasses`; the hardware floor is
   * ~6.5ms, one frame on the display module's UART, and below it the controller
   * starts dropping writes.
   */
  pacing?: number
  /**
   * The cipher the session chose, which on a mixed fleet is a function of the
   * advert name. Frames written with the wrong key are garbage the device ignores.
   */
  cipher?: p.Cipher
  /**
   * Called once if a write fails and the sender dies. Not called by `stop()`.
   *
   * Without it a dead sender is silent to anyone who does not await something.
   * `draw()` returns `this` and `set()` returns `this`, so a canvas pushing a touch
   * per frame never learns that nothing has reached the panel since the link
   * dropped: the drawing on the phone and the drawing on the glasses simply
   * diverge, which reads as broken hardware. Throwing from `draw()` instead would
   * put a try/catch around every touch handler for a condition that is the
   * connection's, not the touch's.
   *
   * A handler that throws is swallowed. It is UI code and the sender is already
   * dead; taking the pump down with it would only lose the reason.
   */
  onError?: (err: unknown) => void
  /** Injectable so tests need no timers. Nothing else should pass this. */
  sleep?: (ms: number) => Promise<void>
}

export interface ClearOptions {
  /**
   * `CLRL` clears the live buffer in a single write, with no sweep. No client of
   * ours has ever sent it, but it is not a guess either: `SMVEW 01` clears by
   * branching into the middle of the `CLRL` handler, so entering DIY already runs
   * these instructions every session (*verified* at byte level,
   * `research/firmware-internals.md`). Pass `false` to clear by writing 24 blank
   * columns instead, which sweeps visibly but uses only paths known to work.
   */
  atomic?: boolean
}

export class LiveSender {
  /** What the caller wants on the panel. Nothing reads this but the pump. */
  private desired = new Grid()

  /** What the device is believed to be showing. */
  private sent = new Grid()

  /**
   * Columns from here up are not to be trusted and will be rewritten whatever
   * they hold. `COLS` means every column's state is known.
   *
   * It starts known-blank because `SMVEW 01` stops the animation engine *and*
   * clears the live buffer (*verified* at byte level: its arm at `abs 0x1847e`
   * branches into the `CLRL` handler), and `Glasses.begin()` is what puts a unit
   * into DIY. Anything that could have moved
   * the panel behind our back - a `MODE`, a rhythm write, a reconnect, a sender
   * built on a connection someone else was already using - calls `refresh()`.
   */
  private cursor = COLS

  private clearNext = false

  /**
   * A `refresh()` has landed since the clear in flight was committed to, and it
   * outranks that clear: whatever moved the panel may have moved it *after* the
   * `CLRL` arrived, so a blank buffer is no longer something we know.
   */
  private refreshed = false

  private unacked = false

  private halted = false

  private running = false

  private pump: Promise<void> = Promise.resolve()

  private idlers: Array<[() => void, (err: unknown) => void]> = []

  private problem: unknown = null

  /** Separate from `problem`, so a rejection whose value is falsy still reports once. */
  private died = false

  private readonly pacing: number

  private readonly cipher: p.Cipher

  private readonly nap: (ms: number) => Promise<void>

  private readonly onError?: (err: unknown) => void

  constructor(
    private transport: Transport,
    opts: SenderOptions = {},
  ) {
    this.pacing = opts.pacing ?? 18
    this.cipher = opts.cipher ?? p.vendor
    this.nap = opts.sleep ?? timer
    this.onError = opts.onError
  }

  /** A failed write stops the pump for good; build a new sender on reconnect. */
  get stopped(): boolean {
    return this.halted
  }

  /** Why it stopped, if it stopped by itself. `idle()` rejects with the same. */
  get error(): unknown {
    return this.problem
  }

  /**
   * Writes still owed to the device, the one in flight included: `sent` is only
   * updated once a write has actually returned.
   */
  get pending(): number {
    return this.owed()
  }

  /**
   * Replace the desired state. Call it on every touch; it is cheap and it never
   * writes more than the difference.
   *
   * A `Bitmap` wider than the panel is truncated rather than wrapped, because the
   * firmware drops a column index >= 24 outright. Slide `viewport.gridAt()` over
   * wide content and hand the window here.
   */
  set(next: Grid | Bitmap): this {
    this.desired = next instanceof Grid ? next.clone() : toGrid(next)
    return this.kick()
  }

  /** One pixel of the desired state. `level` is 0-3, or `true` for full. */
  draw(row: number, col: number, level: boolean | number = true): this {
    this.desired.set(row, col, level)
    return this.kick()
  }

  /**
   * Blank the panel, by default in one write.
   *
   * A clear supersedes whatever columns were still owed: it resets the desired
   * state too, so anything drawn afterwards is written on top of a known-blank
   * device rather than racing the clear.
   */
  clear(opts: ClearOptions = {}): this {
    this.desired.clear()
    if (opts.atomic ?? true) this.clearNext = true
    return this.kick()
  }

  /**
   * Forget what the device is showing, so the next drain rewrites all 24 columns.
   *
   * Needed after anything that moves the panel without going through here. A
   * `MODE` is the common one: it switches to the saved store and discards the
   * live buffer entirely.
   */
  refresh(): this {
    this.cursor = 0
    this.refreshed = true
    return this.kick()
  }

  /**
   * Resolves when the device has been told everything asked for so far.
   *
   * Rejects with the write error if the pump died. After `stop()` it resolves
   * whether or not the state was delivered, because stopping is not a failure.
   */
  idle(): Promise<void> {
    if (this.died) return Promise.reject(this.problem)
    if (!this.running) return Promise.resolve()
    return new Promise((ok, fail) => {
      this.idlers.push([ok, fail])
    })
  }

  /**
   * Drain, then guarantee the bytes have actually left.
   *
   * A batch that drained acked itself, so this does nothing after one. It exists
   * for the batch that `stop()` cut short.
   */
  async flush(): Promise<void> {
    await this.idle()
    if (!this.unacked || this.died) return
    // The ack runs outside the pump, so a failure here would otherwise leave a dead
    // connection behind a sender that still reports itself healthy.
    try {
      await this.ack()
    } catch (err) {
      this.die(err)
      throw err
    }
  }

  /** Stop after the write in flight. Does not touch the connection. */
  async stop(): Promise<void> {
    this.halted = true
    await this.pump
  }

  private kick(): this {
    if (!this.running && !this.halted) {
      this.running = true
      this.pump = this.run()
    }
    return this
  }

  private async run(): Promise<void> {
    try {
      while (!this.halted) {
        if (this.clearNext) {
          await this.sendClear()
          // `CLRL` pushes a frame of its own, so whatever follows it needs the
          // same gap as any other pair of writes.
          if (this.owed() > 0 && this.pacing > 0) await this.nap(this.pacing)
          continue
        }
        const c = this.nextColumn()
        if (c < 0) {
          // `last` is decided before its write, so a column that was owed at that
          // moment and retracted during it leaves the batch unacked. Ack it rather
          // than let an immediate disconnect drop the final column.
          if (!this.unacked) break
          await this.ack()
          continue
        }
        const frame = columnFrame(this.desired, c)
        // The values as they go on the wire, because `desired` may be overwritten
        // while this write is open and `sent` must record what was actually sent.
        const values = Array.from({ length: ROWS }, (_, r) => this.desired.get(r, c))
        const last = this.owed(c) === 0
        await this.write(p.CHAR_BULK_B, frame, last)
        this.adopt(c, values)
        if (!last && this.pacing > 0) await this.nap(this.pacing)
      }
      this.settle(null, false)
    } catch (err) {
      this.die(err)
    } finally {
      this.running = false
    }
  }

  private async sendClear(): Promise<void> {
    // What will still be owed once the buffer is blank: every non-empty column.
    let after = 0
    for (let c = 0; c < COLS; c++) if (this.desired.columnWord(c)) after++
    this.refreshed = false
    await this.write(p.CHAR_COMMAND, p.clear(), after === 0)
    this.clearNext = false
    this.sent = new Grid()
    if (!this.refreshed) this.cursor = COLS
  }

  /** Columns owed a write, ignoring `skip`, plus a clear if one is queued. */
  private owed(skip = -1): number {
    let n = this.clearNext ? 1 : 0
    for (let c = 0; c < COLS; c++) {
      if (c === skip) continue
      if (c >= this.cursor || this.desired.columnWord(c) !== this.sent.columnWord(c)) n++
    }
    return n
  }

  /** The lowest column owed a write: a known difference first, then an untrusted one. */
  private nextColumn(): number {
    for (let c = 0; c < this.cursor; c++) {
      if (this.desired.columnWord(c) !== this.sent.columnWord(c)) return c
    }
    return this.cursor < COLS ? this.cursor : -1
  }

  private adopt(c: number, values: number[]): void {
    for (let r = 0; r < ROWS; r++) this.sent.set(r, c, values[r])
    if (c === this.cursor) this.cursor++
  }

  /**
   * Force everything already handed to the transport out onto the air.
   *
   * A write WITH response is acknowledged by the peer, so once it returns every
   * earlier write has necessarily been transmitted. `STYPE` reaches no handler on
   * this firmware, which is the point: the ack is the whole payload.
   */
  private ack(): Promise<void> {
    return this.write(p.CHAR_COMMAND, p.queryType(), true)
  }

  private async write(
    char: string,
    frame: Uint8Array,
    withResponse: boolean,
  ): Promise<void> {
    this.unacked = !withResponse
    await this.transport.write(char, this.cipher.encrypt(frame), withResponse)
  }

  /**
   * Wake everyone waiting on `idle()`.
   *
   * `failed` is a flag rather than a truthiness test on `err`, because a transport
   * that rejects with `undefined` or an empty string would otherwise resolve every
   * waiter as if the batch had landed. Rare, and silent when it happens: the caller
   * is told the panel is up to date over a connection that is gone.
   */
  private settle(err: unknown, failed: boolean): void {
    for (const [ok, fail] of this.idlers.splice(0)) {
      if (failed) fail(err)
      else ok()
    }
  }

  /**
   * A write failed, so this sender is finished: build a new one on reconnect.
   *
   * `cursor` goes to 0 rather than staying where it was, because a sender that is
   * revived by a future change of mind must not believe any column survived the
   * failure.
   */
  private die(err: unknown): void {
    if (this.died) return
    this.died = true
    this.problem = err
    this.halted = true
    this.cursor = 0
    this.settle(err, true)
    try {
      this.onError?.(err)
    } catch {
      // The handler is UI code and the sender is already dead. Letting it throw
      // from here would replace the write error with the handler's own.
    }
  }
}
