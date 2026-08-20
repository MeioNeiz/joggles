/**
 * A playlist of 2 to 10 items, cycled one at a time, at no flash cost per press.
 *
 * Asked for as "select x images/text/animations where x could be between 2-10 and
 * set that as the ones I cycle between". **Stock firmware cannot do this from the
 * button**: a short press cycles the 21 built-ins, and the saved store holds exactly
 * one user item per type with no slot index. So this is the host-side shape of that
 * feature, built so the firmware version replaces its delivery and not its model.
 * The verdict, the ranked patches and the firmware mapping: `notes/playlist.md`.
 *
 * The whole design exists to keep cycling off the flash:
 *
 *     static, <= 24 columns   live route: SMVEW 01 then paced columns   no flash
 *     scrolling               ONE type 1 reel, members concatenated     one save
 *
 * The reel is what makes it free. Showing content the device already holds is
 * `SPEED` then `MODE 02` and nothing else, so in `reel` mode a press writes flash
 * only when the reel itself changed. `individual` mode gives each scroller its own
 * type 1 save, five page erases per press, and is opt-in for that reason.
 *
 * **"A press" here means a phone tap on stock, and the unit's own button on a crew
 * unit.** The half that makes the physical button drive this is `press.ts`, over the
 * `BUTTON` sub-command: it subscribes, takes the short press off the firmware's
 * built-in cycle, and calls `show()` on steps it has priced `free`, so the button
 * cannot spend an erase. Nothing about this module changes for it, which is what
 * `Driver` being four methods was for. It added `forget()` and nothing else.
 *
 * **Residency is still this module's own bookkeeping, and the reason has changed.**
 * `budget.allow()` used to skip a payload equal to the last acknowledged save of *any*
 * type, so one type 2 save from a drawing screen between two visits to the same reel
 * made that reel look new and cost five real erases putting back what was already
 * there. Track 32 fixed that at the source: `budget.SaveRecord` now carries the DATS
 * type and the guard compares against the last save to the *same store*, which is what
 * `notes/playlist.md` recommended and this module worked around. What `Cycler` keeps
 * is the cheaper half - it never calls `save()` at all when its own hash matches, so
 * a revisit builds no payload, spends no three-second interval and cannot raise a
 * `BudgetError` - plus a cost it can state **before** the press, which a guard
 * answering inside `save()` cannot. It believes a reel is there only once `DATCP` came
 * back `DATCPOK` (`SaveResult.committed`), and `residentHash()` seeds that belief
 * across sessions off the same flag in the ledger.
 *
 * **Nothing here has run on hardware.** The wire it produces is `session.ts`'s,
 * which has, but no press sequence has been watched on a panel, so the reel's
 * member separation and the live/`MODE` transitions are *derived*.
 *
 * Do not run a `Cycler` and a `LiveSender` over one session: they keep separate
 * ideas of what the panel was last told, exactly as `show()` and the sender do.
 */
import * as budget from './budget.js'
import * as content from './content.js'
import * as dats from './dats.js'
import { COLS, Grid, ROWS } from './display.js'
import * as p from './protocol.js'
import type { SaveOpts, SaveResult } from './session.js'
import * as viewport from './viewport.js'

/** Two is the fewest that can be cycled; ten is what was asked for. */
export const MIN_ENTRIES = 2
export const MAX_ENTRIES = 10

