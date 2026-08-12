/**
 * The shell: three tabs, one connection, one live sender, one idea of the panel.
 *
 * Rebuilt from the ground up on 2026-08-12 under track 26, to the festival brief in
 * `notes/app-plan.md` ("The redesign"): the library is the front door, a tap shows a
 * thing, and everything the screens share is owned here rather than rediscovered per
 * screen.
 *
 * What this file owns, and why it cannot live lower:
 *
 *  - **The connection.** One BLE link per pair, and a pair held by the vendor app is
 *    simply unavailable, so no screen wonders whether it has a device.
 *  - **The one `PanelSession`.** Two live senders over one connection is the state
 *    `LiveSender` forbids, and it is exactly what two screens building their own
 *    produce. Every live write in the app goes through this one.
 *  - **What the panel is showing.** `live` means unsaved live work a `MODE` would
 *    discard; `resident` is the type 1 hash this pair last acknowledged. Screens
 *    unmount on every tab change, so neither fact can live in one.
 *  - **The library items**, read once and refreshed on change, because all three tabs
 *    show them and a per-screen read is how a delete gets undone by a stale list.
 *  - **The tap runner.** Screens plan taps (`one-tap.planTap`) and show the plan; only
 *    `tap()` below executes one. It raises `wire` so the tab bar cannot take the
 *    screen away mid-handshake, and refreshes residency afterwards.
 *
 * The accent colour is the connected pair's theme (`settings.theme`), so the whole
 * app answers "which pair am I on" at a glance. Disconnected, it wears the default.
 */
import { Glasses, type anim, playlist, playlist as pl } from '@joggles/core'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BackHandler, StyleSheet, View } from 'react-native'
import { FramePlayer } from './src/anim-player.js'
import type * as animations from './src/animations.js'
import { pairWords } from './src/ble-words.js'
import type { SavedItem } from './src/library.js'
import { library } from './src/library-store.js'
import { nicknames } from './src/nicknames-store.js'
import {
  type Showable,
  type Tap,
  type TapDeps,
  type TapResult,
  runTap,
} from './src/one-tap.js'
import { PanelSession } from './src/panel-session.js'
import { cyclerFor, planReel } from './src/reel.js'
import { AnimationPack } from './src/screens/AnimationPack.js'
import { Create } from './src/screens/Create.js'
import { GlassesScreen } from './src/screens/GlassesScreen.js'
import { Library } from './src/screens/Library.js'
import { settings } from './src/settings-store.js'
import { ThemeContext, themeById } from './src/theme.js'
import { INK, TabBar } from './src/ui.js'

type Tab = 'show' | 'create' | 'glasses'

const TABS = [
  { id: 'show', label: 'Show', glyph: '▶' },
  { id: 'create', label: 'Create', glyph: '＋' },
  { id: 'glasses', label: 'Glasses', glyph: '⚙' },
] as const

