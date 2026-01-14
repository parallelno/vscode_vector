import * as fs from 'fs';
import { SourceOrigin } from './types';
import { describeOrigin, parseStringLiteral, resolveIncludePath, splitTopLevelArgs } from './utils';

export type FilesizeContext = {
  scopes: string[];
  consts: Map<string, number>;
  constOrigins: Map<string, { line: number; src?: string }>;
  variables: Set<string>;
  errors: string[];
  projectFile?: string;
  sourcePath?: string;
};

export function handleFilesizeDirectiveFirstPass(
  line: string,
  origin: SourceOrigin | undefined,
  lineIndex: number,
  ctx: FilesizeContext,
  allocateLocalKey: (name: string, origin: SourceOrigin | undefined, fallbackLine: number, scopeKey: string) => string,
  scopedConstName: (name: string, origin: SourceOrigin | undefined) => string
): boolean {
  const match = line.match(/^([A-Za-z_@][A-Za-z0-9_@.]*)\s*:?\s*\.filesize\b(.*)$/i);
  if (!match) return false;

  const rawName = match[1];
  const argsText = (match[2] || '').trim();
  const originDesc = describeOrigin(origin, lineIndex, ctx.sourcePath);

  if (!argsText.length) {
    ctx.errors.push(`Missing filename for .filesize ${rawName} at ${originDesc}`);
    return true;
  }

  const args = splitTopLevelArgs(argsText);
  if (args.length !== 1) {
    ctx.errors.push(`.filesize for ${rawName} expects exactly one string argument at ${originDesc}`);
    return true;
  }

  const fileLiteral = parseStringLiteral(args[0]);
  if (fileLiteral === null) {
    ctx.errors.push(`Invalid filename '${args[0]}' for .filesize ${rawName} at ${originDesc} - expected string literal`);
    return true;
  }

  const resolvedPath = resolveIncludePath(fileLiteral, origin?.file, ctx.sourcePath, ctx.projectFile);
  if (!resolvedPath) {
    ctx.errors.push(`File not found for .filesize ${rawName} at ${originDesc}: ${fileLiteral}`);
    return true;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (err) {
    const em = err instanceof Error ? err.message : String(err);
    ctx.errors.push(`Failed to read file size for .filesize ${rawName} at ${originDesc}: ${em}`);
    return true;
  }

  if (!stat.isFile()) {
    ctx.errors.push(`.filesize target is not a file for ${rawName} at ${originDesc}: ${resolvedPath}`);
    return true;
  }

  const size = stat.size;
  const isLocal = rawName.startsWith('@');
  const scopeKey = ctx.scopes[lineIndex - 1];
  const storeName = isLocal
    ? allocateLocalKey(rawName, origin, lineIndex, scopeKey)
    : scopedConstName(rawName, origin);

  if (!isLocal && ctx.consts.has(storeName) && !ctx.variables.has(storeName)) {
    ctx.errors.push(`Cannot reassign constant '${rawName}' at ${lineIndex} (use .var to create a variable instead)`);
    return true;
  }

  ctx.consts.set(storeName, size);
  ctx.constOrigins.set(storeName, { line: origin?.line ?? lineIndex, src: origin?.file || ctx.sourcePath });
  return true;
}
