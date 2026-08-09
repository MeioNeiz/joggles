#!/usr/bin/env bun
/**
 * Passive scan. Lists everything advertising, connects to nothing.
 *
 *   bun run packages/cli/src/scan.ts [seconds]
 *
 * The diagnostic to reach for when a unit does not come back: it separates "not
 * advertising" from "advertising under a name we did not expect", which matters the
 * moment firmware starts renaming the advert. Connecting would tell you neither.
 */
import noble from '@abandonware/noble'
import { protocol as p } from '@joggles/core'

const secs = Number(Bun.argv[2] ?? 15)
const seen = new Map<string, string>()
const WANTED = [p.NAME_PREFIX, p.CREW_NAME_PREFIX]
let announced = false

noble.on('discover', (dev: any) => {
  const name = dev.advertisement?.localName ?? ''
  const mfg = dev.advertisement?.manufacturerData
  seen.set(
    dev.id,
    `${(name || '(no name)').padEnd(20)} rssi ${String(dev.rssi).padStart(4)}  ${mfg ? mfg.toString('hex') : '-'}`,
  )
  // Print the moment a unit appears rather than at the end, so a long watch is
  // useful while something is charging on the bench.
  if (WANTED.some((w) => name.startsWith(w)) && !announced) {
    announced = true
    console.log(`\n*** ${name} is advertising, rssi ${dev.rssi} ***`)
  }
})

async function run(): Promise<void> {
  // Duplicates on, so a unit that appears late still shows up.
  await noble.startScanningAsync([], true)
  await Bun.sleep(secs * 1000)
  await noble.stopScanningAsync()
  const named = [...seen.entries()].filter(([, l]) => !l.startsWith('(no name)'))
  console.log(`\n${seen.size} device(s) in ${secs}s, ${named.length} with a name:`)
  for (const [id, line] of named) console.log(`  ${id}  ${line}`)
  process.exit(0)
}

if (noble._state === 'poweredOn') await run()
else noble.once('stateChange', (s: string) => (s === 'poweredOn' ? run() : process.exit(1)))
