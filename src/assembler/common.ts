/**
 * Common helper functions used throughout the assembler
 */

// Tokenize a line into tokens and their offsets.
// It splits the line by whitespace/commas. It ignores empty tokens.
// All tokens returned are in the upper case.
export function tokenize(lineText: string)
: { tokens: string[]; offsets: number[] }
{
  if (!lineText.length) return { tokens: [], offsets: [] };

  // Split by whitespace and commas
  const rawTokens = lineText.split(/[\s,]+/);
  const tokens: string[] = [];
  const offsets: number[] = [];
  // Calculate offsets of each token. Offset is the index in lineText where the token starts.
  let cursor = 0;
  for (const rawToken of rawTokens) {
    if (rawToken.length === 0) {
      cursor += 1; // Skip empty tokens, but move cursor forward
      continue;
    }
    const idx = lineText.indexOf(rawToken, cursor);
    const start = idx >= 0 ? idx : cursor;
    tokens.push(rawToken);
    offsets.push(start);
    cursor = start + rawToken.length;
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
