/**
 * The button on the glasses advances the playlist, and it can never spend an erase.
 *
 * `notes/playlist.md`'s premise is that stock firmware cannot do this: a short press
 * runs `mode_index++` then `set_mode(index+4)`, which cycles the 21 built-ins and
 * cannot reach the saved store, so the playlist is one packed reel switched by the
 * phone. Our extension's `BUTTON` sub-command changes that half: the unit reports the
 * edge and, with `SUPPRESS_CYCLE`, stops driving the panel itself, leaving the press
 * to mean whatever the host says it means. This module is that meaning, and nothing
 * else. It decides, it drives a `playlist.Cycler`, and it owns no wire of its own
 * beyond the one subscription.
 *
 * **Nothing here has run on any unit, and nothing can.** No pair carries the
 * extension, no unit has ever been flashed, and the firmware that would answer
 * `SUB.BUTTON` is not written yet. So every behaviour below is *derived*: the
 * suppression semantics from the hand-decoded press latch, the notification fields
 * from `jgx.ts`'s layouts, and the whole state machine from reasoning about a wire
 * nobody has watched. Treat a green test run here as a statement about this module,
 * not about a panel.
 *
 * ## The button never writes flash, and that is structural
 *
 * A press advances to the next step this cycler prices as `free`, skipping any step
 * that would need a `DATS`, and if a whole lap finds none the press does nothing and
 * says why. So the button walks the statics and a resident reel; committing a reel
 * stays the phone's job. Three reasons that is the rule rather than a preference:
 *
 *  - **Strangers press this button.** `notes/what-to-build.md` already names it: at a
 *    festival people will mash a stranger's glasses. A press that could spend five
 *    page erases makes a stranger's curiosity a wear cost, and no rate limit turns
 *    that into a good idea.
 *  - **The budget's answer to a runaway is a throw**, and a throw inside a
 *    notification handler has nowhere to go. Never issuing the save is better than
 *    catching a `BudgetError` and calling it handled.
 *  - **It keeps the feature's own claim true.** "A press advances the playlist and
 *    costs no flash" is checkable rather than hoped for: this module holds no
 *    reference to `save`, calls `show(i)` only on a step it priced `free`, and
 *    `press.test.ts` crawls the source for the save path and drives a full cycle
 *    asserting zero `DATS`.
 *
 * `costOf` errs towards `save` by its own docblock, so a step the budget would have
 * skipped can read as costed and be stepped over. That is the safe direction: the
 * cost of being wrong is a step the button will not show until the phone shows it
 * once, against an erase nobody asked for.
 *
 * `individual` mode is button-unusable by the same rule, which is correct: it is five
 * page erases per press by design and it is opt-in for that reason.
 *
 * ## Who owns the short press, and what happens on the way in and out
 *
 * `SUPPRESS_CYCLE` is the whole transition, and it is not symmetric.
 *
 *     start()   subscribe first, then BTN.PRESS | BTN.HOLD | BTN.SUPPRESS_CYCLE
 *     stop()    unsubscribe first, then BTN_OFF
 *
 * The listener goes on before the command in both directions and comes off before it
 * in the other, so no edge and no ACK can land in a gap. Registering after the write
 * would drop the `MSG.ACK` that says what is actually in force; unsubscribing after
 * it would let a press advance the playlist after the host asked to stop.
 *
 * **Nothing waits for the ACK, deliberately.** A `MSG.BUTTON` arriving is itself
 * proof the subscription landed, because the firmware only reports subscribed edges,
 * so the driver does not need a confirmation to act on a press. What the ACK adds is
 * the one thing no press can tell us: whether `SUPPRESS_CYCLE` took. That matters
 * because if it did not, the firmware moved the panel to a built-in on the same
 * press, and a built-in takes the panel exactly as `MODE` does. So `suppressed` is a
 * tri-state (`yes`/`no`/`unknown`) and it gates one thing only: whether the panel has
 * to be forgotten before the advance.
 *
 * `MSG.BUTTON.index` is the second, independent witness. Under suppression the device
 * has no cycle position to report and sends `INDEX_NONE`; a real index is the
 * firmware saying it cycled. So the rule is: **forget the panel before advancing
 * unless suppression is confirmed in force and the event reported `INDEX_NONE`.**
 * Both halves fail safe. A needless `forget()` costs one full 24-column redraw on a
 * live step and nothing at all on a reel step, where `SPEED` and `MODE` go out
 * regardless; a missed one leaves a delta aimed at a panel showing something else,
 * which is the "MODE discarded the live buffer" trap arriving without the host
 * sending anything. That is what `Cycler.forget()` was added for, and it is the same
 * rule `app/src/panel-session.ts` calls `dropped()`.
 *
 * *This contract is on a slot nobody has written.* `index === INDEX_NONE` under
 * suppression has to be true of the firmware, and whoever writes that arm has to
 * honour it. Nothing breaks if they do not, because the ACK covers the same question,
 * but the driver would then forget the panel on every press.
 *
 * ## Why no flag may ever suppress the 2 second hold
 *
 * `jgx.ts` states the rule; this module is where the reason becomes concrete. The
 * subscription lives in the unit's RAM and **a disconnect does not clear it**. So the
 * failure mode of this very driver is a phone that goes away with `SUPPRESS_CYCLE`
 * set: app killed, battery flat, out of range, `stop()`'s own write refused by a dead
 * link. The wearer is then holding glasses whose short press does nothing, with no
 * phone able to send `BTN_OFF`.
 *
 * The 2 second hold is what makes that survivable. It powers the unit off, RAM goes
 * with it, and the next power-on has the built-in cycle back with no phone involved.
 * A flag that could suppress the hold would turn a lost connection into glasses the
 * wearer cannot recover at all, which is a strictly worse outcome than any feature
 * such a flag could buy. `stop()` reports `cleared: false` when its write did not go
 * out, and that sentence is what a UI should print, because a power cycle is the fix
 * and the wearer can do it themselves.
 *
 * `HOLD` is subscribed by default for the opposite reason: it is report-only, and a
 * hold edge is the unit announcing it is about to switch off, so the link dropping
 * a moment later is expected rather than a fault to show a person.
 *
 * ## A press can arrive at any time
 *
 * | State when the press lands | What it does | What it costs |
 * | --- | --- | --- |
 * | stock unit, no `CAP.BUTTON` | nothing is subscribed, so no press exists | nothing |
 * | idle, next free step is a static | `SMVEW 01` then paced columns | nothing |
 * | idle, next free step is the resident reel | `SPEED` then `MODE` | nothing |
 * | next step needs a save | stepped over; a whole lap of them does nothing | nothing |
 * | an advance already in flight, upload included | dropped, counted | nothing |
 * | the host says no (`blocked`) | dropped with the host's own sentence | nothing |
 * | `RELEASE` edge | not an advance; reported to `onEdge` only | nothing |
 * | `HOLD` edge | never an advance: the unit is switching off | nothing |
 *
 * **One advance at a time, and a press that lands inside one is dropped rather than
 * queued.** Dropping is the decision worth arguing with, and it was taken over a
 * one-deep queue for two reasons. A press means "now", so honouring it after a
 * multi-second upload moves the panel with nobody touching the glasses; and a queue,
 * however shallow, lets presses bank against a wire that is busy, which is the shape
 * every flash-wear runaway in this repo has had. The count is reported instead, so a
 * UI can say the button was busy rather than pretend it was heard.
 *
 * The upload case is the one that must not race for a harder reason than tidiness:
 * `Cycler` holds no mutex, so a second `show()` inside the DATS handshake would
 * interleave two uploads on one connection and could commit a truncated payload over
 * content the user had already saved. `busy` only knows about advances this driver
 * started, so a host that drives the same cycler from a screen puts those calls
 * through `exclusive()`, and anything this driver cannot wrap says so through
 * `blocked`. Between them there is no window where a press reaches the wire while
 * something else has it.
 *
 * ## A unit that reboots and forgets
 *
 * Everything the device holds for this feature is RAM: the flags, the press counter
 * and the tick counter. So a power cycle hands the button back to the wearer and
 * un-subscribes us, and a reconnect has to `start()` again. Three consequences:
 *
 *  - **One `PressCycle` per connection.** Capabilities are per connection
 *    (`jgx.permits`'s docblock), so a driver built from last session's bitmap is a
 *    guess. Build it from the probe that connection made.
 *  - **`count` restarts, so the first press of a connection reports no missed
 *    presses.** `jgx.missedPresses` cannot tell a reboot from a wrap, and a
 *    connection's first press is exactly where it would be wrong, so it is not asked.
 *  - **`ask()` is how to find out what a unit is already doing**, which is the case
 *    where the app went away with suppression set and has come back. It sends
 *    `buttonAsk` and lets the ACK answer.
 *
 * A missed press means less than `jgx.missedPresses`'s docblock implies, and it is
 * worth being exact: under suppression a lost notification means the panel did
 * **not** move, because the host is the only thing that moves it, so the app's idea
 * of what is showing stays right and only the wearer's intent was lost. It is with
 * suppression off that a lost press leaves the app wrong about the panel, and that
 * case is covered by forgetting the panel on every press.
 *
 * ## The tick stamp
 *
 * Kept and reported, never thrown away, and nothing here reads a tempo out of it.
 * `PressEvent.sinceMs` is `jgx.tapIntervalMs` over the previous press's stamp, with
 * `hz` beside it so a consumer can redo the sum itself. What a consumer building on
 * it needs, and none of it is optional:
 *
 *  - **The tick rate in force**, not an assumed one. Stock is 50 Hz and the patch
 *    doubles it, so an assumption is a factor of two on every interval. Pass `hz` if
 *    the rate is known; this driver also adopts any `MSG.TICK` that comes past it,
 *    since `SUB.TICK` is a question anything on the connection may have asked.
 *  - **Device time, never arrival time.** The stamps are what make an interval
 *    immune to BLE round-trip jitter, and a burst of presses delivered in one radio
 *    interval carries the real spacing in the stamps and nowhere else. Mixing a
 *    stamp with `Date.now()` gives a number that is neither.
 *  - **The unsigned subtraction.** `tapIntervalMs` reads across the counter's wrap;
 *    a plain subtraction gives a negative interval once every 497 days at 100 Hz.
 *
 * The one thing this module does read out of the stamp is a repeat: an edge whose
 * count and stamp both match the previous one is the same edge delivered twice, and
 * acting on it would advance twice for one press.
 *
 * ## What is inert on a stock unit, which is every unit today
 *
 * `available` is `jgx.permits(capabilities, SUB.BUTTON)`, the feature bit and never
 * the `INPUT` family bit. Without it `start()` sends nothing, subscribes nothing and
 * returns a sentence, so a stock pair sees no frame it would have to ignore and the
 * playlist behaves exactly as it does with no button at all.
 */