export default function App() {
  const [tab, setTab] = useState<Tab>('glasses')
  const [glasses, setGlasses] = useState<Glasses | null>(null)
  /** Unsaved live work on the panel: a drawing, a shown message. A MODE discards it. */
  const [live, setLive] = useState(false)
  /** Raised while a tap is on the wire, so the tab bar cannot strand a handshake. */
  const [wire, setWire] = useState(false)
  /** The type 1 hash this pair last acknowledged, or null. Per pair, off its ledger. */
  const [resident, setResident] = useState<string | null>(null)
  const [items, setItems] = useState<SavedItem[] | null>(null)
  const [libTrouble, setLibTrouble] = useState<string | null>(null)
  /** A library item handed to Create for editing. Cleared once Create takes it. */
  const [editing, setEditing] = useState<SavedItem | null>(null)
  /** The library key of what the last tap put on the panel. The "On now" badge. */
  const [showing, setShowing] = useState<string | null>(null)
  /** Bumped when a per-pair setting changes, so the theme re-reads. */
  const [prefsAt, setPrefsAt] = useState(0)
  /** The imported animation pack, a full-screen route off the Show tab. */
  const [packOpen, setPackOpen] = useState(false)
  /** Which pack row the frame player is looping, or null. */
  const [playingPack, setPlayingPack] = useState<string | null>(null)

  const session = useRef<PanelSession | null>(null)
  /**
   * The one frame player, beside the one `PanelSession` and for the same reason.
   *
   * It drives the pack's live route by pushing frames into the session's sender, so two
   * of them would be two owners of one panel. Built per connection and stopped on the way
   * out; `anim-player.ts` explains why it never clears and never leaves DIY.
   */
  const player = useRef<FramePlayer | null>(null)
  // The reel, plus the set it was built for: a different set is a different payload.
  const cycler = useRef<{ current: pl.Cycler | null; key: string }>({
    current: null,
    key: '',
  }).current
  /** Read by deliver's cancel callback mid-upload; a state update would arrive late. */
  const cancelled = useRef(false)

  // Android back walks to the front door before it may leave the app ("Back needs to
  // work more smoothly ... not quit out when it should just go back", 2026-08-12).
  // Refs, because the handler is registered once and must read the current values.
  const tabRef = useRef(tab)
  const wireRef = useRef(false)
  const packRef = useRef(false)
  useEffect(() => {
    tabRef.current = tab
  }, [tab])
  useEffect(() => {
    wireRef.current = wire
  }, [wire])
  useEffect(() => {
    packRef.current = packOpen
  }, [packOpen])
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // Swallowed mid-upload for the same reason the tab bar is: leaving the app
      // strands a DATS handshake the device is still waiting to complete.
      if (wireRef.current) return true
      if (packRef.current) {
        setPackOpen(false)
        return true
      }
      if (tabRef.current !== 'show') {
        setTab('show')
        return true
      }
      return false
    })
    return () => sub.remove()
  }, [])

  /**
   * What to call this pair when a failure has to be said out loud.
   *
   * The nickname if there is one, the advert name otherwise: the same two names the
   * Glasses screen shows, and never the platform handle, which is what ble-plx puts in
   * its own messages (`ble-words.ts`). Resolved here because the screens that catch a
   * BLE failure are below the connection and have no name to hand.
   */
  const pairName = glasses === null ? null : (nicknames.get(glasses.name) ?? glasses.name)

  const refreshItems = useCallback(() => {
    library
      .all()
      .then((got) => {
        setItems(got)
        setLibTrouble(null)
      })
      .catch((e) => setLibTrouble(String((e as Error)?.message ?? e)))
  }, [])

  useEffect(refreshItems, [refreshItems])

  const refreshResident = useCallback(async (g: Glasses | null) => {
    if (g === null) {
      setResident(null)
      return
    }
    try {
      setResident(playlist.residentHash(await g.ledger()))
    } catch {
      setResident(null)
    }
  }, [])

  function open(g: Glasses) {
    session.current = new PanelSession(g, () => {})
    player.current = new FramePlayer({
      target: () => session.current!.live(),
      onError: () => setPlayingPack(null),
    })
    setGlasses(g)
    setLive(false)
    settings.setLastPair(g.name)
    setPrefsAt((n) => n + 1)
    void refreshResident(g)
    // Straight to the front door: connecting is ceremony, showing is the point.
    setTab('show')
  }

  async function close() {
    const s = session.current
    const g = glasses
    // Before the session goes: the loop writes through it, so a player left running
    // would push frames into a sender nobody owns.
    await player.current?.stop().catch(() => {})
    player.current = null
    setPlayingPack(null)
    session.current = null
    setGlasses(null)
    setLive(false)
    setResident(null)
    setShowing(null)
    await s?.end().catch(() => {})
    // 'keep' leaves the panel alone: leaving DIY would restore the vendor's saved
    // image, which looks like stray pixels from nowhere.
    await g?.end('keep').catch(() => {})
  }

  /** Execute a plan a screen showed the user. The one caller of `runTap` in the app. */
  async function tap(
    what: Showable,
    plan: Tap,
    key: string | null = null,
    progress?: (sent: number, total: number) => void,
  ): Promise<TapResult> {
    const g = glasses
    const s = session.current
    if (g === null || s === null) {
      return { showing: false, spent: false, message: 'Nothing connected.' }
    }
    cancelled.current = false
    // A tap takes the panel: `runTap` will `dropped()` the sender for anything that does,
    // and a loop still pushing frames into it would be writing through a sender nobody
    // owns. The player notices a stopped sender by itself, but only this knows to stop
    // first and clear the badge.
    if (playingPack !== null) await stopPack()
    const deps: TapDeps = {
      glasses: g,
      live: () => s.live(),
      dropped: () => s.dropped(),
      cancel: () => cancelled.current,
      // The screen's own status line owns the bar, so the callback comes down from
      // whichever screen the tap started on rather than the shell holding a second
      // copy of "how far has this got".
      progress,
    }
    setWire(true)
    try {
      const out = await runTap(deps, what, plan)
      if (out.showing) {
        setLive(plan.kind === 'live')
        setShowing(key)
      }
      await refreshResident(g)
      return out
    } catch (e) {
      // A link that drops mid-tap reaches here as a rejection, and the screens read
      // the result rather than catching: without this the status line sticks on
      // "sending..." for good and the platform's own wording goes to the log instead
      // of to the person, handle and all.
      return { showing: false, spent: false, message: pairWords(e, pairName) }
    } finally {
      setWire(false)
    }
  }

  /**
   * `tap` with the progress callback in the slot `useTapFlow` actually passes it in.
   *
   * `tap`'s third parameter is the library key; `useTapFlow` calls its `onTap` with the
   * progress callback third. Screens that declared `onTap` as two parameters therefore fed
   * the callback into `key` and left `progress` undefined, so **the upload bar never moved
   * on the Create tab** - track 34's whole feature, silently dead on Message and Effect -
   * and `showing` was handed a function where a string belongs. Found 2026-08-12 while
   * wiring the animation pack onto the same helper. `Library.tsx` is unaffected: it calls
   * `onTap` itself with a real key and never goes through the flow.
   */
  const tapWithProgress = (
    what: Showable,
    plan: Tap,
    progress?: (sent: number, total: number) => void,
  ): Promise<TapResult> => tap(what, plan, null, progress)

  /**
   * Play a pack animation as frames, the one route that shows them as frames.
   *
   * Live work, so `live` goes up: a `MODE` from anywhere discards it. `showing` clears
   * because a pack row is not a library item and the badge would otherwise name whatever
   * was on the panel before.
   */
  function playPack(row: animations.PackRow, animation: anim.Animation) {
    const p = player.current
    if (p === null) return
    p.play(animation)
    setPlayingPack(row.id)
    setLive(true)
    setShowing(null)
  }

  /** Stop the loop. The last frame stays lit, so the panel still holds live work. */
  async function stopPack() {
    await player.current?.stop().catch(() => {})
    setPlayingPack(null)
  }

  /** Put a deleted item back: the undo half of the library's confirm-free delete. */
  async function restore(item: SavedItem) {
    if (item.kind === 'drawing') await library.saveDrawing(item.levels, item.name)
    else if (item.kind === 'text') {
      await library.saveText(item.text, item.motion, item.name, item.font)
    } else await library.saveEffect(item, item.name)
    refreshItems()
  }

  /**
   * Step the favourites reel: several things on one pair for one flash write.
   *
   * The cycler is held here rather than in the screen because it is stateful about the
   * panel and about what the pair holds, and this component owns both. It is rebuilt
   * whenever the set changes, since a different set is a different payload; the ledger
   * hash seeds it, so re-committing a reel the pair already holds is free.
   */
  async function cycle(favourites: SavedItem[]): Promise<TapResult> {
    const g = glasses
    const s = session.current
    if (g === null || s === null) {
      return { showing: false, spent: false, message: 'Nothing connected.' }
    }
    try {
      const ledger = await g.ledger()
      const key = favourites.map((i) => `${i.id}:${i.at}`).join('|')
      if (cycler.current === null || cycler.key !== key) {
        const plan = planReel(favourites, ledger)
        if (plan.problems.length > 0) {
          return { showing: false, spent: false, message: plan.problems.join(' ') }
        }
        cycler.current = cyclerFor(g, s, plan, ledger)
        cycler.key = key
      }
      const out = await cycler.current.next()
      setLive(out.step.kind === 'live')
      setShowing(null)
      await refreshResident(g)
      return {
        showing: true,
        spent: out.cost === 'save',
        message: out.cost === 'save'
          ? `On the glasses: ${out.step.label}. The rest of the set switches free from here.`
          : `On the glasses: ${out.step.label}.`,
      }
    } catch (e) {
      return { showing: false, spent: false, message: pairWords(e, pairName) }
    }
  }

  /** The one clear path: 24 blank columns, the route hardware has actually run. */
  async function clearPanel() {
    const s = session.current
    if (s === null) return
    setWire(true)
    try {
      const sender = await s.live()
      sender.clear({ atomic: false })
      await sender.flush()
      setLive(false)
      setShowing(null)
    } finally {
      setWire(false)
    }
  }

  const theme = themeById(glasses === null ? null : settings.theme(glasses.name))
  void prefsAt

  let body: React.ReactNode
  switch (tab) {
    case 'show':
      body = packOpen ? (
        <AnimationPack
          ctx={{ connected: glasses !== null, resident, liveWork: live }}
          busy={wire}
          speed={settings.defaults().speed}
          playingId={playingPack}
          onTap={tapWithProgress}
          onPlay={playPack}
          onStop={() => void stopPack()}
          onBack={() => setPackOpen(false)}
        />
      ) : (
        <Library
          items={items}
          trouble={libTrouble}
          connected={glasses !== null}
          resident={resident}
          liveWork={live}
          busy={wire}
          showing={showing}
          onTap={tap}
          onEdit={(item) => {
            setEditing(item)
            setTab('create')
          }}
          onDelete={async (item) => {
            await library.remove(item.id)
            refreshItems()
          }}
          onRestore={restore}
          onCycle={cycle}
          onOpenPack={() => setPackOpen(true)}
        />
      )
      break
    case 'create':
      body = (
        <Create
          connected={glasses !== null}
          resident={resident}
          liveWork={live}
          busy={wire}
          onTap={tapWithProgress}
          onKept={refreshItems}
          editing={editing}
          onTook={() => setEditing(null)}
          // Draw's strokes write columns at touch rate, far too hot for tap(): it
          // borrows the one sender directly and reports live work through onLive. The
          // rejection is worded here rather than in the pad, which knows no pair name.
          liveSender={
            glasses === null
              ? null
              : () =>
                  session.current!.live().catch((e) => {
                    throw new Error(pairWords(e, pairName))
                  })
          }
          onLive={(on) => {
            setLive(on)
            // A stroke or a shown message is not a library item: the badge lies if
            // it survives whatever Create just put on the panel.
            setShowing(null)
          }}
        />
      )
      break
    default:
      body = (
        <GlassesScreen
          glasses={glasses}
          items={items}
          resident={resident}
          busy={wire}
          liveWork={live}
          onOpen={open}
          onClose={close}
          onClear={clearPanel}
          onPrefs={() => setPrefsAt((n) => n + 1)}
        />
      )
  }

  return (
    <ThemeContext.Provider value={theme}>
      <View style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.body}>{body}</View>
        <TabBar tabs={[...TABS]} at={tab} onTab={setTab} disabled={wire} />
      </View>
    </ThemeContext.Provider>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: INK.bg },
  body: { flex: 1, paddingHorizontal: 18, paddingTop: 64 },
})
