import * as vscode from 'vscode';
import * as path from 'path';
import { Hardware } from '../emulator/hardware';
import { HardwareReq } from '../emulator/hardware_reqs';
import { normalizeFileKey } from './breakpoints';

export type HoverSymbolInfo = { value: number; kind: 'label' | 'const' | 'line' };

export type InstructionHoverInfo = {
  display: string;
  address: number;
  bytes: number[];
};

export type SymbolCacheLookup = {
  byName: Map<string, { value: number; kind: 'label' | 'const' }>;
  byLowerCase: Map<string, { value: number; kind: 'label' | 'const' }>;
  lineAddresses: Map<string, Map<number, number[]>>;
  projectDir?: string;
  filePaths?: Map<string, string>;
};

export type DataLineSpan = { start: number; byteLength: number; unitBytes: number };
export type DataAddressEntry = { fileKey: string; line: number; span: DataLineSpan };
export type DirectiveValueRange = { start: number; end: number };

export type DataDirectiveHoverInfo = {
  value: number;
  address: number;
  unitBytes: number;
  directive: 'byte' | 'word';
  range: vscode.Range;
  sourceValue?: number;
};

export const lxiRegisterByOpcode: Record<number, string> = {
  0x01: 'b',
  0x11: 'd',
  0x21: 'h',
  0x31: 'sp'
};

export const mviRegisterByOpcode: Record<number, string> = {
  0x06: 'b',
  0x0E: 'c',
  0x16: 'd',
  0x1E: 'e',
  0x26: 'h',
  0x2E: 'l',
  0x36: 'm',
  0x3E: 'a'
};

export const jumpMnemonicByOpcode: Record<number, string> = {
  0xC2: 'jnz',
  0xCA: 'jz',
  0xD2: 'jnc',
  0xDA: 'jc',
  0xE2: 'jpo',
  0xEA: 'jpe',
  0xF2: 'jp',
  0xFA: 'jm',
  0xC3: 'jmp'
};

export const callMnemonicByOpcode: Record<number, string> = {
  0xC4: 'cnz',
  0xCC: 'cz',
  0xD4: 'cnc',
  0xDC: 'cc',
  0xE4: 'cpo',
  0xEC: 'cpe',
  0xF4: 'cp',
  0xFC: 'cm',
  0xCD: 'call'
};

export const byteImmediateMnemonicByOpcode: Record<number, string> = {
  0xC6: 'adi',
  0xCE: 'aci',
  0xD6: 'sui',
  0xDE: 'sbi',
  0xE6: 'ani',
  0xEE: 'xri',
  0xF6: 'ori',
  0xFE: 'cpi'
};

export const wordAddressMnemonicByOpcode: Record<number, string> = {
  0x32: 'sta',
  0x3A: 'lda',
  0x22: 'shld',
  0x2A: 'lhld'
};

function stripAsmComment(text: string): string {
  return text.replace(/\/\/.*$|;.*$/, '').trim();
}

