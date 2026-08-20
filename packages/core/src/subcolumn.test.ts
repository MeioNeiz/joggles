import { describe, expect, test } from 'bun:test'
import * as content from './content.js'
import { COLS, MAX_LEVEL, ROWS, alive } from './display.js'
import * as jgx from './jgx.js'
import * as protocol from './protocol.js'
import * as sub from './subcolumn.js'
import * as tiles from './tiles.js'
import * as viewport from './viewport.js'

const LEVELS = [0, 1, 2, 3]
const STEPS = [1, 2, 3, 4]
const SPEEDS = [0, 5, 15, 25, 35, 45, 55, 65, 75, 85, 95, 100]

/** A word wide enough to scroll, at full level, monochrome. */
const word = (body = 'JOGGLES') =>
  content.text(body, { kind: 'scroll', dir: 0, speed: 50 })

const lit = (bitmap: content.Bitmap): number =>
  bitmap.reduce((n, row) => n + row.filter((v) => v > 0).length, 0)

describe('the blend itself', () => {
  test('sub-step 0 is the column it came from, at every setting', () => {
    for (const steps of STEPS) {
      for (const a of LEVELS) {
        for (const b of LEVELS) expect(sub.blendLevel(a, b, 0, steps)).toBe(a)
      }
    }
  })

  test('there is no sub-step equal to steps: that frame is the next column', () => {
    for (const steps of STEPS) {
      expect(() => sub.blendLevel(3, 0, steps, steps)).toThrow(/outside 0-/)
      expect(() => sub.blendLevel(3, 0, -1, steps)).toThrow()
    }
  })

  test('the settings outside 1 to 4 are refused, as SUB.SMOOTH refuses them', () => {
    expect(sub.OFF).toBe(jgx.SMOOTH_OFF)
    expect(sub.MAX_STEPS).toBe(jgx.SMOOTH_MAX)
    for (const bad of [0, 5, 1.5, -1]) {
      expect(() => sub.blendLevel(0, 3, 0, bad)).toThrow()
      expect(() => sub.blendTable(bad)).toThrow()
      expect(() => sub.frames(word().bitmap, { steps: bad })).toThrow()
    }
  })

  test('a level outside the panel is refused rather than clamped', () => {
    expect(() => sub.blendLevel(4, 0, 0, 2)).toThrow(/from level 4/)
    expect(() => sub.blendLevel(0, -1, 0, 2)).toThrow(/to level -1/)
    expect(() => sub.blendLevel(0, 1.5, 0, 2)).toThrow()
  })

  test('a blend never leaves the range of the two columns it mixes', () => {
    for (const steps of STEPS) {
      for (const a of LEVELS) {
        for (const b of LEVELS) {
          for (let s = 0; s < steps; s++) {
            const v = sub.blendLevel(a, b, s, steps)
            expect(v).toBeGreaterThanOrEqual(Math.min(a, b))
            expect(v).toBeLessThanOrEqual(Math.max(a, b))
          }
        }
      }
    }
  })

  test('darkness cannot be blended into light', () => {
    for (const steps of STEPS) {
      for (let s = 0; s < steps; s++) expect(sub.blendLevel(0, 0, s, steps)).toBe(0)
    }
  })

  test('rounding up is what keeps a level 1 feature from flickering out', () => {
    // Truncating would light this in one sub-step of four instead of three.
    expect([0, 1, 2, 3].map((s) => sub.blendLevel(1, 0, s, 4))).toEqual([1, 1, 1, 0])
    expect([0, 1].map((s) => sub.blendLevel(1, 0, s, 2))).toEqual([1, 1])
    expect([0, 1].map((s) => sub.blendLevel(0, 1, s, 2))).toEqual([0, 1])
  })

  test('the midpoint of a hard edge is two columns of level 2, not one of 3', () => {
    // The reason the docblock refuses to call this a brightness model: whether that
    // reads as constant light depends on a curve the panel module owns.
    expect(sub.blendLevel(3, 0, 1, 2)).toBe(2)
    expect(sub.blendLevel(0, 3, 1, 2)).toBe(2)
  })

  test('the table the firmware can carry agrees with the arithmetic exactly', () => {
    for (const steps of STEPS) {
      const table = sub.blendTable(steps)
      expect(table.length).toBe(MAX_LEVEL * steps + 1)
      for (const a of LEVELS) {
        for (const b of LEVELS) {
          for (let s = 0; s < steps; s++) {
            expect(table[a * (steps - s) + b * s]).toBe(sub.blendLevel(a, b, s, steps))
          }
        }
      }
    }
    // Thirteen entries at the widest, which is why no divide is needed on ARMv6-M.
    expect(sub.blendTable(4).length).toBe(13)
  })
})

