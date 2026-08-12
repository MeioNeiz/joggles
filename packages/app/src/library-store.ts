/**
 * The library's file, and the app's one `Library`, at module scope like the
 * ledger's `FlashBudget`: Fast Refresh remounting the tree must not hand screens a
 * second in-memory copy racing the first over one file.
 *
 * Its own file, never the wear count's. Losing a wear count matters and losing a
 * preset does not, so nothing that writes presets may hold that file open.
 *
 * Same degrade as the wear count's store: a read or write failure complains to the
 * console and the session keeps its items in memory, because a phone with no writable
 * storage should still save and recall until the app closes. `load` returns the
 * parsed JSON as-is; `revive()` in `library.ts` is where trust is decided, so the
 * rules live once and under test.
 *
 * **Write whole, then rename**, which is review-17's finding fixed. The old write
 * truncated the real file and then wrote into it, so a save that died part-way left
 * `library.json` holding a prefix of the new JSON: not the new library, not the old
 * one, and unparseable, so the next launch reads it, drops it and shows an empty
 * library. Every saved drawing gone, while the Draw screen's delete alert tells the
 * user this phone holds the only copy. A probe against the unfixed code left the file
 * as `[{"kind":"te` and the console still said "keeping items in memory only".
 *
 * **The policy is the wear count's, not a second one**: `writeThroughTemp` in
 * `ledger-write.ts` decides between the rename, the in-place fallback and neither,
 * and it is pure so the decision runs under `bun test`. This file is only the three
 * closures over expo-file-system. Nothing of the other store's file reaches this
 * module, and `library.test.ts` crawls the imports to keep it that way.
 *
 * **The two stores diverge in two places, and this side is the right one in both.**
 * The shared policy is untouched: both differences are in the closures handed to it,
 * and the wear count's store should take both next time it is opened.
 *
 *  1. **The returned outcome is read here**, where the other store discards it. Its
 *     first complaint fires before the in-place fallback has run, so a console line
 *     that says the items are in memory only is a guess at that point and wrong
 *     whenever the fallback works. Read the outcome and the line is said once, when it
 *     is true.
 *  2. **The fallback refuses the one case where it can only destroy what it protects.**
 *     If the payload would not go to the scratch file, storage is failing, and an
 *     in-place write over the real file replaces a whole library with a prefix of the
 *     new one. That is not the tear this file guards against, it is the same tear
 *     through the recovery path, and no test caught it because a tear modelled as
 *     process death cannot reach the fallback at all. `reached` in `save` is the
 *     distinction: a rename this device cannot do at all still gets the fallback,
 *     which is the whole reason the fallback exists.
 *
 * **The fallback is right here too, for a different reason.** Losing a preset is
 * cheap where losing a wear count is not, so an in-place write is the lesser risk in
 * both stores, but the argument for taking it is stronger here: `moveSync` has never
 * run outside bun, and without the fallback a device where it is unavailable would
 * keep every library in memory and lose the lot at every app close, which is the
 * failure the delete alert's promise cannot survive. One torn file if the app dies
 * inside the fallback beats a library that never reaches disk at all.
 *
 * `stranded()` is the part that must not be dropped: a `moveSync` that neither moves
 * the file nor throws reads as success, so the temp path is re-asked through a
 * **fresh** handle. Asking the handle that did the move answers about the destination,
 * because expo repoints the instance's own `uri` there.
 */
import { File, Paths } from 'expo-file-system'
import { writeThroughTemp } from './ledger-write.js'
import { Library } from './library.js'
import type { LibraryStore, SavedItem } from './library.js'

const FILE = 'library.json'

const file = () => new File(Paths.document, FILE)

/**
 * Where a save lands before it becomes the library.
 *
 * Derived from `FILE` so this module still names exactly one `.json` literal, which is
 * what `library.test.ts` asserts to keep the three stores on three files.
 */
const temp = () => new File(Paths.document, `${FILE}.writing`)

const warn = (line: string) => console.warn(`library ${line}`)

const complain = (what: string, e: unknown) => warn(`${what} failed: ${String(e)}`)

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
      const json = JSON.stringify(items)
      // How far the whole-file write got, which is what tells "this storage would not
      // take the bytes" from the two failures the fallback is for. Per call rather than
      // at module scope: nothing in this body awaits, so two saves cannot interleave
      // today, and the day one does they must not share this.
      let reached: 'nothing' | 'the scratch file' | 'the whole payload' = 'nothing'
      // A stranded temp file is left where it is: it is written whole before the
      // rename, overwritten by the next save, and nothing ever reads it, so removing
      // it would add a failure path to a recovery path for tidiness alone.
      const outcome = writeThroughTemp(
        {
          rename() {
            const scratch = temp()
            scratch.create({ intermediates: true, overwrite: true })
            reached = 'the scratch file'
            scratch.write(json)
            reached = 'the whole payload'
            scratch.moveSync(file(), { overwrite: true })
          },
          stranded: () => temp().exists,
          inPlace() {
            // The one failure the fallback must refuse, and it is the middle state
            // only: the payload would not go to the scratch file, so writing it over
            // the real one can only replace a whole library with a prefix of the new
            // one. A device that cannot create the scratch file, and one whose rename
            // is a no-op or a throw, are the cases the fallback is for and both still
            // get it.
            if (reached === 'the scratch file') {
              throw new Error(
                'the whole-file write failed, so writing in place could only truncate',
              )
            }
            const f = file()
            if (!f.exists) f.create({ intermediates: true })
            f.write(json)
          },
        },
        complain,
      )
      // Said once and only when it is true. The complaint above fires while the
      // fallback is still to come, so it is the wrong place to tell anyone the items
      // never reached disk.
      if (outcome === 'lost') warn('save reached no file, keeping items in memory only')
    },
  }
}

export const library = new Library(fileStore())
