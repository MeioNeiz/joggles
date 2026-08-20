# The NuMicro originals behind this FMC

**Status: offline documentary research, 2026-08-20, track 56. No hardware was touched.**
Sources are Nuvoton technical reference manuals and datasheets, Nuvoton's own BSP headers
and application notes, OpenOCD's `numicro.c`, Panchip's own CMSIS header for this part,
and the PAN1020 User Manual v1.8, which turned up late and is the first real register
document this project has had for the part.

**Scope:** what the parts this FMC was cloned from actually document, so that track 55's
on-silicon findings in `research/fmc-erase-program.md` have a paper backing, and so that
the places where the clone differs from its ancestor are named rather than assumed.

**Verdict: the clone is a *late* NuMicro FMC wearing early names.** The register offsets
match the 2010-era NUC100/M051 parts, which is what made `ISPCON 0x5000c000` recognisable,
but the *behaviour* is the 2016-era NUC121/NUC126 generation: SPROM, `ISPSTS` at `+0x40`,
a hardware CRC32, and a nine-condition fail flag. Quoting an M051 manual for what this
silicon does is right about the addresses and wrong about half the semantics. This file
says which upstream document to believe for which question.

Read `research/fmc-erase-program.md` first: it is the on-silicon evidence and it outranks
everything here. This file is the paper behind it, plus the family comparisons that only
matter when adapting somebody else's driver.

## Verdict

| Question | Answer | Confidence |
| --- | --- | --- |
| Which NuMicro generation is this FMC | the **late** one (NUC121/NUC126 era), not M051/NUC100 | *verified* from Panchip's own `PN102Series.h`, register by register |
| Erase granularity upstream | **512 B on every family this one resembles**, but 2 KB on four Cortex-M0 families and 4 KB on M480 | *verified* from Nuvoton BSP headers |
| Is there a register manual for this part | **Yes, and the repo thought there was not.** PAN1020 User Manual v1.8, 373 pp, FMC chapter, on Panchip's forum. It documents `CONFIG0` as `[31:8]` Reserved, which thins section 9 | *verified* |
| Is OpenOCD's "ARMv6-M means 512 bytes" rule safe | **No, it is a heuristic and it is wrong for six part families.** Nuvoton's own fork replaces it with a part-ID table | *verified* from both sources |
| Page erase time | **Plan for 20 ms.** Eleven tables say 20 ms; the 2 ms and 3 ms outliers are the ones with no endurance row and a "guaranteed by design" note | *verified* tables, *derived* reading |
| Word program time | **20 to 40 us typ** | *verified* from datasheets |
| Does a set `ISPFF` block the next ISP operation | **No.** M051's manual says so in as many words | *verified* from the TRM |
| Is `ISPFF` write-1-to-clear | **Yes**, on every family | *verified* |
| Which registers `REGLCTL` protects | `ISPCON` and `ISPTRG` **only**, of the FMC block. `ISPCMD`, `ISPADR` and `ISPDAT` are unprotected | *verified* from Panchip's own header |
| Does the FMC stall the CPU during ISP | **Yes, and only on a flash access.** Peripherals keep running | *verified* from the M051 and NUC121 TRMs |
| Is it safe to read FMC registers over SWD while `ISPGO` is set | **Yes.** Every NuMicro flash driver in existence polls exactly that | *verified* by construction |
| Is it safe to read *flash* over SWD while `ISPGO` is set | **No, and this is the documented mechanism** for the AHB stall track 54 already hit | *derived*, strongly |
| Watchdog out of reset | **disabled** (`WTCR` resets to `0x0000_0700`) unless the `CWDTEN` fuse arms it, and this unit's fuse does not | *verified* on the Nuvoton side, *derived* for this part |
| Does the WDT count while halted by ICE | **No, by default.** `DBGACK_WDT`/`ICEDEBUG` resets to 0, meaning "held while CPU is held by ICE" | *verified* from three TRMs and the Panchip header |
| Can a programmed word be programmed again | **No, and Nuvoton's own EEPROM-emulation note is built entirely on never doing it** | *derived* |
| Can the hardware tell you a program did not take | **No. Nothing on this class can.** No verify flag, no blank check, no busy bit distinct from `ISPGO`, no FMC interrupt, no brown-out interlock. **Software read-back is the only detection mechanism that exists** | *verified* by absence across five families |
| Is there a low-voltage inhibit on flash writes | **No.** No pin-VDD floor, no voltage-related `ISPFF` cause, and Nuvoton's only documented IAP inhibit is 8051-only. But **LVR is on by default and has no fuse**, so a deep enough sag resets the part rather than corrupting quietly | *verified* |
| Can an interrupted erase permanently damage the part | **Nothing in any Nuvoton document says so.** AN0025 models an interrupted write as page-granular and recoverable by resuming | *derived* from AN0025's recovery design |

## 1. This is the late FMC, not the early one, and it matters

Two NuMicro FMC generations share the same first five register offsets, which is exactly
what makes the misidentification easy.

| | Early (NUC100, M051, Mini51, NUC029xAN) | Late (NUC121, NUC126, M451, and **this part**) |
| --- | --- | --- |
| Control register | `ISPCON` | `ISPCTL`, same offset `+0x00` |
| Address register | `ISPADR` | `ISPADDR`, same offset `+0x04` |
| Bit 2 of control | **Reserved** | **`SPUEN`**, SPROM update enable |
| Status register | `ISPSTA +0x40`, DN/DE parts only | `ISPSTS +0x40`, always |
| `ISPFF` conditions | 3 (M051) or 4 (NUC100) | **9** |
| SPROM | absent | present, 512 B at `0x00200000` |
| CRC32 in hardware | absent | `0x2D` run, `0x0D` read |
| Access-time register | `FATCON`, one `LFOM` bit | `FATCTL`, a 3-bit `FOM` field |

Panchip's `PN102Series.h` (which actually declares itself `PN020.h` in its file header)
puts this part unambiguously in the right-hand column: *verified*, its `FMC_T` is
`ISPCTL / ISPADDR / ISPDAT / ISPCMD / ISPTRG / DFBA(RO) / FATCTL / [9 reserved] / ISPSTS`,
with `SPUEN` at bit 2 and the nine-condition `ISPFF` list.

**Which upstream document to believe, per question:**

| Question | Believe | Not |
| --- | --- | --- |
| register offsets, unlock keys, `REGLCTL` list | M051 TRM, and Panchip's own header | |
| `ISPFF` conditions | NUC121/NUC126 TRM (9 conditions) | M051 (3) |
| CPU stall wording | NUC121 TRM, which is the precise one | M051, which overstates it |
| `CONFIG0` `CBS` encoding | any two-bit-`CBS` family | the 2010 NUC100 TRM, where `CBS` is one bit |
| erase and program timing | **the datasheet of whichever family, they differ 10x**, and none of them is this part | |

## 2. Erase granularity across the families, and why OpenOCD's rule is wrong

