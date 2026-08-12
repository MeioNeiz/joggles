/**
 * The shared visual language, in one place instead of three private copies.
 *
 * `Row`/`Choice` used to be pasted into every screen (a duplication two reviews
 * flagged and nobody could fix while separate tracks owned the files). The redesign
 * owns everything, so the copies collapse here, and the festival brief sets the
 * ergonomics: big touch targets, dark ground, and one accent colour that comes from
 * the connected pair's theme rather than from a constant - which is the whole
 * "which pair am I on" feature, so no component below names an accent hex directly.
 *
 * Two button shapes carry the repo's one law about money: **the filled button spends
 * flash, the outlined one is free.** The shape is what gets noticed rather than the
 * label, so no screen may fill a free action or outline a costed one.
 *
 * `Sheet` is where a cost sentence lives now. The copy budget in `notes/app-plan.md`
 * says captions get a few words and the one full sentence appears on the step that
 * spends flash: the sheet is that step, made of the same `deliver`/`plan` words the
 * old screens printed inline.
 */
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme } from './theme.js'

/** The non-accent palette. Accents come from the theme, never from here. */
export const INK = {
  bg: '#0b0b0e',
  card: '#17171c',
  line: '#26262c',
  text: '#ececf1',
  dim: '#9a9aa3',
  faint: '#5f5f68',
  bad: '#f87171',
  warn: '#fbbf24',
}

export function Chip({
  on,
  onPress,
  label,
  disabled = false,
}: {
  on: boolean
  onPress: () => void
  label: string
  disabled?: boolean
}) {
  const theme = useTheme()
  return (
    <Pressable
      style={[styles.chip, on && { borderColor: theme.accent, backgroundColor: theme.dim }]}
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
    >
      <Text
        style={[
          styles.chipText,
          on && { color: theme.accent },
          disabled && styles.disabled,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  )
}

export function ChipRow({
  label,
  children,
}: {
  label?: string
  children: React.ReactNode
}) {
  return (
    <View style={styles.chipRow}>
      {label ? <Text style={styles.rowLabel}>{label}</Text> : null}
      <View style={styles.chips}>{children}</View>
    </View>
  )
}

/** The outlined button: always free, and the shape says so. */
export function FreeButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
}) {
  const theme = useTheme()
  return (
    <Pressable
      style={[styles.button, { borderWidth: 1, borderColor: theme.accent }, disabled && styles.off]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.buttonText, { color: theme.accent }, disabled && styles.disabled]}>
        {label}
      </Text>
    </Pressable>
  )
}

/** The filled button: the one that spends flash, or confirms doing so. */
export function FlashButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
}) {
  const theme = useTheme()
  return (
    <Pressable
      style={[styles.button, { backgroundColor: theme.fill }, disabled && styles.off]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.buttonText, { color: INK.text }, disabled && styles.disabled]}>
        {label}
      </Text>
    </Pressable>
  )
}

/** A quiet inline action: rename, delete, show the log. */
export function Link({
  label,
  onPress,
  disabled = false,
  tone = 'accent',
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  tone?: 'accent' | 'bad' | 'dim'
}) {
  const theme = useTheme()
  const color = tone === 'bad' ? INK.bad : tone === 'dim' ? INK.dim : theme.accent
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={10}>
      <Text style={[styles.link, { color }, disabled && styles.disabled]}>{label}</Text>
    </Pressable>
  )
}

export function Card({ children }: { children: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>
}

export type StatusKind = 'busy' | 'good' | 'bad'
export interface Status {
  kind: StatusKind
  message: string
  /**
   * How far an upload has got, 0 to 1. Absent for everything that is not an upload.
   *
   * A full-width loop is ~99 blocks and several seconds of radio, and until this
   * existed the app said "sending..." for the whole of it, which is what "it seems to
   * keep having to send the animation to the device" feels like from the outside: a
   * wait with no evidence that anything is happening.
   */
  progress?: number
}

export function StatusLine({ status }: { status: Status | null }) {
  // Hooks before the early return, or the order changes when a status appears.
  const theme = useTheme()
  if (status === null) return null
  const pct = status.progress
  return (
    <View style={styles.statusWrap}>
      <Text style={[styles.status, status.kind === 'bad' && { color: INK.bad }]}>
        {status.message}
      </Text>
      {pct === undefined ? null : (
        // A bare width fraction rather than an animation: the value only moves when a
        // block is acknowledged, so animating between them would invent progress the
        // radio has not made.
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { backgroundColor: theme.accent }, { width: `${Math.round(Math.min(1, Math.max(0, pct)) * 100)}%` }]} />
        </View>
      )}
    </View>
  )
}

