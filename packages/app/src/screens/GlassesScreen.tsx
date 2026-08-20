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
 * **What the pair is carrying is printed here and worked out nowhere near here.** The
 * shell probes once per connection and hands the answer down; every sentence comes out
 * of `carried.ts` verbatim, the same arrangement as `ble-words.ts` and `deliver.ts`'s
 * `costOf()`. This screen reads no version number and touches no capability bitmap, and
 * `carried.test.ts` fails the build if it starts to.
 *
 * Connecting applies the brightness default before handing the session up: it is the
 * one moment the setting can land without costing anyone a thought.
 */
import { Glasses, protocol as p } from '@joggles/core'
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
import { FAKE_AVAILABLE, scanner, useFakeGlasses, usingFakeGlasses } from '../ble.js'
import {
  type Carried,
  beyondWords,
  carriedLabel,
  carriedWords,
  refusedWords,
  rememberedWords,
} from '../carried.js'
import { saveLog, wearWords } from '../ledger-shape.js'
import { flashBudget } from '../ledger.js'
import type { SavedItem } from '../library.js'
import { budget } from '@joggles/core'
import { residentItem } from '../one-tap.js'
import { MAX_NICKNAME, nicknameIn } from '../nicknames.js'
import { nicknames } from '../nicknames-store.js'
import {
  type Nearby,
  type NearUnit,
  type Presence,
  bandLine,
  createPresence,
  feed,
  headline,
  rows as nearbyRows,
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
  carried,
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
  /** What the shell's probe answered for this pair, or null until it has. */
  carried: Carried | null
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
      carried={carried}
      busy={busy}
      liveWork={liveWork}
      onClose={onClose}
      onClear={onClear}
      onPrefs={onPrefs}
      onSpray={() => setMode('spray')}
    />
  )
}

/**
 * The scan half. Track 1's list, with the remembered pair connecting by itself.
 *
 * **The rows are `near`, not a list beside it.** Track 66: this screen used to append
 * every sighting to a `Discovered[]` that nothing ever emptied, so the header counted the
 * pairs the current source was advertising while the rows accumulated every pair any
 * source had ever advertised. Switching to the simulated pairs left the real unit on
 * screen at a frozen -57 dBm, above a caption reading "simulated pairs only". Rows and
 * count are one array now (`proximity.rows`), and `busy`/`editing` are keyed on the
 * advert name because that is the identity everywhere else in this app.
 */
