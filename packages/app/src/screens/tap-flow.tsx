/**
 * The shared shape of "show this": plan it, run it, say what happened. Nothing else.
 *
 * The first version put a cost sheet in front of flash plans and an alert in front
 * of anything that replaced live work. Both are gone by Jacob's ruling on first
 * contact (2026-08-12, verbatim in `notes/what-to-build.md`): confirmations are the
 * cost, human taps cannot realistically wear the flash out, and the budget guard in
 * `core/src/budget.ts` already stands between a runaway and the hardware. So a tap
 * is a tap. What survives here is the routing (`planTap` still refuses a dark
 * upload and a disconnected send) and one status line whose message comes from the
 * executor, so every screen reports a send in the same words.
 */
import { useCallback, useState } from 'react'
import {
  type Showable,
  type Tap,
  type TapContext,
  type TapResult,
  planTap,
} from '../one-tap.js'
import type { Status } from '../ui.js'

export function useTapFlow({
  ctx,
  busy,
  onTap,
}: {
  ctx: TapContext
  busy: boolean
  onTap: (
    what: Showable,
    plan: Tap,
    progress?: (sent: number, total: number) => void,
  ) => Promise<TapResult>
}) {
  const [status, setStatus] = useState<Status | null>(null)

  /**
   * What `TapDeps.progress` is wired to. Only a `busy` status takes an update, so a
   * late block arriving after the result cannot resurrect the bar over the outcome.
   */
  const onProgress = useCallback((sent: number, total: number) => {
    setStatus((held) =>
      held === null || held.kind !== 'busy'
        ? held
        : { ...held, progress: total > 0 ? sent / total : 0 },
    )
  }, [])

  /** Plan a tap and run it. Blocked says why; everything else goes. */
  const show = useCallback(
    (title: string, what: Showable) => {
      if (busy) return
      const plan = planTap(what, ctx)
      if (plan.kind === 'blocked') {
        setStatus({ kind: 'bad', message: plan.why.join(' ') })
        return
      }
      // A save is the only plan with blocks to count, and it is the only one long
      // enough to need a bar: everything else is one write. Starting at 0 rather than
      // at undefined means the track appears with the message, so a bar arriving late
      // does not shift the layout under a thumb.
      setStatus({
        kind: 'busy',
        message: `sending ${title}...`,
        ...(plan.kind === 'save' ? { progress: 0 } : {}),
      })
      void onTap(what, plan, onProgress).then((out) =>
        setStatus({ kind: out.showing ? 'good' : 'bad', message: out.message }),
      )
    },
    [busy, ctx, onTap, onProgress],
  )

  return { status, setStatus, show, onProgress }
}
