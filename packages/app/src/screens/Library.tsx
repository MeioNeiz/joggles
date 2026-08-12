/**
 * The front door: everything showable, one tap to put it on the glasses.
 *
 * Second pass, rebuilt to the first-contact feedback (2026-08-12, verbatim in
 * `notes/what-to-build.md`):
 *
 *  - **No cost copy anywhere.** Tags, sentences and confirm sheets are gone by
 *    Jacob's ruling: a tap just goes, and the budget guard in code is what actually
 *    protects the flash. The planner still refuses the two real mistakes (dark
 *    upload, disconnected send) with one status line.
 *  - **Built-ins are bare tiles in a grid.** They are numbered, not named, so a label
 *    carries nothing the picture does not, and "Free" on a thing that is always free
 *    was noise. Long-press pins one to Favourites or hides it.
 *  - **Favourites first**: the pinned grid at the top, because switching between a
 *    handful of things in a field is the whole use. Keys live in `settings.ts`.
 *  - **Mine is a tile grid like everything else**, long-pressed for its menu. Delete
 *    is instant with Undo in the status line, never a confirm. *Corrected 2026-08-12:
 *    this said "Mine rows swipe", which was true for about an hour. The swipe rows
 *    were superseded the same afternoon by tiles ("Why does mine still show the name
 *    and everyting, it should be like the others") and a stale docblock is the failure
 *    `notes/WRITING.md` names.*
 *  - **"On now" follows what is showing**, a fact the shell owns; being saved in the
 *    pair's flash is demoted to a word in the row's detail, because the badge
 *    conflating the two is exactly what confused the first session.
 *
 * **Search reaches your own things and cannot reach the built-ins** (track 28, and the
 * reasoning is `notes/library.md`, "Search reaches our things and cannot reach the
 * built-ins"): the 30 are numbered rather than named because nobody has watched them,
 * so there is nothing to match on and a name invented from an offline render would be
 * a guess a person then searches for and fails to find. The screen says that rather
 * than returning a silent nothing. Three rules keep the field from undoing the
 * redesign - this is a festival front door, one hand, seconds of attention:
 *
 *  - it appears only once there is enough saved for browsing to be work (`SEARCH_FROM`),
 *    and while a query is live so it can never strand one it is hiding;
 *  - it never takes focus on mount, because a keyboard over the grid is the opposite of
 *    one-tap;
 *  - while a query is live the favourites grid and both built-in sections step aside, so
 *    everything on the screen is a match and the one line below says what is not being
 *    searched.
 *
 * This screen still touches no wire and holds no session: it plans with `planTap`
 * and hands the plan to the shell's runner. `builtins.test.ts` crawls this source to
 * keep it that way, and `library-screen.test.ts` holds the search rules above.
 */
