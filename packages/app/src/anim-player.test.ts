import { describe, expect, test } from 'bun:test'
import { COLS, ROWS, type Bitmap, anim } from '@joggles/core'
import { FramePlayer, type FrameTarget } from './anim-player.js'

const frameAt = (col: number, level = 3): Bitmap => {
  const b = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 0))
  b[2][col] = level
  return b
}

const animOf = (cols: number[], ms: number): anim.Animation => ({
  frames: cols.map((c) => frameAt(c)),
  frameMs: cols.map(() => ms),
})

/** A virtual clock, so a hold time is asserted rather than waited for. */
function harness(opts: { idleMs?: number; stopAfter?: number } = {}) {
  let t = 0
  const slept: number[] = []
  const sets: Bitmap[] = []
  let release: (() => void) | null = null
  const target: FrameTarget & { stopped: boolean } = {
    stopped: false,
    set(next: Bitmap) {
      sets.push(next)
      return this
    },
    async idle() {
      t += opts.idleMs ?? 0
      if (opts.stopAfter !== undefined && sets.length >= opts.stopAfter) {
        target.stopped = true
      }
    },
  }
  const player = new FramePlayer({
    target: async () => target,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms)
      if (opts.stopAfter === undefined) {
        await new Promise<void>((r) => {
          release = r
        })
      }
      t += ms
    },
  })
  const litColumn = (b: Bitmap) => b[2].findIndex((v) => v > 0)
  return {
    player,
    target,
    slept,
    sets,
    order: () => sets.map(litColumn),
    releaseSleep: () => release?.(),
    clock: () => t,
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/**
 * Let a loop end on its own.
 *
 * `stop()` cannot stand in for this: it bumps the generation, so calling it straight after
 * `play()` cancels the loop before a single frame is written, which is correct behaviour
 * and useless for asserting what the loop does.
 */
const drain = async (player: FramePlayer) => {
  for (let i = 0; i < 2000 && player.playing; i++) await Promise.resolve()
}

describe('FramePlayer', () => {
  test('sets each frame in order and wraps back to the first', async () => {
    const h = harness({ stopAfter: 5 })
    h.player.play(animOf([1, 2], 100))
    await drain(h.player)
    expect(h.order()).toEqual([1, 2, 1, 2, 1])
  })

  test('a hold is measured from when the frame was set, not after it landed', async () => {
    const h = harness({ idleMs: 40, stopAfter: 2 })
    h.player.play(animOf([1, 2], 100))
    await drain(h.player)
    // 40 ms of the 100 ms hold went on the wire, so 60 remains, not 100.
    expect(h.slept).toEqual([60, 60])
  })

  test('when the wire cannot keep up it runs slow and never skips a frame', async () => {
    const h = harness({ idleMs: 150, stopAfter: 4 })
    h.player.play(animOf([1, 2], 100))
    await drain(h.player)
    // Nothing slept, because every frame overran its own hold...
    expect(h.slept).toEqual([])
    // ...and every frame still went out, in order. A dropped frame would leave stale
    // columns on the panel, which is worse than being late.
    expect(h.order()).toEqual([1, 2, 1, 2])
  })

  test('a one-frame animation is a still: set once, then done', async () => {
    const h = harness()
    h.player.play(animOf([7], 100))
    await settle()
    expect(h.sets).toHaveLength(1)
    expect(h.player.playing).toBe(false)
    expect(h.slept).toEqual([])
  })

  test('an empty animation is a no-op rather than a spin or a throw', async () => {
    const h = harness()
    h.player.play({ frames: [], frameMs: [] })
    await settle()
    expect(h.sets).toEqual([])
    expect(h.player.playing).toBe(false)
  })

  test('stop halts after the frame in flight and writes nothing more', async () => {
    const h = harness()
    h.player.play(animOf([1, 2, 3], 100))
    await settle()
    expect(h.order()).toEqual([1])
    const stopping = h.player.stop()
    h.releaseSleep()
    await stopping
    expect(h.order()).toEqual([1])
    expect(h.player.playing).toBe(false)
  })

  test('stop never clears: the last frame stays lit', async () => {
    const h = harness({ stopAfter: 2 })
    h.player.play(animOf([1, 2], 100))
    await drain(h.player)
    // Structurally guaranteed - `FrameTarget` has no clear - and asserted so that
    // widening the interface later has to come past this test.
    expect(Object.keys(h.target).sort()).toEqual(['idle', 'set', 'stopped'])
  })

  test('playing a second animation replaces the first, and the first writes no more', async () => {
    const h = harness()
    h.player.play(animOf([1, 2], 100))
    await settle()
    expect(h.order()).toEqual([1])
    h.player.play(animOf([9], 100))
    h.releaseSleep()
    await settle()
    // The still from the second animation, and no further frame from the first.
    expect(h.order()).toEqual([1, 9])
  })

  test('a sender that dies mid-loop stops the player rather than writing on', async () => {
    const h = harness({ stopAfter: 3 })
    h.player.play(animOf([1, 2], 100))
    await drain(h.player)
    expect(h.sets).toHaveLength(3)
    expect(h.target.stopped).toBe(true)
  })

  test('a target that refuses to open reports once and leaves nothing playing', async () => {
    const seen: unknown[] = []
    const player = new FramePlayer({
      target: async () => {
        throw new Error('not connected')
      },
      onError: (e) => seen.push(e),
    })
    player.play(animOf([1, 2], 100))
    await settle()
    expect(seen).toHaveLength(1)
    expect((seen[0] as Error).message).toBe('not connected')
    expect(player.playing).toBe(false)
  })

  test('stop is safe when nothing is playing', async () => {
    const h = harness()
    await h.player.stop()
    expect(h.player.playing).toBe(false)
  })
})
