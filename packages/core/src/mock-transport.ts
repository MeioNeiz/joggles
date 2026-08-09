/**
 * A device that exists only in a test.
 *
 * The point of the transport split is that "the phone sends the same bytes as the
 * CLI" is a test rather than a hope, and this is what those tests run against.
 * Deliberately not exported from the barrel: it is scaffolding, and shipping a fake
 * device in the app bundle helps nobody.
 *
 * Replies are delivered synchronously from inside `write()`, which is safe because
 * every waiter in `session.ts` is registered before its write goes out. Real
 * hardware is slower and the promises resolve the same way.
 */
import * as p from './protocol.js'
import type { Transport } from './transport.js'
import { assertChannel } from './transport.js'

export interface Written {
  char: string
  block: Uint8Array
  withResponse: boolean
  /** Decrypted, because assertions are about the wire format, not the cipher. */
  plain: Uint8Array
}

/** ASCII opcode of a plaintext frame, e.g. `DATS`. Empty for a column write. */
export const opcodeOf = (plain: Uint8Array): string =>
  String.fromCharCode(...p.body(plain)).replace(/[^A-Z]+.*$/s, '')

export class MockTransport implements Transport {
  readonly writes: Written[] = []

  readonly subscribed: string[] = []

  disconnected = false

  private listeners = new Map<string, (block: Uint8Array) => void>()

  /** Frames the device answers with, as plaintext. Called for every write. */
  answer: (w: Written) => Uint8Array[] = () => []

  constructor(private cipher: p.Cipher = p.vendor) {}

  async write(char: string, block: Uint8Array, withResponse: boolean): Promise<void> {
    assertChannel(char)
    if (block.length !== p.BLOCK_SIZE) {
      throw new Error(`one ${p.BLOCK_SIZE}-byte block per write, got ${block.length}`)
    }
    const w = { char, block, withResponse, plain: this.cipher.decrypt(block) }
    this.writes.push(w)
    for (const frame of this.answer(w)) this.notify(frame)
  }

  async subscribe(char: string, on: (block: Uint8Array) => void): Promise<void> {
    assertChannel(char)
    this.subscribed.push(char)
    this.listeners.set(char, on)
  }

  async disconnect(): Promise<void> {
    this.disconnected = true
  }

  /** Push a plaintext frame up the notify channel, as the device would. */
  notify(frame: Uint8Array): void {
    this.listeners.get(p.CHAR_NOTIFY)?.(this.cipher.encrypt(frame))
  }

  /** Plaintext of every write to one characteristic, padding included. */
  to(char: string): Uint8Array[] {
    return this.writes.filter((w) => w.char === char).map((w) => w.plain)
  }

  /** Opcodes seen on the command channel, in order. */
  get commands(): string[] {
    return this.to(p.CHAR_COMMAND).map(opcodeOf)
  }
}

/** ASCII notify frame, in the shape `dats.parseReply` expects. */
export function reply(text: string): Uint8Array {
  return p.frame(text)
}

/**
 * A mock wired to answer the DATS handshake the way the firmware does.
 *
 * `fail` makes `DATCP` answer `ERROR`, which is a real reply the device gives to
 * an over-long payload and the case a naive retry loop turns into a runaway.
 */
export function datsDevice(opts: { fail?: boolean } = {}): MockTransport {
  const t = new MockTransport()
  t.answer = (w) => {
    if (w.char !== p.CHAR_COMMAND) return []
    const op = opcodeOf(w.plain)
    if (op === 'DATS') return [reply('DATSOK')]
    if (op === 'DATCP') return [reply(opts.fail ? 'ERROR' : 'DATCPOK')]
    return []
  }
  return t
}