Page size tracks the **flash macro generation, not the CPU core**. Straight from Nuvoton's
own `Library/StdDriver/inc/fmc.h`, `FMC_FLASH_PAGE_SIZE`, all *verified*:

| Family | Core | Page |
| --- | --- | --- |
| NUC100/120, M051, M0518, Mini51, Mini58, NUC123, NUC131, Nano100B | M0 | **512 B** |
| NUC029xAN, NUC029xDE, NUC029xEE, NUC029FAE | M0 | **512 B** |
| NUC121/125 | M0 | **512 B** |
| M031 default build | M0 | **512 B** |
| **NUC126** | M0 | **2 KB** |
| **NUC1262** | M0 | **2 KB** |
| **NUC029xGE** | M0 | **2 KB** |
| **M031 with `PAGE_SIZE_2048` defined** | M0 | **2 KB** |
| M451, NUC442/472, M2351 | M4/M23 | 2 KB |
| M480 | M4 | 4 KB |

`NUC029` is not one family for this question: `xAN`/`xDE`/`xEE`/`FAE` are 512 B and `xGE`
is 2 KB. `M031`'s own header carries a commented-out `PAGE_SIZE_2048` switch, so the same
header ships both answers and the build picks.

**OpenOCD upstream decides page size from the CPU core**, which is the wrong axis.
`src/flash/nor/numicro.c`, `numicro_get_arm_arch()`, verbatim:

    #define NUMICRO_PAGESIZE        512
    ...
    if (armv7m->arm.arch != ARM_ARCH_V6M) {
            m_page_size = NUMICRO_PAGESIZE * 4;
            m_address_bias_offset = 0x10000000;
    } else {
            m_page_size = NUMICRO_PAGESIZE;
            m_address_bias_offset = 0x0;
    }

That is the whole rule: ARMv6-M gets 512, everything else gets 2048. There is no per-part
page-size entry anywhere in `numicro_parts[]`, which carries only part name, part ID and
four bank sizes. The `0x10000000` bias is unrelated to page size: it moves the register
base from `0x5000_C000` to `0x4000_C000`, which is where the M4 parts put the FMC.

**Nuvoton's own fork does it properly.** `OpenNuvoton/OpenOCD-Nuvoton`, same function,
selects `NUMICRO_PAGESIZE * 4` for an explicit list of ARMv6-M part IDs: NUC029LGE/SGE/KGE,
M071QE4AE/QG4AE/VG4AE, M0564, NUC126, NUC1261, and four M031G/M031I ID ranges. Everything
else ARMv6-M stays at 512.

**What this means here.** `notes/swd-flashing.md` item 2 leans on OpenOCD's 512 partly as
corroboration. It is not corroboration, it is a coin flip that happened to land right, and
track 55 settled the question properly from the silicon. Do not re-derive it from OpenOCD.

## 3. OpenOCD's `numicro.c`, and the four things it does that our TCL does not

All *verified* by reading `openocd-org/openocd@master`. Relevant because the repo has
considered adapting this driver, and because its choices are a checklist for the TCL.

**`numicro_init_isp()`, in order:**

1. refuse unless the target is halted
2. `numicro_reg_unlock()`: read `0x50000100`; **only if it reads exactly 0** write `0x59`,
   `0x16`, `0x88`; read back and log whether it now reads 1
3. read-modify-write `AHBCLK 0x50000204` with `ISP_EN|SRAM_EN|TICK_EN` (bits 2, 4, 5)
4. read-modify-write `ISPCON` with `ISPFF|LDUEN|APUEN|CFGUEN|ISPEN` (`0x79`)
5. write `1` to `0x5000c01c`, commented *"Write one to undocumented flash control register"*
   and `#define`d as `NUMICRO_FLASH_CHEAT` / *"may be cheat register"*

Step 4 is the one to notice: **upstream sets `CFGUEN` unconditionally**, which
`research/hardware-access.md` already flags as the bit to delete before building. It also
writes `ISPCON` wholesale rather than preserving `BS`, the same defect track 55 found in
our own script. Step 5 has no counterpart in any vendor header; on this part `0x5000c01c`
falls inside `FMC_T`'s nine reserved words. Nuvoton's fork only writes it for ARMv6-M parts
that have no SPROM, and **this part has an SPROM**, so by the vendor's own condition it
should not be written here.

**`numicro_fmc_cmd()` order:** `ISPCMD`, `ISPDAT`, `ISPADR`, then `ISPTRG = 1`. Note
`ISPDAT` before `ISPADR`, the opposite of the vendor's own driver. Then poll `ISPTRG` bit 0,
then read `ISPDAT` unconditionally, even for erase.

**Failure handling:** only `numicro_erase()` and `numicro_write()` check `ISPFF`, and they
check it by reading `ISPCON` and testing bit 6. On failure they log at debug level, write
`status | ISPCON_ISPFF` back to clear it, and then **return `ERROR_OK` anyway**. A failed
erase is not reported to the caller. If this driver is ever adapted, that is the first
thing to fix.

**Timeouts:** every poll loop is `timeout = 100` with `busy_sleep(1)`, i.e. **about
100 ms**.
Against the datasheet numbers in section 4 that is 5x a 20 ms page erase and only 2.5x a
40 ms mass erase. Our TCL's ~2 s ceiling is the better choice.

**Two more details.** `numicro_erase()` polls for the whole `ISPTRG` register to read 0,
not just bit 0. `numicro_flash_bank_command()` sets
`bank->write_start_alignment = bank->write_end_alignment = 4`.

**Why the driver cannot be used here, with the reason rather than the symptom.**
`numicro_get_cpu_type()` reads the part ID from `NUMICRO_SYS_BASE`, which is
`0x50000000` flat, and fails unless it matches `numicro_parts[]`. The repo has *verified*
that this part reads `0x00000000` there. The reason is now visible on paper: Nuvoton's
`SYS_T` begins with `PDID` at `GCR_BA+0x00` (*verified*, NUC100 TRM p.111 and M051 TRM
p.61), whereas Panchip's `SYS_T` begins with `__I uint32_t RESERVED0[1]` and starts real
registers at `RSTSTS +0x04`. **Panchip deleted `PDID`.** The route is closed by design, not
by a bad read.

**The identity that does exist** is in the FMC, and Panchip's `fmc.c` gives the addressing:

| Want | `ISPCMD` | `ISPADDR` |
| --- | --- | --- |
| Company ID | `0x0B` | `0x00` |
| Product ID | `0x0C` | **`0x04`**, not 0 |
| Unique ID word n | `0x04` | `n` (the vendor SDK passes the raw index, not `4*n`) |
| Unique customer ID word n | `0x04` | `0x10 + 4*n` |

The `ISPADDR = 0x04` for product ID is worth having: Nuvoton's own parts take don't-care
there, so a naive port would pass 0 and might read the company ID instead.

