/**
 * Spray a picture at the pairs around you: pick one, turn it on, put the phone away.
 *
 * The policy, the pass structure and every safety property are `spray.ts`; this is the
 * surface. What the screen owes on top of the module:
 *
 *  - **It says what it does to a stranger before it does it.** `HARMLESS_NOTE` is on
 *    screen, not in a docblock, because the person holding the phone is the one who has
 *    to answer "what did you just do to my glasses".
 *  - **It never prints a platform handle.** No event carries one (`spray.ts`), and a
 *    failure is worded by `pairWords`, whose whole job is keeping a MAC off the screen.
 *  - **One row per pair**, keyed on the advert name, so a pair heard on ten passes is one
 *    line that changes rather than ten lines that scroll.
 *  - **The mark is one tap on the row it belongs to.** "Leave them alone" has to work the
 *    moment somebody asks, which is why the run re-reads the policy every pass.
 *  - **Leaving the screen stops the spray.** The run holds the radio, and a spray still
 *    going from a screen nobody is looking at is exactly the nuisance the design rules
 *    out. Said on screen, because it also means the phone stays on this screen.
 *  - **The picker's search is the Show tab's, not a second one.** `library.search` is the
 *    one matcher (`library-screen.test.ts` holds the front door to the same rule), so the
 *    two screens cannot end up disagreeing about what "found" means, and the 30 built-ins
 *    are browsed rather than searched for the reason `builtins.NOT_SEARCHED` gives. A
 *    query narrows what is *offered* and never what is *sent*: the pick is state, so a
 *    query that hides the chosen tile must not quietly change what the button sprays.
 */
import { Glasses, sleep } from '@joggles/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { pairWords } from '../ble-words.js'
import { scanner } from '../ble.js'
import { type Builtin, BUILTINS, NOT_SEARCHED } from '../builtins.js'
import { savedDevices } from '../ledger.js'
import { type SavedItem, search } from '../library.js'
import { nicknames } from '../nicknames-store.js'
import { thumbFor } from '../one-tap.js'
import { Panel } from '../Preview.js'
import { settings } from '../settings-store.js'
import { sprayMemory } from '../spray-store.js'
import {
  HARMLESS_NOTE,
  REACH_NOTE,
  RADIO_NOTE,
  type SprayDeps,
  type SprayEvent,
  type SprayPayload,
  type SprayRun,
  type SprayTally,
  builtinPayload,
  runSpray,
  skipWords,
  stillPayload,
} from '../spray.js'
import { useTheme } from '../theme.js'
import { Card, Fine, FreeButton, INK, Link, Segmented, StatusLine, type Status } from '../ui.js'

/** What the picker is pointing at. Null until a person chooses. */
type Pick =
  | { kind: 'mine'; item: SavedItem }
  | { kind: 'builtin'; builtin: Builtin }

/** One pair, as the log shows it. Keyed on the advert name in a Map, never appended. */
interface Row {
  name: string
  state: 'lit' | 'skipped' | 'failed'
  note: string
  at: number
}

/** How much of the log to draw. Beyond this it is a crowd, not a list to read. */
const ROWS_SHOWN = 40

/**
 * How much saved content earns the field its place above the shelf.
 *
 * Lower than the Show tab's nine (`Library.tsx`'s own `SEARCH_FROM`) because of that
 * number's argument rather than in spite of it: nine is three rows of a grid that has
 * nine tiles under a thumb at once, and this is one horizontal shelf showing about three.
 * Content you have to drag sideways to reach is what a field is for, and on a shelf that
 * starts sooner. Counted in items rather than in matches, so the field does not vanish
 * under the query that emptied the shelf.
 */
const SEARCH_FROM = 6

const REST = {
  brisk: 5_000,
  gentle: 30_000,
} as const

type Pace = keyof typeof REST

const NOTHING: SprayTally = { passes: 0, lit: 0, skipped: 0, failed: 0 }

