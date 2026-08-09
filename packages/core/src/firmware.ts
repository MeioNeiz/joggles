/**
 * The flash-writing half of the library, kept out of the main barrel on purpose.
 *
 * Importing this is the decision to be able to talk to the `fd00` OTA service.
 * A brick on 2026-08-08 cost us a unit with a *stock* image over stock, so the
 * separation is not tidiness: anything that imports `@joggles/core` alone is
 * incapable of reaching the radio path that did it.
 *
 * Laptop tooling (`flash.ts`, `ota-check.ts`) imports this. The phone app must
 * not, and `safe-surface.test.ts` fails the build if the barrel ever pulls it in.
 */
export * as ota from './ota.js'
export * as dfu from './dfu.js'
