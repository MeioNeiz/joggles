/**
 * The catalogue the Library screen offers, and the addressing it rests on.
 *
 * Two of these are worth more than the rest.
 *
 * `commandFor` is checked against the **vendor app's own frames**, byte for byte, taken
 * from `Agreement.getAnimCommand`/`getImageCommand` in the decompiled app. That is an
 * independent source from the firmware decode `bankdump.ts` did, so a typo in the opcode
 * or the argument position cannot pass both.
 *
 * The other is that every thumbnail is distinct and none is blank. The generated file is
 * rewritten by a tool, and the frame it picks per animation is a heuristic: modes 7 and 8
 * share 19 of their 35 frames, so the obvious choice gives two identical tiles in a
 * catalogue whose only purpose is telling built-ins apart. Regenerating from a different
 * image must fail here rather than quietly produce twins.
 *
 * The mode arithmetic is pinned too, because it is the *derived* claim every tap rests on:
 * `ANIM n` selects mode n + 5. If a hardware session shows otherwise, this test is where
 * the correction lands.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { content, display } from '@joggles/core'
import { describe, expect, test } from 'bun:test'
import {
  ANIMATIONS,
  BUILTINS,
  FRAME_MS,
  IMAGES,
  TAKES_THE_PANEL,
  builtinById,
  commandFor,
  hiddenPixels,
  loopWords,
  showCost,
  unpackThumb,
  warnBeforeShowing,
} from './builtins.js'

const CELLS = display.ROWS * display.COLS

const packed = (levels: number[][]): string =>
  levels.map((row) => row.join('')).join('')

const solid = (level: number): number[][] =>
  Array.from({ length: display.ROWS }, () => new Array(display.COLS).fill(level))

describe('unpackThumb', () => {
  test('is rows of levels, bottom row first', () => {
    // Row 0 is the bottom of the panel, so the first 24 digits are the bottom row. A
    // thumbnail stored top-first would render every built-in upside down and nothing
    // else in the app would notice.
    const levels = solid(0)
    levels[0][0] = 3
    levels[display.ROWS - 1][display.COLS - 1] = 1
    const got = unpackThumb(packed(levels))
    expect(got[0][0]).toBe(3)
    expect(got[display.ROWS - 1][display.COLS - 1]).toBe(1)
    expect(got).toEqual(levels)
  })

  test('refuses a thumbnail that is not the panel', () => {
    expect(() => unpackThumb('0'.repeat(CELLS - 1))).toThrow(/digits/)
    expect(() => unpackThumb('0'.repeat(CELLS + 1))).toThrow(/digits/)
  })

  test('refuses a digit that is not a level', () => {
    expect(() => unpackThumb('4' + '0'.repeat(CELLS - 1))).toThrow(/not a level/)
    expect(() => unpackThumb('x' + '0'.repeat(CELLS - 1))).toThrow(/not a level/)
  })
})

describe('the catalogue', () => {
  test('is 11 images and 19 animations, images first', () => {
    expect(IMAGES.length).toBe(11)
    expect(ANIMATIONS.length).toBe(19)
    expect(BUILTINS.length).toBe(30)
    expect(BUILTINS.slice(0, 11).every((b) => b.kind === 'image')).toBe(true)
    expect(BUILTINS.slice(11).every((b) => b.kind === 'animation')).toBe(true)
  })

  test('every thumbnail is the panel, at levels the panel has', () => {
    for (const b of BUILTINS) {
      expect(b.thumb.length, b.id).toBe(display.ROWS)
      for (const row of b.thumb) {
        expect(row.length, b.id).toBe(display.COLS)
        for (const level of row) {
          expect(Number.isInteger(level) && level >= 0 && level <= display.MAX_LEVEL).toBe(
            true,
          )
        }
      }
    }
  })

  test('ids and labels are unique, and labels count from one', () => {
    expect(new Set(BUILTINS.map((b) => b.id)).size).toBe(BUILTINS.length)
    expect(new Set(BUILTINS.map((b) => b.label)).size).toBe(BUILTINS.length)
    expect(IMAGES[0].label).toBe('Image 1')
    expect(IMAGES.at(-1)!.label).toBe('Image 11')
    expect(ANIMATIONS[0].label).toBe('Animation 1')
    expect(ANIMATIONS.at(-1)!.label).toBe('Animation 19')
  })

  test('every thumbnail is distinct, and none is blank', () => {
    const seen = new Map<string, string>()
    for (const b of BUILTINS) {
      const key = packed(b.thumb)
      expect(seen.get(key) ?? b.id, `${b.id} has the same thumbnail as another`).toBe(b.id)
      seen.set(key, b.id)
      expect(content.width(b.thumb), b.id).toBe(display.COLS)
      expect(b.thumb.some((row) => row.some((v) => v > 0)), `${b.id} is blank`).toBe(true)
    }
  })

  test('the arguments are the ranges the vendor app is known to send', () => {
    // `research/vendor-app-protocol.md`: IMAG 0 to 10 and eleven images, both verified
    // from the app source. Ours must not exceed that, because IMAG 11 fails the
    // firmware's own `cmp #0x0b` and shows nothing.
    expect(IMAGES.map((b) => b.arg)).toEqual([...Array(11).keys()])
    expect(ANIMATIONS.map((b) => b.arg)).toEqual([...Array(19).keys()])
  })

  test('ANIM n is mode n + 5, and every image is mode 25', () => {
    for (const b of ANIMATIONS) expect(b.mode, b.id).toBe(b.arg + 5)
    for (const b of IMAGES) expect(b.mode, b.id).toBe(25)
    // The 19 animation banks are exactly the modes the on-board button cycles, less
    // mode 4, which no command can reach, and mode 24, which has no bank of its own.
    expect(ANIMATIONS.map((b) => b.mode)).toEqual(
      Array.from({ length: 19 }, (_, i) => i + 5),
    )
  })

  test('an image is a still and an animation loops', () => {
    for (const b of IMAGES) {
      expect(b.frames, b.id).toBe(1)
      expect(b.loopMs, b.id).toBe(0)
      expect(loopWords(b)).toBe('still')
    }
    const longest = ANIMATIONS.reduce((a, b) => (b.frames > a.frames ? b : a))
    expect(longest.frames).toBe(35)
    expect(longest.loopMs).toBe(35 * FRAME_MS)
    expect(loopWords(longest)).toBe('35 frames, 4.2s loop')
  })

  test('grey is claimed only where a thumbnail could show it', () => {
    // The converse does not hold: a bank may only reach for grey in frames the
    // thumbnail is not, which is why the flag is computed over every frame.
    for (const b of BUILTINS) {
      if (content.hasGrey(b.thumb)) expect(b.grey, `${b.id} shows grey`).toBe(true)
    }
    expect(BUILTINS.filter((b) => b.grey).length).toBeGreaterThan(0)
  })

  test('builtinById finds one and invents none', () => {
    expect(builtinById('anim-6')?.mode).toBe(11)
    expect(builtinById('image-10')?.arg).toBe(10)
    expect(builtinById('image-11')).toBeNull()
    expect(builtinById('anim-19')).toBeNull()
    expect(builtinById('')).toBeNull()
  })
})

describe('commandFor', () => {
  /** The vendor app's own frames, from `Agreement` in the decompiled app. */
  const vendorAnim = (arg: number) => [5, 65, 78, 73, 77, arg]
  const vendorImage = (arg: number) => [5, 73, 77, 65, 71, arg]

  test('builds the frames the vendor app builds', () => {
    for (const b of ANIMATIONS) {
      expect([...commandFor(b)].slice(0, 6), b.id).toEqual(vendorAnim(b.arg))
    }
    for (const b of IMAGES) {
      expect([...commandFor(b)].slice(0, 6), b.id).toEqual(vendorImage(b.arg))
    }
  })

  test('is one 16-byte frame, zero padded', () => {
    const frame = commandFor(ANIMATIONS[0])
    expect(frame.length).toBe(16)
    expect([...frame.slice(6)].every((b) => b === 0)).toBe(true)
  })
})