import * as jgx from './jgx.js'
import type * as pl from './playlist.js'

/**
 * The slice of `Glasses` this needs: one command channel and the event stream.
 *
 * Structural, like `playlist.Driver`, so a test needs no transport and a screen
 * hands over no session. `onEvent` returns its own unsubscribe.
 */
export interface PressLink {
  command(frame: Uint8Array): Promise<void>
  onEvent(fn: (msg: jgx.Notification) => void): () => void
}

/**
 * The slice of `playlist.Cycler` a press drives.
 *
 * `costOf` and `show` both wrap an out-of-range index themselves, which is why this
 * walks `index + k` rather than doing the modulo again: getting the wrap wrong at the
 * ends is exactly where the cost of a press matters most.
 */
export interface Advancing {
  readonly length: number
  readonly index: number
  costOf(i: number): pl.Cost
  show(i: number): Promise<pl.StepResult>
  forget(): void
}

/**
 * What a press subscription asks for by default.
 *
 * `PRESS` is the feature. `HOLD` is report-only and free, and it is what lets an app
 * tell an expected power-off from a fault. `SUPPRESS_CYCLE` is what stops the
 * firmware's own `set_mode` fighting whatever the host then shows. `RELEASE` is not
 * here because nothing in this module acts on it.
 */
export const DEFAULT_FLAGS = jgx.BTN.PRESS | jgx.BTN.HOLD | jgx.BTN.SUPPRESS_CYCLE

