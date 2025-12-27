import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as ext_utils from './utils';
import * as ext_types from './project_info';
import { compileAsmSource, updateBreakpointsInDebugFile } from './compile';
import { reloadEmulatorBreakpointsFromFile } from '../emulatorUI';
import * as ext_consts from './consts';
import { collectIncludeFiles } from '../assembler/includes';


export async function loadAllProjects(
	devectorOutput: vscode.OutputChannel,
	workspaceRoot: string, opts: { silent?: boolean } = {})
	: Promise<ext_types.ProjectInfo[]>
{
	const paths = findAllProjectPaths(workspaceRoot);

  let projects: ext_types.ProjectInfo[] = [];

	for (const path of paths) {
		const project = await ext_types.ProjectInfo.createFromFile(path);
		if (project) projects.push(project);
	}
	return projects;
}


function findAllProjectPaths(workspaceRoot: string)
: string[]
{
	const results: string[] = [];
  try {
    const stat = fs.statSync(workspaceRoot);
    if (!stat.isDirectory()) return [];

    for (const entry of fs.readdirSync(workspaceRoot))
    {
      if (!entry.toLowerCase().endsWith(ext_consts.PROJECT_FILE_SUFFIX)) continue;

      const full = path.join(workspaceRoot, entry);
      results.push(full);
    }
  } catch (_) {
    // Ignore errors
  }
	return results;
}


export async function pickProject(
  devectorOutput: vscode.OutputChannel)
: Promise<ext_types.ProjectInfo | undefined>
{
  if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) {
    devectorOutput.appendLine('Devector: No workspace folder is open. Cannot find project.');
    vscode.window.showErrorMessage(`Cannot find project. Do 'File/Open Folder...' first.`);
    return undefined;
  }
  const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const projects = await loadAllProjects(devectorOutput, workspaceRoot, { silent: true });

  if (!projects.length) {
    vscode.window.showErrorMessage(
      `No *${ext_consts.PROJECT_FILE_SUFFIX} files found in the current workspace folder.`);
    return undefined;
  }

  let selected = projects[0];
  if (projects.length > 1)
  {
    const picks = projects.map((project) => ({
      label: project.name,
      description: path.relative(workspaceRoot, project.absolute_path!) ||
                                 project.absolute_path!,
      detail: project.programPath,
      target: project
    }));
    const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Select a project' });
    if (!pick) return undefined;
    selected = pick.target;
  }
  return selected;
}


export async function ensureRomReady(
  devectorOutput: vscode.OutputChannel,
  project: ext_types.ProjectInfo,
  options: { compile?: boolean } = {})
: Promise<boolean>
{
  const reason = options.compile ?
    ext_consts.VS_CODE_LAUNCH_COMPILE_AND_RUN :
    ext_consts.VS_CODE_LAUNCH_RUN;

  if (!options.compile)
  {
    if (fs.existsSync(project.absolute_rom_path!)) return true;

    const action = await vscode.window.showWarningMessage(
      `ROM file not found. Compile '${project.name}' project?`,
      'Compile',
      'Cancel'
    );
    if (action !== 'Compile') return false;
  }

  const compiled = await compileProjectFile(devectorOutput, project, { silent: false, reason: reason });
  if (!compiled) return false;

  reloadEmulatorBreakpointsFromFile();
  return fs.existsSync(project.absolute_rom_path!);
};


