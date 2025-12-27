import * as fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import * as ext_utils from './utils';
import { DEBUG_FILE_SUFFIX } from './consts';
import { assemble } from '../assembler/assembler';
import { createAssembleAndWrite } from '../assembler/assemble_write';


/**
 * Updates the debug file with current breakpoints without recompiling the assembly source.
 * This is used when only breakpoints changed but the assembly source files remain unchanged.
 */
export async function updateBreakpointsInDebugFile(
  devectorOutput: vscode.OutputChannel,
  srcPath: string,
  contents: string,
  debugPath: string)
  : Promise<boolean>
{
  if (!srcPath || !debugPath) return false;
  if (!fs.existsSync(debugPath)) return false;

  try {
    const includedFiles = new Set<string>(Array.from(ext_utils.findIncludedFiles(srcPath, contents)));
    const tokenText = fs.readFileSync(debugPath, 'utf8');
    const tokens = JSON.parse(tokenText);
    tokens.breakpoints = {};
    
    const basenameToPaths = new Map<string, Set<string>>();
    for (const f of Array.from(includedFiles)) {
      const b = path.basename(f);
      let s = basenameToPaths.get(b);
      if (!s) { s = new Set(); basenameToPaths.set(b, s); }
      s.add(path.resolve(f));
    }

    const allBps = vscode.debug.breakpoints;
    for (const bp of allBps) {
      if ((bp as vscode.SourceBreakpoint).location) {
        const srcBp = bp as vscode.SourceBreakpoint;
        const uri = srcBp.location.uri;
        if (!uri || uri.scheme !== 'file') continue;
        const bpPath = path.resolve(uri.fsPath);
        const bpBase = path.basename(bpPath);
        if (!basenameToPaths.has(bpBase)) continue;
        const pathsForBase = basenameToPaths.get(bpBase)!;
        if (!pathsForBase.has(bpPath)) continue;
        const lineNum = srcBp.location.range.start.line + 1;
        const entry = { line: lineNum, enabled: !!bp.enabled } as any;
        if (tokens.labels) {
          for (const [labelName, labInfo] of Object.entries(tokens.labels)) {
            try {
              if ((labInfo as any).src && (labInfo as any).src === bpBase && (labInfo as any).line === lineNum) {
                entry.label = labelName;
                entry.addr = (labInfo as any).addr;
                break;
              }
            } catch (e) {}
          }
          ext_utils.attachAddressFromTokens(tokens, bpPath, lineNum, entry);
        }
        if (!tokens.breakpoints[bpBase]) tokens.breakpoints[bpBase] = [];
        tokens.breakpoints[bpBase].push(entry);
      }
    }
    
    fs.writeFileSync(debugPath, JSON.stringify(tokens, null, 4), 'utf8');
    let cnt = 0;
    for (const v of Object.values(tokens.breakpoints || {})) cnt += (v as any[]).length;
    ext_utils.logOutput(devectorOutput, `Devector: Updated ${cnt} breakpoint(s) in ${debugPath} (no recompilation)`, true);
    return true;
  } catch (err) {
    console.error('Failed to update breakpoints in debug file:', err);
    return false;
  }
}


export async function compileAsmSource(
  devectorOutput: vscode.OutputChannel,
  srcPath: string,
  contents: string,
  outPath: string,
  debugPath?: string,
  projectFile?: string)
  : Promise<boolean>
{
  if (!srcPath) return false;
  const writer = createAssembleAndWrite(assemble, projectFile);
  const writeRes = writer(contents, outPath, srcPath, debugPath);
  ext_utils.emitPrintMessages(devectorOutput, writeRes.printMessages);
  ext_utils.emitWarnings(devectorOutput, writeRes.warnings);

  if (!writeRes.success)
  {
    if (writeRes.errors && writeRes.errors.length) {
      const summaries: string[] = [];
      const seen = new Set<string>();
      for (const e of writeRes.errors) {
        const summary = (typeof e === 'string' ? e : String(e)).trim();
        if (!summary || seen.has(summary)) continue;
        seen.add(summary);
        summaries.push(summary);
      }
      ext_utils.logOutput(devectorOutput, '\nDevector: Compilation failed:', true);
      for (const summary of summaries) {
        ext_utils.logOutput(devectorOutput, summary);
      }
    } else {
      ext_utils.logOutput(devectorOutput, '\nDevector: Compilation failed: Assemble failed', true);
    }
    return false;
  }
  const timeMsg = (writeRes as any).timeMs !== undefined ? `${(writeRes as any).timeMs}` : '';
  ext_utils.logOutput(devectorOutput, `Devector: Compilation succeeded to ${path.basename(outPath)} in ${timeMsg} ms`, true);
  try {
    const includedFiles = new Set<string>(Array.from(ext_utils.findIncludedFiles(srcPath, contents)));
    let tokenPath: string;
    if (debugPath) {
      tokenPath = debugPath;
    } else if (/\.[^/.]+$/.test(outPath)) {
      tokenPath = outPath.replace(/\.[^/.]+$/, DEBUG_FILE_SUFFIX);
    } else {
      tokenPath = outPath + DEBUG_FILE_SUFFIX;
    }
    if (fs.existsSync(tokenPath)) {
      try {
        const tokenText = fs.readFileSync(tokenPath, 'utf8');
        const tokens = JSON.parse(tokenText);
        tokens.breakpoints = {};
        const basenameToPaths = new Map<string, Set<string>>();
        for (const f of Array.from(includedFiles)) {
          const b = path.basename(f);
          let s = basenameToPaths.get(b);
          if (!s) { s = new Set(); basenameToPaths.set(b, s); }
          s.add(path.resolve(f));
        }

        const allBps = vscode.debug.breakpoints;
        for (const bp of allBps) {
          if ((bp as vscode.SourceBreakpoint).location) {
            const srcBp = bp as vscode.SourceBreakpoint;
            const uri = srcBp.location.uri;
            if (!uri || uri.scheme !== 'file') continue;
            const bpPath = path.resolve(uri.fsPath);
            const bpBase = path.basename(bpPath);
            if (!basenameToPaths.has(bpBase)) continue;
            const pathsForBase = basenameToPaths.get(bpBase)!;
            if (!pathsForBase.has(bpPath)) continue;
            const lineNum = srcBp.location.range.start.line + 1;
            const entry = { line: lineNum, enabled: !!bp.enabled } as any;
            if (tokens.labels) {
              for (const [labelName, labInfo] of Object.entries(tokens.labels)) {
                try {
                  if ((labInfo as any).src && (labInfo as any).src === bpBase && (labInfo as any).line === lineNum) {
                    entry.label = labelName;
                    entry.addr = (labInfo as any).addr;
                    break;
                  }
                } catch (e) {}
              }
              ext_utils.attachAddressFromTokens(tokens, bpPath, lineNum, entry);
            }
            if (!tokens.breakpoints[bpBase]) tokens.breakpoints[bpBase] = [];
            tokens.breakpoints[bpBase].push(entry);
          }
        }
        try {
          fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 4), 'utf8');
          let cnt = 0;
          for (const v of Object.values(tokens.breakpoints || {})) cnt += (v as any[]).length;
          ext_utils.logOutput(devectorOutput, `Devector: Saved ${cnt} breakpoint(s) into ${tokenPath}`, true);
        } catch (err) {
          console.error('Failed to write breakpoints into token file:', err);
        }
      } catch (err) {
        console.error('Failed to read token file for writing breakpoints:', err);
      }
    }
  } catch (err) {
    console.error('Failed to gather editor breakpoints during compile:', err);
  }
  return true;
}
