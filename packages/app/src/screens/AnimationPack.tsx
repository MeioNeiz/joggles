/**
 * Browsing the imported animation pack: hundreds of them, so search is the whole screen.
 *
 * The Show tab's built-in sections are 30 numbered tiles you scroll past. This is a
 * different problem: the pack is a few hundred named things from outside, which is too many
 * to scroll and - unlike the built-ins - genuinely searchable, because every row carries a
 * real name, tags and an author (`animations.ts` explains why that difference is a rule and
 * not an accident). So the search box is at the top and always there, rather than appearing
 * once the list is long enough the way `Library.tsx`'s does.
 *
 * ## It plans, the shell runs
 *
 * No `Glasses`, no `PanelSession`, no `LiveSender`, no session of any kind, and
 * `animation-pack.test.ts` holds this file to that. The saved route goes out through
 * `useTapFlow` like every other screen's; the live route hands the animation up through
 * `onPlay` for the shell to drive, because a frame loop is not one write and cannot be a
 * `Tap`. Draw borrows the sender by callback for the same reason. That split is what lets
 * the whole screen render, search and preview with nothing connected, which is review 17's
 * lesson promoted to the whole app.
 *
 * ## The two routes, and why the sentences are not written here
 *
 * A pack animation can play live, frame by frame off the phone, or be saved as a strip the
 * device pans. Those are genuinely different things and the difference is the one a person
 * will otherwise discover by walking away from their glasses, so both are always shown with
 * their cost. The wording comes from `anim.routeWords()` verbatim rather than being phrased
 * again here: the honesty and the arithmetic that justifies it live in one file, and a
 * screen that re-worded them could drift into promising the wrong thing.
 *
 * ## Why the grid does not animate
 *
 * A tile shows its first frame and says how long its loop is. Animating a few hundred tiles
 * would be a few hundred timers redrawing 216 views each, and the panel preview that
 * actually matters is one tap away and full size. The badge and `loopWords` are how a tile
 * says it moves, which is the answer this app already settled on for the built-ins.
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { anim } from '@joggles/core'
import * as animations from '../animations.js'
import type { Showable, Tap, TapContext, TapResult } from '../one-tap.js'
import { Panel } from '../Preview.js'
import { useTapFlow } from './tap-flow.js'
import {
  Card,
  Chip,
  ChipRow,
  Fine,
  FlashButton,
  FreeButton,
  INK,
  Link,
  StatusLine,
} from '../ui.js'

const PER_ROW = 3

interface Row {
  key: string
  rows: animations.PackRow[]
}

const chunk = (items: animations.PackRow[]): Row[] => {
  const out: Row[] = []
  for (let i = 0; i < items.length; i += PER_ROW) {
    out.push({ key: `r-${i}`, rows: items.slice(i, i + PER_ROW) })
  }
  return out
}

const Tile = memo(function Tile({
  row,
  onPress,
  playing,
}: {
  row: animations.PackRow
  onPress: () => void
  playing: boolean
}) {
  const thumb = useMemo(() => animations.thumbOf(row), [row])
  return (
    <Pressable style={styles.tile} onPress={onPress}>
      <View style={playing ? styles.tileLive : undefined}>
        <Panel frame={thumb} />
      </View>
      <Text numberOfLines={1} style={styles.tileName}>
        {row.name}
      </Text>
      <Text style={styles.tileWords}>
        {animations.moves(row) ? `▶ ${animations.loopWords(row)}` : 'still'}
      </Text>
    </Pressable>
  )
})

/**
 * Step a preview through its frames on the phone.
 *
 * Chained timeouts rather than one interval, because the frames have their own individual
 * hold times and an interval would flatten them to an average. `at` is in the dependency
 * list on purpose: each frame schedules the next.
 */
function useFrameLoop(animation: anim.Animation | null): number {
  const [at, setAt] = useState(0)
  useEffect(() => {
    setAt(0)
  }, [animation])
  useEffect(() => {
    if (animation === null || animation.frames.length < 2) return
    const wait = animation.frameMs[at] ?? anim.ZERO_DELAY_MS
    const timer = setTimeout(() => {
      setAt((n) => (n + 1) % animation.frames.length)
    }, wait)
    return () => clearTimeout(timer)
  }, [animation, at])
  return at
}

