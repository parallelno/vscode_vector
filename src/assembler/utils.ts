import * as fs from 'fs';
import * as path from 'path';
import { SourceOrigin, WordLiteralResult } from './types';

// VS Code API is optional at runtime (CLI/tests). Attempt to load lazily.
function tryGetWorkspaceRoot(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode');
    return vscode.workspace?.workspaceFolders?.[0]?.uri?.fsPath;
  } catch (_e) {
    return undefined;
  }
}

export function stripMultilineComments(source: string): string {
  // Remove /* */ style multiline comments while respecting strings and character literals
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  let inComment = false;
  let inLineComment = false;

  while (i < source.length) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : '';

    // Short-circuit if we're inside a line comment: copy until newline
    if (inLineComment) {
      result += ch;
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }

    // Toggle string/char literal state (respect escapes)
    if (!inComment && (ch === '"' || ch === '\'')) {
      let escaped = false;
      let j = i - 1;
      while (j >= 0 && source[j] === '\\') { escaped = !escaped; j--; }
      if (!escaped) {
        if (!inString) {
          inString = true;
          stringChar = ch;
        } else if (ch === stringChar) {
          inString = false;
          stringChar = '';
        }
      }
      result += ch;
      i++;
      continue;
    }

    if (inString) {
      result += ch;
      i++;
      continue;
    }

    // Enter multiline comment
    if (!inComment && ch === '/' && next === '*') {
      inComment = true;
      i += 2;
      continue;
    }

    // Enter line comment (// or ;) to avoid mis-detecting quotes inside
    if (!inComment && (ch === ';' || (ch === '/' && next === '/'))) {
      inLineComment = true;
      if (ch === '/' && next === '/') {
        result += '//';
        i += 2;
      } else {
        result += ch;
        i += 1;
      }
      continue;
    }

    // Exit comment
    if (inComment && ch === '*' && next === '/') {
      inComment = false;
      i += 2;
      continue;
    }

    if (inComment) {
      // Preserve newlines so line numbers remain aligned after stripping
      if (ch === '\n') result += '\n';
      i++;
      continue;
    }

    // If not in comment, copy char
    result += ch;
    i++;
  }

  return result;
}

