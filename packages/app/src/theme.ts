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
}

export const THEMES: Theme[] = [
  { id: 'green', label: 'Green', accent: '#4ade80', dim: '#0a2e1a', fill: '#166534' },
  { id: 'lime', label: 'Lime', accent: '#a3e635', dim: '#1d2b08', fill: '#4d7c0f' },
  { id: 'amber', label: 'Amber', accent: '#fbbf24', dim: '#33230a', fill: '#b45309' },
  { id: 'orange', label: 'Orange', accent: '#fb923c', dim: '#351805', fill: '#c2410c' },
  { id: 'rose', label: 'Rose', accent: '#fb7185', dim: '#3d0a17', fill: '#be123c' },
  { id: 'fuchsia', label: 'Fuchsia', accent: '#e879f9', dim: '#33093a', fill: '#a21caf' },
  { id: 'violet', label: 'Violet', accent: '#a78bfa', dim: '#231447', fill: '#6d28d9' },
  { id: 'indigo', label: 'Indigo', accent: '#818cf8', dim: '#14183d', fill: '#4338ca' },
  { id: 'sky', label: 'Sky', accent: '#38bdf8', dim: '#082638', fill: '#0369a1' },
  { id: 'teal', label: 'Teal', accent: '#2dd4bf', dim: '#06302c', fill: '#0f766e' },
  { id: 'pearl', label: 'Pearl', accent: '#e5e7eb', dim: '#24262b', fill: '#4b5563' },
]

export const DEFAULT_THEME = THEMES[0]

/** Unknown ids fall back to the default, so a stale settings file cannot blank the UI. */
export const themeById = (id: string | null | undefined): Theme =>
  THEMES.find((t) => t.id === id) ?? DEFAULT_THEME

export const ThemeContext = createContext<Theme>(DEFAULT_THEME)

export const useTheme = (): Theme => useContext(ThemeContext)
