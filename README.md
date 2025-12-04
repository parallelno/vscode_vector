# Intel 8080 Assembler + Debugger (Minimal)

This repository contains a small two-pass Intel 8080 assembler, a tiny emulator for testing, and a debug adapter intended for experimentation.

What’s included

- A two-pass TypeScript assembler that emits a ROM (`.rom`) and a tokens file (`.json`) containing labels and origins.
- A small emulator/debugger used for development and testing.

Quick start

1. Install dependencies:

```pwsh
npm install
```

2. Build the tools (produces `out/`):

```pwsh
npm run compile
```

3. Assemble and run the included test ROM (see below).

Assembler directive tests
--------------------------

Run the focused directive regression suite at any time:

```pwsh
npm run test-directives
```

The command recompiles the TypeScript sources and executes every test case under `test/assembler/directives`, reporting a PASS/FAIL line for each directive scenario plus a summary total. The process exits with a non-zero status when a failure is detected, so it can plug directly into CI.
Current coverage includes `.org`, `.align` (success + failure paths), `.if`/`.endif`, `.loop`/`.endloop` (standalone and inside macros), `.include` (flat + nested + missing-file errors), `.print`, `DS`, literal/binary/hex formats with expression evaluation, and both macro-bodied plus standalone local-label resolution. Add more fixture `.asm` files under `test/assembler/directives` and register them in `src/tools/run_directive_tests.ts` to grow the matrix.

How to assemble and run
-----------------------

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

Emulator panel controls
-----------------------

Launching the VS Code emulator panel loads the ROM and shows a compact toolbar on top of the frame preview. The buttons behave like classic debugger controls:

- **Run / Pause** toggles the hardware thread. While running it reads “Pause”; hitting it stops execution, captures the current frame, and switches back to “Run”.
- **Step Over** executes a single instruction after stopping the machine (currently a simple single-instruction step without temporary breakpoints).
- **Step Into** behaves like a classic single-instruction step, halting immediately after execution.
- **Step Out** is a placeholder single-step today (it stops, runs one instruction, and logs that proper step-out logic is TBD).
- **Step Frame** stops the emulator, runs one full frame with no breaks, and leaves execution paused for inspection.
- **Step 256** runs 256 single-instruction steps in succession so you can advance through short loops faster without resuming full speed.
- **Restart** stops the hardware, resets/restarts the ROM, reloads it into memory, and then resumes running.

The Step buttons automatically disable whenever the emulator is running and re-enable when it pauses or hits a breakpoint so you cannot queue manual steps mid-run.

Memory Dump panel
------------------

The emulator view now embeds a **Memory Dump** panel under the frame preview. It streams a 16x16 hexdump that automatically tracks the current PC (both the hex bytes and ASCII column highlight the byte that will execute next). Uncheck **Follow PC** to freeze the window on a specific address, type any hex/decimal start value, or use the +/-0x10 and +/-0x100 buttons plus **Refresh** to nudge through RAM manually.

Features and notes
------------------

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

Macros
------

Use `.macro Name(param, otherParam, optionalParam=$10)` to define reusable code blocks. A macro's body is copied inline wherever you invoke `Name(...)`, and all parameters are substituted as plain text before the normal two-pass assembly runs. Each parameter ultimately resolves to the same numeric/boolean values accepted by others durectives such as `.if`, `.loop`, etc. inside a macro. Parameters that are omitted during a call fall back to their default value.

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

Extending the workflow
----------------------

- If you want a single npm script that compiles, assembles, updates labels, and runs the emulator, you can add an npm script to `package.json`. Example:

```json
"scripts": {
  "assemble:run": "npm run compile && node ./scripts/run-assembler.js && node ./scripts/update-test-json.js && C:\\Work\\Programming\\devector\\bin\\devector.exe .\\test.rom"
}
```

Adjust the emulator path to the location of `devector.exe` on your machine.

Want help?

Tell me whether you want:

- The `assemble:run` npm script added automatically, or
- Oversize-immediate warnings promoted to errors, or
- Unit tests added for `.include` origin mapping and immediate-size warnings.

I won't make those changes without your confirmation.
