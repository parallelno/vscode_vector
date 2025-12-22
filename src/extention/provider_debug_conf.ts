import * as vscode from 'vscode';
import * as fs from 'fs';
import * as ext_prg from './project';
import * as ext_consts from './consts';
import { openEmulatorPanel } from '../emulatorUI';

export function provideDebugConfigurations(
  folder: vscode.WorkspaceFolder | undefined,
  token?: vscode.CancellationToken)
  : vscode.ProviderResult<vscode.DebugConfiguration[]>
{
  return [
    { type: ext_consts.EXTENTION_NAME, request: 'launch', name: ext_consts.VS_CODE_LAUNCH_RUN, run: true, compile: false },
    { type: ext_consts.EXTENTION_NAME, request: 'launch', name: ext_consts.VS_CODE_LAUNCH_COMPILE_AND_RUN, run: true, compile: true }
  ];
}


export async function resolveDebugConfiguration(
  devectorOutput: vscode.OutputChannel,
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder | undefined,
  config: vscode.DebugConfiguration,
  token?: vscode.CancellationToken)
  : Promise<vscode.DebugConfiguration | undefined>
{

  if (config){
    let selected = await ext_prg.pickProject(devectorOutput);
    if (!selected) return undefined;

    const ready = await ext_prg.ensureRomReady(
      devectorOutput, selected,
      { compile: !!config.compile ||
        config.name === ext_consts.VS_CODE_LAUNCH_COMPILE_AND_RUN }
    );
    if (!ready) {
      if (!fs.existsSync(selected.absolute_rom_path!)) {
        vscode.window.showErrorMessage(`File not found: ${selected.absolute_rom_path!}`);
      }
      return undefined;
    }

    if (config.run) {
      await openEmulatorPanel(context, devectorOutput, selected);
    }
    return config;
  }
  return config;
}

////////////////////////////////////////////////////////////////////////////////
//
// ANYTHING BELOW UNCHECKED YET
//
////////////////////////////////////////////////////////////////////////////////