/** Whether the firmware's built-in cycle is out of the way. */
export type Suppressed = 'yes' | 'no' | 'unknown'

export interface FlagOptions {
  /** Also report the release edge. Nothing here acts on one. */
  release?: boolean
  /** Leave the built-in cycle running, subscribing only. Default is to take it. */
  suppress?: boolean
}

/**
 * The flags a set of options asks for.
 *
 * Exported so a caller can see what will be sent, and so a test can walk every
 * combination. It cannot produce a bit outside `jgx.BTN_FLAGS`, and there is no bit
 * for the 2 s hold to produce: `buttonSet` is the gate that refuses anything else.
 */
export function flagsFor(opts: FlagOptions = {}): number {
  let flags = jgx.BTN.PRESS | jgx.BTN.HOLD
  if (opts.release) flags |= jgx.BTN.RELEASE
  if (opts.suppress !== false) flags |= jgx.BTN.SUPPRESS_CYCLE
  return flags
}

/** One edge, with the arithmetic the stamp and the counter are for already done. */
export interface PressEvent {
  /** `jgx.EDGE`. */
  edge: number
  count: number
  /** The device's own cycle position, or `jgx.INDEX_NONE` under suppression. */
  index: number
  ticks: number
  /**
   * Milliseconds since the previous press, in device time. Null for the first press
   * of a connection, and on a `HOLD` or `RELEASE` it is time since the press itself.
   */
  sinceMs: number | null
  /** Presses the host never saw. Always 0 for the first press of a connection. */
  missed: number
  /** The rate `sinceMs` was computed at, so a consumer can redo the sum. */
  hz: number
}

