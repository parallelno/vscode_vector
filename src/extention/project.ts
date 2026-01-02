import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as ext_utils from './utils';
import * as ext_types from './project_info';
import { compileAsmSource, updateBreakpointsInDebugFile } from './compile';
import { reloadEmulatorBreakpointsFromFile } from '../emulatorUI';
import * as ext_consts from './consts';
import { collectIncludeFiles } from '../assembler/includes';
import { buildFddImage } from '../tools/fddutil';


type CompileOptions = {
  silent?: boolean;
  reason?: string;
  visited?: Set<string>;
  includeDependencies?: boolean; // whether to compile dependent projects
  skipMain?: boolean;            // whether to skip compiling the main project
};


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
  options: { compile?: boolean; includeDependencies?: boolean } = {})
: Promise<boolean>
{
  const includeDependencies = options.includeDependencies ?? true;
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

  const compiled = await compileProjectFile(devectorOutput, project, {
    silent: false,
    reason: reason,
    includeDependencies,
    skipMain: false,
  });
  if (!compiled) return false;

  reloadEmulatorBreakpointsFromFile();
  return fs.existsSync(project.absolute_rom_path!);
};


function reportDependencyIssue(
  devectorOutput: vscode.OutputChannel,
  options: CompileOptions,
  message: string)
{
  if (!options.silent) vscode.window.showErrorMessage(message);
  else ext_utils.logOutput(devectorOutput, 'Devector: ' + message);
}


// Recursively compile dependent projects
async function compileDependentProjects(
  devectorOutput: vscode.OutputChannel,
  project: ext_types.ProjectInfo,
  options: CompileOptions,
  visited: Set<string>)
: Promise<boolean>
{
  const depsDir = project.absolute_dependent_projects_dir;
  if (!depsDir) return true;

  let dirStat: fs.Stats;
  try {
    dirStat = fs.statSync(depsDir);
  } catch (err) {
    const msg = `Dependent projects directory not found: ${depsDir}`;
    reportDependencyIssue(devectorOutput, options, msg);
    return false;
  }

  if (!dirStat.isDirectory()) {
    const msg = `Dependent projects path is not a directory: ${depsDir}`;
    reportDependencyIssue(devectorOutput, options, msg);
    return false;
  }

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(depsDir);
  } catch (err) {
    const msg = `Failed to read dependent projects directory: ${depsDir}`;
    reportDependencyIssue(devectorOutput, options, msg);
    return false;
  }

  const depProjectFiles = entries
    .filter((entry) => entry.toLowerCase().endsWith(ext_consts.PROJECT_FILE_SUFFIX))
    .map((entry) => path.join(depsDir, entry))
    .sort((a, b) => a.localeCompare(b));

  if (!depProjectFiles.length) return true;

  const normalizedCurrent = project.absolute_path
    ? ext_utils.normalizeFsPath(project.absolute_path)
    : '';

  for (const depPath of depProjectFiles) {
    const normalizedDepPath = ext_utils.normalizeFsPath(depPath);
    if (normalizedCurrent && normalizedDepPath === normalizedCurrent) continue;
    if (visited.has(normalizedDepPath)) continue;

    const depProject = await ext_types.ProjectInfo.createFromFile(depPath);
    if (depProject.error) {
      reportDependencyIssue(devectorOutput, options, depProject.error);
      return false;
    }

    const depReason = options.reason ? `${options.reason} dependency` : 'dependency';
    const compiled = await compileProjectFile(
      devectorOutput,
      depProject,
      {
        ...options,
        reason: depReason,
        visited,
        skipMain: false,
        includeDependencies: options.includeDependencies ?? true,
      });
    if (!compiled) return false;
  }

  return true;
}


