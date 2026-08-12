/**
 * The expo-file-system half of `spray.ts`'s memory, split out so the pure store stays
 * importable under bun. Same shape as `settings-store.ts`, and its own file on disk for
 * the same reason: nothing here may share a write or a failure with the wear count.
 *
 * Module scope on purpose. The marks have to outlive the Spray screen, or a pair told to
 * be left alone would be fair game again the moment somebody changed tabs.
 */
import { File, Paths } from 'expo-file-system'
import type { TextFile } from './nicknames.js'
import { createSprayMemory } from './spray.js'

const FILE = 'spray.json'

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

export const sprayMemory = createSprayMemory(onDisk)