export function Spray({
  items,
  holding,
  onRelease,
  onBack,
}: {
  items: SavedItem[] | null
  /** The connected pair's name, or null. A spray needs the radio to itself. */
  holding: string | null
  onRelease: () => Promise<void>
  onBack: () => void
}) {
  const theme = useTheme()
  const [pick, setPick] = useState<Pick | null>(null)
  const [query, setQuery] = useState('')
  const [pace, setPace] = useState<Pace>('gentle')
  const [rows, setRows] = useState<Map<string, Row>>(new Map())
  const [tally, setTally] = useState<SprayTally>(NOTHING)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [sprayed, setSprayed] = useState(() => sprayMemory.sprayed())

  const run = useRef<SprayRun | null>(null)
  /** Raised across the await in `start`, where `running` is not yet true. */
  const starting = useRef(false)
  /**
   * Which run's events are worth listening to.
   *
   * A stopped run can still be inside a push, and its `lit` would otherwise land in the
   * next run's log. Bumped on every start, so a late event from run 1 is dropped rather
   * than believed.
   */
  const token = useRef(0)

  // The radio outlives React, so this is not optional: a spray left running from an
  // unmounted screen would scan and connect with nothing on screen saying so.
  useEffect(
    () => () => {
      run.current?.stop()
      run.current = null
    },
    [],
  )

  const payload = useMemo<SprayPayload | null>(() => {
    if (pick === null) return null
    if (pick.kind === 'builtin') return builtinPayload(pick.builtin)
    const frame = thumbFor(pick.item)
    return frame === null ? null : stillPayload(frame, pick.item.name)
  }, [pick])

  const q = query.trim()
  const searching = q !== ''
  const withSearch = (items?.length ?? 0) >= SEARCH_FROM || searching

  /**
   * Yours, narrowed, with a thumbnail each.
   *
   * The frame is resolved here rather than inside the shelf so a count means what it says:
   * an item whose recipe renders to nothing has no tile, and a shelf of dropped tiles
   * cannot be told apart from a search that found nothing. The matcher is `library.search`
   * and it is handed `items` and nothing else, which is what keeps a query off the 30.
   */
  const yours = useMemo(() => {
    const list = q === '' ? (items ?? []) : search(items ?? [], q)
    const out: Array<{ item: SavedItem; frame: number[][] }> = []
    for (const item of list) {
      const frame = thumbFor(item)
      if (frame !== null) out.push({ item, frame })
    }
    return out
  }, [items, q])

  /**
   * The pairs this phone knows, and so leaves alone by default.
   *
   * Three records, all keyed on the advert name: every pair you have named, every pair
   * you have saved to, and the one this phone reconnects to by itself. Read fresh at
   * every start rather than held, because naming a pair on the Glasses tab between two
   * sprays should take it out of the next one.
   */
  const ours = useCallback((): Set<string> => {
    const set = new Set<string>(Object.keys(nicknames.all()))
    for (const device of savedDevices()) set.add(device)
    const last = settings.lastPair()
    if (last !== null) set.add(last)
    return set
  }, [])

  const shown = (name: string): string => nicknames.get(name) ?? name

  function note(name: string, row: Row) {
    setRows((prev) => new Map(prev).set(name, row))
  }

  async function start() {
    // `running` is not raised until the pair has been let go, which leaves a gap two taps
    // fit inside; the ref closes it, because two runs would mean two scans and two
    // connections to the same stranger.
    if (payload === null || running || starting.current) return
    starting.current = true
    setStatus(null)
    if (holding !== null) {
      setStatus({ kind: 'busy', message: 'letting your pair go...' })
      try {
        await onRelease()
      } catch {
        // A disconnect that fails leaves the pair held, and the scan below would drop it
        // silently: better to stop and say so than to spray with the app lying about it.
        setStatus({ kind: 'bad', message: 'could not let your pair go. Nothing started.' })
        starting.current = false
        return
      }
    }

    const mine = (token.current += 1)
    setRows(new Map())
    setTally(NOTHING)
    setStatus({ kind: 'busy', message: 'scanning...' })
    setRunning(true)

    const onEvent = (event: SprayEvent) => {
      if (token.current !== mine) return
      switch (event.kind) {
        case 'pass':
          setStatus({ kind: 'busy', message: `pass ${event.n}: scanning...` })
          break
        case 'lit':
          sprayMemory.lit(event.name, payload.hash)
          setSprayed(sprayMemory.sprayed())
          note(event.name, {
            name: event.name,
            state: 'lit',
            note: `showing "${payload.label}"`,
            at: Date.now(),
          })
          break
        case 'skipped':
          note(event.name, {
            name: event.name,
            state: 'skipped',
            note: skipWords[event.why],
            at: Date.now(),
          })
          break
        case 'failed':
          note(event.name, {
            name: event.name,
            state: 'failed',
            note: pairWords(event.error, shown(event.name)),
            at: Date.now(),
          })
          break
        case 'resting':
          setStatus({
            kind: 'busy',
            message: `radio off for ${Math.round(event.ms / 1000)}s`,
          })
          break
      }
    }

    const started = runSpray(deps, payload, () => sprayMemory.policy(ours()), onEvent, {
      restMs: REST[pace],
    })
    run.current = started
    starting.current = false
    started.done
      .then((final) => {
        if (token.current !== mine) return
        setTally(final)
        setRunning(false)
        run.current = null
        setStatus({
          kind: 'good',
          message:
            final.lit === 0
              ? 'Stopped. Nothing was lit.'
              : `Stopped. ${final.lit} ${final.lit === 1 ? 'pair' : 'pairs'} lit.`,
        })
      })
      .catch((e: unknown) => {
        if (token.current !== mine) return
        setRunning(false)
        run.current = null
        setStatus({ kind: 'bad', message: pairWords(e, null) })
      })
  }

  function stop() {
    setStatus({ kind: 'busy', message: 'stopping after the pair in flight...' })
    run.current?.stop()
  }

  function mark(name: string, as: 'never' | 'always' | null) {
    sprayMemory.mark(name, as)
    // Through the updater, not `rows.get`: a pass landing at the same moment would
    // otherwise be overwritten by whatever this closure captured.
    setRows((prev) => {
      const held = prev.get(name)
      if (held === undefined) return prev
      return new Map(prev).set(name, {
        ...held,
        state: 'skipped',
        note: as === 'never' ? skipWords.never : as === 'always' ? 'fair game' : 'unmarked',
        at: Date.now(),
      })
    })
  }

  const log = [...rows.values()].sort((a, b) => b.at - a.at).slice(0, ROWS_SHOWN)

  return (
    <ScrollView
      contentContainerStyle={styles.wrap}
      // Without `handled`, the first tap on a result only puts the keyboard away and the
      // tile does not fire: the same two-tap pick the Show tab's grid had to avoid.
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <View style={styles.head}>
        <Text style={styles.title}>Spray</Text>
        {/* Stops the run rather than refusing to leave: the tab bar would unmount this
            screen and stop it anyway, so a disabled Back would only be a dead end. */}
        <Link
          label="Back"
          onPress={() => {
            run.current?.stop()
            onBack()
          }}
        />
      </View>

      <Card>
        <Text style={styles.detail}>{HARMLESS_NOTE}</Text>
        <Fine>{RADIO_NOTE}</Fine>
      </Card>

      <Text style={styles.section}>What to spray</Text>
      {withSearch ? (
        <View style={styles.searchRow}>
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="Search what you have saved"
            placeholderTextColor={INK.faint}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            selectionColor={theme.accent}
          />
          {query !== '' ? (
            <Link label="Clear" tone="dim" onPress={() => setQuery('')} />
          ) : null}
        </View>
      ) : null}
      {yours.length > 0 ? (
        <Strip
          label="Yours"
          tiles={yours.map(({ item, frame }) => ({
            key: `mine:${item.id}`,
            frame,
            title: item.name,
            on: pick?.kind === 'mine' && pick.item.id === item.id,
            onPress: () => setPick({ kind: 'mine', item }),
          }))}
        />
      ) : searching ? (
        <Fine>Nothing of yours matches "{q}".</Fine>
      ) : null}
      {/* Browsed rather than searched, and the line says which: a query that filtered
          these would hide most of 30 tiles on labels track 20 made numbers. */}
      {searching ? (
        <Fine>{NOT_SEARCHED}</Fine>
      ) : (
        <Strip
          label="Built in"
          tiles={BUILTINS.map((builtin) => ({
            key: builtin.id,
            frame: builtin.thumb,
            title: builtin.label,
            on: pick?.kind === 'builtin' && pick.builtin.id === builtin.id,
            onPress: () => setPick({ kind: 'builtin', builtin }),
          }))}
        />
      )}

      {searching && payload !== null ? (
        <Fine>"{payload.label}" stays picked while you search.</Fine>
      ) : null}
      {pick !== null && payload === null ? (
        <Fine>Nothing is lit in that one, so there would be nothing to see.</Fine>
      ) : null}
      {payload?.kind === 'builtin' ? (
        <Fine>
          A built-in plays on the glasses' own engine, so it keeps animating after the
          phone has gone.
        </Fine>
      ) : null}

      <Card>
        <View style={styles.paceRow}>
          <Segmented
            options={[
              { id: 'gentle' as Pace, label: 'Gentle' },
              { id: 'brisk' as Pace, label: 'Brisk' },
            ]}
            at={pace}
            onPick={setPace}
          />
        </View>
        <Fine>
          {pace === 'gentle'
            ? 'Radio off for 30s between passes. Kindest to the battery.'
            : 'Radio off for 5s between passes. For walking through a crowd.'}
        </Fine>
        <FreeButton
          label={running ? 'Stop' : holding !== null ? 'Let the pair go and spray' : 'Start'}
          onPress={() => (running ? stop() : void start())}
          disabled={payload === null && !running}
        />
        <StatusLine status={status} />
        {running ? <Fine>Keep this screen open: leaving it stops the spray.</Fine> : null}
      </Card>

      {tally.passes > 0 || log.length > 0 ? (
        <Text style={styles.section}>
          {tally.lit} lit · {rows.size} pairs heard
        </Text>
      ) : null}

      {log.map((row) => {
        const marked = sprayMemory.markOf(row.name)
        return (
          <View key={row.name} style={styles.row}>
            <View style={styles.label}>
              <Text style={styles.name} numberOfLines={1}>
                {shown(row.name)}
              </Text>
              <Text
                style={[
                  styles.note,
                  row.state === 'lit' && { color: theme.accent },
                  row.state === 'failed' && styles.bad,
                ]}
                numberOfLines={2}
              >
                {row.note}
              </Text>
            </View>
            <Link
              label={marked === 'never' ? 'allow' : 'leave alone'}
              tone={marked === 'never' ? 'dim' : 'bad'}
              onPress={() => mark(row.name, marked === 'never' ? null : 'never')}
            />
          </View>
        )
      })}

      {log.length === 0 && !running ? <Fine>{REACH_NOTE}</Fine> : null}

      {sprayed > 0 ? (
        <View style={styles.footer}>
          <Fine>
            {sprayed} {sprayed === 1 ? 'pair has' : 'pairs have'} shown something already,
            and are left alone until the picture changes.
          </Fine>
          <Link
            label="Forget who has been sprayed"
            tone="dim"
            disabled={running}
            onPress={() => {
              sprayMemory.forget()
              setSprayed(0)
            }}
          />
        </View>
      ) : null}
    </ScrollView>
  )
}

