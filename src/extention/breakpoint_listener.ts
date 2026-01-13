import * as vscode from 'vscode';
import * as path from 'path';
import * as ext_utils from './utils';
import * as ext_prg from './project';

export async function breakpointListener(
  ev: vscode.BreakpointsChangeEvent,
  devectorOutput: vscode.OutputChannel)
{
  const pendingBreakpointAsmPaths = new Set<string>();
  let breakpointCompilePromise: Promise<void> = Promise.resolve();

  let suppressBreakpointValidation = false;

  if (suppressBreakpointValidation) {
    await ext_utils.writeBreakpointsForActiveEditor();
    return;
  }

  const invalidAdded = await ext_utils.findInvalidBreakpoints(devectorOutput, ev.added);
  if (invalidAdded.length) {
    ext_utils.reportInvalidBreakpointLine();
    try {
      suppressBreakpointValidation = true;
      vscode.debug.removeBreakpoints(invalidAdded);
    } finally {
      suppressBreakpointValidation = false;
    }
    await ext_utils.writeBreakpointsForActiveEditor();
    return;
  }

  // Only write tokens if we have an active asm editor
  await ext_utils.writeBreakpointsForActiveEditor();

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