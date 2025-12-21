import { ExpressionEvalContext, IfFrame, PrintMessage, SourceOrigin } from './types';
import {
  stripInlineComment,
  splitTopLevelArgs,
  parseStringLiteral,
  parseNumberFull,
  describeOrigin,
  TextEncodingType,
  TextCaseType,
  parseTextLiteralToBytes
} from './utils';
import { evaluateConditionExpression } from './expression';
import { argsAfterToken } from './common';

export type DirectiveContext = {
  labels: Map<string, { addr: number; line: number; src?: string }>;
  consts: Map<string, number>;
  variables: Set<string>;
  errors: string[];
  warnings: string[];
  printMessages: PrintMessage[];
  textEncoding: TextEncodingType;
  textCase: TextCaseType;
  localsIndex: Map<string, Map<string, Array<{ key: string; line: number }>>>;
  scopes: string[];
};

export function handleIfDirective(
  line: string,
  origin: SourceOrigin | undefined,
  lineIndex: number,
  sourcePath: string | undefined,
  ifStack: IfFrame[],
  ctx: DirectiveContext
): boolean {
  const ifMatch = line.match(/^\.if\b(.*)$/i);
  if (!ifMatch) return false;

  const expr = (ifMatch[1] || '').trim();
  const originDesc = describeOrigin(origin, lineIndex, sourcePath);
  const parentActive = ifStack.length === 0 ? true : ifStack[ifStack.length - 1].effective;
  
  if (!expr.length) {
    ctx.errors.push(`Missing expression for .if at ${originDesc}`);
    ifStack.push({ effective: false, suppressed: !parentActive, origin, lineIndex });
    return true;
  }
  
  const exprCtx: ExpressionEvalContext = { 
    labels: ctx.labels, 
    consts: ctx.consts, 
    localsIndex: ctx.localsIndex, 
    scopes: ctx.scopes, 
    lineIndex 
  };
  
  let conditionResult = false;
  if (!parentActive) {
    try {
      evaluateConditionExpression(expr, exprCtx, false);
    } catch (err: any) {
      ctx.errors.push(`Failed to parse .if expression at ${originDesc}: ${err?.message || err}`);
    }
  } else {
    try {
      const value = evaluateConditionExpression(expr, exprCtx, true);
      conditionResult = value !== 0;
    } catch (err: any) {
      ctx.errors.push(`Failed to evaluate .if at ${originDesc}: ${err?.message || err}`);
      conditionResult = false;
    }
  }
  
  const effective = parentActive && conditionResult;
  ifStack.push({ effective, suppressed: !parentActive, origin, lineIndex });
  return true;
}

export function handleEndifDirective(
  line: string,
  origin: SourceOrigin | undefined,
  lineIndex: number,
  sourcePath: string | undefined,
  ifStack: IfFrame[],
  ctx: DirectiveContext
): boolean {
  const endifMatch = line.match(/^\.endif\b(.*)$/i);
  if (!endifMatch) return false;

  const remainder = (endifMatch[1] || '').trim();
  const originDesc = describeOrigin(origin, lineIndex, sourcePath);
  
  if (remainder.length) {
    ctx.errors.push(`Unexpected tokens after .endif at ${originDesc}`);
  }
  if (!ifStack.length) {
    ctx.errors.push(`.endif without matching .if at ${originDesc}`);
  } else {
    ifStack.pop();
  }
  
  return true;
}

export function handlePrintDirective(
  line: string,
  origin: SourceOrigin | undefined,
  lineIndex: number,
  sourcePath: string | undefined,
  ctx: DirectiveContext
): boolean {
  const printMatch = line.match(/^\.print\b(.*)$/i);
  if (!printMatch) return false;

  const originDesc = describeOrigin(origin, lineIndex, sourcePath);
  const argsText = (printMatch[1] || '').trim();
  const parts = argsText.length ? splitTopLevelArgs(argsText) : [];
  const fragments: string[] = [];
  const exprCtx: ExpressionEvalContext = { 
    labels: ctx.labels, 
    consts: ctx.consts, 
    localsIndex: ctx.localsIndex, 
    scopes: ctx.scopes, 
    lineIndex 
  };
  
  let failed = false;
  for (const partRaw of parts) {
    const part = partRaw.trim();
    if (!part.length) continue;
    
    try {
      const literal = parseStringLiteral(part);
      if (literal !== null) {
        fragments.push(literal);
        continue;
      }
    } catch (err: any) {
      ctx.errors.push(`Invalid string literal in .print at ${originDesc}: ${err?.message || err}`);
      failed = true;
      break;
    }
    
    try {
      const value = evaluateConditionExpression(part, exprCtx, true);
      fragments.push(String(value));
    } catch (err: any) {
      ctx.errors.push(`Failed to evaluate .print expression '${part}' at ${originDesc}: ${err?.message || err}`);
      failed = true;
      break;
    }
  }
  
  if (!failed) {
    const output = fragments.length ? fragments.join(' ') : '';
    ctx.printMessages.push({ text: output, origin, lineIndex });
    try {
      console.log(output);
    } catch (err) {
      // ignore console output errors
    }
  }
  
  return true;
}