/**
 * What a press did.
 *
 * `costed` and `busy` are separate from `blocked` because they are the driver's own
 * refusals and `blocked` is the host's, and a UI wants to say different things.
 */
export type PressAction =
  | 'advanced'
  | 'busy'
  | 'blocked'
  | 'costed'
  | 'repeat'
  | 'failed'

export interface PressOutcome {
  event: PressEvent
  action: PressAction
  /** A sentence, printed verbatim. Absent only when the press advanced. */
  reason?: string
  /** The step, for `advanced`. Carries `showing` and the real cost, as ever. */
  step?: pl.StepResult
  /** What `show()` threw, for `failed`. A `BudgetError` arrives here. */
  error?: unknown
}

export interface PressOptions extends FlagOptions {
  /**
   * A reason a press cannot be honoured right now, or null.
   *
   * The host's own state, which this module cannot see and must not guess: a drawing
   * screen owning the panel, an upload running elsewhere, a spray out, a built-in
   * deliberately showing. One injected predicate rather than a set of flags, the
   * `app/src/spray.ts` shape, so the passes run under `bun test`.
   *
   * A throw from here reads as blocked. Deciding whether to act on unknown state
   * fails towards doing nothing, which is the direction `SaveOpts.cancel` fails in
   * too.
   */
  blocked?: () => string | null
  /** Every press and what it did. Report only: a throw from here is swallowed. */
  onPress?: (outcome: PressOutcome) => void
  /** The hold: the unit is switching itself off, so expect the link to drop. */
  onHold?: (event: PressEvent) => void
  /** The tick rate in force. A `MSG.TICK` on this connection overrides it. */
  hz?: number
}

