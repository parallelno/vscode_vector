import * as vscode from 'vscode';
import * as ext_prg from './project';
import * as ext_consts from './consts';


export async function runProject(
	devectorOutput: vscode.OutputChannel,
	context: vscode.ExtensionContext)
: Promise<void>
{
	const selected = await ext_prg.pickProject(devectorOutput);
	if (!selected) return;

	// Mirror the standard launch config so the VS Code debug toolbar shows.
	await vscode.debug.startDebugging(undefined, {
		type: ext_consts.EXTENTION_NAME,
		request: 'launch',
		name: ext_consts.VS_CODE_LAUNCH_RUN,
		run: true,
		compile: false,
		compileDependencies: false,
		projectPath: selected.absolute_path
	});
}

////////////////////////////////////////////////////////////////////////////////
//
// ANYTHING BELOW UNCHECKED YET
//
////////////////////////////////////////////////////////////////////////////////
