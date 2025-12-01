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
- Adding or removing a breakpoint inside any `.asm` file automatically reruns the project compile so the ROM and breakpoint metadata stay in sync.

- Run the external emulator (example path shown for convenience):

```pwsh
C:\Work\Programming\devector\bin\devector.exe .\test.rom
```

Features and notes
------------------

- `.org` directive: supported (decimal, `0x..`, or `$..`). Example: `.org 0x100`.

- `.include` directive: include another file inline using `.include "file.asm"` or `.include 'file.asm'`. Includes are resolved relative to the including file and support recursive expansion up to 16 levels.

- Origins mapping: when using `.include`, the assembler records the original file and line for each expanded line. Errors and warnings reference the original filename and line number and print the offending source line plus a `file:///` link.

- Tokens file: the assembler writes a JSON alongside the ROM (e.g., `test.json`) containing `labels` with addresses (hex), and the original `src` basename and `line` where each label was defined. This is useful for setting breakpoints by name in the emulator/debugger.
  - Note: When compiling through the VS Code extension `i8080.compile` command, the extension also appends a `breakpoints` section to the tokens JSON that records per-file breakpoints (line numbers, enabled status, and label/addr where available) discovered in the editor across the main file and recursive includes.

- Warnings for immediates/addresses: if an immediate or address exceeds the instruction width (8-bit or 16-bit), the assembler emits a warning and truncates the value to the appropriate width. These are currently non-fatal warnings.

- Diagnostics: invalid mnemonics or bad operands are reported as errors with file/line and the offending source text. The assembler rejects invalid operations such as `MOV M,M`.

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
