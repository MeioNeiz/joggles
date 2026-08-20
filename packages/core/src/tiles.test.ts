import { describe, expect, test } from 'bun:test'
import * as content from './content.js'
import { COLS, MAX_LEVEL, ROWS, alive } from './display.js'
import * as jgx from './jgx.js'
import * as tiles from './tiles.js'

const CAPS = jgx.CAP.CONTENT | jgx.CAP.TILES

/** A palette that can draw a lit panel and a dark one, and nothing else. */
const litPanel = (level = MAX_LEVEL): content.Bitmap =>
  Array.from({ length: ROWS }, () => new Array(COLS).fill(level))

const dark = (): content.Bitmap => content.blank(COLS)

const ack = (sub: number, code = jgx.STATUS.OK): jgx.Ack => ({ type: 'ack', sub, code })

/** Walk a painter's four defines to completion, as a caller would. */
const define = (painter: tiles.Painter): void => {
  for (let step = painter.next(); step; step = painter.next()) {
    painter.sent(step)
    painter.confirm(ack(jgx.SUB.TILE_DEF))
  }
}

describe('a palette cannot be half built', () => {
  test('every palette holds TILE_COUNT entries, whatever it was given', () => {
    for (const n of [0, 1, 3, 5, 15, 16]) {
      const p = tiles.Palette.of(new Array(n).fill(0x3ffff))
      expect(p.words.length).toBe(jgx.TILE_COUNT)
    }
  })

  test('the padding is dark, so an unused entry draws nothing', () => {
    const p = tiles.Palette.of([0x3ffff])
    expect(p.words.slice(1)).toEqual(new Array(jgx.TILE_COUNT - 1).fill(tiles.DARK_TILE))
    expect(p.levels(15)).toEqual(new Array(ROWS).fill(0))
  })

  test('a seventeenth tile is refused rather than dropped', () => {
    expect(() => tiles.Palette.of(new Array(17).fill(0))).toThrow(/16 tiles, got 17/)
  })

  test('words and level arrays are the same thing', () => {
    const levels = [3, 0, 1, 2, 3, 0, 1, 2, 3]
    const p = tiles.Palette.of([levels])
    expect(p.words[0]).toBe(jgx.tileWord(levels))
    expect(p.levels(0)).toEqual(levels)
    expect(p.indexOf(levels)).toBe(0)
    expect(p.indexOf(jgx.tileWord(levels))).toBe(0)
  })

  test('a word outside the 18 bits, or a level outside 0-3, is refused', () => {
    expect(() => tiles.Palette.of([jgx.TILE_WORD_MASK + 1])).toThrow()
    expect(() => tiles.Palette.of([[4, 0, 0, 0, 0, 0, 0, 0, 0]])).toThrow()
    expect(() => tiles.Palette.of([[3, 3, 3]])).toThrow()
  })

  test('a tile the palette does not hold answers -1, not 0', () => {
    expect(tiles.Palette.of([0x3ffff]).indexOf(0x2aaaa)).toBe(-1)
  })

  test('a duplicate tile resolves to its first entry', () => {
    const p = tiles.Palette.of([0, 0x3ffff, 0x3ffff])
    expect(p.indexOf(0x3ffff)).toBe(1)
  })

  test('an entry outside the palette is a range error, not undefined levels', () => {
    expect(() => tiles.Palette.of([0]).levels(16)).toThrow()
    expect(() => tiles.Palette.of([0]).levels(-1)).toThrow()
  })
})

