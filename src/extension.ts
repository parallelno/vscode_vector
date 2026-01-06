import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as ext_utils from './extention/utils';
import * as ext_prg from './extention/project';
import * as ext_consts from './extention/consts';
import { provideDefinition } from './extention/provider_include';
import { provideSymbolDefinition } from './extention/provider_symbol_definition';
import { createProject } from './extention/cmd_create_project';
import { compileProject } from './extention/cmd_compile_project';
import { compileDependencies } from './extention/cmd_compile_dependencies';
import { runProject } from './extention/cmd_run_project';
import { toggleBreakpointFromArg } from './extention/cmd_toggle_bp';
import { provideHover } from './extention/provider_hover';
import {provideDebugConfigurations, resolveDebugConfiguration} from './extention/provider_debug_conf';
import {
  DebugAction,
  onEmulatorToolbarStateChange,
  pauseEmulatorPanel,
  performEmulatorDebugAction,
  resumeEmulatorPanel,
  stopAndCloseEmulatorPanel,
  onEmulatorPanelClosed,
  applyRomDiffToActiveHardware,
  getRunningProjectInfo
} from './emulatorUI';
import { collectIncludeFiles } from './assembler/includes';
import { ProjectInfo } from './extention/project_info';

type DebugRequestMessage = { seq: number; type: 'request'; command: string; arguments?: any };
type OutgoingMessage =
  | { seq: number; type: 'response'; request_seq: number; command: string; success: boolean; body?: any }
  | { seq: number; type: 'event'; event: string; body?: any };

class EmulatorDebugAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<OutgoingMessage>();
  private seq = 1;
  private readonly toolbarSub: vscode.Disposable;
  private readonly panelClosedSub: vscode.Disposable;

  constructor() {
    this.toolbarSub = onEmulatorToolbarStateChange((isRunning) => {
      if (isRunning) {
        this.sendEvent('continued', { threadId: 1 });
      } else {
        this.sendEvent('stopped', { reason: 'pause', threadId: 1 });
      }
    });
    this.panelClosedSub = onEmulatorPanelClosed(() => {
      this.sendEvent('terminated', {});
    });
  }

  onDidSendMessage: vscode.Event<OutgoingMessage> = this.emitter.event;

  handleMessage(message: DebugRequestMessage): void {
    if (!message || message.type !== 'request') return;
    const command = message.command;
    const respond = (body?: any, success: boolean = true) => {
      this.emitter.fire({
        type: 'response',
        seq: this.seq++,
        request_seq: message.seq,
        command,
        success,
        body
      });
    };
    const stopped = (reason: string = 'pause') => {
      this.sendEvent('stopped', { reason, threadId: 1 });
    };

    switch (command) {
    case 'initialize':
      respond({
        supportsConfigurationDoneRequest: true,
        supportsRestartRequest: true,
        supportsTerminateRequest: true,
        supportsPauseRequest: true,
        supportsStepBack: false,
        supportsStepInTargetsRequest: false
      });
      this.sendEvent('initialized');
      break;
    case 'configurationDone':
      respond();
      break;
    case 'launch':
      respond();
      this.sendEvent('continued', { threadId: 1 });
      break;
    case 'setBreakpoints': {
      const bps = (message.arguments?.breakpoints ?? []).map((bp: any, idx: number) => ({
        id: idx + 1,
        verified: true,
        line: bp.line
      }));
      respond({ breakpoints: bps });
      break;
    }
    case 'threads':
      respond({ threads: [{ id: 1, name: 'main' }] });
      break;
    case 'stackTrace':
      respond({ stackFrames: [], totalFrames: 0 });
      break;
    case 'scopes':
      respond({ scopes: [] });
      break;
    case 'variables':
      respond({ variables: [] });
      break;
    case 'continue':
      resumeEmulatorPanel();
      respond({ allThreadsContinued: true });
      break;
    case 'pause':
      pauseEmulatorPanel();
      respond();
      break;
    case 'next': {
      const ok = this.runAction('stepOver');
      respond(undefined, ok);
      if (ok) stopped('step');
      break;
    }
    case 'stepIn': {
      const ok = this.runAction('stepInto');
      respond(undefined, ok);
      if (ok) stopped('step');
      break;
    }
    case 'stepOut': {
      const ok = this.runAction('stepOut');
      respond(undefined, ok);
      if (ok) stopped('step');
      break;
    }
    case 'restart': {
      const ok = this.runAction('restart');
      respond(undefined, ok);
      break;
    }
    case 'disconnect':
    case 'terminate':
      stopAndCloseEmulatorPanel();
      this.sendEvent('terminated', {});
      respond();
      break;
    case 'evaluate':
      respond({ result: '', variablesReference: 0 });
      break;
    default:
      respond();
      break;
    }
  }

  private runAction(action: DebugAction): boolean {
    return performEmulatorDebugAction(action);
  }

  private sendEvent(event: string, body?: any) {
    this.emitter.fire({ type: 'event', seq: this.seq++, event, body });
  }

  dispose(): void {
    this.toolbarSub.dispose();
    this.panelClosedSub.dispose();
    this.emitter.dispose();
  }
}

class EmulatorDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(_session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(new EmulatorDebugAdapter());
  }
}


export function activate(context: vscode.ExtensionContext)
{
  const pendingBreakpointAsmPaths = new Set<string>();
  let breakpointCompilePromise: Promise<void> = Promise.resolve();
  let romHotReloadPromise: Promise<void> = Promise.resolve();

  let suppressBreakpointValidation = false;
  const devectorOutput = vscode.window.createOutputChannel('Devector');
  context.subscriptions.push(devectorOutput);


  const createProjectDisposable = vscode.commands.registerCommand(
    ext_consts.EXTENTION_NAME + '.createProject', () => createProject(devectorOutput, context));
  context.subscriptions.push(createProjectDisposable);

  const compileProjectDisposable = vscode.commands.registerCommand(
    ext_consts.EXTENTION_NAME + '.compileProject',() => compileProject(devectorOutput, context));
  context.subscriptions.push(compileProjectDisposable);

  const compileDependenciesDisposable = vscode.commands.registerCommand(
    ext_consts.EXTENTION_NAME + '.compileDependencies',() => compileDependencies(devectorOutput, context));
  context.subscriptions.push(compileDependenciesDisposable);

  const runProjectDisposable = vscode.commands.registerCommand(
    ext_consts.EXTENTION_NAME + '.runProject',() => runProject(devectorOutput, context));
  context.subscriptions.push(runProjectDisposable);

  // Register a debug configuration provider so the debugger is visible and
  // VS Code can present debug configurations and a F5 launch option.
  const dbgProvider: vscode.DebugConfigurationProvider = {
    provideDebugConfigurations,
    resolveDebugConfiguration: (folder, config, token) =>
      resolveDebugConfiguration(devectorOutput, context, folder, config, token)
  };
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(ext_consts.EXTENTION_NAME, dbgProvider));
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(
      ext_consts.EXTENTION_NAME,
      new EmulatorDebugAdapterFactory()));

  // TODO: It was designed to run an arbitrary ROM. check if helpful.
  // const runDisposable = vscode.commands.registerCommand(
  //   ext_consts.EXTENTION_NAME + '.run',() => openEmulatorPanel(context, devectorOutput));
  // context.subscriptions.push(runDisposable);

  // TODO: implement
  // const pauseDisposable = vscode.commands.registerCommand(
  //   ext_consts.EXTENTION_NAME + '.pause', async () => pauseEmulatorPanel());
  // context.subscriptions.push(pauseDisposable);

  // TODO: implement
  // const resumeDisposable = vscode.commands.registerCommand(
  //   ext_consts.EXTENTION_NAME + '.resume', async () => resumeEmulatorPanel());
  // context.subscriptions.push(resumeDisposable);


  // TODO: implement. check if calling openEmulatorPanel was necessary
  // const runFrameDisposable = vscode.commands.registerCommand(
  //   ext_consts.EXTENTION_NAME + '.stepFrame', async () => {
  //   // Ensure the emulator panel is open before running instructions
  //   await openEmulatorPanel(context, devectorOutput);
  //   // then run the instruction batch
  //   stepFramePanel();
  // });
  // context.subscriptions.push(runFrameDisposable);


  // Provide additional registrations for common variant commands the editor may use
  const cmdNames = [
    'editor.action.debug.toggleBreakpoint',
    'editor.action.toggleBreakpoint',
    'workbench.debug.action.toggleBreakpoints',
    'editor.debug.action.toggleBreakpoint',
    'editor.debug.action.toggleConditionalBreakpoint',
    'editor.action.debug.toggleConditionalBreakpoint',
    'editor.action.debug.toggleLogPoint',
    'editor.debug.action.toggleLogPoint'
  ];
  for (const name of cmdNames) {
    try {
      const reg = vscode.commands.registerCommand(
        name,
        (arg: any) => toggleBreakpointFromArg(devectorOutput, arg)
      );
      context.subscriptions.push(reg);
    } catch (e) {
      // ignore failures to register (some core commands may not be overrideable)
    }
  }

