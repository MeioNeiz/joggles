/**
 * Every unit this host has connected to, as one JSON file.
 *
 * The broadcast leans on it: "glasses we haven't already connected to" is exactly
 * the units absent from here. It is recorded on every successful connection whatever
 * the command - a probe, a `text`, a broadcast - so a unit we have merely looked at
 * once is off the broadcast list too, which is the safety `broadcast --all` lifts.
 *
 * Separate from the flash ledger (`ledger.ts`) because they answer different
 * questions: the ledger counts flash writes to decide what is safe, this records
 * that a connection happened at all. Keyed the same way, by advert name, since that
 * carries the MAC suffix and so names a unit across hosts.
 */
const FILE = '.joggles/connections.json'

interface Connection {
  first: number
  last: number
  count: number
}
type Book = Record<string, Connection>

async function read(): Promise<Book> {
  const file = Bun.file(FILE)
  if (!(await file.exists())) return {}
  try {
    return (await file.json()) as Book
  } catch {
    // A corrupt file must not stop anyone driving the glasses; the cost is at worst
    // a unit lit twice, and the file is rewritten on the next connection.
    return {}
  }
}

/** Note that we have just connected to `name`. Called once per successful attach. */
export async function recordConnection(name: string): Promise<void> {
  const book = await read()
  const now = Date.now()
  const prev = book[name]
  book[name] = { first: prev?.first ?? now, last: now, count: (prev?.count ?? 0) + 1 }
  await Bun.write(FILE, `${JSON.stringify(book, null, 2)}\n`)
}

/** The set of advert names this host has connected to. The broadcast's skip list. */
export async function connectedNames(): Promise<Set<string>> {
  return new Set(Object.keys(await read()))
}