describe('what a tap costs', () => {
  test('is never flash and never persists', () => {
    for (const b of BUILTINS) {
      expect(showCost(b).erases, b.id).toBe(0)
      expect(showCost(b).persists, b.id).toBe(false)
    }
  })

  test('the warning is asked for once, because the second tap has nothing to take', () => {
    expect(warnBeforeShowing(false)).toBe(true)
    expect(warnBeforeShowing(true)).toBe(false)
  })

  test('the warning says what goes and what does not', () => {
    expect(TAKES_THE_PANEL).toMatch(/drawing/i)
    expect(TAKES_THE_PANEL).toMatch(/untouched/i)
  })
})

describe('hiddenPixels', () => {
  const dead: Array<[number, number]> = []
  for (let r = 0; r < display.ROWS; r++) {
    for (let c = 0; c < display.COLS; c++) if (!display.alive(r, c)) dead.push([r, c])
  }

  test('counts lit pixels with no LED under them, and nothing else', () => {
    expect(dead.length).toBeGreaterThan(0)
    expect(hiddenPixels(solid(0))).toBe(0)
    expect(hiddenPixels(solid(3))).toBe(dead.length)

    const one = solid(0)
    const [r, c] = dead[0]
    one[r][c] = 1
    expect(hiddenPixels(one)).toBe(1)

    const alive = solid(0)
    alive[3][0] = 3
    expect(display.alive(3, 0)).toBe(true)
    expect(hiddenPixels(alive)).toBe(0)
  })

  test('some built-ins were drawn for a panel without our dead LEDs', () => {
    // Not a defect and not ours to fix: it is why the screen draws the holes as holes
    // rather than as unlit pixels.
    expect(BUILTINS.some((b) => hiddenPixels(b.thumb) > 0)).toBe(true)
  })
})

