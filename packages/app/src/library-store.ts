/**
 * The library's file, and the app's one `Library`, at module scope like the
 * ledger's `FlashBudget`: Fast Refresh remounting the tree must not hand screens a
 * second in-memory copy racing the first over one file.
 *
 * Its own file, never `ledger.json`. Losing a wear count matters and losing a
 * preset does not, so nothing that writes presets may hold the ledger open.
 *
 * Same degrade as `ledger.ts`: a read or write failure complains to the console
 * and the session keeps its items in memory, because a phone with no writable
 * storage should still save and recall until the app closes. `load` returns the
 * parsed JSON as-is; `revive()` in `library.ts` is where trust is decided, so the
 * rules live once and under test.
 */
import { File, Paths } from 'expo-file-system'
import { Library } from './library.js'
import type { LibraryStore, SavedItem } from './library.js'

const FILE = 'library.json'

const file = () => new File(Paths.document, FILE)

const complain = (what: string, e: unknown) =>
  console.warn(`library ${what} failed, keeping items in memory only: ${String(e)}`)

export function fileStore(): LibraryStore {
  return {
    async load(): Promise<unknown> {
      try {
        const f = file()
        if (f.exists) return JSON.parse(f.textSync())
      } catch (e) {
        complain('read', e)
      }
      return null
    },
    async save(items: SavedItem[]): Promise<void> {
      try {
        const f = file()
        if (!f.exists) f.create({ intermediates: true })
        f.write(JSON.stringify(items))
      } catch (e) {
        complain('write', e)
      }
    },
  }
}

export const library = new Library(fileStore())
