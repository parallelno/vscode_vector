import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as ext_utils from './utils';
import * as ext_prg from './project';
import * as ext_consts from './consts';

// Listener for breakpoint changes to trigger project recompilation.
// It's called on breakpoint add/remove events.
export async function breakpointListener(
  ev: vscode.BreakpointsChangeEvent,
  devectorOutput: vscode.OutputChannel)
{
  const pendingBreakpointAsmPaths = new Set<string>();
  let breakpointCompilePromise: Promise<void> = Promise.resolve();

  const invalidAdded = await findInvalidBreakpoints(devectorOutput, ev.added);
  if (invalidAdded.length) {
    ext_utils.reportInvalidBreakpointLine();
    try {
      vscode.debug.removeBreakpoints(invalidAdded);
    } catch (e) {}
    return;
  }

  // Only write tokens if we have an active asm editor
  await writeBreakpointsForActiveEditor();

  // schedule breakpoint project compile
  const asmPaths = ext_utils.collectAsmPathsFromEvent(ev);
  for (const p of asmPaths) {
      pendingBreakpointAsmPaths.add(path.resolve(p));
    }

    breakpointCompilePromise = breakpointCompilePromise.then(async () =>
    {
      if (!pendingBreakpointAsmPaths.size) return;

      const batch = new Set(pendingBreakpointAsmPaths);
      pendingBreakpointAsmPaths.clear();
      if (batch.size === 0) return;
      // compile only projects that own the affected asm paths
      await ext_prg.compileProjectsForBreakpointChanges(devectorOutput, batch);

    }).catch((err) => {
      ext_utils.logOutput(
        devectorOutput,
        'Devector: breakpoint-triggered project compile failed: ' +
        (err instanceof Error ? err.message : String(err)));
    });
}


// Helper to write breakpoints for the active asm editor into its tokens file
export async function writeBreakpointsForActiveEditor()
{
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const doc = ed.document;
  if (!doc || doc.isUntitled || !doc.fileName.endsWith('.asm')) return;
  const src = doc.getText();
  const mainPath = doc.fileName;
  try {
    let tokenPath: string;
    const outPath = mainPath.replace(/\.asm$/i, '.rom');
    if (/\.[^/.]+$/.test(outPath)) tokenPath = outPath.replace(/\.[^/.]+$/, ext_consts.DEBUG_FILE_SUFFIX);
    else tokenPath = outPath + ext_consts.DEBUG_FILE_SUFFIX;
    if (!fs.existsSync(tokenPath)) return;
    const tokenText = fs.readFileSync(tokenPath, 'utf8');
    const tokens = JSON.parse(tokenText);
    const projectDir = ext_utils.resolveProjectDirFromTokens(tokens, tokenPath) || path.dirname(mainPath);
    const projectFile = ext_utils.resolveProjectFileFromTokens(tokens, tokenPath);
    const included = ext_utils.findIncludedFiles(mainPath, src, new Set<string>(), 0, mainPath, projectFile);
    tokens.breakpoints = {};
    const fileKeyToPaths = new Map<string, Set<string>>();
    for (const f of Array.from(included)) {
      const key = ext_utils.normalizeDebugFileKey(f, projectDir);
      if (!key) continue;
      let s = fileKeyToPaths.get(key);
      if (!s) { s = new Set(); fileKeyToPaths.set(key, s); }
      s.add(path.resolve(f));
    }
    const allBps = vscode.debug.breakpoints;
    for (const bp of allBps) {
      if ((bp as vscode.SourceBreakpoint).location) {
        const srcBp = bp as vscode.SourceBreakpoint;
        const uri = srcBp.location.uri;
        if (!uri || uri.scheme !== 'file') continue;
        const bpPath = path.resolve(uri.fsPath);
        const bpKey = ext_utils.normalizeDebugFileKey(bpPath, projectDir);
        if (!bpKey || !fileKeyToPaths.has(bpKey)) continue;
        const pathsForBase = fileKeyToPaths.get(bpKey)!;
        if (!pathsForBase.has(bpPath)) continue;
        const lineNum = srcBp.location.range.start.line + 1;
        const entry = { line: lineNum, enabled: !!bp.enabled } as any;
        if (tokens.labels) {
          for (const [labelName, labInfo] of Object.entries(tokens.labels)) {
            try {
              const labelKey = ext_utils.normalizeDebugFileKey((labInfo as any).src, projectDir);
              if (labelKey && labelKey === bpKey && (labInfo as any).line === lineNum) {
                entry.label = labelName;
                entry.addr = (labInfo as any).addr;
                break;
              }
            } catch (e) {}
          }
        }
        ext_utils.attachAddressFromTokens(tokens, bpPath, lineNum, entry, tokenPath);
        if (!tokens.breakpoints[bpKey]) tokens.breakpoints[bpKey] = [];
        tokens.breakpoints[bpKey].push(entry);
      }
    }
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 4), 'utf8');
  } catch (e) {
    console.error('writeBreakpointsForActiveEditor failed:', e);
  }
}

// Find invalid breakpoints in the given list of breakpoints.
// A breakpoint is invalid if it's set on a line that is not valid for breakpoints
// (e.g., empty line, comment-only line, data directive, etc.)
// Only .asm files are considered.
// Returns the list of invalid source breakpoints.
export async function findInvalidBreakpoints(
  devectorOutput: vscode.OutputChannel,
  items?: readonly vscode.Breakpoint[])
  : Promise<vscode.SourceBreakpoint[]>
{
  const invalid: vscode.SourceBreakpoint[] = [];
  if (!items) return invalid;
  for (const bp of items) {
    if (!(bp instanceof vscode.SourceBreakpoint)) continue;
    const uri = bp.location?.uri;
    if (!uri || uri.scheme !== 'file') continue;
    if (!uri.fsPath.toLowerCase().endsWith('.asm')) continue;
    const doc = await ext_utils.openDocument(devectorOutput, uri);
    if (!doc) continue;
    const line = bp.location.range.start.line;
    if (!ext_utils.isAsmBreakpointLine(doc, line)) invalid.push(bp);
  }
  return invalid;
}