## 4. Erase and program timing, from the datasheets

**Plan for a 20 ms page erase.** That is the figure eleven of the fourteen NuMicro flash
tables surveyed give, and the handful of faster ones look like early under-characterised
entries rather than faster silicon. The reasoning is below, because the raw table count is
the weaker half of the argument.

Nuvoton publishes these in the datasheet, never in the TRM, under "Flash DC Electrical
Characteristics". The rows below are *verified* by reading the tables.

| Family | Page erase | Mass erase | Word program | Endurance | Retention |
| --- | --- | --- | --- | --- | --- |
| NUC100/120xxxDN datasheet Rev 1.04 | **2 ms** | 10 ms | 20 us | **not stated** | 10 yr at 85 C |
| M051 DN/DE Rev 1.03 | **20 ms** | not stated | 40 us | 20,000 | 10 yr at 85 C |
| NUC123 Rev 2.04, ANx (s7.5) | **20 ms** | 40 ms | 40 us | **not stated** | 10 yr at 85 C |
| NUC123 Rev 2.04, AEx (s8.5) | **20 ms** | 40 ms | 35 us | 20,000 | 100 yr at 25 C |
| M0518 Rev 1.02 (s8.5) | **20 ms** | 40 ms | 40 us | 20,000 | 10 yr at 85 C |
| M031, the best-characterised table in the set | **20 ms** | | | stated | |

**M031 says 20 ms and is the best-characterised table of the set**, which isolates NUC100's
2 ms further. **Two things about M031 must not be carried across to this part.** Its pages
are **2048 bytes**, not 512. And its ISP set gives **`0x23` as an APROM *bank* erase**,
where Panchip's own `fmc.h` gives `0x23` as `FMC_ISPCMD_CPERASE`, a **whole-flash** erase
marked "Rom use only". Both destructive, neither expressible by our tooling, but **the
meaning of an opcode number differs by family** and this repo has already been burned once
by assuming one transfers. *verified* for the page size and both command tables, from the
vendor BSP headers.

**Why 20 ms and not 2 ms, stated properly.** Across the wider survey, 2 ms appears **once**,
3 ms **twice**, and 20 ms in **eleven** tables. Counting tables is the weak argument. The
strong one is *which* tables are the fast ones: the 2 ms and 3 ms entries are precisely the
ones with **no endurance row at all** and carrying the note "guaranteed by design, not test
in production". A table that omits endurance and disclaims measurement is an early,
under-characterised datasheet, not evidence of a faster flash macro. The later and
better-populated tables converge on 20 ms. *derived*, and it is the reason to size a poll
ceiling against 20 ms even though this part's own datasheet says nothing.

**No maximum is published for any of these numbers, in any family.** Every entry is
typical, and several add "guaranteed by design, not test in production". A poll ceiling has
to be generous on principle, not tuned to a typical.

**A table bug that will mislead the next reader, so read the column heading.** M0518,
NUC131, NUC029xDE and NUC029xEE print `TERASE`, `TMER` and `TPROG` in the **MIN** column,
with `TYP` and `MAX` left as dashes, while sibling datasheets put the identical values under
`TYP`. *verified* for M0518 Rev 1.02 by reading the table directly: `TERASE 20 - - ms` with
the 20 under MIN. A minimum erase time is not a meaningful specification, so these are
typicals in the wrong column, and anyone quoting "minimum 20 ms" from them is quoting a
typo.

**A correction to an earlier draft of this file.** It cited M0518 **Rev 1.01** for a data
retention of 100 yr at 85 C. That is a superseded figure: **Rev 1.02 gives 10 yr at 85 C**,
*verified* by reading both. 100 years at 85 C was never plausible. Always take the latest
revision; Nuvoton silently fixes these tables.

**Endurance is 20,000 cycles, not 100,000**, wherever it is stated. Lower than most MCU
flash, and worth knowing when `core/src/budget.ts` reasons about device flash wear.

**Two negatives worth recording as findings.** Both searched for and not found:

- **No minimum pin VDD for erase or program is specified anywhere.** The `VDD` column in
  these tables is `1.62 / 1.8 / 1.98 V`, footnoted "VDD is source from chip LDO output
  voltage": it is the macro's own supply off the internal regulator, not the pin. No
  NuMicro datasheet states a pin-VDD floor for flash writes distinct from the part's
  operating range. The protection against a sagging rail is the brown-out interlock in
  section 5, not a documented voltage floor, and on this unit that interlock is disabled by
  the `CONFIG0` fuse.
- **No maximum HCLK or ISP clock constraint for page erase or 32-bit program is specified
  anywhere.** The single clock constraint found in any family attaches to M031's
  **multi-word** program, which is neither page erase nor the 32-bit program our tooling
  uses. `FATCON`/`FATCTL` is **read-path** timing, `FOM` optimising flash *access* cycles
  by frequency; nothing in any document ties it to erase correctness or makes it an erase
  precondition.

**Neither Panchip document has a flash characteristics table either.** Not the datasheet,
and not the 373-page user manual, which stops at the peripherals and has no
electrical-characteristics chapter. So for this part specifically there is no page erase
time, program time, endurance or retention figure published anywhere, and "we looked and it
is not specified" is the honest and useful answer.

**Dead ends, so nobody repeats them.** `DS_NUC131_Series_EN_Rev1.00.pdf` and
`DA00-NUC140ENF1.pdf` are **scanned images with no text layer**: `pdftotext` returns
nothing and they cannot be searched without OCR. `DA00-NUC140ENF1.pdf` is 23 MB. Skip both.

## 5. `ISPFF`: exactly what sets it, and it does not block the next operation

Three wordings exist upstream and the list grows with the generation. All *verified*.

**M051 (early, three conditions), TRM Rev 1.03 p.159:**

> This bit is set by hardware when a triggered ISP meets any of the following conditions:
> (1) APROM writes to itself if APUEN is set to 0. (2) LDROM writes to itself.
> (3) Destination address is illegal, such as over an available range.
> Note: Write 1 to clear this bit to 0.

**NUC100 (four),** TRM Rev 1.04: the same three plus *"(3) CONFIG is erased/programmed if
CFGUEN is set to 0"*.

**This part (nine),** from Panchip's own `PN102Series.h`, `ISPSTS[6]`, which is the
NUC121/NUC126 list verbatim:

    (1) APROM writes to itself if APUEN is set to 0.
    (2) LDROM writes to itself if LDUEN is set to 0.
    (3) CONFIG is erased/programmed if CFGUEN is set to 0.
    (4) SPROM is erased/programmed if SPUEN is set to 0.
    (5) SPROM is programmed at SPROM secured mode.
    (6) Page Erase command at LOCK mode with ICE connection.
    (7) Erase or Program command at brown-out detected.
    (8) Destination address is illegal, such as over an available range.
    (9) Invalid ISP commands.