export interface StartResult {
  started: boolean
  /** What was asked for, when it was asked for. */
  flags?: number
  reason?: string
}

export interface StopResult {
  /** The driver is no longer listening. True even when the write failed. */
  stopped: boolean
  /** `BTN_OFF` reached the unit, so the wearer has their button back now. */
  cleared: boolean
  reason?: string
}

const STOCK_REASON =
  'this pair does not report button presses, so its button still cycles the built-ins'

const COSTED_REASON =
  'the button never spends flash, and everything the playlist could move to needs an ' +
  'upload. Show it once from the phone and the button takes over'

const BUSY_REASON = 'the last press is still being shown, so this one was dropped'

const REPEAT_REASON = 'the same edge arrived twice, so it was counted once'

const UNCLEARED_REASON =
  'the link was gone before BTN_OFF went out, so the unit still has its built-in ' +
  'cycle suppressed. A 2 second hold powers it off and clears it, with no phone needed'

/**
 * Binds one connection's button to one compiled playlist.
 *
 * Per connection, never remembered across one, and it owns the unit's `BUTTON`
 * subscription for the life of that connection: the flags are a single piece of
 * device state, so a second subscriber would simply overwrite the first's. Anything
 * else wanting edges hangs off `onEdge` instead of sending its own `buttonSet`.
 */
export class PressCycle {
  private off: (() => void) | null = null

  private asked = 0

  /**
   * What the driver believes the unit is doing with its short press.
   *
   * Not derived from whether it is listening, because the two can disagree in the
   * one case that matters: a `stop()` whose write never went out has stopped
   * listening while the unit still has the cycle suppressed.
   */
  private believed: Suppressed = 'no'

  private hz: number

  private previous: { count: number; ticks: number } | null = null

  private inflight: Promise<void> | null = null

  private edgeListeners: Array<(event: PressEvent) => void> = []

  private counts = { presses: 0, advanced: 0, dropped: 0, missed: 0 }

  /** The feature bit and never the `INPUT` family bit, which licenses nothing. */
  static available(capabilities: number): boolean {
    return jgx.permits(capabilities, jgx.SUB.BUTTON)
  }

  constructor(
    private link: PressLink,
    private playlist: Advancing,
    private capabilities: number,
    private opts: PressOptions = {},
  ) {
    this.hz = opts.hz ?? jgx.TICK_STOCK_HZ
  }

  get available(): boolean {
    return PressCycle.available(this.capabilities)
  }

  /** Subscribed and listening. False on every stock unit, which is all of them. */
  get listening(): boolean {
    return this.off !== null
  }

  /** An advance is in flight, so a press now would be dropped. */
  get busy(): boolean {
    return this.inflight !== null
  }

  get flags(): number {
    return this.asked
  }

  get tickHz(): number {
    return this.hz
  }

  /**
   * Whether the firmware's own cycle is out of the way.
   *
   * `unknown` between the subscription and its ACK, and it stays there for good if
   * the ACK never comes, which is why nothing gates the advance on it: it gates only
   * whether the panel is forgotten first. It also stays there after a `stop()` that
   * could not send `BTN_OFF`, because that is exactly what nobody knows.
   */
  get suppressed(): Suppressed {
    return this.believed
  }

  /**
   * Distinct presses seen, presses that reached the panel, presses refused, and
   * presses the wire never delivered at all.
   *
   * `presses` counts an edge once, so a duplicate delivery is not in it, and
   * `advanced + dropped` is every press but the ones `show()` threw on.
   */
  get tally(): { presses: number; advanced: number; dropped: number; missed: number } {
    return { ...this.counts }
  }

