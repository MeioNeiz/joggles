/**
 * Type a thing, see it, show it. One screen and no detour, which is track 22's
 * contract inherited by the redesign.
 *
 * **Motion is not a control** (`notes/library.md`, "Text decides its own motion"):
 * text that fits the panel is still, text one column wider scrolls. The trap in that
 * rule is that the boundary is also a price change - 24 columns or fewer rides the
 * live buffer free, one more column is a type 1 save at five page erases, and it
 * falls mid-word - so the boundary is shown while typing (the column count against
 * 24) and the button changes shape across it, outline for free, filled for flash.
 * No sheet asks any more (the 2026-08-12 ruling), so the shape and the caption are
 * the whole disclosure, which is why both stay.
 *
 * No ink control either: a message is bright. Grey enters this app through Draw,
 * where it is free, and through nothing else, which is what keeps the grey question
 * off every screen (the planner still answers it for content that has some).
 */
import { content, font } from '@joggles/core'
import { useMemo, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import type { SavedText } from '../../library.js'
import { library } from '../../library-store.js'
import type { Showable, Tap, TapContext, TapResult } from '../../one-tap.js'
import { Preview } from '../../Preview.js'
import { settings } from '../../settings-store.js'
import { PRESETS, describe as describeSpeed, msPerColumn, sameStep } from '../../speed.js'
import { Chip, ChipRow, Fine, FlashButton, FreeButton, INK, Link, StatusLine } from '../../ui.js'
import { useTapFlow } from '../tap-flow.js'

export function Message({
  ctx,
  busy,
  onTap,
  onKept,
  prefill,
}: {
  ctx: TapContext
  busy: boolean
  onTap: (what: Showable, plan: Tap) => Promise<TapResult>
  onKept: () => void
  prefill: SavedText | null
}) {
  const [text, setText] = useState(prefill?.text ?? '')
  const [speed, setSpeed] = useState(
    prefill?.motion.kind === 'scroll' ? prefill.motion.speed : settings.defaults().speed,
  )
  // An item written before faces were pickable resolves to band5 and stays there, which
  // is `fontByName`'s own rule rather than a default this screen applies.
  const [face, setFace] = useState<font.Font>(() => font.fontByName(prefill?.font))
  const flow = useTapFlow({ ctx, busy, onTap })

  /**
   * The honest column count in the chosen face, before `content.text` pads to 24.
   *
   * Recomputed per face on purpose: the 24-column line between free and five page
   * erases MOVES when the font does, and that is the one number on this screen doing
   * real work. `JOGGLES` is 27 columns in band5 and exactly 24 in slim5, so the same
   * message crosses the price line by changing nothing but the face.
   */
  const measured = useMemo(() => {
    if (text.trim() === '') return null
    try {
      return font.fit(text, face)
    } catch {
      return null
    }
  }, [text, face])

  const columns = text.trim() === '' ? 0 : (measured?.columns ?? null)
  const fits = measured !== null && measured.free
  const motion = useMemo<content.Motion>(
    () =>
      fits ? { kind: 'static' } : { kind: 'scroll', dir: settings.defaults().dir, speed },
    [fits, speed],
  )

  const piece = useMemo(() => {
    if (columns === null || columns === 0) return null
    try {
      return content.text(text, motion, { font: face })
    } catch {
      return null
    }
  }, [columns, text, motion, face])

  async function keep() {
    if (piece === null) return
    try {
      await library.saveText(text, motion, '', face.name)
      onKept()
      flow.setStatus({ kind: 'good', message: 'kept in the library' })
    } catch (e) {
      flow.setStatus({ kind: 'bad', message: String((e as Error)?.message ?? e) })
    }
  }

  const showable: Showable | null = piece === null ? null : { kind: 'piece', piece }

  return (
    <View style={styles.wrap}>
      {piece ? (
        <Preview
          bitmap={piece.bitmap}
          scroll={!fits}
          dir={motion.kind === 'scroll' ? motion.dir : 0}
          intervalMs={msPerColumn(speed)}
        />
      ) : null}

      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder="Type a message"
        placeholderTextColor={INK.faint}
        autoCorrect={false}
      />

      {columns === null ? (
        <Text style={styles.bad}>Something in there cannot be drawn by this font.</Text>
      ) : columns > 0 ? (
        <Fine>
          {columns} of {content.MAX_LIVE_COLUMNS} columns
          {fits ? ' · fits the panel, shows free' : ' · scrolls, saving writes flash'}
        </Fine>
      ) : null}

      {/* The faces are shown always, not only once something is typed: picking one is
          how a message looks, and it changes where the free line falls. `usable` is
          false when a face cannot draw this string at all (tall7 drops glyphs round
          the notch rather than clipping them), so it is offered but says so. */}
      <ChipRow label="Font">
        {font.FONTS.map((f) => (
          <Chip
            key={f.name}
            on={face.name === f.name}
            onPress={() => setFace(f)}
            label={f.label}
          />
        ))}
      </ChipRow>
      {measured !== null && !measured.usable ? (
        // `Fit.dropped` is the CHARACTERS that fall off, not a sentence: a tall face is
        // placed around the nose notch rather than clipped, so it reports what it could
        // not seat. Printing it bare put "LE" on the screen with no way to read it.
        <Text style={styles.bad}>
          {face.label} cannot fit “{measured.dropped}”. Try a shorter message or another
          font.
        </Text>
      ) : null}

      {!fits && columns !== null && columns > 0 ? (
        <>
          {/* Ten rungs, one per firmware bucket, so nothing the panel can do is out of
              reach. The caption carries the rate because the top rung is the hardware
              ceiling and a row of numbers alone would invite hunting for an eleventh. */}
          <ChipRow label="Speed">
            {PRESETS.map((s) => (
              <Chip
                key={s.value}
                on={sameStep(speed, s.value)}
                onPress={() => setSpeed(s.value)}
                label={s.label}
              />
            ))}
          </ChipRow>
          <Fine>{describeSpeed(speed)}</Fine>
        </>
      ) : null}

      <View style={styles.actions}>
        {fits ? (
          <FreeButton
            label="Show · free"
            onPress={() => showable && flow.show(`"${text.trim()}"`, showable)}
            disabled={busy || showable === null}
          />
        ) : (
          <FlashButton
            label="Send to glasses"
            onPress={() => showable && flow.show(`"${text.trim()}"`, showable)}
            disabled={busy || showable === null}
          />
        )}
      </View>
      <View style={styles.keepRow}>
        <Link label="Keep in the library" onPress={() => void keep()} disabled={piece === null} />
      </View>

      <StatusLine status={flow.status} />
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  input: {
    color: INK.text,
    fontSize: 20,
    borderBottomWidth: 1,
    borderBottomColor: INK.line,
    paddingVertical: 10,
  },
  actions: { gap: 10 },
  keepRow: { alignItems: 'center' },
  bad: { color: INK.bad, fontSize: 13 },
})
