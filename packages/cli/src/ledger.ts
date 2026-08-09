/**
 * The laptop's copy of the flash-wear ledger, as one JSON file.
 *
 * The count exists because nothing can read the remaining flash cycles off the
 * device, so if we do not keep it, no one has it. Persisting matters more than the
 * format: rate limits that reset on every `bun cli` invocation would not have
 * caught the bench loop that prompted them.
 *
 * Keyed by advert name rather than the platform's handle, since the name carries
 * the last three bytes of the MAC and so identifies a unit across hosts.
 */
import { budget } from '@joggles/core'

export const LEDGER_FILE = '.joggles/ledger.json'

type Book = Record<string, budget.DeviceLedger>

async function read(): Promise<Book> {
  const file = Bun.file(LEDGER_FILE)
  if (!(await file.exists())) return {}
  try {
    return (await file.json()) as Book
  } catch {
    // A corrupt ledger must not stop anyone driving the glasses; losing the count
    // is the smaller harm, and the file is rewritten on the next save.
    console.error(`warning: ${LEDGER_FILE} is unreadable, starting a fresh count`)
    return {}
  }
}

export function fileStore(): budget.LedgerStore {
  return {
    async load(device) {
      return (await read())[device] ?? null
    },
    async save(ledger) {
      const book = await read()
      book[ledger.device] = ledger
      await Bun.write(LEDGER_FILE, `${JSON.stringify(book, null, 2)}\n`)
    },
  }
}

/** Every device this host has ever saved to. What `bun cli ledger` prints. */
export async function allDevices(): Promise<budget.DeviceLedger[]> {
  return Object.values(await read())
}
