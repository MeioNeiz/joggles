/**
 * Per-pair accent themes, so a glance says which pair the app is driving.
 *
 * Asked for on 2026-08-12: several pairs at a festival are as indistinguishable in the
 * app as they are in a scan list, and a colour is readable in a dark field where a
 * nickname is not. Which pair wears which hue is `settings.ts` state, keyed on the
 * advert name like every other per-pair fact this phone holds; this file is only the
 * palette and the plumbing.
 *
 * The palette is fixed because the value is recognition, not decoration, and it is
 * eleven entries because five was fewer than the crew has pairs (asked for on
 * 2026-08-12: "need more theme colours for specific glasses"). Eleven is where it stops
 * for a reason rather than a whim: the ten hues are spaced about 30 degrees apart around
 * the wheel, which is roughly the finest split still readable at arm's length in a dark
 * field, so a twelfth would have to sit between two it could be mistaken for. The
 * neutral, `pearl`, is the one entry that is not a hue, for the pair that would rather
 * not wear one.
 *
 * Ordered round the wheel rather than by preference, so the swatch row reads as a
 * spectrum and two pairs are picked apart by where they sit in it as much as by colour.
 * `green` stays first because it is the default and a stored `null` must keep meaning
 * what it meant.
 *
 * Every entry carries its own dim and fill variants rather than deriving them, because
 * colour arithmetic in JS gets hue subtly wrong and there are only eleven to write out.
 * The three are one family per row: accent is the readable mid tone, `dim` is a
 * near-black wash of the same hue for a selected chip, and `fill` is dark enough that
 * white text sits on it, which is what the flash button needs.
 *
 * **The lit pixel wears the theme too** ("theme colour should be preview colour as
 * well", 2026-08-12). Three grids draw panel pixels - the compose preview, the draw pad
 * and the library thumbnails - and all three held the same three greens written out
 * three times, so an amber pair got its colour everywhere except the part of the screen
 * a person was actually looking at. `levels` is that family, and it is the same eleven
 * rows so there is one place to read a hue off.
 *
 * The levels are three separable steps rather than a rendition of the panel: the
 * module's own steps are far subtler (*verified*: six-column bands at different levels
 * were not separable side by side), so they say "there is grey here" and no more. Level
 * 3 is the accent, which is what makes a full-brightness pixel and a chip the same
 * colour; the grids own what unlit looks like, because that is a property of the grid
 * and not of the pair.
 *
 * A React context rather than a prop, because the accent reaches leaf components
 * (chips, buttons, the tab bar) through every screen, and threading it would make
 * each screen's props lie about what the screen actually varies on. The context
 * imports only `react`, so everything here still loads under bun.
 */
import { createContext, useContext } from 'react'

export interface Theme {
  id: string
  label: string
  /** The accent: active chips, links, the outline of the free button. */
  accent: string
  /** Barely-there accent background, for a selected chip. */
  dim: string
  /** The filled button, which is the one that spends flash. */
  fill: string
  /** A lit panel pixel at levels 1, 2 and 3. The third is `accent`. */
  levels: readonly [string, string, string]
}

export const THEMES: Theme[] = [
  { id: 'green', label: 'Green', accent: '#4ade80', dim: '#0a2e1a', fill: '#166534',
    levels: ['#14532d', '#22c55e', '#4ade80'] },
  { id: 'lime', label: 'Lime', accent: '#a3e635', dim: '#1d2b08', fill: '#4d7c0f',
    levels: ['#365314', '#84cc16', '#a3e635'] },
  { id: 'amber', label: 'Amber', accent: '#fbbf24', dim: '#33230a', fill: '#b45309',
    levels: ['#78350f', '#f59e0b', '#fbbf24'] },
  { id: 'orange', label: 'Orange', accent: '#fb923c', dim: '#351805', fill: '#c2410c',
    levels: ['#7c2d12', '#f97316', '#fb923c'] },
  { id: 'rose', label: 'Rose', accent: '#fb7185', dim: '#3d0a17', fill: '#be123c',
    levels: ['#881337', '#f43f5e', '#fb7185'] },
  { id: 'fuchsia', label: 'Fuchsia', accent: '#e879f9', dim: '#33093a', fill: '#a21caf',
    levels: ['#701a75', '#d946ef', '#e879f9'] },
  { id: 'violet', label: 'Violet', accent: '#a78bfa', dim: '#231447', fill: '#6d28d9',
    levels: ['#4c1d95', '#8b5cf6', '#a78bfa'] },
  { id: 'indigo', label: 'Indigo', accent: '#818cf8', dim: '#14183d', fill: '#4338ca',
    levels: ['#312e81', '#6366f1', '#818cf8'] },
  { id: 'sky', label: 'Sky', accent: '#38bdf8', dim: '#082638', fill: '#0369a1',
    levels: ['#0c4a6e', '#0ea5e9', '#38bdf8'] },
  { id: 'teal', label: 'Teal', accent: '#2dd4bf', dim: '#06302c', fill: '#0f766e',
    levels: ['#134e4a', '#14b8a6', '#2dd4bf'] },
  // The neutral cannot lean on hue to separate a dim pixel from an unlit one, so its
  // level 1 is lighter than the hues' are.
  { id: 'pearl', label: 'Pearl', accent: '#e5e7eb', dim: '#24262b', fill: '#4b5563',
    levels: ['#4b5563', '#9ca3af', '#e5e7eb'] },
]

export const DEFAULT_THEME = THEMES[0]

/** Unknown ids fall back to the default, so a stale settings file cannot blank the UI. */
export const themeById = (id: string | null | undefined): Theme =>
  THEMES.find((t) => t.id === id) ?? DEFAULT_THEME

export const ThemeContext = createContext<Theme>(DEFAULT_THEME)

export const useTheme = (): Theme => useContext(ThemeContext)
