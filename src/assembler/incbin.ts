import * as fs from 'fs';
import * as path from 'path';
import { ExpressionEvalContext, SourceOrigin } from './types';
import { describeOrigin, parseStringLiteral, splitTopLevelArgs } from './utils';
import { argsAfterToken } from './common';
import { evaluateConditionExpression } from './expression';

export type IncbinContext = {
  labels: Map<string, { addr: number; line: number; src?: string }>;
  consts: Map<string, number>;
  localsIndex: Map<string, Map<string, Array<{ key: string; line: number }>>>;
  scopes: string[];
  errors: string[];
};

type IncbinParams = {
  fileData: Buffer;
  offset: number;
  length: number;
};

/**
 * Shared helper to parse .incbin arguments and read binary file
 * Returns null on error (error messages added to ctx.errors)
 */
function parseIncbinParams(
  line: string,
  tokens: string[],
  tokenOffsets: number[],
  srcLine: number,
  origin: SourceOrigin | undefined,
  sourcePath: string | undefined,
  ctx: IncbinContext
): IncbinParams | null {
  const originDesc = describeOrigin(origin, srcLine, sourcePath);
  const rest = argsAfterToken(line, tokens[0], tokenOffsets[0]).trim();

  if (!rest.length) {
    ctx.errors.push(`Missing filename for .incbin at ${originDesc}`);
    return null;
  }

  const args = splitTopLevelArgs(rest);
  if (args.length < 1) {
    ctx.errors.push(`Missing filename for .incbin at ${originDesc}`);
    return null;
  }

  // Parse filename
  const filenameArg = args[0].trim();
  const filename = parseStringLiteral(filenameArg);
  if (filename === null) {
    ctx.errors.push(`Invalid filename '${filenameArg}' for .incbin at ${originDesc} - expected string literal`);
    return null;
  }

  // Resolve the file path
  let filePath = filename;
  if (!path.isAbsolute(filePath)) {
    const baseDir = sourcePath ? path.dirname(sourcePath) : process.cwd();
    filePath = path.resolve(baseDir, filePath);
  }

  // Read the file
  let fileData: Buffer;
  try {
    fileData = fs.readFileSync(filePath);
  } catch (err) {
    const em = err && (err as any).message ? (err as any).message : String(err);
    ctx.errors.push(`Failed to read binary file '${filename}' for .incbin at ${originDesc} - ${em}`);
    return null;
  }

  // Parse optional offset and length
  const exprCtx: ExpressionEvalContext = {
    labels: ctx.labels,
    consts: ctx.consts,
    localsIndex: ctx.localsIndex,
    scopes: ctx.scopes,
    lineIndex: srcLine
  };

  let offset = 0;
  let length = fileData.length;

  if (args.length >= 2) {
    const offsetArg = args[1].trim();
    try {
      offset = evaluateConditionExpression(offsetArg, exprCtx, true);
      if (offset < 0 || offset > fileData.length) {
        ctx.errors.push(`Invalid offset ${offset} for .incbin at ${originDesc} - must be between 0 and ${fileData.length}`);
        return null;
      }
    } catch (err: any) {
      ctx.errors.push(`Failed to evaluate offset for .incbin at ${originDesc}: ${err?.message || err}`);
      return null;
    }
  }

  if (args.length >= 3) {
    const lengthArg = args[2].trim();
    try {
      length = evaluateConditionExpression(lengthArg, exprCtx, true);
      if (length < 0 || offset + length > fileData.length) {
        ctx.errors.push(`Invalid length ${length} for .incbin at ${originDesc} - offset + length exceeds file size`);
        return null;
      }
    } catch (err: any) {
      ctx.errors.push(`Failed to evaluate length for .incbin at ${originDesc}: ${err?.message || err}`);
      return null;
    }
  } else {
    // If no length specified, use remaining bytes from offset
    length = fileData.length - offset;
  }

  return { fileData, offset, length };
}

/**
 * Handles .incbin directive in first pass (address calculation only)
 * Returns the number of bytes that will be emitted
 */
export function handleIncbinFirstPass(
  line: string,
  tokens: string[],
  tokenOffsets: number[],
  srcLine: number,
  origin: SourceOrigin | undefined,
  sourcePath: string | undefined,
  ctx: IncbinContext
): number {
  const params = parseIncbinParams(line, tokens, tokenOffsets, srcLine, origin, sourcePath, ctx);
  if (!params) return 0;
  return params.length;
}

/**
 * Handles .incbin directive in second pass (emit binary data)
 * Returns the number of bytes emitted
 */
export function handleIncbinSecondPass(
  line: string,
  tokens: string[],
  tokenOffsets: number[],
  srcLine: number,
  origin: SourceOrigin | undefined,
  sourcePath: string | undefined,
  ctx: IncbinContext,
  out: number[]
): number {
  const params = parseIncbinParams(line, tokens, tokenOffsets, srcLine, origin, sourcePath, ctx);
  if (!params) return 0;

  // Emit the binary data
  for (let i = 0; i < params.length; i++) {
    out.push(params.fileData[params.offset + i]);
  }

  return params.length;
}