export function handleErrorDirective(
  line: string,
  origin: SourceOrigin | undefined,
  lineIndex: number,
  sourcePath: string | undefined,
  ctx: DirectiveContext
): boolean {
  const errorMatch = line.match(/^\.error\b(.*)$/i);
  if (!errorMatch) return false;

  const originDesc = describeOrigin(origin, lineIndex, sourcePath);
  const argsText = (errorMatch[1] || '').trim();
  const parts = argsText.length ? splitTopLevelArgs(argsText) : [];
  const fragments: string[] = [];
  const exprCtx: ExpressionEvalContext = { 
    labels: ctx.labels, 
    consts: ctx.consts, 
    localsIndex: ctx.localsIndex, 
    scopes: ctx.scopes, 
    lineIndex 
  };
  
  let failed = false;
  for (const partRaw of parts) {
    const part = partRaw.trim();
    if (!part.length) continue;
    
    try {
      const literal = parseStringLiteral(part);
      if (literal !== null) {
        fragments.push(literal);
        continue;
      }
    } catch (err: any) {
      ctx.errors.push(`Invalid string literal in .error at ${originDesc}: ${err?.message || err}`);
      failed = true;
      break;
    }
    
    try {
      const value = evaluateConditionExpression(part, exprCtx, true);
      fragments.push(String(value));
    } catch (err: any) {
      ctx.errors.push(`Failed to evaluate .error expression '${part}' at ${originDesc}: ${err?.message || err}`);
      failed = true;
      break;
    }
  }
  
  if (!failed) {
    const errorMessage = fragments.length ? fragments.join(' ') : '';
    ctx.errors.push(`.error: ${errorMessage} at ${originDesc}`);
  }
  
  return true;
}

export function handleEncodingDirective(
  line: string,
  origin: SourceOrigin | undefined,
  lineIndex: number,
  sourcePath: string | undefined,
  ctx: DirectiveContext,
  tokenOffsets: number[],
  tokens: string[]
): boolean {
  const op = tokens[0].toUpperCase();
  if (op !== '.ENCODING') return false;

  const originDesc = describeOrigin(origin, lineIndex, sourcePath);
  const rest = argsAfterToken(line, tokens[0], tokenOffsets[0]).trim();
  const args = splitTopLevelArgs(rest);
  
  if (args.length < 1) {
    ctx.errors.push(`Missing encoding type for .encoding at ${originDesc}`);
    return true;
  }
  
  const typeArg = parseStringLiteral(args[0]);
  if (typeArg === null) {
    ctx.errors.push(`Invalid encoding type '${args[0]}' for .encoding at ${originDesc} - expected string literal`);
    return true;
  }
  
  const typeLower = typeArg.toLowerCase();
  if (typeLower !== 'ascii' && typeLower !== 'screencodecommodore') {
    ctx.errors.push(`Unknown encoding type '${typeArg}' for .encoding at ${originDesc} - expected 'ascii' or 'screencodecommodore'`);
    return true;
  }
  
  ctx.textEncoding = typeLower as TextEncodingType;
  
  // Parse optional case argument
  if (args.length >= 2) {
    const caseArg = parseStringLiteral(args[1]);
    if (caseArg === null) {
      ctx.errors.push(`Invalid case '${args[1]}' for .encoding at ${originDesc} - expected string literal`);
      return true;
    }
    const caseLower = caseArg.toLowerCase();
    if (caseLower !== 'mixed' && caseLower !== 'lower' && caseLower !== 'upper') {
      ctx.errors.push(`Unknown case '${caseArg}' for .encoding at ${originDesc} - expected 'mixed', 'lower', or 'upper'`);
      return true;
    }
    ctx.textCase = caseLower as TextCaseType;
  } else {
    ctx.textCase = 'mixed';  // Default case when not provided
  }
  
  return true;
}

export function handleTextDirective(
  line: string,
  origin: SourceOrigin | undefined,
  lineIndex: number,
  sourcePath: string | undefined,
  ctx: DirectiveContext,
  tokenOffsets: number[],
  tokens: string[],
  out?: number[],
  addrRef?: { value: number }
): { handled: boolean; emitted?: number } {
  const op = tokens[0].toUpperCase();
  if (op !== '.TEXT') return { handled: false };

  const originDesc = describeOrigin(origin, lineIndex, sourcePath);
  const rest = argsAfterToken(line, tokens[0], tokenOffsets[0]).trim();
  
  if (!rest.length) {
    ctx.errors.push(`Missing value for .text at ${originDesc}`);
    return { handled: true };
  }
  
  const parts = splitTopLevelArgs(rest);
  let emitted = 0;
  
  for (const part of parts) {
    const parsed = parseTextLiteralToBytes(part, ctx.textEncoding, ctx.textCase);
    if ('error' in parsed) {
      ctx.errors.push(`${parsed.error} at ${originDesc}`);
    } else {
      if (out && addrRef) {
        for (const b of parsed.bytes) {
          out.push(b);
          addrRef.value++;
          emitted++;
        }
      } else {
        emitted += parsed.bytes.length;
      }
    }
  }
  
  return { handled: true, emitted };
}
