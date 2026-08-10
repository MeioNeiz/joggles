/**
 * "Put my text on every new pair of glasses that comes into range."
 *
 * The fun one. It scans without stopping and, for each unit it has never lit
 * before, connects, writes the text to the live DIY buffer and moves on to the
 * next. The panel is a separate module that holds its last frame (the mental model
 * in CLAUDE.md), so the message stays up after we disconnect. Nothing is saved:
 * this is the live buffer, not DATS, so no flash cycle is spent on a stranger's
 * unit and the wear ledger is left alone. What that costs us is persistence across
 * a power cycle - fine for a walk-by, and the honest price of not branding someone
 * else's flash.
 *
 * "haven't already connected to" is the shared connections record (see
 * `connections.ts`) plus the flash ledger: any unit this host has ever driven or
 * saved to is left alone. A unit connected here is added to that record, so it is
 * lit once and then left alone across runs. `all` lifts the safety and lights every
 * unit in range whatever its history.
 *
 * CoreBluetooth dislikes scanning and connecting at once (the reason
 * NobleScanner.first stops before it connects), so this alternates: open a scan
 * window to gather new adverts, stop, drain them one connection at a time, repeat.
 */
import {
  Glasses,
  type Discovered,
  Grid,
  display,
  font,
  protocol as p,
  sleep,
} from '@joggles/core'
import { connectedNames, recordConnection } from './connections.js'
import { allDevices } from './ledger.js'
import { NobleScanner } from './noble.js'

/** Every unit we must leave alone: connected to before, or saved to before. */
async function offLimits(): Promise<Set<string>> {
  const names = await connectedNames()
  for (const d of await allDevices()) names.add(d.device)
  return names
}

/** Lay a text bitmap into a 24-column Grid, `offset` columns of it scrolled off left. */
export function frameFor(bitmap: number[][], offset: number): Grid {
  const g = new Grid()
  const w = bitmap[0]?.length ?? 0
  for (let r = 0; r < font.HEIGHT; r++) {
    for (let c = 0; c < display.COLS; c++) {
      const src = c + offset
      if (src >= 0 && src < w && bitmap[r][src]) g.set(font.BASELINE + r, c)
    }
  }
  return g
}

/**
 * The one static frame we leave on a unit: centred if it fits, else the start.
 *
 * A broadcast sets a frame and disconnects, and a disconnected panel cannot scroll,
 * so a resting frame is the honest thing to leave. Wider-than-panel text shows its
 * first 24 columns; the caller says so.
 */
export function restingFrame(text: string): {
  grid: Grid
  width: number
  truncated: boolean
} {
  const bitmap = font.textBitmap(text)
  const width = font.textWidth(text)
  const offset = width <= display.COLS ? -Math.floor((display.COLS - width) / 2) : 0
  return { grid: frameFor(bitmap, offset), width, truncated: width > display.COLS }
}

export interface BroadcastOptions {
  /** Delay between column writes. Below ~12ms the panel starts dropping them. */
  pacing?: number
  /** Disable the safety: light every unit in range, even ones we have connected to
   *  before. Connections are still recorded. */
  all?: boolean
  /** Stop after this many seconds. Omit to run until Ctrl-C. */
  forSeconds?: number
  /** Hold each connection open this long after the frame lands. Delivery is acked
   *  already; a dwell just lets you watch it happen. */
  dwellMs?: number
  /** How long to gather adverts before draining a batch, when nothing is in range. */
  windowMs?: number
  /** Cipher, or a function of the advert name for a mixed stock/crew fleet. */
  cipher?: p.Cipher | ((name: string) => p.Cipher)
  /** Advert-name prefixes to accept. Defaults to stock and crew. */
  prefixes?: string[]
}

export async function broadcast(text: string, opts: BroadcastOptions = {}): Promise<void> {
  const { pacing = 18, all = false, dwellMs = 0, windowMs = 5000 } = opts
  const prefixes = opts.prefixes ?? [p.NAME_PREFIX, p.CREW_NAME_PREFIX]
  const { grid, width, truncated } = restingFrame(text)

  const fit = truncated ? `${width} cols, showing the first ${display.COLS}` : 'centred'
  console.log(`broadcasting ${JSON.stringify(text)} (${fit})`)
  console.log(grid.render())
  console.log(
    all
      ? 'watching for glasses - safety off: lighting everyone in range.'
      : 'watching for glasses we have not connected to before.',
  )
  console.log('Ctrl-C to stop.\n')

  const scanner = new NobleScanner()
  const skip = new Set<string>() // names handled or failed this run
  let lit = 0
  let stop = false
  const deadline = opts.forSeconds ? Date.now() + opts.forSeconds * 1000 : Infinity

  const onSigint = () => {
    if (stop) process.exit(130)
    stop = true
    console.log('\nstopping after the current unit (Ctrl-C again to force)...')
  }
  process.on('SIGINT', onSigint)

  try {
    while (!stop && Date.now() < deadline) {
      const batch = new Map<string, string>() // peripheral id -> advert name
      const already = all ? new Set<string>() : await offLimits()

      await scanner.scan((u: Discovered) => {
        if (!prefixes.some((pre) => u.name.startsWith(pre))) return
        if (already.has(u.name) || skip.has(u.name)) return
        batch.set(u.id, u.name)
      })

      // Watch the whole window when nothing is around; once a unit appears, give a
      // short grace to gather a cluster, then move on rather than wait the full window.
      const start = Date.now()
      let firstHitAt = 0
      while (!stop && Date.now() - start < windowMs) {
        await sleep(150)
        if (batch.size > 0) {
          if (!firstHitAt) firstHitAt = Date.now()
          if (Date.now() - firstHitAt > 800) break
        }
      }
      await scanner.stop()

      for (const [id, name] of batch) {
        if (stop) break
        if (skip.has(name)) continue // saw the same unit twice this window
        process.stdout.write(`  ${name} ... `)
        try {
          const transport = await scanner.connect(id)
          const glasses = await Glasses.attach(transport, name, { pacing, cipher: opts.cipher })
          // Recorded the moment we are attached, before drawing: "once we connect,
          // leave it alone" holds even if the frame below fails to land.
          await recordConnection(name)
          skip.add(name)
          await glasses.begin()
          await glasses.show(grid, true)
          if (dwellMs > 0) await sleep(dwellMs)
          await glasses.end('keep')
          lit++
          console.log('lit')
        } catch (err) {
          // A unit that walked off or is held by its owner's phone. Skip it for the
          // rest of this run so we do not hammer it; whether it is remembered across
          // runs depends on if we got as far as recording the connection above.
          skip.add(name)
          console.log(`skipped (${(err as Error).message})`)
        }
      }
    }
  } finally {
    process.off('SIGINT', onSigint)
    await scanner.stop().catch(() => {})
  }

  console.log(`\n${lit} pair(s) lit this run.`)
}
