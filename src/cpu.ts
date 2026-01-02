export type CpuType = 'i8080' | 'z80';

export const DEFAULT_CPU: CpuType = 'i8080';

export function normalizeCpu(value: unknown): CpuType | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  if (lower === 'i8080') return 'i8080';
  if (lower === 'z80') return 'z80';
  return null;
}
