/**
 * The finger canvas, now usable with nothing connected.
 *
 * Track 4 built the pad and track 26 moved it here with one structural change: the
 * old screen could not mount without an open session (review 17's finding), where
 * drawing and keeping a drawing are local acts that need no radio. So the pad always
 * works; what the connection adds is the panel mirroring the strokes, through the
 * one `PanelSession` sender the shell owns. This component never builds a sender and
 * never stops one - both are the shell's, which is what closed the two-senders
 * hazard the old Draw/Compose pair carried.
 *
 * Everything else is track 4's hard-won shape, unchanged: no queue of writes (every
 * touch replaces desired state, `LiveSender` sends the difference), no flash, no
 * `MODE`, dead pixels drawn as absent, and a clear that is 24 column writes because
 * that is the path hardware has actually run.
 */
import type { LiveSender } from '@joggles/core'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Pad } from '../../draw/Pad.js'
import { Canvas, type Cell } from '../../draw/canvas.js'
import type { SavedDrawing } from '../../library.js'
import { library } from '../../library-store.js'
import { Chip, ChipRow, Fine, Link, type Status, StatusLine } from '../../ui.js'

const BRUSHES = [
  { level: 0, label: 'Erase' },
  { level: 1, label: 'Dim' },
  { level: 2, label: 'Mid' },
  { level: 3, label: 'Bright' },
]

const reason = (e: unknown): string => String((e as Error)?.message ?? e)

export function DrawPanel({
  liveSender,
  onLive,
  onKept,
  prefill,
}: {
  /** Null when nothing is connected: the pad still draws, keeping still works. */
  liveSender: (() => Promise<LiveSender>) | null
  onLive: (live: boolean) => void
  onKept: () => void
  prefill: SavedDrawing | null
}) {
  const [sender, setSender] = useState<LiveSender | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [brush, setBrush] = useState(3)

  const canvas = useRef(new Canvas()).current
  const [version, bump] = useReducer((n: number) => n + 1, 0)
  const bitmap = useMemo(() => canvas.levels(), [canvas, version])
  const empty = useMemo(() => canvas.empty, [canvas, version])

  // The shell's sender, borrowed: strokes arrive at touch rate, far too hot for the
  // planned-tap path, and the difference-only sending is the whole point of the pad.
  useEffect(() => {
    if (liveSender === null) {
      setSender(null)
      return
    }
    let alive = true
    liveSender()
      .then((s) => alive && setSender(s))
      .catch((e) => alive && setStatus({ kind: 'bad', message: reason(e) }))
    return () => {
      alive = false
    }
  }, [liveSender])

  // A handed-in drawing loads once, and replays through the same live columns a
  // stroke uses when the panel is there to receive it.
  const took = useRef<string | null>(null)
  useEffect(() => {
    if (prefill === null || took.current === prefill.id) return
    took.current = prefill.id
    if (canvas.load(prefill.levels)) bump()
  }, [canvas, prefill])

  const paint = useCallback(
    (cell: Cell) => {
      if (!canvas.drag(cell, brush)) return
      bump()
      if (sender !== null && !sender.stopped) {
        sender.set(canvas.snapshot())
        onLive(true)
      }
    },
    [brush, canvas, onLive, sender],
  )

  const lift = useCallback(() => canvas.lift(), [canvas])

  function clear() {
    canvas.clear()
    bump()
    if (sender !== null && !sender.stopped) {
      sender.clear()
      onLive(false)
    }
  }

  /** The glasses' own button can change the panel; this rewrites all 24 columns. */
  function resend() {
    sender?.refresh()
  }

  async function keep() {
    try {
      await library.saveDrawing(canvas.levels())
      onKept()
      setStatus({ kind: 'good', message: 'kept in the library' })
    } catch (e) {
      setStatus({ kind: 'bad', message: `this phone would not keep it: ${reason(e)}` })
    }
  }

  const mirroring = sender !== null && !sender.stopped

  return (
    <View style={styles.wrap}>
      <Pad bitmap={bitmap} onCell={paint} onLift={lift} disabled={false} />

      <ChipRow label="Brush">
        {BRUSHES.map((b) => (
          <Chip
            key={b.level}
            on={brush === b.level}
            onPress={() => setBrush(b.level)}
            label={b.label}
          />
        ))}
      </ChipRow>

      <View style={styles.actions}>
        <Link label="Clear" onPress={clear} />
        {mirroring ? <Link label="Resend" onPress={resend} tone="dim" /> : null}
        <Link label="Keep in the library" onPress={() => void keep()} disabled={empty} />
      </View>

      {!mirroring ? (
        <Fine>
          Drawing on the phone only. Connect a pair and the strokes go straight to the
          panel, free.
        </Fine>
      ) : null}

      <StatusLine status={status} />
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  actions: {
    flexDirection: 'row',
    gap: 22,
    alignItems: 'center',
    paddingVertical: 4,
  },
})
