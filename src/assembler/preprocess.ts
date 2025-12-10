import * as fs from 'fs';
import * as path from 'path';
import { SourceOrigin } from './types';
import { prepareMacros, expandMacroInvocations } from './macro';
import { expandLoopDirectives } from './loops';

const MAX_INCLUDE_DEPTH = 16;

export type PreprocessResult = {
  lines: string[];
  origins: SourceOrigin[];
  errors: string[];
};

function toErrorMessage(err: unknown): string {
  return err && (err as any).message ? (err as any).message : String(err);
}

function processContent(
  source: string,
  sourcePath?: string,
  depth = 0
): { lines: string[]; origins: SourceOrigin[] } {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(`Include recursion too deep (>${MAX_INCLUDE_DEPTH}) when processing ${sourcePath || '<memory>'}`);
  }
  const outLines: string[] = [];
  const origins: Array<{ file?: string; line: number }> = [];
  const srcLines = source.split(/\r?\n/);
  for (let li = 0; li < srcLines.length; li++) {
    const raw = srcLines[li];
    const trimmed = raw.replace(/\/\/.*$|;.*$/, '').trim();
    const includeMatch = trimmed.match(/^\.include\s+["']([^"']+)["']/i);
    if (includeMatch) {
      const inc = includeMatch[1];
      let incPath = inc;
      if (!path.isAbsolute(incPath)) {
        const baseDir = sourcePath ? path.dirname(sourcePath) : process.cwd();
        incPath = path.resolve(baseDir, incPath);
      }
      let incText: string;
      try {
        incText = fs.readFileSync(incPath, 'utf8');
      } catch (err) {
        throw new Error(`Failed to include '${inc}' at ${sourcePath || '<memory>'}:${li + 1} - ${toErrorMessage(err)}`);
      }
      const nested = processContent(incText, incPath, depth + 1);
      for (let k = 0; k < nested.lines.length; k++) {
        outLines.push(nested.lines[k]);
        origins.push(nested.origins[k]);
      }
      continue;
    }
    outLines.push(raw);
    origins.push({ file: sourcePath, line: li + 1 });
  }
  return { lines: outLines, origins };
}

export function preprocessSource(source: string, sourcePath?: string): PreprocessResult {
  let expanded: { lines: string[]; origins: SourceOrigin[] };
  try {
    expanded = processContent(source, sourcePath, 0);
  } catch (err: any) {
    return { lines: [], origins: [], errors: [err?.message || String(err)] };
  }

  const macroPrep = prepareMacros(expanded.lines, expanded.origins, sourcePath);
  if (macroPrep.errors.length) {
    return { lines: [], origins: expanded.origins, errors: macroPrep.errors };
  }

  const macroExpanded = expandMacroInvocations(macroPrep.lines, macroPrep.origins, macroPrep.macros, sourcePath);
  if (macroExpanded.errors.length) {
    return { lines: [], origins: macroExpanded.origins, errors: macroExpanded.errors };
  }

  const loopExpanded = expandLoopDirectives(macroExpanded.lines, macroExpanded.origins, sourcePath);
  if (loopExpanded.errors.length) {
    return { lines: [], origins: loopExpanded.origins, errors: loopExpanded.errors };
  }

  return { lines: loopExpanded.lines, origins: loopExpanded.origins, errors: [] };
}