/** Fine print. The copy budget says there should be very little of this. */
export function Fine({ children }: { children: React.ReactNode }) {
  return <Text style={styles.fine}>{children}</Text>
}

export function Bad({ children }: { children: React.ReactNode }) {
  return <Text style={styles.bad}>{children}</Text>
}

export interface MenuOption {
  label: string
  tone?: 'accent' | 'bad' | 'dim'
  onPress: () => void
}

/**
 * A long-press menu: options as a bottom card, dismissed by the scrim.
 *
 * Replaces both the cost sheet (gone by Jacob's 2026-08-12 ruling: taps just go, the
 * budget guard in code is the protection) and `Alert.alert` menus, which cap at
 * three buttons on Android and were about to need four.
 */
export function ActionMenu({
  open,
  title,
  options,
  onClose,
}: {
  open: boolean
  title: string
  options: MenuOption[]
  onClose: () => void
}) {
  const theme = useTheme()
  const colour = (tone?: MenuOption['tone']) =>
    tone === 'bad' ? INK.bad : tone === 'dim' ? INK.dim : theme.accent
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={styles.sheet}>
        <Text style={styles.sheetTitle}>{title}</Text>
        {options.map((option) => (
          <Pressable
            key={option.label}
            style={styles.menuRow}
            onPress={() => {
              onClose()
              option.onPress()
            }}
          >
            <Text style={[styles.menuText, { color: colour(option.tone) }]}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </Modal>
  )
}

export interface TabDef<T extends string> {
  id: T
  label: string
  glyph: string
}

export function TabBar<T extends string>({
  tabs,
  at,
  onTab,
  disabled = false,
}: {
  tabs: TabDef<T>[]
  at: T
  onTab: (tab: T) => void
  /** Raised while an upload is on the wire, so a tab cannot interrupt it. */
  disabled?: boolean
}) {
  const theme = useTheme()
  return (
    <View style={styles.tabBar}>
      {tabs.map((tab) => {
        const active = tab.id === at
        return (
          <Pressable
            key={tab.id}
            style={styles.tab}
            onPress={() => onTab(tab.id)}
            disabled={disabled || active}
          >
            <Text style={[styles.tabGlyph, { color: active ? theme.accent : INK.faint }]}>
              {tab.glyph}
            </Text>
            <Text style={[styles.tabLabel, { color: active ? theme.accent : INK.dim }]}>
              {tab.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/** Segments inside a screen: Message | Draw | Effect. */
export function Segmented<T extends string>({
  options,
  at,
  onPick,
}: {
  options: { id: T; label: string }[]
  at: T
  onPick: (id: T) => void
}) {
  const theme = useTheme()
  return (
    <View style={styles.segments}>
      {options.map((option) => {
        const active = option.id === at
        return (
          <Pressable
            key={option.id}
            style={[styles.segment, active && { backgroundColor: theme.dim }]}
            onPress={() => onPick(option.id)}
          >
            <Text style={[styles.segmentText, active && { color: theme.accent }]}>
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  chip: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: INK.line,
  },
  chipText: { color: INK.dim, fontSize: 14 },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowLabel: { color: INK.dim, fontSize: 13, width: 72 },
  chips: { flexDirection: 'row', gap: 8, flexShrink: 1, flexWrap: 'wrap', alignItems: 'center' },
  // No flexGrow/flexBasis: `flexBasis: 0` inside a column collapsed the sheet's
  // confirm button to a thin unlabelled pill on the handset (2026-08-12). Buttons
  // stretch to their container's width instead.
  button: {
    borderRadius: 10,
    paddingVertical: 15,
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  off: { opacity: 0.45 },
  disabled: { color: INK.faint },
  link: { fontSize: 14 },
  card: {
    backgroundColor: INK.card,
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  status: { color: INK.dim, fontSize: 13 },
  statusWrap: { gap: 6 },
  barTrack: { height: 3, borderRadius: 2, backgroundColor: INK.line, overflow: 'hidden' },
  barFill: { height: 3, borderRadius: 2 },
  fine: { color: INK.faint, fontSize: 12, lineHeight: 17 },
  bad: { color: INK.bad, fontSize: 13, lineHeight: 18 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    backgroundColor: INK.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 32,
    gap: 12,
  },
  sheetTitle: { color: INK.text, fontSize: 17, fontWeight: '600' },
  menuRow: { paddingVertical: 14 },
  menuText: { fontSize: 16 },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: INK.line,
    backgroundColor: INK.bg,
    paddingBottom: 22,
    paddingTop: 6,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 6 },
  tabGlyph: { fontSize: 18 },
  tabLabel: { fontSize: 12 },
  segments: {
    flexDirection: 'row',
    backgroundColor: INK.card,
    borderRadius: 10,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  segmentText: { color: INK.dim, fontSize: 14 },
})
