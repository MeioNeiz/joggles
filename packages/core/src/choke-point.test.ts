/**
 * `DATCP` is the only thing this codebase does that writes flash, so it gets one
 * caller and that caller is rate limited.
 *
 * Five page erases per call whatever the payload size, no wear levelling, and no
 * way to read the remaining cycles back off the device. The defence cannot be a
 * code review habit, because the runaway causes are all code nobody thought was
 * about saving: a React effect under StrictMode, a retry loop with no ceiling, a
 * reconnect handler that "restores state", a teardown path that commits on the way
 * out. Every one of those adds a second caller, and this test is what notices.
 *
 * Reasoning and the full list: "Flash wear" in `notes/app-plan.md`.
 */
import { expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../../..')

/** Where the flash write is declared. Every other mention is a caller. */
const DECLARED_IN = 'dats.ts'

const SKIP = new Set(['node_modules', '.git', 'apk', 'decompiled', 'native', 'firmware'])

/** Source with comments removed, so prose about the choke point is not a caller. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry) || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, out)
    // Tests may name it; they run against a mock and write no flash.
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(path)
  }
  return out
}

const MENTIONS = sources(ROOT)
  .filter((f) => !f.endsWith(`/${DECLARED_IN}`))
  .filter((f) => /\bdatsComplete\b/.test(code(readFileSync(f, 'utf8'))))
  .map((f) => f.slice(ROOT.length + 1))

test('the scan sees the codebase it thinks it does', () => {
  // Guards the walker: a wrong root would make every assertion below vacuous.
  const all = sources(ROOT).map((f) => f.slice(ROOT.length + 1))
  expect(all).toContain('packages/core/src/session.ts')
  expect(all).toContain('packages/cli/src/glasses.ts')
  expect(all.length).toBeGreaterThan(20)
})

test('datsComplete has exactly one caller in the codebase', () => {
  expect(MENTIONS).toEqual(['packages/core/src/session.ts'])
})

test('that caller is session.save, and it goes through the budget guard', () => {
  const src = code(readFileSync(join(ROOT, 'packages/core/src/session.ts'), 'utf8'))
  const calls = (re: RegExp) => src.match(re)?.length ?? 0

  expect(calls(/\bdatsComplete\(/g)).toBe(1)
  // One check before the write and one count after it. A second save path would
  // have to duplicate both to get past this.
  expect(calls(/\bbudget\.allow\(/g)).toBe(1)
  expect(calls(/\bbudget\.count\(/g)).toBe(1)

  const save = src.slice(src.indexOf('async save('), src.indexOf('async command('))
  expect(save).toContain('datsComplete()')
  expect(save).toContain('this.budget.allow(')
})
