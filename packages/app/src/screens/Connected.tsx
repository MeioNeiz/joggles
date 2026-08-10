/**
 * A unit is open: compose a message, put it on the glasses, tell them to scroll it.
 *
 * **This screen is the only thing in the app that writes flash, and the whole of it
 * is inside one `onPress`.** Nothing saves from an effect, a timer or a retry: those
 * are the top three entries on the runaway list in `notes/app-plan.md`, and they are
 * not theoretical here - `probe()` in an effect fired twice on the first hardware
 * run, and had that been `save()` it would have been ten page erases for one tap.
 *
 * Two device-side steps, and only the first costs anything. `save()` streams to SRAM
 * and commits with `DATCP`, five page erases; `MODE` then tells the device to display
 * the saved store, free and unlimited. So re-sending the same text with a different
 * direction spends nothing: the budget guard recognises the identical payload, skips
 * it, and the `MODE` still goes out.
 *
 * The button also refuses for three seconds afterwards. The budget guard would throw
 * at that rate anyway; this is so an impatient double-tap reads as a UI that is busy
 * rather than an error message accusing the user of being a loop.
 */
import { Glasses, budget, content, dats, protocol as p } from '@joggles/core'
import type { Identity } from '@joggles/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { Preview } from '../Preview.js'
import { deliver, problems as checkPiece } from '../deliver.js'
import { PRESETS, columnsPerSecond, msPerColumn } from '../speed.js'

/**
 * Stand-ins for the real motion when rendering the bitmap.
 *
 * `content.text` reads only `motion.kind` - a scroll gets a screen-width gap so the
 * message cannot run into its own start - so direction and speed have no effect on
 * the pixels. Saying that here is what lets the bitmap keep its identity while they
 * change, and the preview reverse direction without restarting its clock.
 */
const STATIC: content.Motion = { kind: 'static' }
const SCROLLING: content.Motion = { kind: 'scroll', dir: 0, speed: 0 }

/** `LIGHT n`, and the dispatcher clamps `n` to 1-5. There is no level 0. */
const LEVELS = [1, 2, 3, 4, 5]

type Status = { kind: 'busy' | 'good' | 'bad'; message: string } | null

