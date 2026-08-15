/**
 * Pick an effect, tune the knobs a thumb deserves, show it. Nothing else to decide.
 *
 * Three controls the old Effects screen offered are gone, each because the repo
 * already knew the answer (`notes/library.md`, "Width is not a question worth
 * asking"): **width** always renders at the ceiling, since every `DATCP` erases the
 * same five pages whatever the payload and width only buys upload seconds;
 * **dither** is the catalogue's per-generator answer; **direction** is the default
 * that hides the store's dead space at the end of a pass. What survives is the knob
 * bag, which is genuinely taste, speed, and the one thing the old screen refused to
 * offer: **Still**, one panel of the field through the live buffer, free, which is
 * the only zero-erase way to put a generated picture up (track 25's item).
 *
 * The screen builds no frames and reaches no wire: `planLoop` prices and checks, and
 * the executor behind `onTap` is the audited one. `effects-ui/wiring.test.ts` crawls
 * this source to hold it there. It opens on `stripes`, the catalogue's own "most
 * legible thing here", after plasma made the worst first impression twice; and the
 * two fine-print facts (`MONO_NOTE`, `PANEL_GAP_NOTE`) sit behind one small toggle,
 * per the 2026-08-12 ruling that the writing is the cost.
 */
import { content, effects as fx } from '@joggles/core'
import { useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { CATALOGUE, type KnobValue, defaultsFor, specFor, tuning } from '../../effects-ui/catalogue.js'
import { LEVELS, MONO_NOTE, PANEL_GAP_NOTE, planLoop } from '../../effects-ui/plan.js'
import type { SavedEffect } from '../../library.js'
import { library } from '../../library-store.js'
import type { Showable, Tap, TapContext, TapResult } from '../../one-tap.js'
import { Preview } from '../../Preview.js'
import { settings } from '../../settings-store.js'
import { PRESETS, describe as describeSpeed, msPerColumn, sameStep } from '../../speed.js'
import { Chip, ChipRow, Bad, Fine, FlashButton, FreeButton, Link, StatusLine } from '../../ui.js'
import { useTapFlow } from '../tap-flow.js'

export function Effect({
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
  prefill: SavedEffect | null
}) {
  const [name, setName] = useState(prefill?.effect ?? 'stripes')
  const [about, setAbout] = useState(false)
  /** Knobs per effect, so wandering across the list and back keeps what was tuned. */
  const [tuned, setTuned] = useState<Record<string, Record<string, KnobValue>>>(
    prefill === null ? {} : { [prefill.effect]: { ...defaultsFor(prefill.effect), ...prefill.opts } },
  )
  const [still, setStill] = useState(prefill?.motion.kind === 'static')
  const [speed, setSpeed] = useState(
    prefill?.motion.kind === 'scroll' ? prefill.motion.speed : settings.defaults().speed,
  )
  const flow = useTapFlow({ ctx, busy, onTap })

  const spec = useMemo(() => specFor(name), [name])
  const opts = tuned[name] ?? defaultsFor(name)
  const dir = settings.defaults().dir

  /** The full loop, priced and checked. Rendered at the ceiling: width is not a question. */
  const plan = useMemo(
    () => planLoop({ name, opts, columns: fx.MAX_COLUMNS, dither: spec.dither, dir, speed }),
    [name, opts, spec.dither, dir, speed],
  )

  /** One panel of the same field, for the free still. */
  const stillPiece = useMemo<content.Content>(() => {
    const bitmap = fx.EFFECTS[name]({
      ...tuning(opts),
      columns: content.MAX_LIVE_COLUMNS,
      levels: LEVELS,
      dither: spec.dither,
    })
    return { bitmap, route: 'live', motion: { kind: 'static' } }
  }, [name, opts, spec.dither])

  const piece = still ? stillPiece : plan.piece
  const showable: Showable = { kind: 'piece', piece }
  const blocked = still ? [] : plan.problems

  function tune(key: string, value: KnobValue) {
    setTuned({ ...tuned, [name]: { ...opts, [key]: value } })
  }

  async function keep() {
    try {
      await library.saveEffect({
        effect: name,
        opts,
        columns: still ? content.MAX_LIVE_COLUMNS : plan.columns,
        dither: spec.dither,
        motion: still ? { kind: 'static' } : { kind: 'scroll', dir, speed },
      })
      onKept()
      flow.setStatus({ kind: 'good', message: 'kept in the library' })
    } catch (e) {
      flow.setStatus({ kind: 'bad', message: String((e as Error)?.message ?? e) })
    }
  }

  return (
    <View style={styles.wrap}>
      <Preview
        bitmap={piece.bitmap}
        scroll={!still}
        dir={dir}
        intervalMs={msPerColumn(speed)}
      />

      <ChipRow label="Effect">
        {CATALOGUE.map((s) => (
          <Chip
            key={s.name}
            on={s.name === name}
            onPress={() => setName(s.name)}
            label={s.name.charAt(0).toUpperCase() + s.name.slice(1)}
          />
        ))}
      </ChipRow>

      {spec.knobs.map((knob) => (
        <ChipRow key={knob.key} label={knob.label}>
          {knob.values.map((value, i) => (
            <Chip
              key={String(value)}
              on={opts[knob.key] === value}
              onPress={() => tune(knob.key, value)}
              label={knob.labels?.[i] ?? String(value)}
            />
          ))}
        </ChipRow>
      ))}

      <ChipRow label="Motion">
        <Chip on={!still} onPress={() => setStill(false)} label="Loop" />
        <Chip on={still} onPress={() => setStill(true)} label="Still" />
      </ChipRow>

      {!still ? (
        <>
          {/* One chip per firmware bucket. `sameStep` rather than equality, so a loop
              saved at a speed that is not one of the ten still lights its own rung. */}
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

      <Fine>
        {still
          ? 'One panel of it, through the live buffer: free.'
          : `About ${Math.round(plan.panelSeconds)}s a pass, animating on the glasses with the phone away.`}
      </Fine>

      <View style={styles.actions}>
        {still ? (
          <FreeButton
            label="Show · free"
            onPress={() => flow.show(name, showable)}
            disabled={busy}
          />
        ) : (
          <FlashButton
            label="Send to glasses"
            onPress={() => flow.show(name, showable)}
            disabled={busy || blocked.length > 0}
          />
        )}
      </View>
      <View style={styles.keepRow}>
        <Link label="Keep in the library" onPress={() => void keep()} />
      </View>

      {blocked.map((problem) => (
        <Bad key={problem}>{problem}</Bad>
      ))}
      <StatusLine status={flow.status} />

      {/* The two facts a person cannot guess, in plan.ts's own words, behind one
          small toggle: "monochrome" and the device's own gap are otherwise learnt by
          surprise on a dark field, but printing them at everyone was the old screen's
          mistake. */}
      {!still ? (
        <View style={styles.fineprint}>
          <Link
            label={about ? 'less' : 'about these loops'}
            tone="dim"
            onPress={() => setAbout(!about)}
          />
          {about ? <Fine>{MONO_NOTE}</Fine> : null}
          {about ? <Fine>{PANEL_GAP_NOTE}</Fine> : null}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  actions: { gap: 10 },
  keepRow: { alignItems: 'center' },
  fineprint: { gap: 6, marginTop: 8 },
})