describe('the preview walks viewport loop and not a second copy of it', () => {
  for (const loop of ['uploaded', 'panel'] as const) {
    for (const dir of [0, 1] as const) {
      test(`one sub-step is exactly the unsmoothed walk (${loop}, dir ${dir})`, () => {
        const bitmap = word().bitmap
        expect(sub.frames(bitmap, { steps: 1, loop, dir })).toEqual(
          viewport.frames(bitmap, { kind: 'scroll', dir }, { loop }),
        )
      })

      test(`every whole-column frame is the frame viewport draws (${loop}, dir ${dir})`, () => {
        const bitmap = word().bitmap
        const plain = viewport.frames(bitmap, { kind: 'scroll', dir }, { loop })
        for (const steps of STEPS) {
          const smooth = sub.frames(bitmap, { steps, loop, dir })
          expect(smooth.length).toBe(plain.length * steps)
          plain.forEach((frame, i) => expect(smooth[i * steps]).toEqual(frame))
        }
      })
    }
  }

  test('the panel loop is 24 columns longer, and the blend fades into the gap', () => {
    const bitmap = word().bitmap
    const cols = content.width(bitmap)
    const panel = sub.frames(bitmap, { steps: 4, loop: 'panel' })
    expect(panel.length).toBe(viewport.marqueeWidth(cols) * 4)
    expect(panel.length - sub.frames(bitmap, { steps: 4 }).length).toBe(24 * 4)
    // Somewhere in the pass the panel is entirely dark, and either side of that the
    // blend puts intermediate levels on the panel rather than jumping to it.
    expect(panel.some((f) => lit(f) === 0)).toBe(true)
    expect(panel.some((f) => f.some((row) => row.some((v) => v > 0 && v < MAX_LEVEL))))
      .toBe(true)
  })

  test('the direction decides which column is the incoming one', () => {
    const bitmap = content.normalise([[], [], [3, 0, 0, 0], [3, 0, 0, 0]])
    const back = viewport.scrollOffsets(4, 1)
    expect(back).toEqual([0, 3, 2, 1])
    // Under dir 1 the walk runs backwards, so the frame after offset 0 is offset 3 and
    // that is what a sub-step between them has to blend towards.
    expect(sub.frames(bitmap, { steps: 2, dir: 1 })[1]).toEqual(
      sub.blendAt(bitmap, 0, 3, 1, { steps: 2 }),
    )
    expect(sub.frames(bitmap, { steps: 2, dir: 0 })[1]).toEqual(
      sub.blendAt(bitmap, 0, 1, 1, { steps: 2 }),
    )
  })

  test('empty content is one dark frame, not `steps` of them', () => {
    for (const steps of STEPS) {
      expect(sub.frames([], { steps })).toEqual([content.blank(COLS)])
    }
  })

  test('smoothing actually changes something, or it would not be worth the sub-command', () => {
    const bitmap = word().bitmap
    const plain = sub.frames(bitmap, { steps: 1 })
    const smooth = sub.frames(bitmap, { steps: 4 })
    const grey = (fs: content.Bitmap[]) =>
      fs.filter((f) => f.some((row) => row.some((v) => v > 0 && v < MAX_LEVEL))).length
    expect(grey(plain)).toBe(0)
    expect(grey(smooth)).toBeGreaterThan(0)
  })
})