  /**
   * Take the short press.
   *
   * Idempotent: a second call subscribes nothing, because two listeners on one
   * connection would advance the playlist twice for one press.
   */
  async start(): Promise<StartResult> {
    if (!this.available) return { started: false, reason: STOCK_REASON }
    if (this.off) return { started: true, flags: this.asked }

    // Listener first: the ACK is the only thing that says whether SUPPRESS_CYCLE
    // took, and it can be back before this method's own await resolves.
    this.off = this.link.onEvent((msg) => this.receive(msg))
    this.asked = flagsFor(this.opts)
    try {
      await this.link.command(jgx.buttonSet(this.asked))
    } catch (error) {
      // Nothing is subscribed at the unit, so a listener here would be waiting on a
      // subscription that never happened.
      this.off()
      this.off = null
      this.asked = 0
      return { started: false, reason: `the button subscription failed: ${error}` }
    }
    this.believed = 'unknown'
    return { started: true, flags: this.asked }
  }

  /**
   * Give the button back and stop listening.
   *
   * Unsubscribes before the write, so a press landing in between cannot advance the
   * playlist after the host asked to stop. `cleared: false` means the unit still has
   * its built-in cycle suppressed and only a power cycle will fix it, which is a
   * sentence a wearer can act on: see this module's head on the 2 s hold.
   */
  async stop(): Promise<StopResult> {
    if (!this.off) return { stopped: true, cleared: true }
    this.off()
    this.off = null
    this.asked = 0
    try {
      await this.link.command(jgx.buttonSet(jgx.BTN_OFF))
    } catch {
      // `believed` is left alone deliberately: the unit is still doing whatever it
      // was doing, and this driver has stopped being able to find out.
      return { stopped: true, cleared: false, reason: UNCLEARED_REASON }
    }
    this.believed = 'no'
    return { stopped: true, cleared: true }
  }

  /**
   * Ask what the unit currently has in force.
   *
   * For the reconnect where the app went away with suppression set: the flags live in
   * the unit's RAM and outlive the connection that set them.
   */
  async ask(): Promise<boolean> {
    if (!this.available || !this.off) return false
    await this.link.command(jgx.buttonAsk())
    return true
  }

  /** Every edge, raw, for anything else that wants presses without a second wire. */
  onEdge(fn: (event: PressEvent) => void): () => void {
    this.edgeListeners.push(fn)
    return () => {
      this.edgeListeners = this.edgeListeners.filter((l) => l !== fn)
    }
  }

  /** Resolves once any advance in flight has finished. Nothing here throws. */
  async settled(): Promise<void> {
    while (this.inflight) await this.inflight
  }

