/**
 * base64 for the BLE adapter, hand-rolled and dependency-free.
 *
 * ble-plx speaks base64 in both directions and React Native has no `Buffer` and no
 * dependable `btoa`. Kept in its own file with no React Native imports so it can be
 * tested under `bun test`, which the rest of the adapter cannot be.
 *
 * Worth testing rather than eyeballing: every frame this protocol sends is 16 bytes,
 * and 16 is not a multiple of 3, so the padding path runs on literally every write.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += ALPHABET[a >> 2]
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : ALPHABET[c & 63]
  }
  return out
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  const out = new Uint8Array((clean.length * 3) >> 2)
  let acc = 0
  let bits = 0
  let n = 0
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch)
    if (v < 0) continue
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, n)
}