describe('no blend lights a pixel the panel does not have', () => {
  test('every frame at every setting is masked at the window', () => {
    const bitmap = content.normalise(
      Array.from({ length: ROWS }, () => new Array(40).fill(MAX_LEVEL)),
    )
    for (const steps of STEPS) {
      for (const loop of ['uploaded', 'panel'] as const) {
        for (const frame of sub.frames(bitmap, { steps, loop })) {
          for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
              if (!alive(r, c)) expect(frame[r][c]).toBe(0)
            }
          }
        }
      }
    }
  })

  test('a blend of a solid panel leaves exactly the panel silhouette', () => {
    const solid = content.normalise(
      Array.from({ length: ROWS }, () => new Array(30).fill(MAX_LEVEL)),
    )
    const alives = ROWS * COLS - 6 - 6 - 4
    for (const steps of STEPS) {
      for (const frame of sub.frames(solid, { steps })) expect(lit(frame)).toBe(alives)
    }
  })

  test('content inside rows 2-7 never bleeds into a notched row', () => {
    const band = content.blank(30)
    for (let r = 2; r <= 7; r++) band[r].fill(MAX_LEVEL)
    for (const steps of STEPS) {
      for (const frame of sub.frames(band, { steps, loop: 'panel' })) {
        for (const r of [0, 1, 8]) expect(frame[r].every((v) => v === 0)).toBe(true)
      }
    }
  })
})

describe('previewing what the device is actually holding', () => {
  test('a type 1 scroll is previewed flattened, because the store is one bit deep', () => {
    const greyish = content.text('AB', { kind: 'scroll', dir: 0, speed: 50 }, { level: 1 })
    // Forced to type 1, which is what keeps a save persistent, so the grey goes.
    const frames = sub.scrollFrames(greyish, { steps: 4, type: 1 })
    const wholeColumn = frames.filter((_, i) => i % 4 === 0)
    for (const frame of wholeColumn) {
      for (const row of frame) for (const v of row) expect([0, MAX_LEVEL]).toContain(v)
    }
    // Blending the caller's own bitmap would have shown level 1 everywhere instead.
    expect(lit(wholeColumn[0]) + lit(wholeColumn[3])).toBeGreaterThan(0)
    expect(sub.frames(greyish.bitmap, { steps: 4 })[0]).not.toEqual(frames[0])
  })

  test('grey content is refused rather than previewed as a scroll it cannot do', () => {
    const grey = content.text('AB', { kind: 'scroll', dir: 0, speed: 50 }, { level: 2 })
    expect(content.savedType(grey)).toBe(2)
    const problems = sub.previewProblems(grey)
    expect(problems.length).toBe(1)
    expect(problems[0]).toMatch(/type 2.*still 24-column image/)
    expect(() => sub.scrollFrames(grey, { steps: 2 })).toThrow(/no column step to interpolate/)
    // Forcing type 1 is the offer the sentence makes, and it is honoured.
    expect(sub.scrollFrames(grey, { steps: 2, type: 1 }).length).toBeGreaterThan(0)
  })

  test('static content is one frame however many sub-steps are asked for', () => {
    const still = content.text('HI')
    expect(sub.previewProblems(still)).toEqual([])
    for (const steps of STEPS) {
      expect(sub.scrollFrames(still, { steps }).length).toBe(1)
    }
  })

  test('a scroll previews the same frames as the flattened bitmap does', () => {
    const item = word()
    const flat = content
      .flatten(item.bitmap)
      .map((row) => row.map((v) => (v ? MAX_LEVEL : 0)))
    expect(sub.scrollFrames(item, { steps: 3, loop: 'panel' })).toEqual(
      sub.frames(flat, { steps: 3, loop: 'panel', dir: 0 }),
    )
  })
})

