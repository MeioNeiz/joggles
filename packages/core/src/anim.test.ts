import { describe, expect, test } from 'bun:test'
import { COLS, MAX_LEVEL, ROWS } from './display.js'
import * as content from './content.js'
import * as dats from './dats.js'
import { MAX_SAVED_COLUMNS, hasGrey, width } from './content.js'
import { PACING_MS } from './protocol.js'
import * as anim from './anim.js'

/** A frame with every live pixel at `level`, so a test can state one difference from it. */
const solid = (level = 0): anim.Animation['frames'][number] =>
  Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => level))

const lit = (cells: Array<[number, number, number]>) => {
  const frame = solid(0)
  for (const [r, c, level] of cells) frame[r][c] = level
  return frame
}

const of = (frames: anim.Animation['frames'], ms: number[]): anim.Animation => ({
  frames,
  frameMs: ms,
})

describe('normalise', () => {
  test('a frame declaring 0 ms becomes the 100 ms every browser reads it as', () => {
    const out = anim.normalise(of([lit([[2, 2, 3]])], [0]))
    expect(out.frameMs).toEqual([anim.ZERO_DELAY_MS])
  })

  test('delays below the floor are clamped rather than priced as achievable', () => {
    const out = anim.normalise(of([lit([[2, 2, 3]])], [3]))
    expect(out.frameMs).toEqual([anim.MIN_FRAME_MS])
  })

  test('repeated frames merge into one held longer, so a duration is not doubled', () => {
    const pose = lit([[3, 4, 2]])
    const out = anim.normalise(of([pose, pose, pose], [40, 40, 40]))
    expect(out.frames).toHaveLength(1)
    expect(out.frameMs).toEqual([120])
    expect(anim.durationMs(out)).toBe(120)
  })

  test('only consecutive repeats merge: a two-pose cycle survives', () => {
    const a = lit([[2, 2, 3]])
    const b = lit([[2, 3, 3]])
    const out = anim.normalise(of([a, b, a, b], [50, 50, 50, 50]))
    expect(out.frames).toHaveLength(4)
  })

  test('frames differing only under a dead LED are the same picture and merge', () => {
    const a = lit([[8, 10, 3]])
    const b = solid(0)
    expect(anim.sameFrame(a, b)).toBe(true)
    const out = anim.normalise(of([a, b], [60, 60]))
    expect(out.frames).toHaveLength(1)
    expect(out.frameMs).toEqual([120])
  })
})

describe('changedColumns', () => {
  test('counts columns and not pixels', () => {
    const from = solid(0)
    const to = lit([
      [2, 5, 3],
      [3, 5, 3],
      [4, 5, 3],
    ])
    expect(anim.changedColumns(from, to)).toBe(1)
  })

  test('a difference only under a dead LED costs no write', () => {
    expect(anim.changedColumns(solid(0), lit([[1, 11, 3]]))).toBe(0)
    expect(anim.changedColumns(solid(0), lit([[0, 12, 3]]))).toBe(0)
  })

  test('every live column changing is the full sweep the docs warn about', () => {
    expect(anim.changedColumns(solid(0), solid(3))).toBe(COLS)
  })
})

describe('livePlan', () => {
  test('one frame is a still: the writes are what it lights, and never slow', () => {
    const plan = anim.livePlan(of([lit([[2, 7, 3]])], [100]))
    expect(plan.writes).toBe(1)
    expect(plan.slow).toBe(false)
  })

  test('the cycle pays for wrapping from the last frame back to the first', () => {
    const a = lit([[2, 0, 3]])
    const b = lit([[2, 1, 3]])
    // a->b changes 2 columns, b->a changes the same 2: 4 writes a cycle, not 2.
    const plan = anim.livePlan(of([a, b], [500, 500]))
    expect(plan.writes).toBe(4)
    expect(plan.wireMs).toBe(4 * PACING_MS)
  })

  test('sparse pixel art holds its drawn rate, which is the point of the route', () => {
    const a = lit([[2, 0, 3]])
    const b = lit([[2, 1, 3]])
    const plan = anim.livePlan(of([a, b], [200, 200]))
    expect(plan.slow).toBe(false)
    expect(plan.fps).toBeCloseTo(5, 5)
  })

  test('a full-panel change every frame runs slow, and says so rather than dropping', () => {
    const plan = anim.livePlan(of([solid(0), solid(3)], [10, 10]))
    expect(plan.writes).toBe(COLS * 2)
    expect(plan.slow).toBe(true)
    // The rate reported is what the wire can do, not what was asked for.
    expect(plan.fps).toBeCloseTo(2000 / (COLS * 2 * PACING_MS), 5)
  })

  test('an empty animation prices as nothing rather than throwing', () => {
    expect(anim.livePlan(of([], []))).toEqual({
      writes: 0,
      wireMs: 0,
      wantedMs: 0,
      slow: false,
      fps: 0,
    })
  })
})

