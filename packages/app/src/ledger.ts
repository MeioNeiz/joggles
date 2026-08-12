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
 *
 * **Two things were weaker here than in the nickname store, which is backwards** given
 * that losing a nickname costs nothing and losing a wear count costs hardware
 * (review-10). Both are fixed and both fixes are load-bearing:
 *
 *  1. **The write is temp-and-rename**, not truncate-then-write. The old one opened
 *     `ledger.json` and overwrote it in place, so a process death mid-write left a
 *     truncated file where the whole history had been - and this is written once per
 *     `DATCP`, which is exactly when the app is busy. The policy, including what
 *     happens when the rename is unavailable, is `ledger-write.ts` so that it runs
 *     under bun; this file is only the three closures over expo-file-system.
 *  2. **The parse is validated**, in `ledger-shape.ts` so it runs under bun. It used to
 *     accept any object `JSON.parse` produced as the whole ledger, which puts arbitrary
 *     values inside the flash guard.
 */
import { budget } from '@joggles/core'
import { File, Paths } from 'expo-file-system'
import { type All, reviveAll } from './ledger-shape.js'
import { writeThroughTemp } from './ledger-write.js'

const FILE = 'ledger.json'

/**
 * The whole ledger, held in memory once read.
 *
 * Saves are rare by construction - one per `DATCP`, floored at three seconds apart -
 * so there is no write batching here and no need for any.
 */
let held: All | null = null

const file = () => new File(Paths.document, FILE)

/**
 * Where a write lands before it becomes the ledger.
 *
 * Derived from `FILE` rather than written out, so this file still names exactly one
 * `.json` literal: `nicknames.test.ts` asserts that, and it is how "the nickname file
 * and the ledger file are different files" is enforced rather than hoped for.
 */
const temp = () => new File(Paths.document, `${FILE}.writing`)

// No "counting in memory only" here: that verdict belongs to the write OUTCOME, not to
// a step. The old wording announced a loss before the in-place fallback had been tried,
// so a recovered write reported a loss that did not happen (track 24, review-21).
const complain = (what: string, e: unknown) =>
  console.warn(`ledger ${what} failed: ${String(e)}`)

function load(): All {
  if (held) return held
  held = reviveAll(null)
  try {
    const f = file()
    // A half-finished write leaves plausible JSON as easily as garbage, and this is
    // read before every save, so a bad file must degrade to an empty count rather
    // than throw somewhere inside the budget guard. What of it survives is
    // `ledger-shape.ts`'s decision, under test.
    if (f.exists) held = reviveAll(JSON.parse(f.textSync()))
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
      const json = JSON.stringify(all)
      // **Nothing here has run outside bun**, `moveSync` included, which is why the
      // policy has a fallback at all and why `stranded` is asked: if the rename turns
      // out to be unavailable on this device the alternative is a phone that silently
      // stops counting wear forever. `ledger-write.ts` decides between them.
      const outcome = writeThroughTemp(
        {
          rename() {
            const scratch = temp()
            scratch.create({ intermediates: true, overwrite: true })
            scratch.write(json)
            scratch.moveSync(file(), { overwrite: true })
          },
          // A fresh handle, not the one that did the move: `moveSync` repoints the
          // instance's own `uri` at the destination, so `scratch.exists` afterwards is
          // a question about `ledger.json` and would answer true either way.
          stranded: () => temp().exists,
          inPlace() {
            const f = file()
            if (!f.exists) f.create({ intermediates: true })
            f.write(json)
          },
        },
        complain,
      )
      if (outcome === 'lost') {
        console.warn('ledger write lost, counting in memory only for this session')
      }
    },
  }
}

export const flashBudget = new budget.FlashBudget(fileStore())
