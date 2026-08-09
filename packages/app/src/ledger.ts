/**
 * Where the save count survives an app restart.
 *
 * Nothing can read a flash cycle count off the glasses, so this file holds the only
 * wear number we will ever have. It backs `budget.FlashBudget`, which is what
 * actually refuses a runaway; losing the file costs the history, not the guard.
 *
 * **One `FlashBudget` for the whole app, at module scope on purpose.** Per connection
 * would reset the three-second interval rule on every reconnect, and "reconnect
 * handler that restores state" is on the runaway list in `notes/app-plan.md`. Module
 * scope also means Fast Refresh remounting the tree does not hand anyone a fresh
 * allowance.
 *
 * expo-file-system needs no native rebuild here: it ships as a dependency of `expo`
 * and is already linked into the dev client (`expo.modules.filesystem` is in the
 * merged manifest). Every call is guarded anyway, because a build where the module
 * is missing must still enforce the budget, just without the history.
 */
import { budget } from '@joggles/core'
import { File, Paths } from 'expo-file-system'

const FILE = 'ledger.json'

/** Every device this phone has saved to, keyed the way `SessionOptions.device` is. */
type All = Record<string, budget.DeviceLedger>

/**
 * The whole ledger, held in memory once read.
 *
 * Saves are rare by construction - one per `DATCP`, floored at three seconds apart -
 * so there is no write batching here and no need for any.
 */
let held: All | null = null

const file = () => new File(Paths.document, FILE)

const complain = (what: string, e: unknown) =>
  console.warn(`ledger ${what} failed, counting in memory only: ${String(e)}`)

function load(): All {
  if (held) return held
  held = {}
  try {
    const f = file()
    // A half-finished write leaves plausible JSON as easily as garbage, and this is
    // read before every save, so a bad file must degrade to an empty count rather
    // than throw somewhere inside the budget guard.
    if (f.exists) {
      const parsed: unknown = JSON.parse(f.textSync())
      if (parsed && typeof parsed === 'object') held = parsed as All
    }
  } catch (e) {
    complain('read', e)
  }
  return held
}

export function fileStore(): budget.LedgerStore {
  return {
    async load(device) {
      return load()[device] ?? null
    },
    async save(ledger) {
      // In memory first: a failed write must still cost the caller its allowance for
      // the rest of the session, or a device with no writable storage would have no
      // rate limit at all.
      const all = load()
      all[ledger.device] = ledger
      try {
        const f = file()
        if (!f.exists) f.create({ intermediates: true })
        f.write(JSON.stringify(all))
      } catch (e) {
        complain('write', e)
      }
    },
  }
}

export const flashBudget = new budget.FlashBudget(fileStore())
