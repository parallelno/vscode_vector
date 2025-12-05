import * as path from 'path';
import { SourceOrigin, WordLiteralResult } from './types';

export function stripInlineComment(line: string): string {
  return line.replace(/\/\/.*$|;.*$/, '');
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

export function parseNumberFull(v: string): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^\$[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(1), 16);
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  if (/^b[01_]+$/i.test(s)) return parseInt(s.slice(1).replace(/_/g, ''), 2);
  if (/^%[01_]+$/.test(s)) return parseInt(s.slice(1).replace(/_/g, ''), 2);
  return null;
}

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
