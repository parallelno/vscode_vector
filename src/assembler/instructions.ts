import { ExpressionEvalContext } from './types';
import {parseNumberFull} from './utils';
import { resolveLocalLabelKey } from './labels';
import { evaluateExpression } from './expression';

export type InstructionContext = {
  labels: Map<string, { addr: number; line: number; src?: string }>;
  consts: Map<string, number>;
  localsIndex: Map<string, Map<string, Array<{ key: string; line: number }>>>;
  scopes: string[];
  errors: string[];
  originLines?: Array<number | undefined>;
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
  errors: string[]
): boolean {
  const max = bits === 8 ? 0xff : 0xffff;
  value = bits === 8 ? value & 0xff : value & 0xffff;
  if (value > max)
  {
    errors.push(`${operandLabel} (${formatSignedHex(value)}) does not fit in ${bits}-bit operand for ${opLabel} at ${line}`);
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
  const exprCtx: ExpressionEvalContext = {
    labels: ctx.labels,
    consts: ctx.consts,
    localsIndex: ctx.localsIndex,
    scopes: ctx.scopes,
    lineIndex
  };

  // simple numeric
  const num = parseNumberFull(s);
  if (num !== null) return num;

  // check simple named constants
  if (ctx.consts && ctx.consts.has(s)) return ctx.consts.get(s)!;

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
        } else if (ctx.consts && ctx.consts.has(tok)) {
          val = ctx.consts.get(tok)!;
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
