import * as ext_utils from './utils';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as ext_consts from './consts';
import * as ext_types from './project_info';


export async function createProject(
	devectorOutput: vscode.OutputChannel,
	context: vscode.ExtensionContext)
: Promise<void>
{
	if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) {
		devectorOutput.appendLine('Devector: No workspace folder is open. Cannot create project.');
		vscode.window.showErrorMessage('Open a folder before creating a project.');
		return;
	}

	const name = await vscode.window.showInputBox({
		prompt: 'Project name',
		placeHolder: ext_consts.TEMPLATE_PROJECT_NAME,
		validateInput: (value) => value && value.trim().length > 0 ? undefined : 'Enter a project name'
	});
	if (!name) return;

	const safeName = ext_utils.sanitizeFileName(name, ext_consts.TEMPLATE_PROJECT_NAME);
	const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
	const absoluteProjectPath = path.join(workspaceRoot, safeName + ext_consts.PROJECT_FILE_SUFFIX);
	let project = new ext_types.ProjectInfo(absoluteProjectPath);
	if (project.error) {
		ext_utils.logOutput(
			devectorOutput,
			`Devector: ${project.error}`,
			true);
	}

	if (fs.existsSync(absoluteProjectPath)) {
		const overwrite = await vscode.window.showWarningMessage(
			`${path.basename(absoluteProjectPath)} already exists. Overwrite?`,
			{ modal: true },
			'Overwrite'
		);
		if (overwrite !== 'Overwrite') return;
	}
	try {
		project.init_asm_path();
		if (!fs.existsSync(project.absolute_asm_path!)) {
			const mainTemplate = ext_utils.readTemplateMainAsm(
				devectorOutput, context, ext_consts.TEMPLATE_MAIN_ASM_PATH);

			if (!mainTemplate) {
				vscode.window.showErrorMessage(
					`Failed to create ${ext_consts.MAIN_ASM} from template. Template not found.`);
				return;
			}
			fs.writeFileSync(project.absolute_asm_path!, mainTemplate, 'utf8');
			ext_utils.logOutput(devectorOutput, `Devector: Created ${project.asmPath} from template`, true);
		}

		project.save();
		ext_utils.logOutput(devectorOutput, `Devector: Created project file ${project.absolute_path}`, true);

		const runLaunchUpdated = ext_utils.initLaunchConfiguration(
			devectorOutput, workspaceRoot, project,
			{ configName: ext_consts.VS_CODE_LAUNCH_RUN, extraProps: { compile: false } });
		if (runLaunchUpdated) {
			ext_utils.logOutput(
				devectorOutput,
				`Devector: Inited '${ext_consts.VS_CODE_LAUNCH_RUN}' launch for ${project.name}`,
				true);
		}

		const compileLaunchUpdated = ext_utils.initLaunchConfiguration(
			devectorOutput, workspaceRoot, project,
			{ configName: ext_consts.VS_CODE_LAUNCH_COMPILE_AND_RUN, extraProps: { compile: true } });
		if (compileLaunchUpdated) {
			ext_utils.logOutput(
				devectorOutput,
				`Devector: Inited '${ext_consts.VS_CODE_LAUNCH_COMPILE_AND_RUN}' launch for ${project.name}`,
				true);
		}
		try {
			const doc = await vscode.workspace.openTextDocument(absoluteProjectPath);
			await vscode.window.showTextDocument(doc);
		} catch (_) {}
	} catch (err) {
		vscode.window.showErrorMessage('Failed to create project file: ' + (err instanceof Error ? err.message : String(err)));
	}
}

////////////////////////////////////////////////////////////////////////////////
//
// ANYTHING BELOW UNCHECKED YET
//
////////////////////////////////////////////////////////////////////////////////