/**
 * Playing a frame animation down the wire, which is the only route that shows frames.
 *
 * `core/src/anim.ts` explains why this exists: the device has nowhere to store a frame
 * animation, so the frames are cut here on the phone and pushed one at a time. What makes
 * it viable rather than the visible sweep the protocol docs warn about is that
 * `LiveSender` holds a desired grid and a believed-sent grid and writes only the columns
 * that differ - so a small pixel-art loop is three or four writes a frame, not 24.
 *
 * ## The two rules that keep it honest
 *
 * **Never drop a frame to catch up.** The obvious way to hold a frame rate is to skip
 * frames when behind, and it is wrong here: the panel keeps whatever columns it was last
 * given, so a skipped frame is not a missing frame, it is a *stale* one, and the picture
 * left behind is a blend of two poses that the animation never contained. Running slow is
 * visibly slow; dropping is visibly broken. So every frame is set and awaited, and
 * `anim.livePlan().slow` is how a screen warns beforehand instead.
 *
 * **Hold time is measured from when the frame was set, not after it arrived.** A frame
 * that took 40 ms to write has already used 40 ms of its own hold, and sleeping the full
 * delay on top of the write would make every animation run at the sum of the two. So the
 * loop sleeps the remainder or not at all.
 *
 * ## What it deliberately does not own
 *
 * It never enters or leaves DIY, and it never constructs a sender: it asks for one through
 * the closure it was given, which is `PanelSession.live()`, because the app is allowed
 * exactly one `LiveSender` and that ownership sits above every screen
 * (`panel-session.ts`). It also never clears on the way out - the last frame stays lit,
 * the same `end('keep')` default the rest of the app uses, because a panel going dark on
 * stop reads as a fault.
 *
 * `FrameTarget` is the narrow structural slice of `LiveSender` this needs. It is narrow on
 * purpose: a player that could reach `clear()`, `refresh()` or `stop()` would be a second
 * owner of the sender's lifecycle, which is the exact thing `PanelSession` exists to
 * prevent.
 */
import type { Bitmap } from '@joggles/core'
import { anim } from '@joggles/core'

/** The slice of `LiveSender` a player is allowed to touch. */
export interface FrameTarget {
  set(next: Bitmap): unknown
  idle(): Promise<void>
  readonly stopped: boolean
}

export interface PlayerOptions {
  /** `PanelSession.live()`. Called once per `play()`, never cached across stops. */
  target: () => Promise<FrameTarget>
  /** Reported and then swallowed: a dying wire must not throw into a render. */
  onError?: (err: unknown) => void
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export class FramePlayer {
  /**
   * Bumped by every `play()` and `stop()`.
   *
   * The running loop compares it against the value it started with and returns the moment
   * they differ, which is what makes switching animations safe: the old loop cannot write
   * one more frame after the new one has begun, and two loops driving one sender would be
   * the two-owners bug in a different costume.
   */
  private generation = 0

  private loop: Promise<void> = Promise.resolve()

  private at = 0

  private current: anim.Animation | null = null

  private readonly nap: (ms: number) => Promise<void>

  private readonly clock: () => number

  constructor(private readonly opts: PlayerOptions) {
    this.nap = opts.sleep ?? wait
    this.clock = opts.now ?? (() => Date.now())
  }

  /** Whether a loop is running. False the instant `stop()` is called, not when it lands. */
  get playing(): boolean {
    return this.current !== null
  }

  /** Which frame was last put on the panel, for a screen that mirrors the playback. */
  get frame(): number {
    return this.at
  }

  /**
   * Start looping an animation, replacing whatever was playing.
   *
   * Returns immediately: the caller is a tap handler, not a playback owner. Errors reach
   * `onError` and stop the loop rather than rejecting into nowhere.
   */
  play(animation: anim.Animation): void {
    if (animation.frames.length === 0) return
    const mine = ++this.generation
    this.current = animation
    this.at = 0
    const previous = this.loop
    this.loop = (async () => {
      await previous.catch(() => {})
      await this.run(animation, mine)
    })()
  }

  /** Stop after the frame in flight, leaving it lit. Safe to call when not playing. */
  async stop(): Promise<void> {
    this.generation++
    this.current = null
    await this.loop.catch(() => {})
  }

  private async run(animation: anim.Animation, mine: number): Promise<void> {
    try {
      const target = await this.opts.target()
      if (this.generation !== mine) return
      const { frames, frameMs } = animation
      for (let i = 0; this.generation === mine; i = (i + 1) % frames.length) {
        if (target.stopped) break
        const started = this.clock()
        target.set(frames[i])
        this.at = i
        await target.idle()
        if (this.generation !== mine) return
        const spent = this.clock() - started
        const left = frameMs[i] - spent
        // A single-frame animation is a still: set it once and stop, rather than
        // rewriting columns that already hold the picture for as long as the app runs.
        if (frames.length === 1) break
        if (left > 0) await this.nap(left)
      }
    } catch (err) {
      this.opts.onError?.(err)
    } finally {
      if (this.generation === mine) this.current = null
    }
  }
}
