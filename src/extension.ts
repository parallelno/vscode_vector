import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { assembleAndWrite } from './assembler';
import type { PrintMessage } from './assembler/types';
import { openEmulatorPanel, pauseEmulatorPanel, resumeEmulatorPanel, stepFramePanel, reloadEmulatorBreakpointsFromFile, resolveEmulatorHoverSymbol, isEmulatorPanelPaused, resolveDataDirectiveHover, resolveInstructionHover } from './emulatorUI';

export function activate(context: vscode.ExtensionContext) {
  const devectorOutput = vscode.window.createOutputChannel('Devector');
  context.subscriptions.push(devectorOutput);
  const logOutput = (message: string, reveal: boolean = false) => {
    try {
      devectorOutput.appendLine(message);
      if (reveal) devectorOutput.show(true);
    } catch (e) { /* ignore output channel errors */ }
  };

  const emitPrintMessages = (messages?: PrintMessage[]) => {
    if (!messages || !messages.length) return;
    for (const msg of messages) {
      let originLabel: string | undefined;
      if (msg.origin?.file) {
        const base = path.basename(msg.origin.file);
        if (msg.origin.line) originLabel = `${base}:${msg.origin.line}`;
        else originLabel = base;
      } else if (msg.origin?.line) {
        originLabel = `line ${msg.origin.line}`;
      } else if (msg.lineIndex) {
        originLabel = `line ${msg.lineIndex}`;
      }
      const prefix = originLabel ? `[.print ${originLabel}]` : '[.print]';
      const text = (msg.text ?? '').toString();
      logOutput(`${prefix} ${text}`, true);
    }
  };

  const emitWarnings = (warnings?: string[]) => {
    if (!warnings || !warnings.length) return;
    for (const warning of warnings) {
      logOutput(`Devector warning: ${warning}`, true);
    }
  };

  const readMainTemplate = (): string => {
    const templatePath = path.join(context.extensionPath, 'templates', 'main.asm');
    try {
      return fs.readFileSync(templatePath, 'utf8');
    } catch (err) {
      logOutput('Devector: Failed to read main.asm template, using fallback stub.', true);
      return '; main.asm template missing. Please recreate templates/main.asm.';
    }
  };

  // gather included files (resolve .include recursively)
  function findIncludedFiles(srcPath: string, content: string, out = new Set<string>(), depth = 0): Set<string> {
    if (!srcPath) return out;
    if (depth > 16) return out;
    out.add(path.resolve(srcPath));
    const lines = content.split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li];
      // strip comments
      const trimmed = raw.replace(/\/\/.*$|;.*$/, '').trim();
      const m = trimmed.match(/^\.include\s+["']([^"']+)["']/i);
      if (m) {
        let incPath = m[1];
        if (!path.isAbsolute(incPath)) {
          incPath = path.resolve(path.dirname(srcPath), incPath);
        }
        if (!out.has(path.resolve(incPath))) {
          // read file and recurse
          try {
            const incText = fs.readFileSync(incPath, 'utf8');
            findIncludedFiles(incPath, incText, out, depth + 1);
          } catch (err) {
            // ignore missing include here; assembler would've reported it.
          }
        }
      }
    }
    return out;
  }

  const reportInvalidBreakpointLine = () => {
    vscode.window.setStatusBarMessage('Breakpoints can only target label or instruction lines.', 3000);
  };

  const sanitizeFileName = (value: string | undefined, fallback: string): string => {
    const trimmed = (value || '').trim();
    if (!trimmed) return fallback;
    const safe = trimmed.replace(/[^A-Za-z0-9_-]+/g, '_');
    return safe.length ? safe : fallback;
  };

  const toWorkspaceVariablePath = (absoluteTarget: string, workspaceRoot: string | undefined): string => {
    if (!workspaceRoot) return absoluteTarget;
    try {
      const relative = path.relative(workspaceRoot, absoluteTarget);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return absoluteTarget;
      }
      const normalized = relative.split(path.sep).join('/');
      const workspaceToken = '${workspaceFolder}';
      return normalized ? `${workspaceToken}/${normalized}` : workspaceToken;
    } catch {
      return absoluteTarget;
    }
  };

  const resolveWorkspaceVariablePath = (value: string | undefined, workspaceRoot: string | undefined): string | undefined => {
    if (!value) return undefined;
    if (!workspaceRoot) return value;
    try {
      const replaced = value.replace(/\$\{workspaceFolder\}/g, workspaceRoot);
      return path.resolve(replaced);
    } catch {
      return value;
    }
  };

  const ensureLaunchConfiguration = (workspaceRoot: string, romAbsolutePath: string, opts: { configName?: string; extraProps?: Record<string, any> } = {}): boolean => {
    if (!workspaceRoot) return false;
    const vscodeDir = path.join(workspaceRoot, '.vscode');
    const launchPath = path.join(vscodeDir, 'launch.json');
    const desiredName = opts.configName || 'Run ROM';
    const workspaceProgramPath = toWorkspaceVariablePath(romAbsolutePath, workspaceRoot);
    const enforcedProps = { runProjectRom: true, ...(opts.extraProps || {}) } as Record<string, any>;

    let launchData: { version?: string; configurations?: any[] } = { version: '0.2.0', configurations: [] };
    let dirty = false;

    if (fs.existsSync(launchPath)) {
      try {
        const raw = fs.readFileSync(launchPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          launchData = parsed;
        }
      } catch (err) {
        logOutput('Devector: Failed to parse existing launch.json, recreating.');
        dirty = true;
      }
    } else {
      dirty = true;
    }

    if (!Array.isArray(launchData.configurations)) {
      launchData.configurations = [];
      dirty = true;
    }

    if (!launchData.version) {
      launchData.version = '0.2.0';
      dirty = true;
    }

    const configs = launchData.configurations as any[];
    let targetConfig = configs.find((cfg) => cfg && cfg.name === desiredName);

    const resolvedProgram = resolveWorkspaceVariablePath(targetConfig?.program, workspaceRoot);
    if (targetConfig) {
      if (resolvedProgram !== romAbsolutePath || targetConfig.type !== 'i8080' || targetConfig.request !== 'launch') {
        targetConfig.type = 'i8080';
        targetConfig.request = 'launch';
        targetConfig.program = workspaceProgramPath;
        dirty = true;
      }
      for (const [key, value] of Object.entries(enforcedProps)) {
        if (targetConfig[key] !== value) {
          targetConfig[key] = value;
          dirty = true;
        }
      }
    } else {
      targetConfig = {
        name: desiredName,
        type: 'i8080',
        request: 'launch',
        program: workspaceProgramPath
      } as any;
      for (const [key, value] of Object.entries(enforcedProps)) {
        targetConfig[key] = value;
      }
      configs.push(targetConfig);
      dirty = true;
    }

    if (!dirty) return false;

    try {
      if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir, { recursive: true });
      }
      fs.writeFileSync(launchPath, JSON.stringify(launchData, null, 4), 'utf8');
      return true;
    } catch (err) {
      logOutput('Devector: Failed to write launch.json: ' + (err instanceof Error ? err.message : String(err)), true);
      return false;
    }
  };

  const isAsmBreakpointLine = (doc: vscode.TextDocument, line: number): boolean => {
    if (!doc || line < 0 || line >= doc.lineCount) return false;
    const text = doc.lineAt(line).text;
    const trimmed = text.trim();
    if (!trimmed.length) return false;
    if (trimmed.startsWith(';') || trimmed.startsWith('//')) return false;
    if (trimmed.startsWith('.')) return false;
    return true;
  };

  const normalizeFsPath = (value: string) => {
    try {
      return path.resolve(value).replace(/\\/g, '/').toLowerCase();
    } catch {
      return value.toLowerCase();
    }
  };

  const getOpenDocumentByFsPath = (fsPath: string): vscode.TextDocument | undefined => {
    const target = normalizeFsPath(fsPath);
    return vscode.workspace.textDocuments.find((doc) => normalizeFsPath(doc.uri.fsPath) === target);
  };

  const ensureDocument = async (uri: vscode.Uri): Promise<vscode.TextDocument | undefined> => {
    const existing = getOpenDocumentByFsPath(uri.fsPath);
    if (existing) return existing;
    try {
      return await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      logOutput('Devector: Failed to open document for breakpoint validation: ' + (err instanceof Error ? err.message : String(err)));
      return undefined;
    }
  };

  const lookupLineAddress = (tokens: any, filePath: string, line: number): string | undefined => {
    if (!tokens || !tokens.lineAddresses) return undefined;
    const base = path.basename(filePath).toLowerCase();
    const perFile = tokens.lineAddresses[base];
    if (!perFile) return undefined;
    const keyDirect = perFile[line];
    if (typeof keyDirect === 'string' && keyDirect) return keyDirect;
    const keyString = perFile[String(line)];
    if (typeof keyString === 'string' && keyString) return keyString;
    return undefined;
  };

  const attachAddressFromTokens = (tokens: any, filePath: string, line: number, entry: Record<string, any>) => {
    if (!entry || entry.addr) return;
    const addr = lookupLineAddress(tokens, filePath, line);
    if (addr) entry.addr = addr;
  };
  async function compileAsmSource(srcPath: string, contents: string, options: { outPath?: string; debugPath?: string } = {}): Promise<boolean> {
    if (!srcPath) return false;
    const outPath = options.outPath || srcPath.replace(/\.asm$/i, '.rom');
    const writeRes = assembleAndWrite(contents, outPath, srcPath, options.debugPath);
    emitPrintMessages(writeRes.printMessages);
    emitWarnings(writeRes.warnings);
    if (!writeRes.success) {
      const summarizeError = (raw: string): string => {
        const firstLine = raw.split(/\r?\n/)[0]?.trim() || raw.trim();
        return firstLine.replace(/ at \d+.*$/, '').trim();
      };
      if (writeRes.errors && writeRes.errors.length) {
        const summaries: string[] = [];
        const seen = new Set<string>();
        for (const e of writeRes.errors) {
          const summary = summarizeError(typeof e === 'string' ? e : String(e));
          if (!summary || seen.has(summary)) continue;
          seen.add(summary);
          summaries.push(summary);
        }
        logOutput('Devector: Compilation failed:', true);
        for (const summary of summaries) {
          logOutput(summary);
        }
      } else {
        logOutput('Devector: Compilation failed: Assemble failed', true);
      }
      return false;
    }
    const timeMsg = (writeRes as any).timeMs !== undefined ? `${(writeRes as any).timeMs}` : '';
    logOutput(`Devector: Compilation succeeded to ${path.basename(outPath)} in ${timeMsg} ms`, true);
    try {
      const includedFiles = new Set<string>(Array.from(findIncludedFiles(srcPath, contents)));
      let tokenPath: string;
      if (options.debugPath) {
        tokenPath = options.debugPath;
      } else if (/\.[^/.]+$/.test(outPath)) {
        tokenPath = outPath.replace(/\.[^/.]+$/, '.debug.json');
      } else {
        tokenPath = outPath + '.debug.json';
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
                attachAddressFromTokens(tokens, bpPath, lineNum, entry);
              }
              if (!tokens.breakpoints[bpBase]) tokens.breakpoints[bpBase] = [];
              tokens.breakpoints[bpBase].push(entry);
            }
          }
          try {
            fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 4), 'utf8');
            let cnt = 0;
            for (const v of Object.values(tokens.breakpoints || {})) cnt += (v as any[]).length;
            logOutput(`Devector: Saved ${cnt} breakpoint(s) into ${tokenPath}`, true);
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

  const compileCommand = vscode.commands.registerCommand('i8080.compile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showErrorMessage('Open an .asm file to compile'); return; }
    const doc = editor.document;
    if (!doc.fileName.endsWith('.asm')) { vscode.window.showWarningMessage('File does not have .asm extension, still attempting to assemble.'); }
    await compileAsmSource(doc.fileName, doc.getText());
  });

  context.subscriptions.push(compileCommand);

  type ProjectInfo = {
    projectPath: string;
    name: string;
    mainPath?: string;
    outputBase: string;
    romName: string;
    fddName?: string;
    /** Optional project settings */
    settings?: {
      /** Emulation speed multiplier (e.g., 1, 2, 4) or 'max' for maximum speed */
      speed?: number | 'max';
      /** View mode for display rendering: 'full' (768×312) or 'noBorder' (256×192 4:3 aspect) */
      viewMode?: 'full' | 'noBorder';
      /** Path to the RAM disk data file for persistence */
      ramDiskDataPath?: string;
      /** Path to the FDD data file for persistence */
      fddDataPath?: string;
    };
  };

  function findProjectJsonFiles(workspaceRoot: string): string[] {
    const candidates = [
      path.join(workspaceRoot, 'test', 'project'),
      path.join(workspaceRoot, 'project'),
      workspaceRoot
    ];
    const results: string[] = [];
    const seen = new Set<string>();
    for (const folder of candidates) {
      try {
        const stat = fs.statSync(folder);
        if (!stat.isDirectory()) continue;
        const entries = fs.readdirSync(folder);
        for (const entry of entries) {
          if (!entry.toLowerCase().endsWith('.project.json')) continue;
          const full = path.join(folder, entry);
          if (seen.has(full)) continue;
          seen.add(full);
          results.push(full);
        }
      } catch (_) {
        continue;
      }
    }
    return results;
  }

  function readProjectInfo(projectPath: string, opts: { quiet?: boolean } = {}): ProjectInfo | undefined {
    try {
      const text = fs.readFileSync(projectPath, 'utf8');
      const data = JSON.parse(text);
      const rawName = typeof data?.name === 'string' && data.name.trim().length ? data.name.trim() : path.basename(projectPath);
      const defaultBase = path.basename(projectPath).replace(/\.project\.json$/i, '') || 'vector_project';
      const outputBase = sanitizeFileName(rawName, sanitizeFileName(defaultBase, 'vector_project'));
      const romName = typeof data?.rom === 'string' && data.rom.trim().length ? data.rom.trim() : `${outputBase}.rom`;
      const fddName = typeof data?.fdd === 'string' && data.fdd.trim().length ? data.fdd.trim() : undefined;
      const name = rawName;
      const mainEntry = typeof data?.main === 'string' ? data.main : undefined;
      const mainPath = mainEntry ? (path.isAbsolute(mainEntry) ? mainEntry : path.resolve(path.dirname(projectPath), mainEntry)) : undefined;
      
      // Parse settings
      let settings: { speed?: number | 'max'; viewMode?: 'full' | 'noBorder'; ramDiskDataPath?: string; fddDataPath?: string } | undefined = undefined;
      if (data?.settings && typeof data.settings === 'object') {
        let speed: number | 'max' | undefined = undefined;
        if (data.settings.speed === 'max') {
          speed = 'max';
        } else if (typeof data.settings.speed === 'number' && data.settings.speed > 0) {
          speed = data.settings.speed;
        }
        
        let viewMode: 'full' | 'noBorder' | undefined = undefined;
        if (data.settings.viewMode === 'full' || data.settings.viewMode === 'noBorder') {
          viewMode = data.settings.viewMode;
        }
        
        let ramDiskDataPath: string | undefined = undefined;
        if (typeof data.settings.ramDiskDataPath === 'string') {
          const trimmed = data.settings.ramDiskDataPath.trim();
          if (trimmed.length > 0) {
            // Resolve to absolute path relative to project directory
            ramDiskDataPath = path.isAbsolute(trimmed) ? trimmed : path.resolve(path.dirname(projectPath), trimmed);
          }
        }
        
        let fddDataPath: string | undefined = undefined;
        if (typeof data.settings.fddDataPath === 'string') {
          const trimmed = data.settings.fddDataPath.trim();
          if (trimmed.length > 0) {
            // Resolve to absolute path relative to project directory
            fddDataPath = path.isAbsolute(trimmed) ? trimmed : path.resolve(path.dirname(projectPath), trimmed);
          }
        }
        
        if (speed !== undefined || viewMode !== undefined || ramDiskDataPath !== undefined || fddDataPath !== undefined) {
          settings = { speed, viewMode, ramDiskDataPath, fddDataPath };
        }
      }
      
      return { projectPath, name, mainPath, outputBase, romName, fddName, settings };
    } catch (err) {
      if (!opts.quiet) {
        logOutput(`Devector: Failed to read ${projectPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    }
  }

  function gatherProjectInfos(workspaceRoot: string, opts: { quiet?: boolean } = {}): ProjectInfo[] {
    const files = findProjectJsonFiles(workspaceRoot);
    const infos: ProjectInfo[] = [];
    for (const file of files) {
      const info = readProjectInfo(file, opts);
      if (info) infos.push(info);
    }
    return infos;
  }

  async function compileProjectFile(projectPath: string, options: { notify?: boolean; reason?: string } = {}): Promise<boolean> {
    const info = readProjectInfo(projectPath, { quiet: !options.notify });
    if (!info) {
      if (options.notify) vscode.window.showErrorMessage(`Failed to read ${path.basename(projectPath)}.`);
      return false;
    }
    if (!info.mainPath) {
      const msg = `${path.basename(projectPath)} is missing a "main" entry.`;
      if (options.notify) vscode.window.showErrorMessage(msg);
      else logOutput('Devector: ' + msg);
      return false;
    }
    if (!fs.existsSync(info.mainPath)) {
      const msg = `Main assembly file not found: ${info.mainPath}`;
      if (options.notify) vscode.window.showErrorMessage(msg);
      else logOutput('Devector: ' + msg);
      return false;
    }
    let contents: string;
    try {
      contents = fs.readFileSync(info.mainPath, 'utf8');
    } catch (err) {
      const msg = `Failed to read ${info.mainPath}: ${err instanceof Error ? err.message : String(err)}`;
      if (options.notify) vscode.window.showErrorMessage(msg);
      else logOutput('Devector: ' + msg);
      return false;
    }
    const projectDir = path.dirname(projectPath);
    const romPath = path.resolve(projectDir, info.romName);
    const romDir = path.dirname(romPath);
    if (!fs.existsSync(romDir)) {
      if (options.notify) {
        const action = await vscode.window.showErrorMessage(
          `The directory for the output ROM does not exist: ${romDir}. Do you want to create it?`,
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
        logOutput(`Devector: Output directory missing: ${romDir}`);
        return false;
      }
    }
    const debugPath = path.join(projectDir, `${info.outputBase}.debug.json`);
    const success = await compileAsmSource(info.mainPath, contents, { outPath: romPath, debugPath });
    if (success) {
      const reason = options.reason ? ` (${options.reason})` : '';
      logOutput(`Devector: Compiled project ${path.basename(projectPath)} -> ${path.basename(romPath)}${reason}`);
      if (options.notify) {
        vscode.window.showInformationMessage(`Compiled ${path.basename(info.mainPath)} to ${path.basename(romPath)}`);
      }
      reloadEmulatorBreakpointsFromFile();
    }
    return success;
  }

  async function pickProjectRomPath(options: { compileBeforeRun?: boolean } = {}): Promise<{ project: ProjectInfo; programPath: string; debugPath: string } | undefined> {
    if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) {
      vscode.window.showErrorMessage('Open a folder before running a ROM.');
      return undefined;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const infos = gatherProjectInfos(workspaceRoot, { quiet: true });
    if (!infos.length) {
      vscode.window.showErrorMessage('No *.project.json files found in test/project, project, or the workspace root.');
      return undefined;
    }

    let selected = infos[0];
    if (infos.length > 1) {
      const picks = infos.map((info) => ({
        label: info.name,
        description: path.relative(workspaceRoot, info.projectPath) || info.projectPath,
        detail: info.fddName || info.romName,
        target: info
      }));
      const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Select a project ROM to run' });
      if (!pick) return undefined;
      selected = pick.target;
    }

    const romPath = path.resolve(path.dirname(selected.projectPath), selected.romName);
    const fddPath = selected.fddName ? path.resolve(path.dirname(selected.projectPath), selected.fddName) : undefined;
    const programPath = fddPath || romPath;
    const debugPath = path.join(path.dirname(selected.projectPath), `${selected.outputBase}.debug.json`);
    const ensureRomReady = async (): Promise<boolean> => {
      if (options.compileBeforeRun) {
        const compiled = await compileProjectFile(selected.projectPath, { notify: true, reason: 'compile & run' });
        if (!compiled) return false;
        // If running FDD, we just check if it exists (we don't compile it directly, but we compiled the ROM)
        if (fddPath) return fs.existsSync(fddPath);
        return fs.existsSync(romPath);
      }
      if (fs.existsSync(programPath)) return true;
      const action = await vscode.window.showWarningMessage(
        `${path.basename(programPath)} not found. Compile ${selected.name}?`,
        'Compile',
        'Cancel'
      );
      if (action !== 'Compile') return false;
      const compiled = await compileProjectFile(selected.projectPath, { notify: true, reason: 'run rom' });
      if (!compiled) return false;
      return fs.existsSync(programPath);
    };

    const ready = await ensureRomReady();
    if (!ready) {
      if (!fs.existsSync(programPath)) {
        vscode.window.showErrorMessage(`File not found: ${programPath}`);
      }
      return undefined;
    }

    return { project: selected, programPath: programPath, debugPath };
  }

  async function launchProjectRomEmulator(options: { compileBeforeRun?: boolean } = {}): Promise<boolean> {
    const programSelection = await pickProjectRomPath({ compileBeforeRun: options.compileBeforeRun });
    if (!programSelection) return false;
    await openEmulatorPanel(context, devectorOutput, { 
      programPath: programSelection.programPath, 
      debugPath: programSelection.debugPath,
      projectPath: programSelection.project.projectPath,
      initialSpeed: programSelection.project.settings?.speed,
      initialViewMode: programSelection.project.settings?.viewMode,
      ramDiskDataPath: programSelection.project.settings?.ramDiskDataPath,
      fddDataPath: programSelection.project.settings?.fddDataPath
    });
    return true;
  }

  const pendingBreakpointAsmPaths = new Set<string>();
  let breakpointCompilePromise: Promise<void> = Promise.resolve();
  let suppressBreakpointValidation = false;

  function collectAsmPathsFromEvent(ev: vscode.BreakpointsChangeEvent): Set<string> {
    const result = new Set<string>();
    const gather = (items?: readonly vscode.Breakpoint[]) => {
      if (!items) return;
      for (const bp of items) {
        if (!(bp instanceof vscode.SourceBreakpoint)) continue;
        const uri = bp.location?.uri;
        if (!uri || uri.scheme !== 'file') continue;
        if (!uri.fsPath.toLowerCase().endsWith('.asm')) continue;
        result.add(path.resolve(uri.fsPath));
      }
    };
    gather(ev.added);
    gather(ev.removed);
    gather(ev.changed);
    return result;
  }

  async function compileProjectsForBreakpointChanges(paths: Set<string>) {
    if (!paths.size) return;
    if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) return;
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const infos = gatherProjectInfos(workspaceRoot, { quiet: true });
    if (!infos.length) return;
    for (const info of infos) {
      await compileProjectFile(info.projectPath, { notify: false, reason: 'breakpoint change' });
    }
  }

  function scheduleBreakpointProjectCompile(paths: Set<string>) {
    if (!paths.size) return;
    for (const p of paths) pendingBreakpointAsmPaths.add(path.resolve(p));
    breakpointCompilePromise = breakpointCompilePromise.then(async () => {
      if (!pendingBreakpointAsmPaths.size) return;
      const batch = new Set(pendingBreakpointAsmPaths);
      pendingBreakpointAsmPaths.clear();
      await compileProjectsForBreakpointChanges(batch);
    }).catch((err) => {
      logOutput('Devector: breakpoint-triggered project compile failed: ' + (err instanceof Error ? err.message : String(err)));
    });
  }

  async function findInvalidBreakpoints(items?: readonly vscode.Breakpoint[]): Promise<vscode.SourceBreakpoint[]> {
    const invalid: vscode.SourceBreakpoint[] = [];
    if (!items) return invalid;
    for (const bp of items) {
      if (!(bp instanceof vscode.SourceBreakpoint)) continue;
      const uri = bp.location?.uri;
      if (!uri || uri.scheme !== 'file') continue;
      if (!uri.fsPath.toLowerCase().endsWith('.asm')) continue;
      const doc = await ensureDocument(uri);
      if (!doc) continue;
      const line = bp.location.range.start.line;
      if (!isAsmBreakpointLine(doc, line)) invalid.push(bp);
    }
    return invalid;
  }

  const runDisposable = vscode.commands.registerCommand('i8080.run', async () => {
    await openEmulatorPanel(context, devectorOutput);
  });
  context.subscriptions.push(runDisposable);

  const createProjectDisposable = vscode.commands.registerCommand('i8080.createProject', async () => {
    if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) {
      vscode.window.showErrorMessage('Open a folder before creating a project.');
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: 'Project name',
      placeHolder: 'MyVectorProject',
      validateInput: (value) => value && value.trim().length > 0 ? undefined : 'Enter a project name'
    });
    if (!name) return;
    const trimmed = name.trim();
    const safeName = sanitizeFileName(trimmed, 'vector_project');
    const romBaseName = sanitizeFileName(trimmed, safeName);
    const romName = `${romBaseName}.rom`;
    const projectData = {
      name: trimmed,
      main: 'main.asm',
      rom: romName,
      fdd: ""
    };
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const targetPath = path.join(workspaceRoot, `${safeName}.project.json`);
    const mainAsmPath = path.join(workspaceRoot, 'main.asm');
    const romPath = path.join(workspaceRoot, romName);
    if (fs.existsSync(targetPath)) {
      const overwrite = await vscode.window.showWarningMessage(
        `${path.basename(targetPath)} already exists. Overwrite?`,
        { modal: true },
        'Overwrite'
      );
      if (overwrite !== 'Overwrite') return;
    }
    try {
      if (!fs.existsSync(mainAsmPath)) {
        const mainTemplate = readMainTemplate();
        fs.writeFileSync(mainAsmPath, mainTemplate, 'utf8');
        logOutput(`Devector: Created ${mainAsmPath} from template`, true);
      }
      fs.writeFileSync(targetPath, JSON.stringify(projectData, null, 4), 'utf8');
      logOutput(`Devector: Created project file ${targetPath}`, true);
      const runLaunchUpdated = ensureLaunchConfiguration(workspaceRoot, romPath, { configName: 'Run ROM' });
      if (runLaunchUpdated) {
        logOutput(`Devector: Ensured Run ROM launch for ${path.basename(romPath)}`, true);
      }
      const compileLaunchUpdated = ensureLaunchConfiguration(workspaceRoot, romPath, { configName: 'Compile & Run', extraProps: { compileBeforeRun: true } });
      if (compileLaunchUpdated) {
        logOutput(`Devector: Ensured Compile & Run launch for ${path.basename(romPath)}`, true);
      }
      try {
        const doc = await vscode.workspace.openTextDocument(targetPath);
        await vscode.window.showTextDocument(doc);
      } catch (_) {}
    } catch (err) {
      vscode.window.showErrorMessage('Failed to create project file: ' + (err instanceof Error ? err.message : String(err)));
    }
  });
  context.subscriptions.push(createProjectDisposable);

  const compileProjectDisposable = vscode.commands.registerCommand('i8080.compileProject', async () => {
    if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) {
      vscode.window.showErrorMessage('Open a folder before compiling a project.');
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const infos = gatherProjectInfos(workspaceRoot, { quiet: true });
    if (!infos.length) {
      vscode.window.showErrorMessage('No *.project.json files found in test/project, project, or the current workspace folder.');
      return;
    }

    let targetPath = infos[0].projectPath;
    if (infos.length > 1) {
      const picks = infos.map((info) => ({
        label: info.name,
        description: path.relative(workspaceRoot, info.projectPath) || info.projectPath,
        detail: info.mainPath ? `main: ${path.relative(workspaceRoot, info.mainPath)}` : 'main not set',
        projectPath: info.projectPath
      }));
      const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Select a project to compile' });
      if (!pick) return;
      targetPath = pick.projectPath;
    }

    await compileProjectFile(targetPath, { notify: true, reason: 'command' });
  });
  context.subscriptions.push(compileProjectDisposable);

  // Register a debug configuration provider so the debugger is visible and
  // VS Code can present debug configurations and a F5 launch option.
  const dbgProvider: vscode.DebugConfigurationProvider = {
    provideDebugConfigurations(folder, token) {
      return [
        { type: 'i8080', request: 'launch', name: 'Launch i8080', program: '${file}' },
        { type: 'i8080', request: 'launch', name: 'Run ROM', runProjectRom: true },
        { type: 'i8080', request: 'launch', name: 'Compile & Run', runProjectRom: true, compileBeforeRun: true }
      ];
    },
    async resolveDebugConfiguration(folder, config, token) {
      if (config && (config.runProjectRom || config.name === 'Run ROM' || config.name === 'Compile & Run')) {
        await launchProjectRomEmulator({ compileBeforeRun: !!config.compileBeforeRun || config.name === 'Compile & Run' });
        return undefined;
      }

      // If no program is set, try to use the active editor file
      if (!config || !config.program) {
        const ed = vscode.window.activeTextEditor;
        if (ed && ed.document && ed.document.fileName) config = config || {} as any, config.program = ed.document.fileName;
      }
      return config;
    }
  };
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('i8080', dbgProvider));

  const pauseDisposable = vscode.commands.registerCommand('i8080.pause', async () => {
    pauseEmulatorPanel();
  });
  context.subscriptions.push(pauseDisposable);

  const resumeDisposable = vscode.commands.registerCommand('i8080.resume', async () => {
    resumeEmulatorPanel();
  });
  context.subscriptions.push(resumeDisposable);

  const runFrameDisposable = vscode.commands.registerCommand('i8080.stepFrame', async () => {
    // Ensure the emulator panel is open before running instructions
    await openEmulatorPanel(context, devectorOutput);
    // then run the instruction batch
    stepFramePanel();
  });
  context.subscriptions.push(runFrameDisposable);

  // Toggle breakpoint command: toggles a SourceBreakpoint at the current cursor line
  const toggleBp = vscode.commands.registerCommand('i8080.toggleBreakpoint', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const doc = ed.document;
    // Only operate on files (not untitled) and only asm
    if (!doc || doc.isUntitled || !doc.fileName.toLowerCase().endsWith('.asm')) return;
    const line = ed.selection.active.line;
    const uri = doc.uri;
    const existing = vscode.debug.breakpoints.filter((b) => {
      if (!(b instanceof vscode.SourceBreakpoint)) return false;
      const sb = b as vscode.SourceBreakpoint;
      if (!sb.location || !sb.location.uri) return false;
      if (sb.location.uri.fsPath !== uri.fsPath) return false;
      return sb.location.range.start.line === line;
    }) as vscode.SourceBreakpoint[];

    if (existing.length) {
      vscode.debug.removeBreakpoints(existing);
    } else {
      if (!isAsmBreakpointLine(doc, line)) {
        reportInvalidBreakpointLine();
        return;
      }
      const loc = new vscode.Location(uri, new vscode.Position(line, 0));
      const sb = new vscode.SourceBreakpoint(loc, true);
      vscode.debug.addBreakpoints([sb]);
    }
  });
  context.subscriptions.push(toggleBp);

  // Helper utilities for breakpoint targeting
  const looksLikeFsPath = (value: string) => {
    return path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
  };

  const normalizeUri = (value: any): vscode.Uri | undefined => {
    if (!value) return undefined;
    if (value instanceof vscode.Uri) return value;
    if (typeof value === 'string') {
      try {
        return looksLikeFsPath(value) ? vscode.Uri.file(value) : vscode.Uri.parse(value);
      } catch (_) {
        return undefined;
      }
    }
    if (typeof value === 'object') {
      if (typeof value.fsPath === 'string') return normalizeUri(value.fsPath);
      if (typeof value.path === 'string') {
        if (value.scheme === 'file') return normalizeUri(value.path);
        try {
          if (value.scheme) return vscode.Uri.parse(`${value.scheme}://${value.authority || ''}${value.path}`);
        } catch (_) {
          return undefined;
        }
        return normalizeUri(value.path);
      }
      if (typeof value.scheme === 'string' && typeof value.authority === 'string' && typeof value.path === 'string') {
        try {
          return vscode.Uri.parse(`${value.scheme}://${value.authority}${value.path}`);
        } catch (_) { return undefined; }
      }
    }
    return undefined;
  };

  const applyLine = (current: number | undefined, raw: any, opts: { oneBased?: boolean } = {}): number | undefined => {
    if (current !== undefined) return current;
    if (raw === undefined || raw === null) return current;
    const num = Number(raw);
    if (!Number.isFinite(num)) return current;
    const normalized = opts.oneBased ? num - 1 : num;
    return Math.max(0, Math.floor(normalized));
  };

  const extractTargetFromArg = (arg: any): { uri?: vscode.Uri; line?: number } => {
    let uri: vscode.Uri | undefined;
    let line: number | undefined;

    const visit = (node: any) => {
      if (node === undefined || node === null) return;
      if (uri && line !== undefined) return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      const maybeUri = normalizeUri(node);
      if (maybeUri && !uri) uri = maybeUri;
      if (typeof node === 'number') {
        line = applyLine(line, node);
        return;
      }
      if (typeof node !== 'object') return;
      const candidate = node as any;
      if (candidate.uri) {
        const parsed = normalizeUri(candidate.uri);
        if (parsed && !uri) uri = parsed;
      }
      if (candidate.resource) {
        const parsed = normalizeUri(candidate.resource);
        if (parsed && !uri) uri = parsed;
      }
      if (candidate.document?.uri) {
        const parsed = normalizeUri(candidate.document.uri);
        if (parsed && !uri) uri = parsed;
      }
      if (candidate.source?.path) {
        const parsed = normalizeUri(candidate.source.path);
        if (parsed && !uri) uri = parsed;
      }
      if (candidate.location) {
        const loc = candidate.location;
        if (loc.uri) {
          const parsed = normalizeUri(loc.uri);
          if (parsed && !uri) uri = parsed;
        }
        if (loc.range) visit(loc.range);
      }
      if (candidate.editor) visit(candidate.editor);
      if (candidate.textEditor) visit(candidate.textEditor);
      if (candidate.range) visit(candidate.range);
      if (candidate.selection) visit(candidate.selection);
      if (candidate.selections) visit(candidate.selections);
      if (candidate.position) visit(candidate.position);
      if (candidate.active) visit(candidate.active);
      if (candidate.start) visit(candidate.start);
      if (candidate.end) visit(candidate.end);
      if (candidate.anchor) visit(candidate.anchor);
      if (candidate.line !== undefined) line = applyLine(line, candidate.line);
      if (candidate.lineNumber !== undefined) line = applyLine(line, candidate.lineNumber, { oneBased: true });
      if (candidate.startLine !== undefined) line = applyLine(line, candidate.startLine);
      if (candidate.startLineNumber !== undefined) line = applyLine(line, candidate.startLineNumber, { oneBased: true });
      if (candidate.lineno !== undefined) line = applyLine(line, candidate.lineno, { oneBased: true });
    };

    visit(arg);
    return { uri, line };
  };

  // Intercept built-in toggle command to handle gutter clicks that toggle breakpoints
  async function toggleBreakpointFromArg(arg: any) {
    try {
      let { uri, line } = extractTargetFromArg(arg);

      if (!uri || line === undefined) {
        const ed = vscode.window.activeTextEditor;
        if (ed) {
          if (!uri) uri = ed.document.uri;
          if (line === undefined) line = ed.selection.active.line;
        }
      }

      if (!uri || line === undefined) {
        logOutput('Devector: toggleBreakpoint override - missing uri/line for toggle');
        return;
      }

      const targetUri = uri;

      const targetLine = Math.max(0, Math.floor(line));
      const matching = vscode.debug.breakpoints.filter((bp) => {
        if (!(bp instanceof vscode.SourceBreakpoint)) return false;
        const sb = bp as vscode.SourceBreakpoint;
        const bpUri = sb.location?.uri;
        if (!bpUri) return false;
        return (bpUri.fsPath === targetUri.fsPath) && (sb.location.range.start.line === targetLine);
      }) as vscode.SourceBreakpoint[];

      if (matching.length) {
        vscode.debug.removeBreakpoints(matching);
        logOutput(`Devector: Removed breakpoint at ${targetUri.fsPath}:${targetLine + 1}`);
        return;
      }

      if (targetUri.scheme === 'file' && targetUri.fsPath.toLowerCase().endsWith('.asm')) {
        const doc = await ensureDocument(targetUri);
        if (doc && !isAsmBreakpointLine(doc, targetLine)) {
          reportInvalidBreakpointLine();
          return;
        }
      }

      const newBp = new vscode.SourceBreakpoint(new vscode.Location(targetUri, new vscode.Position(targetLine, 0)), true);
      vscode.debug.addBreakpoints([newBp]);
      logOutput(`Devector: Added breakpoint at ${targetUri.fsPath}:${targetLine + 1}`);
    } catch (e) {
      logOutput('Devector: toggleBreakpoint override failed: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  const overrideBuiltinToggle = vscode.commands.registerCommand('editor.debug.action.toggleBreakpoint', (arg: any) => toggleBreakpointFromArg(arg));
  context.subscriptions.push(overrideBuiltinToggle);
  // Provide additional registrations for common variant commands the editor may use
  const cmdNames = [
    'editor.action.debug.toggleBreakpoint', 'editor.action.toggleBreakpoint', 'workbench.debug.action.toggleBreakpoints', 'editor.debug.action.toggleConditionalBreakpoint', 'editor.action.debug.toggleConditionalBreakpoint', 'editor.action.debug.toggleLogPoint', 'editor.debug.action.toggleLogPoint'
  ];
  for (const name of cmdNames) {
    try {
      const reg = vscode.commands.registerCommand(name, (arg: any) => toggleBreakpointFromArg(arg));
      context.subscriptions.push(reg);
    } catch (e) {
      // ignore failures to register (some core commands may not be overrideable)
    }
  }


  // Helper to write breakpoints for the active asm editor into its tokens file
  async function writeBreakpointsForActiveEditor() {
    const ed2 = vscode.window.activeTextEditor;
    if (!ed2) return;
    const doc2 = ed2.document;
    if (!doc2 || doc2.isUntitled || !doc2.fileName.endsWith('.asm')) return;
    const src2 = doc2.getText();
    const mainPath2 = doc2.fileName;
    try {
      const included = findIncludedFiles(mainPath2, src2, new Set<string>());
      let tokenPath2: string;
      const outPath2 = mainPath2.replace(/\.asm$/i, '.rom');
      if (/\.[^/.]+$/.test(outPath2)) tokenPath2 = outPath2.replace(/\.[^/.]+$/, '.debug.json');
      else tokenPath2 = outPath2 + '.debug.json';
      if (!fs.existsSync(tokenPath2)) return;
      const tokenText2 = fs.readFileSync(tokenPath2, 'utf8');
      const tokens2 = JSON.parse(tokenText2);
      tokens2.breakpoints = {};
      const basenameToPaths = new Map<string, Set<string>>();
      for (const f of Array.from(included)) {
        const b = path.basename(f);
        let s = basenameToPaths.get(b);
        if (!s) { s = new Set(); basenameToPaths.set(b, s); }
        s.add(path.resolve(f));
      }
      const allBps2 = vscode.debug.breakpoints;
      for (const bp of allBps2) {
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
          if (tokens2.labels) {
            for (const [labelName, labInfo] of Object.entries(tokens2.labels)) {
              try {
                if ((labInfo as any).src && (labInfo as any).src === bpBase && (labInfo as any).line === lineNum) {
                  entry.label = labelName;
                  entry.addr = (labInfo as any).addr;
                  break;
                }
              } catch (e) {}
            }
          }
          attachAddressFromTokens(tokens2, bpPath, lineNum, entry);
          if (!tokens2.breakpoints[bpBase]) tokens2.breakpoints[bpBase] = [];
          tokens2.breakpoints[bpBase].push(entry);
        }
      }
      fs.writeFileSync(tokenPath2, JSON.stringify(tokens2, null, 4), 'utf8');
    } catch (e) {
      console.error('writeBreakpointsForActiveEditor failed:', e);
    }
  }

  const asmHoverProvider = vscode.languages.registerHoverProvider('asm', {
    provideHover(document, position) {
      if (!isEmulatorPanelPaused()) return undefined;
      const dataHover = resolveDataDirectiveHover(document, position);
      if (dataHover) {
        const valueWidth = Math.max(2, dataHover.unitBytes * 2);
        const memoryHex = '0x' + (dataHover.value >>> 0).toString(16).toUpperCase().padStart(valueWidth, '0');
        const memoryDec = (dataHover.value >>> 0).toString(10);
        const addressHex = '0x' + dataHover.address.toString(16).toUpperCase().padStart(4, '0');
        const md = new vscode.MarkdownString(undefined, true);
        md.appendMarkdown(`**${dataHover.directive.toUpperCase()} literal**\n\n`);
        md.appendMarkdown(`- addr: \`${addressHex}\`\n`);
        md.appendMarkdown(`- memory: \`${memoryHex}/${memoryDec}\`\n`);
        if (typeof dataHover.sourceValue === 'number') {
          const normalizedSource = dataHover.sourceValue >>> 0;
          const sourceHex = '0x' + normalizedSource.toString(16).toUpperCase().padStart(valueWidth, '0');
          const sourceDec = normalizedSource.toString(10);
          md.appendMarkdown(`- source: \`${sourceHex}/${sourceDec}\``);
        }
        md.isTrusted = false;
        return new vscode.Hover(md, dataHover.range);
      }

      const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_@.][A-Za-z0-9_@.]*/);
      const identifier = wordRange ? document.getText(wordRange) : '';
      const filePath = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
      if (identifier && !identifier.startsWith('.')) {
        const symbol = resolveEmulatorHoverSymbol(identifier, filePath ? { filePath, line: position.line + 1 } : undefined);
        if (symbol) {
          if (symbol.kind === 'line') {
            const instructionHover = resolveInstructionHover(document, position, symbol.value);
            if (instructionHover) {
              const addrHex = '0x' + instructionHover.address.toString(16).toUpperCase().padStart(4, '0');
              const memBytes = instructionHover.bytes.map(b => '0x' + b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
              const md = new vscode.MarkdownString(undefined, true);
              md.appendMarkdown(`${instructionHover.display}\n\n`);
              md.appendMarkdown(`- address: \`${addrHex}/${instructionHover.address}\`\n`);
              md.appendMarkdown(`- memory: \`${memBytes}\``);
              md.isTrusted = false;
              return new vscode.Hover(md, wordRange);
            }
          }

          const numericValue = Math.trunc(symbol.value);
          if (Number.isFinite(numericValue)) {
            const normalized16 = ((numericValue % 0x10000) + 0x10000) % 0x10000;
            const paddedHex = '0x' + normalized16.toString(16).toUpperCase().padStart(4, '0');
            const fullHex = numericValue < 0 ? `-0x${Math.abs(numericValue).toString(16).toUpperCase()}` : `0x${numericValue.toString(16).toUpperCase()}`;
            const hexValue = symbol.kind === 'const' ? fullHex : paddedHex;
            const decValue = numericValue.toString(10);
            const kindLabel = symbol.kind === 'const' ? 'constant' : symbol.kind === 'label' ? 'label' : 'address';
            const md = new vscode.MarkdownString(undefined, true);
            md.appendMarkdown(`**${identifier}** (${kindLabel})\n\n`);
            md.appendMarkdown(`- hex: \`${hexValue}\`\n`);
            md.appendMarkdown(`- dec: \`${decValue}\``);
            if (symbol.kind === 'line') {
              md.appendMarkdown('\n- note: derived from source line address');
            }
            md.isTrusted = false;
            return new vscode.Hover(md, wordRange);
          }
        }
      }

      return undefined;
    }
  });
  context.subscriptions.push(asmHoverProvider);

  // Persist breakpoints whenever they change in the debugger model
  context.subscriptions.push(vscode.debug.onDidChangeBreakpoints(async (ev) => {
    if (suppressBreakpointValidation) {
      await writeBreakpointsForActiveEditor();
      return;
    }

    const invalidAdded = await findInvalidBreakpoints(ev.added);
    if (invalidAdded.length) {
      reportInvalidBreakpointLine();
      try {
        suppressBreakpointValidation = true;
        vscode.debug.removeBreakpoints(invalidAdded);
      } finally {
        suppressBreakpointValidation = false;
      }
      await writeBreakpointsForActiveEditor();
      return;
    }

    // Only write tokens if we have an active asm editor
    await writeBreakpointsForActiveEditor();
    const asmPaths = collectAsmPathsFromEvent(ev);
    if (asmPaths.size) scheduleBreakpointProjectCompile(asmPaths);
  }));

  // Register DefinitionProvider for .include directive paths
  // This enables Ctrl+hover underline and Ctrl+click navigation to included files
  const includeDefinitionProvider: vscode.DefinitionProvider = {
    async provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Definition | vscode.DefinitionLink[] | undefined> {
      const line = document.lineAt(position.line);
      const lineText = line.text;

      // Match .include "filename" or .include 'filename'
      // Strip trailing comments first for the match (uses same pattern as findIncludedFiles)
      const textWithoutComment = lineText.replace(/\/\/.*$|;.*$/, '');
      // Capture groups: (1) prefix including whitespace and .include keyword + space, (2) quote char, (3) path
      const includeRegex = /^(\s*\.include\s+)(["'])([^"']+)\2/i;
      const includeMatch = textWithoutComment.match(includeRegex);
      if (!includeMatch) {
        return undefined;
      }

      const includedPath = includeMatch[3];
      // Calculate the range of the path string based on the match
      // includeMatch[1] is the prefix ".include " part (including leading whitespace)
      // +1 for the opening quote character
      const pathStartIndex = includeMatch[1].length + 1;
      const pathEndIndex = pathStartIndex + includedPath.length;

      // Check if the cursor position is within the path (exclusive end)
      if (position.character < pathStartIndex || position.character >= pathEndIndex) {
        return undefined;
      }

      // Resolve the path relative to the current document
      let resolvedPath: string;
      if (path.isAbsolute(includedPath)) {
        resolvedPath = includedPath;
      } else {
        const baseDir = path.dirname(document.uri.fsPath);
        resolvedPath = path.resolve(baseDir, includedPath);
      }

      // Check if the file exists asynchronously
      try {
        await fs.promises.access(resolvedPath);
      } catch {
        return undefined;
      }

      const targetUri = vscode.Uri.file(resolvedPath);
      const targetRange = new vscode.Range(0, 0, 0, 0);
      const originRange = new vscode.Range(
        position.line, pathStartIndex,
        position.line, pathEndIndex
      );

      return [{
        targetUri,
        targetRange,
        originSelectionRange: originRange
      }] as vscode.DefinitionLink[];
    }
  };

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider({ language: 'asm' }, includeDefinitionProvider)
  );
}

export function deactivate() {}
