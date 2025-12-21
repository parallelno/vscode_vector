import { ExpressionEvalContext } from './types';
import { 
  regCodes, 
  mviOpcodes, 
  parseNumberFull,
  parseAddressToken,
  describeOrigin
} from './utils';
import { evaluateConditionExpression } from './expression';

export type InstructionContext = {
  labels: Map<string, { addr: number; line: number; src?: string }>;
  consts: Map<string, number>;
  localsIndex: Map<string, Map<string, Array<{ key: string; line: number }>>>;
  scopes: string[];
  errors: string[];
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
  if (value < 0 || value > max) {
    errors.push(`${operandLabel} (${formatSignedHex(value)}) does not fit in ${bits}-bit operand for ${opLabel} at ${line}`);
    return false;
  }
  return true;
}

export function resolveAddressToken(
  arg: string,
  lineIndex: number,
  ctx: InstructionContext
): number | null {
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
          if (lineIndex <= 0 || lineIndex - 1 >= ctx.scopes.length) return null;
          const scopeKey = ctx.scopes[lineIndex - 1];
          const fileMap = ctx.localsIndex.get(scopeKey);
          if (!fileMap) return null;
          const arr = fileMap.get(tok.slice(1));
          if (!arr || !arr.length) return null;
          let chosen = arr[0];
          for (const entry of arr) {
            if ((entry.line || 0) <= lineIndex) chosen = entry;
            else break;
          }
          const key = chosen.key;
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
          val = evaluateConditionExpression(tok, exprCtx, true);
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
    if (lineIndex <= 0 || lineIndex - 1 >= ctx.scopes.length) return null;
    const scopeKey = ctx.scopes[lineIndex - 1];
    const fileMap = ctx.localsIndex.get(scopeKey);
    if (!fileMap) return null;
    const arr = fileMap.get(s.slice(1));
    if (!arr || !arr.length) return null;
    let chosen = arr[0];
    for (const entry of arr) {
      if ((entry.line || 0) <= lineIndex) chosen = entry;
      else break;
    }
    const key = chosen.key;
    if (ctx.labels.has(key)) return ctx.labels.get(key)!.addr;
    return null;
  }

  if (ctx.labels.has(s)) return ctx.labels.get(s)!.addr;

  // final fallback: evaluate full expression
  try {
    const value = evaluateConditionExpression(s, exprCtx, true);
    return value;
  } catch (err) {
    // swallow so caller can emit a contextual error
  }
  return null;
}

export function encodeMVI(
  line: string,
  srcLine: number,
  ctx: InstructionContext,
  out: number[]
): number {
  const args = line.slice(3).trim();
  const m = args.split(',').map(s => s.trim());
  if (m.length !== 2) {
    ctx.errors.push(`Bad MVI syntax at ${srcLine}`);
    return 0;
  }
  
  const r = m[0].toUpperCase();
  const rawVal = m[1];
  
  let full: number | null = parseNumberFull(rawVal);
  if (full === null) {
    const resolved = resolveAddressToken(rawVal, srcLine, ctx);
    if (resolved !== null) full = resolved;
    else {
      const p = parseAddressToken(rawVal, ctx.labels, ctx.consts);
      if (p !== null) full = p;
    }
  }
  
  // Try evaluating as expression (supports < and > operators)
  if (full === null) {
    const exprCtx: ExpressionEvalContext = { 
      labels: ctx.labels, 
      consts: ctx.consts, 
      localsIndex: ctx.localsIndex, 
      scopes: ctx.scopes, 
      lineIndex: srcLine 
    };
    try {
      full = evaluateConditionExpression(rawVal, exprCtx, true);
    } catch (err: any) {
      // Fall through to error below
    }
  }
  
  if (!(r in mviOpcodes) || (full === null)) {
    ctx.errors.push(`Bad MVI operands at ${srcLine}`);
    return 0;
  }
  
  if (!ensureImmediateRange(full, 8, `Immediate ${rawVal}`, 'MVI', srcLine, ctx.errors)) {
    return 0;
  }
  
  out.push(mviOpcodes[r]);
  out.push((full & 0xff));
  return 2;
}

export function encodeMOV(
  tokens: string[],
  srcLine: number,
  ctx: InstructionContext,
  out: number[]
): number {
  const args = tokens.slice(1).join(' ');
  const m = args.split(',').map(s => s.trim());
  if (m.length !== 2) {
    ctx.errors.push(`Bad MOV syntax at ${srcLine}`);
    return 0;
  }
  
  const d = m[0].toUpperCase();
  const s = m[1].toUpperCase();
  
  if (!(d in regCodes) || !(s in regCodes)) {
    ctx.errors.push(`Bad MOV registers at ${srcLine}`);
    return 0;
  }
  
  // Explicitly reject the invalid MOV M,M form
  if (d === 'M' && s === 'M') {
    ctx.errors.push(`Invalid MOV M,M at ${srcLine}`);
    return 0;
  }
  
  const opcode = 0x40 + (regCodes[d] << 3) + regCodes[s];
  out.push(opcode & 0xff);
  return 1;
}

