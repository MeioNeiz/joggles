/**
 * Authoring a slot: how a firmware feature is declared, priced and assembled.
 *
 * `notes/patch-over-bt.md` establishes the delivery: a **resident** half written once
 * over SWD, and two **slots** in the staging bank that carry every feature and are
 * replaced over Bluetooth, alternately. What it did not establish is how a slot gets
 * written. This is that: a feature declares the sub-commands it answers, the capability
 * bit HELLO should report for it, the facts it needs out of the image it will run on,
 * and the code. `buildSlot` puts several of them in one slot, refuses the ways they can
 * collide, and prices the result against the slot bound.
 *
 * ## The four refusals, and why each exists
 *
 *  - **a sub-command the resident half owns.** `HELLO` and the five `UPD_*` are in the
 *    half only a probe can rewrite, and the trampoline dispatches them before it looks
 *    at a slot. A slot claiming one would be dead code that looks alive.
 *  - **two features claiming the same sub-command.** Silently, the second one would
 *    win or lose depending on emission order. Named both ways here instead.
 *  - **a body that does not fit.** Refused with the number of bytes over, because
 *    truncation is a slot that passes its CRC and branches into whatever follows.
 *  - **a feature whose facts do not resolve.** Every feature that touches the vendor's
 *    code finds its anchors by content in the image it is being built for, the way
 *    `ext.findHookSite` does, and a feature that cannot find them refuses rather than
 *    guessing an address.
 *
 * ## What a slot cannot be, and it is a rule rather than a limitation
 *
 * **A slot's code runs only when a command frame arrives**, and nothing here can
 * express anything else. There is no way for a feature to install an interrupt handler,
 * hook the TIMER0 ISR, or run per tick, and that is deliberate: the recovery argument
 * for the whole design is that a slot whose code faults still leaves a unit that
 * answers the commands that replace it. Slot code on the tick path would fault fifty
 * times a second from boot, before any frame could be dispatched, and the unit would
 * need the probe (`research/patch-over-bt-review-2026-08-20.md`, section 3).
 *
 * So a feature that needs to run at a moment we do not control - **notify on button
 * press is the one everybody wants** - is not a slot feature. It needs a second edit to
 * the vendor's code, the hook is the one edit and it is spent, and that puts it back on
 * the SWD route with its own image. Recorded here because it is the first thing anyone
 * will try to add.
 *
 * ## Nothing here has run on silicon
 *
 * `research/tools/thumbsim.ts` executes what this builds, which is worth much more than
 * "it assembles" and much less than "it ran". Its own header lists what the model does
 * not cover: time, interrupts, and the BLE stack running concurrently. No slot has been
 * written to any unit and no unit carries our extension at all.
 */
import * as jgx from '../../../packages/core/src/jgx.js'
import { Asm } from '../thumb.js'
import { HDR, MAGIC, MAGIC_WORD, type Note } from '../ext.js'
import { MAX_BODY as SLOT_MAX_BODY, SLOT_A, SLOT_HDR_LEN, SLOT_SIZE } from '../updater.js'
import { crc32 } from '../../../packages/core/src/ota.js'

export { SLOT_MAX_BODY }

const hex = (n: number) => '0x' + (n >>> 0).toString(16)

/** Sub-command ids the resident half answers, which a slot can never be offered. */
export const RESIDENT_SUBS: readonly number[] = [
  jgx.SUB.HELLO,
  jgx.SUB.UPD_BEGIN,
  jgx.SUB.UPD_DATA,
  jgx.SUB.UPD_END,
  jgx.SUB.UPD_ABORT,
  jgx.SUB.UPD_STATUS,
]

/** An in-place, length-preserving edit to the vendor's image, for `patch.ts`. */
export interface ImageEdit {
  abs: number
  expect: Uint8Array
  to: Uint8Array
  note: string
}

/** What a feature's handlers are handed and may reach. */
export interface FeatureContext {
  /** Absolute address of the slot body's own `JGX1` header. Literals resolve off it. */
  bodyBase: number
  /** The slot this body is assembled for. A body cannot be moved to the other one. */
  slotBase: number
  /** `notify(r0 = length, r1 = pointer)` in the image the slot will run on. */
  notify: number
  /** Frame struct offset of wire byte `n`. */
  arg: (n: number) => number
  /** First byte of one of our notifications. */
  marker: number
}

/**
 * One firmware feature.
 *
 * `F` is whatever the feature resolved out of the image: addresses, immediates, the
 * numbers its own edits and its own literals are built from. It is carried through
 * rather than stored, so a feature cannot be emitted against one image having resolved
 * against another.
 */
