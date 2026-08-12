/**
 * The expo-file-system half of `settings.ts`, split out so the pure store stays
 * importable under bun. Same shape as `nicknames-store.ts`, and its own file on disk
 * for the same reason: nothing here may share a write or a failure with the ledger.
 *
 * Module scope on purpose: Fast Refresh remounting the tree must see the same
 * defaults, not re-read the file per mount.
 */
import { File, Paths } from 'expo-file-system'
import type { TextFile } from './nicknames.js'
import { createSettings } from './settings.js'

const FILE = 'settings.json'

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

export const settings = createSettings(onDisk)