describe('what the device sub-steps would cost on its own clock', () => {
  test('the sub-steps sum to the column, and none of them is shorter than a tick', () => {
    for (const speed of SPEEDS) {
      for (const steps of STEPS) {
        const t = sub.timing(speed, steps)
        expect(t.ticksPerColumn).toBe(protocol.speedDivisor(speed))
        expect(t.ticks.length).toBe(steps)
        expect(t.ticks.reduce((a, b) => a + b, 0)).toBe(t.ticksPerColumn)
        expect(Math.min(...t.ticks)).toBeGreaterThanOrEqual(1)
      }
    }
  })

  test('four sub-steps fit at every speed because the fastest column is four ticks', () => {
    expect(protocol.SPEED_FASTEST).toBe(sub.MAX_STEPS)
    expect(sub.timing(100, 4).ticks).toEqual([1, 1, 1, 1])
  })

  test('the sub-steps are uneven at most speeds, and that is the finding', () => {
    expect(sub.timing(0, 4).ticks).toEqual([3, 3, 3, 4])
    expect(sub.timing(0, 4).even).toBe(false)
    expect(sub.timing(15, 4).ticks).toEqual([3, 3, 3, 3])
    expect(sub.timing(15, 4).even).toBe(true)
    const even = SPEEDS.filter((v) => sub.timing(v, 4).even)
    expect(even.length).toBeLessThan(SPEEDS.length / 2)
  })

  test('evenSteps picks the biggest split that divides the column', () => {
    expect(sub.evenSteps(100)).toBe(4)
    expect(sub.evenSteps(15)).toBe(4)
    expect(sub.evenSteps(45)).toBe(3)
    expect(sub.evenSteps(35)).toBe(2)
    expect(sub.evenSteps(0)).toBe(sub.OFF)
    for (const speed of SPEEDS) {
      const steps = sub.evenSteps(speed)
      expect(sub.timing(speed, steps).even).toBe(true)
    }
  })

  test('the panel UART is never the binding constraint at either tick rate', () => {
    expect(sub.PANEL_FRAME_MS).toBeCloseTo(6.42, 2)
    for (const hz of jgx.TICK_RATES) {
      for (const speed of SPEEDS) {
        for (const steps of STEPS) {
          const t = sub.timing(speed, steps, hz)
          expect(t.fits).toBe(true)
          expect(t.shortestMs).toBe(Math.min(...t.ms))
        }
      }
    }
    // The tightest case there is: one tick of the 100 Hz patch per frame.
    expect(sub.timing(100, 4, 100).shortestMs).toBe(10)
  })

  test('the tick patch doubles the scroll rate rather than the smoothness', () => {
    const stock = sub.timing(50, 2, 50)
    const fast = sub.timing(50, 2, 100)
    expect(fast.ticks).toEqual(stock.ticks)
    expect(fast.ms.map((v) => v * 2)).toEqual(stock.ms)
  })
})

describe('the same look through tile frames, and what bounds it', () => {
  test('a blended pass needs at least as many tiles as the plain one', () => {
    const bitmap = word().bitmap
    let previous = 0
    for (const steps of STEPS) {
      const needed = tiles.tilesFor(sub.frames(bitmap, { steps })).length
      expect(needed).toBeGreaterThanOrEqual(previous)
      previous = needed
    }
  })

  test('smoothing JOGGLES host-side blows the sixteen-tile ceiling', () => {
    const bitmap = word().bitmap
    expect(tiles.planProblems(sub.frames(bitmap, { steps: 1 }))).toEqual([])
    expect(tiles.tilesFor(sub.frames(bitmap, { steps: 1 })).length).toBe(11)
    expect(tiles.planProblems(sub.frames(bitmap, { steps: 2 }))[0]).toMatch(
      /distinct columns and a palette holds 16/,
    )
  })

  test('a narrow loop still fits, which is what makes the route worth having', () => {
    const small = content.normalise([[], [], [0, 3, 3, 0, 0, 0], [0, 3, 0, 0, 0, 0]])
    const frames = sub.frames(small, { steps: 4 })
    expect(tiles.planProblems(frames)).toEqual([])
    const plan = tiles.plan(frames)
    expect(plan.distinct).toBeLessThanOrEqual(16)
    plan.frames.forEach((row, i) => {
      row.forEach((entry, c) => {
        expect(plan.palette.words[entry]).toBe(tiles.columnWords(frames[i])[c])
      })
    })
  })
})
