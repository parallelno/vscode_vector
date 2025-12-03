export function parseAddressLike(value: any): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value & 0xffff;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return parseInt(trimmed.slice(2), 16) & 0xffff;
    if (/^\$[0-9a-fA-F]+$/.test(trimmed)) return parseInt(trimmed.slice(1), 16) & 0xffff;
    if (/^[0-9a-fA-F]+$/.test(trimmed)) {
      // Treat bare alphanumeric strings containing hex digits as hex (useful for UI inputs like "AB00")
      if (/[a-fA-F]/.test(trimmed)) return parseInt(trimmed, 16) & 0xffff;
      return parseInt(trimmed, 10) & 0xffff;
    }
    if (/^[0-9]+$/.test(trimmed)) return parseInt(trimmed, 10) & 0xffff;
  }
  return undefined;
}