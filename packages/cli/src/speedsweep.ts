#!/usr/bin/env bun
/**
 * Which `SPEED` argument is actually the fastest, settled by looking at the panel.
 *
 * The disassembly says the answer is 91: the ladder at `abs 0x183da` compares against
 * 10, 20, ... 90 and everything above the last threshold writes the same divisor, so
 * `SPEED 91`, `SPEED 100` and `SPEED 255` are one speed with three names, and 12.5
 * columns per second is the ceiling. `protocol.SPEED_STEPS` is built on that reading
 * and the whole speed control on the phone is built on `SPEED_STEPS`. This is the
 * hardware check for it, because a ladder read out of a disassembly is *derived* until
 * somebody watches the panel.
 *
 * Two questions, and the second is the one worth the connection:
 *
 *  1. **Are the ten rungs ten visibly different speeds?** If two adjacent rungs look
 *     identical the bucket boundaries are transcribed wrong and the chip row is
 *     offering the same speed twice.
 *  2. **Does anything above the ladder do something the ladder does not predict?** The
 *     firmware compares one byte. If that compare is signed, `SPEED 128` and up are
 *     negative, every one of them falls in the `<= 10` bucket, and asking for 255
 *     would give the SLOWEST scroll rather than the fastest - which is exactly the
 *     shape of bug that makes a "turbo" setting feel broken. Unsigned is the
 *     expectation; this is how it stops being one.
 *
 * **One flash write, at the start, and none after it.** `SPEED` and `MODE` are RAM,
 * so a sweep of any length costs the same five page erases as a single save, and a
 * second run costs nothing at all because the budget guard recognises the payload.
 *
 * There is nothing to read back: the device never reports its divisor. The output is
 * a prediction per step and a human deciding whether the panel agreed.
 */
import { font, protocol as p } from '@joggles/core'
import { open, sleep } from './glasses.js'

export interface SweepOptions {
  /** What to scroll. Wants to be wider than the panel or there is no motion to judge. */
  text?: string
  /** How long each step is held. Below about 3s there is not enough motion to compare. */
  holdMs?: number
}

/**
 * Arguments past the top of the ladder, which the firmware should treat as identical.
 *
 * 255 is where a person reaches when a control says "faster" and they want more; 128
 * is the first value that is negative if the compare is signed. Nothing here can be
 * larger than a byte: the frame carries `SPEED` and one argument.
 */
const BEYOND = [100, 101, 128, 200, 255]

export async function sweepSpeed(opts: SweepOptions = {}): Promise<void> {
  const text = opts.text ?? 'JOGGLES JOGGLES'
  const hold = opts.holdMs ?? 6000
  const bitmap = font.panelBitmap(text)
  const columns = bitmap[0]?.length ?? 0

  if (columns <= 24) {
    console.log(`"${text}" is ${columns} columns and fits the panel, so it will not`)
    console.log('scroll and there is no speed to see. Give it something longer.')
    return
  }

  const g = await open({ pacing: 8 })
  console.log(`connected to ${g.name}`)
  console.log(`"${text}" -> ${columns} columns\n`)

  const { status, reply, saves } = await g.save(bitmap)
  // 'skipped' is the budget guard recognising a payload the device already holds,
  // which is the good case on a re-run: the content is there and no flash was written.
  if (reply !== 'DATCPOK' && status !== 'skipped') {
    console.log(`upload failed: ${reply} (${status}). Nothing to scroll, stopping.`)
    await g.end('keep')
    return
  }
  console.log(`content on the device: ${reply} (${status}, ${saves} saves to this unit)\n`)

  const show = async (arg: number): Promise<void> => {
    // SPEED before MODE, the order `deliver.ts` sends and the run that worked used.
    // MODE is re-sent per step so every rung starts from the same position, which is
    // what makes two of them comparable by eye.
    await g.command(p.speed(arg))
    await g.command(p.mode(2, 0))
    await sleep(hold)
  }

  console.log('=== the ten rungs. Each should be visibly faster than the one before.')
  console.log('step   SPEED   predicted   ms/column')
  console.log('-'.repeat(42))
  for (const [i, arg] of p.SPEED_STEPS.entries()) {
    console.log(
      `${String(i + 1).padStart(4)}${String(arg).padStart(8)}` +
        `${p.columnsPerSecond(arg).toFixed(1).padStart(12)}/s` +
        `${String(p.msPerColumn(arg)).padStart(10)}`,
    )
    await show(arg)
  }

  console.log('\n=== past the top of the ladder. All five should look IDENTICAL to')
  console.log(`    step ${p.SPEED_STEPS.length}, and identical to each other.`)
  console.log('If one is slower, the firmware compare is signed and the fast end of')
  console.log('the chip row is wrong. If one is FASTER, the ladder is not the whole')
  console.log('story and protocol.ts needs correcting.\n')
  for (const arg of BEYOND) {
    console.log(`    SPEED ${arg}`)
    await show(arg)
  }

  await g.end('keep')
  console.log('\nleft scrolling at the last value. Two questions to answer:')
  console.log('  1. were all ten rungs different, in order, slowest first?')
  console.log(`  2. did anything above ${p.SPEED_FASTEST_ARG} differ from step ${p.SPEED_STEPS.length}?`)
  console.log('\nIf both are "no surprises", the ceiling is confirmed: 12.5 columns a')
  console.log('second is the fastest this firmware scrolls, and only the tick patch')
  console.log('at abs 0x18052 moves it. See notes/plan-after-the-brick.md.')
}
