import { describe, expect, test } from 'bun:test'
import type { TextFile } from './nicknames.js'
import { FALLBACK, createSettings, revive } from './settings.js'

/** An in-memory file, breakable on demand. */
function memory(initial: string | null = null) {
  const state = { text: initial, writes: 0, broken: false }
  const file: TextFile = {
    read() {
      if (state.broken) throw new Error('unreadable')
      return state.text
    },
    write(text) {
      if (state.broken) throw new Error('unwritable')
      state.text = text
      state.writes++
    },
  }
  return { file, state }
}

describe('revive', () => {
  test('nothing yields the fallbacks', () => {
    const got = revive(null)
    expect(got.defaults).toEqual(FALLBACK)
    expect(got.themes.size).toBe(0)
    expect(got.lastPair).toBeNull()
  })

  test('clamps rather than trusts: an illegal LIGHT level cannot persist', () => {
    const got = revive({ defaults: { brightness: 99, speed: -3, dir: 5 } })
    expect(got.defaults).toEqual({ brightness: 5, speed: 0, dir: 0 })
    expect(revive({ defaults: { brightness: 0 } }).defaults.brightness).toBe(1)
    expect(revive({ defaults: { brightness: '3' } }).defaults.brightness).toBe(
      FALLBACK.brightness,
    )
  })

  test('drops malformed theme entries and keeps the rest', () => {
    const got = revive({
      themes: { 'GLASSES-125B37': 'sky', bad: 7, '': 'rose', empty: '' },
    })
    expect(got.themes.get('GLASSES-125B37')).toBe('sky')
    expect(got.themes.size).toBe(1)
  })

  test('a pair advertising as __proto__ gets its own entry, not Object.prototype', () => {
    // Review-10's nickname defect, kept out of this store by construction: the pairs
    // live in a Map, so a hostile advert name is a key like any other.
    const got = revive({ themes: { __proto__: 'violet' } })
    // JSON.parse would deliver it; an object literal in a test cannot, so go through
    // the parser the store actually uses.
    const parsed = revive(JSON.parse('{"themes":{"__proto__":"violet"}}'))
    expect(parsed.themes.get('__proto__')).toBe('violet')
    expect(got.themes.get('toString')).toBeUndefined()
  })
})

describe('createSettings', () => {
  test('round-trips through the file', () => {
    const a = memory()
    const first = createSettings(a.file)
    first.setDefaults({ brightness: 2 })
    first.setTheme('GLASSES-125B37', 'amber')
    first.setLastPair('GLASSES-125B37')

    const second = createSettings(a.file)
    expect(second.defaults().brightness).toBe(2)
    expect(second.theme('GLASSES-125B37')).toBe('amber')
    expect(second.lastPair()).toBe('GLASSES-125B37')
  })

  test('a partial patch leaves the other defaults alone', () => {
    const s = createSettings(memory().file)
    s.setDefaults({ speed: 95 })
    expect(s.defaults()).toEqual({ ...FALLBACK, speed: 95 })
  })

  test('clearing a theme removes the entry', () => {
    const a = memory()
    const s = createSettings(a.file)
    s.setTheme('GLASSES-125B37', 'rose')
    s.setTheme('GLASSES-125B37', null)
    expect(s.theme('GLASSES-125B37')).toBeNull()
    expect(createSettings(a.file).theme('GLASSES-125B37')).toBeNull()
  })

  test('an unreadable file starts from the fallbacks, an unwritable one keeps the session', () => {
    const a = memory()
    a.state.broken = true
    const s = createSettings(a.file)
    expect(s.defaults()).toEqual(FALLBACK)
    s.setDefaults({ brightness: 4 })
    // The write failed, the choice still holds for this session.
    expect(s.defaults().brightness).toBe(4)
    expect(a.state.writes).toBe(0)
  })

  test('mutating what defaults() returned changes nothing held', () => {
    const s = createSettings(memory().file)
    const d = s.defaults()
    d.brightness = 1
    expect(s.defaults().brightness).toBe(FALLBACK.brightness)
  })
})