export function stripInlineComment(line: string): string {
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';

    if (inString) {
      if (ch === stringChar) {
        // Count preceding backslashes to detect escaping
        let backslashes = 0;
        let j = i - 1;
        while (j >= 0 && line[j] === '\\') { backslashes++; j--; }
        if ((backslashes % 2) === 0) {
          inString = false;
          stringChar = '';
        }
      }
      continue;
    }

    if (ch === '"' || ch === '\'') {
      // Enter string/char literal if quote is not escaped
      let backslashes = 0;
      let j = i - 1;
      while (j >= 0 && line[j] === '\\') { backslashes++; j--; }
      if ((backslashes % 2) === 0) {
        inString = true;
        stringChar = ch;
      }
      continue;
    }

    if (ch === ';') {
      return line.slice(0, i);
    }

    if (ch === '/' && next === '/') {
      return line.slice(0, i);
    }
  }

  return line;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function splitTopLevelArgs(text: string): string[] {
  if (!text.trim()) return [];
  const result: string[] = [];
  let current = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';
    if (!inDouble && ch === '\'' && prev !== '\\') {
      inSingle = !inSingle;
    } else if (!inSingle && ch === '"' && prev !== '\\') {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble) {
      if (ch === '(') depth++;
      else if (ch === ')' && depth > 0) depth--;
      else if (ch === ',' && depth === 0) {
        result.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  result.push(current.trim());
  return result;
}

export function substituteIdentifiers(source: string, replacements: Record<string, string>): string {
  let output = source;
  for (const [token, value] of Object.entries(replacements)) {
    const pattern = new RegExp(`\\b${escapeRegExp(token)}\\b`, 'g');
    output = output.replace(pattern, value);
  }
  return output;
}

export const regCodes: Record<string, number> = {
  B: 0,
  C: 1,
  D: 2,
  E: 3,
  H: 4,
  L: 5,
  M: 6,
  A: 7
};

export const mviOpcodes: Record<string, number> = {
  B: 0x06,
  C: 0x0e,
  D: 0x16,
  E: 0x1e,
  H: 0x26,
  L: 0x2e,
  M: 0x36,
  A: 0x3e
};

export function toByte(v: string): number | null {
  if (/^0x[0-9a-fA-F]+$/.test(v)) return parseInt(v.slice(2), 16) & 0xff;
  if (/^[0-9]+$/.test(v)) return parseInt(v, 10) & 0xff;
  if (/^b[01_]+$/i.test(v)) return parseInt(v.slice(1).replace(/_/g, ''), 2) & 0xff;
  if (/^%[01_]+$/.test(v)) return parseInt(v.slice(1).replace(/_/g, ''), 2) & 0xff;
  return null;
}

export function parseWordLiteral(v: string): WordLiteralResult {
  const text = v.trim();
  if (!text.length) return { error: 'Missing .word value' };

  const negativeMatch = /^-([0-9]+)$/.exec(text);
  if (negativeMatch) {
    const magnitude = parseInt(negativeMatch[1], 10);
    if (isNaN(magnitude)) return { error: `Invalid negative .word value '${text}'` };
    if (magnitude > 0x7fff) return { error: `Negative .word value '${text}' exceeds 15-bit limit` };
    const value = (-magnitude) & 0xffff;
    return { value };
  }

  let parsed: number | null = null;
  if (/^0x[0-9a-fA-F]+$/.test(text)) parsed = parseInt(text.slice(2), 16);
  else if (/^\$[0-9a-fA-F]+$/.test(text)) parsed = parseInt(text.slice(1), 16);
  else if (/^[0-9]+$/.test(text)) parsed = parseInt(text, 10);
  else if (/^b[01_]+$/i.test(text)) parsed = parseInt(text.slice(1).replace(/_/g, ''), 2);
  else if (/^%[01_]+$/.test(text)) parsed = parseInt(text.slice(1).replace(/_/g, ''), 2);

  if (parsed === null || isNaN(parsed)) {
    return { error: `Invalid .word value '${text}'` };
  }
  if (parsed < 0) {
    return { error: `.word value '${text}' cannot be negative (only decimal negatives allowed)` };
  }
  if (parsed > 0xffff) {
    return { error: `.word value '${text}' exceeds 16-bit range` };
  }
  return { value: parsed & 0xffff };
}

// Parse a number in various formats: hex (0x or $),
// decimal, binary (b or %)
export function parseNumberFull(v: string)
: number | null
{
  if (!v) return null;
  const s = v.trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^\$[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(1), 16);
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  if (/^b[01_]+$/i.test(s)) return parseInt(s.slice(1).replace(/_/g, ''), 2);
  if (/^%[01_]+$/.test(s)) return parseInt(s.slice(1).replace(/_/g, ''), 2);
  return null;
}

// Parse an address token, which can be a number, label, const,
// or expression
export function parseAddressToken(
  v: string,
  labels?: Map<string, { addr: number; line: number; src?: string }>,
  consts?: Map<string, number>
): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16) & 0xffff;
  if (/^\$[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(1), 16) & 0xffff;
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10) & 0xffff;

  const exprParts = s.split(/\s*([+-])\s*/);
  if (exprParts.length > 1) {
    let acc: number | null = null;
    for (let pi = 0; pi < exprParts.length; pi += 2) {
      const tok = exprParts[pi].trim();
      let val: number | null = null;
      val = parseNumberFull(tok);
      if (val === null) {
        if (consts && consts.has(tok)) val = consts.get(tok)!;
        else if (labels && labels.has(tok)) val = labels.get(tok)!.addr;
      }
      if (val === null) return null;
      if (acc === null) acc = val;
      else {
        const op = exprParts[pi - 1];
        acc = op === '+' ? acc + val : acc - val;
      }
    }
    return acc! & 0xffff;
  }

  if (consts && consts.has(s)) return consts.get(s)! & 0xffff;
  if (labels && labels.has(s)) return labels.get(s)!.addr & 0xffff;
  return null;
}

export function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_@]/.test(ch);
}

export function isIdentifierPart(ch: string): boolean {
  return /[A-Za-z0-9_@.]/.test(ch);
}