/**
 * Blank columns left after a reel member by default.
 *
 * A screen's width, so a member has left the panel before the next one arrives and
 * two texts cannot read as one string. These columns are ours, inside one bitmap, and
 * are a separate question from `dats.TYPE1_BRACKET`, which is the device's.
 *
 * **The last member gets one too, so the wrap is wider than the joins**: what a
 * viewer sees between two members is ours alone, and what they see between the last
 * and the first is ours plus the device's bracket. Deliberate, and the opposite of
 * `content.SCROLL_GAP`'s reasoning, because the two are betting on different things:
 * whether that bracket is there at all in the session that saved the reel is
 * *unverified*, and one 32-column block looped with no dark pass at all in its own
 * session. Dropping our trailing gap on the strength of that would risk the last
 * member running straight into the first, which is the one failure this constant
 * exists to prevent. `Entry.gap` on the final member is the way to the other
 * behaviour, and the first hardware run decides which is right.
 *
 * *Corrected: this said the bracket's 48 columns "only join the loop after a power
 * cycle". The magnitude was wrong and the condition was never established.* The record
 * `DATCP` writes brackets the content with 24 blank columns each side, 48 in all, and a
 * scroll resuming at the content walks only the trailing set, so **one screen width of
 * blank joins the loop, not two** (measured by eye 2026-08-11, against a payload
 * verified off the app's wire log). Whether that 24 is unconditional or only follows a
 * restore from flash is *unverified*: one 32-column block looped with no dark pass at
 * all in the session that saved it, which nothing reconciles yet.
 * `research/loop-gap-2026-08-10.md`.
 */
export const REEL_GAP = COLS

/** Middle of the `SPEED` ladder, ~8 columns/second. */
export const DEFAULT_SPEED = 50

/** One thing the playlist can show. `bitmap` is `ROWS` rows, as everywhere here. */
export interface Entry {
  /** What a UI calls this item. Never sent to the device. */
  label: string
  bitmap: content.Bitmap
  motion: content.Motion
  /**
   * Blank columns to leave after this item when it is packed into a reel.
   *
   * `REEL_GAP` unless set. `loopEntry` sets 0: a wide effect loop is built to close
   * on itself and a gap turns that seam into a dark pass. Inside a reel that means
   * the loop runs straight into the next member, which is the author's choice to
   * make and not something this module can guess.
   */
  gap?: number
}

export type Mode = 'reel' | 'individual'

export interface CompileOptions {
  /** `reel` packs every scroller into one save. Default, and the free one. */
  mode?: Mode
  /** Default gap after a member, for entries that do not carry their own. */
  gap?: number
}

/** A type 1 payload, and the ledger hash that says whether it is already there. */
export interface Reel {
  /** Flattened to monochrome, because type 1 is one bit per pixel. */
  bitmap: content.Bitmap
  /**
   * `budget.fingerprint` of exactly the bytes `session.save()` will send, so it
   * compares equal to what the ledger records. Recomputing it any other way is how
   * a residency check silently stops matching.
   */
  hash: string
  columns: number
  /** Entry indices in the order packed, and the column each one starts at. */
  members: number[]
  offsets: number[]
  /** Grey was thrown away to fit type 1. Say so in the UI. */
  flattened: boolean
  /** The one `SPEED`/`MODE` the whole reel scrolls under. */
  motion: content.Motion
}

export type StepKind = 'live' | 'reel' | 'saved'

/** One press. In `reel` mode the scrollers share a step, so steps <= entries. */
export interface Step {
  kind: StepKind
  label: string
  /** Entry indices this step shows. One, except a `reel` step. */
  entries: number[]
  /** What the panel will show: 24 columns for `live`, the saved bitmap otherwise. */
  bitmap: content.Bitmap
  motion: content.Motion
  flattened: boolean
  /** The type 1 content this step needs resident. Null for a `live` step. */
  reel: Reel | null
}

export interface Compiled {
  mode: Mode
  steps: Step[]
  /**
   * The one shared reel. Null in `individual` mode, where each scrolling step
   * carries its own, and null when nothing in the playlist scrolls.
   */
  reel: Reel | null
  entries: Entry[]
}

export const isScroll = (entry: Entry): boolean => entry.motion.kind === 'scroll'

/** Statics go live because that costs nothing; scrolling is a saved-route mode. */
export const routeFor = (motion: content.Motion): content.Route =>
  motion.kind === 'scroll' ? 'saved' : 'live'

