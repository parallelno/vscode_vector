import * as vscode from 'vscode';
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

export function resolveInstructionHoverForMemory(
  hardware: Hardware | null | undefined,
  document: vscode.TextDocument,
  position: vscode.Position,
  address: number,
  isToolbarRunning: boolean)
  : InstructionHoverInfo | undefined
{
  if (!hardware || isToolbarRunning) return undefined;

  const normalizedAddr = address & 0xffff;
  const instr = hardware.Request(HardwareReq.GET_INSTR, { addr: normalizedAddr })['data'] as number[];
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
    const fileKey = normalizeFileKey(location.filePath);
    const perLine = fileKey ? symbolCache.lineAddresses.get(fileKey) : undefined;
    const addrs = perLine?.get(location.line);
    const addr = addrs && addrs.length ? addrs[0] : undefined;
    if (addr !== undefined) {
      return { value: addr, kind: 'line' };
    }
  }
  return undefined;
}