////////////////////////////////////////////////////////////////////////////////
//
// ANYTHING BELOW UNCHECKED YET
//
////////////////////////////////////////////////////////////////////////////////


  // Hover provider for asm files to show emulator symbol info when paused
  const asmHoverProvider = vscode.languages.registerHoverProvider(
    'asm', {provideHover}
  );
  context.subscriptions.push(asmHoverProvider);


  // Register DefinitionProvider for .include directive paths
  // This enables Ctrl+hover underline and click navigation to included files
  const asmDefinitionProvider = vscode.languages.registerDefinitionProvider(
      { language: 'asm' }, { provideDefinition });
  context.subscriptions.push(asmDefinitionProvider);

    // Definition provider for labels/consts using emulator debug metadata
    const asmSymbolDefinitionProvider = vscode.languages.registerDefinitionProvider(
      { language: 'asm' }, { provideDefinition: provideSymbolDefinition });
    context.subscriptions.push(asmSymbolDefinitionProvider);


  // Persist breakpoints whenever they change in the debugger model
  context.subscriptions.push(vscode.debug.onDidChangeBreakpoints(async (ev) =>
  {
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
  }));

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const projectInfo = getRunningProjectInfo();
      if (!projectInfo) return;
      if (doc.isUntitled) return;
      if (doc.uri.scheme !== 'file') return;
      const ext = path.extname(doc.fileName).toLowerCase();
      if (ext !== '.asm') return;
      const savedPath = doc.uri.fsPath;
      romHotReloadPromise = romHotReloadPromise.then(async () => {
        await handleRomHotReload(devectorOutput, savedPath, projectInfo);
      }).catch((err) => {
        ext_utils.logOutput(
          devectorOutput,
          'Devector: ROM hot reload failed: ' +
          (err instanceof Error ? err.message : String(err)));
      });
    })
  );
}

async function handleRomHotReload(
  devectorOutput: vscode.OutputChannel,
  savedPath: string,
  project: ProjectInfo | undefined)
{
  if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) return;
  const normalizedTarget = ext_utils.normalizeFsPath(savedPath);
  if (!project?.settings.RomHotReload) return;
  const mainAsm = project.absolute_asm_path;
  if (!mainAsm || !fs.existsSync(mainAsm)) return;

  let source: string;
  try {
    source = fs.readFileSync(mainAsm!, 'utf8');
  } catch (err) {
    ext_utils.logOutput(
      devectorOutput,
      `Devector: ROM hot reload skipped for ${project.name}: ` +
      (err instanceof Error ? err.message : String(err)));
    return;
  }

  let includes: Set<string>;
  try {
    includes = collectIncludeFiles(source, mainAsm!, mainAsm!, project.absolute_path);
  } catch (err) {
    ext_utils.logOutput(
      devectorOutput,
      `Devector: ROM hot reload include scan failed for ${project.name}: ` +
      (err instanceof Error ? err.message : String(err)));
    return;
  }
  includes.add(mainAsm!);
  const normalizedIncludes = new Set(Array.from(includes).map(ext_utils.normalizeFsPath));
  if (!normalizedIncludes.has(normalizedTarget)) return;

  await performRomHotReload(devectorOutput, project);
}

async function performRomHotReload(
  devectorOutput: vscode.OutputChannel,
  project: ProjectInfo)
{
  const romPath = project.absolute_rom_path;
  if (!romPath) {
    ext_utils.logOutput(devectorOutput, `Devector: ROM hot reload skipped for ${project.name}: ROM path is not set`);
    return;
  }

  ext_utils.logOutput(devectorOutput, `Devector: ROM hot reload triggered for ${project.name}`);

  let oldRom = new Uint8Array();
  if (fs.existsSync(romPath)) {
    try {
      ext_utils.logOutput(devectorOutput, `Devector: Reading existing ROM from ${romPath} for comparison`);
      oldRom = fs.readFileSync(romPath);
    } catch (err) {
      ext_utils.logOutput(
        devectorOutput,
        `Devector: Failed to read existing ROM for ${project.name}: ` +
        (err instanceof Error ? err.message : String(err)));
      return;
    }
  } else {
    ext_utils.logOutput(devectorOutput, `Devector: No existing ROM found for ${project.name}; treating as empty before rebuild`);
  }

  ext_utils.logOutput(devectorOutput, `Devector: Compiling updated ROM for hot reload...`);
  const compiled = await ext_prg.compileProjectFile(devectorOutput, project, {
    silent: true,
    reason: 'ROM hot reload',
    includeDependencies: false,
    skipMain: false,
  });
  if (!compiled) {
    ext_utils.logOutput(devectorOutput, `Devector: ROM hot reload skipped for ${project.name}: compilation failed`);
    return;
  }
  if (!fs.existsSync(romPath)) {
    ext_utils.logOutput(devectorOutput, `Devector: ROM hot reload skipped: compiled ROM not found at ${romPath}`);
    return;
  }

  let newRom: Uint8Array;
  try {
    newRom = fs.readFileSync(romPath);
  } catch (err) {
    ext_utils.logOutput(
      devectorOutput,
      `Devector: Failed to read compiled ROM for ${project.name}: ` +
      (err instanceof Error ? err.message : String(err)));
    return;
  }

  ext_utils.logOutput(devectorOutput, `Devector: Comparing ROM images and applying diff...`);
  const result = applyRomDiffToActiveHardware(oldRom, newRom, devectorOutput);
  if (result.patched === 0) {
    ext_utils.logOutput(devectorOutput, `Devector: ROM hot reload found no differences to apply for ${project.name}`);
  } else {
    ext_utils.logOutput(
      devectorOutput,
      `Devector: ROM hot reload applied ${result.patched} diff chunk(s), ${result.bytes} byte(s) updated for ${project.name}`);
  }
}

export function deactivate() {}
