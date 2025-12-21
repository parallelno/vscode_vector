import { SourceOrigin } from './types';

/**
 * Common helper functions used throughout the assembler
 */

export function tokenizeLineWithOffsets(lineText: string): { tokens: string[]; offsets: number[] } {
  if (!lineText.length) return { tokens: [], offsets: [] };
  const tokens = lineText.split(/\s+/);
  const offsets: number[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const idx = lineText.indexOf(token, cursor);
    const start = idx >= 0 ? idx : cursor;
    offsets.push(start);
    cursor = start + token.length;
  }
  return { tokens, offsets };
}

export function argsAfterToken(lineText: string, token: string | undefined, offset: number | undefined): string {
  if (!lineText || !token || offset === undefined || offset < 0) return '';
  return lineText.slice(offset + token.length);
}

// Check if token is an address-directive (org or align) that requires special label handling
export function isAddressDirective(value: string | undefined): boolean {
  return !!value && /^\.?(org|align)$/i.test(value);
}

export function checkLabelOnDirective(line: string, directive: string): boolean {
  const pattern = new RegExp(`^[A-Za-z_@][A-Za-z0-9_@.]*\\s*:?\\s*\\.${directive}\\b`, 'i');
  return pattern.test(line) && line[0] !== '.';
}
