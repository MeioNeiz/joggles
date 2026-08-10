#!/usr/bin/env bun
/**
 * Watch a wide loop scroll, with no glasses in the room.
 *
 *   bun run effects                        list what there is
 *   bun run effects wave                   animate it through a 24-column window
 *   bun run effects plasma --columns 736   the full-length loop
 *   bun run effects stripes --hard --levels 2 --still
 *
 * **Nothing here connects to anything.** It imports no transport, so it runs on a
 * laptop with no adapter, no unit powered up and no flash budget spent, which is
 * the point: an effect is worth judging before it costs a page erase. The window
 * is `viewport`, so what scrolls past is the panel including its dead LEDs.
 *
 * The report under the animation is the part that matters more than the picture.
 * A 736-column loop with one grey pixel in it saves as DATS type 2, which the
 * device shows 24 columns of and forgets at the next power cycle, and there is
 * nothing at the device end that would tell you. `--levels 2` is the fix and the
 * report says so in as many words.
 */
import { ROWS, content, effects as fx, viewport } from '@joggles/core'
import type { Bitmap, Content, RenderOptions } from '@joggles/core'

/** One line each, because a name on its own does not say what you would see. */
const ABOUT: Record<string, string> = {
  plasma: 'summed sines cut to 4 levels: drifting contour bands',
  stripes: 'a barber pole. --hard --levels 2 is the most legible thing here',
  wave: 'one bright ribbon on black, the clearest shape on 9 rows',
  ripple: 'concentric rings from a few centres, reading as pulses going past',
  starfield: 'fixed stars at mixed brightnesses. It cannot twinkle, only drift',
}

interface Args {
  name: string
  still: boolean
  passes: number
  speed: number
  opts: Record<string, number | boolean | string>
}

function parse(argv: string[]): Args {
  const out: Args = { name: '', still: false, passes: 2, speed: 9, opts: {} }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      if (!out.name) out.name = arg
      continue
    }
    const key = arg.slice(2)
    if (key === 'still') out.still = true
    else if (key === 'hard') out.opts.soft = false
    else if (key === 'soft') out.opts.soft = true
    else if (key === 'dither') out.opts.dither = choice(argv[++i], key, ['ordered', 'none'])
    else if (key === 'passes') out.passes = num(argv[++i], key)
    else if (key === 'speed') out.speed = num(argv[++i], key)
    // Anything else is passed through as a number, so each effect's own
    // parameters work without this file knowing what they are.
    else out.opts[key] = num(argv[++i], key)
  }
  return out
}

function num(raw: string | undefined, key: string): number {
  const v = Number(raw)
  // A silently-ignored typo is how a preview ends up showing the defaults and
  // nobody notices the flag never took.
  if (raw === undefined || raw === '' || !Number.isFinite(v)) {
    throw new Error(`--${key} wants a number, got ${raw === undefined ? 'nothing' : raw}`)
  }
  return v
}

function choice(raw: string | undefined, key: string, allowed: string[]): string {
  if (raw === undefined || !allowed.includes(raw)) {
    throw new Error(`--${key} wants one of ${allowed.join(', ')}, got ${raw ?? 'nothing'}`)
  }
  return raw
}

function usage(): void {
  console.log('bun run effects <name> [options]\n')
  const width = Math.max(...fx.EFFECT_NAMES.map((n) => n.length))
  for (const name of fx.EFFECT_NAMES) {
    console.log(`  ${name.padEnd(width)}  ${ABOUT[name] ?? ''}`)
  }
  console.log(`
  --columns N    loop width, snapped down to a multiple of ${fx.TILE} (max ${fx.MAX_COLUMNS})
  --levels 2|4   2 for anything saved wider than the panel, 4 otherwise
  --dither none  quantise flat instead of shading. Sharper, more banded
  --still        print the whole strip once instead of animating
  --passes N     how many times round before it stops (default 2)
  --speed N      preview columns per second (device does ${fx.SLOWEST_SCROLL}-${fx.FASTEST_SCROLL})

Each effect also takes its own numbers, passed straight through:
  plasma --cycles 3 --rise 1 --warp 0.35
  stripes --cycles 12 --shear 0.5 --duty 0.5 --hard
  wave --cycles 4 --harmonic 8 --amplitude 0.34 --thickness 0.22
  ripple --sources 3 --wavelength 6 --falloff 18
  starfield --density 0.12 --seed 1`)
}

/**
 * What this loop would cost and whether it would survive the night.
 *
 * The two numbers people get wrong: a loop with grey in it is type 2, so it is
 * 24 columns and gone at power off, and a loop is only seamless if it closes.
 */
