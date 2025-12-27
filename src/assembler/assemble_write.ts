import * as fs from 'fs';
import * as path from 'path';
import { DEBUG_FILE_SUFFIX } from '../extention/consts';
import { AssembleResult, AssembleWriteResult } from './types';

type AssembleFn = (source: string, sourcePath?: string, projectFile?: string) => AssembleResult;

export function createAssembleAndWrite(assemble: AssembleFn, projectFile?: string)
{
  return function assembleAndWrite(
    source: string,
    outPath: string,
    sourcePath?: string,
    debugPath?: string,
  ): AssembleWriteResult
  {
    const startTime = Date.now();

    const res = assemble(source, sourcePath, projectFile);

    if (!res.success || !res.output) {
      // Improve error messages: include the source line, filename, line number,
      // and file URI / vscode URI so editors/terminals can link to the location.
      const formatted: string[] = [];
      const srcLines = source.split(/\r?\n/);
      if (res.errors && res.errors.length) {
        for (const e of res.errors) {
          // Try to extract a trailing `at <line>` marker from the assembler error
          const m = e.match(/at\s+(\d+)\b/);
          const lineNo = m ? parseInt(m[1], 10) : undefined;
          // Determine origin (file + original line) if available from assemble()
          const origin = (res.origins && lineNo) ? res.origins[lineNo - 1] : undefined;
          let srcText = '';
          let displayPath: string | undefined;
          let displayLine = lineNo;
          if (origin && origin.file) {
            displayPath = path.resolve(origin.file);
            displayLine = origin.line;
            try {
              const fileLines = fs.readFileSync(origin.file, 'utf8').split(/\r?\n/);
              if (fileLines[displayLine - 1]) srcText = fileLines[displayLine - 1].replace(/\t/g, '    ').trim();
            } catch (err) {
              srcText = '';
            }
          } else if (lineNo) {
            displayPath = sourcePath ? path.resolve(sourcePath) : undefined;
            srcText = srcLines[lineNo - 1] ? srcLines[lineNo - 1].replace(/\t/g, '    ').trim() : '';
          }
          let msg = '';
          if (displayPath && displayLine) {
            const fileUri = 'file:///' + displayPath.replace(/\\/g, '/');
            // replace any "at <expandedLine>" in the assembler message with the original source line
            const cleaned = typeof e === 'string' ? e.replace(/at\s+\d+\b/, `at ${displayLine}`) : e;
            msg = `${displayPath}:${displayLine}: ${cleaned}\n> ${srcText}\n${fileUri}:${displayLine}`;
          } else if (displayLine) {
            const cleaned = typeof e === 'string' ? e.replace(/at\s+\d+\b/, `at ${displayLine}`) : e;
            msg = `line ${displayLine}: ${cleaned}\n> ${srcText}`;
          } else {
            msg = e;
          }
          formatted.push(msg);
          // Also print to stderr for immediate feedback when running the assembler
          console.error(msg);
          console.error('');
        }
      }
      return {
        success: false,
        errors: formatted.length ? formatted : res.errors,
        warnings: res.warnings,
        printMessages: res.printMessages
      };
    }

    // Print warnings (non-fatal) in a similar formatted style so they are visible
    if (res.warnings && res.warnings.length) {
      for (const w of res.warnings) {
        const m = w.match(/at\s+(\d+)\b/);
        const lineNo = m ? parseInt(m[1], 10) : undefined;
        const origin = (res.origins && lineNo) ? res.origins[lineNo - 1] : undefined;
        let srcText = '';
        let displayPath: string | undefined;
        let displayLine = lineNo;
        if (origin && origin.file) {
          displayPath = path.resolve(origin.file);
          displayLine = origin.line;
          try {
            const fileLines = fs.readFileSync(origin.file, 'utf8').split(/\r?\n/);
            if (fileLines[displayLine - 1]) srcText = fileLines[displayLine - 1].replace(/\t/g, '    ').trim();
          } catch (err) {}
        } else if (lineNo) {
          displayPath = sourcePath ? path.resolve(sourcePath) : undefined;
          const srcLines = source.split(/\r?\n/);
          srcText = srcLines[lineNo - 1] ? srcLines[lineNo - 1].replace(/\t/g, '    ').trim() : '';
        }
        if (displayPath && displayLine) {
          const fileUri = 'file:///' + displayPath.replace(/\\/g, '/');
          const cleaned = typeof w === 'string' ? w.replace(/at\s+\d+\b/, `at ${displayLine}`) : w;
          console.warn(`${displayPath}:${displayLine}: ${cleaned}\n> ${srcText}\n${fileUri}:${displayLine}`);
          console.warn('');
        } else if (displayLine) {
          const cleaned = typeof w === 'string' ? w.replace(/at\s+\d+\b/, `at ${displayLine}`) : w;
          console.warn(`line ${displayLine}: ${cleaned}\n> ${srcText}`);
          console.warn('');
        } else {
          console.warn(w);
          console.warn('');
        }
      }
    }
    fs.writeFileSync(outPath, res.output);

    // write debug file (JSON)
    try {
      // token file uses a DEBUG_FILE_SUFFIX suffix (e.g. `test.rom` -> `test.debug.json`).
      let tokenPath: string;
      if (debugPath) {
        tokenPath = debugPath;
      } else if (/\.[^/.]+$/.test(outPath)) {
        tokenPath = outPath.replace(/\.[^/.]+$/, DEBUG_FILE_SUFFIX);
      } else {
        tokenPath = outPath + DEBUG_FILE_SUFFIX;
      }
      const tokens: any = {
        labels: {},
        consts: {}
      };
      if (res.labels) {
        for (const [name, info] of Object.entries(res.labels)) {
          tokens.labels[name] = {
            addr: '0x' + info.addr.toString(16).toUpperCase().padStart(4, '0'),
            src: info.src || (sourcePath ? path.basename(sourcePath) : undefined),
            line: info.line
          };
        }
      }
      if (res.consts) {
        const originInfo = res.constOrigins || {};
        for (const [name, value] of Object.entries(res.consts)) {
          const normalized = ((value % 0x10000) + 0x10000) % 0x10000;
          const origin = originInfo[name];
          tokens.consts[name] = {
            value,
            hex: '0x' + normalized.toString(16).toUpperCase().padStart(4, '0'),
            line: origin?.line,
            src: origin?.src ? path.basename(origin.src) : (sourcePath ? path.basename(sourcePath) : undefined)
          };
        }
      }
      tokens.lineAddresses = {};
      if (res.map && res.origins) {
        for (const [lineStr, addrVal] of Object.entries(res.map)) {
          const lineIndex = parseInt(lineStr, 10);
          if (!Number.isFinite(lineIndex) || lineIndex <= 0) continue;
          const origin = res.origins[lineIndex - 1] as { file?: string; line: number } | undefined;
          if (!origin || typeof origin.line !== 'number') continue;
          const originFile = (origin.file || sourcePath);
          if (!originFile) continue;
          const base = path.basename(originFile).toLowerCase();
          if (!tokens.lineAddresses[base]) tokens.lineAddresses[base] = {};
          const addrHex = '0x' + (addrVal & 0xffff).toString(16).toUpperCase().padStart(4, '0');
          const existing = tokens.lineAddresses[base][origin.line];
          if (Array.isArray(existing)) {
            if (!existing.includes(addrHex)) existing.push(addrHex);
          } else if (existing !== undefined) {
            if (existing !== addrHex) tokens.lineAddresses[base][origin.line] = [existing, addrHex];
          } else {
            tokens.lineAddresses[base][origin.line] = [addrHex];
          }
        }
      }
      if (res.dataLineSpans && res.origins) {
        tokens.dataLines = tokens.dataLines || {};
        for (const [lineStr, span] of Object.entries(res.dataLineSpans)) {
          const lineIndex = parseInt(lineStr, 10);
          if (!Number.isFinite(lineIndex) || lineIndex <= 0) continue;
          const origin = res.origins[lineIndex - 1] as { file?: string; line: number } | undefined;
          if (!origin || typeof origin.line !== 'number') continue;
          const originFile = origin.file || sourcePath;
          if (!originFile) continue;
          const base = path.basename(originFile).toLowerCase();
          if (!tokens.dataLines[base]) tokens.dataLines[base] = {};
          tokens.dataLines[base][origin.line] = {
            addr: '0x' + (span.start & 0xffff).toString(16).toUpperCase().padStart(4, '0'),
            byteLength: span.byteLength,
            unitBytes: span.unitBytes
          };
        }
      }
      fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 4), 'utf8');
    } catch (err) {
      // non-fatal: write failed
      console.error('Warning: failed to write token file:', err);
    }

    const durationMs = Date.now() - startTime;
    // Print a concise success message including compile time for CLI/debug usage
    try {
      console.log(`Devector: Compilation succeeded to ${outPath} (${res.output ? res.output.length : 0} bytes) in ${durationMs} ms`);
    } catch (e) {}

    return {
      success: true,
      path: outPath,
      timeMs: durationMs,
      warnings: res.warnings,
      printMessages: res.printMessages
    };
  };
}
