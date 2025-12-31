import * as vscode from 'vscode';
import * as ext_prg from './project';

export async function compileDependencies(
  devectorOutput: vscode.OutputChannel,
  context: vscode.ExtensionContext)
: Promise<void>
{
  const selected = await ext_prg.pickProject(devectorOutput);
  if (!selected) return;

  await ext_prg.compileProjectFile(devectorOutput, selected, {
    silent: false,
    reason: 'command dependencies',
    includeDependencies: true,
    skipMain: true,
  });
}

////////////////////////////////////////////////////////////////////////////////
//
// ANYTHING BELOW UNCHECKED YET
//
////////////////////////////////////////////////////////////////////////////////