  /**
   * Run a host operation over the same cycler, with presses dropped for its duration.
   *
   * The hole this closes: `busy` only knows about advances *this* driver started, and
   * the host drives the same `Cycler` from a screen. `Cycler` holds no mutex, so a
   * press landing inside a phone-initiated save would put a second `show()` inside
   * the DATS handshake, and two uploads interleaved on one connection can commit a
   * truncated payload over content the user had already saved.
   *
   * So a host that shares a cycler with a button puts its own calls through here.
   * `blocked` covers the same ground for work this driver cannot wrap, such as an
   * upload through a different session object, and the two are complementary rather
   * than alternatives.
   *
   * The work's own rejection is returned to its caller untouched; what this holds is
   * a promise that cannot reject, so `settled()` never throws at a notification
   * handler.
   */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    while (this.inflight) await this.inflight
    const run = work()
    this.inflight = run
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.inflight = null
      })
    return run
  }

  private report(outcome: PressOutcome): void {
    try {
      this.opts.onPress?.(outcome)
    } catch {}
  }

  /** The next step this press is allowed to show, or null if a whole lap costs. */
  private target(): number | null {
    for (let k = 1; k <= this.playlist.length; k++) {
      const at = this.playlist.index + k
      if (this.playlist.costOf(at) === 'free') return at
    }
    return null
  }

  private receive(msg: jgx.Notification): void {
    // Whoever asked, the answer is about this connection's timebase, and every
    // interval this module reports is computed at it.
    if (msg.type === 'tick') {
      this.hz = msg.hz
      return
    }
    if (msg.type === 'ack' && msg.sub === jgx.SUB.BUTTON) {
      // A refusal leaves nothing in force as far as this driver is concerned, so the
      // panel gets forgotten on every press rather than trusted.
      const flags = msg.code === jgx.STATUS.OK ? (msg.detail?.[0] ?? this.asked) : 0
      this.believed = (flags & jgx.BTN.SUPPRESS_CYCLE) !== 0 ? 'yes' : 'no'
      return
    }
    if (msg.type !== 'button') return

    const event = this.eventFor(msg)
    for (const fn of this.edgeListeners) {
      try {
        fn(event)
      } catch {}
    }
    if (event.edge === jgx.EDGE.HOLD) {
      try {
        this.opts.onHold?.(event)
      } catch {}
      return
    }
    if (event.edge !== jgx.EDGE.PRESS) return

    // A repeat is the same press twice, so it is not counted as a press: `presses`
    // is distinct presses seen, and `advanced` plus `dropped` accounts for all of
    // them but the ones `show()` threw on.
    const repeat =
      this.previous !== null &&
      this.previous.count === msg.count &&
      this.previous.ticks === msg.ticks
    if (repeat) {
      this.report({ event, action: 'repeat', reason: REPEAT_REASON })
      return
    }
    this.counts.presses++
    this.counts.missed += event.missed
    this.previous = { count: msg.count, ticks: msg.ticks }

    // Before any refusal, because the firmware's own set_mode already moved the panel
    // if it was going to, whether or not this press turns into an advance.
    if (this.suppressed !== 'yes' || event.index !== jgx.INDEX_NONE) {
      this.playlist.forget()
    }

    let blocked: string | null = null
    try {
      blocked = this.opts.blocked?.() ?? null
    } catch (error) {
      blocked = `the app could not say whether a press is safe right now: ${error}`
    }
    if (blocked) {
      this.counts.dropped++
      this.report({ event, action: 'blocked', reason: blocked })
      return
    }
    if (this.inflight) {
      this.counts.dropped++
      this.report({ event, action: 'busy', reason: BUSY_REASON })
      return
    }
    const at = this.target()
    if (at === null) {
      this.counts.dropped++
      this.report({ event, action: 'costed', reason: COSTED_REASON })
      return
    }
    // Deliberately not awaited: this runs inside the notify handler. `advance` catches
    // everything, so nothing here can become an unhandled rejection, and `settled()`
    // is how a caller waits.
    this.inflight = this.advance(at, event)
  }

  private async advance(at: number, event: PressEvent): Promise<void> {
    try {
      const step = await this.playlist.show(at)
      this.counts.advanced++
      this.report({ event, action: 'advanced', step })
    } catch (error) {
      // A BudgetError lands here. It should not be reachable, since only a `free`
      // step is ever shown and a free step issues no `DATS`, but a handler that let
      // it escape would be an unhandled rejection inside a BLE callback.
      this.report({
        event,
        action: 'failed',
        reason: `showing the next item failed: ${error}`,
        error,
      })
    } finally {
      this.inflight = null
    }
  }

  private eventFor(msg: jgx.ButtonEvent): PressEvent {
    const was = this.previous
    // Missed presses are not asked for on the first press of a connection: the
    // counter restarts at power-on and `missedPresses` cannot tell a reboot from a
    // wrap. Nor on a release or a hold, which carry their own press's count.
    const counting = was !== null && msg.edge === jgx.EDGE.PRESS
    return {
      edge: msg.edge,
      count: msg.count,
      index: msg.index,
      ticks: msg.ticks,
      sinceMs: was ? jgx.tapIntervalMs(was.ticks, msg.ticks, this.hz) : null,
      missed: counting ? Math.max(0, jgx.missedPresses(was.count, msg.count)) : 0,
      hz: this.hz,
    }
  }
}
