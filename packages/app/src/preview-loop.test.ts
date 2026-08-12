/**
 * The preview walks the panel's loop through `viewport.frames`, not around it.
 *
 * Track 36, found by `review-16`. `viewport.ts` carries a `LoopModel` switch whose
 * whole job is deciding whether a preview shows the ~24 blank columns the device
 * appends to a scrolling save, and `Preview.tsx` used to write that walk out inline,
 * which left `viewport.frames(bitmap, motion, { loop })` with **zero production
 * callers**. Two copies of one model is how a preview and a panel come to disagree,
 * and that disagreement is the original bug this whole area exists to fix
 * (`research/loop-gap-2026-08-10.md`): a preview that walked the bitmap alone showed
 * no gap where the panel showed a full screen of one.
 *
 * `Preview.tsx` renders React, which does not import under bun, so this is a source
 * crawl plus a behavioural half over the model itself. The crawl is what catches the
 * walk growing back; the behavioural half is what catches `LOOP` being switched
 * silently, since that constant decides what a person sees and nothing else asserts
 * it.
 */
import { content, dats, viewport } from '@joggles/core'
import { expect, test } from 'bun:test'

const SOURCE = await Bun.file(new URL('./Preview.tsx', import.meta.url)).text()

test('the preview calls the model', () => {
  expect(SOURCE).toContain('viewport.frames(bitmap, motion, { loop: LOOP })')
})

test('the preview no longer walks the loop itself', () => {
  // The four calls the inline walk was built from. Any of them reappearing here means
  // the model has a second implementation again, whatever it looks like at the time.
  for (const gone of ['marqueeOffsets', 'marqueeAt', 'scrollOffsets', 'windowAt']) {
    expect(SOURCE).not.toContain(`viewport.${gone}`)
  }
})

test('the pre-render survives, because the clock is frame-counted', () => {
  // "It seems to speed up the less pixels are showing on the screen" was render cost
  // stretching a frame-counted clock, fixed by rendering every offset once at plan
  // time. A step must stay a lookup, so the map has to sit inside the memo.
  expect(SOURCE).toContain('.map(strings)')
  expect(SOURCE).toMatch(/const frames = useMemo\(\(\) => \{[\s\S]*?\.map\(strings\)/)
})

test('the panel loop is 24 columns longer than the bitmap, and the preview shows it', () => {
  // The behavioural half. A gapless 27-column scroll has exactly one fully dark frame
  // under the panel model and none under the bitmap model, which is the whole
  // difference between what the app used to show and what the glasses do.
  const bitmap = content.text('HI THERE', { kind: 'scroll', dir: 0, speed: 50 }).bitmap
  const cols = content.width(bitmap)
  const panel = viewport.frames(bitmap, { kind: 'scroll', dir: 0 }, { loop: 'panel' })
  const uploaded = viewport.frames(bitmap, { kind: 'scroll', dir: 0 }, { loop: 'uploaded' })

  expect(panel.length).toBe(cols + dats.TYPE1_BRACKET)
  expect(uploaded.length).toBe(cols)
  const dark = (frames: number[][][]) =>
    frames.filter((f) => f.every((row) => row.every((v) => v === 0))).length
  expect(dark(panel)).toBeGreaterThan(0)
  expect(dark(uploaded)).toBe(0)
})

test('LOOP is the panel model, which is what the device does', () => {
  // Verified by eye on 2026-08-12: the panel goes fully dark between passes, on
  // content restored from flash with nothing connected. A silent switch to 'uploaded'
  // would put the preview back to disagreeing with the panel.
  expect(SOURCE).toContain("const LOOP = 'panel'")
})
