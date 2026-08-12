/**
 * The making tab: Message, Draw or Effect, each ending in Show and Keep.
 *
 * A segmented host rather than three tabs, because the three creators share their
 * exits (the tap flow, the library) and a person switches between them while making
 * one thing. Everything works with nothing connected - composing, drawing, keeping -
 * and only showing needs the pair, which is the redesign's rule for every screen.
 *
 * An `editing` item arrives from the library's Edit action, picks its own segment
 * and pre-fills it, then is released via `onTook` so leaving and returning starts
 * fresh rather than resurrecting a stale hand-off.
 */
import type { LiveSender } from '@joggles/core'
import { useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text } from 'react-native'
import type { SavedItem } from '../library.js'
import type { Showable, Tap, TapContext, TapResult } from '../one-tap.js'
import { INK, Segmented } from '../ui.js'
import { DrawPanel } from './create/DrawPanel.js'
import { Effect } from './create/Effect.js'
import { Message } from './create/Message.js'

type Kind = 'message' | 'draw' | 'effect'

const SEGMENTS = [
  { id: 'message', label: 'Message' },
  { id: 'draw', label: 'Draw' },
  { id: 'effect', label: 'Effect' },
] as const

const segmentFor = (item: SavedItem): Kind =>
  item.kind === 'drawing' ? 'draw' : item.kind === 'text' ? 'message' : 'effect'

export function Create({
  connected,
  resident,
  liveWork,
  busy,
  onTap,
  onKept,
  editing,
  onTook,
  liveSender,
  onLive,
}: {
  connected: boolean
  resident: string | null
  liveWork: boolean
  busy: boolean
  onTap: (what: Showable, plan: Tap) => Promise<TapResult>
  onKept: () => void
  editing: SavedItem | null
  onTook: () => void
  liveSender: (() => Promise<LiveSender>) | null
  onLive: (live: boolean) => void
}) {
  const [kind, setKind] = useState<Kind>(editing === null ? 'message' : segmentFor(editing))
  /** Held for the mount, so the editor keeps its prefill while App forgets the hand-off. */
  const [took] = useState(editing)
  useEffect(onTook, [onTook])

  const ctx = useMemo<TapContext>(
    () => ({ connected, resident, liveWork }),
    [connected, resident, liveWork],
  )

  return (
    <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Create</Text>
      <Segmented options={[...SEGMENTS]} at={kind} onPick={setKind} />
      {kind === 'message' ? (
        <Message
          ctx={ctx}
          busy={busy}
          onTap={onTap}
          onKept={onKept}
          prefill={took?.kind === 'text' ? took : null}
        />
      ) : kind === 'draw' ? (
        <DrawPanel
          liveSender={liveSender}
          onLive={onLive}
          onKept={onKept}
          prefill={took?.kind === 'drawing' ? took : null}
        />
      ) : (
        <Effect
          ctx={ctx}
          busy={busy}
          onTap={onTap}
          onKept={onKept}
          prefill={took?.kind === 'effect' ? took : null}
        />
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 14, paddingBottom: 32 },
  title: { color: INK.text, fontSize: 22, fontWeight: '700' },
})