export function parseStringLiteral(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== '\'') || trimmed[trimmed.length - 1] !== quote) return null;
  let result = '';
  for (let i = 1; i < trimmed.length - 1; i++) {
    let ch = trimmed[i]!;
    if (ch === '\\') {
      i++;
      if (i >= trimmed.length - 1) throw new Error('Unterminated escape in string literal');
      const esc = trimmed[i]!;
      switch (esc) {
        case 'n': ch = '\n'; break;
        case 'r': ch = '\r'; break;
        case 't': ch = '\t'; break;
        case '0': ch = '\0'; break;
        case '\\': ch = '\\'; break;
        case '\'': ch = '\''; break;
        case '"': ch = '"'; break;
        default: ch = esc;
      }
    }
    result += ch;
  }
  return result;
}

export function describeOrigin(origin?: SourceOrigin, fallbackLine?: number, sourcePath?: string): string {
  const file = origin?.file || sourcePath || '<memory>';
  const line = origin?.line ?? fallbackLine ?? 0;
  return `${file}:${line}`;
}

export function formatMacroCallStack(origin?: SourceOrigin): string {
  const entries: Array<{ name: string; ordinal: number; file?: string; line?: number }> = [];
  let frame = origin?.macroInstance;
  while (frame) {
    entries.push({ name: frame.name, ordinal: frame.ordinal, file: frame.callerFile, line: frame.callerLine });
    frame = frame.callerMacro;
  }
  if (!entries.length) return '';

  const lines = entries.reverse().map((e) => {
    const file = e.file ? path.resolve(e.file) : '<memory>';
    const line = e.line ?? 0;
    const uri = e.file ? 'file:///' + path.resolve(e.file).replace(/\\/g, '/') + ':' + line : '';
    return `${e.name}#${e.ordinal} at ${file}:${line}${uri ? ` (${uri})` : ''}`;
  });

  return '\nMacro call stack:\n  ' + lines.join('\n  ');
}

export function detectNormalLabelName(line: string): string | null {
  const stripped = stripInlineComment(line);
  const match = stripped.match(/^\s*([@A-Za-z_][A-Za-z0-9_@.]*)\s*:/);
  if (!match) return null;
  const name = match[1];
  if (!name || name[0] === '@') return null;
  return name;
}

export function resolveLocalLabelKey(name: string, originFile?: string, sourcePath?: string): string {
  if (!name || name[0] !== '@') return name;
  const baseFile = originFile || sourcePath;
  const base = baseFile ? path.basename(baseFile, path.extname(baseFile)) : 'memory';
  return '@' + name.slice(1) + '_' + base;
}

export type TextEncodingType = 'ascii' | 'screencodecommodore';
export type TextCaseType = 'mixed' | 'lower' | 'upper';

export function applyTextCase(str: string, caseType: TextCaseType): string {
  switch (caseType) {
    case 'lower': return str.toLowerCase();
    case 'upper': return str.toUpperCase();
    default: return str;
  }
}

export function encodeTextToBytes(str: string, encoding: TextEncodingType, caseType: TextCaseType): number[] {
  const text = applyTextCase(str, caseType);
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (encoding === 'ascii') {
      // ASCII encoding: only bytes 0x00-0x7F are kept, others are ignored
      if (code >= 0x00 && code <= 0x7f) {
        bytes.push(code);
      }
    } else if (encoding === 'screencodecommodore') {
      // Commodore screencode conversion:
      // ASCII 0x40-0x5F (@, A-Z, [\]^_) -> 0x00-0x1F (subtract 0x40)
      // ASCII 0x60-0x7F (`, a-z, {|}~, DEL) -> 0x00-0x1F (subtract 0x60)
      // ASCII 0x20-0x3F (space, digits, punctuation) -> unchanged
      // ASCII 0x00-0x1F (control characters) -> unchanged
      // Characters outside 0x00-0x7F range are ignored
      let screencode = code;
      if (code >= 0x40 && code <= 0x5f) {
        // @ and uppercase A-Z and symbols [\]^_: subtract 0x40
        screencode = code - 0x40;
      } else if (code >= 0x60 && code <= 0x7f) {
        // lowercase a-z and symbols {|}~ and backtick: subtract 0x60
        screencode = code - 0x60;
      } else if (code >= 0x20 && code <= 0x3f) {
        // space and digits/punctuation stay the same
        screencode = code;
      } else if (code < 0x20) {
        // control characters stay as-is
        screencode = code;
      } else {
        // ignore characters outside basic ASCII range
        continue;
      }
      bytes.push(screencode & 0xff);
    }
  }
  return bytes;
}

