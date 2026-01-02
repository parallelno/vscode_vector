import * as path from 'path';
import * as fs from 'fs';
import { SourceOrigin } from './types';
import * as ext_utils from './utils';

export type IncludeResult = {
  lines: string[];
  origins: SourceOrigin[];
};

const MAX_INCLUDE_DEPTH = 16;

/**
 * Expand .include directives and build an origin map so we can report
 * errors/warnings that reference the original file and line number.
 */
export function processIncludes(
  content: string,
  file?: string,
  sourcePath?: string,
  projectFile?: string,
  depth = 0
): IncludeResult {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(`Include recursion too deep (>${MAX_INCLUDE_DEPTH}) when processing ${file || '<memory>'}`);
  }

  const outLines: string[] = [];
  const origins: Array<{ file?: string; line: number }> = [];
  // Strip multiline comments before splitting into lines
  const cleanedContent = ext_utils.stripMultilineComments(content);
  const srcLines = cleanedContent.split(/\r?\n/);

  for (let li = 0; li < srcLines.length; li++) {
    const raw = srcLines[li];
    const trimmed = ext_utils.stripInlineComment(raw).trim();

    // match .include "filename" or .include 'filename'
    const m = trimmed.match(/^\.include\s+["']([^"']+)["']/i);
    if (m) {
      const inc = m[1];
      // resolve path
      let incText: string;
      const incPath: string | undefined = ext_utils.resolveIncludePath(inc, file, sourcePath, projectFile);
      if (!incPath) {
        throw new Error(`Failed to include '${inc}' at ${file || sourcePath || '<memory>'}:${li + 1} - ${incPath || inc}`);
      }
      try {
        incText = fs.readFileSync(incPath!, 'utf8');
      } catch (err) {
        const em = err && (err as any).message ? (err as any).message : String(err);
        throw new Error(`Failed to include '${inc}' at ${file || sourcePath || '<memory>'}:${li+1} - ${em}`);
      }

      const nested = processIncludes(incText, incPath, sourcePath, projectFile, depth + 1);
      for (let k = 0; k < nested.lines.length; k++) {
        outLines.push(nested.lines[k]);
        origins.push(nested.origins[k]);
      }
      continue;
    }

    outLines.push(raw);
    origins.push({ file: file || sourcePath, line: li + 1 });
  }

  return { lines: outLines, origins };
}

// Recursively collect all included files
export function collectIncludeFiles(
  content: string,
  file?: string,
  sourcePath?: string,
  projectFile?: string,
  depth = 0,
  collected: Set<string> = new Set()
): Set<string>
{
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(`Include recursion too deep (>${MAX_INCLUDE_DEPTH}) when processing ${file || '<memory>'}`);
  }

  // Strip multiline comments before splitting into lines
  const cleanedContent = ext_utils.stripMultilineComments(content);
  const srcLines = cleanedContent.split(/\r?\n/);
  for (let li = 0; li < srcLines.length; li++) {
    const raw = srcLines[li];
    const trimmed = ext_utils.stripInlineComment(raw).trim();
    const m = trimmed.match(/^\.include\s+["']([^"']+)["']/i);
    if (!m) continue;

    const inc = m[1];
    const incPath = ext_utils.resolveIncludePath(inc, file, sourcePath, projectFile);
    if (!incPath) {
      throw new Error(`Failed to include '${inc}' at ${file || sourcePath || '<memory>'}:${li + 1} - ${inc}`);
    }
    let incText: string;
    try {
      incText = fs.readFileSync(incPath, 'utf8');
    } catch (err) {
      const em = err && (err as any).message ? (err as any).message : String(err);
      throw new Error(`Failed to include '${inc}' at ${file || sourcePath || '<memory>'}:${li + 1} - ${em}`);
    }

    collected.add(incPath);

    collectIncludeFiles(incText, incPath, sourcePath, projectFile, depth + 1, collected);
  }

  return collected;
}