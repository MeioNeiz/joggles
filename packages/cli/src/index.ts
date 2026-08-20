#!/usr/bin/env bun
/**
 * Laptop control for the glasses.
 *
 *   bun cli probe            report what firmware a unit carries
 *   bun cli text "HELLO"     scroll or centre text
 *   bun cli broadcast "HI"   set your text on every new pair in range
 *   bun cli edge             trace the panel silhouette
 *   bun cli bench            measure the real frame rate
 *   bun cli off              blank the panel
 *   bun cli ledger           flash saves counted against each unit
 *   bun cli patch status     what slot a crew unit is carrying, if any
 */
import { Grid, budget, display, font, jgx, protocol as p } from '@joggles/core'
import { type BroadcastOptions, broadcast, frameFor } from './broadcast.js'
import { open, sleep } from './glasses.js'
import { LEDGER_FILE, allDevices } from './ledger.js'

async function cmdText(text: string): Promise<void> {
  const bitmap = font.textBitmap(text)
  const w = font.textWidth(text)
  console.log(`${JSON.stringify(text)} -> ${w} columns, panel is ${display.COLS}\n`)

  const glasses = await open()
  console.log(`connected to ${glasses.name}`)
  await glasses.begin()

  if (w <= display.COLS) {
    const centred = frameFor(bitmap, -Math.floor((display.COLS - w) / 2))
    console.log(centred.render())
    await glasses.show(centred, true)
    await sleep(20000)
  } else {
    console.log('scrolling 3 times...')
    for (let pass = 0; pass < 3; pass++) {
      for (let off = -display.COLS; off <= w; off++) {
        await glasses.show(frameFor(bitmap, off))
      }
    }
  }
  await glasses.end('keep')
}

/**
 * Set your text on every pair of glasses we have not connected to before, as they
 * come into range. Runs until Ctrl-C. See `broadcast.ts`; the cipher is picked per
 * advert so a crew unit in the crowd gets the crew key and everyone else the vendor
 * one. `--all` disables the "leave connected units alone" safety.
 *
 *   bun cli broadcast "HELLO"            new units only, until Ctrl-C
 *   bun cli broadcast "HELLO" --for 60   stop after a minute
 *   bun cli broadcast "HELLO" --all      light every unit in range, connected or not
 *   bun cli broadcast "HI" --dwell 2000  hold each unit 2s so you can watch it
 */
async function cmdBroadcast(rest: string[]): Promise<void> {
  const opts: BroadcastOptions = {}
  const words: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--all') opts.all = true
    else if (a === '--for') opts.forSeconds = Number(rest[++i])
    else if (a === '--dwell') opts.dwellMs = Number(rest[++i])
    else if (a === '--pacing') opts.pacing = Number(rest[++i])
    else words.push(a)
  }

  const key = await crewKey()
  opts.cipher = (name) =>
    key && name.startsWith(p.CREW_NAME_PREFIX) ? p.cipher(key) : p.vendor

  await broadcast(words.join(' ') || 'HELLO', opts)
}

async function cmdEdge(): Promise<void> {
  const g = new Grid()
  for (const [r, c] of display.edgePixels()) g.set(r, c)
  console.log(g.render())
  const glasses = await open()
  await glasses.begin()
  await glasses.show(g, true)
  console.log('edge trace displayed')
  await glasses.end('keep')
}

async function cmdOff(): Promise<void> {
  const glasses = await open()
  await glasses.begin()
  await glasses.end('off')
  console.log('panel off')
}

/**
 * Measure real throughput. This decides what the app can be: a text-and-presets
 * controller, or something that animates.
 */
async function cmdBench(): Promise<void> {
  console.log('measuring frame rate at several pacings\n')
  console.log('pacing   full-frame fps   delta fps (sparse)   verdict')
  console.log('-'.repeat(62))

  for (const pacing of [18, 12, 8, 5, 3, 1]) {
    const glasses = await open({ pacing })
    await glasses.begin()

    // Full frames: every column rewritten, the worst case.
    const full: Grid[] = []
    for (let i = 0; i < 6; i++) {
      const g = new Grid()
      for (let c = 0; c < display.COLS; c++) g.set(2 + (i % 5), c)
      full.push(g)
    }
    let t0 = performance.now()
    for (const g of full) await glasses.show(g, true)
    const fullFps = (full.length / (performance.now() - t0)) * 1000

    // Sparse: a single moving pixel, the best case for delta updates.
    const sparse: Grid[] = []
    for (let i = 0; i < 12; i++) {
      const g = new Grid()
      g.set(4, i * 2)
      sparse.push(g)
    }
    await glasses.show(sparse[0], true)
    t0 = performance.now()
    for (const g of sparse) await glasses.show(g)
    const deltaFps = (sparse.length / (performance.now() - t0)) * 1000

    const verdict =
      deltaFps >= 15 ? 'animation viable' : deltaFps >= 8 ? 'usable' : 'too slow'
    console.log(
      `${String(pacing).padStart(4)}ms   ${fullFps.toFixed(1).padStart(12)}   ` +
        `${deltaFps.toFixed(1).padStart(18)}   ${verdict}`,
    )
    await glasses.end('keep')
    await sleep(500)
  }
  console.log('\nIf sparse fps stays high as pacing drops, we are pacing-bound')
  console.log('and can simply go faster. If it plateaus, the panel is the limit.')
}


