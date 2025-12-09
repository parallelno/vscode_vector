# Intel 8080 Assembler + Debugger (Minimal)

This repository contains a VS Code extension with key features: a two-pass Intel 8080 assembler, a tiny Vector 06c emulator, and a debugger, along with quality of life VS Code functionality to improve the Vector 06c development process.

## Table of Contents

- [Quick start](#quick-start)
- [Test Suites](#test-suites)
  - [Assembler directive tests](#1-assembler-directive-tests)
  - [Emulator tests](#2-emulator-tests)
- [How to assemble and run](#how-to-assemble-and-run)
- [VS Code editor helpers](#vs-code-editor-helpers)
- [Emulator panel controls](#emulator-panel-controls)
- [Symbol hover hints while paused](#symbol-hover-hints-while-paused)
- [Memory Dump panel](#memory-dump-panel)
- [Assembler](#assembler)
- [Tools](#tools)
- [Implementation notes](#implementation-notes)

## Quick start

1. Install dependencies:

```pwsh
npm install
```

2. Build the tools (produces `out/`):

```pwsh
npm run compile
```

3. Build and test:

```pwsh
npm run test
```

## Test Suites

### 1. Assembler directive tests

```pwsh
npm run test-directives
```

The command recompiles the TypeScript sources and executes every test case under `test/assembler/directives`, reporting a PASS/FAIL line for each directive scenario plus a summary total. The process exits with a non-zero status when a failure is detected, so it can plug directly into CI.
Current coverage includes `.org`, `.align` (success + failure paths), `.if`/`.endif`, `.loop`/`.endloop` (standalone and inside macros), `.include` (flat + nested + missing-file errors), `.print`, `DS`, literal/binary/hex formats with expression evaluation, and both macro-bodied plus standalone local-label resolution. Add more fixture `.asm` files under `test/assembler/directives` and register them in `src/tools/run_directive_tests.ts` to grow the matrix.

### 2. Emulator tests

Run the i8080 CPU emulator test suite at any time:

```pwsh
npm run test-emulator
```

The command recompiles the TypeScript sources and executes all emulator test cases stored in `.test/emulator/`. The test runner:

- Assembles each `.asm` test file
- Loads the resulting ROM into the emulator
- Executes a specified number of instructions
- Validates CPU state (registers, flags) and memory against expected values
- Generates a comprehensive report grouped by test category

Current coverage includes:
- **Data Transfer**: MVI, MOV, LXI, LDA, STA, MOV M,r
- **Arithmetic**: ADD, SUB, INR, DCR, DAD, ADC, SBB, INX, DCX
- **Logical**: ANA, ORA, XRA, CMP, CMA
- **Rotate**: RLC, RRC
- **Control Flow**: JMP, JNZ, JZ, CALL, RET
- **Stack**: PUSH, POP
- **Flags**: STC, CMC

Add more test `.asm` files under `.test/emulator/` and register them in `src/tools/run_emulator_tests.ts` to expand the test matrix. Each test case specifies:
- Source file name
- Number of instructions to execute
- Expected register values, flag states, and/or memory contents

## How to assemble and run

- Compile TypeScript:

```pwsh
npm run compile
```

- Assemble `test.asm` into `test.rom` (and write a token file `test.json` with labels):

```pwsh
node .\scripts\run-assembler.js
```

- Compile the active `test/project/*.project.json` configuration from VS Code via the **"Compile i8080 Project"** command. The command locates the project JSON inside `test/project`, reads its `main` ASM entry, and assembles it using the same pipeline as the standard `Compile i8080 Assembly` command.
- Project builds emit `<project-name>.rom` (and the matching `<project-name>.debug.json` tokens file) beside the `.project.json`, so the name field controls the output artifact names.
- Adding or removing a breakpoint inside any `.asm` file automatically reruns the project compile so the ROM and breakpoint metadata stay in sync.

- Run the external emulator (example path shown for convenience):

```pwsh
C:\Work\Programming\devector\bin\devector.exe .\test.rom
```

## Project Configuration

You can configure your project using a `.project.json` file. This file defines the project name, main assembly file, output ROM name, and optional settings.

### Example `.project.json`

```json
{
    "name": "my_project",
    "main": "main.asm",
    "rom": "./out/game.rom",
    "fdd": "./out/game.fdd",
    "settings": {
        "speed": 1.5
    }
}
```
```json
{
    "name": "my_project",
    "main": "main.asm",
    "rom": "./out/game.rom",
    "fdd": "./out/game.fdd",
    "settings": {
        "speed": "max",
        "fddDataPath": "./out/game_saved.fdd"
    }
}
```

### Fields

- **name**: The name of the project.
- **main**: The main assembly file to compile.
- **rom**: The path to the output ROM file.
- **fdd**: (Optional) The path to the FDD disk image to run. The emulator runs prefers fdd over rom if present a valid path.
- **settings**: (Optional) Project-specific settings.

### Settings

- **speed**: Controls the initial emulation speed.
  - Values: `0.1`, `1`, `2`, `4`, `8`, or `"max"`.
  - Default: `1` (normal speed).
  - This setting is automatically updated when you change the speed in the emulator panel, persisting your preference across sessions.

- **fddDataPath**: (Optional) Path to save FDD disk data for persistence across emulator restarts.
  - When set, any writes to the FDD (floppy disk) during emulation are automatically saved to this file when the emulator closes.
  - On the next run, if this saved file exists, it will be loaded instead of the original FDD file specified in the `fdd` field.
  - Example: `"fddDataPath": "./out/saved_disk.fdd"`
  - If not set, FDD changes are lost on each emulator restart.
  - This allows you to preserve game saves, high scores, and other data written to the floppy disk.

- **ramDiskDataPath**: (Optional) Path to save RAM disk data for persistence across emulator restarts.
  - When set, RAM disk contents are automatically saved to this file when the emulator closes and loaded on startup.
  - Example: `"ramDiskDataPath": "./out/ramdisk.bin"`

## VS Code editor helpers

The bundled extension now exposes quality-of-life helpers whenever you edit `.asm` sources in VS Code:

- **Ctrl+click navigation for includes**: hold `Ctrl` (or `Cmd` on macOS) to underline the path in the ASM '.include' directive and click it to open the target file.

## Emulator panel controls

Launching the VS Code emulator panel loads the ROM and shows a compact toolbar on top of the frame preview. The buttons behave like classic debugger controls:

- **Run / Pause** toggles the hardware thread. While running it reads “Pause”; hitting it stops execution, captures the current frame, and switches back to “Run”.
- **Step Over** executes a single instruction after stopping the machine (currently a simple single-instruction step without temporary breakpoints).
- **Step Into** behaves like a classic single-instruction step, halting immediately after execution.
- **Step Out** is a placeholder single-step today (it stops, runs one instruction, and logs that proper step-out logic is TBD).
- **Step Frame** stops the emulator, runs one full frame with no breaks, and leaves execution paused for inspection.
- **Step 256** runs 256 single-instruction steps in succession so you can advance through short loops faster without resuming full speed.
- **Restart** stops the hardware, resets/restarts the ROM, reloads it into memory, and then resumes running.
- **Speed** dropdown allows you to control the emulation speed with the following options:
  - **0.1x** - Run at 1/10th normal speed (slow motion for debugging)
  - **1x** - Normal speed (default, 60 FPS)
  - **2x** - 2x normal speed
  - **4x** - 4x normal speed
  - **8x** - 8x normal speed
  - **Max** - Run as fast as possible with no frame delay

The Step buttons automatically disable whenever the emulator is running and re-enable when it pauses or hits a breakpoint so you cannot queue manual steps mid-run.

## Symbol hover hints while paused

When the emulator is paused (manually or because it hit a breakpoint) you can hover any label or named constant in an `.asm` file that belongs to the loaded ROM and VS Code shows a tooltip with both the hexadecimal and decimal value. The hint data comes directly from the ROM’s `.debug.json` metadata, so it works for symbols introduced through `.include` chains as well. This is handy for confirming the current address/value of a label without opening the token file or dumping registers.

When you hover over an assembled instruction (the mnemonic or register portion of the line—not the immediate literal) the extension now reads the underlying opcode bytes from the paused emulator, disassembles the operands, and shows the resolved value alongside the backing memory bytes. Example:

```
lxi h, 0x40A0
address: 0x0102/258
memory: 0x21 0xA0 0x40
```

The tooltip length automatically matches the instruction length reported by `CPU.GetInstrLen`, so multi-byte opcodes such as `J*`, `C*`, `STA/LDA`, `IN/OUT`, and the byte-immediate ALU ops all display their encoded operands with no manual math.

When execution pauses, the executing code line in the editor receives a translucent green highlight with a HW states. If no source mapping is available, the debugger highlights the last line in yellow printing the opcode executed.

Data directives (`DB`/`.byte`, `DW`/`.word`). The specific values are highlighted while paused (blue for reads, red for writes). Hovering a highlighted value shows the live memory at that address (hex + decimal) from the paused emulator.

## Memory Dump panel

The emulator view now embeds a **Memory Dump** panel under the frame preview. It streams a 16x16 hexdump that automatically tracks the current PC (both the hex bytes and ASCII column highlight the byte that will execute next). Uncheck **Follow PC** to freeze the window on a specific address, type any hex/decimal start value, or use the +/-0x10 and +/-0x100 buttons plus **Refresh** to nudge through RAM manually.

## Assembler

### Expressions and Operators

The assembler supports a rich expression system used throughout directives (`.if`, `.loop`, `.align`, `.print`, etc.), immediate values, and address calculations. Expressions can combine numeric literals, symbols, and operators.

**Numeric Literals**

| Format | Example | Description |
|--------|---------|-------------|
| Decimal | `42`, `-5` | Standard decimal numbers |
| Hex `$` | `$FF`, `$1234` | Hexadecimal with `$` prefix |
| Hex `0x` | `0xFF`, `0x1234` | Hexadecimal with `0x` prefix |
| Binary `%` | `%1010`, `%11_00` | Binary with `%` prefix (underscores allowed) |
| Binary `0b` | `0b1010`, `0b11_00` | Binary with `0b` prefix (underscores allowed) |
| Binary `b` | `b1010`, `b11_00` | Binary with `b` prefix (underscores allowed) |
| Character | `'A'`, `'\n'` | ASCII character (supports escapes) |

**Arithmetic Operators**

| Operator | Description | Example |
|----------|-------------|---------|
| `+` | Addition | `Value + 10` |
| `-` | Subtraction | `EndAddr - StartAddr` |
| `*` | Multiplication | `Count * 2` |
| `/` | Division | `Total / 4` |
| `%` | Modulo (remainder) | `Offset % 256` |

**Comparison Operators**

| Operator | Description | Example |
|----------|-------------|---------|
| `==` | Equal | `Value == 0` |
| `!=` | Not equal | `Flag != FALSE` |
| `<` | Less than | `Count < 10` |
| `<=` | Less than or equal | `Index <= Max` |
| `>` | Greater than | `Size > 0` |
| `>=` | Greater than or equal | `Addr >= $100` |

**Bitwise Operators**

| Operator | Description | Example |
|----------|-------------|---------|
| `&` | Bitwise AND | `Value & $0F` |
| `\|` | Bitwise OR | `Flags \| $80` |
| `^` | Bitwise XOR | `Data ^ $FF` |
| `~` | Bitwise NOT | `~Mask` |
| `<<` | Left shift | `1 << 4` |
| `>>` | Right shift | `Value >> 8` |

**Logical Operators**

| Operator | Description | Example |
|----------|-------------|---------|
| `!` | Logical NOT | `!Enabled` |
| `&&` | Logical AND | `(A > 0) && (B < 10)` |
| `\|\|` | Logical OR | `(X == 0) \|\| (Y == 0)` |

**Unary Prefix Operators**

| Operator | Description | Example |
|----------|-------------|---------|
| `+` | Unary plus (identity) | `+Value` |
| `-` | Unary minus (negation) | `-Offset` |
| `<` | Low byte (bits 0-7) | `<$1234` → `$34` |
| `>` | High byte (bits 8-15) | `>$1234` → `$12` |

The `<` (low byte) and `>` (high byte) unary operators extract 8-bit portions from 16-bit values. This is useful for splitting addresses or constants when working with 8-bit instructions:

```
ADDR = $1234

mvi l, <ADDR    ; Load low byte ($34) into L
mvi h, >ADDR    ; Load high byte ($12) into H

db <$ABCD       ; Emits $CD
db >$ABCD       ; Emits $AB
```

**Symbols**

Expressions can reference:
- Labels (e.g., `StartAddr`, `Loop`)
- Constants defined with `=` or `EQU` (e.g., `MAX_VALUE`)
- Local labels prefixed with `@` (e.g., `@loop`)
- Boolean literals `TRUE` (1) and `FALSE` (0)

**Operator Precedence** (highest to lowest)

1. Parentheses `()`
2. Unary operators: `+`, `-`, `!`, `~`, `<`, `>`
3. Multiplicative: `*`, `/`, `%`
4. Additive: `+`, `-`
5. Shift: `<<`, `>>`
6. Relational: `<`, `<=`, `>`, `>=`
7. Equality: `==`, `!=`
8. Bitwise AND: `&`
9. Bitwise XOR: `^`
10. Bitwise OR: `|`
11. Logical AND: `&&`
12. Logical OR: `||`

- `.org` directive: supported (decimal, `0x..`, or `$..`). Example: `.org 0x100`.

- `.include` directive: include another file inline using `.include "file.asm"` or `.include 'file.asm'`. Includes are resolved relative to the including file and support recursive expansion up to 16 levels.

- Origins mapping: when using `.include`, the assembler records the original file and line for each expanded line. Errors and warnings reference the original filename and line number and print the offending source line plus a `file:///` link.

- Tokens file: the assembler writes a JSON alongside the ROM (e.g., `test.json`) containing `labels` with addresses (hex), and the original `src` basename and `line` where each label was defined. This is useful for setting breakpoints by name in the emulator/debugger.
  - Note: When compiling through the VS Code extension `i8080.compile` command, the extension also appends a `breakpoints` section to the tokens JSON that records per-file breakpoints (line numbers, enabled status, and label/addr where available) discovered in the editor across the main file and recursive includes.
  - Breakpoints can be toggled only on meaningful lines (labels or instructions). Empty lines, pure comment lines, or lines containing compiler commands `.<cmd>` are ignored when you click the gutter or press `F9`.

- Warnings for immediates/addresses: if an immediate or address exceeds the instruction width (8-bit or 16-bit), the assembler emits a warning and truncates the value to the appropriate width. These are currently non-fatal warnings.

- Diagnostics: invalid mnemonics or bad operands are reported as errors with file/line and the offending source text. The assembler rejects invalid operations such as `MOV M,M`.
- `.macro` / `.endmacro`: build parameterized macros (with defaults, nested calls, and per-invocation label namespaces) that expand inline before assembly.
- `.if` / `.endif`: wrap any sequence of source lines in a conditional block that assembles only when its expression evaluates to non-zero. You can nest `.if` directives freely, and the parser short-circuits inactive branches so forward references inside skipped blocks do not trigger errors. The argument may be a single numeric/boolean literal or any full expression evaluated with the rules below. Expressions support decimal/hex/binary literals, character constants, symbol names (labels, constants, `@local` labels), arithmetic (`+ - * / % << >>`), comparisons (`== != < <= > >=`), bitwise logic (`& | ^ ~`), and boolean operators (`! && ||`). Example:

```
Value = 3

.if (Value >= 2) && (SomeFlag == TRUE)
  mvi a, #$00
  sta $d020
.endif
```
- `.loop` / `.endloop`: repeat a block of source lines `LoopCount` times (maximum per loop: 100,000). Loop counts are evaluated with the same expression engine as `.if`, so you can reference previously defined constants or simple expressions. Loop bodies can nest other `.loop` or `.if` blocks, and any constant assignments inside the block execute on each iteration because the assembler expands the body inline:

```
Value = 0
Step  = 4

.loop (Step / 2)
  db Value
  Value = Value + 1
.endloop
```

The example above emits `Value` three times (0, 1, 2) and leaves `Value` set to 3 for subsequent code.
- `.print`: emit compile-time diagnostics to the console during the second pass. Arguments are comma-separated and can mix string literals (`"PC="`), numeric literals, labels, or arbitrary expressions. Each argument is evaluated with the same expression engine as `.if`, so you can dump intermediate values or addresses while assembling:

```
.print "Copying from", SourceAddr, "to", DestAddr
.print "Loop count:", (EndAddr - StartAddr) / 16
```

Strings honor standard escapes (`\n`, `\t`, `\"`, etc.). Non-string arguments are printed in decimal.
- `.error`: immediately halt the second pass with a fatal diagnostic that uses the same argument rules as `.print`. Use it for compile-time validation inside conditionals or macros. Arguments can be strings, numbers, labels, or expressions, separated by commas. When the directive executes the assembler stops and surfaces the concatenated message to the user. Because inactive `.if` blocks are skipped during expansion, `.error` calls inside false branches never trigger:

```
MAX_SIZE = 100

.if (BUFFER_SIZE > MAX_SIZE)
  .error "Buffer size", BUFFER_SIZE, "exceeds", MAX_SIZE
.endif
```

Typical use cases include guardrails for configuration constants, macro argument validation, and short-circuiting builds when a derived value falls outside a legal range.
- `.var Name value`: declares a mutable variable whose value can be reassigned later in the file (or inside macros). Unlike `=` or `EQU`, `.var` establishes an initial value but can be updated with either direct assignments (`Counter = Counter - 1`) or a subsequent `EQU`. The symbol participates in all expression contexts just like any other constant.

```
ImmutableConst = 1      ; Initialize constant
                        ; Emits: 0x01

Counter .var 10         ; Initialize variable
db Counter              ; Emits: 0x0A

Counter = Counter - 1   ; Update with expression
db Counter              ; Emits: 0x09

Counter equ 5           ; Update with EQU
db Counter              ; Emits: 0x05
```

- `.align value`: pad the output with zero bytes until the program counter reaches the next multiple of `value`, then resume emitting instructions. The argument can be any expression understood by the `.if` evaluator, must be positive, and has to be a power of two (1, 2, 4, 8, ...). If the current address is already aligned no padding is emitted. Example:

```
.org $100
Start:
  db 0, 1, 2
.align 16   ; next instructions start at $110
AlignedLabel:
  mvi a, 0
```

`AlignedLabel` is assigned the aligned address ($110) and the gap between `$103` and `$10F` is filled with zeros.
- `.word value[, values...]`: emit one or more 16-bit words at the current address. Values may be decimal, hexadecimal (`0x`/`$`), or binary (`b`/`%`) literals. Negative decimal literals are allowed down to -0x7FFF (15-bit magnitude) and are encoded using two's complement. Each value is written little-endian (low byte first). Example:

```
.word $1234, 42, b0000_1111, -5
```

The snippet above outputs `34 12 2A 00 0F 00 FB FF`.

Alternative: `DW`

- `.byte value[, values...]`: emit one or more bytes at the current address. Accepts decimal, hex (`0x`/`$`), or binary (`b`/`%`). Example:

```
.byte 255, $10, 0xFF, b1111_0000, %11_11_00_00
```

The snippet above emits `FF 10 FF F0 F0`.

Alternative: `DB`

- `.macro Name(param, otherParam, optionalParam=$10)`: defines reusable code blocks. A macro's body is copied inline wherever you invoke `Name(...)`, and all parameters are substituted as plain text before the normal two-pass assembly runs. Each parameter ultimately resolves to the same numeric/boolean values accepted by others durectives such as `.if`, `.loop`, etc. inside a macro. Parameters that are omitted during a call fall back to their default value.

Each macro call receives its own namespace for "normal" (`Label:`) and local (`@loop`) labels, so you can safely reuse throwaway labels inside macros or even call a macro recursively. Normal labels defined inside the macro are exported as `MacroName_<call-index>.Label`, letting you jump back into generated code for debugging tricks:

```
.macro SetColors(Background=$06, Border=$0e, Addr)
  lda #Background
  sta $d021
  lda #Border
  sta $d020
AddrPtr ldx Addr
  stx $3300
.endmacro

SetColors($0b, $0f, PalettePtr)
SetColors(, MyColor+1, $0000) ; Background uses the default $06
```

Nested macros are supported (up to 32 levels deep), but you cannot open another `.macro` inside a macro body. All macro lines keep their original file/line metadata, so assembler errors still point back to the macro definition.

- `.encoding "Type", "Case"`: selects how upcoming `.text` literals convert characters to bytes. Supported types are `"ascii"` (default) and `"screencodecommodore"`. The optional case argument accepts `"mixed"` (default), `"lower"`, or `"upper"`. Example:

```
.encoding "ascii", "upper"
.text "hello", 'w'           ; emits: 0x48, 0x45, 0x4C, 0x4C, 0x4F, 0x57

.encoding "screencodecommodore"
.text "@AB"                  ; emits: 0x00, 0x01, 0x02
```

- `.text value[, values...]`: emits bytes from comma-separated string or character literals using the current `.encoding` settings. Strings honor standard escapes like `\n`, `\t`, `\"`, etc. Example:

```
.encoding "ascii"
.text "   address:   1", '\n', '\0'
; emits: 20 20 20 61 64 64 72 65 73 73 3A 20 20 20 31 0A 00
```


## Tools

### FDD utility CLI

The FDD utility tool is a command-line tool that reads and writes FDD images, and adds files to the image. It is useful for creating custom FDD images for the Vector 06c emulator.

```pwsh
npm run compile # make sure out/tools/fddutil.js exists
node .\out\tools\fddutil.js -h
node .\out\tools\fddutil.js -r .\res\fdd\rds308.fdd -i file1.com -i file2.dat -o mydisk.fdd
```

Key switches:

- `-t <file>` optional template disk image (Commonly FDD image with a boot sector and the OS of your choice).
- `-i <file>` adds a host file into the image; repeat the flag for each additional file.
- `-o <file>` writes the resulting `.fdd` image.
- `-h` prints the usage summary.