const speedOf = (motion: content.Motion): number =>
  motion.kind === 'scroll' ? motion.speed : 0

const dirOf = (motion: content.Motion): 0 | 1 =>
  motion.kind === 'scroll' ? motion.dir : 0

/**
 * Text as a playlist item.
 *
 * **`gap: 0` into `content.text`, always.** Gaps are this module's job, so the one
 * `content.text` would apply is named here rather than inherited.
 *
 * *Corrected: this said `content.text` defaults to a screen's width for scrolling
 * content, so leaving it alone would give a scroller two gaps. Its default is
 * `content.SCROLL_GAP`, which is 0 exactly because the device supplies a screen's
 * width itself, so passing 0 changes nothing today and is kept because that default
 * answers a different question and is track 16's to move.*
 *
 * What `content.text` does add unconditionally is padding to a full panel width
 * (whether `MODE` handles content narrower than 24 is verify item 5, unrun), so a
 * scroller shorter than the panel carries trailing blank inside its own bitmap: a
 * 3-letter word is a 24-column member, and `Reel.columns` and `Reel.offsets` count
 * that padding. It shows up as a wider gap than asked for, never a narrower one.
 */
export function textEntry(
  label: string,
  body: string,
  motion: content.Motion = { kind: 'static' },
  opts: { spacing?: number; level?: number; gap?: number } = {},
): Entry {
  const { spacing, level, gap } = opts
  const drawn = content.text(body, motion, {
    spacing,
    level,
    gap: 0,
    route: routeFor(motion),
  })
  return { label, bitmap: drawn.bitmap, motion, ...(gap === undefined ? {} : { gap }) }
}

/** A 24-column drawing or image, shown live so it costs nothing and keeps its grey. */
export function imageEntry(label: string, source: content.Bitmap | Grid): Entry {
  return {
    label,
    bitmap: content.drawing(source, 'live').bitmap,
    motion: { kind: 'static' },
  }
}

/**
 * A wide effect loop as a scrolling item.
 *
 * `gap` is 0 unless asked for: `effects` widths snap to the dither tile so the loop
 * closes on itself, and a separator would undo the one property it was built for.
 */
export function loopEntry(
  label: string,
  bitmap: content.Bitmap,
  opts: { speed?: number; dir?: 0 | 1; gap?: number } = {},
): Entry {
  const { speed = DEFAULT_SPEED, dir = 0, gap = 0 } = opts
  return {
    label,
    bitmap: content.normalise(bitmap),
    motion: { kind: 'scroll', dir, speed },
    gap,
  }
}

const gapOf = (entry: Entry, fallback: number): number => entry.gap ?? fallback

/** Columns a reel of these members occupies, gaps included. */
export function reelColumns(
  entries: Entry[],
  members: number[],
  gap = REEL_GAP,
): number {
  return members.reduce(
    (n, i) => n + content.width(entries[i].bitmap) + gapOf(entries[i], gap),
    0,
  )
}

/**
 * Everything wrong with a playlist, as sentences. Empty means it compiles.
 *
 * A list rather than a throw, for the same reason `content.check` is one: a screen
 * wants to grey out a button and say why, and more than one item can be wrong.
 */