describe('a tile has no position, so the frame carries the mask', () => {
  test('no column word sets a bit where the panel has no LED', () => {
    const words = tiles.columnWords(litPanel())
    words.forEach((word, c) => {
      jgx.tileLevels(word).forEach((level, r) => {
        expect(alive(r, c) ? level : 0).toBe(level)
      })
    })
  })

  test('identical content masks to different tiles either side of the notch', () => {
    const words = tiles.columnWords(litPanel())
    // Full column, one with the notched top and bottom, one that also loses row 1.
    expect(new Set(words).size).toBe(3)
    expect(words[0]).not.toBe(words[11])
    expect(words[9]).not.toBe(words[11])
    expect(words[0]).toBe(words[23])
  })

  test('rows 2-7 are the band where a tile costs the same in every column', () => {
    const band = content.blank(COLS)
    for (let r = 2; r <= 7; r++) band[r].fill(MAX_LEVEL)
    expect(new Set(tiles.columnWords(band)).size).toBe(1)
  })

  test('a sloppy renderer is normalised rather than refused', () => {
    const ragged = [[3, 3], [2.4], [], [0, 0, 0, 9]]
    const words = tiles.columnWords(ragged)
    expect(words.length).toBe(COLS)
    expect(jgx.tileLevels(words[0])).toEqual([3, 2, 0, 0, 0, 0, 0, 0, 0])
    expect(jgx.tileLevels(words[3])).toEqual([0, 0, 0, MAX_LEVEL, 0, 0, 0, 0, 0])
  })
})

describe('planning a picture', () => {
  test('tiles come out most used first, which is what makes one define enough', () => {
    const plan = tiles.plan([litPanel()])
    expect(plan.distinct).toBe(3)
    expect(plan.palette.words[0]).toBe(tiles.columnWords(litPanel())[0])
    expect(plan.frames[0][0]).toBe(0)
    // 18 full columns, then the four that lose row 1 too, then the two between them.
    expect(plan.frames[0][11]).toBe(1)
    expect(plan.frames[0][9]).toBe(2)
    expect(plan.defines).toBe(1)
  })

  test('every one of the 24 columns round-trips through the palette', () => {
    const panel = content.text('HI').bitmap
    const plan = tiles.plan([panel])
    const words = tiles.columnWords(panel)
    expect(plan.frames[0].length).toBe(COLS)
    plan.frames[0].forEach((entry, c) => {
      expect(plan.palette.words[entry]).toBe(words[c])
    })
  })

  test('several panels share one palette, and the frames stay in order', () => {
    const plan = tiles.plan([dark(), litPanel(), dark()])
    expect(plan.frames.length).toBe(3)
    expect(plan.frames[0]).toEqual(plan.frames[2])
    expect(plan.frames[0]).not.toEqual(plan.frames[1])
    expect(plan.palette.indexOf(tiles.DARK_TILE)).toBeGreaterThanOrEqual(0)
  })

  test('defines counts the steps that must land before the frames are drawable', () => {
    // Nine distinct columns, so the highest entry used is 8 and three defines are owed.
    const nine = content.blank(COLS)
    for (let c = 0; c < 8; c++) nine[2 + (c % 6)][c] = MAX_LEVEL
    const plan = tiles.plan([nine])
    expect(plan.distinct).toBe(7)
    expect(plan.defines).toBe(Math.ceil(plan.distinct / jgx.TILE_DEF_ENTRIES))
  })

  test('more than sixteen distinct columns is refused, with the number in it', () => {
    const many = content.blank(COLS)
    // The column index written in binary across rows 2-7, so 24 distinct patterns and
    // none of them touched by the mask.
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < 6; r++) many[2 + r][c] = (c >> r) & 1 ? MAX_LEVEL : 0
    }
    const problems = tiles.planProblems([many])
    expect(problems.length).toBe(1)
    expect(problems[0]).toMatch(/distinct columns and a palette holds 16/)
    expect(problems[0]).toMatch(/nose notch/)
    expect(() => tiles.plan([many])).toThrow(/palette holds 16/)
  })

  test('a panel wider than the frame is named rather than silently clipped', () => {
    const wide = content.blank(COLS + 6)
    expect(tiles.planProblems([wide])[0]).toMatch(/wider than the 24 columns/)
  })

  test('nothing to draw is a sentence, not an empty plan', () => {
    expect(tiles.planProblems([])).toEqual(['no panels to draw'])
    expect(() => tiles.plan([])).toThrow(/no panels/)
  })
})

