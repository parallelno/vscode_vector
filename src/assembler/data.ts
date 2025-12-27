import { ExpressionEvalContext, SourceOrigin } from './types';
import {
  toByte,
  parseWordLiteral,
  parseDwordLiteral,
  describeOrigin,
  splitTopLevelArgs
} from './utils';
import { evaluateExpression } from './expression';
import { argsAfterToken } from './common';

export type DataContext = {
  labels: Map<string, { addr: number; line: number; src?: string }>;
  consts: Map<string, number>;
  localsIndex: Map<string, Map<string, Array<{ key: string; line: number }>>>;
  scopes: string[];
  errors: string[];
  // Optional address of the current line for location-counter expressions
  locationCounter?: number;
};

export function handleDB(
  line: string,
  tokens: string[],
  tokenOffsets: number[],
  srcLine: number,
  origin: SourceOrigin | undefined,
  sourcePath: string | undefined,
  ctx: DataContext,
  out?: number[],
  options: { defer?: boolean } = {}
): number {
  const op = tokens[0].toUpperCase();
  const rest = argsAfterToken(line, tokens[0], tokenOffsets[0]).trim();
  const parts = rest.split(',').map(p => p.trim()).filter(p => p.length > 0);
  let emitted = 0;

  for (const p of parts) {
    // Allow string literals in DB/.BYTE (e.g., "TEXT")
    const strMatch = p.match(/^(['"])(.*)\1$/);
    if (strMatch) {
      const content = strMatch[2] || '';
      const bytes: number[] = [];
      for (let i = 0; i < content.length; i++) {
        let ch = content[i]!;
        if (ch === '\\') {
          i++;
          if (i >= content.length) {
            ctx.errors.push(`Bad ${op} value '${p}' at ${srcLine}: Unterminated escape sequence`);
            break;
          }
          const esc = content[i]!;
          switch (esc) {
            case 'n': ch = '\n'; break;
            case 'r': ch = '\r'; break;
            case 't': ch = '\t'; break;
            case '0': ch = '\0'; break;
            case '\\': ch = '\\'; break;
            case '\"': ch = '"'; break;
            case '\'': ch = '\''; break;
            default: ch = esc;
          }
        }
        bytes.push(ch.charCodeAt(0) & 0xff);
      }
      if (bytes.length) {
        if (out) bytes.forEach((b) => out.push(b));
        emitted += bytes.length;
        continue;
      }
    }

    let val = toByte(p);
    // If toByte fails, try evaluating as an expression unless we're deferring resolution
    if (val === null && out && !options.defer) {
      const exprCtx: ExpressionEvalContext = {
        labels: ctx.labels,
        consts: ctx.consts,
        localsIndex: ctx.localsIndex,
        scopes: ctx.scopes,
        lineIndex: srcLine,
        locationCounter: ctx.locationCounter === undefined ? undefined : ctx.locationCounter + emitted
      };
      try {
        val = evaluateExpression(p, exprCtx, true);
      } catch (err: any) {
        ctx.errors.push(`Bad ${op} value '${p}' at ${srcLine}: ${err?.message || err}`);
        val = 0;
      }
    }

    if (out && val !== null) {
      out.push(val & 0xff);
    }
    emitted++;
  }

  return emitted;
}

export function handleDW(
  line: string,
  tokens: string[],
  tokenOffsets: number[],
  srcLine: number,
  origin: SourceOrigin | undefined,
  sourcePath: string | undefined,
  ctx: DataContext,
  out?: number[],
  options: { defer?: boolean } = {}
): number {
  const op = tokens[0].toUpperCase();
  const originDesc = describeOrigin(origin, srcLine, sourcePath);
  const rest = argsAfterToken(line, tokens[0], tokenOffsets[0]).trim();

  if (!rest.length) {
    ctx.errors.push(`Missing value for ${op} at ${originDesc}`);
    return 0;
  }

  const parts = rest.split(',').map(p => p.trim()).filter(p => p.length > 0);
  if (!parts.length) {
    ctx.errors.push(`Missing value for ${op} at ${originDesc}`);
    return 0;
  }

  let emitted = 0;
  for (const part of parts) {
    let value: number | null = null;
    const parsed = parseWordLiteral(part);

    if ('error' in parsed) {
      if (!options.defer) {
        const exprCtx: ExpressionEvalContext = {
          labels: ctx.labels,
          consts: ctx.consts,
          localsIndex: ctx.localsIndex,
          scopes: ctx.scopes,
          lineIndex: srcLine,
          locationCounter: ctx.locationCounter === undefined ? undefined : ctx.locationCounter + emitted
        };
        try {
          value = evaluateExpression(part, exprCtx, true) & 0xffff;
        } catch (err: any) {
          ctx.errors.push(`Bad ${op} value '${part}' at ${originDesc}: ${err?.message || err}`);
        }
      }
    } else {
      value = parsed.value & 0xffff;
    }

    if (out && value !== null) {
      out.push(value & 0xff);
      out.push((value >> 8) & 0xff);
    }
    emitted += 2;
  }

  return emitted;
}

export function handleDD(
  line: string,
  tokens: string[],
  tokenOffsets: number[],
  srcLine: number,
  origin: SourceOrigin | undefined,
  sourcePath: string | undefined,
  ctx: DataContext,
  out?: number[],
  options: { defer?: boolean } = {}
): number {
  const op = tokens[0].toUpperCase();
  const originDesc = describeOrigin(origin, srcLine, sourcePath);
  const rest = argsAfterToken(line, tokens[0], tokenOffsets[0]).trim();

  if (!rest.length) {
    ctx.errors.push(`Missing value for ${op} at ${originDesc}`);
    return 0;
  }

  const parts = rest.split(',').map(p => p.trim()).filter(p => p.length > 0);
  if (!parts.length) {
    ctx.errors.push(`Missing value for ${op} at ${originDesc}`);
    return 0;
  }

  let emitted = 0;
  for (const part of parts) {
    let value: number | null = null;
    const parsed = parseDwordLiteral(part);

    if ('error' in parsed) {
      if (!options.defer) {
        const exprCtx: ExpressionEvalContext = {
          labels: ctx.labels,
          consts: ctx.consts,
          localsIndex: ctx.localsIndex,
          scopes: ctx.scopes,
          lineIndex: srcLine,
          locationCounter: ctx.locationCounter === undefined ? undefined : ctx.locationCounter + emitted
        };
        try {
          value = evaluateExpression(part, exprCtx, true) >>> 0;
        } catch (err: any) {
          ctx.errors.push(`Bad ${op} value '${part}' at ${originDesc}: ${err?.message || err}`);
        }
      }
    } else {
      value = parsed.value >>> 0;
    }

    if (out && value !== null) {
      out.push(value & 0xff);
      out.push((value >>> 8) & 0xff);
      out.push((value >>> 16) & 0xff);
      out.push((value >>> 24) & 0xff);
    }
    emitted += 4;
  }

  return emitted;
}

export function handleStorage(
  line: string,
  tokens: string[],
  tokenOffsets: number[],
  srcLine: number,
  origin: SourceOrigin | undefined,
  sourcePath: string | undefined,
  ctx: DataContext,
  out?: number[]
): { size: number; filled: boolean } {
  const originDesc = describeOrigin(origin, srcLine, sourcePath);
  const rest = argsAfterToken(line, tokens[0], tokenOffsets[0]).trim();
  if (!rest.length) {
    ctx.errors.push(`Missing value for .storage at ${originDesc}`);
    return { size: 0, filled: false };
  }

  const parts = splitTopLevelArgs(rest);
  if (!parts.length || !parts[0].trim()) {
    ctx.errors.push(`Missing value for .storage at ${originDesc}`);
    return { size: 0, filled: false };
  }

  const exprCtx: ExpressionEvalContext = {
    labels: ctx.labels,
    consts: ctx.consts,
    localsIndex: ctx.localsIndex,
    scopes: ctx.scopes,
    lineIndex: srcLine,
    locationCounter: ctx.locationCounter
  };

  let size = 0;
  try {
    size = evaluateExpression(parts[0], exprCtx, true);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error('size must be a non-negative number');
    }
  } catch (err: any) {
    ctx.errors.push(`Bad .storage size '${parts[0]}' at ${originDesc}: ${err?.message || err}`);
    return { size: 0, filled: false };
  }

  let filler: number | undefined;
  if (parts.length > 1 && parts[1].trim().length) {
    const fillerText = parts[1].trim();
    let val = toByte(fillerText);
    if (val === null) {
      try {
        val = evaluateExpression(fillerText, exprCtx, true) & 0xff;
      } catch (err: any) {
        ctx.errors.push(`Bad .storage filler '${fillerText}' at ${originDesc}: ${err?.message || err}`);
      }
    }
    if (val !== null) filler = val & 0xff;
  }

  if (out && filler !== undefined && size > 0) {
    for (let i = 0; i < size; i++) {
      out.push(filler);
    }
  }

  return { size, filled: filler !== undefined };
}
