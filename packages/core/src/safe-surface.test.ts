/**
 * What `@joggles/core` is allowed to drag in.
 *
 * Two properties the phone app depends on, neither of which any other test would
 * notice breaking:
 *
 *  1. **No route to the OTA service.** A stock-over-stock OTA commit bricked
 *     `GLASSES-12C3EF` on 2026-08-08. The app's defence is that the code to do it
 *     is not in the bundle, which only holds while the barrel stays clean. `ota`
 *     and `dfu` live behind `firmware.js` for exactly this reason.
 *  2. **No Node.** React Native has no `Buffer`, no `node:` modules and no
 *     `process`. The stack decision (one shared TS core, two transports) rests on
 *     this package importing none of them.
 *
 * Crawls relative imports from the barrel rather than trusting the export list,
 * because the risk is a transitive import somebody adds three modules down.
 *
 * This guards the barrel and nothing else. The other doors to the same code, an
 * importer in the CLI or in the app that skips the barrel entirely, are
 * `firmware-doors.test.ts`: a gate on one door is the failure this project keeps
 * recording.
 *
 * **Every pattern below was defeated before it was written.** Track 64 got five
 * violations past the previous crawl in a scratch copy: a dynamic `import('./ota.js')`,
 * a `require('./ota.js')`, a side-effect `import './dfu.js'` with no `from`, a
 * double-quoted specifier, and `import { readFileSync } from 'fs'` without the `node:`
 * prefix. Each is now a named attack in "the crawl catches the ways round it" below,
 * and the discovery regex reads specifiers rather than one spelling of an import.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const HERE = dirname(new URL(import.meta.url).pathname)

/**
 * Comments stripped, so prose cannot pass or fail a code assertion.
 *
 * Added 2026-08-12: `gif.ts` failed this crawl by *promising* in its docblock not to use
 * `Buffer`, which is the guard's own rule restated and the opposite of a violation. The
 * repo already settled this shape elsewhere (`effects-ui/wiring.test.ts`, and the spray
 * track's crawl) - a docblock has to stay free to name what the code may not do.
 *
 * The OTA name check deliberately does NOT use this: naming `fd00` anywhere, comment
 * included, is worth failing over, because that one is the brick guard.
 *
 * A trailing `//` goes too, but only when the quotes before it are balanced. Eating to
 * end of line unconditionally would eat `'http://x'` and hide whatever followed it on
 * that line, which is the wrong direction for a guard to be wrong in; refusing to eat
 * trailing comments at all fails a docblock's own right to name what the code may not
 * do, which is what this stripper exists for.
 */
const stripTrailing = (line: string): string => {
  const at = line.indexOf('//')
  if (at < 0) return line
  const before = line.slice(0, at)
  const unclosed = (q: string) => (before.split(q).length - 1) % 2 === 1
  return unclosed("'") || unclosed('"') || unclosed('`') ? line : before
}

const codeOf = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(stripTrailing)
    .join('\n')

/**
 * Every module specifier a file actually pulls in, however it spells the import.
 *
 * `from 'x'` is one spelling of five. The others all bundle their target just as
 * effectively, and four of them walked past the previous version of this crawl:
 * `import 'x'` for side effects, `import('x')` dynamically, `require('x')`, and any
 * of those with double quotes. Read off comment-stripped source, so a commented-out
 * import is correctly not an import.
 */
const specifiers = (src: string): string[] =>
  [
    ...codeOf(src).matchAll(
      /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"\n]+)['"]/g,
    ),
  ].map((m) => m[1])

/** Every module reachable from the barrel, as absolute paths. */
function reachable(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [resolve(HERE, entry)]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const src = readFileSync(file, 'utf8')
    for (const spec of specifiers(src)) {
      if (!spec.startsWith('.')) continue
      // Source is TypeScript importing `./x.js`, per this package's convention.
      queue.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')))
    }
  }
  return [...seen]
}

const MODULES = reachable('index.ts')

test('the barrel reaches every module it should', () => {
  // Guards the crawler itself: a regex that silently matched nothing would make
  // every assertion below vacuous.
  const names = MODULES.map((f) => f.split('/').pop())
  expect(names).toContain('protocol.ts')
  expect(names).toContain('aes.ts')
  expect(names).toContain('display.ts')
  expect(names).toContain('jgx.ts')
  expect(MODULES.length).toBeGreaterThan(20)
})