import { content, display, motifs, viewport } from '@joggles/core'
import { memo, useCallback, useMemo, useState } from 'react'
import * as animations from '../animations.js'
import {
  Modal,
  Pressable,
  SectionList,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from 'react-native'
import {
  ANIMATIONS,
  type Builtin,
  IMAGES,
  NOT_SEARCHED,
  builtinById,
} from '../builtins.js'
import { type SavedItem, search } from '../library.js'
import {
  type Showable,
  type Tap,
  type TapResult,
  pieceFor,
  planTap,
  thumbFor,
} from '../one-tap.js'
import { MIN_ITEMS, reelResident } from '../reel.js'
import { settings } from '../settings-store.js'
import { DEFAULT_THEME, THEMES, useTheme } from '../theme.js'
import { ActionMenu, Chip, ChipRow, INK, Link, type MenuOption, type Status } from '../ui.js'

/** Rows top-first, because row 0 is the bottom of the panel. As `Preview.tsx`. */
const ORDER = Array.from({ length: display.ROWS }, (_, i) => display.ROWS - 1 - i)

const ALIVE = Array.from({ length: display.ROWS }, (_, r) =>
  Array.from({ length: display.COLS }, (_, c) => display.alive(r, c)),
)

const PER_ROW = 3

/**
 * How much saved content earns a search field its place at the top of the screen.
 *
 * Three full rows of tiles: below that, everything a person has is already under their
 * thumb and a field would be a control that cannot pay for itself, which is the
 * complaint the whole redesign came from. It is a count of items rather than of
 * matches, so the field does not vanish under the query that emptied the grid.
 */
const SEARCH_FROM = PER_ROW * 3

/*
 * What search does not reach is `builtins.NOT_SEARCHED`, printed on the empty state
 * below: a grid that appears to have lost 30 things is the alternative, and the sentence
 * moved out of this file once the spray's picker needed the same one.
 */

interface TileData {
  key: string
  frame: content.Bitmap | null
  title: string
  what: Showable
  /** Whether it animates on the panel, so a loop and a picture read differently. */
  moves: boolean
}

type Row =
  | { key: string; kind: 'grid'; tiles: TileData[] }
  | { key: string; kind: 'none'; words: string }

interface Group {
  key: string
  title: string | null
  data: Row[]
}

const mineKey = (item: SavedItem): string => `mine:${item.id}`

const chunk = (tiles: TileData[], prefix: string): Row[] => {
  const rows: Row[] = []
  for (let i = 0; i < tiles.length; i += PER_ROW) {
    rows.push({ key: `${prefix}-${i}`, kind: 'grid', tiles: tiles.slice(i, i + PER_ROW) })
  }
  return rows
}

/**
 * A drawn motif as a tile. Free to show when it fits the panel, which all but the
 * rolling loop do: 24 columns is the live buffer and the live buffer costs nothing.
 */
const motifTile = (motif: motifs.Motif): TileData => {
  const bitmap = motif.make()
  return {
    key: `motif:${motif.name}`,
    frame: viewport.windowAt(bitmap, 0),
    title: motif.label,
    what: {
      kind: 'piece',
      piece: {
        bitmap,
        route: motif.wide ? 'saved' : 'live',
        motion: motif.wide
          ? { kind: 'scroll', dir: settings.defaults().dir, speed: settings.defaults().speed }
          : { kind: 'static' },
      },
    },
    moves: motif.wide,
  }
}

const builtinTile = (b: Builtin): TileData => ({
  key: b.id,
  frame: viewport.windowAt(b.thumb, 0),
  title: b.label,
  what: { kind: 'builtin', builtin: b },
  moves: b.frames > 1,
})

const mineTile = (item: SavedItem): TileData => ({
  key: mineKey(item),
  frame: thumbFor(item),
  title: item.name,
  what: { kind: 'piece', piece: pieceFor(item) },
  moves: pieceFor(item).motion.kind === 'scroll',
})

export function Library({
  items,
  trouble,
  connected,
  resident,
  liveWork,
  busy,
  showing,
  onTap,
  onEdit,
  onDelete,
  onRestore,
  onCycle,
  onOpenPack,
}: {
  items: SavedItem[] | null
  trouble: string | null
  connected: boolean
  resident: string | null
  liveWork: boolean
  busy: boolean
  /** The key of what the last tap put on the panel, or null. The shell's fact. */
  showing: string | null
  onTap: (what: Showable, plan: Tap, key: string) => Promise<TapResult>
  /** Step the favourites reel: one save for the set, then free switching. */
  onCycle?: (favourites: SavedItem[]) => Promise<TapResult>
  onEdit: (item: SavedItem) => void
  onDelete: (item: SavedItem) => Promise<void>
  /** Puts a deleted item back. The undo half of confirm-free delete. */
  onRestore: (item: SavedItem) => Promise<void>
  /**
   * Open the imported animation pack, which is its own screen rather than a section here.
   *
   * The built-in sections below are 30 tiles you scroll past; the pack is hundreds of
   * named things and needs a search box of its own, so it gets a route instead of a row.
   */
  onOpenPack?: () => void
}) {
  const theme = useTheme()
  const [status, setStatus] = useState<Status | null>(null)
  const [menu, setMenu] = useState<{ title: string; options: MenuOption[] } | null>(null)
  const [undo, setUndo] = useState<SavedItem | null>(null)
  /** The tile a new group is being named for, or null. */
  const [naming, setNaming] = useState<TileData | null>(null)
  const [groupName, setGroupName] = useState('')
  const [withHidden, setWithHidden] = useState(false)
  const [query, setQuery] = useState('')
  /** Bumped when favourites, hidden or groups change, so the memos re-read settings. */
  const [pinsAt, setPinsAt] = useState(0)
  /** The group being browsed, by name. Null is all favourites. */
  const [group, setGroup] = useState<string | null>(null)
  /**
   * Narrowing the gallery WITHOUT pretending to search it.
   *
   * "Even on the main gallery thing it should be easy to find images" (Jacob,
   * 2026-08-12), which is not a request for a text box over the built-ins: they are
   * numbered rather than named, so there is nothing to type (`notes/library.md`). What
   * the app does know about every tile is whether it moves, and that halves the grid in
   * one tap, which is the honest version of the same ask.
   */
  const [only, setOnly] = useState<'all' | 'moves' | 'still'>('all')

  const q = query.trim()
  const searching = q !== ''
  /** Shown while a query is live too, so the field can never hide the thing it filters. */
  const withSearch = (items?.length ?? 0) >= SEARCH_FROM || searching

  const show = useCallback(
    (tile: TileData) => {
      if (busy) return
      const plan = planTap(tile.what, { connected, resident, liveWork })
      if (plan.kind === 'blocked') {
        setStatus({ kind: 'bad', message: plan.why.join(' ') })
        return
      }
      setUndo(null)
      setStatus({ kind: 'busy', message: `sending ${tile.title}...` })
      void onTap(tile.what, plan, tile.key).then((out) =>
        setStatus({ kind: out.showing ? 'good' : 'bad', message: out.message }),
      )
    },
    [busy, connected, liveWork, onTap, resident],
  )

  const remove = useCallback(
    (item: SavedItem) => {
      void onDelete(item)
        .then(() => {
          setUndo(item)
          setStatus({ kind: 'good', message: `deleted "${item.name}"` })
        })
        .catch((e) =>
          setStatus({ kind: 'bad', message: String((e as Error)?.message ?? e) }),
        )
    },
    [onDelete],
  )

  const restore = useCallback(() => {
    const item = undo
    if (item === null) return
    setUndo(null)
    void onRestore(item)
      .then(() => setStatus(null))
      .catch((e) => setStatus({ kind: 'bad', message: String((e as Error)?.message ?? e) }))
  }, [onRestore, undo])

  /** One gesture from the tile, because a menu two levels down is not "easy to add". */
  const quickPin = useCallback((tile: TileData) => {
    const on = settings.toggleFavourite(tile.key)
    setPinsAt((n) => n + 1)
    setStatus({ kind: 'good', message: on ? `pinned ${tile.title}` : `unpinned ${tile.title}` })
  }, [])

  const longPress = useCallback(
    (tile: TileData, item: SavedItem | null) => {
      const isPinned = settings.favourites().includes(tile.key)
      const options: MenuOption[] = [
        {
          label: isPinned ? 'Unpin from favourites' : 'Pin to favourites',
          onPress: () => quickPin(tile),
        },
      ]
      // Groups, as toggles rather than a submenu: at the count a phone screen can show,
      // one flat list is fewer taps and needs no back gesture in a dark field.
      for (const g of settings.groups()) {
        const inIt = g.keys.includes(tile.key)
        options.push({
          label: inIt ? `Remove from ${g.name}` : `Add to ${g.name}`,
          tone: 'dim',
          onPress: () => {
            settings.toggleInGroup(g.name, tile.key)
            setPinsAt((n) => n + 1)
            setStatus({
              kind: 'good',
              message: inIt ? `out of ${g.name}` : `in ${g.name}`,
            })
          },
        })
      }
      options.push({
        label: 'New group with this in it',
        tone: 'dim',
        onPress: () => setNaming(tile),
      })
      if (item !== null) {
        options.push({ label: 'Edit', onPress: () => onEdit(item) })
        options.push({ label: 'Delete', tone: 'bad', onPress: () => remove(item) })
      } else {
        const hidden = settings.hidden().includes(tile.key)
        options.push({
          label: hidden ? 'Unhide' : 'Hide',
          tone: 'dim',
          onPress: () => {
            settings.toggleHidden(tile.key)
            setPinsAt((n) => n + 1)
          },
        })
      }
      setMenu({ title: tile.title, options })
    },
    [onEdit, quickPin, remove],
  )

  /**
   * The favourites that are content, in pinned order, for the reel.
   *
   * Built-ins are excluded and cannot be otherwise: a built-in is one command naming a
   * bank in the firmware, not columns we could pack into a payload. So a set of tiles
   * can be cyclable while a set of pictures is not, which is why the control appears on
   * the count of these rather than on the count of favourites.
   */
  const favouriteItems = useMemo<SavedItem[]>(() => {
    void pinsAt
    const byKey = new Map((items ?? []).map((item) => [mineKey(item), item]))
    return settings
      .favourites()
      .map((key) => byKey.get(key))
      .filter((item): item is SavedItem => item !== undefined)
  }, [items, pinsAt])

  /**
   * Whether the pinned set is the reel the pair is already holding.
   *
   * `reel.reelResident` rather than `one-tap.residentItem`, which cannot answer it: a
   * reel's hash is the packed payload's, so a committed reel matches no single item.
   */
  const reelHere = useMemo(
    () => reelResident(favouriteItems, resident),
    [favouriteItems, resident],
  )

  const groups = useMemo<Group[]>(() => {
    void pinsAt
    const mine = items ?? []
    const byKey = new Map(mine.map((item) => [mineKey(item), item]))
    // A group is a view of the favourites, so an unknown or deleted group name falls
    // back to all of them rather than showing an empty grid with no way out.
    const inGroup = settings.groups().find((g) => g.name === group)?.keys ?? null
    const keys = inGroup ?? settings.favourites()
    const favourites = keys
      .map((key): TileData | null => {
        const item = byKey.get(key)
        if (item) return mineTile(item)
        const b = builtinById(key)
        if (b) return builtinTile(b)
        const motif = key.startsWith('motif:') ? motifs.motifByName(key.slice(6)) : null
        return motif ? motifTile(motif) : null
      })
      .filter((tile): tile is TileData => tile !== null)

    const hidden = new Set(withHidden ? [] : settings.hidden())
    // The gallery filter, applied to the built-in sections and to the motifs: it reads
    // a fact the app already holds (does this move?) rather than inventing names.
    const wanted = (moves: boolean) =>
      only === 'all' || (only === 'moves' ? moves : !moves)
    const visible = (list: Builtin[]) =>
      list.filter((b) => !hidden.has(b.id) && wanted(b.frames > 1))
    const found = searching ? search(mine, q) : mine

    const rows: Group[] = []
    // The pinned grid is a browsing shortcut, so it stands down while a query is live:
    // pinned tiles that match are in Mine below anyway, and pinned ones that do not
    // would be the only thing on a results screen that did not match.
    if (!searching && favourites.length > 0) {
      const data = chunk(favourites, 'favs')
      // Two things the reel can say and nothing else on the screen can (track 30's
      // done-when, both added by review-30). WHICH set the pair is holding: a reel's
      // hash is the packed payload's, so `residentItem` matches no member of it and the
      // Glasses tab reads as holding nothing. And that the pair's own button walks the
      // same reel, which is this whole feature working with the phone in a pocket.
      if (favouriteItems.length >= MIN_ITEMS) {
        data.push({
          key: 'favs-reel',
          kind: 'none',
          words: reelHere
            ? 'This set is on the glasses. Switching between them is free, and the '
              + "pair's own button walks the same set with no phone at all."
            : 'Cycle sends the set once. After that, switching between them is free, '
              + "and the pair's own button walks the same set with no phone at all.",
        })
      }
      rows.push({ key: 'favs', title: 'Favourites', data })
    }
    // Tiles like everything else ("Why does mine still show the name and everyting,
    // it should be like the others", 2026-08-12): the picture is the label, and the
    // name survives as the long-press menu's title.
    rows.push({
      key: 'mine',
      title: 'Mine',
      data:
        found.length > 0
          ? chunk(found.map(mineTile), 'mine')
          : [
              {
                key: 'mine-none',
                kind: 'none',
                words: searching
                  ? `Nothing of yours matches "${q}".`
                  : items === null
                    ? 'Reading this phone...'
                    : 'Nothing saved yet. Make something on the Create tab.',
              },
            ],
    })
    if (searching) {
      // Not filtered to nothing: not searched at all, and the line says which.
      rows.push({
        key: 'builtins',
        title: null,
        data: [{ key: 'builtins-unsearched', kind: 'none', words: NOT_SEARCHED }],
      })
      return rows
    }
    rows.push({
      key: 'motifs',
      title: 'Waluigi',
      data: chunk(motifs.MOTIFS.filter((mo) => wanted(mo.wide)).map(motifTile), 'motif'),
    })
    rows.push({
      key: 'images',
      title: 'Pictures',
      data: chunk(visible(IMAGES).map(builtinTile), 'img'),
    })
    rows.push({
      key: 'animations',
      title: 'Animations',
      data: chunk(visible(ANIMATIONS).map(builtinTile), 'anim'),
    })
    return rows
    // `group` and `only` are the two chip rows above the grid, and they were missing
    // here: the memo read them and never recomputed for them, so both controls lit
    // their own chip and changed nothing below it. Creating a group hid half of it,
    // that path bumping `pinsAt` on the way past, so the first one worked and every
    // switch afterwards did not (review-28, 2026-08-12).
  }, [items, pinsAt, q, searching, withHidden, group, only, favouriteItems, reelHere])

  const hiddenCount = settings.hidden().length

  const groupNames = useMemo(() => {
    void pinsAt
    return settings.groups().map((g) => g.name)
  }, [pinsAt])

  /** Read once per render pass rather than per tile, which is 30-odd lookups. */
  const pinned = useMemo(() => {
    void pinsAt
    return new Set(settings.favourites())
  }, [pinsAt])

  const makeGroup = useCallback(() => {
    const tile = naming
    if (tile === null) return
    const made = settings.addGroup(groupName)
    setNaming(null)
    setGroupName('')
    if (made === null) {
      setStatus({ kind: 'bad', message: 'That group needs a name.' })
      return
    }
    settings.toggleInGroup(made, tile.key)
    setPinsAt((n) => n + 1)
    setGroup(made)
    setStatus({ kind: 'good', message: `${tile.title} is in ${made}` })
  }, [groupName, naming])

  const renderRow = useCallback(
    ({ item: row }: { item: Row }) => {
      if (row.kind === 'none') return <Text style={styles.none}>{row.words}</Text>

      if (row.kind === 'grid') {
        return (
          <View style={styles.gridRow}>
            {row.tiles.map((tile) => (
              <Pressable
                key={tile.key}
                onPress={() => show(tile)}
                onLongPress={() =>
                  longPress(
                    tile,
                    tile.key.startsWith('mine:')
                      ? (items ?? []).find((i) => mineKey(i) === tile.key) ?? null
                      : null,
                  )
                }
                disabled={busy}
              >
                <Tile
                  frame={tile.frame}
                  glow={showing === tile.key ? theme.accent : null}
                  moves={tile.moves}
                />
                {/* The pin sits ON the tile, so adding to favourites is one gesture
                    from the thing being added rather than a long-press into a menu.
                    Its own hit area, so a thumb aiming at the picture still shows it. */}
                <Pressable
                  style={styles.pin}
                  hitSlop={8}
                  onPress={() => quickPin(tile)}
                  disabled={busy}
                >
                  <Text
                    style={[
                      styles.pinMark,
                      pinned.has(tile.key) && { color: theme.accent, opacity: 1 },
                    ]}
                  >
                    ★
                  </Text>
                </Pressable>
              </Pressable>
            ))}
          </View>
        )
      }

      return null
    },
    [busy, items, longPress, pinned, quickPin, show, showing, theme.accent],
  )

  return (
    <>
      <SectionList<Row, Group>
        sections={groups}
        keyExtractor={(row) => row.key}
        contentContainerStyle={styles.wrap}
        initialNumToRender={8}
        windowSize={5}
        stickySectionHeadersEnabled={false}
        // Without `handled`, the first tap on a result only dismisses the keyboard and
        // the tile does not fire: a two-tap show, which is the one thing this screen
        // exists not to be. Dragging the grid puts the keyboard away instead.
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.title}>Show</Text>
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
            {/* Two narrowing rows, both one tap and neither a text box. Hidden while a
                query is live, because a search already IS the narrowing and stacking
                three filters is the kind of screen the redesign came from. */}
            {!searching && groupNames.length > 0 ? (
              <ChipRow>
                <Chip on={group === null} onPress={() => setGroup(null)} label="All pinned" />
                {groupNames.map((name) => (
                  <Chip
                    key={name}
                    on={group === name}
                    onPress={() => setGroup(group === name ? null : name)}
                    label={name}
                  />
                ))}
              </ChipRow>
            ) : null}
            {!searching ? (
              <ChipRow>
                <Chip on={only === 'all'} onPress={() => setOnly('all')} label="Everything" />
                <Chip on={only === 'moves'} onPress={() => setOnly('moves')} label="Moving" />
                <Chip on={only === 'still'} onPress={() => setOnly('still')} label="Still" />
              </ChipRow>
            ) : null}
            {!searching && onOpenPack && animations.PACK.length > 0 ? (
              <View style={styles.packRow}>
                <Link
                  label={`Imported animations (${animations.PACK.length}) ›`}
                  onPress={onOpenPack}
                />
              </View>
            ) : null}
            {status ? (
              <View style={styles.statusRow}>
                <Text
                  style={[styles.status, status.kind === 'bad' && { color: INK.bad }]}
                  numberOfLines={1}
                >
                  {status.message}
                </Text>
                {undo !== null ? <Link label="Undo" onPress={restore} /> : null}
              </View>
            ) : !connected ? (
              <Text style={styles.detail}>Nothing connected: connect on the Glasses tab</Text>
            ) : null}
            {trouble ? (
              <Text style={styles.bad}>
                This phone would not read its library: {trouble}. The built-ins still work.
              </Text>
            ) : null}
          </View>
        }
        renderSectionHeader={({ section }) =>
          section.title ? (
            <View style={styles.groupRow}>
              <Text style={styles.group}>{section.title}</Text>
              {/* Cycling lives on the favourites header because the favourites ARE the
                  set: the reel packs every scrolling one into a single type 1 save, so
                  after the first tap the rest switch with no flash at all, which is the
                  only answer stock firmware has to "can we really not have more than
                  one saved slot?". Two is core's own minimum for a playlist. */}
              {section.key === 'favs' && onCycle && favouriteItems.length >= MIN_ITEMS ? (
                <Link
                  label="Cycle"
                  onPress={() => {
                    setStatus({ kind: 'busy', message: 'sending the set...' })
                    void onCycle(favouriteItems).then((out) =>
                      setStatus({ kind: out.showing ? 'good' : 'bad', message: out.message }),
                    )
                  }}
                  disabled={!connected || busy}
                />
              ) : null}
            </View>
          ) : null
        }
        renderItem={renderRow}
        ListFooterComponent={
          hiddenCount > 0 && !searching ? (
            <View style={styles.footer}>
              <Link
                label={withHidden ? 'Tuck the hidden ones away' : `Show ${hiddenCount} hidden`}
                tone="dim"
                onPress={() => setWithHidden(!withHidden)}
              />
            </View>
          ) : null
        }
      />

      <ActionMenu
        open={menu !== null}
        title={menu?.title ?? ''}
        options={menu?.options ?? []}
        onClose={() => setMenu(null)}
      />
      {/* Naming a group is the one place in this screen that needs a keyboard, so it is
          a small modal rather than a field parked on the front door. Making the group
          also puts the tile in it: nobody makes an empty group on purpose. */}
      <Modal
        visible={naming !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setNaming(null)}
      >
        <Pressable style={styles.scrim} onPress={() => setNaming(null)} />
        <View style={styles.namer}>
          <Text style={styles.namerTitle}>New group</Text>
          <TextInput
            style={styles.search}
            value={groupName}
            onChangeText={setGroupName}
            placeholder="Name it"
            placeholderTextColor={INK.faint}
            autoFocus
            selectionColor={theme.accent}
            onSubmitEditing={() => makeGroup()}
            returnKeyType="done"
          />
          <View style={styles.namerRow}>
            <Link label="Cancel" tone="dim" onPress={() => setNaming(null)} />
            <Link label="Make it" onPress={() => makeGroup()} />
          </View>
        </View>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 10, paddingBottom: 24 },
  header: { gap: 6, marginBottom: 6 },
  title: { color: INK.text, fontSize: 22, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  packRow: { paddingBottom: 4, paddingTop: 8 },
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
  status: { color: INK.dim, fontSize: 13, flexShrink: 1 },
  group: { color: INK.dim, fontSize: 13, marginTop: 16, marginBottom: 6 },
  groupRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  namer: {
    position: 'absolute',
    left: 20,
    right: 20,
    top: '30%',
    backgroundColor: INK.card,
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  namerTitle: { color: INK.text, fontSize: 17, fontWeight: '700' },
  namerRow: { flexDirection: 'row', justifyContent: 'space-between' },
  pin: { position: 'absolute', top: 2, right: 6, padding: 4 },
  pinMark: { color: INK.faint, fontSize: 15, opacity: 0.65 },
  gridRow: { flexDirection: 'row', gap: 12, paddingVertical: 5, justifyContent: 'center' },
  detail: { color: INK.dim, fontSize: 12, lineHeight: 16 },
  none: { color: INK.faint, fontSize: 13, lineHeight: 18, paddingVertical: 8 },
  bad: { color: INK.bad, fontSize: 13, lineHeight: 18 },
  footer: { paddingVertical: 14, alignItems: 'center' },
  panel: { backgroundColor: '#000', padding: 3, borderRadius: 4, borderWidth: 1, borderColor: 'transparent' },
  moves: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    width: 17,
    height: 17,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(11,11,14,0.86)',
    borderWidth: 1,
    borderColor: 'rgba(236,236,241,0.4)',
  },
  // Borders rather than a glyph: a triangle drawn this way is exactly the size asked
  // for on every device, where a codepoint is at the mercy of Android's font fallback
  // and can arrive as tofu, as a colour emoji, or at a size of the font's choosing.
  movesMark: {
    width: 0,
    height: 0,
    marginLeft: 2,
    borderTopWidth: 4.5,
    borderBottomWidth: 4.5,
    borderLeftWidth: 7,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: INK.text,
  },
  noTile: { width: 104, height: 53 },
  pixelRow: { flexDirection: 'row' },
  pixel: { width: 3, height: 4, margin: 0.5, borderRadius: 1, backgroundColor: '#191919' },
  dead: { backgroundColor: 'transparent' },
})

