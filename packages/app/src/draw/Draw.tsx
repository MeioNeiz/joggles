/**
 * Draw on the glasses with a finger, one column per touched pixel.
 *
 * **Nothing on this screen writes flash.** A live column write is SRAM and the
 * display module's UART, so a whole evening of drawing costs a unit nothing at all;
 * the wear budget, the cooldown and the confirmation that the Compose screen needs
 * are all absent here on purpose rather than by omission. `notes/app-plan.md`,
 * "Flash wear", has the table this rests on.
 *
 * What it costs instead is the connection. The drawing lives in the device's live
 * buffer, so it survives a disconnect at best and never a power cycle, and **any
 * `MODE` discards it** - which the Compose screen sends every time it saves. So this
 * screen sends no `MODE`, and says out loud that the drawing is not kept.
 *
 * Three rules it exists to obey, each from a failure that has already happened
 * somewhere in this project:
 *
 *  1. **Never a queue of writes.** A finger produces touches far faster than one
 *     column per pacing interval, and write-without-response has no flow control, so
 *     a queueing sender overruns the controller and leaves stale pixels lit. Every
 *     touch replaces the desired state and `LiveSender` writes the difference.
 *  2. **`begin()` before the sender exists.** `SMVEW 01` clears the live buffer,
 *     which is exactly the blank state the sender assumes it starts from. Building
 *     the sender first would have it believe a panel it had not cleared.
 *  3. **A dead pump has to be visible.** Touches await nothing, so without
 *     `onError` a dropped link is silent and the phone goes on showing a drawing the
 *     glasses stopped receiving. The sender stays dead by design, so the honest
 *     message is "reconnect", not a retry.
 *
 * "Save drawing" keeps the canvas in the phone's library (`library.ts`), because the
 * phone is the only place a drawing can persist: the device's greyscale save dies at
 * power-off and its flash save flattens grey. A library save is a local file write,
 * so it needs no link and no budget; Load puts an item back through the same live
 * columns a stroke uses, still no flash and still no `MODE`.
 */
import { Glasses, LiveSender } from '@joggles/core'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { SavedDrawing, SavedItem } from '../library.js'
import { library } from '../library-store.js'
import { Pad } from './Pad.js'
import { Canvas, type Cell } from './canvas.js'

/** Erase, then the three levels. The panel's steps are subtle; these are shading. */
const BRUSHES = [
  { level: 0, label: 'Erase' },
  { level: 1, label: 'Dim' },
  { level: 2, label: 'Mid' },
  { level: 3, label: 'Bright' },
]

const reason = (e: unknown): string => String((e as Error)?.message ?? e)

const onlyDrawings = (items: SavedItem[]): SavedDrawing[] =>
  items.filter((item): item is SavedDrawing => item.kind === 'drawing')

export function Draw({ glasses, onBack }: { glasses: Glasses; onBack: () => void }) {
  const [sender, setSender] = useState<LiveSender | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [brush, setBrush] = useState(3)
  const [saved, setSaved] = useState<SavedDrawing[] | null>(null)

  // The canvas mutates in place - a stroke is a touch per frame and copying a grid
  // per touch is work for nothing - so a counter is what tells React it changed.
  const canvas = useRef(new Canvas()).current
  const [version, bump] = useReducer((n: number) => n + 1, 0)
  const bitmap = useMemo(() => canvas.levels(), [canvas, version])

  useEffect(() => {
    let live = true
    let made: LiveSender | null = null
    // DIY first, and only then a sender: SMVEW 01 both stops the animation engine
    // and clears the live buffer, which is the state LiveSender starts by assuming.
    const started = glasses.begin().then(() => {
      if (!live) return
      made = glasses.live({ onError: (e) => setTrouble(reason(e)) })
      setSender(made)
    })
    started.catch((e) => live && setTrouble(reason(e)))

    return () => {
      live = false
      setSender(null)
      // Stop, then flush: stopping ends the pump after the write in flight, and the
      // flush acks a tail that would otherwise be dropped by an immediate
      // disconnect. It does not leave DIY - `SMVEW 00` would restore the vendor's
      // saved image, which looks like stray pixels from nowhere.
      started
        .then(() => made?.stop())
        .then(() => made?.flush())
        .catch(() => {})
    }
  }, [glasses])

  const paint = useCallback(
    (cell: Cell) => {
      if (!sender || sender.stopped) return
      // Nothing to redraw and nothing to send if the stroke stayed in one pixel,
      // which is most of a slow one.
      if (!canvas.drag(cell, brush)) return
      bump()
      sender.set(canvas.snapshot())
    },
    [canvas, sender, brush],
  )

  const lift = useCallback(() => canvas.lift(), [canvas])

  function clear() {
    canvas.clear()
    bump()
    // Sent even when the canvas was already blank: it is one write, it is the
    // panel's "start again", and it repairs a buffer something else moved.
    sender?.clear()
  }

  /**
   * Rewrite all 24 columns.
   *
   * The glasses have their own button - a short press cycles the built-in modes -
   * so the panel can change without this app having sent anything. There is no way
   * to notice that from here, which is why it is a button and not automatic.
   */
  function resend() {
    sender?.refresh()
  }

  const ready = sender !== null && trouble === null

  return (
    <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View>
          <Text style={styles.name}>{glasses.name}</Text>
          <Text style={styles.kind}>
            {trouble ? 'link lost' : sender ? 'drawing, live' : 'entering draw mode...'}
          </Text>
        </View>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>Done</Text>
        </Pressable>
      </View>

      <Pad bitmap={bitmap} onCell={paint} onLift={lift} disabled={!ready} />

      <Row label="Brush">
        {BRUSHES.map((b) => (
          <Choice
            key={b.level}
            on={brush === b.level}
            onPress={() => setBrush(b.level)}
            label={b.label}
          />
        ))}
      </Row>

      <View style={styles.actions}>
        <Pressable style={styles.action} onPress={clear} disabled={!ready}>
          <Text style={[styles.actionText, !ready && styles.disabled]}>Clear</Text>
        </Pressable>
        <Pressable style={styles.action} onPress={resend} disabled={!ready}>
          <Text style={[styles.actionText, !ready && styles.disabled]}>Resend all</Text>
        </Pressable>
      </View>

      {trouble ? (
        <Text style={styles.bad}>
          The link dropped, so nothing is reaching the glasses. Go back and reconnect
          to carry on drawing. ({trouble})
        </Text>
      ) : null}

      <Text style={styles.note}>
        Drawing writes no flash at all, so there is no limit on it. The drawing lives
        in the glasses' memory: it goes when they are powered off, and saving a
        message on the other screen replaces it.
      </Text>
      <Text style={styles.note}>
        The middle band is the only part with an LED in every column. Pixels above and
        below it pass behind the nose bridge, and the gaps are drawn as gaps.
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
}: {
  on: boolean
  onPress: () => void
  label: string
}) {
  return (
    <Pressable style={[styles.choice, on && styles.choiceOn]} onPress={onPress}>
      <Text style={[styles.choiceText, on && styles.choiceTextOn]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 14, paddingBottom: 48 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  name: { color: '#eee', fontSize: 17 },
  kind: { color: '#888', fontSize: 13, marginTop: 2 },
  back: { color: '#4ade80', fontSize: 15 },
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
  actions: { flexDirection: 'row', gap: 12 },
  action: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    alignItems: 'center',
  },
  actionText: { color: '#eee', fontSize: 15 },
  disabled: { color: '#444' },
  bad: { color: '#f87171', fontSize: 13, lineHeight: 19 },
  note: { color: '#555', fontSize: 12, lineHeight: 17 },
})