export interface Feature<F = unknown> {
  /** Short name, used in reports and as the collision key. */
  id: string
  /** One line: what the feature does. */
  summary: string
  /** The `jgx.CAP` bit HELLO should report when this feature is in the live slot. */
  capability: number
  /** The sub-commands it answers. `jgx.SUB` ids, and each needs a `jgx.SUB_CAP` entry. */
  subcommands: { id: number; label: string }[]
  /** Find what this feature needs in the image it will run on, by content. */
  resolve(image: Uint8Array, base: number): { facts: F | null; notes: Note[] }
  /** Length-preserving edits the image needs before the slot half is any use. */
  edits?(facts: F, image: Uint8Array, base: number): { edits: ImageEdit[]; notes: Note[] }
  /** Emit the handlers. One label per sub-command, named by its `label`. */
  emit(a: Asm, ctx: FeatureContext, facts: F): void
}

export interface SlotOptions {
  /** The image the slot will run on, so features can resolve their anchors. */
  image: Uint8Array
  base: number
  /** `SLOT_A` or `SLOT_B`. A body is assembled for one and refused by the other. */
  slotBase?: number
  notify: number
  arg: (n: number) => number
  marker?: number
  /** Slot version, reported in the body header. */
  version?: number
}

export interface Slot {
  /** The bytes `UPD_DATA` carries, which is a `JGX1` block. */
  body: Uint8Array
  /** `ota.crc32` of the body, which is what `UPD_BEGIN` declares. */
  crc: number
  slotBase: number
  bodyBase: number
  version: number
  capabilities: number
  /** Sub-command ids the body's table names. */
  subcommands: number[]
  /** Body length, and how much of the slot is left. */
  bytes: number
  headroom: number
  /** `UPD_DATA` frames this body takes. */
  frames: number
  features: string[]
  notes: Note[]
}

/**
 * Check a set of features can share one slot, before anything is assembled.
 *
 * Separate from `buildSlot` so a caller can report every problem at once rather than
 * the first one, and so the checks can be tested without an image.
 */
export function checkFeatures(features: Feature<never>[]): Note[] {
  const notes: Note[] = []
  const fatal = (message: string) => notes.push({ severity: 'fatal', message })

  const byId = new Map<string, number>()
  for (const f of features) byId.set(f.id, (byId.get(f.id) ?? 0) + 1)
  for (const [id, n] of byId) {
    if (n > 1) fatal(`${n} features are called '${id}'; the id is how a slot's contents ` +
      'are reported and how a collision is named, so it has to be unique')
  }

  const owner = new Map<number, string>()
  for (const f of features) {
    if (!f.subcommands.length) {
      fatal(`feature '${f.id}' answers no sub-command, so nothing in a slot could ever ` +
        'reach it')
    }
    for (const s of f.subcommands) {
      if (!Number.isInteger(s.id) || s.id < 0 || s.id > 0xff) {
        fatal(`feature '${f.id}' claims sub-command ${s.id}, which is not a byte`)
        continue
      }
      if (RESIDENT_SUBS.includes(s.id)) {
        fatal(`feature '${f.id}' claims sub-command ${hex(s.id)}, which the resident ` +
          'half answers. The trampoline dispatches resident handlers before it consults ' +
          'a slot, so this handler could never run: that ordering is what keeps a ' +
          'broken slot replaceable over the air and it is not negotiable')
        continue
      }
      const held = owner.get(s.id)
      if (held !== undefined) {
        fatal(`sub-command ${hex(s.id)} is claimed by both '${held}' and '${f.id}'. ` +
          'One slot has one table, so one of them would silently never run')
        continue
      }
      owner.set(s.id, f.id)
      if (jgx.SUB_CAP[s.id] === undefined) {
        notes.push({
          severity: 'warn',
          message: `sub-command ${hex(s.id)} ('${s.label}', from '${f.id}') has no ` +
            'entry in jgx.SUB_CAP, so `jgx.permits()` refuses it and no client that ' +
            'asks first will ever send it',
        })
      } else if (jgx.SUB_CAP[s.id] !== f.capability) {
        notes.push({
          severity: 'warn',
          message: `sub-command ${hex(s.id)} is licensed by ${hex(jgx.SUB_CAP[s.id])} ` +
            `in jgx.SUB_CAP but '${f.id}' reports ${hex(f.capability)}, so a client ` +
            'would check one bit and the unit would advertise another',
        })
      }
    }
  }
  return notes
}

/**
 * Assemble one slot body from a set of features.
 *
 * The body is a `JGX1` block, the same shape as the resident one, so the resident
 * dispatcher reads a slot's table exactly the way it reads its own and there is one
 * layout rather than two. Two fields mean something slightly different in a slot:
 *
 *  - **`entry` is the address the body was assembled for**, Thumb-tagged. A slot has no
 *    trampoline, since dispatch is by table, so the field is free, and the resident
 *    dispatcher compares it with where the body actually is. That is the check for the
 *    failure `notes/patch-over-bt.md` calls the one it cannot catch: slot code is
 *    position-dependent, and a body built for A and programmed into B has a valid magic
 *    and a valid CRC and branches somewhere absurd.
 *  - **`size` is the body length**, which is also what the slot header declares and
 *    what the resident dispatcher bounds every table offset against.
 */
