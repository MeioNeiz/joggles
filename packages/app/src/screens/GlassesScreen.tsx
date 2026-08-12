/**
 * The pair itself: find it, connect without ceremony, and see what it is holding.
 *
 * Disconnected, this is track 1's scan list with track 14's proximity count and
 * track 10's nickname editor, kept almost verbatim - plus the festival addition:
 * **the remembered pair reconnects by itself.** `settings.lastPair` names the advert
 * this phone last opened, and the first sighting of it this round connects with no
 * tap, because at a festival the connect ceremony is the app's whole cost.
 *
 * Connected, it is the per-pair dashboard the redesign owes: the theme that recolours
 * the app while this pair is connected (so a glance says which pair you are on), the
 * brightness that persists as the default and is applied on connect, what the pair is
 * holding in its flash store (the same fingerprint the library badges), the clear
 * button, and the wear count in `wearWords`'s honest wording with the save log behind
 * a tap.
 *
 * Connecting applies the brightness default before handing the session up: it is the
 * one moment the setting can land without costing anyone a thought.
 */
import { Glasses, type Discovered, protocol as p } from '@joggles/core'
import type { Identity } from '@joggles/core'
import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { pairWords } from '../ble-words.js'
import { FAKE_AVAILABLE, scanner, useFakeGlasses } from '../ble.js'
import { saveLog, wearWords } from '../ledger-shape.js'
import { flashBudget } from '../ledger.js'
import type { SavedItem } from '../library.js'
import { budget } from '@joggles/core'
import { residentItem } from '../one-tap.js'
import { MAX_NICKNAME, nicknameIn } from '../nicknames.js'
import { nicknames } from '../nicknames-store.js'
import {
  type Nearby,
  type Presence,
  bandLine,
  createPresence,
  feed,
  headline,
  signalText,
} from '../proximity.js'
import { settings } from '../settings-store.js'
import { THEMES, useTheme } from '../theme.js'
import { Card, Chip, ChipRow, Fine, FreeButton, INK, Link, StatusLine, type Status } from '../ui.js'
import { Spray } from './Spray.js'

const SCAN_MS = 20_000
const TICK_MS = 1_000

const NOTHING: Nearby = {
  count: 0,
  units: [],
  bands: { reach: 0, room: 0, far: 0, unknown: 0 },
}

const LEVELS = [1, 2, 3, 4, 5]

const clock = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function GlassesScreen({
  glasses,
  items,
  resident,
  busy,
  liveWork,
  onOpen,
  onClose,
  onClear,
  onPrefs,
}: {
  glasses: Glasses | null
  items: SavedItem[] | null
  resident: string | null
  busy: boolean
  liveWork: boolean
  onOpen: (glasses: Glasses) => void
  /** Awaitable: the spray needs the pair actually let go before it takes the radio. */
  onClose: () => Promise<void>
  onClear: () => Promise<void>
  onPrefs: () => void
}) {
  /**
   * The spray lives here because it is the tab about other people's pairs, and because
   * it needs the two things this screen already has: the connection, to let go of, and
   * the scanner. It is checked before `glasses`, so releasing the pair mid-spray does not
   * mount the scan list underneath it and start a second scan against the spray's own.
   */
  const [mode, setMode] = useState<'pairs' | 'spray'>('pairs')

  if (mode === 'spray') {
    return (
      <Spray
        items={items}
        holding={glasses === null ? null : (nicknames.get(glasses.name) ?? glasses.name)}
        onRelease={onClose}
        onBack={() => setMode('pairs')}
      />
    )
  }

  return glasses === null ? (
    <Scan onOpen={onOpen} onSpray={() => setMode('spray')} />
  ) : (
    <Connected
      glasses={glasses}
      items={items}
      resident={resident}
      busy={busy}
      liveWork={liveWork}
      onClose={onClose}
      onClear={onClear}
      onPrefs={onPrefs}
      onSpray={() => setMode('spray')}
    />
  )
}

