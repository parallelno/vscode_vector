import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { assemble, assembleAndWrite } from './assembler';
import { openEmulatorPanel, pauseEmulatorPanel, resumeEmulatorPanel, runFramePanel } from './emulatorUI';

export function activate(context: vscode.ExtensionContext) {
  const devectorOutput = vscode.window.createOutputChannel('Devector');
  context.subscriptions.push(devectorOutput);
  const logOutput = (message: string, reveal: boolean = false) => {
    try {
      devectorOutput.appendLine(message);
      if (reveal) devectorOutput.show(true);
    } catch (e) { /* ignore output channel errors */ }
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
  const disposable = vscode.commands.registerCommand('i8080.compile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showErrorMessage('Open an .asm file to compile'); return; }
    const doc = editor.document;
    if (!doc.fileName.endsWith('.asm')) { vscode.window.showWarningMessage('File does not have .asm extension, still attempting to assemble.'); }
    const src = doc.getText();
    // pass the document file path so assembler can resolve .include relative paths
    const outPath = doc.fileName.replace(/\.asm$/i, '.rom');
    // use assembleAndWrite which prints formatted errors/warnings to stderr/stdout
    const writeRes = assembleAndWrite(src, outPath, doc.fileName);
    if (!writeRes.success) {
      // assembleAndWrite already printed formatted errors to stderr, but keep the popup
      const errMsg = writeRes.errors ? writeRes.errors.join('; ') : 'Assemble failed';
      // Also write the formatted errors to the Output panel so they are visible
      logOutput(`Devector: Compilation failed:\n${errMsg}`, true);
      if (writeRes.errors && writeRes.errors.length) {
        for (const e of writeRes.errors) {
          logOutput(e);
          logOutput('');
        }
      }
      //vscode.window.showErrorMessage('Compilation failed: ' + errMsg);
      return;
    }
    // Also write success and timing info to the Output panel
    const timeMsg = (writeRes as any).timeMs !== undefined ? `${(writeRes as any).timeMs}` : '';
    logOutput(`Devector: Compilation succeeded to ${path.basename(outPath)} in ${timeMsg} ms`, true);
    // Add tokens for editor breakpoints (source line breakpoints) across
    // the main asm and all recursively included files. The assembler writes
    // token file `<out>_.json`; read it, add a `breakpoints` key and write it back.
    try {
      const includedFiles = new Set<string>(Array.from(findIncludedFiles(doc.fileName, src)));

      // Build token path (same logic as in assembler.ts)
      let tokenPath: string;
      if (/\.[^/.]+$/.test(outPath)) tokenPath = outPath.replace(/\.[^/.]+$/, '_.json');
      else tokenPath = outPath + '_.json';

      // If the token file exists, read and update it
      if (fs.existsSync(tokenPath)) {
        try {
          const tokenText = fs.readFileSync(tokenPath, 'utf8');
          const tokens = JSON.parse(tokenText);
          // Clear existing breakpoints so we store the current set freshly
          tokens.breakpoints = {};

          // Map included file basenames to absolute paths for matching
          const basenameToPaths = new Map<string, Set<string>>();
          for (const f of Array.from(includedFiles)) {
            const b = path.basename(f);
            let s = basenameToPaths.get(b);
            if (!s) { s = new Set(); basenameToPaths.set(b, s); }
            s.add(path.resolve(f));
          }

          // Iterate all VS Code breakpoints and pick those that are in included files
          const allBps = vscode.debug.breakpoints;
          for (const bp of allBps) {
            if ((bp as vscode.SourceBreakpoint).location) {
              const srcBp = bp as vscode.SourceBreakpoint;
              const uri = srcBp.location.uri;
              if (!uri || uri.scheme !== 'file') continue;
              const bpPath = path.resolve(uri.fsPath);
              const bpBase = path.basename(bpPath);
              // Only include if file is one of the included files
              if (!basenameToPaths.has(bpBase)) continue;
              const pathsForBase = basenameToPaths.get(bpBase)!;
              if (!pathsForBase.has(bpPath)) continue;

              // Breakpoint line numbers in the token file should be 1-based
              const lineNum = srcBp.location.range.start.line + 1;
              const entry = { line: lineNum, enabled: !!bp.enabled } as any;

              // Attach label and addr if matching label exists in tokens
              if (tokens.labels) {
                for (const [labelName, labInfo] of Object.entries(tokens.labels)) {
                  try {
                    // tokens store src as just basename in many cases
                    if ((labInfo as any).src && (labInfo as any).src === bpBase && (labInfo as any).line === lineNum) {
                      entry.label = labelName;
                      entry.addr = (labInfo as any).addr;
                      break;
                    }
                  } catch (e) {}
                }
              }

              if (!tokens.breakpoints[bpBase]) tokens.breakpoints[bpBase] = [];
              tokens.breakpoints[bpBase].push(entry);
            }
          }

          // Write back tokens file with the new breakpoints section
          try {
            fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 4), 'utf8');
            // Log to Output channel how many breakpoints written for visibility
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
    //vscode.window.showInformationMessage(`Assembled to ${path.basename(outPath)}`);
  });

  context.subscriptions.push(disposable);

  const runDisposable = vscode.commands.registerCommand('i8080.run', async () => {
    openEmulatorPanel(context);
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
    const safeName = trimmed.replace(/[^A-Za-z0-9_-]+/g, '_') || 'vector_project';
    const projectData = {
      name: trimmed,
      main: 'main.asm'
    };
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const targetPath = path.join(workspaceRoot, `${safeName}.project.json`);
    if (fs.existsSync(targetPath)) {
      const overwrite = await vscode.window.showWarningMessage(
        `${path.basename(targetPath)} already exists. Overwrite?`,
        { modal: true },
        'Overwrite'
      );
      if (overwrite !== 'Overwrite') return;
    }
    try {
      fs.writeFileSync(targetPath, JSON.stringify(projectData, null, 4), 'utf8');
      logOutput(`Devector: Created project file ${targetPath}`, true);
      try {
        const doc = await vscode.workspace.openTextDocument(targetPath);
        await vscode.window.showTextDocument(doc);
      } catch (_) {}
    } catch (err) {
      vscode.window.showErrorMessage('Failed to create project file: ' + (err instanceof Error ? err.message : String(err)));
    }
  });
  context.subscriptions.push(createProjectDisposable);

  // Register a debug configuration provider so the debugger is visible and
  // VS Code can present debug configurations and a F5 launch option.
  const dbgProvider: vscode.DebugConfigurationProvider = {
    provideDebugConfigurations(folder, token) {
      return [
        {
          type: 'i8080', request: 'launch', name: 'Launch i8080', program: '${file}'
        }
      ];
    },
    resolveDebugConfiguration(folder, config, token) {
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

  const runFrameDisposable = vscode.commands.registerCommand('i8080.runFrame', async () => {
    // Ensure the emulator panel is open before running instructions
    await openEmulatorPanel(context);
    // then run the instruction batch
    runFramePanel();
  });
  context.subscriptions.push(runFrameDisposable);

  // Toggle breakpoint command: toggles a SourceBreakpoint at the current cursor line
  const toggleBp = vscode.commands.registerCommand('i8080.toggleBreakpoint', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const doc = ed.document;
    // Only operate on files (not untitled) and only asm
    if (!doc || doc.isUntitled || !doc.fileName.endsWith('.asm')) return;
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

      const targetLine = Math.max(0, Math.floor(line));
      const matching = vscode.debug.breakpoints.filter((bp) => {
        if (!(bp instanceof vscode.SourceBreakpoint)) return false;
        const sb = bp as vscode.SourceBreakpoint;
        const bpUri = sb.location?.uri;
        if (!bpUri) return false;
        return (bpUri.fsPath === uri!.fsPath) && (sb.location.range.start.line === targetLine);
      }) as vscode.SourceBreakpoint[];

      if (matching.length) {
        vscode.debug.removeBreakpoints(matching);
        logOutput(`Devector: Removed breakpoint at ${uri.fsPath}:${targetLine + 1}`);
      } else {
        const newBp = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(targetLine, 0)), true);
        vscode.debug.addBreakpoints([newBp]);
        logOutput(`Devector: Added breakpoint at ${uri.fsPath}:${targetLine + 1}`);
      }
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
      if (/\.[^/.]+$/.test(outPath2)) tokenPath2 = outPath2.replace(/\.[^/.]+$/, '_.json');
      else tokenPath2 = outPath2 + '_.json';
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
          if (!tokens2.breakpoints[bpBase]) tokens2.breakpoints[bpBase] = [];
          tokens2.breakpoints[bpBase].push(entry);
        }
      }
      fs.writeFileSync(tokenPath2, JSON.stringify(tokens2, null, 4), 'utf8');
    } catch (e) {
      console.error('writeBreakpointsForActiveEditor failed:', e);
    }
  }

  // Persist breakpoints whenever they change in the debugger model
  context.subscriptions.push(vscode.debug.onDidChangeBreakpoints(async (ev) => {
    // Only write tokens if we have an active asm editor
    await writeBreakpointsForActiveEditor();
  }));
}

export function deactivate() {}