export function Connected({
  glasses,
  onClose,
  onDraw,
}: {
  glasses: Glasses
  onClose: () => void
  onDraw: () => void
}) {
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [text, setText] = useState('JOGGLES')
  const [scroll, setScroll] = useState(true)
  const [dir, setDir] = useState<0 | 1>(0)
  const [speed, setSpeed] = useState(PRESETS[1].value)
  const [level, setLevel] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [cooling, setCooling] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [saves, setSaves] = useState<number | null>(null)

  // Latched, not merely effect-scoped. Observed firing twice five seconds apart on
  // the first hardware run, which a `[glasses]` dependency does not prevent: Fast
  // Refresh, StrictMode and any remount all re-run it. Probing twice is only
  // wasteful, but it is the same shape as a save in an effect, so the pattern is
  // worth getting right where it is cheap.
  const probed = useRef<Glasses | null>(null)

  useEffect(() => {
    if (probed.current === glasses) return
    probed.current = glasses
    let live = true
    // A dead link rejects the probe - the write itself fails - which with a bare
    // .then() is an unhandled rejection. Identity stays 'identifying...', and the
    // next thing the user tries will say what is actually wrong.
    glasses
      .probe()
      .then((id) => live && setIdentity(id))
      .catch(() => {})
    // Reading the ledger touches local storage only. It is the one number we have
    // about this unit's wear, so it is on the screen rather than in a debug menu.
    glasses.ledger().then((l) => live && setSaves(l.lifetime))
    return () => {
      live = false
    }
  }, [glasses])

  // Content shorter than the panel is left-aligned rather than centred, because
  // `content.text` pads it to 24 columns and that padded buffer is exactly what gets
  // uploaded. A prettier preview would be a preview of something else.
  const bitmap = useMemo(
    () => content.text(text.toUpperCase(), scroll ? SCROLLING : STATIC).bitmap,
    [text, scroll],
  )
  const motion = useMemo<content.Motion>(
    () => (scroll ? { kind: 'scroll', dir, speed } : { kind: 'static' }),
    [scroll, dir, speed],
  )
  // Memoised because a `Content` rebuilt every render never compares equal, which is
  // the second entry on the runaway list in `notes/app-plan.md`.
  const composed = useMemo<content.Content>(
    () => ({ bitmap, route: 'saved', motion }),
    [bitmap, motion],
  )

  const cols = content.width(bitmap)
  const problems = useMemo(() => checkPiece(composed), [composed])

  const cooldown = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (cooldown.current) clearTimeout(cooldown.current)
    },
    [],
  )

  async function send() {
    if (busy || cooling || problems.length > 0) return
    setBusy(true)
    setStatus({ kind: 'busy', message: `uploading ${cols} columns...` })
    try {
      const out = await deliver(glasses, composed)
      setSaves(out.saves)

      const where = scroll ? 'scrolling' : 'on the panel'
      setStatus(
        !out.showing
          ? { kind: 'bad', message: out.reply }
          : out.status === 'skipped'
            ? { kind: 'good', message: `already on the glasses, now ${where}` }
            : out.reply === 'DATCPOK'
              ? { kind: 'good', message: `saved and ${where}. It stays with the phone off` }
              : { kind: 'bad', message: `device replied ${out.reply}` },
      )
    } catch (e) {
      setStatus({
        kind: 'bad',
        message:
          e instanceof budget.BudgetError
            ? e.message
            : `save failed: ${String((e as Error).message ?? e)}`,
      })
    } finally {
      setBusy(false)
      setCooling(true)
      cooldown.current = setTimeout(() => setCooling(false), budget.LIMITS.intervalMs)
    }
  }

  /**
   * Free, no flash, and immediate. Nothing here needs the budget guard.
   *
   * Gated on `busy` all the same: `Glasses` does not serialise `command()` against
   * `save()`, so a brightness tap mid-save puts a LIGHT frame inside the DATS
   * handshake (asserted in `connected.test.ts`). What the firmware's upload state
   * machine makes of that has never been sent to hardware, which is reason enough.
   */
  async function light(n: number) {
    if (busy) return
    setLevel(n)
    await glasses.command(p.brightness(n)).catch(() => {})
  }

  const blocked = busy || cooling || problems.length > 0

  return (
    <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View>
          <Text style={styles.name}>{glasses.name}</Text>
          <Text style={styles.kind}>
            {identity === null
              ? 'identifying...'
              : identity.kind === 'crew'
                ? `crew firmware v${identity.version}`
                : 'stock firmware'}
          </Text>
        </View>
        {/* Both disabled mid-save: leaving this screen while `deliver` is streaming
            would strand a DATS handshake the device is still waiting to complete. */}
        <View style={styles.actions}>
          <Pressable onPress={onDraw} hitSlop={12} disabled={busy}>
            <Text style={[styles.close, busy && styles.disabled]}>Draw</Text>
          </Pressable>
          <Pressable onPress={onClose} hitSlop={12} disabled={busy}>
            <Text style={[styles.close, busy && styles.disabled]}>Disconnect</Text>
          </Pressable>
        </View>
      </View>

      <Preview
        bitmap={bitmap}
        scroll={scroll}
        dir={dir}
        intervalMs={msPerColumn(speed)}
      />

      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder="Type a message"
        placeholderTextColor="#666"
        autoCapitalize="characters"
        autoCorrect={false}
      />

      <Text style={styles.status}>
        {cols} of {content.maxColumns(dats.TYPE_TEXT)} columns
      </Text>

      <Row label="Motion">
        <Choice on={!scroll} onPress={() => setScroll(false)} label="Static" />
        <Choice on={scroll} onPress={() => setScroll(true)} label="Scroll" />
      </Row>

      {scroll ? (
        <>
          <Row label="Direction">
            <Choice on={dir === 0} onPress={() => setDir(0)} label="Dir 0" />
            <Choice on={dir === 1} onPress={() => setDir(1)} label="Dir 1" />
          </Row>
          {/* Dir 0 was watched on hardware 2026-08-09 and moves the text right to
              left. Dir 1 has never been sent, so it stays unlabelled: the vendor
              app's table calls 0 left, which the one observation we have contradicts,
              so predicting 1 from it would be inventing the answer. */}
          <Text style={styles.note}>
            Dir 0 scrolls right to left. Which way Dir 1 goes is unconfirmed
          </Text>
          <Row label="Speed">
            {PRESETS.map((s) => (
              <Choice
                key={s.value}
                on={speed === s.value}
                onPress={() => setSpeed(s.value)}
                label={s.label}
              />
            ))}
          </Row>
          {/* The device's own figure, not the preview's: `SPEED` picks one of ten
              frame divisors and the panel holds each column for that many ticks of
              its 50 Hz clock. The preview runs at the same rate. */}
          <Text style={styles.note}>
            {columnsPerSecond(speed).toFixed(1)} columns per second on the panel,
            {' '}
            {msPerColumn(speed)}ms each
          </Text>
        </>
      ) : null}

      <Row label="Brightness">
        {LEVELS.map((n) => (
          <Choice
            key={n}
            on={level === n}
            onPress={() => light(n)}
            label={String(n)}
            disabled={busy}
          />
        ))}
      </Row>

      <Pressable
        style={[styles.send, blocked && styles.sendOff]}
        onPress={send}
        disabled={blocked}
      >
        <Text style={styles.sendText}>
          {busy ? 'Sending...' : cooling ? 'Wait a moment' : 'Save to glasses'}
        </Text>
      </Pressable>
      <Text style={styles.note}>
        Writes flash: five page erases, whatever the length. Everything else on this
        screen is free.
      </Text>

      {problems.map((problem) => (
        <Text key={problem} style={styles.bad}>
          {problem}
        </Text>
      ))}

      {status ? (
        <Text style={[styles.status, status.kind === 'bad' ? styles.bad : null]}>
          {status.message}
        </Text>
      ) : null}

      {/* The only wear number that exists. Nothing can read a cycle count off the
          device, so this count is it, and it belongs on the screen rather than in a
          debug menu. */}
      <Text style={styles.note}>
        {saves === null
          ? 'reading the ledger...'
          : `${saves} save${saves === 1 ? '' : 's'} to this unit, ever`}
      </Text>
    </ScrollView>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.choices}>{children}</View>
    </View>
  )
}

