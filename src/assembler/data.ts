import { ExpressionEvalContext, SourceOrigin } from './types';
import { 
  toByte, 
  parseWordLiteral, 
  describeOrigin,
  splitTopLevelArgs 
} from './utils';
import { evaluateConditionExpression } from './expression';
import { argsAfterToken } from './common';

export type DataContext = {
  labels: Map<string, { addr: number; line: number; src?: string }>;
  consts: Map<string, number>;
  localsIndex: Map<string, Map<string, Array<{ key: string; line: number }>>>;
  scopes: string[];
  errors: string[];
};

export function handleDB(
  line: string,
  tokens: string[],
  tokenOffsets: number[],
  srcLine: number,
  origin: SourceOrigin | undefined,
  sourcePath: string | undefined,
  ctx: DataContext,
  out?: number[]
): number {
  const op = tokens[0].toUpperCase();
  const rest = argsAfterToken(line, tokens[0], tokenOffsets[0]).trim();
  const parts = rest.split(',').map(p => p.trim()).filter(p => p.length > 0);
  let emitted = 0;
  
  for (const p of parts) {
    let val = toByte(p);
    // If toByte fails, try evaluating as an expression
    if (val === null && out) {
      const exprCtx: ExpressionEvalContext = { 
        labels: ctx.labels, 
        consts: ctx.consts, 
        localsIndex: ctx.localsIndex, 
        scopes: ctx.scopes, 
        lineIndex: srcLine 
      };
      try {
        val = evaluateConditionExpression(p, exprCtx, true);
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
  out?: number[]
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
    const parsed = parseWordLiteral(part);
    let value = 0;
    
    if ('error' in parsed) {
      ctx.errors.push(`${parsed.error} at ${originDesc}`);
    } else {
      value = parsed.value & 0xffff;
    }
    
    if (out) {
      out.push(value & 0xff);
      out.push((value >> 8) & 0xff);
    }
    emitted += 2;
  }
  
  return emitted;
}

export function handleDS(
  line: string,
  tokens: string[],
  tokenOffsets: number[],
  srcLine: number,
  ctx: DataContext
): number {
  const rest = argsAfterToken(line, tokens[0], tokenOffsets[0]).trim();
  const n = parseInt(rest);
  
  if (isNaN(n) || n < 0) {
    ctx.errors.push(`Bad DS count '${rest}' at ${srcLine}`);
    return 0;
  }
  
  return n;
}
