/**
 * Everything that drives a running unit, and nothing that can rewrite its flash.
 *
 * `ota` and `dfu` are deliberately absent: they live behind `./firmware.js`, so a
 * client that only imports this barrel cannot reach the OTA service even by
 * accident. The phone app imports this and never that, which is the whole of its
 * "cannot brick a unit" guarantee. `safe-surface.test.ts` enforces both halves.
 */
export * as protocol from './protocol.js'
export * as display from './display.js'
export * as font from './font.js'
export { Grid, ROWS, COLS, alive, edgePixels } from './display.js'
export * as dats from './dats.js'
export * as jgx from './jgx.js'
export { Glasses, sleep } from './session.js'
export type { Identity, SaveOpts, SaveResult, SessionOptions } from './session.js'
export { CHANNELS, assertChannel } from './transport.js'
export type { Discovered, Scanner, Transport } from './transport.js'
export * as budget from './budget.js'
export * as content from './content.js'
export * as viewport from './viewport.js'
export type { Bitmap, Content, Motion, Route } from './content.js'
export { LiveSender } from './sender.js'
export type { ClearOptions, SenderOptions } from './sender.js'
export * as effects from './effects.js'
export type { Field, RenderOptions, Sample, Seam } from './effects.js'
export * as rhythm from './rhythm.js'
export type { SmoothOptions, SpectrumOptions, Style, StyleSpec } from './rhythm.js'