export function encodeLXI(
  line: string,
  srcLine: number,
  ctx: InstructionContext,
  out: number[]
): number {
  const args = line.slice(3).trim();
  const parts = args.split(',').map(s => s.trim());
  if (parts.length !== 2) {
    ctx.errors.push(`Bad LXI syntax at ${srcLine}`);
    return 0;
  }
  
  const rp = parts[0].toUpperCase();
  const val = parts[1];
  
  let opcode = -1;
  if (rp === 'B') opcode = 0x01;
  if (rp === 'D') opcode = 0x11;
  if (rp === 'H') opcode = 0x21;
  if (rp === 'SP') opcode = 0x31;
  
  if (opcode < 0) {
    ctx.errors.push(`Bad LXI register pair at ${srcLine}`);
    return 0;
  }
  
  let target: number | null = parseNumberFull(val);
  if (target === null) {
    const resolvedVal = resolveAddressToken(val, srcLine, ctx);
    if (resolvedVal !== null) target = resolvedVal;
  }
  
  if (target === null) {
    const exprCtx: ExpressionEvalContext = { 
      labels: ctx.labels, 
      consts: ctx.consts, 
      localsIndex: ctx.localsIndex, 
      scopes: ctx.scopes, 
      lineIndex: srcLine 
    };
    try {
      target = evaluateConditionExpression(val, exprCtx, true);
    } catch (err: any) {
      ctx.errors.push(`Bad LXI value '${val}' at ${srcLine}: ${err?.message || err}`);
      return 0;
    }
  }
  
  if (target === null) {
    ctx.errors.push(`Bad LXI value '${val}' at ${srcLine}`);
    return 0;
  }
  
  if (!ensureImmediateRange(target, 16, `Immediate ${val}`, 'LXI', srcLine, ctx.errors)) {
    return 0;
  }
  
  out.push(opcode & 0xff);
  out.push(target & 0xff);
  out.push((target >> 8) & 0xff);
  return 3;
}

export function encodeThreeByteAddress(
  tokens: string[],
  srcLine: number,
  opcode: number,
  ctx: InstructionContext,
  out: number[]
): number {
  const arg = tokens.slice(1).join(' ').trim();
  let target = 0;
  const num = parseNumberFull(arg);
  
  if (num !== null) {
    target = num;
  } else {
    const resolvedVal = resolveAddressToken(arg, srcLine, ctx);
    if (resolvedVal !== null) target = resolvedVal;
    else {
      ctx.errors.push(`Unknown label or address '${arg}' at ${srcLine}`);
      target = 0;
    }
  }
  
  if (!ensureImmediateRange(target, 16, `Address ${arg}`, tokens[0].toUpperCase(), srcLine, ctx.errors)) {
    return 0;
  }
  
  out.push(opcode & 0xff);
  out.push(target & 0xff);
  out.push((target >> 8) & 0xff);
  return 3;
}

export function encodeImmediateOp(
  tokens: string[],
  srcLine: number,
  opcode: number,
  ctx: InstructionContext,
  out: number[]
): number {
  const valTok = tokens.slice(1).join(' ').trim();
  let full: number | null = parseNumberFull(valTok);
  
  if (full === null) {
    const exprCtx: ExpressionEvalContext = { 
      labels: ctx.labels, 
      consts: ctx.consts, 
      localsIndex: ctx.localsIndex, 
      scopes: ctx.scopes, 
      lineIndex: srcLine 
    };
    try {
      full = evaluateConditionExpression(valTok, exprCtx, true);
    } catch (err: any) {
      ctx.errors.push(`Bad immediate '${valTok}' at ${srcLine}: ${err?.message || err}`);
      return 0;
    }
  }
  
  if (full === null) {
    ctx.errors.push(`Bad immediate '${valTok}' at ${srcLine}`);
    return 0;
  }
  
  if (!ensureImmediateRange(full, 8, `Immediate ${valTok}`, tokens[0].toUpperCase(), srcLine, ctx.errors)) {
    return 0;
  }
  
  out.push(opcode & 0xff);
  out.push(full & 0xff);
  return 2;
}

export function encodeRegisterOp(
  tokens: string[],
  srcLine: number,
  baseOpcode: number,
  ctx: InstructionContext,
  out: number[]
): number {
  const r = tokens[1].toUpperCase();
  if (!(r in regCodes)) {
    ctx.errors.push(`Bad ${tokens[0].toUpperCase()} reg at ${srcLine}`);
    return 0;
  }
  out.push((baseOpcode + regCodes[r]) & 0xff);
  return 1;
}
