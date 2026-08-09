/**
 * Wrap a raw binary in a minimal ELF32 so llvm-objdump will disassemble it.
 * Rebuild of the one-off described in research/firmware-internals.md "Reproducing".
 *
 *   bun mkelf.ts fw10.bin fw10.elf 0x16800
 */
const [inPath, outPath, baseArg] = Bun.argv.slice(2)
const base = Number(baseArg)
const text = new Uint8Array(await Bun.file(inPath).arrayBuffer())

const strtab = new TextEncoder().encode('\0.text\0.shstrtab\0')
const NAME_TEXT = 1
const NAME_STRTAB = 7

const align4 = (n: number) => (n + 3) & ~3
const textOff = align4(52)
const strOff = align4(textOff + text.length)
const shOff = align4(strOff + strtab.length)

const size = shOff + 3 * 40
const buf = new Uint8Array(size)
const dv = new DataView(buf.buffer)
const u8 = (o: number, v: number) => dv.setUint8(o, v)
const u16 = (o: number, v: number) => dv.setUint16(o, v, true)
const u32 = (o: number, v: number) => dv.setUint32(o, v >>> 0, true)

// e_ident
buf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0], 0)
u16(16, 2)            // e_type ET_EXEC
u16(18, 40)           // e_machine EM_ARM
u32(20, 1)            // e_version
u32(24, base)         // e_entry
u32(28, 0)            // e_phoff
u32(32, shOff)        // e_shoff
u32(36, 0x05000000)   // e_flags EF_ARM_EABI_VER5
u16(40, 52)           // e_ehsize
u16(42, 32)           // e_phentsize
u16(44, 0)            // e_phnum
u16(46, 40)           // e_shentsize
u16(48, 3)            // e_shnum
u16(50, 2)            // e_shstrndx

buf.set(text, textOff)
buf.set(strtab, strOff)

const shdr = (i: number, f: Record<string, number>) => {
  const o = shOff + i * 40
  u32(o + 0, f.name ?? 0)
  u32(o + 4, f.type ?? 0)
  u32(o + 8, f.flags ?? 0)
  u32(o + 12, f.addr ?? 0)
  u32(o + 16, f.offset ?? 0)
  u32(o + 20, f.size ?? 0)
  u32(o + 32, f.align ?? 0)
}
shdr(0, {})
shdr(1, {
  name: NAME_TEXT, type: 1, flags: 0x6,
  addr: base, offset: textOff, size: text.length, align: 4,
})
shdr(2, { name: NAME_STRTAB, type: 3, offset: strOff, size: strtab.length, align: 1 })

await Bun.write(outPath, buf)
console.log(`${outPath}: ${text.length} bytes at ${'0x' + base.toString(16)}`)