function report(bitmap: Bitmap, asked: number): void {
  const cols = content.width(bitmap)
  const saved: Content = {
    bitmap,
    route: 'saved',
    motion: { kind: 'scroll', dir: 0, speed: 50 },
  }
  const type = content.savedType(saved)
  const { slowest, fastest } = fx.loopSeconds(cols)
  const s = fx.seam(bitmap)

  const lit = bitmap.flat().filter((v) => v > 0).length
  let hidden = 0
  for (let off = 0; off < cols; off++) hidden += viewport.hidden(bitmap, off, { wrap: true })

  console.log(`\ncolumns    ${cols}${asked === cols ? '' : ` (asked for ${asked})`}`)
  console.log(
    `loop       ${fastest.toFixed(1)}s to ${slowest.toFixed(1)}s ` +
      `at the device's own SPEED range`,
  )
  console.log(
    `seam       ${s.seamless ? 'closes' : 'OPEN'}: wrap ${s.wrap.toFixed(2)}, ` +
      `sharpest join inside ${s.worst.toFixed(2)}, average ${s.mean.toFixed(2)}`,
  )
  console.log(`lit        ${lit} of ${cols * 9} pixels, ${(hidden / cols).toFixed(1)} per`
    + ` frame land on dead LEDs`)

  if (type === 1) {
    console.log(`saves as   DATS type 1, monochrome, survives a power cycle`)
    console.log(`           costs one budgeted save: 5 page erases. bun cli ledger`)
  } else {
    console.log(`saves as   DATS type 2, because it has grey in it`)
    console.log(
      `           the device would show ${content.MAX_IMAGE_COLUMNS} of these ` +
        `${cols} columns and lose them\n           at power off. Re-render with ` +
        `--levels 2 if this is meant to last.`,
    )
  }

  const problems = content.check(saved)
  if (problems.length) console.log(`refused    ${problems.join('; ')}`)
}

/** The whole strip, in chunks that fit the terminal. */
function still(bitmap: Bitmap): void {
  const cols = content.width(bitmap)
  const chunk = Math.max(24, Math.min(cols, (process.stdout.columns ?? 80) - 8))
  const shade = ['.', '-', '+', '#']
  for (let start = 0; start < cols; start += chunk) {
    const end = Math.min(cols, start + chunk)
    console.log(`\ncol ${start}`)
    for (let r = ROWS - 1; r >= 0; r--) {
      console.log(bitmap[r].slice(start, end).map((v) => shade[v]).join(''))
    }
  }
}

/** Scroll it past the window, redrawing in place. */
async function animate(bitmap: Bitmap, passes: number, speed: number): Promise<void> {
  const cols = content.width(bitmap)
  const interval = 1000 / Math.max(0.5, speed)
  process.stdout.write('\x1b[?25l')
  const restore = () => process.stdout.write('\x1b[?25h\n')
  process.on('SIGINT', () => {
    restore()
    process.exit(0)
  })
  try {
    for (let pass = 0; pass < passes; pass++) {
      for (let off = 0; off < cols; off++) {
        const frame = viewport.gridAt(bitmap, off, { wrap: true }).render()
        process.stdout.write(`${frame}\n`)
        await Bun.sleep(interval)
        // 9 rows written, cursor sits on the line below them.
        process.stdout.write('\x1b[9A')
      }
    }
    // Leave the last frame on screen rather than a torn one.
    process.stdout.write(`${viewport.gridAt(bitmap, 0, { wrap: true }).render()}\n`)
  } finally {
    process.stdout.write('\x1b[?25h')
  }
}

try {
  const args = parse(process.argv.slice(2))
  if (!args.name) {
    usage()
    process.exit(0)
  }
  const make = fx.EFFECTS[args.name]
  if (!make) {
    throw new Error(`no effect called ${args.name}. One of: ${fx.EFFECT_NAMES.join(', ')}`)
  }

  const asked = Number(args.opts.columns ?? fx.DEFAULT_COLUMNS)
  const bitmap = make(args.opts as RenderOptions)

  console.log(`${args.name}: ${ABOUT[args.name] ?? ''}`)
  if (args.still) still(bitmap)
  report(bitmap, asked)
  if (!args.still) {
    console.log(`\n${args.passes} passes at ${args.speed} columns/second, Ctrl-C to stop\n`)
    await animate(bitmap, args.passes, args.speed)
  }
  process.exit(0)
} catch (err) {
  console.error('error:', (err as Error).message)
  process.exit(1)
}
