#!/usr/bin/env bun
/**
 * Drive and preview the rhythm channel: 24 bars, one 16-byte write per frame.
 *
 *   bun run packages/cli/src/rhythm.ts preview [style]   terminal only, no device
 *   bun run packages/cli/src/rhythm.ts spectrum          the mapper, on synthetic bins
 *   bun run packages/cli/src/rhythm.ts send [style] --yes   the hardware session
 *
 * `send` is what graduates `packages/core/src/rhythm.ts` from *derived* to
 * *verified*, and it is the whole point of the file. **Nothing here has ever run on
 * hardware.** What it is testing, in order of what would be most surprising:
 *
 *  1. That the frame is `[0d][style][12 bytes]` and not the `[len][?][style][12]`
 *     the notes recorded. If the second byte were really a subchannel, this draws
 *     nothing or draws the wrong style.
 *  2. That leaving DIY is required. Sent from inside DIY the same frame reaches the
 *     single-column store instead, where the style byte is read as a column index:
 *     the failure is one wrong column, not silence, and `--in-diy` provokes it on
 *     purpose so the two failures can be told apart.
 *  3. That heights index the tables the way `render()` says, so the terminal
 *     preview and the panel agree bar for bar.
 *
 * **It writes no flash.** No `DATS`, no `DATCP`, no `session.save()`: every frame
 * goes to `CHAR_BULK_B` as a live write, so this costs nothing from the wear budget
 * and can be re-run freely. It still needs `.claude/locks/glasses`.
 *
 * The preparation is two commands and it is not optional. `SMVEW 01` stops the
 * animation engine and clears the live buffer; `SMVEW 00` then leaves DIY with that
 * buffer empty, which lands the unit in mode 1. Mode 1 is the mode to be in: its
 * per-tick handler re-pushes `0x200036ac`, the same live buffer the rhythm handler
 * writes into, so the engine refreshes our own bars rather than fighting them. Leave
 * DIY with pixels still lit and the unit picks mode 26 instead, which repaints from
 * the saved RAM buffer eight times a second and would erase the bars.
 */
import { protocol as p, rhythm } from '@joggles/core'
import { open, sleep } from './glasses.js'

const args = Bun.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const cmd = positional[0] ?? 'preview'
const confirmed = args.includes('--yes')
const inDiy = args.includes('--in-diy')
const styleArg = positional[1] ?? '0'
if (!['0', '1', '2', '3'].includes(styleArg)) {
  console.error(`style must be 0-3, got ${styleArg}`)
  process.exit(2)
}
const style = Number(styleArg) as rhythm.Style
const seconds = Number(args.find((a) => a.startsWith('--seconds='))?.slice(10) ?? 20)
const fps = Number(args.find((a) => a.startsWith('--fps='))?.slice(6) ?? 25)

const shade = ['.', '-', '+', '#']

function draw(heights: number[], s: rhythm.Style): string {
  const bitmap = rhythm.render(heights, s)
  const lines: string[] = []
  for (let r = bitmap.length - 1; r >= 0; r--) {
    lines.push(bitmap[r].map((v) => shade[v]).join(''))
  }
  lines.push(heights.map((h) => h.toString(36)).join(' '))
  return lines.join('\n')
}

/**
 * A travelling bulge, which is the pattern that makes a wrong nibble order obvious:
 * swap the nibbles and it moves in pairs of two rather than smoothly.
 */
function wave(bars: number, t: number): number[] {
  return Array.from({ length: bars }, (_, i) => {
    const phase = (i / bars) * Math.PI * 2 - t
    return Math.round(((Math.sin(phase) + 1) / 2) ** 2 * rhythm.MAX_HEIGHT)
  })
}

/**
 * Synthetic spectrum: a bass note, a mid pad and a hat, so bands differ.
 *
 * Scaled to sit inside the mapper's default -60 to -12 dB window. Full-scale
 * magnitudes are 0 dB and would pin every bar at 9, which looks like a working
 * demo right up until the moment it has to show that anything is being mapped.
 */
function spectrum(bins: number, t: number): number[] {
  const sampleRate = 44100
  return Array.from({ length: bins }, (_, i) => {
    const hz = ((i + 0.5) / bins) * (sampleRate / 2)
    const peak = (centre: number, q: number, gain: number) =>
      gain / (1 + ((hz - centre) / q) ** 2)
    return (
      peak(80, 30, 0.05 * (0.5 + 0.5 * Math.sin(t * 2))) +
      peak(900, 400, 0.02) +
      peak(6500, 2500, 0.015 * Math.max(0, Math.sin(t * 6)))
    )
  })
}

