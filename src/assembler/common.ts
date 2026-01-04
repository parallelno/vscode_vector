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

  // Tokenize while respecting quoted strings so `' '` stays intact.
  const tokens: string[] = [];
  const offsets: number[] = [];

  const isSeparator = (ch: string) => /[\s,]/.test(ch);

  let i = 0;
  while (i < lineText.length) {
    // Skip separators
    while (i < lineText.length && isSeparator(lineText[i])) i++;
    if (i >= lineText.length) break;

    const start = i;
    const quote = lineText[i] === '\'' || lineText[i] === '"' ? lineText[i] : null;

    if (quote) {
      // Consume quoted string as a single token (including quotes)
      i++; // skip opening quote
      while (i < lineText.length && lineText[i] !== quote) i++;
      if (i < lineText.length) i++; // include closing quote if present
    } else {
      // Regular token until next separator
      while (i < lineText.length && !isSeparator(lineText[i])) i++;
    }

    const token = lineText.slice(start, i);
    tokens.push(token);
    offsets.push(start);
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