export function check(entries: Entry[], opts: CompileOptions = {}): string[] {
  const { mode = 'reel', gap = REEL_GAP } = opts
  const out: string[] = []

  // Named first because every rule below is per mode, so an unrecognised one would
  // otherwise skip the reel's ceiling and its one-SPEED rule and then compile into a
  // step with no reel behind it. A `Mode` off persisted JSON is not a typed value.
  if (mode !== 'reel' && mode !== 'individual') {
    out.push(`mode must be 'reel' or 'individual', got ${JSON.stringify(mode)}`)
  }
  if (entries.length < MIN_ENTRIES || entries.length > MAX_ENTRIES) {
    out.push(
      `a playlist holds ${MIN_ENTRIES} to ${MAX_ENTRIES} items, got ${entries.length}`,
    )
  }
  if (!Number.isInteger(gap) || gap < 0) {
    out.push(`gap must be a whole number of columns, got ${gap}`)
  }

  entries.forEach((entry, i) => {
    const where = `item ${i + 1} (${entry.label || 'unnamed'})`
    const own = entry.gap
    if (own !== undefined && (!Number.isInteger(own) || own < 0)) {
      out.push(`${where}: gap must be a whole number of columns, got ${own}`)
    }
    // Type 1 forced: a scroller is always saved as text, whatever grey it carries,
    // because type 2 dies at power off and shows 24 of its columns.
    const problems = content.check(
      { bitmap: entry.bitmap, route: routeFor(entry.motion), motion: entry.motion },
      { type: dats.TYPE_TEXT },
    )
    for (const problem of problems) out.push(`${where}: ${problem}`)
  })

  const members = entries.flatMap((e, i) => (isScroll(e) ? [i] : []))
  if (mode === 'reel' && members.length > 1) {
    // One saved bitmap gets one SPEED and one MODE, so members that disagree would
    // have all but the first silently ignored.
    const first = entries[members[0]].motion
    const odd = members.filter(
      (i) =>
        speedOf(entries[i].motion) !== speedOf(first) ||
        dirOf(entries[i].motion) !== dirOf(first),
    )
    for (const i of odd) {
      out.push(
        `item ${i + 1} (${entries[i].label || 'unnamed'}): a reel scrolls under one ` +
          `SPEED and one MODE, and item ${members[0] + 1} set ${speedOf(first)}/` +
          `dir ${dirOf(first)}. Use mode 'individual' to give it its own`,
      )
    }
  }
  // The gap is saved along with the content, so it counts against the ceiling in
  // both modes. `content.check` above only sees the member's own width.
  if (mode === 'reel' && members.length) {
    const total = reelColumns(entries, members, gap)
    if (total > content.MAX_SAVED_COLUMNS) {
      out.push(
        `the reel is ${total} columns: ${members.length} scrolling items and their ` +
          `gaps. Type 1 holds ${content.MAX_SAVED_COLUMNS}`,
      )
    }
  }
  if (mode === 'individual') {
    for (const i of members) {
      const total = reelColumns(entries, [i], gap)
      if (total > content.MAX_SAVED_COLUMNS) {
        out.push(
          `item ${i + 1} (${entries[i].label || 'unnamed'}): ${total} columns once its ` +
            `gap is saved with it. Type 1 holds ${content.MAX_SAVED_COLUMNS}`,
        )
      }
    }
  }
  return out
}

function reelOf(entries: Entry[], members: number[], gap: number): Reel {
  const parts: content.Bitmap[] = []
  const offsets: number[] = []
  let at = 0
  for (const i of members) {
    const entry = entries[i]
    const pad = gapOf(entry, gap)
    offsets.push(at)
    parts.push(entry.bitmap)
    if (pad > 0) parts.push(content.blank(pad))
    at += content.width(entry.bitmap) + pad
  }
  const joined = Array.from({ length: ROWS }, (_, r) =>
    parts.flatMap((part) => [...part[r]]),
  )
  const bitmap = content.flatten(joined)
  return {
    bitmap,
    hash: budget.fingerprint(dats.encodeBitmap(bitmap), dats.TYPE_TEXT),
    columns: at,
    members: [...members],
    offsets,
    flattened: content.hasGrey(joined),
    motion: entries[members[0]].motion,
  }
}

/**
 * Turn entries into the presses that show them.
 *
 * Throws on anything `check` reports, because a `Cycler` over content the device
 * will refuse is worse than a screen that cannot offer the button.
 *
 * **Steps are not one per entry in `reel` mode**, which is the one place this
 * differs from what `notes/playlist.md` first sketched: every scroller shares the
 * one reel, so giving each its own press would make consecutive presses identical
 * on the wire and on the panel. They collapse into a single step, positioned where
 * the first scroller sat. `individual` mode is where one press means one scroller,
 * and it pays five page erases for it.
 */
