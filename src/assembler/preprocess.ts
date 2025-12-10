import * as fs from 'fs';
import * as path from 'path';
import { SourceOrigin } from './types';
import { prepareMacros, expandMacroInvocations } from './macro';
import { expandLoopDirectives } from './loops';
import { errorMessage, stripInlineComment } from './utils';

const MAX_INCLUDE_DEPTH = 16;

export type PreprocessResult = {
  lines: string[];
  origins: SourceOrigin[];
  errors: string[];
};

function processContent(
  source: string,
  sourcePath?: string,
  depth = 0
): { lines: string[]; origins: SourceOrigin[] } {
  const outLines: string[] = [];
  const origins: SourceOrigin[] = [];
  if (depth > MAX_INCLUDE_DEPTH) {
    const recursionError = new Error(`Include recursion too deep (> ${MAX_INCLUDE_DEPTH}) when processing ${sourcePath || '<memory>'}`) as Error & { origins?: SourceOrigin[] };
    recursionError.origins = origins;
    throw recursionError;
  }
  const srcLines = source.split(/\r?\n/);
  for (let li = 0; li < srcLines.length; li++) {
    const raw = srcLines[li];
    const trimmed = stripInlineComment(raw).trim();
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
        const includeError = new Error(`Failed to include '${inc}' at ${sourcePath || '<memory>'}:${li + 1} - ${errorMessage(err)}`) as Error & { origins?: SourceOrigin[] };
        includeError.origins = origins;
        throw includeError;
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
  } catch (err: unknown) {
    const originContext = (err as { origins?: SourceOrigin[] } | undefined)?.origins;
    return { lines: [], origins: originContext || [], errors: [errorMessage(err)] };
  }

  const macroPrep = prepareMacros(expanded.lines, expanded.origins, sourcePath);
  if (macroPrep.errors.length) {
    return { lines: [], origins: macroPrep.origins, errors: macroPrep.errors };
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
