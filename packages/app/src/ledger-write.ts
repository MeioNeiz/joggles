/**
 * How the wear count reaches disk, and what to do when the rename will not.
 *
 * `ledger.ts` cannot be tested: it imports expo-file-system, which does not resolve
 * under bun. So the policy lives here as three closures over that module and the
 * decision between them is a `bun test`, the same split `ledger-shape.ts` exists for.
 * Losing the wear count is the failure the whole two-file store guards against - it is
 * the only cycle number that will ever exist for these glasses - so which branch runs
 * is worth asserting rather than hoping.
 *
 * **Write whole, then rename.** A rename is the one filesystem operation that cannot
 * leave a half-updated file behind, and this is written once per `DATCP`, which is
 * exactly when the app is busiest and most likely to be killed.
 *
 * **The rename is verified rather than assumed, which is review-12's fix.** `moveSync`
 * has never run outside bun on this project, and a rename that neither moves the file
 * nor throws is the one failure mode where the fallback below never fires and the phone
 * silently stops counting wear for good: every save still looks written because the
 * in-memory copy is right, and the loss only shows up as a lifetime count that reset
 * itself on the next app start. So `stranded()` asks whether the scratch file is still
 * where the rename should have moved it from, and a yes is treated as a throw.
 *
 * **A stranded scratch file is left where it is.** It is written whole before the
 * rename and overwritten by the next save, and nothing ever reads it, so deleting it
 * would add a failure path to a recovery path for tidiness alone.
 */

/** The three operations the policy needs, so it can be decided without a filesystem. */
export interface AtomicWrite {
  /** Write the whole file to a scratch path, then rename it over the target. */
  rename(): void
  /**
   * Whether the scratch file is still at the scratch path after `rename()`.
   *
   * It must ask through a **fresh** handle. expo-file-system's `moveSync` updates the
   * instance's own `uri` to the destination on success, so re-asking the handle that
   * did the move is a question about the ledger rather than about the scratch file.
   */
  stranded(): boolean
  /** Overwrite the target in place, which carries the tear `rename` exists to avoid. */
  inPlace(): void
}

/**
 * `renamed` is the good path, `in place` is the survivable one, `lost` is neither.
 *
 * `in place` still counts wear across restarts, which is why it is worth taking: the
 * risk it carries is one torn file if the app dies inside a write, against a certainty
 * of losing every count if nothing is written at all.
 */
export type WriteOutcome = 'renamed' | 'in place' | 'lost'

export function writeThroughTemp(
  w: AtomicWrite,
  complain: (what: string, e: unknown) => void,
): WriteOutcome {
  try {
    w.rename()
    if (w.stranded()) throw new Error('moveSync left the temp file where it was')
    return 'renamed'
  } catch (e) {
    complain('atomic write', e)
    try {
      w.inPlace()
      return 'in place'
    } catch (fallback) {
      complain('write', fallback)
      return 'lost'
    }
  }
}