export function compile(entries: Entry[], opts: CompileOptions = {}): Compiled {
  const problems = check(entries, opts)
  if (problems.length) throw new Error(problems.join('; '))

  const mode = opts.mode ?? 'reel'
  const gap = opts.gap ?? REEL_GAP
  const members = entries.flatMap((e, i) => (isScroll(e) ? [i] : []))
  const reel = mode === 'reel' && members.length ? reelOf(entries, members, gap) : null

  const steps: Step[] = []
  let placed = false
  entries.forEach((entry, i) => {
    if (!isScroll(entry)) {
      steps.push({
        kind: 'live',
        label: entry.label,
        entries: [i],
        bitmap: entry.bitmap,
        motion: entry.motion,
        flattened: false,
        reel: null,
      })
      return
    }
    if (mode === 'individual') {
      const own = reelOf(entries, [i], gap)
      steps.push({
        kind: 'saved',
        label: entry.label,
        entries: [i],
        bitmap: own.bitmap,
        motion: own.motion,
        flattened: own.flattened,
        reel: own,
      })
      return
    }
    if (placed) return
    placed = true
    steps.push({
      kind: 'reel',
      label: members.map((m) => entries[m].label).join(' / '),
      entries: [...members],
      bitmap: reel!.bitmap,
      motion: reel!.motion,
      flattened: reel!.flattened,
      reel,
    })
  })
  return { mode, steps, reel, entries }
}

/**
 * The slice of `Glasses` a `Cycler` drives, so tests need no transport and no
 * screen has to hand one the whole session.
 */
export interface Driver {
  begin(): Promise<void>
  show(grid: Grid, full?: boolean): Promise<number>
  command(frame: Uint8Array): Promise<void>
  save(bitmap: content.Bitmap, opts?: SaveOpts): Promise<SaveResult>
}

/** What the panel was last told. `mode` means a `MODE` discarded the live buffer. */
export type Panel = 'live' | 'mode' | 'unknown'

export interface CyclerOptions {
  /**
   * The type 1 hash the device is believed to already hold. `residentHash()` reads
   * one off a ledger; absent means "assume nothing", which costs one save.
   */
  resident?: string | null
  /** Passed straight to `save()`. `blockSleep` is the one worth setting. */
  save?: SaveOpts
}

/** Whether a press writes flash. The only distinction the UI has to state. */
export type Cost = 'free' | 'save'

export interface StepResult {
  index: number
  step: Step
  /** What it actually cost, which is `free` whenever no `DATCP` went out. */
  cost: Cost
  /** Present only when a save was attempted. `skipped` means it was already there. */
  save?: SaveResult
  /**
   * Whether the panel was actually switched to this step.
   *
   * False whenever the commit was not acknowledged, because no `MODE` goes out then
   * and the device keeps displaying whatever it was displaying. `cost` cannot answer
   * this: a rejected commit costs a full save and shows nothing.
   */
  showing: boolean
  /** Column writes sent, for a live step. */
  writes: number
}