export async function compileProjectFile(
  devectorOutput: vscode.OutputChannel,
  project: ext_types.ProjectInfo,
  options: CompileOptions = {})
	: Promise<boolean>
{
  if (!project.absolute_path || !path.isAbsolute(project.absolute_path)) {
    const msg = 'Project path is not set or is not absolute.';
    reportDependencyIssue(devectorOutput, options, msg);
    return false;
  }

  const visited = options.visited ?? new Set<string>();
  const normalizedProjectPath = ext_utils.normalizeFsPath(project.absolute_path);
  if (visited.has(normalizedProjectPath)) return true;
  visited.add(normalizedProjectPath);

  const includeDependencies = options.includeDependencies ?? true;
  const skipMain = options.skipMain ?? false;

  if (includeDependencies) {
    const depsCompiled = await compileDependentProjects(devectorOutput, project, options, visited);
    if (!depsCompiled) return false;
  }

  if (skipMain) {
    const reason = options.reason ? ` (${options.reason})` : '';
    const note = includeDependencies ? 'dependencies' : 'nothing';
    ext_utils.logOutput(
      devectorOutput,
      `Devector: Skipped main compilation for ${project.name}; ${note} done` + reason);
    if (!options.silent && includeDependencies) {
      vscode.window.showInformationMessage(`Compiled dependencies for ${project.name}`);
    }
    return true;
  }

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

  const alignValue = project.romAlign;
  if (typeof alignValue === 'number' && Number.isFinite(alignValue) && alignValue > 0) {
    try {
      const stat = fs.statSync(project.absolute_rom_path!);
      const remainder = stat.size % alignValue;
      if (remainder !== 0) {
        const pad = alignValue - remainder;
        fs.appendFileSync(project.absolute_rom_path!, Buffer.alloc(pad, 0));
        ext_utils.logOutput(
          devectorOutput,
          `Devector: Padded ROM to ${alignValue}-byte alignment (+${pad} bytes)`);
      }
    } catch (err) {
      ext_utils.logOutput(
        devectorOutput,
        `Devector: Failed to align ROM length: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const fddBuilt = buildProjectFddImage(devectorOutput, project);
  if (!fddBuilt) return false;

  const reason = options.reason ? ` (${options.reason})` : '';
  ext_utils.logOutput(
    devectorOutput,
    `Devector: Compiled project ${project.name} -> ${project.romPath}` + reason);

  if (!options.silent) {
    vscode.window.showInformationMessage(`Compiled ${project.name} to ${project.romPath}`
    );
  }

  reloadEmulatorBreakpointsFromFile();
  return true;
}

function collectFilesRecursively(root: string): { files: string[]; error?: string } {
  const files: string[] = [];
  const stack: string[] = [root];

  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { files: [], error: `Failed to read FDD content directory ${current}: ${message}` };
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return { files };
}

function buildProjectFddImage(
  devectorOutput: vscode.OutputChannel,
  project: ext_types.ProjectInfo)
: boolean
{
  const fddContentPath = project.absolute_fdd_content_path;
  if (!fddContentPath) return true;

  const fddOutputPath = project.absolute_fdd_path;
  if (!fddOutputPath) {
    ext_utils.logOutput(devectorOutput, 'Devector: fddPath is not set; skipping FDD image build');
    return false;
  }

  const templatePath = project.absolute_fdd_template_path;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(fddContentPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ext_utils.logOutput(devectorOutput, `Devector: FDD content folder is not accessible: ${fddContentPath} (${message})`);
    return false;
  }

  if (!stat.isDirectory()) {
    ext_utils.logOutput(devectorOutput, `Devector: FDD content path is not a directory: ${fddContentPath}`);
    return false;
  }

  const collected = collectFilesRecursively(fddContentPath);
  if (collected.error) {
    ext_utils.logOutput(devectorOutput, `Devector: ${collected.error}`);
    return false;
  }

  if (!collected.files.length) {
    ext_utils.logOutput(devectorOutput, `Devector: FDD content folder is empty: ${fddContentPath}`);
    return true;
  }

  const result = buildFddImage({
    templateFile: templatePath,
    inputFiles: collected.files,
    outputFile: fddOutputPath,
    log: (message: string) => ext_utils.logOutput(devectorOutput, message),
  });

  if (!result.success) {
    ext_utils.logOutput(devectorOutput, `Devector: Failed to build FDD image: ${result.error || 'Unknown error'}`);
    return false;
  }

  ext_utils.logOutput(
    devectorOutput,
    `Devector: Built FDD image ${path.basename(fddOutputPath)} with ${collected.files.length} file(s)`);
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
function latestMtime(paths: Array<string | undefined>): number | undefined {
  let latest: number | undefined;
  for (const p of paths) {
    if (!p) continue;
    try {
      const t = fs.statSync(p).mtimeMs;
      if (latest === undefined || t > latest) latest = t;
    } catch (_) {
      // ignore missing paths here; caller decides fallback
    }
  }
  return latest;
}

function haveAsmFilesChanged(
  project: ext_types.ProjectInfo,
  asmFiles: Set<string>)
  : boolean
{
  project.init_rom_path();
  project.init_debug_path();

  const latestBuild = latestMtime([
    project.absolute_rom_path,
    project.absolute_debug_path,
  ]);

  // If we have no build artifacts, play it safe and recompile
  if (latestBuild === undefined) return true;

  try {
    for (const asmPath of asmFiles) {
      const asmTime = fs.statSync(asmPath).mtimeMs;
      if (asmTime > latestBuild) {
        return true;
      }
    }
    return false;
  } catch (err) {
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
    project.init_asm_path();
    project.init_rom_path();
    project.init_debug_path();
    const mainsm = project.absolute_asm_path;
    if (!mainsm || !fs.existsSync(mainsm)) continue;

    const source = fs.readFileSync(mainsm, 'utf8');
    const asmFiles = collectIncludeFiles(source, mainsm, mainsm, project.absolute_path);
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
