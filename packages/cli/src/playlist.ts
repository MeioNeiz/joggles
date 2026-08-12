#!/usr/bin/env bun
/**
 * Cycle a playlist of 2 to 10 items from the keyboard.
 *
 *   bun run playlist preview [item...]        terminal only, no device
 *   bun run playlist run --yes [item...]      the hardware session
 *
 * An item is one of:
 *
 *   text:HI            static, live route, no flash ever
 *   scroll:A MESSAGE   scrolling text, packed into the reel
 *   effect:plasma      a wide effect loop, levels 2, packed into the reel
 *
 * With no items it uses a four-item default. Options: `--individual` (one type 1
 * save per scrolling press, five page erases each), `--speed=0..100`, `--gap=N`
 * between reel members, `--width=N` for effect loops.
 *
 * **`preview` writes nothing and needs nothing attached.** `run` needs
 * `.claude/locks/glasses`, and in the default `reel` mode it writes flash exactly
 * once however long the session lasts: the reel is saved on the first scrolling
 * press and every later visit is `SPEED` then `MODE 02`. Each press states its cost
 * before it happens, and the lifetime save count is printed at both ends.
 *
 * **Nothing here has run on hardware.** What the first run settles, in order of
 * what would be most surprising:
 *
 *  1. That the reel reads as separate items rather than one long string. The
 *     24-column gap between members is a guess at what looks like a break.
 *  2. That a press from a scrolling step back to a static one looks like a switch
 *     rather than a flicker: it is `SMVEW 01` then 24 paced column writes, so the
 *     panel sweeps left to right over about half a second.
 *  3. That `MODE 02` picks up the reel we just saved without a power cycle.
 */
import { content, effects, playlist as pl, viewport } from '@joggles/core'
import { open } from './glasses.js'

const args = Bun.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const cmd = positional[0] ?? 'preview'
const items = positional.slice(1)
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

const confirmed = args.includes('--yes')
const mode: pl.Mode = args.includes('--individual') ? 'individual' : 'reel'
const speed = Number(flag('speed') ?? pl.DEFAULT_SPEED)
const gap = Number(flag('gap') ?? pl.REEL_GAP)
const loopWidth = Number(flag('width') ?? effects.DEFAULT_COLUMNS)

/** Four items, three presses: two statics and a reel of the two scrollers. */
const DEFAULT_ITEMS = ['text:HI', 'text:YO', 'scroll:FUNKY GLASSES', 'effect:plasma']

const shade = ['.', '-', '+', '#']

function die(message: string): never {
  console.error(message)
  process.exit(2)
}

if (!Number.isInteger(speed) || speed < 0 || speed > content.MAX_SPEED) {
  die(`--speed must be a whole number 0 to ${content.MAX_SPEED}, got ${speed}`)
}
if (!Number.isInteger(gap) || gap < 0) die(`--gap must be a whole number, got ${gap}`)
if (!Number.isFinite(loopWidth)) die(`--width must be a number, got ${loopWidth}`)

/** One `kind:value` argument as an entry. */
function parseItem(spec: string): pl.Entry {
  const at = spec.indexOf(':')
  const kind = at < 0 ? spec : spec.slice(0, at)
  const value = at < 0 ? '' : spec.slice(at + 1)

  if (kind === 'text') {
    if (!value) die('text: needs something to draw')
    return pl.textEntry(value, value)
  }
  if (kind === 'scroll') {
    if (!value) die('scroll: needs something to draw')
    return pl.textEntry(value, value, { kind: 'scroll', dir: 0, speed })
  }
  if (kind === 'effect') {
    const make = effects.EFFECTS[value]
    if (!make) die(`unknown effect ${value}. one of: ${effects.EFFECT_NAMES.join(', ')}`)
    // levels 2 is not optional for a reel member: one grey pixel sends the save to
    // type 2, which shows 24 columns of it and forgets it at power off.
    const bitmap = make({ columns: loopWidth, levels: 2 })
    return pl.loopEntry(value, bitmap, { speed })
  }
  return die(`unknown item ${spec}. use text:, scroll: or effect:`)
}

/**
 * The panel as it would look at this content offset, dead LEDs blanked.
 *
 * `mono` for anything going out as type 1: the bitmap is flattened to level 1 by
 * then, but the panel lights a set bit at full brightness, so shading it as a dim
 * pixel would preview a dimness the device does not have.
 */
function panel(bitmap: content.Bitmap, mono = false, offset = 0): string {
  const win = viewport.windowAt(bitmap, offset)
  const lines: string[] = []
  for (let r = win.length - 1; r >= 0; r--) {
    lines.push(win[r].map((v) => (mono && v ? shade[3] : shade[v])).join(''))
  }
  return lines.join('\n')
}