describe('the wire ceilings both sub-commands were shaped by', () => {
  test('a define is the longest body the dispatcher takes, and one ATT write', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(tiles.plan([litPanel()]).palette)
    for (const step of painter.pending()) {
      expect(step.frame[0]).toBe(jgx.MAX_BODY)
      expect(step.frame[0]).toBeLessThanOrEqual(15)
      expect(step.frame.length).toBe(16)
      expect(step.frame[0]).toBeGreaterThanOrEqual(jgx.MIN_BODY)
    }
  })

  test('a fifth palette entry would not fit, which is why the palette is not atomic', () => {
    expect(1 + jgx.TILE_DEF_ENTRIES * jgx.TILE_WORD_BYTES).toBe(jgx.MAX_PAYLOAD)
    expect(1 + 5 * jgx.TILE_WORD_BYTES).toBeGreaterThan(jgx.MAX_PAYLOAD)
    expect(jgx.TILE_COUNT / jgx.TILE_DEF_ENTRIES).toBe(tiles.DEFINE_FIRSTS.length)
  })

  test('a frame is 24 nibbles inside the same ceiling, with a byte to spare', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(tiles.Palette.of([0]))
    define(painter)
    const frame = painter.frame(new Array(COLS).fill(0))
    expect(frame[0]).toBe(COLS / 2 + 2)
    expect(frame[0]).toBeLessThan(jgx.MAX_BODY)
    expect(frame.length).toBe(16)
  })

  test('all 24 nibbles survive the round trip, in the right halves of each byte', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(tiles.Palette.of(Array.from({ length: 16 }, (_, i) => i)))
    define(painter)
    for (const indices of [
      Array.from({ length: COLS }, (_, i) => i % jgx.TILE_COUNT),
      Array.from({ length: COLS }, (_, i) => (i % 2 ? 15 : 0)),
      Array.from({ length: COLS }, (_, i) => (i % 2 ? 0 : 15)),
      new Array(COLS).fill(9),
    ]) {
      const cmd = jgx.parseCommand(painter.frame(indices))!
      expect(cmd.sub).toBe(jgx.SUB.TILE_FRAME)
      expect(jgx.readTileFrame(cmd.args)).toEqual(indices)
    }
  })

  test('a define round-trips its four words and where they start', () => {
    const words = [0x3ffff, 0x2aaaa, 0x15555, 0]
    const painter = new tiles.Painter(CAPS)
    painter.use(tiles.Palette.of([...new Array(8).fill(0), ...words]))
    const step = painter.pending().find((s) => s.first === 8)!
    const cmd = jgx.parseCommand(step.frame)!
    expect(cmd.sub).toBe(jgx.SUB.TILE_DEF)
    expect(jgx.readTileDefine(cmd.args)).toEqual({ first: 8, words })
  })
})

