/**
 * Put a `Content` on the glasses: commit it, then tell them to display it.
 *
 * This is out of the screen and in a plain function for one reason - it is the app's
 * only flash write, and a sequence buried in an `onPress` can only be checked by a
 * person looking at a 9x24 LED panel. Here it runs against `core`'s mock transport,
 * so "the phone sends DATS, then the blocks, then DATCP, then SPEED, then MODE" is a
 * test. See `deliver.test.ts`.
 *
 * Two steps, and only the first costs anything. `save()` streams into SRAM and
 * commits with `DATCP`, five page erases whatever the length; `MODE` then switches
 * the device to showing its saved store, which is free and unlimited. So re-sending
 * the same text with a different direction spends nothing: the budget guard skips the
 * identical payload and the `MODE` still goes out.
 *
 * It does not retry. `ERROR` is a legitimate reply to an over-long payload, so a
 * retry loop here would be a save loop, which is fourth on the runaway list in
 * `notes/app-plan.md`.
 */
import { Glasses, content, dats, protocol as p } from '@joggles/core'
import type { SaveOpts, SaveResult } from '@joggles/core'

export interface Delivered {
  /** `saved` wrote flash. `skipped` did not. `refused` never got past `DATS`. */
  status: SaveResult['status']
  /** The device's own word, or why nothing was sent. */
  reply: string
  /** Lifetime saves counted against this unit, this one included. */
  saves: number
  /** Whether `MODE` went out, so the panel is showing what was just committed. */
  showing: boolean
}

/**
 * Everything that makes this content unsendable, as sentences. Empty means go.
 *
 * A list rather than a throw because the Compose screen disables its button and says
 * why, and more than one thing can be wrong at once.
 */
export function problems(piece: content.Content): string[] {
  // `session.save()` still announces DATS type 1, so greyscale would be flattened to
  // 1bpp with nothing at either end able to say it happened. Refusing is honest;
  // sending it needs a `type` argument threaded into `dats.datsStart`, which is a
  // change in core and belongs to whoever lands the draw canvas.
  if (content.savedType(piece) !== dats.TYPE_TEXT) {
    return ['grey levels need DATS type 2, and save() only sends type 1']
  }
  // Type-pinned for the same reason: the two types have unrelated ceilings, so check
  // against what will actually be sent, not against what the content would prefer.
  return content.check(piece, { type: dats.TYPE_TEXT })
}

export async function deliver(
  glasses: Glasses,
  piece: content.Content,
  opts: SaveOpts = {},
): Promise<Delivered> {
  const bad = problems(piece)
  if (bad.length > 0) throw new Error(bad.join('; '))

  const result = await glasses.save(piece.bitmap, opts)
  // Nothing was committed, so switching to the saved store now would display
  // whatever was there before and read as a successful save of the wrong text.
  if (result.status === 'refused') return { ...result, showing: false }

  // SPEED before MODE, which is the order `packages/cli/src/upload.ts` used on the
  // run that scrolled unattended. Whether the scroll timer re-reads the value
  // afterwards is untested, so nothing here relies on it.
  if (piece.motion.kind === 'scroll') await glasses.command(p.speed(piece.motion.speed))
  const args = content.modeArgs(piece.motion)
  await glasses.command(p.mode(args.kind, args.dir))
  return { ...result, showing: true }
}