export async function compileProjectFile(
  devectorOutput: vscode.OutputChannel,
  project: ext_types.ProjectInfo,
  options: { silent?: boolean; reason?: string } = {})
	: Promise<boolean>
{
  if (!project.absolute_asm_path || !fs.existsSync(project.absolute_asm_path!)) {
    const msg = `Main assembly file not found or 'asm_path' project field is invalid. `+
                `Project path: ${project.absolute_path!}`;

    if (!options.silent) vscode.window.showErrorMessage(msg);
    else ext_utils.logOutput(devectorOutput, 'Devector: ' + msg);
    return false;
  }

  let contents: string;
  try {
    contents = fs.readFileSync(project.absolute_asm_path!, 'utf8');
  } catch (err) {
    const msg = `Failed to read ${project.absolute_asm_path!}: ${err instanceof Error ? err.message : String(err)}`;
    if (!options.silent) vscode.window.showErrorMessage(msg);
    else ext_utils.logOutput(devectorOutput, 'Devector: ' + msg);
    return false;
  }

  project.init_rom_path();

  if (!project.absolute_rom_path) {
    const msg = `'romPath' project field is invalid. Project path: ${project.absolute_path!}`;
    if (!options.silent) vscode.window.showErrorMessage(msg);
    else ext_utils.logOutput(devectorOutput, 'Devector: ' + msg);
    return false;
  }

  const romDir = path.dirname(project.absolute_rom_path!);

  if (!fs.existsSync(romDir)) {
    if (!options.silent) {
      const action = await vscode.window.showErrorMessage(
        `The directory for the output ROM does not exist: ${romDir}. `+
        `Do you want to create it?`,
        'Create Directory',
        'Cancel'
      );
      if (action === 'Create Directory') {
        try {
          fs.mkdirSync(romDir, { recursive: true });
        } catch (e) {
          vscode.window.showErrorMessage(`Failed to create directory: ${e}`);
          return false;
        }
      } else {
        return false;
      }
    } else {
      ext_utils.logOutput(
        devectorOutput, `Devector: Output directory missing: ${romDir}`);
      return false;
    }
  }

  project.init_debug_path();
  project.save();

  const success = await compileAsmSource(devectorOutput,
                                        project.absolute_asm_path!,
                                        contents,
                                        project.absolute_rom_path!,
                                        project.absolute_debug_path!,
                                        project.absolute_path!);
  if (!success) return false;

  const reason = options.reason ? ` (${options.reason})` : '';
  ext_utils.logOutput(
    devectorOutput,
    `Devector: Compiled project ${project.name} -> ${project.romPath}` + reason);

  if (!options.silent) {
    vscode.window.showInformationMessage(`Compiled ${project.name} to ${project.romPath}`
    );
  }

  // TODO: think of a better way to reload breakpoints
  reloadEmulatorBreakpointsFromFile();
  return true;
}

////////////////////////////////////////////////////////////////////////////////
//
// ANYTHING BELOW UNCHECKED YET
//
////////////////////////////////////////////////////////////////////////////////


/**
 * Checks if any assembly source files have been modified since the ROM file was last built.
 * Returns true if any .asm file is newer than the ROM file, false otherwise.
 */
function haveAsmFilesChanged(
  project: ext_types.ProjectInfo,
  asmFiles: Set<string>)
  : boolean
{
  if (!project.absolute_rom_path || !fs.existsSync(project.absolute_rom_path)) {
    // ROM doesn't exist, so we need to compile
    return true;
  }

  try {
    const romStat = fs.statSync(project.absolute_rom_path);
    const romMtime = romStat.mtimeMs;

    // Check if any assembly file is newer than the ROM
    for (const asmPath of asmFiles) {
      if (fs.existsSync(asmPath)) {
        const asmStat = fs.statSync(asmPath);
        if (asmStat.mtimeMs > romMtime) {
          return true;
        }
      }
    }
    return false;
  } catch (err) {
    // If we can't check, assume files changed to be safe
    console.error('Error checking file timestamps:', err);
    return true;
  }
}


export async function compileProjectsForBreakpointChanges(
  devectorOutput: vscode.OutputChannel,
  asmPaths: Set<string>)
{
  if (!asmPaths.size) return;
  if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) return;
  const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const infos = await loadAllProjects(devectorOutput, workspaceRoot, { silent: true });
  if (!infos.length) return;

  // Process only projects that own the affected asm paths
  for (const project of infos)
  {
    let shouldProcess = false;
    const mainsm = project.absolute_asm_path;
    if (!mainsm || !fs.existsSync(mainsm)) continue;

    const source = fs.readFileSync(mainsm, 'utf8');
    const asmFiles = collectIncludeFiles(source, mainsm);
    asmFiles.add(mainsm);
    
    // Check if any affected asm path is in the project
    for (const p of asmPaths) {
      if (asmFiles.has(p)) {
        shouldProcess = true;
        break;
      }
    }

    if (!shouldProcess) continue;

    // Check if assembly files have actually changed
    const filesChanged = haveAsmFilesChanged(project, asmFiles);
    
    if (filesChanged) {
      // Assembly files changed - do full compilation
      await compileProjectFile(devectorOutput, project, { silent: true, reason: 'breakpoint change' });
    } else {
      // Only breakpoints changed - just update debug file
      project.init_debug_path();
      if (project.absolute_debug_path && fs.existsSync(project.absolute_debug_path)) {
        await updateBreakpointsInDebugFile(
          devectorOutput,
          mainsm,
          source,
          project.absolute_debug_path
        );
        reloadEmulatorBreakpointsFromFile();
      } else {
        // Debug file doesn't exist, need full compilation
        await compileProjectFile(devectorOutput, project, { silent: true, reason: 'breakpoint change' });
      }
    }
  }
}