function cmdPreview(): void {
  const bars = rhythm.barCount(style)
  console.log(`style ${style}: ${bars} bars, ${JSON.stringify(rhythm.spec(style))}\n`)
  for (const t of [0, 1.2, 2.4]) {
    const heights = wave(bars, t)
    console.log(draw(heights, style))
    const frame = rhythm.encode(heights, style)
    console.log(
      `wire: ${[...frame].map((b) => b.toString(16).padStart(2, '0')).join(' ')}\n`,
    )
  }
}

function cmdSpectrum(): void {
  console.log('synthetic spectrum -> 24 heights, with and without smoothing\n')
  let smoothed = new Array(24).fill(0)
  for (let f = 0; f < 6; f++) {
    const t = f * 0.4
    const raw = rhythm.fromSpectrum(spectrum(512, t), { sampleRate: 44100 })
    smoothed = rhythm.smooth(smoothed, raw, { fall: 0.4 })
    console.log(`t=${t.toFixed(1)}  raw ${raw.join('')}`)
    console.log(`         smoothed ${smoothed.join('')}`)
  }
  console.log(`\n${draw(smoothed, 0)}`)
}

async function cmdSend(): Promise<void> {
  if (!confirmed) {
    console.log('this connects to the glasses. re-run with --yes')
    console.log('it writes no flash: live frames on 960b only')
    return
  }
  const bars = rhythm.barCount(style)
  const glasses = await open()
  console.log(`connected to ${glasses.name}, style ${style}, ${bars} bars`)

  if (inDiy) {
    // The deliberate wrong answer, so a blank panel and a misrouted frame are
    // distinguishable. In DIY the frame is read as [index][3 bytes of pixels].
    console.log('staying in DIY on purpose: expect ONE wrong column, not bars')
    await glasses.command(p.enterDIY())
  } else {
    await glasses.command(p.enterDIY())
    await glasses.command(p.exitDIY())
    console.log('left DIY with an empty live buffer; the unit should be in mode 1')
    console.log('a dark panel can also be the power gate: this channel is ignored')
    console.log('unless the unit was switched on at its button (flag 0x2000306d)')
  }

  const frames = Math.max(1, Math.round(seconds * fps))
  // commandRaw already paces itself, so only the remainder is ours to wait out.
  const gap = Math.max(0, Math.round(1000 / fps) - 18)
  console.log(`sending ${frames} frames at ~${fps}/s for ${seconds}s\n`)
  console.log(draw(wave(bars, 0), style))
  console.log('\nwatch the panel. bars should sweep smoothly, not in pairs.')

  let smoothed = new Array(bars).fill(0)
  for (let f = 0; f < frames; f++) {
    const t = (f / fps) * 2
    const raw = rhythm.toBars(
      rhythm.fromSpectrum(spectrum(256, t), { sampleRate: 44100 }),
      bars,
    )
    smoothed = rhythm.smooth(smoothed, raw, { fall: 0.4 })
    await glasses.commandRaw(rhythm.encode(smoothed, style))
    if (gap > 0) await sleep(gap)
  }

  // Blank the bars through the same channel that drew them, so the panel is not
  // left lit for whoever picks up the glasses next.
  await glasses.commandRaw(rhythm.encode(new Array(bars).fill(0), style))
  await glasses.command(p.clear())
  await glasses.end('keep')
  console.log('\ndone, panel cleared')
}

/**
 * One static staircase, left on the panel and not cleared.
 *
 * The verification a moving demo cannot give: heights 0 to 9 in order, so a person
 * arriving at any point afterwards can count the rows in each bar against the
 * printed preview. Reading it settles the table indexing, the nibble order and the
 * left-to-right direction in one look. Whoever reads it should run `bun cli off`.
 */
async function cmdHold(): Promise<void> {
  if (!confirmed) {
    console.log('this leaves a pattern lit on the glasses. re-run with --yes')
    return
  }
  const bars = rhythm.barCount(style)
  const heights = Array.from({ length: bars }, (_, i) =>
    Math.min(rhythm.MAX_HEIGHT, Math.round((i / (bars - 1)) * rhythm.MAX_HEIGHT)),
  )
  const glasses = await open()
  console.log(`connected to ${glasses.name}`)
  await glasses.command(p.enterDIY())
  await glasses.command(p.exitDIY())
  await glasses.commandRaw(rhythm.encode(heights, style))
  await glasses.end('keep')
  console.log(`\n${draw(heights, style)}`)
  console.log('\nleft on the panel. it should be a staircase rising to the right.')
  console.log('clear it with: bun cli off')
}

if (cmd === 'preview') cmdPreview()
else if (cmd === 'spectrum') cmdSpectrum()
else if (cmd === 'send') await cmdSend()
else if (cmd === 'hold') await cmdHold()
else console.log(`unknown command ${cmd}`)
