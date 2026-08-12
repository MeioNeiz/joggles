/**
 * The one live sender a connection is allowed, owned above every screen.
 *
 * Two senders over one connection each believe their own picture of the panel and
 * repair against it, which is the state `LiveSender`'s docblock forbids - and the old
 * shape invited it: Compose and Draw each built a sender in their own effect, so a
 * trip between screens was a handoff nobody owned. This class is that ownership. The
 * app makes one per connection and every screen that wants the live route asks it.
 *
 * The rules it encodes are all lessons already paid for:
 *
 *  - **`begin()` before the sender exists, and only once per sender.** `SMVEW 01` both
 *    stops the animation engine and clears the live buffer, which is the blank state
 *    `LiveSender` assumes it starts from. Building the sender first would have it
 *    believe a panel it had not cleared.
 *  - **Concurrent callers share one opening.** Two taps racing `begin()` used to be
 *    possible per screen; here the second awaits the first's promise, so `SMVEW 01`
 *    goes out once and one sender exists. (The Fast Refresh `mounted` latch defect in
 *    the first feedback table was this shape: the fix is owning it outside any
 *    screen's lifecycle.)
 *  - **`dropped()` after anything that takes the panel.** A `MODE`, an `ANIM`, an
 *    `IMAG`: the live buffer is discarded and the sender's believed-sent grid is a
 *    fiction, so the sender is stopped and forgotten rather than repaired. The next
 *    `live()` begins DIY afresh.
 *  - **Stop, then flush, on the way out**, in Draw's order: stopping ends the pump
 *    after the write in flight, and the flush acks a tail an immediate disconnect
 *    would drop. It never leaves DIY - `SMVEW 00` would restore the vendor's saved
 *    image, which looks like stray pixels from nowhere.
 *
 * No mutex against `save()` lives here: `Glasses` has none, so screens still gate
 * wire-touching controls on their own `busy`, exactly as before.
 */
import type { Glasses, LiveSender } from '@joggles/core'

export class PanelSession {
  private sender: LiveSender | null = null
  private opening: Promise<LiveSender> | null = null

  constructor(
    private readonly glasses: Glasses,
    private readonly onError: (e: unknown) => void,
  ) {}

  /** The sender, entering DIY first if nobody has. Safe to race. */
  async live(): Promise<LiveSender> {
    if (this.sender !== null && !this.sender.stopped) return this.sender
    this.opening ??= this.open()
    try {
      return await this.opening
    } finally {
      this.opening = null
    }
  }

  private async open(): Promise<LiveSender> {
    await this.glasses.begin()
    const made = this.glasses.live({ onError: this.onError })
    this.sender = made
    return made
  }

  /** Whether a live picture is believed to be on the panel. */
  get holding(): boolean {
    return this.sender !== null && !this.sender.stopped
  }

  /**
   * The panel was taken by a `MODE` or a built-in: forget the sender.
   *
   * Fire and forget, deliberately: the buffer is already discarded on the device, so
   * there is no tail worth flushing and nothing to await before the caller reports.
   */
  dropped(): void {
    this.sender?.stop().catch(() => {})
    this.sender = null
  }

  /** On disconnect. Stop, then flush the tail; never leaves DIY. */
  async end(): Promise<void> {
    const s = this.sender
    this.sender = null
    if (s === null) return
    await s.stop().catch(() => {})
    await s.flush().catch(() => {})
  }
}