export function formatHexByte(value: number): string {
  return '0x' + (value & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

function formatHexWord(value: number): string {
  return '0x' + (value & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

export function formatInstructionHoverText(opcode: number, bytes: number[], sourceLine: string): string {
  const byteImm = bytes.length >= 2 ? bytes[1] & 0xff : undefined;
  const wordImm = bytes.length >= 3 ? ((bytes[1] & 0xff) | ((bytes[2] & 0xff) << 8)) & 0xffff : undefined;

  if (opcode in lxiRegisterByOpcode && wordImm !== undefined) {
    return `lxi ${lxiRegisterByOpcode[opcode]}, ${formatHexWord(wordImm)}`;
  }
  if (opcode in mviRegisterByOpcode && byteImm !== undefined) {
    return `mvi ${mviRegisterByOpcode[opcode]}, ${formatHexByte(byteImm)}`;
  }
  if (opcode in wordAddressMnemonicByOpcode && wordImm !== undefined) {
    return `${wordAddressMnemonicByOpcode[opcode]} ${formatHexWord(wordImm)}`;
  }
  if (opcode in jumpMnemonicByOpcode && wordImm !== undefined) {
    return `${jumpMnemonicByOpcode[opcode]} ${formatHexWord(wordImm)}`;
  }
  if (opcode in callMnemonicByOpcode && wordImm !== undefined) {
    return `${callMnemonicByOpcode[opcode]} ${formatHexWord(wordImm)}`;
  }
  if (opcode === 0xD3 && byteImm !== undefined) {
    return `out ${formatHexByte(byteImm)}`;
  }
  if (opcode === 0xDB && byteImm !== undefined) {
    return `in ${formatHexByte(byteImm)}`;
  }
  if (opcode in byteImmediateMnemonicByOpcode && byteImm !== undefined) {
    return `${byteImmediateMnemonicByOpcode[opcode]} ${formatHexByte(byteImm)}`;
  }

  const sanitized = stripAsmComment(sourceLine);
  if (sanitized.length) return sanitized;
  return `opcode 0x${opcode.toString(16).toUpperCase().padStart(2, '0')}`;
}

export async function resolveInstructionHoverForMemory(
  hardware: Hardware | null | undefined,
  document: vscode.TextDocument,
  position: vscode.Position,
  address: number,
  isToolbarRunning: boolean)
  : Promise<InstructionHoverInfo | undefined>
{
  if (!hardware || isToolbarRunning) return undefined;

  const normalizedAddr = address & 0xffff;
  const instrResp = await hardware.Request(HardwareReq.GET_INSTR, { addr: normalizedAddr });
  const instr = instrResp['data'] as number[];
  const opcode = instr[0];
  const bytes = instr;

  const sourceLine = document.lineAt(position.line).text;
  const display = formatInstructionHoverText(opcode, bytes, sourceLine);
  return { display, address: normalizedAddr, bytes };
}

export function resolveHoverSymbol(
  identifier: string,
  location: { filePath?: string; line?: number } | undefined,
  symbolCache: SymbolCacheLookup | null | undefined)
  : HoverSymbolInfo | undefined
{
  if (!symbolCache) return undefined;
  const token = (identifier || '').trim();
  if (token) {
    const exact = symbolCache.byName.get(token) || symbolCache.byLowerCase.get(token.toLowerCase());
    if (exact) return exact;
  }
  if (location?.filePath && location.line !== undefined) {
    let fileKey = normalizeFileKey(location.filePath, symbolCache.projectDir);
    let perLine = fileKey ? symbolCache.lineAddresses.get(fileKey) : undefined;
    if ((!perLine || perLine.size === 0) && symbolCache.filePaths) {
      const normalizedPath = path.normalize(location.filePath);
      for (const [key, resolvedPath] of symbolCache.filePaths.entries()) {
        if (path.normalize(resolvedPath) === normalizedPath) {
          fileKey = key;
          perLine = symbolCache.lineAddresses.get(key);
          break;
        }
      }
    }
    const addrs = perLine?.get(location.line);
    const addr = addrs && addrs.length ? addrs[0] : undefined;
    if (addr !== undefined) {
      return { value: addr, kind: 'line' };
    }
  }
  return undefined;
}

export function extractDataDirectiveInfo(lineText: string): { directive: 'byte' | 'word'; ranges: DirectiveValueRange[] } | undefined {
  if (!lineText.trim()) return undefined;
  const commentMatch = lineText.search(/(;|\/\/)/);
  const workingText = commentMatch >= 0 ? lineText.slice(0, commentMatch) : lineText;
  const directiveRegex = /(?:^|[\s\t])((?:\.?(?:db|byte))|(?:\.?(?:dw|word)))\b/i;
  const match = directiveRegex.exec(workingText);
  if (!match || match.index === undefined) return undefined;
  const token = match[1] || '';
  const directive: 'byte' | 'word' = token.toLowerCase().includes('w') ? 'word' : 'byte';
  const matchText = match[0];
  const tokenStart = (match.index ?? 0) + matchText.lastIndexOf(token);
  const valuesOffset = tokenStart + token.length;
  const valuesSegment = workingText.slice(valuesOffset);
  const ranges = splitArgsWithRanges(valuesSegment, valuesOffset);
  if (!ranges.length) return undefined;
  return { directive, ranges };
}

export function splitArgsWithRanges(text: string, offset: number): DirectiveValueRange[] {
  const ranges: DirectiveValueRange[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let tokenStart = -1;
  const pushToken = (endIndex: number) => {
    if (tokenStart === -1) return;
    let startIdx = tokenStart;
    let endIdx = endIndex;
    while (startIdx < endIdx && /\s/.test(text[startIdx]!)) startIdx++;
    while (endIdx > startIdx && /\s/.test(text[endIdx - 1]!)) endIdx--;
    if (startIdx < endIdx) {
      ranges.push({ start: offset + startIdx, end: offset + endIdx });
    }
    tokenStart = -1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const prev = i > 0 ? text[i - 1]! : '';
    if (!inDouble && ch === '\'' && prev !== '\\') {
      if (tokenStart === -1) tokenStart = i;
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"' && prev !== '\\') {
      if (tokenStart === -1) tokenStart = i;
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === '(') {
      if (tokenStart === -1) tokenStart = i;
      depth++;
      continue;
    }
    if (ch === ')' && depth > 0) {
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) {
      pushToken(i);
      continue;
    }
    if (tokenStart === -1 && !/\s/.test(ch)) {
      tokenStart = i;
    }
  }
  pushToken(text.length);
  return ranges;
}

export async function resolveDataDirectiveHoverForMemory(
  document: vscode.TextDocument,
  position: vscode.Position,
  hardware: Hardware | null | undefined,
  isToolbarRunning: boolean,
  dataLineSpanCache: Map<string, Map<number, DataLineSpan>> | null | undefined)
  : Promise<DataDirectiveHoverInfo | undefined>
{
  if (!hardware || isToolbarRunning) return undefined;
  if (!dataLineSpanCache || dataLineSpanCache.size === 0) return undefined;
  const fileKey = normalizeFileKey(document.uri.fsPath);
  if (!fileKey) return undefined;
  const lineSpans = dataLineSpanCache.get(fileKey);
  if (!lineSpans) return undefined;
  const lineNumber = position.line + 1;
  const span = lineSpans.get(lineNumber);
  if (!span) return undefined;
  const lineText = document.lineAt(position.line).text;
  const directiveInfo = extractDataDirectiveInfo(lineText);
  if (!directiveInfo) return undefined;
  const { directive, ranges } = directiveInfo;
  if ((directive === 'byte' && span.unitBytes !== 1) || (directive === 'word' && span.unitBytes !== 2)) {
    // directive mismatch; fallback to unitBytes to infer
  }
  const matchIndex = ranges.findIndex(
    (range: DirectiveValueRange) =>
      position.character >= range.start && position.character < range.end);
  if (matchIndex < 0) return undefined;
  const byteOffset = matchIndex * span.unitBytes;
  if (byteOffset >= span.byteLength) return undefined;
  const addr = (span.start + byteOffset) & 0xffff;
  const value = await readMemoryValueForSpan(hardware, addr, span.unitBytes);
  if (value === undefined) return undefined;
  const tokenRange = ranges[matchIndex];
  const literalRange = new vscode.Range(position.line, tokenRange.start, position.line, tokenRange.end);
  const literalText = document.getText(literalRange);
  const sourceValue = parseDataLiteralValue(literalText, span.unitBytes);
  return {
    value,
    address: addr,
    unitBytes: span.unitBytes,
    directive,
    range: literalRange,
    sourceValue
  };
}

async function readMemoryValueForSpan(hardware: Hardware | undefined | null, addr: number, unitBytes: number): Promise<number | undefined> {
  if (!hardware) return undefined;

  const normalizedAddr = addr & 0xffff;
  const bytesResp = await hardware.Request(HardwareReq.GET_MEM_RANGE, { "addr": normalizedAddr, "length": unitBytes });
  const bytes = bytesResp['data'] as number[];

  if (unitBytes === 1) return bytes[0];

  const word = (bytes[1] << 8) | bytes[0];
  return word;
}

export function parseDataLiteralValue(text: string, unitBytes: number): number | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed.length) return undefined;
  let value: number | undefined;
  const normalizeUnderscore = (s: string) => s.replace(/_/g, '');
  if (/^0x[0-9a-fA-F_]+$/.test(trimmed)) value = parseInt(normalizeUnderscore(trimmed.slice(2)), 16);
  else if (/^\$[0-9a-fA-F_]+$/.test(trimmed)) value = parseInt(normalizeUnderscore(trimmed.slice(1)), 16);
  else if (/^0b[01_]+$/i.test(trimmed)) value = parseInt(normalizeUnderscore(trimmed.slice(2)), 2);
  else if (/^b[01_]+$/i.test(trimmed)) value = parseInt(normalizeUnderscore(trimmed.slice(1)), 2);
  else if (/^%[01_]+$/.test(trimmed)) value = parseInt(normalizeUnderscore(trimmed.slice(1)), 2);
  else if (/^[-+]?[0-9]+$/.test(trimmed)) value = parseInt(trimmed, 10);
  else if (/^'(.|\\.)'$/.test(trimmed)) {
    const inner = trimmed.slice(1, trimmed.length - 1);
    value = inner.length === 1 ? inner.charCodeAt(0) : inner.charCodeAt(inner.length - 1);
  }
  if (value === undefined || Number.isNaN(value)) return undefined;
  const mask = unitBytes >= 4 ? 0xffffffff : ((1 << (unitBytes * 8)) >>> 0) - 1;
  return value & mask;
}