describe('the palette state a painter is allowed to draw from', () => {
  const palette = () => tiles.Palette.of(Array.from({ length: 16 }, (_, i) => i * 0x101))

  test('a unit that never advertised TILES is refused before anything else', () => {
    const painter = new tiles.Painter(jgx.CAP.CONTENT)
    expect(painter.supported).toBe(false)
    painter.use(palette())
    define(painter)
    expect(painter.problems(new Array(COLS).fill(0))[0]).toMatch(/did not advertise TILES/)
    expect(() => painter.frame(new Array(COLS).fill(0))).toThrow(/HELLO for this connection/)
  })

  test('nothing can be drawn before a palette is chosen', () => {
    const painter = new tiles.Painter(CAPS)
    expect(painter.palette).toBeNull()
    expect(painter.ready).toBe(false)
    expect(painter.next()).toBeNull()
    expect(painter.problems(new Array(COLS).fill(0))).toContain(
      'no palette has been defined: call use() first',
    )
    expect(() => painter.draw(dark())).toThrow(/use\(\) first/)
  })

  test('a half-defined palette can draw from the entries that landed, and no others', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(palette())
    expect(painter.pending().map((s) => s.first)).toEqual([0, 4, 8, 12])

    const first = painter.next()!
    painter.sent(first)
    expect(painter.confirm(ack(jgx.SUB.TILE_DEF))).toBe(true)

    // Entries 0-3 are believed held, so a frame using only those is safe.
    expect(painter.frame(new Array(COLS).fill(3)).length).toBe(16)
    expect([0, 1, 2, 3].every((e) => painter.holds(e))).toBe(true)
    expect(painter.holds(4)).toBe(false)
    expect(painter.ready).toBe(false)

    // One column reaching entry 4 is enough to refuse the whole frame.
    const reaching = new Array(COLS).fill(0)
    reaching[7] = 4
    expect(painter.problems(reaching)[0]).toMatch(
      /entries 4 have not been acknowledged .* whatever the last palette left there/,
    )
    expect(() => painter.frame(reaching)).toThrow(/not been acknowledged/)
  })

  test('ready means all sixteen, and only after four ACKs', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(palette())
    for (let i = 0; i < 4; i++) {
      expect(painter.ready).toBe(false)
      const step = painter.next()!
      painter.sent(step)
      painter.confirm(ack(jgx.SUB.TILE_DEF))
    }
    expect(painter.ready).toBe(true)
    expect(painter.next()).toBeNull()
    expect(painter.pending()).toEqual([])
  })

  test('a define that failed is not believed', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(palette())
    const step = painter.next()!
    painter.sent(step)
    expect(painter.confirm(ack(jgx.SUB.TILE_DEF, jgx.STATUS.BUSY))).toBe(false)
    expect(painter.holds(0)).toBe(false)
    expect(painter.next()!.first).toBe(0)
  })

  test('an ACK for something else changes nothing', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(palette())
    painter.sent(painter.next()!)
    expect(painter.confirm(ack(jgx.SUB.SMOOTH))).toBe(false)
    expect(painter.holds(0)).toBe(false)
    // And the define is still outstanding, so the real ACK still lands.
    expect(painter.confirm(ack(jgx.SUB.TILE_DEF))).toBe(true)
    expect(painter.holds(0)).toBe(true)
  })

  test('an ACK with nothing outstanding is not credited to anything', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(palette())
    expect(painter.confirm(ack(jgx.SUB.TILE_DEF))).toBe(false)
    expect(painter.ready).toBe(false)
  })

  test('two defines cannot be outstanding, because an ACK names no entry', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(palette())
    const [one, two] = painter.pending()
    painter.sent(one)
    expect(() => painter.sent(two)).toThrow(/awaiting an ACK/)
    // Re-sending the same one is how a lost ACK is handled.
    expect(() => painter.sent(one)).not.toThrow()
  })

  test('a step that is already held, or from another palette, is refused', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(palette())
    const stale = painter.next()!
    painter.sent(stale)
    painter.confirm(ack(jgx.SUB.TILE_DEF))
    expect(() => painter.sent(stale)).toThrow(/already held/)

    painter.use(tiles.Palette.of(new Array(16).fill(0x3ffff)))
    expect(() => painter.sent(stale)).toThrow(/no longer using/)
    expect(() => painter.sent({ ...stale, first: 3 })).toThrow(/not the first entry/)
  })

  test('swapping a palette keeps the beliefs the two agree on', () => {
    const painter = new tiles.Painter(CAPS)
    const words = Array.from({ length: 16 }, (_, i) => i * 0x101)
    painter.use(tiles.Palette.of(words))
    define(painter)

    const changed = [...words]
    changed[15] = 0x3ffff
    painter.use(tiles.Palette.of(changed))
    expect(painter.pending().map((s) => s.first)).toEqual([12])
    expect(painter.holds(15)).toBe(false)
    expect(painter.holds(12)).toBe(true)
  })

  test('a palette swap drops the outstanding define with it', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(palette())
    painter.sent(painter.next()!)
    painter.use(tiles.Palette.of(new Array(16).fill(0x1)))
    expect(painter.confirm(ack(jgx.SUB.TILE_DEF))).toBe(false)
    expect(painter.holds(0)).toBe(false)
  })

  test('forget believes nothing again, because nothing can read a palette back', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(palette())
    define(painter)
    expect(painter.ready).toBe(true)
    painter.forget()
    expect(painter.ready).toBe(false)
    expect(painter.pending().map((s) => s.first)).toEqual([0, 4, 8, 12])
    expect(painter.palette).not.toBeNull()
  })

  test('abandon puts an unanswered define back on the pending list', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(palette())
    painter.sent(painter.next()!)
    painter.abandon()
    expect(painter.confirm(ack(jgx.SUB.TILE_DEF))).toBe(false)
    expect(painter.next()!.first).toBe(0)
  })

  test('a malformed frame is refused whatever the palette state', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(palette())
    define(painter)
    expect(() => painter.frame(new Array(23).fill(0))).toThrow(/24 columns, got 23/)
    expect(() => painter.frame(new Array(COLS).fill(16))).toThrow(/not palette entries/)
    expect(() => painter.frame(new Array(COLS).fill(-1))).toThrow(/not palette entries/)
    expect(() => painter.frame(new Array(COLS).fill(1.5))).toThrow(/not palette entries/)
    expect(painter.holds(99)).toBe(false)
  })
})