test('nothing reachable from the barrel can address the OTA service', () => {
  for (const file of MODULES) {
    expect(file).not.toMatch(/\/(ota|dfu)\.ts$/)
    const src = readFileSync(file, 'utf8')
    const hit = src.match(/fd0[0-2]/i)
    expect(hit, `${file.split('/').pop()} names ${hit?.[0]}`).toBeNull()
  }
})

/**
 * Zero dependencies is the rule, and it is a stronger rule than "no Node".
 *
 * `packages/core` has no dependencies at all, so any non-relative specifier in a
 * barrel-reachable module is a violation whatever it names: `node:fs`, bare `fs`,
 * `react-native`, a npm package. Stating it that way closes the gap that a list of
 * known Node builtins leaves open, which is how `import { readFileSync } from 'fs'`
 * got past this file before.
 */
test('nothing reachable from the barrel imports anything outside itself', () => {
  for (const file of MODULES) {
    const outside = specifiers(readFileSync(file, 'utf8')).filter((s) => !s.startsWith('.'))
    expect(outside, `${file.split('/').pop()} imports ${outside.join(', ')}`).toEqual([])
  }
})

test('nothing reachable from the barrel needs Node', () => {
  for (const file of MODULES) {
    const src = codeOf(readFileSync(file, 'utf8'))
    expect(src).not.toMatch(/from\s+'node:/)
    expect(src).not.toMatch(/\bBuffer\b/)
    expect(src).not.toMatch(/\bprocess\.\w/)
  }
})

test('stripping comments does not blind the Node crawl', () => {
  // Guards the stripper: without this, a regex that ate the whole file would make the
  // assertions above vacuous in exactly the way `reachable()` is guarded against.
  const stripped = codeOf('/** no Buffer here */\nconst x = Buffer.from([1])\n')
  expect(stripped).not.toContain('no Buffer here')
  expect(stripped).toMatch(/\bBuffer\b/)
  expect(codeOf("// from 'node:fs'\nimport { x } from 'node:fs'\n")).toMatch(/from\s+'node:/)
  // A docblock, and a trailing comment, may both name what the code may not do.
  expect(codeOf("const ok = 1 // from 'node:fs'\n")).not.toMatch(/from\s+'node:/)
  // But a string containing // must survive, or the token after it disappears.
  expect(codeOf("const u = 'http://x' + Buffer\n")).toMatch(/\bBuffer\b/)
  expect(codeOf('const u = "http://x" + Buffer\n')).toMatch(/\bBuffer\b/)
  expect(codeOf('const u = `http://${Buffer}`\n')).toMatch(/\bBuffer\b/)
})

/**
 * The five ways round the old crawl, each now caught.
 *
 * A gate nobody has attacked is a gate whose confidence is unearned, so these are the
 * attacks themselves rather than a description of them: every line here was verified
 * to pass the previous crawl before this test existed.
 */
test('the crawl catches the ways round it', () => {
  const attacks: [string, string][] = [
    ['dynamic import', "export const x = () => import('./ota.js')"],
    ['require', "export const x = () => require('./ota.js')"],
    ['side-effect import, no from', "import './dfu.js'"],
    ['double quotes', 'import * as x from "./ota.js"'],
    ['bare Node builtin', "import { readFileSync } from 'fs'"],
    ['npm package', "import { z } from 'zod'"],
  ]
  for (const [name, line] of attacks) {
    expect(specifiers(line), name).not.toEqual([])
  }

  // And the relative ones are followed, not merely noticed.
  const followed = attacks
    .map(([, line]) => specifiers(line)[0])
    .filter((s) => s.startsWith('.'))
  expect(followed).toEqual(['./ota.js', './ota.js', './dfu.js', './ota.js'])

  // A commented-out import is not an import, and must not be followed.
  expect(specifiers("// import './ota.js'\n")).toEqual([])
})

test('firmware.js is the only way to the flash-writing half', async () => {
  const firmware = await import('./firmware.js')
  expect(typeof firmware.ota.check).toBe('function')
  expect(firmware.dfu.SERVICE).toContain('fd00')

  const barrel = await import('./index.js')
  expect(Object.keys(barrel)).not.toContain('ota')
  expect(Object.keys(barrel)).not.toContain('dfu')
})