export function parseTextLiteralToBytes(part: string, encoding: TextEncodingType, caseType: TextCaseType): { bytes: number[] } | { error: string } {
  const trimmed = part.trim();
  if (!trimmed.length) return { error: 'Empty .text value' };

  // Check if it's a string literal
  const strLiteral = parseStringLiteral(trimmed);
  if (strLiteral !== null) {
    return { bytes: encodeTextToBytes(strLiteral, encoding, caseType) };
  }

  // Check if it's a single character in quotes (parseStringLiteral handles this)
  // If parseStringLiteral returned null, it's not a valid string/char literal
  return { error: `Invalid .text value '${trimmed}' - expected string or character literal` };
}

export function resolveIncludePath(
  includedFile: string,
  currentAsm?: string,
  mainAsm?: string,
  projectFile?: string
): string | undefined
{
  // Keep a list of attempted paths so the caller can surface a useful error when none exist.
  const attempted: string[] = [];

  if (path.isAbsolute(includedFile)) {
    return includedFile;
  }

  const tryResolve = (baseDir?: string): string | undefined => {
    if (!baseDir) return undefined;
    const candidate = path.resolve(baseDir, includedFile);
    attempted.push(candidate);
    return fs.existsSync(candidate) ? candidate : undefined;
  };

  const projectDir = projectFile ? path.dirname(projectFile) : undefined;

  // 1) Relative to the current file
  const currentDir = currentAsm ? path.dirname(currentAsm) : undefined;
  const found = tryResolve(currentDir)
    // 2) Relative to the main asm file directory
    || tryResolve(mainAsm ? path.dirname(mainAsm) : undefined)
    // 3) Relative to the project file directory (explicit)
    || tryResolve(projectDir)
    // 4) Relative to the VS Code workspace root when available
    || tryResolve(tryGetWorkspaceRoot())
    // 5) Relative to the current working directory
    || tryResolve(process.cwd());

  if (found) return found;

  // Fall back to the last attempted path so the caller can include it in the error message.
  return attempted.length ? attempted[attempted.length - 1] : undefined;
}

export function parseDwordLiteral(v: string): WordLiteralResult {
  const text = v.trim();
  if (!text.length) return { error: 'Missing .dword value' };

  const negativeMatch = /^-([0-9]+)$/.exec(text);
  if (negativeMatch) {
    const magnitude = parseInt(negativeMatch[1], 10);
    if (isNaN(magnitude)) return { error: `Invalid negative .dword value '${text}'` };
    if (magnitude > 0x7fffffff) return { error: `Negative .dword value '${text}' exceeds 31-bit limit` };
    const value = (-magnitude) >>> 0;
    return { value };
  }

  let parsed: number | null = null;
  if (/^0x[0-9a-fA-F]+$/.test(text)) parsed = parseInt(text.slice(2), 16);
  else if (/^\$[0-9a-fA-F]+$/.test(text)) parsed = parseInt(text.slice(1), 16);
  else if (/^[0-9]+$/.test(text)) parsed = parseInt(text, 10);
  else if (/^b[01_]+$/i.test(text)) parsed = parseInt(text.slice(1).replace(/_/g, ''), 2);
  else if (/^%[01_]+$/i.test(text)) parsed = parseInt(text.slice(1).replace(/_/g, ''), 2);

  if (parsed === null || isNaN(parsed)) {
    return { error: `Invalid .dword value '${text}'` };
  }
  if (parsed < 0) {
    return { error: `.dword value '${text}' cannot be negative (only decimal negatives allowed)` };
  }
  if (parsed > 0xffffffff) {
    return { error: `.dword value '${text}' exceeds 32-bit range` };
  }
  return { value: parsed >>> 0 };
}