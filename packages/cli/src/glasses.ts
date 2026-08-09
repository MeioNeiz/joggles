/**
 * Scan, connect, attach: the one-shot a CLI script wants.
 *
 * The sequencing that used to live here is now `packages/core/src/session.ts`, and
 * the noble parts are `./noble.ts`. What is left is the convenience the phone
 * deliberately does not get: it resolves the FIRST advert matching a prefix and
 * throws the rest away, where a Scan screen needs the list.
 *
 * The budget is wired here rather than in each script so the laptop obeys the same
 * flash-wear rules as the app, and so the count survives across invocations. The
 * laptop is where the loops actually get written.
 */
import { Glasses, budget, protocol as p, sleep } from '@joggles/core'
import { NobleScanner } from './noble.js'
import { fileStore } from './ledger.js'

export interface Options {
  /** Delay between column writes. Below ~12ms the panel starts dropping them. */
  pacing?: number
  timeoutMs?: number
  /** Cipher, or a function of the advert name for a mixed stock/crew fleet. */
  cipher?: p.Cipher | ((name: string) => p.Cipher)
  /** Advert name prefixes to accept. Defaults to stock and crew. */
  prefixes?: string[]
}

/** One budget per invocation, over the on-disk ledger, shared by every session. */
export const flashBudget = new budget.FlashBudget(fileStore())

export async function open(opts: Options = {}): Promise<Glasses> {
  const { pacing = 18, timeoutMs = 20000, cipher } = opts
  const prefixes = opts.prefixes ?? [p.NAME_PREFIX, p.CREW_NAME_PREFIX]
  const scanner = new NobleScanner()
  const unit = await scanner.first(prefixes, timeoutMs)
  const transport = await scanner.connect(unit.id)
  return Glasses.attach(transport, unit.name, { pacing, cipher, budget: flashBudget })
}

export { Glasses, sleep }