export function buildSlot(features: Feature<never>[], opts: SlotOptions): Slot {
  const slotBase = opts.slotBase ?? SLOT_A
  const bodyBase = slotBase + SLOT_HDR_LEN
  const version = opts.version ?? 1
  const marker = opts.marker ?? jgx.MARKER
  const notes: Note[] = [...checkFeatures(features)]

  const resolved: { feature: Feature<never>; facts: unknown }[] = []
  for (const f of features) {
    const r = f.resolve(opts.image, opts.base)
    notes.push(...r.notes)
    if (r.facts === null) {
      notes.push({
        severity: 'fatal',
        message: `feature '${f.id}' could not resolve what it needs in this image, so ` +
          'it is not being built. Its own notes above say what was missing',
      })
      continue
    }
    resolved.push({ feature: f, facts: r.facts })
  }
  if (notes.some((n) => n.severity === 'fatal')) {
    return {
      body: new Uint8Array(0),
      crc: 0,
      slotBase,
      bodyBase,
      version,
      capabilities: 0,
      subcommands: [],
      bytes: 0,
      headroom: SLOT_MAX_BODY,
      frames: 0,
      features: resolved.map((r) => r.feature.id),
      notes,
    }
  }

  const handlers = resolved.flatMap((r) => r.feature.subcommands)
  const tableCount = Math.max(...handlers.map((h) => h.id)) + 1
  const capabilities = resolved.reduce((c, r) => c | r.feature.capability, 0)

  const a = new Asm(bodyBase)
  a.ascii(MAGIC)
  a.half(version)
  a.half(capabilities)
  a.word((bodyBase | 1) >>> 0) //   the base this body was assembled for
  a.word(0) //                      SIZE, filled in once it is known
  a.half(tableCount)
  a.half(0) //                      reserved
  if (a.size !== HDR.TABLE) throw new Error(`header is ${a.size} bytes, expected 0x14`)
  for (let i = 0; i < tableCount; i++) a.half(0)
  a.align(4)

  const ctx: FeatureContext = { bodyBase, slotBase, notify: opts.notify, arg: opts.arg, marker }
  for (const r of resolved) r.feature.emit(a, ctx, r.facts as never)
  a.align(4)
  a.label('end')

  const body = a.assemble()
  const size = a.addressOf('end') - bodyBase
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength)
  dv.setUint32(HDR.SIZE, size, true)
  for (const h of handlers) {
    dv.setUint16(HDR.TABLE + h.id * 2, a.addressOf(h.label) - bodyBase, true)
  }

  if (size > SLOT_MAX_BODY) {
    throw new Error(
      `this slot's body is ${size} bytes and a slot holds ${SLOT_MAX_BODY} ` +
      `(${SLOT_SIZE} bytes of flash less the ${SLOT_HDR_LEN}-byte header), so it is ` +
      `${size - SLOT_MAX_BODY} over. Features in it: ` +
      resolved.map((r) => r.feature.id).join(', ') +
      '. Split them across two slots, or take one out: a truncated body has a valid ' +
      'CRC and branches into whatever follows it',
    )
  }

  return {
    body: body.subarray(0, size),
    crc: crc32(body.subarray(0, size)),
    slotBase,
    bodyBase,
    version,
    capabilities,
    subcommands: handlers.map((h) => h.id).sort((x, y) => x - y),
    bytes: size,
    headroom: SLOT_MAX_BODY - size,
    frames: jgx.updFrames(size),
    features: resolved.map((r) => r.feature.id),
    notes,
  }
}

/** Read a slot body back and report what its header says, the way `readExtension` does. */
export function readSlot(body: Uint8Array) {
  if (body.length < HDR.TABLE) return null
  const magic = String.fromCharCode(...body.subarray(0, 4))
  if (magic !== MAGIC) return null
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const count = dv.getUint16(HDR.TABLE_COUNT, true)
  const subcommands: number[] = []
  for (let i = 0; i < count && HDR.TABLE + i * 2 + 2 <= body.length; i++) {
    if (dv.getUint16(HDR.TABLE + i * 2, true) !== 0) subcommands.push(i)
  }
  return {
    magic,
    magicWord: MAGIC_WORD,
    version: dv.getUint16(HDR.VERSION, true),
    capabilities: dv.getUint16(HDR.CAPABILITIES, true),
    /** The base the body was assembled for, Thumb-tagged. */
    assembledFor: dv.getUint32(HDR.ENTRY, true),
    size: dv.getUint32(HDR.SIZE, true),
    subcommands,
  }
}