/** Levels 0 to 3, where 0 is the unlit pixel this grid owns. As `Preview.tsx`. */
type Lit = readonly StyleProp<ViewStyle>[]

/** One table per theme, built once, so a tile's pixels keep their references. */
const HOLE = [styles.pixel, styles.dead]
const LIT: Record<string, Lit> = Object.fromEntries(
  THEMES.map((t) => [
    t.id,
    [styles.pixel, ...t.levels.map((colour) => [styles.pixel, { backgroundColor: colour }])],
  ]),
)

const skin = (lit: Lit, alive: boolean, level: number) =>
  alive ? (lit[level] ?? lit[0]) : HOLE

/**
 * One small frame at panel coordinates. `glow` outlines the tile that is on now;
 * `moves` marks anything that animates, because a loop and a picture are otherwise
 * identical stills until tapped ("There should be some way to see when something is
 * an animation", 2026-08-12).
 *
 * The mark is a badge rather than a bare glyph, and that is the second attempt: the
 * first was a 9px `▸` at `INK.dim` in the corner, and Jacob's verdict on seeing it was
 * "its there, just small". A badge carries its own backing, so it reads over lit
 * pixels as well as dark ones rather than depending on what the content happens to
 * put underneath it.
 */
const Tile = memo(function Tile({
  frame,
  glow,
  moves = false,
}: {
  frame: content.Bitmap | null
  glow: string | null
  moves?: boolean
}) {
  const theme = useTheme()
  if (frame === null) return <View style={styles.noTile} />
  const lit = LIT[theme.id] ?? LIT[DEFAULT_THEME.id]
  return (
    <View style={[styles.panel, glow !== null && { borderColor: glow }]}>
      {ORDER.map((row) => (
        <View key={row} style={styles.pixelRow}>
          {ALIVE[row].map((alive, col) => (
            <View key={col} style={skin(lit, alive, frame[row]?.[col] ?? 0)} />
          ))}
        </View>
      ))}
      {moves ? (
        <View style={styles.moves}>
          <View style={styles.movesMark} />
        </View>
      ) : null}
    </View>
  )
})