function Scan({
  onOpen,
  onSpray,
}: {
  onOpen: (glasses: Glasses) => void
  onSpray: () => void
}) {
  const theme = useTheme()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [scanning, setScanning] = useState(true)
  const [round, setRound] = useState(0)
  const [names, setNames] = useState<Record<string, string>>(() => nicknames.all())
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [near, setNear] = useState<Nearby>(NOTHING)
  /**
   * Which source the rows came from, asked of the scanner rather than remembered.
   *
   * Read at mount because this component is rebuilt on every disconnect and every visit
   * to the tab, and the switch below is module state that outlives it.
   */
  const [simulated, setSimulated] = useState(usingFakeGlasses)
  const presence = useRef<Presence | null>(null)
  /** One automatic connect per mount: retrying a failed one would loop on a dead pair. */
  const reached = useRef(false)
  // The auto-connect runs inside the scan callback, where `busy` state would be stale:
  // a ref mirrors it, the same reasoning as one-tap's cancel.
  const busyRef = useRef<string | null>(null)
  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  async function connect(unit: { id: string; name: string }) {
    setBusy(unit.name)
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
        // No row is built here. `saw` has already folded this advert into `tracker`, and
        // the tick below is what publishes it: a row is a member of that map.
        //
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

  function beginRename(unit: NearUnit) {
    setDraft(nicknameIn(names, unit.name) ?? '')
    setEditing(unit.name)
  }

  function commitRename(unit: NearUnit) {
    nicknames.set(unit.name, draft)
    setNames(nicknames.all())
    setEditing(null)
  }

  const bands = bandLine(near)
  // The rows ARE the count, re-ordered. `listed.length === near.count` is arithmetic
  // here, not a rule anyone has to keep.
  const listed = nearbyRows(near)

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Text style={styles.title}>Glasses</Text>

      <View style={styles.status}>
        {scanning ? <ActivityIndicator color={theme.accent} /> : null}
        <Text style={styles.count}>{headline(near, scanning)}</Text>
      </View>
      {bands ? <Fine>{bands}</Fine> : null}
      {/* Beside the list it describes, not three screens below it: this sentence is the
          only thing standing between a simulated render and someone quoting it as
          evidence, and track 66 found it captioning a real pair from the bottom of the
          page. What makes it true is `ble.ts`'s `onlyFrom`, not its placement. */}
      {simulated ? (
        <Fine>Simulated pairs only. Nothing here is evidence about the real panel.</Fine>
      ) : null}

      {listed.map((unit) => {
        if (editing === unit.name) {
          return (
            <View key={unit.name} style={styles.unit}>
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
        const handle = unit.id
        return (
          <Pressable
            key={unit.name}
            style={styles.unit}
            onPress={() => handle !== null && void connect({ id: handle, name: unit.name })}
            disabled={busy !== null || handle === null}
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
                {busy === unit.name ? 'connecting...' : signalText(unit.rssi)}
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

      {listed.length === 0 && scanning && !error ? (
        <Fine>A pair held by another app will not appear: one connection per device.</Fine>
      ) : null}

      {error ? <Text style={styles.bad}>{error}</Text> : null}

      {!scanning ? (
        <FreeButton
          label={listed.length === 0 ? 'Nothing found. Scan again' : 'Scan again'}
          onPress={() => setRound((n) => n + 1)}
        />
      ) : null}

      {/* The other half of "pairs nearby": the ones that are not yours. Free, and it
          writes nothing to anybody's memory, which is why it is a link and not a sheet. */}
      <View style={styles.spray}>
        <Link label="Spray a picture at pairs nearby" onPress={onSpray} />
        <Fine>One still picture, no flash, and one push per pair.</Fine>
      </View>

      <SimulatedPair
        on={simulated}
        onChanged={(now) => {
          setSimulated(now)
          setRound((n) => n + 1)
        }}
      />
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
 *
 * **It holds no state of its own.** It used to hold `on`, and it is rebuilt on every
 * disconnect and every visit to this tab while the switch itself is module state that
 * outlives it, so one switch and one disconnect left the app on the simulated pairs with
 * this control offering to turn them on. Track 66: the owner is `Scan`, which asks the
 * scanner, and `useFakeGlasses` reports what actually happened rather than what was asked
 * for - a release build answers false.
 */
function SimulatedPair({
  on,
  onChanged,
}: {
  on: boolean
  onChanged: (simulated: boolean) => void
}) {
  if (!FAKE_AVAILABLE) return null
  return (
    <View style={styles.dev}>
      <Fine>
        {on
          ? 'The rows above are simulated pairs. Nothing here is evidence about the real panel.'
          : 'Dev build: drive the app with no hardware attached.'}
      </Fine>
      <Link
        label={on ? 'use real glasses' : 'use simulated glasses'}
        onPress={() => {
          void useFakeGlasses(!on).then(onChanged)
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
  carried,
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
  carried: Carried | null
  busy: boolean
  liveWork: boolean
  /** Awaitable: the spray needs the pair actually let go before it takes the radio. */
  onClose: () => Promise<void>
  onClear: () => Promise<void>
  onPrefs: () => void
  onSpray: () => void
}) {
  const theme = useTheme()
  const [level, setLevel] = useState(settings.defaults().brightness)
  const [ledger, setLedger] = useState<budget.DeviceLedger | null>(null)
  const [log, setLog] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)

  /**
   * What this pair answered last time, read once at mount.
   *
   * Fills the line while the shell's probe is still out, so a reconnect at a festival
   * is not a blank. It decides nothing: the type will not let it reach the gate.
   */
  const recalled = useRef(rememberedWords(settings.carried(glasses.name))).current

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
  const beyond = beyondWords(carried)
  const refused = refusedWords(carried)

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
              {carriedLabel(carried)}
            </Text>
          </View>
          <Link label="Disconnect" onPress={onClose} disabled={busy} />
        </View>

        {/* Every line below is `carried.ts` printed verbatim. A stock pair gets one
            sentence, which exists to say that stock is the ordinary answer; a crew pair
            gets that plus whatever it reports that this app has no control for, plus the
            refusal if it says it can take firmware. Every pair we can meet today is
            stock, so the other lines are unreachable rather than merely unseen - and the
            stock one has not been rendered on a handset either. */}
        <Fine>{carriedWords(carried)}</Fine>
        {carried === null && recalled !== null ? <Fine>{recalled}</Fine> : null}
        {beyond !== null ? <Fine>{beyond}</Fine> : null}
        {refused !== null ? <Fine>{refused}</Fine> : null}

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