The `ISPCTL[6]` copy in the same header omits (6) and (7) and renumbers, so the two lists in
one file disagree; the `ISPSTS` one is the longer and is the one to trust.

**Answering the four sub-questions the brief asked:**

- **Region not enabled** by `APUEN`/`LDUEN`/`CFGUEN`/`SPUEN`: yes, sets `ISPFF`, and the
  operation does not run. This is the mechanism the repair script relies on.
- **Address out of range**: yes, condition (8).
- **Illegal command**: yes, condition (9). `ISPCMD` is a 7-bit field on this part and the
  header says *"The other commands are invalid"* after listing nine.
- **Alignment: not listed as an `ISPFF` condition on any family.** The manuals make it a
  requirement, never a fault: *"ISPADR[1:0] must be kept 00'b for ISP operation"* (M051
  p.161), *"It must be 512 bytes page alignment"* (M051 Table 6-9), and M480 and M2351 say
  outright that the low bits are **ignored** (`FMC_ISPADDR[11:0] will be ignored`). That is
  the paper behind `research/fmc-erase-program.md` section 7.6: a misaligned erase silently
  takes the containing page and reports success.

**Write-1-to-clear, on every family**, and on this part it can be cleared through either
`ISPCTL[6]` or the `ISPSTS[6]` mirror.

**A set `ISPFF` does *not* block further ISP operations.** M051 TRM Rev 1.03 p.154:

> Several error conditions are checked after ISP register function is completed. If an
> error condition occurs, ISP register operation is not started and the ISP fail flag will
> be set instead. ISPFF flag can only be cleared by software. **The next ISP register
> control procedure can be started even ISPFF bit is kept as 1.** Therefore, it is
> recommended to check the ISPFF bit and clear it after each ISP register operation.

The NUC121-generation manual drops that sentence but adds no contrary one. **Consequence
for the write script: `ISPFF` must be checked and cleared after every single operation,
because a stale 1 from operation *n* is indistinguishable from a fresh failure at *n+1*.**
Checking only at the end tells you that something failed, not what.

### The hardware cannot tell you a program did not take

**This is the most important sentence in this file for anyone writing flash on this part.**
On a NUC100-class FMC there is **no mechanism by which the silicon reports a program or
erase that silently failed to stick**:

| Mechanism | NUC100, M051, Mini51, NUC029, NUC123 | M031, M2351, M480 |
| --- | --- | --- |
| Program-fail / verify flag (`PGFF` or similar) | **absent.** Zero hits across all five; `ISPSTA[5]` is Reserved | present |
| Blank-check command | **absent** | present (`0x08` read-all-one, `0x28` run-all-one) |
| Busy flag distinct from `ISPGO` | **absent** | present |
| FMC interrupt | **absent** | present |
| Brown-out interlock on erase/program | **absent** | present |

**So read-back verification is not belt-and-braces on this silicon. It is the only
detection mechanism there is.** A command that "returned" tells you nothing at all:
`ISPGO` clearing means the engine finished its cycle, not that the cells changed. This is
the reason the read-back in `swdflash` must never be weakened or made optional to save
wire time, and the reason a bare "no `ISPFF`, done" is not a success criterion.

**The vendor's own BSP is inconsistent about exactly this**, which is worth knowing before
copying it. *verified* in Panchip's `fmc.c`: `FMC_Erase()` polls, checks `ISPFF`, clears it
and returns `-1` on failure; **`FMC_Write()` is declared `void`**, polls `ISPGO` and then
simply returns, checking nothing. Anyone trusting a BSP return code on a write is trusting
a value that does not exist.

### `ISPFF` is a pre-flight refusal, which bounds the risk window

NUC100 Rev 1.04 p.188 and M051 Rev 1.03 p.154 both say it plainly: *"If an error condition
occurs, **ISP operation is not started** and the ISP fail flag will be set instead."*

**A refused command never begins, so it cannot leave a partial write.** That matters for
sizing the actual exposure. The window in which an interruption can corrupt anything is only
the period **after a successful trigger**, which is roughly **20 us for a word program and
20 ms for a page erase**. That is a far smaller and better-characterised exposure than
"something might go wrong during the write".

**Why the older manuals carry no brown-out warning.** The `ISPFF` condition *"Erase or
Program command at brown-out detected"* is present on NUC123, M031, M2351 and M480 and
**absent on NUC100, M051, Mini51 and NUC029**. On the parts that have the interlock the
hardware refuses to start; on the parts that do not, nobody wrote the sentence. **Ours is
the second kind**, notwithstanding that this part's `ISPSTS` list does carry the condition,
which is one of the internal inconsistencies catalogued in section 5.

### There is no low-voltage inhibit on flash writes, and what protects you instead

**Nothing in the FMC stops you writing flash at a marginal supply.** No pin-VDD floor is
specified for erase or program in any Cortex-M NuMicro document, none of the `ISPFF` causes
is voltage related (all are permission or address related), and Nuvoton's only documented
mechanism for inhibiting IAP at low voltage is the **8051 line's `BOIAP` bit, which has no
Cortex-M equivalent**. On this silicon brown-out *detection* is off by default anyway:
`CONFIG0[23]` reads 1 on both our units and the field is active-low.

**What does exist is LVR, and it is the reason the failure is loud rather than silent.**
Low-voltage reset is **enabled by default and has no fuse behind it**: NUC100 Rev 1.04 p.77,
*"LVR function is enabled by default"*, with `BODCR` resetting to `0x0000_008X` and bit 7
`LVR_EN` set. So a sag deep enough to matter **resets the part** rather than quietly
corrupting the array, and a reset mid-write is loud: the SWD port drops and the operator
watches the session die.

**So the realistic failure is page-granular corruption of the in-flight page, plus a lost
session.** Not silent damage to the whole window. Nuvoton's own **AN0025** models an
interrupted flash write exactly that way. *verified*, PDF fetched and read directly,
Rev 1.00, section 3.1:

> A swap continue process is provided to prevent the swap process from being incomplete due
> to unexpected conditions such as **power off, randomly reset, and system crash** ... The
> swap continue process will analyze the corrupted condition to **find the corrupted page
> and continue to complete the swap process**.

Per-page CRC locates the damage, the process resumes from that page, and **there is no
de-brick step anywhere in the document**. It is an M2351 note, so Cortex-M23 rather than
M0, and it is a recovery *design* rather than a statement about what the cells do. It is
still the closest thing Nuvoton has published to an answer.

**The operational consequence, and it deserves to be singled out rather than listed among
precautions.** A charged battery, and never powering the board from the probe, is not
general hygiene here: **it is the only protection there is.** Not because a brown-out would
go undetected, but because nothing prevents you reaching one, and if you do you lose the
page that was in flight and the session with it.

