/**
 * Print both fonts, and some text in them, without a device.
 *
 * A bitmap font is the one kind of code that cannot be reviewed by reading it:
 * `['.##','#.#','.##']` is either a `q` or a bug and the source looks the same
 * either way. So this exists to be looked at, by whoever writes a glyph and by
 * whoever reviews it.
 *
 *     bun run packages/cli/src/fontsheet.ts            both fonts, plus samples
 *     bun run packages/cli/src/fontsheet.ts "any text" that text in both fonts
 *
 * Dead LEDs print as a space, so a glyph that would lose a stroke to the nose
 * notch shows up as a hole rather than as a plausible letter.
 */
import { COLS, ROWS, alive, font } from '@joggles/core'

const INK = '#'
const OFF = '·'
const DEAD = ' '

const sheet = (f: font.Font, chars: string[]) => {
  const cell = (rows: string[], r: number) => (rows[r] ?? '').padEnd(rows[0].length, '.')
  for (let i = 0; i < chars.length; i += 12) {
    const group = chars.slice(i, i + 12).map((ch) => ({
      ch,
      rows: font.kern.glyphRows(f, ch),
    }))
    for (let r = 0; r < f.height; r++) {
      console.log(group.map((g) => cell(g.rows, r).replaceAll('#', INK)).join('  '))
    }
    console.log(group.map((g) => `${g.ch}${g.rows[0].length}`.padEnd(g.rows[0].length + 2)).join(''))
    console.log()
  }
}

/**
 * A 9-row bitmap, dead LEDs blanked out to column 24.
 *
 * Anything past column 24 is off the panel and prints unmasked: a scrolling
 * message is wider than the panel by design, and masking it there would draw a
 * notch that does not exist and hide one that does.
 */
const panel = (bitmap: number[][]) => {
  const cols = Math.max(bitmap[0]?.length ?? 0, COLS)
  for (let r = ROWS - 1; r >= 0; r--) {
    const line = Array.from({ length: cols }, (_, c) =>
      c < COLS && !alive(r, c) ? DEAD : bitmap[r]?.[c] ? INK : OFF,
    ).join('')
    console.log(`|${line.slice(0, COLS)}|${line.slice(COLS)}`)
  }
}

const argText = process.argv[2]

/** One line saying what this face does with this text, and what it costs. */
const verdict = (f: font.Font, text: string): string => {
  const v = font.fit(text, f)
  const cost = v.free ? 'free' : v.usable ? 'scrolls, five erases' : `dropped "${v.dropped}"`
  return `${f.name} (${f.label}), ${v.columns} columns, ${cost}`
}

/** Every face's take on one string: the picker's whole job, in the terminal. */
const show = (f: font.Font, text: string) => {
  console.log(verdict(f, text))
  panel(f.scrolls ? font.panelBitmap(text, { font: f }) : font.staticText(text, { font: f }).bitmap)
  console.log()
}

if (argText) {
  for (const f of font.FONTS) show(f, argText)
  process.exit(0)
}

const upper = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
const lower = [...'abcdefghijklmnopqrstuvwxyz']
const digits = [...'0123456789']
const punct = [...' !?.,;:-+=\'"<>*/()[]#@%&$^_']

for (const f of font.FONTS) {
  const rows = f.scrolls
    ? `sits at panel rows ${f.baseline}-${f.baseline + f.height - 1}`
    : 'static, placed around the notch'
  console.log(`\n=== ${f.name}: ${f.height} rows, ${rows} - ${f.note} ===\n`)
  sheet(f, [...upper, ...lower, ...digits, ...punct].filter((ch) => f.glyphs[ch]))
}

console.log('=== the same words in every face: where the free 24 columns run out ===\n')
for (const sample of ['Hello there', 'FUNKY GLASSES', 'jaguar 42%', 'Wavey, mate!', 'JOGGLES']) {
  for (const f of font.FONTS) show(f, sample)
}

console.log('=== tall7 placed around the dead pixels ===\n')
for (const sample of ['OK', 'HI', '42', 'YES', '3:45', 'JOGGLES']) {
  const placed = font.staticText(sample)
  console.log(`"${sample}"${placed.dropped ? ` dropped "${placed.dropped}"` : ''}`)
  panel(placed.bitmap)
  console.log()
}
