import * as fs from 'fs';
import * as path from 'path';
import { SourceOrigin } from './types';

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
  depth = 0
): IncludeResult {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(`Include recursion too deep (>${MAX_INCLUDE_DEPTH}) when processing ${file || '<memory>'}`);
  }
  
  const outLines: string[] = [];
  const origins: Array<{ file?: string; line: number }> = [];
  const srcLines = content.split(/\r?\n/);
  
  for (let li = 0; li < srcLines.length; li++) {
    const raw = srcLines[li];
    const trimmed = raw.replace(/\/\/.*$|;.*$/, '').trim();
    
    // match .include "filename" or .include 'filename'
    const m = trimmed.match(/^\.include\s+["']([^"']+)["']/i);
    if (m) {
      const inc = m[1];
      // resolve path
      let incPath = inc;
      if (!path.isAbsolute(incPath)) {
        const baseDir = file ? path.dirname(file) : (sourcePath ? path.dirname(sourcePath) : process.cwd());
        incPath = path.resolve(baseDir, incPath);
      }
      
      let incText: string;
      try {
        incText = fs.readFileSync(incPath, 'utf8');
      } catch (err) {
        const em = err && (err as any).message ? (err as any).message : String(err);
        throw new Error(`Failed to include '${inc}' at ${file || sourcePath || '<memory>'}:${li+1} - ${em}`);
      }
      
      const nested = processIncludes(incText, incPath, sourcePath, depth + 1);
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