/**
 * Visual reliability check. The bench measures send rate; this finds the pacing
 * at which the panel stops keeping up, which only a human can see.
 */
async function cmdStress(): Promise<void> {
  console.log('A vertical bar sweeps left-to-right at each pacing.')
  console.log('Watch for: tearing, columns left lit behind the bar, stutter.\n')

  for (const pacing of [12, 8, 5, 3, 2, 1]) {
    console.log(`=== pacing ${pacing}ms - sweeping 4 times`)
    const glasses = await open({ pacing })
    await glasses.begin()
    await glasses.show(new Grid(), true)
    for (let pass = 0; pass < 4; pass++) {
      for (let c = 0; c < display.COLS; c++) {
        const g = new Grid()
        for (let r = 0; r < display.ROWS; r++) g.set(r, c)
        await glasses.show(g)
      }
    }
    await glasses.show(new Grid(), true)
    await glasses.end('keep')
    console.log('    done\n')
    await sleep(1500)
  }
  console.log('At which pacing did it start looking wrong?')
}

/**
 * Ask a unit what firmware it carries.
 *
 * The first thing to run against a freshly flashed unit, and the only check that
 * tells crew from stock without guessing: stock never answers HELLO at all.
 */
async function cmdProbe(): Promise<void> {
  const key = await crewKey()
  console.log(key ? `crew key from ${CREW_KEY_FILE}` : 'no crew key; vendor key only')

  const glasses = await open({
    cipher: (name) =>
      key && name.startsWith(p.CREW_NAME_PREFIX) ? p.cipher(key) : p.vendor,
  })
  const id = await glasses.probe()
  console.log(`\nname       ${id.name}`)
  if (id.kind === 'stock') {
    console.log('firmware   stock: no answer to HELLO')
    console.log('           (also what a crew unit looks like under the wrong key)')
  } else {
    const caps = jgx.capabilityNames(id.capabilities)
    console.log(`firmware   JGX1 extension v${id.version}`)
    console.log(`capable of ${caps.join(', ') || 'nothing declared'}`)
  }
  await glasses.end('keep')
}

/**
 * What each unit has been made to write to its flash.
 *
 * Nothing can read the remaining cycles off the device, so this count is the only
 * number we will ever have, and it is worth being able to see without connecting.
 * A run of identical hashes in `recent` is the signature of a runaway.
 */
async function cmdLedger(): Promise<void> {
  const devices = await allDevices()
  if (!devices.length) {
    console.log(`no saves recorded yet (${LEDGER_FILE})`)
    return
  }
  const when = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 16) : '-')
  console.log('device            lifetime   hour    day   first             last')
  console.log('-'.repeat(74))
  for (const d of devices) {
    const { hour, day } = budget.counts(d, Date.now())
    console.log(
      `${d.device.padEnd(18)}${String(d.lifetime).padStart(6)}` +
        `${String(hour).padStart(7)}${String(day).padStart(7)}   ` +
        `${when(d.first)}  ${when(d.last)}`,
    )
  }
  console.log(
    `\nEach save is 5 page erases at abs 0x3c000. Wear there costs saved content,` +
      `\nnot the unit. See "Flash wear" in notes/app-plan.md.`,
  )
}

/** The group key our firmware carries. Absent until build-firmware.ts makes one. */
const CREW_KEY_FILE = 'firmware/crew-key.json'

async function crewKey(): Promise<Uint8Array | null> {
  const file = Bun.file(CREW_KEY_FILE)
  if (!(await file.exists())) return null
  const hex = String((await file.json()).key)
  return new Uint8Array((hex.match(/../g) ?? []).map((b) => parseInt(b, 16)))
}

const [cmd, ...rest] = process.argv.slice(2)
try {
  switch (cmd) {
    case 'probe':
      await cmdProbe()
      break
    case 'text':
      await cmdText(rest.join(' ') || 'HELLO')
      break
    case 'broadcast':
      await cmdBroadcast(rest)
      break
    case 'edge':
      await cmdEdge()
      break
    case 'off':
      await cmdOff()
      break
    case 'stress':
      await cmdStress()
      break
    case 'bench':
      await cmdBench()
      break
    case 'ledger':
      await cmdLedger()
      break
    // Imported here rather than at the top of the file so the firmware-side modules
    // load only when asked for: `patch check` needs no adapter and no Bluetooth.
    case 'patch':
      process.exit(await (await import('./patch.js')).runCli(rest))
    default:
      console.log(
        'usage: bun cli <probe|text|broadcast|edge|off|bench|stress|ledger> [args]',
      )
      console.log('       bun cli patch <status|check|send|commit|abort> [args]')
      process.exit(1)
  }
  process.exit(0)
} catch (err) {
  console.error('error:', (err as Error).message)
  process.exit(1)
}