function describe(plan: pl.Compiled): void {
  const { steps, entries } = plan
  const presses = steps.length === 1 ? '1 press' : `${steps.length} presses`
  console.log(`mode ${plan.mode}: ${presses}, ${entries.length} items\n`)
  steps.forEach((step, i) => {
    const cols = content.width(step.bitmap)
    const names = step.entries.map((e) => entries[e].label).join(' / ')
    const bits = [`${step.kind}`, `${cols} cols`]
    if (step.kind !== 'live') {
      const pass = effects.loopSeconds(cols)
      bits.push(`one pass ${pass.fastest.toFixed(1)}-${pass.slowest.toFixed(1)}s`)
    }
    if (step.flattened) bits.push('grey flattened to save as type 1')
    console.log(`${i + 1}. ${names}  [${bits.join(', ')}]`)
    console.log(panel(step.bitmap, step.kind !== 'live'))
    if (step.reel && step.reel.members.length > 1) {
      const reel = step.reel
      const at = reel.members
        .map((m, k) => `${entries[m].label}@${reel.offsets[k]}`)
        .join('  ')
      console.log(`   reel layout: ${at}`)
    }
    console.log('')
  })
  if (steps.length < 2) {
    // Every item scrolls, so they all share the one reel and there is nothing for a
    // second press to switch to. Worth saying out loud: the ask was cycling, and this
    // is the one shape of playlist where a keypress does not do it.
    console.log(
      'every item scrolls, so the reel is the only press and the panel cycles the\n' +
        'members itself as it passes. add a static item, or --individual for one\n' +
        'press each at five page erases per press.\n',
    )
  }
}

function build(): pl.Compiled {
  const entries = (items.length ? items : DEFAULT_ITEMS).map(parseItem)
  const problems = pl.check(entries, { mode, gap })
  if (problems.length) die(`this playlist will not run:\n  ${problems.join('\n  ')}`)
  return pl.compile(entries, { mode, gap })
}

function cmdPreview(): void {
  const plan = build()
  describe(plan)
  const saves = plan.steps.filter((s) => s.reel).length
  console.log(
    mode === 'reel'
      ? `flash cost: ${saves ? 'one save' : 'none'}, then every press is free`
      : `flash cost: five page erases on every scrolling press (${saves} of them)`,
  )
  console.log('to drive it: bun run playlist run --yes')
}

/**
 * Keys, as raw stdin chunks. Arrows arrive as three-byte escape sequences, and raw
 * mode makes ctrl-C a byte rather than a signal, so quitting has to be handled here.
 */
function keyOf(chunk: string): 'next' | 'prev' | 'quit' | null {
  if (chunk === 'q' || chunk === '\x03' || chunk === '\x04') return 'quit'
  if (chunk === 'n' || chunk === ' ' || chunk === '\r' || chunk === '\x1b[C') {
    return 'next'
  }
  if (chunk === 'p' || chunk === '\x1b[D') return 'prev'
  return null
}

async function cmdRun(): Promise<void> {
  const plan = build()
  describe(plan)
  if (!confirmed) {
    console.log('this connects to the glasses. re-run with --yes')
    console.log(
      mode === 'reel'
        ? 'in reel mode it writes flash once, on the first scrolling press'
        : 'in individual mode EVERY scrolling press is five page erases',
    )
    return
  }

  const glasses = await open()
  const before = await glasses.ledger()
  // Seeded from the ledger, so a reel still on the device from an earlier session is
  // recognised instead of being written again. Conservative: a wrong answer costs
  // one save, never the wrong content.
  const resident = pl.residentHash(before)
  const cycler = new pl.Cycler(glasses, plan, { resident })
  console.log(`\nconnected to ${glasses.name}, ${before.lifetime} lifetime saves`)
  if (resident && plan.reel?.hash === resident) {
    console.log('the reel is already on this unit: the whole session is free')
  }
  console.log('n / space next, p previous, q quit\n')

  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')

  const press = async (key: 'next' | 'prev') => {
    if (cycler.costOf(cycler.upcoming[key]) === 'save') {
      console.log('this press writes flash: five page erases')
    }
    const result = key === 'next' ? await cycler.next() : await cycler.prev()
    const what = result.step.entries
      .map((e) => plan.entries[e].label)
      .join(' / ')
    const how =
      result.save?.status === 'saved'
        ? `saved, ${result.save.reply}, ${result.save.saves} lifetime`
        : result.save?.status === 'refused'
          ? `REFUSED: ${result.save.reply}`
          : result.step.kind === 'live'
            ? `${result.writes} column writes, no flash`
            : 'already on the glasses, no flash'
    const at = `${result.index + 1}/${cycler.length}`
    console.log(`${at} ${what} [${result.step.kind}] ${how}`)
  }

  for await (const chunk of process.stdin) {
    const key = keyOf(String(chunk))
    if (!key) continue
    if (key === 'quit') break
    try {
      await press(key)
    } catch (err) {
      // A BudgetError is the guard doing its job, not a bug to retry through.
      console.log(`refused: ${(err as Error).message}`)
    }
  }

  process.stdin.setRawMode?.(false)
  process.stdin.pause()
  const after = await glasses.ledger()
  const spent = after.lifetime - before.lifetime
  console.log(`\n${spent} saves this session, ${after.lifetime} lifetime`)
  // 'keep' leaves the panel showing whatever the last press put there. It does not
  // send DATCP, so quitting costs nothing.
  await glasses.end('keep')
  console.log('disconnected, panel left as it was')
}

if (cmd === 'preview') cmdPreview()
else if (cmd === 'run') await cmdRun()
else console.log(`unknown command ${cmd}. try preview or run`)
