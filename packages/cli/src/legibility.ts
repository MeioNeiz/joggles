/**
 * Measure a font's legibility against this panel, rather than judging it by eye.
 *
 * Four things are checked, in the order they actually cost readability at 24
 * columns of 1-bit ink:
 *
 *  1. Identical glyphs. Two characters with the same bitmap are unreadable, full
 *     stop, and the source looks fine either way.
 *  2. Near-identical glyphs, Hamming distance 1 or 2 over the same box. At this
 *     size a two-pixel difference is a coin toss on a moving panel.
 *  3. Touching pairs. After real kerning, if the ink of two adjacent glyphs is
 *     orthogonally adjacent with no blank column between them, the pair reads as
 *     one blob. This is the single biggest legibility cost and it is invisible in
 *     a glyph table.
 *  4. Blocked counters. A closed shape whose interior is fewer than one pixel of
 *     background loses the hole that tells a from o.
 */
import { font } from '@joggles/core'

type Font = font.Font

const box = (f: Font, ch: string): string[] => font.kern.glyphRows(f, ch)

const key = (rows: readonly string[]): string => rows.join('/')

/** Ink coordinates of a glyph, top-row-first source order. */
const ink = (rows: readonly string[]): Array<[number, number]> => {
  const out: Array<[number, number]> = []
  rows.forEach((line, r) => [...line].forEach((p, c) => p === '#' && out.push([r, c])))
  return out
}

const hamming = (a: readonly string[], b: readonly string[]): number | null => {
  if (a.length !== b.length || a[0].length !== b[0].length) return null
  let d = 0
  for (let r = 0; r < a.length; r++) {
    for (let c = 0; c < a[0].length; c++) if (a[r][c] !== b[r][c]) d++
  }
  return d
}

/** The characters worth reporting on: a symbol clash matters far less than a letter one. */
const isWord = (ch: string): boolean => /[A-Za-z0-9]/.test(ch)

function identical(f: Font, chars: string[]): string[][] {
  const seen = new Map<string, string[]>()
  for (const ch of chars) {
    const rows = box(f, ch)
    if (font.kern.isBlank(rows)) continue
    const k = key(rows)
    seen.set(k, [...(seen.get(k) ?? []), ch])
  }
  return [...seen.values()].filter((g) => g.length > 1)
}

function near(f: Font, chars: string[], maxDist: number): Array<[string, string, number]> {
  const out: Array<[string, string, number]> = []
  for (let i = 0; i < chars.length; i++) {
    for (let j = i + 1; j < chars.length; j++) {
      const a = box(f, chars[i])
      const b = box(f, chars[j])
      if (font.kern.isBlank(a) || font.kern.isBlank(b)) continue
      const d = hamming(a, b)
      if (d !== null && d > 0 && d <= maxDist) out.push([chars[i], chars[j], d])
    }
  }
  return out.sort((x, y) => x[2] - y[2])
}

/**
 * Render two glyphs through the real layout and report whether their ink ends up
 * orthogonally adjacent. `pieces` applies spacing and tuck, so this measures what
 * the panel actually shows, not what the table implies.
 */
function touching(f: Font, a: string, b: string): boolean {
  const list = font.kern.pieces(a + b, f)
  if (list.length < 2) return false
  const xs = font.kern.positions(list)
  const owner = new Map<string, number>()
  list.forEach((piece, index) => {
    const rows = font.kern.glyphRows(f, piece.ch ?? '')
    for (const [r, c] of ink(rows)) owner.set(`${r},${c + xs[index]}`, index)
  })
  // Same row, adjacent column, different glyph. Only orthogonal horizontal contact
  // fuses two letters into one shape; diagonal contact is ordinary in bitmap type
  // and reads fine, so counting it reported almost every pair as broken.
  for (const [at, who] of owner) {
    const [r, c] = at.split(',').map(Number)
    const other = owner.get(`${r},${c + 1}`)
    if (other !== undefined && other !== who) return true
  }
  return false
}