describe('filmstrip', () => {
  test('frames land side by side, one panel width each', () => {
    const strip = anim.filmstrip(of([lit([[2, 0, 3]]), lit([[2, 0, 3]])], [100, 100]))
    expect(width(strip)).toBe(COLS * 2)
    expect(strip).toHaveLength(ROWS)
  })

  test('lit means MAX_LEVEL, so the strip still routes to the store that persists', () => {
    const grey = lit([
      [2, 3, 1],
      [2, 4, 3],
    ])
    expect(hasGrey(grey)).toBe(true)
    const strip = anim.filmstrip(of([grey], [100]))
    expect(strip[2][3]).toBe(MAX_LEVEL)
    expect(strip[2][4]).toBe(MAX_LEVEL)
    expect(new Set(strip.flat())).toEqual(new Set([0, MAX_LEVEL]))
    // The regression this pins: at 0/1, `hasGrey` reads the strip as grey and
    // `savedType` sends it to type 2, which neither persists nor shows past column 24.
    expect(hasGrey(strip)).toBe(false)
    expect(content.savedType(anim.filmstripPiece(of([grey], [100]), 50))).toBe(dats.TYPE_TEXT)
  })

  test('filmstripPiece is a wide saved scroller, the one shape that reaches flash', () => {
    const piece = anim.filmstripPiece(of([lit([[2, 0, 3]]), lit([[2, 1, 3]])], [100, 100]), 40, 1)
    expect(piece.route).toBe('saved')
    expect(piece.motion).toEqual({ kind: 'scroll', dir: 1, speed: 40 })
    expect(width(piece.bitmap)).toBe(COLS * 2)
    expect(content.check(piece)).toEqual([])
  })

  test('the strip stops at what one type 1 save holds', () => {
    expect(anim.maxFilmstripFrames()).toBe(Math.floor(MAX_SAVED_COLUMNS / COLS))
    const many = Array.from({ length: anim.maxFilmstripFrames() + 5 }, (_, i) =>
      lit([[2, i % COLS, 3]]),
    )
    const strip = anim.filmstrip(of(many, many.map(() => 100)))
    expect(width(strip)).toBe(anim.maxFilmstripFrames() * COLS)
    expect(width(strip)).toBeLessThanOrEqual(MAX_SAVED_COLUMNS)
  })

  test('filmstripLosesGrey reports before the flatten happens', () => {
    expect(anim.filmstripLosesGrey(of([lit([[2, 3, 2]])], [100]))).toBe(true)
    expect(anim.filmstripLosesGrey(of([lit([[2, 3, 3]])], [100]))).toBe(false)
  })
})

describe('hiddenPixels', () => {
  test('counts lit pixels the panel has no LED for, across every frame', () => {
    const one = lit([
      [8, 10, 3],
      [8, 11, 3],
      [2, 2, 3],
    ])
    expect(anim.hiddenPixels(of([one, one], [100, 100]))).toBe(4)
  })
})

describe('routeWords', () => {
  const walk = of([lit([[2, 0, 3]]), lit([[2, 1, 3]])], [200, 200])

  test('the live sentence says the phone stays, which is the whole difference', () => {
    const words = anim.routeWords(walk, 'live')
    expect(words).toContain('No flash')
    expect(words).toContain('disconnects')
    expect(words).toContain('frames a second')
  })

  test('a slow animation admits it in the sentence a screen prints', () => {
    const words = anim.routeWords(of([solid(0), solid(3)], [10, 10]), 'live')
    expect(words).toContain('Slower than it was drawn')
  })

  test('the filmstrip sentence says "pan", because that is what it is', () => {
    const words = anim.routeWords(walk, 'filmstrip')
    expect(words).toContain('pan')
    expect(words).toContain('One flash save')
    expect(words).toContain('with the phone away')
  })

  test('the filmstrip sentence warns about grey and about dropped frames', () => {
    expect(anim.routeWords(of([lit([[2, 3, 1]])], [100]), 'filmstrip')).toContain('Grey goes')
    const many = Array.from({ length: anim.maxFilmstripFrames() + 3 }, () => lit([[2, 1, 3]]))
    const words = anim.routeWords(of(many, many.map(() => 100)), 'filmstrip')
    expect(words).toContain('do not fit')
  })
})
