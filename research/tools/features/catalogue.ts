/**
 * Every feature there is, and which of them a build has to know about.
 *
 * One list, so `build-firmware` and the slot builder cannot disagree about what exists.
 * A feature goes in `FEATURES` and everything else follows: `bun run build-firmware
 * --feature <id>` applies its image edits, and `bun research/tools/features/build-slot.ts
 * <id>...` puts its handlers in a slot.
 *
 * ## Adding one
 *
 *  1. write `features/<id>.ts` exporting a `Feature`: the `jgx.SUB` ids it answers, the
 *     `jgx.CAP` bit HELLO reports for it, a `resolve` that finds what it needs in the
 *     image **by content**, an `emit` for the handlers, and `edits` if it needs the
 *     vendor's own code changed;
 *  2. add it here;
 *  3. give it a test that executes it, the way `features/slot.test.ts` does: assembling
 *     is not evidence.
 *
 * Two things a feature cannot be, both in `features/index.ts`'s header: it cannot claim
 * a sub-command the resident half answers, and it cannot run anywhere except in a
 * command frame. The second is what rules out notify-on-button-press, which needs a
 * second edit to the vendor's code and therefore its own image and its own probe
 * session.
 */
import type { Feature } from './index.js'
import { tick } from './tick.js'

/** A feature that also needs edits to the vendor's own code. */
export type ImageFeature = Feature<never> & { edits: NonNullable<Feature<never>['edits']> }

export const FEATURES: Feature<never>[] = [tick as unknown as Feature<never>]

export const featureById = (id: string): Feature<never> | undefined =>
  FEATURES.find((f) => f.id === id)
