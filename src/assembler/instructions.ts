import { ExpressionEvalContext, SourceOrigin } from './types';
import { parseNumberFull, describeOrigin, formatMacroCallStack } from './utils';
import { resolveLocalLabelKey, resolveScopedConst } from './labels';
import { evaluateExpression } from './expression';
import { CpuType } from '../cpu';

export type InstructionContext = {
  labels: Map<string, { addr: number; line: number; src?: string }>;
  consts: Map<string, number>;
  localsIndex: Map<string, Map<string, Array<{ key: string; line: number }>>>;
  scopes: string[];
  errors: string[];
  originLines?: Array<number | undefined>;
  // Optional address of the current line for location-counter expressions
  locationCounter?: number;
};

export function formatSignedHex(value: number): string {
  const normalized = Math.trunc(value);
  const prefix = normalized < 0 ? '-0x' : '0x';
  const hex = Math.abs(normalized).toString(16).toUpperCase();
  return prefix + hex;
}

export function ensureImmediateRange(
  value: number,
  bits: 8 | 16,
  operandLabel: string,
  opLabel: string,
  line: number,
  errors: string[],
  origin?: SourceOrigin
): boolean {
  const max = bits === 8 ? 0xff : 0xffff;
  const min = bits === 8 ? -0xff : -0xffff;
  if (value < min || value > max) {
    const stack = formatMacroCallStack(origin);
    errors.push(`${operandLabel} (${formatSignedHex(value)}) does not fit in ${bits}-bit operand for ${opLabel} at ${describeOrigin(origin, line)}${stack}`);
    return false;
  }
  return true;
}

// Resolve an address token to a numeric value, using labels, consts,
// and expression evaluation
export function resolveAddressToken(
  arg: string,
  lineIndex: number,
  ctx: InstructionContext
): number | null
{
  if (!arg) return null;
  const s = arg.trim();
  const scopeKey = lineIndex > 0 && lineIndex - 1 < ctx.scopes.length ? ctx.scopes[lineIndex - 1] : undefined;
  const exprCtx: ExpressionEvalContext = {
    labels: ctx.labels,
    consts: ctx.consts,
    localsIndex: ctx.localsIndex,
    scopes: ctx.scopes,
    lineIndex,
    locationCounter: ctx.locationCounter
  };

  // simple numeric
  const num = parseNumberFull(s);
  if (num !== null) return num;

  // check simple named constants
  const directConst = resolveScopedConst(s, ctx.consts, scopeKey);
  if (directConst !== undefined) return directConst;

  // support chained arithmetic like "a + b - 1"
  const exprParts = s.split(/\s*([+-])\s*/);
  if (exprParts.length > 1) {
    let acc: number | null = null;
    for (let pi = 0; pi < exprParts.length; pi += 2) {
      const tok = exprParts[pi].trim();
      let val: number | null = null;

      // numeric
      val = parseNumberFull(tok);
      if (val === null) {
        if (tok[0] === '@') {
          const refLine = ctx.originLines ? ctx.originLines[lineIndex - 1] : undefined;
          const key = resolveLocalLabelKey(tok, lineIndex, ctx.scopes, ctx.localsIndex, refLine);
          if (!key) return null;
          if (ctx.labels.has(key)) val = ctx.labels.get(key)!.addr;
          else val = null;
        } else if (ctx.labels.has(tok)) {
          val = ctx.labels.get(tok)!.addr;
        } else {
          const scoped = resolveScopedConst(tok, ctx.consts, scopeKey);
          if (scoped !== undefined) val = scoped;
        }
      }

      if (val === null) {
        try {
          val = evaluateExpression(tok, exprCtx, true);
        } catch (err) {
          val = null;
        }
      }

      if (val === null) return null;
      if (acc === null) acc = val;
      else {
        const op = exprParts[pi - 1];
        acc = op === '+' ? (acc + val) : (acc - val);
      }
    }
    return acc!;
  }

  // local label resolution
  if (s[0] === '@') {
    const refLine = ctx.originLines ? ctx.originLines[lineIndex - 1] : undefined;
    const key = resolveLocalLabelKey(s, lineIndex, ctx.scopes, ctx.localsIndex, refLine);
    if (!key) return null;
    if (ctx.labels.has(key)) return ctx.labels.get(key)!.addr;
    return null;
  }

  if (ctx.labels.has(s)) return ctx.labels.get(s)!.addr;

  // final fallback: evaluate full expression
  try {
    const value = evaluateExpression(s, exprCtx, true);
    return value;
  } catch (err) {
    // swallow so caller can emit a contextual error
  }
  return null;
}

type NormalizedInstruction =
  | { tokens: string[] }
  | null
  | undefined;

function normalizeRegister(token: string): string | null {
  const upper = token.toUpperCase();
  if (upper === '(HL)') return 'M';
  if (upper === 'A' || upper === 'B' || upper === 'C' ||
      upper === 'D' || upper === 'E' || upper === 'H' || upper === 'L') {
    return upper;
  }
  return null;
}