**The brown-out interlock, condition (7), is a real safety feature and it is off here.**
The FMC refuses to start an erase or program while the BOD is asserting. Nuvoton's own FAQ
"How to erase/write Flash data in the BoD interrupt function?" answers *"disable the BOD
function and clear BODOUT. After the erase/write is complete, the user can enable the BOD
function again"*, which only makes sense if an asserted BOD blocks the operation. Track 55
found `CONFIG0` bit 23 = 1 on these units, i.e. **BOD disabled**, so the interlock never
fires and the only protection against a sagging rail is a charged battery.

## 6. Register write protection: the exact list

Panchip's own header, `SYS_T.REGLCTL` at offset `0x100`, lists the protected registers for
**this part** (*verified*):

| Register | Address | Note |
| --- | --- | --- |
| `SYS_IPRST0` | `0x5000_0008` | peripheral reset control |
| `SYS_BODCTL` | `0x5000_0018` | brown-out detector |
| `CLK_PWRCTL` | `0x5000_0200` | bit 6 unprotected |
| `CLK_APBCLK` bit 0 | `0x5000_0208` | watchdog clock enable |
| `CLK_CLKSEL0` | `0x5000_0210` | HCLK and STCLK source |
| `CLK_CLKSEL1` bits 1:0 | `0x5000_0214` | watchdog clock source |
| `NMI_SEL` bit 8 | `0x5000_0380` | NMI enable |
| **`ISPCON`** | **`0x5000_C000`** | flash ISP control |
| **`ISPTRG`** | **`0x5000_C010`** | ISP trigger |
| `WTCR` | `0x4000_4000` | watchdog control |

**`ISPCMD` (`+0x0C`), `ISPADR` (`+0x04`) and `ISPDAT` (`+0x08`) are not protected.** Only
the two FMC registers above are, which is exactly why the unlock has to be held (or
re-taken) across the trigger and not merely across the setup. Nuvoton's M051 list is the
same plus `PORCR 0x5000_0024` and `FATCON 0x5000_C018`; NUC100's is the same again but
expressed bit by bit, and it additionally names `ISPSTA[6]` and every `DBGACK_TMR`.

**The unlock sequence,** M051 TRM Rev 1.03 p.62, *verified*:

> The register protection disable sequence is writing the data "59h", "16h" "88h" to the
> register REGWRPROT address at 0x5000_0100 continuously. **Any different data value,
> different sequence or any other write to other address during these three data writing
> will abort the whole sequence.**
> After the protection is disabled, user can check the protection disable bit at address
> 0x5000_0100 bit0, "1" is protection disable, "0" is protection enable. Then user can
> update the target protected register value and then **write any data to the address
> "0x5000_0100" to enable register protection.**

So: the register is write-only for the key and read-only for `REGPROTDIS` at bit 0; reading
1 means unlocked; **any fourth write of any value re-locks it**; a reset re-locks it; and an
intervening write to any other address aborts the sequence. That last clause is why
OpenOCD's `numicro_reg_unlock` issues the three writes back to back with nothing between,
and why the vendor firmware retries the whole triple rather than the last write.

**A lapsed unlock is a silent no-op, not a refusal, and that is a real trap.** `ISPCON`,
`ISPTRG` and `ISPSTS` are behind the lock; **`ISPCMD` and `ISPADR` never are.** So with the
lock slipped you can stage a command and an address perfectly happily, write `ISPTRG`, have
that write **ignored**, and see no error: `ISPGO` never sets, nothing runs, and `ISPFF`
stays clear because no ISP operation was ever triggered. Our script catches it at the
read-back. Anyone hand-poking registers would not, and would conclude the erase succeeded.

**The lock register moved on the later parts.** It is `0x5000_0100` here, *verified*, and
`0x4000_0100` on M480 and M2351. A hardcoded `0x50000100` copied from a newer example, or
into one, silently no-ops rather than failing.

`research/fmc-erase-program.md` derives that retry from the disassembly. The vendor's C
source says the same thing outright, `sys.h`, *verified*:

    __STATIC_INLINE void SYS_UnlockReg(void)
    {
        do {
            SYS->REGLCTL = 0x59;
            SYS->REGLCTL = 0x16;
            SYS->REGLCTL = 0x88;
        } while (SYS->REGLCTL == 0);
    }

    __STATIC_INLINE void SYS_LockReg(void) { SYS->REGLCTL = 0; }

A `do`/`while`, not an `if`: the vendor expects the sequence to fail sometimes and simply
repeats the whole triple. Worth copying rather than asserting once.

## 7. The CPU stall during ISP, which is the mechanism behind the AHB hang

Two manuals, two levels of precision, both *verified*.

**M051 TRM Rev 1.03 p.154, the loose version:**

> When the ISPGO bit is set, CPU will wait for ISP operation to finish during this period;
> the peripheral still keeps working as usual. If any interrupt request occurs, CPU will
> not service it till ISP operation is finished.

**NUC121/125 TRM Rev 1.04 p.218, the precise version:**

> When the ISPGO(FMC_ISPTRG[0]) bit is set, FMC start to process ISP command, **CPU will be
> halt to wait ISP done if CPU trying to access flash memory.** For example, if any
> interrupt request occurs, CPU will not service it till ISP operation is finished. User
> could move their code and exception handlers to SRAM to avoid this situation. **The
> peripheral still keeps working as usual** when ISP processing.

The conditional clause is the whole answer:

- **Reading FMC registers while `ISPGO` is set is safe.** They are on the peripheral bus,
  not the flash array, and every NuMicro flash driver ever written polls `ISPTRG` in a tight
  loop. So does the vendor's own `FMC_Erase`. So does ours.
- **Reading flash while `ISPGO` is set stalls the transfer** until the operation completes,
  because the stall is on the flash AHB slave. That is the documented mechanism behind the
  session abort `research/hardware-access.md` already records. *derived* for this part,
  since the precise quote is NUC121's.
- Neither manual says the debugger's own accesses are treated differently from the CPU's.

The NUC100/120 manual states the stall and the interrupt deferral together, Rev 1.03 p.186.
**For an SWD-driven session the consequence is the whole design of the poll loop:** polling
an FMC *register* is safe, reading *flash* during an operation is not. That is exactly why
the repair script polls `ISPTRG` rather than reading the target address back mid-operation,
and exactly the abort an earlier draft of that script hit. Recorded here so that nobody
later "optimises" the poll into a read-back.
  Assume they are not.

The same paragraph is the origin of the `__ISB()` that every Nuvoton BSP puts after setting
`ISPGO`: *"ISB (Instruction Synchronization Barrier) instruction is used right after ISPGO
setting"*. It is a CPU pipeline concern for code running on the part and has no analogue in
a debugger-driven poke loop.

## 8. The watchdog

- **Disabled out of reset.** `WTCR` / `WDT_CTL` resets to **`0x0000_0700`** on both NUC100
  (TRM Rev 1.04) and M051 (Rev 1.03 p.269): `WTE`/`WDTEN` bit 7 clear, `WTIS`/`TOUTSEL`
  = 111 (the longest interval), `DBGACK_WDT` bit 31 clear. *verified*.