/**
 * The screen's two prohibitions, asserted on source because a React screen cannot be
 * rendered under bun. Same technique as `library.test.ts`'s ledger crawl.
 *
 * Both are load-bearing. Flash wear is the app's one irreversible cost and this screen
 * has no business spending it; `MODE` is the one-way door away from a resident type 2
 * image, so a browsing screen that sent one would destroy content while claiming to be
 * free. The built-in commands (`ANIM`/`IMAG`) do take the panel, which is what the
 * warning is for, and they write nothing.
 *
 * **A crawl is only worth what an injected violation proves**, which is review-14's
 * lesson and how this one was found leaking: `.save(` alone missed `glasses.save?.(x)`,
 * `glasses['save'](x)` and `.save.bind(glasses)`, and `.mode(` missed
 * `protocol.frame('MODE', 2, 0)` entirely, the generic builder being exported. So the
 * source is normalised into one call shape first, and the `MODE` rule is enforced as
 * "this screen builds no frames of its own": the one command it sends comes from
 * `commandFor`, which is where the addressing is reviewed. Every pattern below was
 * injected into the real file and watched to go red. *review-20.*
 */
describe('the Library screen', () => {
  const HERE = dirname(new URL(import.meta.url).pathname)
  /**
   * The screen's source, comments out and every equivalent call spelling folded into one.
   * `a?.b(`, `a["b"](` and `a.b!(` all reach the same method as `a.b(`.
   */
  /** Comments out only: the view for asserting what the screen SAYS. */
  const text = (): string =>
    readFileSync(resolve(HERE, 'screens/Library.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  /**
   * Strings out too, and every equivalent call spelling folded into one: the view for
   * banning what the screen DOES. UI copy legitimately says "to the glasses" and names
   * the "Glasses" tab, and neither is a session object, so bans must not read prose.
   * The bracket-access fold runs before the string strip, so a computed access cannot
   * hide in a string this removes.
   */
  const source = (): string =>
    text()
      .replace(/\?\./g, '.')
      .replace(/!\s*\(/g, '(')
      .replace(/\[\s*['"`]([A-Za-z_$][\w$]*)['"`]\s*\]/g, '.$1')
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''")

  test('cannot write flash, cannot send MODE, and holds no session at all', () => {
    const src = source()
    expect(src.length).toBeGreaterThan(0)
    // `.save` without a call is enough: a reference is how the aliased spellings start.
    expect(src, 'reaches a save').not.toMatch(/\bsave\s*[.(]/)
    expect(src, 'calls deliver()').not.toMatch(/\bdeliver\b/)
    expect(src, 'sends MODE').not.toMatch(/\.mode\s*\(/)
    expect(src, 'names MODE').not.toMatch(/\bMODE\b/)
    expect(src, 'touches DATS').not.toMatch(/dats/i)
    // Builds no frames of its own, which is what closes `protocol.frame('MODE', ...)`
    // and every other raw opcode.
    expect(src, 'builds its own frames').not.toMatch(/\bprotocol\b/)
    // The track 26 strengthening: the screen has no `Glasses` and no member access on
    // one. It plans taps and hands the plan to the shell's runner, so the only route
    // to the wire is the audited executor in `one-tap.ts`. JSX prose still names the
    // Glasses tab, so the ban is on import, annotation and member-access shapes.
    expect(src, 'imports the session class').not.toMatch(/[{,]\s*Glasses\b/)
    expect(src, 'types a session').not.toMatch(/:\s*Glasses\b/)
    expect(src, 'reaches into a session').not.toMatch(/\bglasses\s*[.[]/)
  })

  test('a tap routes through the planner, with no ceremony in front of it', () => {
    // The 2026-08-12 ruling: no cost copy, no confirm sheets, no alerts. The planner
    // still refuses the two real mistakes (dark upload, disconnected send), and the
    // budget guard in core is what actually protects the flash.
    const src = source()
    expect(src).toMatch(/planTap/)
    expect(src).not.toMatch(/cost\.words/)
    expect(src).not.toMatch(/TAKES_THE_PANEL/)
    expect(src).not.toMatch(/Alert\.alert/)
  })

  test('deleting is instant and undoable, never a confirm', () => {
    // Undo beats "are you sure": the phone holds the only copy, so the protection is
    // a way back rather than a question in the way.
    const src = text()
    expect(src).toMatch(/onRestore/)
    expect(src).toMatch(/undo/i)
    expect(src).not.toMatch(/Alert\.alert/)
  })
})
