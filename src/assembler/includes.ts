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
      let incText: string;
      
      if (!path.isAbsolute(incPath)) {
        // First try: resolve relative to the current file
        const currentFileDir = file ? path.dirname(file) : (sourcePath ? path.dirname(sourcePath) : process.cwd());
        const firstAttempt = path.resolve(currentFileDir, incPath);
        
        try {
          incText = fs.readFileSync(firstAttempt, 'utf8');
          incPath = firstAttempt;
        } catch (err) {
          // Second try: resolve relative to the project root (sourcePath directory)
          if (sourcePath && file && path.dirname(file) !== path.dirname(sourcePath)) {
            const projectRoot = path.dirname(sourcePath);
            const secondAttempt = path.resolve(projectRoot, incPath);
            try {
              incText = fs.readFileSync(secondAttempt, 'utf8');
              incPath = secondAttempt;
            } catch (err2) {
              // Both attempts failed, throw error with info about both attempts
              const em = err && (err as any).message ? (err as any).message : String(err);
              throw new Error(`Failed to include '${inc}' at ${file || sourcePath || '<memory>'}:${li+1} - ${em}`);
            }
          } else {
            // No project root to try, throw the original error
            const em = err && (err as any).message ? (err as any).message : String(err);
            throw new Error(`Failed to include '${inc}' at ${file || sourcePath || '<memory>'}:${li+1} - ${em}`);
          }
        }
      } else {
        // Absolute path - just read it
        try {
          incText = fs.readFileSync(incPath, 'utf8');
        } catch (err) {
          const em = err && (err as any).message ? (err as any).message : String(err);
          throw new Error(`Failed to include '${inc}' at ${file || sourcePath || '<memory>'}:${li+1} - ${em}`);
        }
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

// Recursively collect all included files
export function collectIncludeFiles(
  content: string,
  file?: string,
  sourcePath?: string,
  depth = 0,
  collected: Set<string> = new Set()
): Set<string>
{
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(`Include recursion too deep (>${MAX_INCLUDE_DEPTH}) when processing ${file || '<memory>'}`);
  }

  const srcLines = content.split(/\r?\n/);
  for (let li = 0; li < srcLines.length; li++) {
    const raw = srcLines[li];
    const trimmed = raw.replace(/\/\/.*$|;.*$/, '').trim();
    const m = trimmed.match(/^\.include\s+["']([^"']+)["']/i);
    if (!m) continue;

    const inc = m[1];
    let incPath = inc;
    let incText: string;
    
    if (!path.isAbsolute(incPath)) {
      // First try: resolve relative to the current file
      const currentFileDir = file ? path.dirname(file) : (sourcePath ? path.dirname(sourcePath) : process.cwd());
      const firstAttempt = path.resolve(currentFileDir, incPath);
      
      try {
        incText = fs.readFileSync(firstAttempt, 'utf8');
        incPath = firstAttempt;
      } catch (err) {
        // Second try: resolve relative to the project root (sourcePath directory)
        if (sourcePath && file && path.dirname(file) !== path.dirname(sourcePath)) {
          const projectRoot = path.dirname(sourcePath);
          const secondAttempt = path.resolve(projectRoot, incPath);
          try {
            incText = fs.readFileSync(secondAttempt, 'utf8');
            incPath = secondAttempt;
          } catch (err2) {
            // Both attempts failed, throw error
            const em = err && (err as any).message ? (err as any).message : String(err);
            throw new Error(`Failed to include '${inc}' at ${file || sourcePath || '<memory>'}:${li + 1} - ${em}`);
          }
        } else {
          // No project root to try, throw the original error
          const em = err && (err as any).message ? (err as any).message : String(err);
          throw new Error(`Failed to include '${inc}' at ${file || sourcePath || '<memory>'}:${li + 1} - ${em}`);
        }
      }
    } else {
      // Absolute path - just read it
      try {
        incText = fs.readFileSync(incPath, 'utf8');
      } catch (err) {
        const em = err && (err as any).message ? (err as any).message : String(err);
        throw new Error(`Failed to include '${inc}' at ${file || sourcePath || '<memory>'}:${li + 1} - ${em}`);
      }
    }

    collected.add(incPath);

    collectIncludeFiles(incText, incPath, sourcePath, depth + 1, collected);
  }

  return collected;
}