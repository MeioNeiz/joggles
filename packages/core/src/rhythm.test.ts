import { expect, test } from 'bun:test'
import { COLS, ROWS } from './display.js'
import {
  MAX_HEIGHT,
  PAYLOAD_BYTES,
  SOLID_BARS,
  type Style,
  TAPERED_BARS,
  barCount,
  decode,
  encode,
  fromSpectrum,
  render,
  smooth,
  spec,
  toBars,
} from './rhythm.js'

const zeros = (n: number) => new Array(n).fill(0)
const ramp = (n: number) => Array.from({ length: n }, (_, i) => i % (MAX_HEIGHT + 1))

test('the frame is a plain 13-byte command frame, style then 12 payload bytes', () => {
  const f = encode(zeros(24), 0)
  expect(f.length).toBe(16)
  expect(f[0]).toBe(1 + PAYLOAD_BYTES)
  expect(f[1]).toBe(0)
  expect([...f.subarray(2)]).toEqual(zeros(14))
})

test('two heights per byte, low nibble first', () => {
  const heights = zeros(24)
  heights[0] = 1
  heights[1] = 2
  heights[22] = 7
  heights[23] = 9
  const f = encode(heights, 0)
  expect(f[2]).toBe(0x21)
  expect(f[2 + 11]).toBe(0x97)
})

test('the style byte is the only other field, and all four are reachable', () => {
  for (const style of [0, 1, 2, 3] as Style[]) {
    const f = encode(zeros(barCount(style)), style)
    expect(f[1]).toBe(style)
    expect(f[0]).toBe(1 + PAYLOAD_BYTES)
  }
})

/**
 * Not cosmetic. The firmware's own range check replaces a height of 10 or more
 * with 0, so an unclamped loud bar blanks its column instead of topping out, and
 * the panel goes dark at exactly the moment the music is loudest.
 */
test('heights are clamped to 0-9 here rather than left to blank a column', () => {
  const f = encode([10, -3, ...zeros(22)], 0)
  expect(f[2] & 0xf).toBe(MAX_HEIGHT)
  expect(f[2] >> 4).toBe(0)
})

test('a style is given exactly the heights it draws, or it throws', () => {
  expect(barCount(0)).toBe(24)
  expect(barCount(1)).toBe(24)
  expect(barCount(2)).toBe(12)
  expect(barCount(3)).toBe(8)
  expect(() => encode(zeros(24), 3)).toThrow(/8 heights, got 24/)
  expect(() => encode(zeros(12), 0)).toThrow(/24 heights, got 12/)
})

test('payload bytes past what a style reads are sent as zero', () => {
  const f = encode(zeros(8).fill(9), 3)
  expect([...f.subarray(2, 6)]).toEqual([0x99, 0x99, 0x99, 0x99])
  expect([...f.subarray(6, 14)]).toEqual(zeros(8))
})

test('decode inverts encode for every style', () => {
  for (const style of [0, 1, 2, 3] as Style[]) {
    const heights = ramp(barCount(style))
    expect(decode(encode(heights, style))).toEqual({ style, heights })
  }
})

test('decode rejects anything that is not a rhythm frame', () => {
  expect(decode(new Uint8Array(16))).toBeNull()
  const live = new Uint8Array(16)
  live[0] = 4
  expect(decode(live)).toBeNull()
  const badStyle = encode(zeros(24), 0)
  badStyle[1] = 4
  expect(decode(badStyle)).toBeNull()
})

test('render unpacks the firmware tables, so height 9 is nine rows at full level', () => {
  const full = render(new Array(24).fill(MAX_HEIGHT), 0)
  expect(full.length).toBe(ROWS)
  expect(full[0].length).toBe(COLS)
  for (let r = 0; r < ROWS; r++) expect(full[r]).toEqual(new Array(COLS).fill(3))
  expect(SOLID_BARS[MAX_HEIGHT]).toBe(0x3ffff)
})

test('a bar of height n lights exactly n rows from the bottom', () => {
  for (let h = 0; h <= MAX_HEIGHT; h++) {
    const drawn = render([h, ...zeros(23)], 0)
    const lit = drawn.filter((row) => row[0] > 0).length
    expect(lit).toBe(h)
    for (let r = 0; r < h; r++) expect(drawn[r][0]).toBe(3)
  }
})

/** The one greyscale the firmware draws by itself: three bands, brightest at the bottom. */
test('style 1 tapers brightness in three bands', () => {
  const drawn = render(new Array(24).fill(MAX_HEIGHT), 1)
  expect(drawn.map((row) => row[0])).toEqual([3, 3, 3, 2, 2, 2, 1, 1, 1])
  expect(TAPERED_BARS[MAX_HEIGHT]).toBe(0x15abf)
})

test('the wider styles still fill all 24 columns', () => {
  for (const style of [0, 1, 2, 3] as Style[]) {
    const { bars, barWidth, gap } = spec(style)
    expect(bars * (barWidth + gap)).toBe(COLS)
    const drawn = render(new Array(bars).fill(MAX_HEIGHT), style)
    expect(drawn[0].length).toBe(COLS)
  }
})