function Choice({
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
  return (
    <Pressable
      style={[styles.choice, on && styles.choiceOn]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text
        style={[styles.choiceText, on && styles.choiceTextOn, disabled && styles.disabled]}
      >
        {label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 14, paddingBottom: 48 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  name: { color: '#eee', fontSize: 17 },
  kind: { color: '#888', fontSize: 13, marginTop: 2 },
  actions: { flexDirection: 'row', gap: 16 },
  close: { color: '#4ade80', fontSize: 15 },
  disabled: { color: '#444' },
  input: {
    color: '#eee',
    fontSize: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
    paddingVertical: 8,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowLabel: { color: '#888', fontSize: 13, width: 76 },
  choices: { flexDirection: 'row', gap: 8, flexShrink: 1, flexWrap: 'wrap' },
  choice: {
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#333',
  },
  choiceOn: { borderColor: '#4ade80', backgroundColor: '#052e16' },
  choiceText: { color: '#888', fontSize: 14 },
  choiceTextOn: { color: '#4ade80' },
  send: {
    backgroundColor: '#166534',
    borderRadius: 8,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 6,
  },
  sendOff: { backgroundColor: '#1f2937' },
  sendText: { color: '#eee', fontSize: 17 },
  status: { color: '#888', fontSize: 13 },
  bad: { color: '#f87171', fontSize: 13 },
  note: { color: '#555', fontSize: 12, lineHeight: 17 },
})
