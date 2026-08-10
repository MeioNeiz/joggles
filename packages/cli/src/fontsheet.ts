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

if (argText) {
  console.log(`\nband5, scrolling, ${font.textWidth(argText)} columns\n`)
  panel(font.panelBitmap(argText))
  const placed = font.staticText(argText)
  console.log(`\ntall7, static${placed.dropped ? `, dropped "${placed.dropped}"` : ''}\n`)
  panel(placed.bitmap)
  process.exit(0)
}

const upper = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
const lower = [...'abcdefghijklmnopqrstuvwxyz']
const digits = [...'0123456789']
const punct = [...' !?.,;:-+=\'"<>*/()[]#@%&$^_']

console.log('\n=== band5: 5 rows, scrolling, sits at panel rows 2-6 ===\n')
sheet(font.BAND5, [...upper, ...lower, ...digits, ...punct])

console.log('=== tall7: 7 rows, static, sits at panel rows 1-7 ===\n')
sheet(font.TALL7, [...upper, ...digits, ...' .,:!?-+=\'/<>()%'])

console.log('=== band5 on the panel: every glyph clears the notch ===\n')
for (const sample of ['Hello there', 'FUNKY GLASSES', 'jaguar 42%', 'Wavey, mate!']) {
  console.log(`${sample}  (${font.textWidth(sample)} columns)`)
  panel(font.panelBitmap(sample))
  console.log()
}

console.log('=== tall7 placed around the dead pixels ===\n')
for (const sample of ['OK', 'HI', '42', 'YES', '3:45', 'JOGGLES']) {
  const placed = font.staticText(sample)
  console.log(`"${sample}"${placed.dropped ? ` dropped "${placed.dropped}"` : ''}`)
  panel(placed.bitmap)
  console.log()
}
