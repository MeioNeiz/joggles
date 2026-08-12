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
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const HERE = dirname(new URL(import.meta.url).pathname)

/** Every module reachable from the barrel, as absolute paths. */
function reachable(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [resolve(HERE, entry)]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
      // Source is TypeScript importing `./x.js`, per this package's convention.
      queue.push(resolve(dirname(file), m[1].replace(/\.js$/, '.ts')))
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
  expect(MODULES.length).toBeGreaterThan(4)
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
 * Comments stripped, so prose cannot pass or fail a code assertion.
 *
 * Added 2026-08-12: `gif.ts` failed this crawl by *promising* in its docblock not to use
 * `Buffer`, which is the guard's own rule restated and the opposite of a violation. The
 * repo already settled this shape elsewhere (`effects-ui/wiring.test.ts`, and the spray
 * track's crawl) - a docblock has to stay free to name what the code may not do.
 *
 * The OTA crawl above deliberately does NOT use this: naming `fd00` anywhere, comment
 * included, is worth failing over, because that one is the brick guard.
 */
const codeOf = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

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
})

test('firmware.js is the only way to the flash-writing half', async () => {
  const firmware = await import('./firmware.js')
  expect(typeof firmware.ota.check).toBe('function')
  expect(firmware.dfu.SERVICE).toContain('fd00')

  const barrel = await import('./index.js')
  expect(Object.keys(barrel)).not.toContain('ota')
  expect(Object.keys(barrel)).not.toContain('dfu')
})
