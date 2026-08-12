/**
 * The font tables and the layout engine. `../font.ts` is the API most callers
 * want; this is what it is built from, and what you import to name a font.
 */
export type { Font } from './types.js'
export { BAND5 } from './band5.js'
export { BAND6 } from './band6.js'
export { SLIM5 } from './slim5.js'
export { TALL7 } from './tall7.js'
export * as kern from './kern.js'
export { staticText, widestGlyph } from './place.js'
export type { StaticOptions, StaticPlacement } from './place.js'
export {
  FONTS,
  FREE_COLUMNS,
  LEGACY_FONT,
  bestFree,
  fit,
  fitAll,
  fontByName,
} from './fit.js'
export type { Fit } from './fit.js'