/**
 * The wire, built once at module scope.
 *
 * `open` is the only place a platform handle is used and it does not leave: `spray.ts`
 * is handed a `SprayPair`, which has no `save` on it at all. No `budget` is passed to
 * `attach` either, so a stranger's advert name cannot reach this phone's wear ledger -
 * and it never would, because nothing on this path opens a save.
 */
const deps: SprayDeps = {
  scan: (onFound, tuning) => scanner.scan((unit) => onFound(unit), tuning),
  stop: () => scanner.stop(),
  async open(advert) {
    const transport = await scanner.connect(advert.id)
    // 18ms rather than the 10ms default, which is the CLI broadcast's choice for the same
    // reason: a stranger's pair is at the edge of range, BLE negotiates its interval per
    // connection, and a dropped column is silent. 24 columns costs 200ms more.
    return Glasses.attach(transport, advert.name, { pacing: 18 })
  },
  sleep,
}

interface Tile {
  key: string
  frame: number[][] | null
  title: string
  on: boolean
  onPress: () => void
}

/** A horizontal shelf of panels. The picker, twice: yours, then the built-ins. */
function Strip({ label, tiles }: { label: string; tiles: Tile[] }) {
  const theme = useTheme()
  return (
    <View style={styles.strip}>
      <Text style={styles.stripLabel}>{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.shelf}>
          {tiles.map((tile) =>
            tile.frame === null ? null : (
              <Pressable key={tile.key} onPress={tile.onPress}>
                <View
                  style={[styles.tile, tile.on && { borderColor: theme.accent }]}
                >
                  <Panel frame={tile.frame} />
                </View>
                <Text style={styles.tileLabel} numberOfLines={1}>
                  {tile.title}
                </Text>
              </Pressable>
            ),
          )}
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 14, paddingBottom: 24 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: INK.text, fontSize: 22, fontWeight: '700' },
  section: { color: INK.text, fontSize: 15, marginTop: 4 },
  detail: { color: INK.dim, fontSize: 13, lineHeight: 19 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  search: {
    flex: 1,
    backgroundColor: INK.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: INK.line,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: INK.text,
    fontSize: 15,
  },
  strip: { gap: 6 },
  stripLabel: { color: INK.dim, fontSize: 13 },
  shelf: { flexDirection: 'row', gap: 10, paddingVertical: 2 },
  tile: { borderWidth: 1, borderColor: INK.line, borderRadius: 6, padding: 3 },
  tileLabel: { color: INK.faint, fontSize: 11, marginTop: 4, maxWidth: 96 },
  paceRow: { paddingBottom: 4 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: INK.line,
  },
  label: { flexShrink: 1, paddingRight: 12 },
  name: { color: INK.text, fontSize: 16 },
  note: { color: INK.dim, fontSize: 12, marginTop: 2 },
  bad: { color: INK.bad },
  footer: { gap: 6, marginTop: 10, borderTopWidth: 1, borderTopColor: INK.line, paddingTop: 12 },
})
