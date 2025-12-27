import { ExpressionEvalContext, SourceOrigin } from './types';
import { parseNumberFull, describeOrigin, formatMacroCallStack } from './utils';
import { resolveLocalLabelKey, resolveScopedConst } from './labels';
import { evaluateExpression } from './expression';

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
  const min = bits === 8 ? -0x80 : -0x8000;
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
