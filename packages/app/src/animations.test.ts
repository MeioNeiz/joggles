import { describe, expect, test } from 'bun:test'
import { COLS, ROWS, anim, quantise } from '@joggles/core'
import * as animations from './animations.js'

const row = (over: Partial<animations.PackRow> = {}): animations.PackRow => ({
  id: 'kenney-walk-0',
  name: 'Skeleton walk',
  tags: ['skeleton', 'walk', 'character'],
  pack: 'Kenney Platformer Characters',
  licence: 'CC0',
  author: 'Kenney',
  source: 'https://kenney.nl',
  frameMs: [100, 100],
  frames: ['aa', 'bb'],
  score: 0.8,
  ...over,
})

describe('moves and timing', () => {
  test('one frame is a still, more than one moves', () => {
    expect(animations.moves(row({ frames: ['aa'], frameMs: [100] }))).toBe(false)
    expect(animations.moves(row())).toBe(true)
  })

  test('a loop is the sum of its own frame times', () => {
    expect(animations.durationMs(row({ frameMs: [80, 120, 100] }))).toBe(300)
  })

  test('loopWords says frames and seconds, or just still', () => {
    expect(animations.loopWords(row({ frameMs: [250, 250] }))).toBe('2 frames, 0.5s')
    expect(animations.loopWords(row({ frames: ['aa'], frameMs: [100] }))).toBe('still')
  })
})

describe('matches', () => {
  test('an empty query matches everything, so a blank box hides nothing', () => {
    expect(animations.matches(row(), '')).toBe(true)
    expect(animations.matches(row(), '   ')).toBe(true)
  })

  test('the name matches, case-insensitively', () => {
    expect(animations.matches(row(), 'SKELETON')).toBe(true)
    expect(animations.matches(row(), 'skel')).toBe(true)
  })

  test('a tag matches even when the name does not contain it', () => {
    expect(animations.matches(row({ name: 'Bones' }), 'character')).toBe(true)
  })

  test('the pack and the author match, because that is a real thing to type', () => {
    expect(animations.matches(row(), 'kenney')).toBe(true)
    expect(animations.matches(row(), 'platformer')).toBe(true)
  })

  test('every term must hit, so two words narrow rather than widen', () => {
    expect(animations.matches(row(), 'skeleton walk')).toBe(true)
    expect(animations.matches(row(), 'skeleton dragon')).toBe(false)
  })

  test('nothing outside name, tags, pack and author is searched', () => {
    // The id and the licence are not a search surface: matching on them would let a
    // query hit rows for reasons a person cannot see on the tile.
    expect(animations.matches(row(), 'cc0')).toBe(false)
    expect(animations.matches(row({ name: 'Bones', tags: [] }), 'kenney-walk-0')).toBe(false)
  })
})

describe('search', () => {
  const rows = [
    row({ id: 'a', name: 'Skeleton walk', score: 0.9 }),
    row({ id: 'b', name: 'Coin spin', tags: ['coin'], score: 0.5 }),
    row({ id: 'c', name: 'Heart', tags: ['icon'], frames: ['aa'], frameMs: [100], score: 0.7 }),
    row({ id: 'd', name: 'Slime', tags: ['enemy'], pack: 'OGA Slimes', author: 'Bevouliin', score: 0.6 }),
  ]

  test('no filter returns everything given', () => {
    expect(animations.search({}, rows)).toHaveLength(4)
  })

  test('moving true drops the stills, moving false keeps only them', () => {
    expect(animations.search({ moving: true }, rows).map((r) => r.id)).toEqual([
      'a',
      'b',
      'd',
    ])
    expect(animations.search({ moving: false }, rows).map((r) => r.id)).toEqual(['c'])
  })

  test('a pack filter is exact, not a substring', () => {
    expect(animations.search({ pack: 'OGA Slimes' }, rows).map((r) => r.id)).toEqual(['d'])
    expect(animations.search({ pack: 'OGA' }, rows)).toEqual([])
  })

  test('query and filters compose', () => {
    expect(animations.search({ query: 'kenney', moving: true }, rows).map((r) => r.id)).toEqual(
      ['a', 'b'],
    )
  })

  test('the order given is the order returned, so filtering never reshuffles', () => {
    // `PACK` is sorted once at load; `search` must not pay to re-derive that per keystroke.
    const given = [
      row({ id: 'z', name: 'Zebra', score: 0.1 }),
      row({ id: 'm', name: 'Apple', score: 0.9 }),
    ]
    expect(animations.search({}, given).map((r) => r.id)).toEqual(['z', 'm'])
  })

  test('the shipped catalogue itself is sorted best-first, name breaking ties', () => {
    const scores = animations.PACK.map((r) => r.score)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
  })
})