function blockedCounters(f: Font, chars: string[]): string[] {
  // A counter is a background pixel fully enclosed by ink on all four sides. Its
  // absence in a round letter is what turns o into a solid block.
  const round = [...'abdegopq069ABDGOPQR']
  const out: string[] = []
  for (const ch of chars) {
    if (!round.includes(ch)) continue
    const rows = box(f, ch)
    if (font.kern.isBlank(rows)) continue
    // Flood fill the background from the glyph's edges. Anything unreached is an
    // enclosed counter, whatever its shape. Requiring ink on all four sides of a
    // single pixel instead only ever found counters one pixel tall, so a normal
    // three-pixel slot inside an O counted as blocked.
    const h = rows.length
    const w = rows[0].length
    const seen = Array.from({ length: h }, () => new Array(w).fill(false))
    const queue: Array<[number, number]> = []
    for (let r = 0; r < h; r++) {
      for (const c of [0, w - 1]) if (rows[r][c] === '.') queue.push([r, c])
    }
    for (let c = 0; c < w; c++) {
      for (const r of [0, h - 1]) if (rows[r][c] === '.') queue.push([r, c])
    }
    while (queue.length) {
      const [r, c] = queue.pop()!
      if (r < 0 || r >= h || c < 0 || c >= w || seen[r][c] || rows[r][c] === '#') continue
      seen[r][c] = true
      queue.push([r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1])
    }
    let holes = 0
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) if (rows[r][c] === '.' && !seen[r][c]) holes++
    }
    if (holes === 0) out.push(ch)
  }
  return out
}

const CHARS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789']

for (const f of font.FONTS) {
  console.log(`\n${'='.repeat(66)}`)
  console.log(`${f.name} (${f.label})  height ${f.height}  spacing ${f.spacing}  maxTuck ${f.maxTuck}`)
  console.log('='.repeat(66))

  // A caps-only face folds every lowercase letter onto its capital, so "A = a" is
  // what it is for rather than a collision. Reported separately, because listing 26
  // such pairs as unreadable buries any real duplicate underneath them.
  const capsOnly = [...'abcdefghijklmnopqrstuvwxyz'].every(
    (ch) => !Object.hasOwn(f.glyphs, ch),
  )
  const dupes = identical(f, CHARS).filter(
    (g) => !(capsOnly && g.length === 2 && g[0].toLowerCase() === g[1].toLowerCase()),
  )
  if (capsOnly) console.log('\n   (caps-only face: lowercase folds onto capitals by design)')
  console.log(`\n1. Identical glyphs: ${dupes.length === 0 ? 'none' : ''}`)
  for (const g of dupes) console.log(`   ${g.join(' = ')}   <-- unreadable`)

  const n1 = near(f, CHARS, 1)
  const n2 = near(f, CHARS, 2).filter(([, , d]) => d === 2)
  console.log(`\n2. One pixel apart: ${n1.length === 0 ? 'none' : ''}`)
  for (const [a, b] of n1) console.log(`   ${a} / ${b}`)
  console.log(`   Two pixels apart: ${n2.length}`)
  if (n2.length) console.log(`   ${n2.map(([a, b]) => `${a}/${b}`).join('  ')}`)

  // Only word characters, and only pairs that can actually occur in text.
  const words = CHARS.filter(isWord)
  const merged: string[] = []
  for (const a of words) {
    for (const b of words) if (touching(f, a, b)) merged.push(a + b)
  }
  console.log(`\n3. Pairs whose ink touches after kerning: ${merged.length}`)
  if (merged.length) console.log(`   ${merged.slice(0, 40).join(' ')}${merged.length > 40 ? ' ...' : ''}`)

  const blocked = blockedCounters(f, CHARS)
  console.log(`\n4. Round glyphs with no open counter: ${blocked.length === 0 ? 'none' : blocked.join(' ')}`)
}