/**
 * Walks a compiled playlist, one press at a time.
 *
 * The three transitions, and why each is what it is:
 *
 *     live -> live      a bare show(), which sends only the changed columns
 *     * -> live         begin() first: a MODE discarded the live buffer, and the
 *                       session's idea of what is lit is stale
 *     * -> scrolling    save only if not resident, then SPEED then MODE, that order
 *
 * A `BudgetError` from `save()` propagates and the index does not move. Nothing
 * here retries: a retry loop round a flash write is the runaway the budget exists
 * to stop.
 *
 * **`MODE` goes out only when the device is holding the reel**, which until
 * review-32 it did not. `session.save()` answers `saved` for any `DATCP` it managed
 * to send, because the erases happen at the device's end whatever came back; this
 * class withheld the `MODE` on `refused` alone, so a commit answered `ERROR` or
 * `TIMEOUT` switched the panel to a store the same `DATS` had just zeroed and
 * reported a normal press. That is the identical defect track 32 fixed in
 * `app/src/deliver.ts`, in the file the same track owned, and the two now read the
 * same flag: `save.status === 'skipped' || save.committed`. `StepResult.showing`
 * carries the answer out, because `cost` cannot: a rejected commit costs a full save
 * and shows nothing.
 *
 * **One press at a time, and this holds no mutex**, exactly like `Glasses`. A
 * second press landing inside the DATS handshake is the defect review-1 found on
 * the phone, so a screen gates on `busy` and a CLI awaits the press it started.
 */
export class Cycler {
  private idx = -1

  private held: string | null

  private state: Panel = 'unknown'

  constructor(
    private driver: Driver,
    readonly plan: Compiled,
    private opts: CyclerOptions = {},
  ) {
    this.held = opts.resident ?? null
  }

  get length(): number {
    return this.plan.steps.length
  }

  /** Where the cycler is. -1 until something has been shown. */
  get index(): number {
    return this.idx
  }

  get current(): Step | null {
    return this.plan.steps[this.idx] ?? null
  }

  /** The type 1 hash believed resident. Null means "unknown", so the next save runs. */
  get resident(): string | null {
    return this.held
  }

  get panel(): Panel {
    return this.state
  }

  private step(i: number): Step {
    const step = this.plan.steps[i]
    if (!step) throw new Error(`no step ${i}: the playlist has ${this.length}`)
    return step
  }

  private wrap(i: number): number {
    const n = this.length
    return ((i % n) + n) % n
  }

  /**
   * Something else took the panel, so forget what it was last told.
   *
   * The next `live` step then calls `begin()` and redraws in full instead of
   * diffing against a buffer the device no longer holds, which is
   * `app/src/panel-session.ts`'s `dropped()` rule in the one class that keeps the
   * same belief here. Call it after anything that takes the panel from underneath a
   * cycler: a built-in (`MODE`, `ANIM`, `IMAG`) shown from a screen, a spray, or the
   * firmware's own short-press `set_mode` when `jgx.BTN.SUPPRESS_CYCLE` is not known
   * to be in force (`press.ts`, which is this method's caller).
   *
   * **Residency is deliberately untouched.** A built-in takes the live buffer and the
   * panel, not the type 1 store, and `MODE` is what switches back to it. Clearing the
   * held hash here would make the next reel visit re-save content the device is still
   * holding, which is the exact five-erase mistake this class was written to avoid.
   */
  forget(): void {
    this.state = 'unknown'
  }

  /**
   * What showing step `i` will cost, before anything is sent.
   *
   * A prediction, and it errs towards `save`: the budget may still skip a payload
   * this cycler has no record of, in which case the press turns out free.
   */
  costOf(i: number): Cost {
    const step = this.step(this.wrap(i))
    return step.reel && step.reel.hash !== this.held ? 'save' : 'free'
  }

  /** Every step's cost as it stands, for a UI that lists them. */
  costs(): Cost[] {
    return this.plan.steps.map((_, i) => this.costOf(i))
  }

  /**
   * Where `next()` and `prev()` would land.
   *
   * Here rather than in every caller so that "say what this press costs before it
   * happens" does not mean re-deriving the wrap rule, and getting it wrong at the
   * ends, where the cost is exactly what a user cares about.
   */
  get upcoming(): { next: number; prev: number } {
    return {
      next: this.wrap(this.idx + 1),
      prev: this.wrap(this.idx < 0 ? -1 : this.idx - 1),
    }
  }

