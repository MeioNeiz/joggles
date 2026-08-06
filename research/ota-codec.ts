/**
 * OTA container codec, command line front end.
 *
 *   bun research/ota-codec.ts verify firmware/*.bin
 *   bun research/ota-codec.ts decode firmware/TR1906R04-10_OTA.bin out.bin
 *   bun research/ota-codec.ts encode out.bin rebuilt.bin
 *
 * The codec itself lives in `packages/core/src/ota.ts` so that it is testable and
 * shared with the safety checks. This file is only the CLI.
 *
 * To decide whether an image is safe to send, use `bun packages/cli/src/ota-check.ts`
 * instead. `verify` below only checks that the container is internally consistent.
 */
// Relative, not '@joggles/core': research/ is outside the bun workspace.
import * as ota from '../packages/core/src/ota.js'

const hex8 = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0')

async function verify(paths: string[]) {
  for (const path of paths) {
    const file = new Uint8Array(await Bun.file(path).arrayBuffer())
    const h = ota.parseHeader(file)
    const plain = ota.plaintext(file)

    const sizeOk = h.codeSize === file.length - ota.HEADER_SIZE
    const crcOk = ota.crc32(plain) === h.crc32
    const rebuilt = ota.encode(plain, h)
    const rtOk = rebuilt.length === file.length && rebuilt.every((v, i) => v === file[i])

    // Every pad position should be dominated by 0x00 in the plaintext, since
    // zero-fill dominates a firmware image. A wrong pad byte shows up immediately.
    let badPos = 0
    for (let j = 0; j < ota.pad.length; j++) {
      const hist = new Array(256).fill(0)
      for (let i = j; i < plain.length; i += ota.pad.length) hist[plain[i]]++
      let mode = 0
      for (let v = 1; v < 256; v++) if (hist[v] > hist[mode]) mode = v
      if (mode !== 0) badPos++
    }

    console.log(`${path}`)
    console.log(`  codeSize ${h.codeSize} (${sizeOk ? 'matches file length' : 'MISMATCH'})`)
    console.log(`  crc32    ${hex8(h.crc32)} over deobfuscated body: ${crcOk ? 'MATCH' : 'MISMATCH'}`)
    console.log(`  version  app=${h.appVer} dev=${h.devVer} pro=${h.proVer} type=${h.type}`)
    console.log(`  pad positions with non-zero modal byte: ${badPos}/${ota.pad.length}`)
    console.log(`  re-encode byte-identical to original: ${rtOk}`)
  }
}

const [cmd, ...rest] = Bun.argv.slice(2)
if (cmd === 'verify') {
  await verify(rest)
} else if (cmd === 'decode') {
  const file = new Uint8Array(await Bun.file(rest[0]).arrayBuffer())
  await Bun.write(rest[1], ota.plaintext(file))
  console.log(JSON.stringify(ota.parseHeader(file), null, 2))
} else if (cmd === 'encode') {
  const plain = new Uint8Array(await Bun.file(rest[0]).arrayBuffer())
  await Bun.write(rest[1], ota.encode(plain, { appVer: 3, devVer: 10, proVer: 10, type: ota.OTA_APP }))
  console.log(`wrote ${rest[1]}: ${plain.length} body bytes, crc32 ${hex8(ota.crc32(plain))}`)
} else {
  console.log('usage: ota-codec.ts <verify|decode|encode> ...')
}