function normalizeRegisterPair(token: string): 'B' | 'D' | 'H' | 'SP' | null {
  const upper = token.toUpperCase();
  if (upper === 'BC') return 'B';
  if (upper === 'DE') return 'D';
  if (upper === 'HL') return 'H';
  if (upper === 'SP') return 'SP';
  return null;
}

function stripParens(token: string): string {
  let out = token.trim();
  if (out.startsWith('(')) out = out.slice(1);
  if (out.endsWith(')')) out = out.slice(0, -1);
  return out;
}

function unwrapParenTokens(tokens: string[]): string[] {
  if (!tokens.length) return tokens;
  const out = tokens.slice();
  out[0] = stripParens(out[0]);
  if (out.length > 1) {
    const last = out.length - 1;
    out[last] = stripParens(out[last]);
  }
  return out;
}

export function normalizeInstructionTokens(
  tokens: string[],
  cpu: CpuType,
  origin: SourceOrigin | undefined,
  srcLine: number,
  errors: string[]
): NormalizedInstruction {
  if (cpu !== 'z80') return undefined;
  if (!tokens.length) return undefined;
  const op = tokens[0].toUpperCase();
  if (op !== 'LD') return undefined;

  if (tokens.length < 3) {
    const stack = formatMacroCallStack(origin);
    errors.push(`Unsupported LD form at ${describeOrigin(origin, srcLine)}${stack}`);
    return null;
  }

  const destRaw = tokens[1];
  const destReg = normalizeRegister(destRaw);
  const destPair = normalizeRegisterPair(destRaw);
  const destMemPair = normalizeRegisterPair(stripParens(destRaw));
  const srcTokens = tokens.slice(2);
  const srcReg = srcTokens.length === 1 ? normalizeRegister(srcTokens[0]) : null;
  const srcPair = srcTokens.length === 1 ? normalizeRegisterPair(srcTokens[0]) : null;
  const srcMemPair = srcTokens.length === 1 ? normalizeRegisterPair(stripParens(srcTokens[0])) : null;
  const srcParens = srcTokens.length > 0 && srcTokens[0].trim().startsWith('(');
  const srcLastReg = srcTokens.length ? normalizeRegister(srcTokens[srcTokens.length - 1]) : null;
  const srcLastPair = srcTokens.length ? normalizeRegisterPair(srcTokens[srcTokens.length - 1]) : null;
  const stack = formatMacroCallStack(origin);

  // LD r, r' / LD (HL), r' / LD r, (HL)
  if (destReg) {
    if (srcReg) {
      return { tokens: ['MOV', destReg, srcReg] };
    }

    // LD A, (BC)/(DE)
    if (destReg === 'A' && srcMemPair && (srcMemPair === 'B' || srcMemPair === 'D')) {
      return { tokens: ['LDAX', srcMemPair] };
    }

    // LD A, (nn)
    if (destReg === 'A' && srcParens) {
      return { tokens: ['LDA', ...unwrapParenTokens(srcTokens)] };
    }

    // Immediate: LD r, n / LD (HL), n
    if (srcParens) {
      errors.push(`Unsupported LD source operand at ${describeOrigin(origin, srcLine)}${stack}`);
      return null;
    }
    if (srcPair || srcMemPair) {
      errors.push(`Unsupported LD source operand at ${describeOrigin(origin, srcLine)}${stack}`);
      return null;
    }
    return { tokens: ['MVI', destReg, ...srcTokens] };
  }

  // LD rp, rp' / LD rp, nn
  if (destPair) {
    if (destPair === 'SP' && srcPair === 'H') {
      return { tokens: ['SPHL'] };
    }

    if (destPair === 'H' && srcParens) {
      return { tokens: ['LHLD', ...unwrapParenTokens(srcTokens)] };
    }

    if (srcParens) {
      errors.push(`Unsupported LD source operand at ${describeOrigin(origin, srcLine)}${stack}`);
      return null;
    }
    if (srcPair) {
      errors.push(`Unsupported LD source operand at ${describeOrigin(origin, srcLine)}${stack}`);
      return null;
    }

    return { tokens: ['LXI', destPair, ...srcTokens] };
  }

  // LD (BC)/(DE), A
  if (destMemPair && (destMemPair === 'B' || destMemPair === 'D') && srcReg === 'A') {
    return { tokens: ['STAX', destMemPair] };
  }

  // LD (nn), HL / LD (nn), A
  if (destRaw.trim().startsWith('(')) {
    const addressTokens = unwrapParenTokens(tokens.slice(1, tokens.length - 1));
    if (!addressTokens.length) {
      addressTokens.push(stripParens(destRaw));
    }

    if (srcLastPair === 'H') {
      return { tokens: ['SHLD', ...addressTokens] };
    }
    if (srcLastReg === 'A') {
      return { tokens: ['STA', ...addressTokens] };
    }
  }

  const originDesc = describeOrigin(origin, srcLine);
  errors.push(`Unsupported LD form at ${originDesc}${stack}`);
  return null;
}