  async show(i: number): Promise<StepResult> {
    const at = this.wrap(i)
    const step = this.step(at)

    if (step.kind === 'live') {
      // Anything that sent MODE threw the live buffer away, and `Glasses.last`
      // still describes columns the device no longer holds, so a diff against it
      // would leave the panel half drawn. begin() clears both.
      if (this.state !== 'live') {
        await this.driver.begin()
        this.state = 'live'
      }
      const writes = await this.driver.show(viewport.gridAt(step.bitmap))
      this.idx = at
      return { index: at, step, cost: 'free', showing: true, writes }
    }

    const reel = step.reel!
    let save: SaveResult | undefined
    if (reel.hash !== this.held) {
      // Type 1 last, so it cannot be overridden: a reel saved as type 2 would show
      // 24 of its columns and be gone at the next power off.
      save = await this.driver.save(reel.bitmap, {
        ...this.opts.save,
        type: dats.TYPE_TEXT,
      })
      if (save.status === 'refused') {
        // DATCP never went out, so no erases were spent and the store still holds
        // whatever it held. What that was is no longer knowable from here.
        this.held = null
        this.idx = at
        return { index: at, step, cost: 'free', save, showing: false, writes: 0 }
      }
      // `saved` means DATCP went out, not that the device liked it: a dropped block
      // or a silent link gives `ERROR` or `TIMEOUT` and the ledger records ok:false.
      // The erases were spent and DATS zeroed the store, so nothing is resident, and
      // believing otherwise would leave every later visit free and blank with no save
      // left to repair it. `committed` is that flag, and `residentHash` reads the
      // same one back off the ledger.
      const stored = save.status === 'skipped' || save.committed
      this.held = stored ? reel.hash : null
      if (!stored) {
        // The same rule `deliver()` follows: no `MODE` on a commit the device did not
        // acknowledge. `DATS` zeroed the store and the erases were spent, so a `MODE`
        // here switches the panel away from whatever the wearer was looking at and on
        // to a store that is now empty. `cost` is still `save`, because it was one.
        this.idx = at
        return { index: at, step, cost: 'save', save, showing: false, writes: 0 }
      }
    }
    // SPEED before MODE, the order the vendor app's own log shows.
    await this.driver.command(p.speed(speedOf(step.motion)))
    const args = content.modeArgs(step.motion)
    await this.driver.command(p.mode(args.kind, args.dir))
    this.state = 'mode'
    this.idx = at
    return {
      index: at,
      step,
      cost: save?.status === 'saved' ? 'save' : 'free',
      save,
      showing: true,
      writes: 0,
    }
  }

  next(): Promise<StepResult> {
    return this.show(this.idx + 1)
  }

  prev(): Promise<StepResult> {
    // Nothing shown yet is "before the first step", so going back from there lands
    // on the last one rather than one short of it.
    return this.show(this.idx < 0 ? -1 : this.idx - 1)
  }
}

/**
 * What type 1 content a device is probably still holding, from its ledger.
 *
 * The rule moved into `budget.storedHash()` when `SaveRecord` learned which store it
 * hit, and this is that rule over the flash store. What changed, and what did not:
 *
 *  - **A type 2 save no longer hides the reel.** It writes no flash (*verified*), so
 *    an acknowledged one is looked through to the type 1 record beneath it. This used
 *    to read as "unknown" and cost a redundant five-erase save per drawing.
 *  - **An unacknowledged commit still ends the answer**, review-18's rule, unchanged:
 *    the erases were spent and the store holds nobody knows what.
 *  - **A record with no type reads as unknown**, never as type 1, and the ledgers
 *    that already exist are full of them. So this answers null on a fresh install
 *    reading an old ledger, and the first save of the session is a real one.
 *
 * Still conservative in the safe direction: the worst a null costs is one redundant
 * save, where a wrong hash shows the wrong content with no way to notice.
 */
export function residentHash(ledger: budget.DeviceLedger): string | null {
  return budget.storedHash(ledger, dats.TYPE_TEXT)
}