describe('drawing a bitmap through a painter', () => {
  test('a planned palette draws its own panels', () => {
    const panel = content.text('HI').bitmap
    const plan = tiles.plan([panel])
    const painter = new tiles.Painter(CAPS)
    painter.use(plan.palette)
    define(painter)
    const cmd = jgx.parseCommand(painter.draw(panel))!
    expect(jgx.readTileFrame(cmd.args)).toEqual(plan.frames[0])
  })

  test('a column the palette cannot draw names the column, rather than drawing dark', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(tiles.Palette.of([tiles.DARK_TILE]))
    define(painter)
    const panel = content.blank(COLS)
    panel[3][5] = MAX_LEVEL
    expect(() => painter.draw(panel)).toThrow(/columns 5 need tiles this palette does not hold/)
  })

  test('a frame changes no belief, because TILE_FRAME is never answered', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(tiles.Palette.of([tiles.DARK_TILE]))
    const step = painter.next()!
    painter.sent(step)
    painter.confirm(ack(jgx.SUB.TILE_DEF))
    const before = painter.pending().map((s) => s.first)
    const one = painter.frame(new Array(COLS).fill(0))
    const two = painter.frame(new Array(COLS).fill(0))
    expect([...two]).toEqual([...one])
    expect(painter.pending().map((s) => s.first)).toEqual(before)
    expect(painter.ready).toBe(false)
  })

  test('a still is the frame plus resends, since a dropped last frame is permanent', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(tiles.Palette.of([tiles.DARK_TILE]))
    define(painter)
    const indices = new Array(COLS).fill(0)
    const sent = painter.still(indices)
    expect(sent.length).toBe(tiles.STILL_RESENDS + 1)
    expect(sent.every((f) => [...f].join() === [...sent[0]].join())).toBe(true)
    // Distinct buffers, so a caller that encrypts in place cannot corrupt the rest.
    expect(sent[0]).not.toBe(sent[1])
    expect(painter.still(indices, 0).length).toBe(1)
    expect(() => painter.still(indices, -1)).toThrow()
  })

  test('a still goes through the same gate as a frame', () => {
    const painter = new tiles.Painter(CAPS)
    painter.use(tiles.Palette.of(Array.from({ length: 16 }, (_, i) => i * 0x101)))
    painter.sent(painter.next()!)
    painter.confirm(ack(jgx.SUB.TILE_DEF))
    expect(() => painter.still(new Array(COLS).fill(15))).toThrow(/not been acknowledged/)
  })
})