describe('favourites and hidden', () => {
  test('toggle, keep order, and round-trip', () => {
    const a = memory()
    const s = createSettings(a.file)
    expect(s.toggleFavourite('anim-3')).toBe(true)
    expect(s.toggleFavourite('mine:x1')).toBe(true)
    expect(s.favourites()).toEqual(['anim-3', 'mine:x1'])
    expect(s.toggleFavourite('anim-3')).toBe(false)
    expect(s.favourites()).toEqual(['mine:x1'])

    expect(s.toggleHidden('image-9')).toBe(true)
    expect(createSettings(a.file).hidden()).toEqual(['image-9'])
    expect(createSettings(a.file).favourites()).toEqual(['mine:x1'])
  })

  test('revive drops junk keys and duplicates, keeps order', () => {
    const got = revive({ favourites: ['a', 7, '', 'b', 'a'], hidden: 'nope' })
    expect(got.favourites).toEqual(['a', 'b'])
    expect(got.hidden).toEqual([])
  })
})

test('groups are named subsets of the favourites, and a member is always one', () => {
  const s = createSettings(memory().file)
  expect(s.addGroup('  Main stage  ')).toBe('Main stage')
  // Typing a name that already exists means that group, not a second one with the same
  // label, which nobody could tell apart in a picker.
  expect(s.addGroup('main STAGE')).toBe('Main stage')
  expect(s.groups().length).toBe(1)

  expect(s.toggleInGroup('Main stage', 'mine:a')).toBe(true)
  expect(s.groups()[0].keys).toEqual(['mine:a'])
  // Joining a group makes it a favourite: a member that was not one would be in a view
  // of the favourites while not being in the favourites, and so invisible everywhere.
  expect(s.favourites()).toContain('mine:a')

  expect(s.toggleInGroup('Main stage', 'mine:a')).toBe(false)
  expect(s.groups()[0].keys).toEqual([])
  // Leaving a group does NOT unpin it, because the two are different decisions.
  expect(s.favourites()).toContain('mine:a')
})

test('an item can be in more than one group', () => {
  const s = createSettings(memory().file)
  s.addGroup('Walk')
  s.addGroup('Waluigi')
  s.toggleInGroup('Walk', 'motif:ww')
  s.toggleInGroup('Waluigi', 'motif:ww')
  expect(s.groups().map((g) => g.keys)).toEqual([['motif:ww'], ['motif:ww']])
})

test('deleting a group keeps the things in it', () => {
  const s = createSettings(memory().file)
  s.addGroup('Walk')
  s.toggleInGroup('Walk', 'mine:a')
  s.removeGroup('walk')
  expect(s.groups()).toEqual([])
  // The whole point: a way of organising things is not the things.
  expect(s.favourites()).toContain('mine:a')
})

test('unusable group names are refused rather than stored', () => {
  const s = createSettings(memory().file)
  expect(s.addGroup('   ')).toBeNull()
  expect(s.addGroup('')).toBeNull()
  expect(s.groups()).toEqual([])
  // A long name is cut rather than refused: the intent is clear and truncation is
  // recoverable, where a refusal loses what they typed.
  const long = s.addGroup('x'.repeat(80))
  expect(long?.length).toBe(24)
  // And a key can only join a group that exists.
  expect(s.toggleInGroup('nope', 'mine:a')).toBe(false)
})

test('groups survive a reload, and a malformed one is dropped alone', () => {
  const raw = {
    groups: [
      { name: 'Keep', keys: ['mine:a', 'mine:a', ''] },
      { name: '   ', keys: ['mine:b'] },
      { name: 'Keep', keys: ['mine:c'] },
      'not a group',
      { name: 'Also', keys: 'not an array' },
    ],
  }
  const out = revive(raw)
  // Deduped keys, the unnamed one gone, the duplicate name gone, the junk gone, and the
  // one with a broken key list kept with no keys rather than dropped entirely.
  expect(out.groups).toEqual([
    { name: 'Keep', keys: ['mine:a'] },
    { name: 'Also', keys: [] },
  ])
})