test('style 2 doubles each bar and style 3 leaves a blank column between them', () => {
  const two = render([9, ...zeros(11)], 2)
  expect(two[0].slice(0, 4)).toEqual([3, 3, 0, 0])

  const three = render([9, 9, ...zeros(6)], 3)
  expect(three[0].slice(0, 7)).toEqual([3, 3, 0, 3, 3, 0, 0])
})

test('toBars averages rather than dropping, so a peak still moves its bar', () => {
  expect(toBars([0, 9, 0, 0], 2)).toEqual([5, 0])
  expect(toBars(ramp(24), 24)).toEqual(ramp(24))
  expect(toBars([], 8)).toEqual(zeros(8))
  expect(toBars([4, 4], 0)).toEqual([])
})

test('silence is a dark panel, not a floor of stubs', () => {
  expect(fromSpectrum(zeros(512), { sampleRate: 44100 })).toEqual(zeros(COLS))
})

test('a spectrum at the ceiling tops every bar out', () => {
  const loud = new Array(512).fill(1)
  expect(fromSpectrum(loud, { sampleRate: 44100 })).toEqual(
    new Array(COLS).fill(MAX_HEIGHT),
  )
})

test('an empty or absent spectrum is zeros of the requested width', () => {
  expect(fromSpectrum([], { bars: 8 })).toEqual(zeros(8))
  expect(fromSpectrum([0.5], { bars: 0 })).toEqual([])
})

/**
 * The property the log spacing exists for: a pure tone lights one bar, and moving
 * the tone up moves the bar right. Linear spacing would put every tone below 4 kHz
 * in the leftmost few bars.
 */
test('a pure tone lights one band, and a higher tone lights a higher one', () => {
  const sampleRate = 44100
  const bins = 1024
  const at = (hz: number) => {
    const mags = zeros(bins)
    mags[Math.round((hz / (sampleRate / 2)) * bins)] = 1
    return fromSpectrum(mags, { sampleRate })
  }
  const lit = (heights: number[]) => heights.flatMap((h, i) => (h > 0 ? [i] : []))

  const low = lit(at(120))
  const high = lit(at(4000))
  expect(low.length).toBe(1)
  expect(high.length).toBe(1)
  expect(high[0]).toBeGreaterThan(low[0])
})

test('bands below the transform resolution reuse the nearest bin instead of a hole', () => {
  // 32 bins over 22 kHz is 690 Hz each, so every band under 690 Hz is narrower
  // than one bin. Those bars must still respond rather than sit dark.
  const mags = new Array(32).fill(1)
  const heights = fromSpectrum(mags, { sampleRate: 44100 })
  expect(heights.every((h) => h === MAX_HEIGHT)).toBe(true)
})

test('dB input is used as it stands, and 0 dB is loud rather than silent', () => {
  const quiet = fromSpectrum(new Array(64).fill(-60), { sampleRate: 44100, input: 'db' })
  const loud = fromSpectrum(new Array(64).fill(0), { sampleRate: 44100, input: 'db' })
  expect(quiet).toEqual(zeros(COLS))
  expect(loud).toEqual(new Array(COLS).fill(MAX_HEIGHT))
})

test('power input is the square of magnitude input', () => {
  const mags = Array.from({ length: 64 }, (_, i) => (i % 5) / 4)
  const opts = { sampleRate: 44100 } as const
  expect(fromSpectrum(mags.map((v) => v * v), { ...opts, input: 'power' })).toEqual(
    fromSpectrum(mags, opts),
  )
})

test('a minHz above Nyquist degrades instead of blanking every band', () => {
  const heights = fromSpectrum(new Array(64).fill(1), {
    sampleRate: 44100,
    minHz: 40000,
  })
  expect(heights).toEqual(new Array(COLS).fill(MAX_HEIGHT))
})

test('bars rise at once and fall gradually', () => {
  const up = smooth(zeros(4), [9, 9, 9, 9])
  expect(up).toEqual([9, 9, 9, 9])
  const down = smooth([9, 9, 9, 9], zeros(4))
  expect(down.every((h) => h > 0 && h < 9)).toBe(true)
})

/**
 * A 34% step rounded to nearest strands a bar at 1 forever, which on the panel is a
 * row of stubs that never clears. Falling must terminate.
 */
test('a falling bar reaches zero rather than stranding above it', () => {
  let heights = new Array(24).fill(MAX_HEIGHT)
  const target = zeros(24)
  for (let frame = 0; frame < 64; frame++) heights = smooth(heights, target)
  expect(heights).toEqual(target)
})

test('a rising bar reaches its target even with a slow rise', () => {
  let heights = zeros(24)
  const target = new Array(24).fill(MAX_HEIGHT)
  for (let frame = 0; frame < 64; frame++) heights = smooth(heights, target, { rise: 0.2 })
  expect(heights).toEqual(target)
})

test('smoothing never overshoots the target', () => {
  for (let was = 0; was <= MAX_HEIGHT; was++) {
    for (let want = 0; want <= MAX_HEIGHT; want++) {
      const [got] = smooth([was], [want], { rise: 0.5, fall: 0.5 })
      const [lo, hi] = was < want ? [was, want] : [want, was]
      expect(got).toBeGreaterThanOrEqual(lo)
      expect(got).toBeLessThanOrEqual(hi)
    }
  }
})