/** The scan half. Track 1's list, with the remembered pair connecting by itself. */
function Scan({
  onOpen,
  onSpray,
}: {
  onOpen: (glasses: Glasses) => void
  onSpray: () => void
}) {
  const theme = useTheme()
  const [units, setUnits] = useState<Discovered[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [scanning, setScanning] = useState(true)
  const [round, setRound] = useState(0)
  const [names, setNames] = useState<Record<string, string>>(() => nicknames.all())
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [near, setNear] = useState<Nearby>(NOTHING)
  const presence = useRef<Presence | null>(null)
  /** One automatic connect per mount: retrying a failed one would loop on a dead pair. */
  const reached = useRef(false)
  // The auto-connect runs inside the scan callback, where `busy` state would be stale:
  // a ref mirrors it, the same reasoning as one-tap's cancel.
  const busyRef = useRef<string | null>(null)
  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  async function connect(unit: Discovered) {
    setBusy(unit.id)
    setError(null)
    try {
      const transport = await scanner.connect(unit.id)
      // The app's one budget, keyed by the advert name, as track 1 wired it.
      const g = await Glasses.attach(transport, unit.name, { budget: flashBudget })
      // The persisted default, applied at the one moment it costs nobody a thought.
      await g.command(p.brightness(settings.defaults().brightness)).catch(() => {})
      onOpen(g)
    } catch (e) {
      // Said in the name on the row, never the platform handle: `ble-words.ts`.
      setError(pairWords(e, nicknameIn(names, unit.name) ?? unit.name))
      setBusy(null)
      setScanning(false)
    }
  }

  useEffect(() => {
    let live = true
    setScanning(true)
    setNear(NOTHING)
    const tracker = createPresence()
    presence.current = tracker

    const stop = feed(scanner, tracker, {
      onSighting: (unit) => {
        if (!live) return
        setUnits((prev) =>
          prev.some((u) => u.id === unit.id)
            ? prev.map((u) => (u.id === unit.id ? unit : u))
            : [...prev, unit],
        )
        // The festival shortcut: the pair this phone last opened connects on sight.
        if (!reached.current && busyRef.current === null && unit.name === settings.lastPair()) {
          reached.current = true
          void connect(unit)
        }
      },
      onError: (e) => {
        if (!live) return
        // A scan failure belongs to no pair, so it passes through with its own words
        // ("bluetooth permission refused"); the pass is here for the one that names a
        // device anyway, which would otherwise print a handle.
        setError(pairWords(e, null))
        setScanning(false)
      },
    })

    const done = setTimeout(() => {
      if (!live) return
      setNear(presence.current?.nearby(Date.now()) ?? NOTHING)
      setScanning(false)
      stop()
    }, SCAN_MS)

    return () => {
      live = false
      clearTimeout(done)
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round])

  useEffect(() => {
    if (!scanning) return
    const tick = setInterval(() => {
      setNear(presence.current?.nearby(Date.now()) ?? NOTHING)
    }, TICK_MS)
    return () => clearInterval(tick)
  }, [scanning, round])

  function beginRename(unit: Discovered) {
    setDraft(nicknameIn(names, unit.name) ?? '')
    setEditing(unit.id)
  }

  function commitRename(unit: Discovered) {
    nicknames.set(unit.name, draft)
    setNames(nicknames.all())
    setEditing(null)
  }

  const bands = bandLine(near)

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Text style={styles.title}>Glasses</Text>

      <View style={styles.status}>
        {scanning ? <ActivityIndicator color={theme.accent} /> : null}
        <Text style={styles.count}>{headline(near, scanning)}</Text>
      </View>
      {bands ? <Fine>{bands}</Fine> : null}

      {units.map((unit) => {
        if (editing === unit.id) {
          return (
            <View key={unit.id} style={styles.unit}>
              <TextInput
                style={[styles.input, { borderBottomColor: theme.accent }]}
                value={draft}
                onChangeText={setDraft}
                placeholder="Nickname. Empty clears it"
                placeholderTextColor={INK.faint}
                autoFocus
                maxLength={MAX_NICKNAME}
                returnKeyType="done"
                onSubmitEditing={() => commitRename(unit)}
              />
              <Link label="save" onPress={() => commitRename(unit)} />
            </View>
          )
        }
        const nick = nicknameIn(names, unit.name)
        return (
          <Pressable
            key={unit.id}
            style={styles.unit}
            onPress={() => connect(unit)}
            disabled={busy !== null}
          >
            <View style={styles.label}>
              <Text style={styles.name} numberOfLines={1}>
                {nick ?? unit.name}
              </Text>
              {nick ? (
                <Text style={styles.advert} numberOfLines={1}>
                  {unit.name}
                </Text>
              ) : null}
            </View>
            <View style={styles.side}>
              <Text style={styles.rssi}>
                {busy === unit.id ? 'connecting...' : signalText(unit.rssi)}
              </Text>
              <Link
                label={nick ? 'rename' : 'name'}
                onPress={() => beginRename(unit)}
                disabled={busy !== null}
              />
            </View>
          </Pressable>
        )
      })}

      {units.length === 0 && scanning && !error ? (
        <Fine>A pair held by another app will not appear: one connection per device.</Fine>
      ) : null}

      {error ? <Text style={styles.bad}>{error}</Text> : null}

      {!scanning ? (
        <FreeButton
          label={units.length === 0 ? 'Nothing found. Scan again' : 'Scan again'}
          onPress={() => setRound((n) => n + 1)}
        />
      ) : null}

      {/* The other half of "pairs nearby": the ones that are not yours. Free, and it
          writes nothing to anybody's memory, which is why it is a link and not a sheet. */}
      <View style={styles.spray}>
        <Link label="Spray a picture at pairs nearby" onPress={onSpray} />
        <Fine>One still picture, no flash, and one push per pair.</Fine>
      </View>

      <SimulatedPair onChanged={() => setRound((n) => n + 1)} />
    </ScrollView>
  )
}

/**
 * The dev-build switch for the simulated pair (`fake-glasses.ts`, track 40).
 *
 * Renders nothing at all in a release build, rather than rendering disabled: a
 * control a festival user can see and cannot use is a support question, and this one
 * would read as "my glasses might be fake", which is the worst possible thing for it
 * to suggest. `FAKE_AVAILABLE` is `__DEV__`, so the whole subtree is dead code the
 * bundler drops.
 */
function SimulatedPair({ onChanged }: { onChanged: () => void }) {
  const [on, setOn] = useState(false)
  if (!FAKE_AVAILABLE) return null
  return (
    <View style={styles.dev}>
      <Fine>
        {on
          ? 'Simulated pairs only. Nothing here is evidence about the real panel.'
          : 'Dev build: drive the app with no hardware attached.'}
      </Fine>
      <Link
        label={on ? 'use real glasses' : 'use simulated glasses'}
        onPress={() => {
          const next = !on
          void useFakeGlasses(next).then((got) => {
            setOn(got)
            onChanged()
          })
        }}
      />
    </View>
  )
}

/** The connected half: this pair, its colour, its memory, its wear. */
function Connected({
  glasses,
  items,
  resident,
  busy,
  liveWork,
  onClose,
  onClear,
  onPrefs,
  onSpray,
}: {
  glasses: Glasses
  items: SavedItem[] | null
  resident: string | null
  busy: boolean
  liveWork: boolean
  /** Awaitable: the spray needs the pair actually let go before it takes the radio. */
  onClose: () => Promise<void>
  onClear: () => Promise<void>
  onPrefs: () => void
  onSpray: () => void
}) {
  const theme = useTheme()
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [level, setLevel] = useState(settings.defaults().brightness)
  const [ledger, setLedger] = useState<budget.DeviceLedger | null>(null)
  const [log, setLog] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)

  // Latched, not merely effect-scoped: probe() fired twice on the first hardware run
  // under Fast Refresh, and the latch outside React's lifecycle is the shape that
  // stops it (the same defect as a save in an effect, caught where it is cheap).
  const probed = useRef<Glasses | null>(null)
  useEffect(() => {
    if (probed.current === glasses) return
    probed.current = glasses
    let alive = true
    glasses
      .probe()
      .then((id) => alive && setIdentity(id))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [glasses])

  useEffect(() => {
    let alive = true
    glasses
      .ledger()
      .then((l) => alive && setLedger(l))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [glasses, resident])

  const nickname = nicknames.get(glasses.name)
  const holding = residentItem(items ?? [], resident)

  async function light(n: number) {
    if (busy) return
    setLevel(n)
    settings.setDefaults({ brightness: n })
    await glasses.command(p.brightness(n)).catch(() => {})
  }

  async function clear() {
    setStatus({ kind: 'busy', message: 'clearing...' })
    try {
      await onClear()
      setStatus({ kind: 'good', message: 'panel cleared. Free' })
    } catch (e) {
      setStatus({
        kind: 'bad',
        message: `could not clear it: ${pairWords(e, nickname ?? glasses.name)}`,
      })
    }
  }

  const rows = ledger ? saveLog(ledger) : []

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Text style={styles.title}>Glasses</Text>

      <Card>
        <View style={styles.cardHead}>
          <View style={styles.label}>
            <Text style={styles.name}>{nickname ?? glasses.name}</Text>
            <Text style={styles.advert}>
              {nickname ? `${glasses.name} · ` : ''}
              {identity === null
                ? 'identifying...'
                : identity.kind === 'crew'
                  ? `crew firmware v${identity.version}`
                  : 'stock firmware'}
            </Text>
          </View>
          <Link label="Disconnect" onPress={onClose} disabled={busy} />
        </View>

        {/* The pair's colour: the whole app wears it while this pair is connected. */}
        <View style={styles.swatches}>
          {THEMES.map((t) => (
            <Pressable
              key={t.id}
              onPress={() => {
                settings.setTheme(glasses.name, t.id)
                onPrefs()
              }}
              hitSlop={6}
            >
              {/* Selected is a ring in the swatch's own colour, not a white one: the
                  palette's neutral is near-white and a white ring disappears on it. */}
              <View style={[styles.ring, theme.id === t.id && { borderColor: t.accent }]}>
                <View style={[styles.swatch, { backgroundColor: t.accent }]} />
              </View>
            </Pressable>
          ))}
        </View>

        <ChipRow label="Panel">
          {LEVELS.map((n) => (
            <Chip
              key={n}
              on={level === n}
              onPress={() => void light(n)}
              label={String(n)}
              disabled={busy}
            />
          ))}
        </ChipRow>
        <Fine>Brightness, kept as the default and set on connect.</Fine>
      </Card>

      <Card>
        <Text style={styles.name}>On the glasses</Text>
        <Text style={styles.detail}>
          {liveWork
            ? 'Live work from this phone. It is not saved: it goes at power off, and ' +
              'sending anything saved replaces it.'
            : holding !== null
              ? `Holding "${holding.name}" in memory. It survives power off, and comes ` +
                'back free from the Show tab.'
              : 'Holding its own content. Whatever this phone saves will replace one ' +
                'saved thing: the glasses keep exactly one.'}
        </Text>
        <View style={styles.actions}>
          <Link label="Clear the panel" onPress={() => void clear()} disabled={busy} />
        </View>
        <StatusLine status={status} />
      </Card>

      <Card>
        <Text style={styles.name}>Pairs that are not yours</Text>
        <Text style={styles.detail}>
          Spray one still picture at the pairs around you. It writes nothing to their
          memory, and this pair is let go while it runs.
        </Text>
        <View style={styles.actions}>
          <Link label="Spray at pairs nearby" onPress={onSpray} disabled={busy} />
        </View>
      </Card>

      <Card>
        <Text style={styles.detail}>{ledger === null ? '...' : wearWords(ledger)}</Text>
        {rows.length > 0 ? (
          <Link
            label={log ? 'Hide the save log' : `Show the last ${rows.length} saves`}
            tone="dim"
            onPress={() => setLog(!log)}
          />
        ) : null}
        {log
          ? rows.map((row) => (
              <Fine key={`${row.at}-${row.hash}`}>
                {clock(row.at)} | {row.columns} cols | {row.hash}
                {row.ok ? '' : ' | not acknowledged'}
                {row.repeat ? ' | repeat' : ''}
              </Fine>
            ))
          : null}
      </Card>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 14, paddingBottom: 24 },
  dev: { gap: 6, marginTop: 28, borderTopWidth: 1, borderTopColor: INK.line, paddingTop: 14 },
  title: { color: INK.text, fontSize: 22, fontWeight: '700' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  count: { color: INK.text, fontSize: 15 },
  unit: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: INK.line,
  },
  label: { flexShrink: 1, paddingRight: 12 },
  name: { color: INK.text, fontSize: 16 },
  advert: { color: INK.faint, fontSize: 12, marginTop: 2 },
  detail: { color: INK.dim, fontSize: 13, lineHeight: 19 },
  side: { alignItems: 'flex-end', gap: 4 },
  rssi: { color: INK.dim, fontSize: 13 },
  input: {
    flex: 1,
    color: INK.text,
    fontSize: 16,
    paddingVertical: 4,
    marginRight: 16,
    borderBottomWidth: 1,
  },
  bad: { color: INK.bad, fontSize: 13 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  // Wraps because the palette outgrew one phone width at eleven entries: a row that
  // cannot wrap squeezes the last swatches off the card rather than moving them down.
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingVertical: 4 },
  ring: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatch: { width: 26, height: 26, borderRadius: 13 },
  actions: { flexDirection: 'row', gap: 18 },
  spray: { gap: 6, marginTop: 18 },
})