describe('packs', () => {
  test('counts per source pack, biggest first', () => {
    const rows = [
      row({ pack: 'Kenney' }),
      row({ pack: 'Kenney' }),
      row({ pack: 'OGA' }),
    ]
    expect(animations.packs(rows)).toEqual([
      { name: 'Kenney', count: 2 },
      { name: 'OGA', count: 1 },
    ])
  })
})

describe('emptyWords', () => {
  test('an unharvested pack names the build step rather than looking lost', () => {
    const words = animations.emptyWords({}, 0)
    expect(words).toContain('animpack')
    expect(words).toContain('laptop')
  })

  test('a query that matched nothing says so, and quotes the query', () => {
    expect(animations.emptyWords({ query: 'dragon' }, 40)).toBe(
      'Nothing in the pack matches "dragon".',
    )
  })

  test('the two filter states get their own sentence', () => {
    expect(animations.emptyWords({ moving: true }, 40)).toBe('Nothing in this pack moves.')
    expect(animations.emptyWords({ moving: false }, 40)).toBe('Everything in this pack moves.')
  })
})

describe('the shipped pack', () => {
  test('every row is well formed, whatever the harvest produced', () => {
    for (const r of animations.PACK) {
      expect(r.frames.length).toBe(r.frameMs.length)
      expect(r.frames.length).toBeGreaterThan(0)
      expect(r.name.trim().length).toBeGreaterThan(0)
      expect(r.licence.trim().length).toBeGreaterThan(0)
      expect(r.score).toBeGreaterThanOrEqual(0)
      expect(r.score).toBeLessThanOrEqual(1)
    }
  })

  test('ids are unique, because a duplicate would make two tiles the same thing', () => {
    const ids = animations.PACK.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('nothing bundled carries a licence that would need more than provenance', () => {
    // The harvest is CC0-only by policy. Anything else appearing here is a bug in the
    // tool, not a thing to render a caveat for.
    for (const r of animations.PACK) expect(r.licence).toBe('CC0')
  })
})

describe('animationOf', () => {
  const real = (levels: number[][]): animations.PackRow['frames'][number] =>
    quantise.packBitmap(levels)

  const grid = (col: number, level: number) =>
    Array.from({ length: ROWS }, (_, r) =>
      Array.from({ length: COLS }, (_, c) => (c === col && r === 2 ? level : 0)),
    )

  test('decodes the packed frames back into a panel-shaped animation', () => {
    const r = row({ id: 'decode-1', frames: [real(grid(3, 3)), real(grid(4, 3))] })
    const a = animations.animationOf(r)
    expect(a.frames).toHaveLength(2)
    expect(a.frames[0][2][3]).toBe(3)
    expect(a.frames[1][2][4]).toBe(3)
  })

  test('normalise is applied here, so a 0 ms source frame arrives usable', () => {
    const r = row({ id: 'decode-2', frames: [real(grid(3, 3))], frameMs: [0] })
    expect(animations.animationOf(r).frameMs).toEqual([anim.ZERO_DELAY_MS])
  })

  test('repeated source frames merge, so a duration is not double counted', () => {
    const same = real(grid(5, 3))
    const r = row({ id: 'decode-3', frames: [same, same], frameMs: [60, 60] })
    const a = animations.animationOf(r)
    expect(a.frames).toHaveLength(1)
    expect(a.frameMs).toEqual([120])
  })

  test('the same row decodes once and is handed back the same object', () => {
    const r = row({ id: 'decode-4', frames: [real(grid(1, 3))], frameMs: [100] })
    expect(animations.animationOf(r)).toBe(animations.animationOf(r))
  })

  test('thumbOf draws the first frame without decoding the loop', () => {
    const r = row({ id: 'decode-5', frames: [real(grid(7, 2)), real(grid(8, 3))] })
    expect(animations.thumbOf(r)[2][7]).toBe(2)
  })
})