- **The clock gate default is fuse-dependent.** `APBCLK`'s reset value is printed as
  `0x0000_000X` in both manuals, bit 0 being the watchdog clock enable, because the fuse
  decides it.
- **The fuse can force it on and lock it there.** Panchip's header, `WDT_CTL[7] WDTEN`:
  *"If CWDTEN[2:0] (combined by Config0[31] and Config0[4:3]) bits is not configure to 111,
  this bit is forced as 1 and user cannot change this bit to 0."* NUC121's manual adds that
  in that case the clock source is forced to LIRC and *"LIRC can't be disabled"*.
- **This unit's fuse does not arm it.** `CONFIG0 = 0xFFFFFFBF` gives bit 31 = 1 and bits
  4:3 = 11, so `CWDTEN[2:0] = 111`, *"WDT hardware enable function is inactive"*. Same for
  `0xFFFFFFFF` and `0xFFFFFF3F`. *derived*: the decode is certain, the field positions are
  from the NUC121 manual and Panchip's header, and nobody has read `WDT_CTL` on this part.
- **It freezes while halted, by default.** `DBGACK_WDT` (Nuvoton) / `ICEDEBUG` (Panchip),
  bit 31, resets to 0 and 0 means *"ICE debug mode acknowledgement affects WDT counting. WDT
  up counter will be held while CPU is held by ICE."* 1 means it keeps going. *verified*
  wording, on three TRMs and Panchip's header.

**On this part the watchdog is clocked from HCLK, not from LIRC**, which is the opposite of
the Nuvoton default and changes what its period means. *verified* from the vendor SDK:
`WDT_Init()` calls `CLK_SetModuleClock(WDT_MODULE, CLK_CLKSEL1_WDTSEL_HCLK_DIV2048)`, and
`WDT_Start()` carries the arithmetic in a comment,
`//watch dog reset time 2^14/(16M/2048). 2.097s`. So the 2.097 s that
`research/fmc-erase-program.md` quotes holds **only at HCLK = 16 MHz**, and the vendor's
own comment is where that number comes from. Two consequences. Changing HCLK changes the
watchdog period proportionally. And neither of the obvious intuitions about halting is the
reason it is safe: HCLK keeps running while the core is halted, so the watchdog does not
stop because its clock stopped, and it is not on LIRC either. **`ICEDEBUG` is the only
reason it freezes.**

The 16 MHz the comment assumes is the same 16 MHz `research/hardware-access.md` settles for
the external crystal, so if HCLK runs off HXT undivided the 2.097 s is exact rather than
indicative. Nobody has read `CLKSEL0` on this part to confirm that it does.

*A trap in the vendor SDK, noted in passing.* `clk.h` defines
`CLK_CLKSEL1_WDTSEL_HCLK_DIV2048` as `0x0` and `CLK_CLKSEL1_WDTSEL_LIRC` as `0x1`, but
`PN102Series.h` documents `CLKSEL1[1:0]` as `00 = HXT or LXT`, `10 = HCLK/2048`,
`11 = LIRC`. The two disagree. Anyone selecting a watchdog clock from the driver constants
should read the register back rather than trust them.

Net: `research/fmc-erase-program.md` is right that halting is enough. Two independent
reasons now, not one: the fuse is not arming a watchdog at reset, and the application's
own armed watchdog freezes on halt. The residual case is a target that **resets** mid-run
and starts executing the application, which arms it; that is the DHCSR check track 55
handed to track 54, and it matters more than the watchdog itself.

`WTCR` is `REGLCTL`-protected, so a halted-core script cannot disarm a watchdog without
holding the unlock, and the unlock is exactly what the ISP session already holds.

## 9. `CONFIG0`

**`CBS[7:6]`, the four encodings**, identical text in every two-bit family (*verified*):

| `CBS` | Boots |
| --- | --- |
| `00` | LDROM with IAP mode |
| `01` | LDROM without IAP mode |
| `10` | APROM with IAP mode |
| `11` | APROM without IAP mode |

*"When CBS[0] = 0, the LDROM base address is mapping to 0x100000 and APROM base address is
mapping to 0x0. User could access both APROM and LDROM without boot switching."* `BS`
(`ISPCON[1]`) only controls boot switching when `CBS[0] = 1`; `VECMAP` only remaps
`0x0`-`0x1ff` when `CBS[0] = 0`. The 2010 NUC100 manual is the exception, where `CBS` is a
single bit 7 with no IAP concept at all; do not quote it for this part.

The three values this project has seen, decoded against that table:

| `CONFIG0` | `CBS` | Boot | `LOCK` | `DFEN` | `CWDTEN` |
| --- | --- | --- | --- | --- | --- |
| `0xFFFFFFFF` (erased, unit 1 now) | `11` | APROM without IAP | 1, unlocked | 1, disabled | 111, inactive |
| `0xFFFFFFBF` (healthy 12E69E) | `10` | **APROM with IAP** | 1, unlocked | 1, disabled | 111, inactive |
| `0xFFFFFF3F` (**what the application writes on the commit path**, *corrected 2026-08-20*: this row said "the wrong prediction", and it is in fact exactly the value the vendor's own application programs to hand over to the bootloader, already documented that way in `firmware-flashing.md`, `brick-2026-08-08.md` and `ldrom-2026-08-19.md`) | `00` | LDROM with IAP | 1, unlocked | 1, disabled | 111, inactive |

This is arithmetic on the field table, and it agrees with `research/brick-2026-08-08.md`
independently.

**`LOCK`, bit 1, and the one clause that matters.** `0 = locked`, `1 = not locked`, so an
erased `CONFIG0` is unlocked. NUC100 Rev 1.04 and AN0001 Rev 1.00 Table 2-1:

> When flash data is locked, only device ID, Config0 and Config1 can be read by writer and
> ICP through serial debug interface. Others data is locked as 0xFFFFFFFF. **ISP can read
> data anywhere regardless of LOCK bit value.** User need to erase whole chip by ICP/Writer
> tool **or erase user configuration by ISP** to unlock.

M051's wording substitutes "unique ID" for "Config0 and Config1" and offers *"use ISP
command to disable LOCK bit or erase whole chip (Chip Erase) by ICP tool"*.

The italicised clause is the upstream evidence behind
`research/fmc-erase-program.md` section 7.7: the lock filters the debugger's *direct* flash
reads and does not filter `ISPCMD 0x00`. One nuance to add there. The late-generation
`ISPFF` list gates a command on the lock explicitly, *"(6) Page Erase command at LOCK mode
with ICE connection"*, so the designers did consider ICE-plus-ISP; **reads are not in that
list**, which is the reason to expect an ISP read to still work on this generation rather
than only on M051's. *unverified* either way, and one cheap test settles it on any locked
unit: read `0x0` with `mdw` and with `ISPCMD 0x00` and compare.

**A register manual for this part exists after all, and it thins the CONFIG0 story.**
*PAN1020 User Manual v1.8, Jun 2022, 373 pages*, with a real FMC chapter at section 4.3,
pp.73-94. It is on Panchip's own forum rather than anywhere indexed, which is why the repo
had concluded no such document existed. **Its `CONFIG0` table documents only three fields**
and marks **`[31:8]` Reserved**, *verified* by reading the extracted text:

| Bit | Field | Manual's wording |
| --- | --- | --- |
| `[31:8]` | Reserved | Reserved |
| `[7:6]` | `CBS` | the standard four encodings, `00` LDROM+IAP through `11` APROM no IAP |
| `[5:2]` | Reserved | Reserved |
| `[1]` | `LOCK` | "0 = Flash memory content is locked. 1 = Flash memory content is locked except ALOCK (CONFIG2[7:0]) is 0x5A." |
| `[0]` | `DFEN` | "0 = Data Flash Enabled. 1 = Data Flash Disabled." |

Three things follow, and the first is a caution about this file.

- **The upper bits are undocumented for this part, not absent.** The same manual's prose
  cites "CBOVEXT (CONFIG0[23]), CBOV (CONFIG0[22:21]) and CBORST (CONFIG0[20])" in the
  system-manager chapter and "(CONFIG0[31:26])" in the clock chapter. The register table
  was evidently trimmed while the prose kept the Nuvoton inheritance. **So the field table
  below is *derived*, from Nuvoton's manuals plus this part's own cross-references, and it
  is not corroborated by this part's `CONFIG0` table.** Treat the positions as good working
  assumptions, not as documented facts, and do not write a `CONFIG0` value that depends on
  one without reading it back.
- **`LOCK` has a second latch on this part: `ALOCK` in `CONFIG2[7:0]`, which must be
  `0x5A`.** The manual's sentence is garbled, the second "locked" plainly meaning
  *unlocked*, and it matches Mini58 and M480 where the same mechanism is worded correctly.
  The manual also notes that "ALOCK will be programmed as 0x5A after executing page erase
  or whole chip erase", so an erase restores the unlocked state by itself. **Our units read
  `CONFIG2 = 0`**, which is not `0x5A`, and nobody has worked out what that means for a
  part whose `CONFIG0` `LOCK` bit is set. Worth an hour before anyone concludes anything
  about lock state from `CONFIG0` alone.
- **`0x23` is confirmed verbatim as "FLASH whole chip Erase (ROM mode)"**, listed in the
  `FMC_ISPCMD` field description but deliberately omitted from the manual's user-mode ISP
  command table. The vendor header's "Rom use only!!" is accurate.

The manual also confirms, first-hand, the two internal inconsistencies this file records
from the CMSIS header: `ISPCTL[6]` lists **seven** `ISPFF` conditions and `ISPSTS[6]` lists
**nine**, the two extra being the LOCK-mode page erase and the brown-out condition; and
`VECMAP` is `[23:9]` in the manual against `[20:9]` in the header.

*Provenance: the PDF was fetched by a parallel search, not by me; the quotations above are
mine, read directly out of the extracted text. The file is not committed, in line with the
repo's rule on vendor material.*

**The rest of the field, *derived* from the NUC121 and M051 tables by position and
corroborated only by this part's prose cross-references:**

| Bit | Field | Meaning, with the polarity |
| --- | --- | --- |
| 31, 4:3 | `CWDTEN[2:0]` | `111` = hardware watchdog enable inactive |
| 23 | `CBODEN` | **0 enables** brown-out detect, 1 disables |
| 22:21 | `CBOV` | threshold. On this part: `2.15 / 2.40 / 2.67 / 3.03 V` per Panchip's `BODCTL` |
| 20 | `CBORST` | **0 enables** brown-out reset, 1 disables |
| 19 | `PDLVR` | 0 enables low-voltage reset (Panchip-specific naming) |
| 10 | `CIOINI` | GPIO reset state. **Polarity is inverted between families**, so do not port it |
| 1 | `LOCK` | 0 = locked |
| 0 | `DFEN` | **0 = Data Flash enabled**, 1 = disabled |

Note the polarity throughout: **0 enables**. An erased `0xFFFFFFFF` means BOD off, BOD reset
off, watchdog off, data flash off, unlocked. That is why an erased config page is the safe
state and why track 55's "erase cannot set a bit to 0" argument holds.

**`CONFIG` is page-erased like anything else.** Nuvoton's M451 BSP docblock on
`FMC_WriteConfig()`: *"User must enable User Configuration update before writing it. User
must erase User Configuration before writing it. **User Configuration is also be page
erase.** User needs to backup necessary data before erase User Configuration."* Combined
with `CFGUEN`, that is exactly the sequence `research/tools/fmc-repair-config.sh` already
runs.

## 10. Program without erase: no

**No Nuvoton manual states the rule in a sentence**, which is why it is worth writing down.
The evidence is three-fold and consistent, all *derived*:

- **The erase-unit paragraph implies it.** M051 TRM Rev 1.03 p.147: *"The erase unit is 512
  bytes. **When a word will be changed, all 128 words need to be copied to another page or
  SRAM in advance.**"* If a programmed word could be reprogrammed, that sentence would not
  need to exist.
- **The BSP says it.** `FMC_WriteConfig()`'s docblock, quoted above: "must erase before
  writing it".
- **AN0002, Nuvoton's own EEPROM emulation note, is built entirely on never doing it.**
  Rev 1.00: every store appends a fresh `(address, value)` record into the next *erased*
  slot of a page, `0xFF` is the "invalid/free" marker, and when the page fills, the live
  records are copied to a new page and the old one is erased. Nothing is ever overwritten
  in place. That is the design you produce when rewrite-without-erase is unavailable.

Flash is one-way: program drives bits from 1 to 0 and only erase returns them to 1. So
**writing `0xFFFFFFFF` to a programmed word is a no-op, not a repair and not damage**: it
requests no bit changes. It also does not clear the word. *derived* from the physics and
consistent with everything above; no Nuvoton document says it in words.

## Unverified

- **Whether an interrupted erase or program can permanently damage this flash.** The
  negative needs stating precisely, because the flat version is wrong in two directions.
  **Nuvoton never describes an *externally* interrupted erase or program**: no TRM,
  datasheet, app note or tool manual says what a half-erased page reads as, or warns
  against resetting while `ISPGO` is set. The scope of that search is what makes it
  credible: roughly 7,300 pages across eight TRMs including M480 Rev 3.01 and M2351,
  for "power off", "power fail", "power loss", "unexpected reset", "during erase",
  "during program", "interrupted", "corrupt" and "damage", with the only FMC-chapter hit
  being the register-unlock sentence.
  **But Nuvoton does describe one mid-flight abort, and treats it as ordinarily
  resumable.** In multi-word programming the controller exits cleanly if the CPU cannot
  feed it in time, exposes the last address written in `FMC_MPADDR`, and the documented
  recovery is to "restart a new procedure to continue": no re-erase, no damage
  (M480 TRM Rev 3.01 p.700, near-identical at M031 Rev 2.02 p.349). *Second-hand: relayed
  from a parallel search, not read by me.*
  **And AN0025 models an interrupted write as page-granular and recoverable**, which is
  first-hand, see below. So the honest form is not "Nuvoton is silent on interruption" but
  "Nuvoton never describes an externally interrupted operation, and every internally
  aborted or power-interrupted case it does describe is treated as resumable by rewriting,
  with no de-brick step anywhere". Note that the familiar "just re-erase the page" phrasing
  is **Infineon and NXP wording, not Nuvoton's**; do not attribute it to them.
- **Whether this part's flash macro is the 2 ms kind or the 20 ms kind.** Section 4 argues
  for 20 ms and explains why, but it is an inference from which datasheets are
  under-characterised, not a measurement. One timed erase settles it. **It no longer
  matters operationally**: 150 erases at 20 ms is 3 s against 5 to 12 minutes of wire time,
  and the `wait_trg` ceiling is 2 s, a hundred times a 20 ms erase. Capture the number when
  the first erase runs, but nothing waits on it.
- **Whether `ISPCMD 0x00` can read a `LOCK`ed unit on this part.** Section 9.
- **Whether `0x5000c01c` does anything here.** OpenOCD writes 1 to it; Nuvoton's own fork
  skips it for SPROM parts, and this is one.
- **Whether a debugger's AHB read is stalled the same way the CPU's is.** Section 7 assumes
  it is, which matches the one observation we have, but no manual distinguishes them.

## Sources

Register maps, `ISPFF`, `REGWRPROT`, `CONFIG0`, CPU stall:

- [M051 BN/DN/DE TRM Rev 1.03](https://www.nuvoton.com/resource-files/TRM_M051\(BN_DN_DE\)_Series_EN_Rev1.03.pdf)
  pp.62-63 protected registers, p.147 erase unit, p.154 ISP flow and the ISPFF sentence,
  pp.149-150 `CONFIG0`, p.159 `ISPCON`, p.161 `ISPADR`, p.269 `WTCR`
- [NUC100/120xxxDN TRM Rev 1.04](https://www.nuvoton.com/export/resource-files/TRM_NUC100_120\(DN\)_Series_EN_V1.04.pdf)
  p.64 protected registers, p.111 `PDID`, pp.183-185 `CONFIG0`/`CONFIG1`,
  p.189 `ISPCON`
- [NUC121/125 TRM Rev 1.04](https://www.nuvoton.com/export/resource-files/TRM_NUC121_125_Series_EN_Rev1.04.pdf)
  p.218 the precise CPU-stall paragraph, pp.206-208 `CONFIG0`, the nine-condition `ISPFF`

Timing:

- [NUC100/120xxxDN datasheet Rev 1.04](https://www.nuvoton.com/export/resource-files/DS_NUC100_120\(DN\)_Series_EN_V1.04.pdf) section 8.5
- [M051 DN/DE datasheet Rev 1.03](https://www.nuvoton.com/resource-files/DS_M051\(DN_DE\)_Series_EN_Rev1.03.pdf) section 9.5
- [NUC123 datasheet Rev 2.04](https://www.nuvoton.com/resource-files/DS_NUC123_Series_EN_Rev2.04.pdf) sections 7.5 and 8.5
- [M0518 datasheet Rev 1.02](https://www.nuvoton.com/resource-files/DS_M0518_Series_EN_Rev1.02.pdf) section 8.5.
  Rev 1.01 at the same URL pattern is superseded and its retention figure is wrong

Application notes:

- [AN0001, NuMicro Cortex-M Code Protection Rev 1.00](https://www.nuvoton.com/export/resource-files/AN0001_NuMicro_Cortex-M_Code_Protection_EN_V1.00.pdf) the `LOCK` table and the ICP unlock flow
- [AN0002, Using DataFlash to Emulate EEPROM Rev 1.00](https://www.nuvoton.com/resource-files/AN_0002_Using_DataFlash_to_Emulate_EEPROM_EN_Rev1.00.pdf) the append-only design
- [AN0025, M2351 Dual Bank Firmware Upgrade Mechanism Rev 1.00](https://www.nuvoton.com/export/resource-files/AN_0025_M2351_DualBank_Firmware_Upgrade_Mechanism_EN_Rev1.00.pdf)
  sections 3.1 and 3.4.2, the swap-continue recovery from power off mid-write. **M2351,
  Cortex-M23, not M0.** Fetched and read directly
- [Nuvoton FAQ, erase/write flash in the BOD interrupt](https://forum.nuvoton.com/en/mcu-nudeveloper-ecosystem/faq/181),
  and the same text restated at [FAQ 13510](https://forum.nuvoton.com/en/numicro-cortex-m4-mcu/faq/13510)

Code:

- [OpenOCD `src/flash/nor/numicro.c`](https://raw.githubusercontent.com/openocd-org/openocd/master/src/flash/nor/numicro.c)
  and [`contrib/loaders/flash/numicro/numicro_m0.S`](https://raw.githubusercontent.com/openocd-org/openocd/master/contrib/loaders/flash/numicro/numicro_m0.S)
- [`OpenNuvoton/OpenOCD-Nuvoton` `numicro.c`](https://raw.githubusercontent.com/OpenNuvoton/OpenOCD-Nuvoton/master/src/flash/nor/numicro.c), the per-part page-size table
- OpenNuvoton BSP `Library/StdDriver/inc/fmc.h` for M051, NUC100, Mini51, Mini58, NUC121,
  NUC123, NUC126, NUC131, NUC1262, NUC029x{AN,DE,EE,GE}, M0518, M031, M451, M480,
  NUC472_442, M2351, Nano100B: the `FMC_FLASH_PAGE_SIZE` and `FMC_ISPCMD_*` tables
- **PAN1020 User Manual v1.8, Jun 2022**, 373 pp, FMC chapter section 4.3 pp.73-94.
  Panchip's own forum, [thread 7480](http://bbs.panchip.com/forum.php?mod=viewthread&tid=7480),
  guest download, no login. **Vendor document, not committed here.** The 2019 v1.4
  *datasheet* is a different and far less useful document with no register map at all
- Panchip SDK, `PN102Series.h` (declares itself `PN020.h`), `driver/inc/fmc.h`,
  `driver/src/fmc.c`, mirrored in the wild at `hao0527/BLE_APP`. **Vendor source, not
  committed here**, in line with the repo's rule on vendor binaries

## Reproducing this

Nothing here needs hardware or the repo. Fetch the PDFs above, `pdftotext -layout` them and
grep; fetch the two `numicro.c` files and the BSP headers with `curl`. The Panchip header
needs `LC_ALL=C tr '\r' '\n'` first: it is CR-only and `grep` treats it as binary.
