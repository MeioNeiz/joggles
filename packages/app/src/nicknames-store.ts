/**
 * The expo-file-system half of `nicknames.ts`, split out so the pure store stays
 * importable under bun.
 *
 * Its own file on disk, never `ledger.json`: losing a wear count matters and losing a
 * nickname does not, so they must not share a write, a parse, or a failure.
 *
 * Module scope on purpose, like the ledger's `flashBudget`: Fast Refresh remounting
 * the tree must see the same map, not re-read the file per mount. Every file call is
 * guarded inside `createStore`, so a build without the module still renames in memory.
 */
import { File, Paths } from 'expo-file-system'
import { createStore, type TextFile } from './nicknames.js'

const FILE = 'nicknames.json'

const onDisk: TextFile = {
  read() {
    const f = new File(Paths.document, FILE)
    return f.exists ? f.textSync() : null
  },
  write(text) {
    const f = new File(Paths.document, FILE)
    if (!f.exists) f.create({ intermediates: true })
    f.write(text)
  },
}

export const nicknames = createStore(onDisk)