export function AnimationPack({
  ctx,
  busy,
  speed,
  playingId,
  onTap,
  onPlay,
  onStop,
  onBack,
}: {
  ctx: TapContext
  busy: boolean
  /** The app-wide scroll speed, carried onto a saved strip's motion. */
  speed: number
  /** The row the shell believes is playing, so the grid can mark it. */
  playingId: string | null
  onTap: (
    what: Showable,
    plan: Tap,
    progress?: (sent: number, total: number) => void,
  ) => Promise<TapResult>
  onPlay: (row: animations.PackRow, animation: anim.Animation) => void
  onStop: () => void
  onBack: () => void
}) {
  const connected = ctx.connected
  // The saved route is an ordinary tap, so it goes through the flow every other screen
  // uses and reports in the same words. The live route cannot: it is a frame loop the
  // shell drives, not one write, which is why `onPlay` exists beside this.
  const flow = useTapFlow({ ctx, busy, onTap })
  const [query, setQuery] = useState('')
  const [moving, setMoving] = useState<boolean | undefined>(undefined)
  const [pack, setPack] = useState<string | undefined>(undefined)
  const [chosen, setChosen] = useState<animations.PackRow | null>(null)

  const filter = useMemo(() => ({ query, moving, pack }), [query, moving, pack])
  const found = useMemo(() => animations.search(filter), [filter])
  const grid = useMemo(() => chunk(found), [found])
  const sources = useMemo(() => animations.packs(), [])

  const preview = useMemo(
    () => (chosen === null ? null : animations.animationOf(chosen)),
    [chosen],
  )
  const at = useFrameLoop(preview)

  const close = useCallback(() => setChosen(null), [])

  return (
    <View style={styles.screen}>
      <View style={styles.head}>
        <Link label="‹ Back" onPress={onBack} />
        <Text style={styles.count}>
          {found.length} of {animations.PACK.length}
        </Text>
      </View>

      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder="Search by name, tag, pack or author"
        placeholderTextColor={INK.dim}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        clearButtonMode="while-editing"
      />

      <ChipRow>
        <Chip on={moving === undefined} onPress={() => setMoving(undefined)} label="Everything" />
        <Chip on={moving === true} onPress={() => setMoving(true)} label="Moving" />
        <Chip on={moving === false} onPress={() => setMoving(false)} label="Still" />
      </ChipRow>

      {sources.length > 1 ? (
        <ChipRow>
          <Chip on={pack === undefined} onPress={() => setPack(undefined)} label="All packs" />
          {sources.map((s) => (
            <Chip
              key={s.name}
              on={pack === s.name}
              onPress={() => setPack(s.name)}
              label={`${s.name} (${s.count})`}
            />
          ))}
        </ChipRow>
      ) : null}

      <StatusLine status={flow.status} />

      {playingId !== null ? (
        <View style={styles.playing}>
          <Text style={styles.playingText}>Playing on the glasses from this phone.</Text>
          <Link label="Stop" onPress={onStop} disabled={busy} />
        </View>
      ) : null}

      <FlatList<Row>
        data={grid}
        keyExtractor={(r) => r.key}
        keyboardShouldPersistTaps="handled"
        // A row is PER_ROW panels and a panel is a View per run, so these two numbers are
        // how many hundred Views stand between a tap and anything on screen. Six rows
        // mounted 18 panels for a screen that shows about six, which is the same defect
        // measured on the Show tab (7.4s to first paint, `panel-runs.ts`).
        initialNumToRender={2}
        windowSize={3}
        maxToRenderPerBatch={2}
        removeClippedSubviews
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{animations.emptyWords(filter)}</Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.gridRow}>
            {item.rows.map((row) => (
              <Tile
                key={row.id}
                row={row}
                playing={row.id === playingId}
                onPress={() => setChosen(row)}
              />
            ))}
          </View>
        )}
      />

      <Modal visible={chosen !== null} transparent animationType="slide" onRequestClose={close}>
        <Pressable style={styles.scrim} onPress={close} />
        <View style={styles.sheet}>
          {chosen !== null && preview !== null ? (
            <>
              <Text style={styles.sheetTitle}>{chosen.name}</Text>
              <Fine>
                {chosen.author.length > 0 ? `${chosen.author}, ` : ''}
                {chosen.pack} · {chosen.licence}
              </Fine>
              <View style={styles.previewPanel}>
                <Panel frame={preview.frames[at] ?? preview.frames[0]} />
              </View>
              <Fine>
                {animations.loopWords(chosen)}
                {anim.hiddenPixels(preview) > 0
                  ? ` · ${anim.hiddenPixels(preview)} lit pixels land where this panel has no LED`
                  : ''}
              </Fine>

              <Card>
                <Text style={styles.routeName}>Play it now</Text>
                <Text style={styles.routeWords}>{anim.routeWords(preview, 'live')}</Text>
                <FreeButton
                  label="Play on the glasses"
                  disabled={!connected || busy}
                  onPress={() => {
                    onPlay(chosen, preview)
                    close()
                  }}
                />
              </Card>

              <Card>
                <Text style={styles.routeName}>Keep it on the glasses</Text>
                <Text style={styles.routeWords}>{anim.routeWords(preview, 'filmstrip')}</Text>
                <FlashButton
                  label="Save to the glasses"
                  disabled={!connected || busy}
                  onPress={() => {
                    flow.show(chosen.name, {
                      kind: 'piece',
                      piece: anim.filmstripPiece(preview, speed),
                    })
                    close()
                  }}
                />
              </Card>

              {!connected ? (
                <Fine>Nothing connected: connect on the Glasses tab. The preview above is
                  this phone drawing it, not the panel.</Fine>
              ) : null}
              <Link label="Close" tone="dim" onPress={close} />
            </>
          ) : null}
        </View>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 12, paddingTop: 8 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  count: { color: INK.dim, fontSize: 13 },
  search: {
    backgroundColor: '#151515',
    borderRadius: 8,
    color: INK.text,
    fontSize: 16,
    marginVertical: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  gridRow: { flexDirection: 'row', justifyContent: 'flex-start' },
  tile: { alignItems: 'center', flex: 1 / PER_ROW, paddingVertical: 8 },
  tileLive: { borderColor: INK.text, borderRadius: 8, borderWidth: 2 },
  tileName: { color: INK.text, fontSize: 12, marginTop: 4, maxWidth: '95%' },
  tileWords: { color: INK.dim, fontSize: 11 },
  playing: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  playingText: { color: INK.text, fontSize: 13 },
  empty: { paddingVertical: 32 },
  emptyText: { color: INK.dim, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  scrim: { backgroundColor: '#000a', flex: 1 },
  sheet: {
    backgroundColor: '#111',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    gap: 8,
    padding: 16,
  },
  sheetTitle: { color: INK.text, fontSize: 18, fontWeight: '600' },
  previewPanel: { alignItems: 'center', paddingVertical: 8 },
  routeName: { color: INK.text, fontSize: 15, fontWeight: '600', marginBottom: 4 },
  routeWords: { color: INK.dim, fontSize: 13, lineHeight: 19, marginBottom: 10 },
})
