import * as vscode from 'vscode';
import * as ext_consts from './extention/consts';
import { provideIncludeDefinition } from './extention/provider_include';
import { provideSymbolDefinition } from './extention/provider_symbol_definition';
import { createProject } from './extention/cmd_create_project';
import { compileProject } from './extention/cmd_compile_project';
import { compileDependencies } from './extention/cmd_compile_dependencies';
import { runProject } from './extention/cmd_run_project';
import { toggleBreakpointFromArg } from './extention/cmd_toggle_bp';
import { provideSymbolHover } from './extention/provider_symbol_hover';
import {provideDebugConfigurations, resolveDebugConfiguration} from './extention/provider_debug_conf';
import {
  DebugAction,
  onEmulatorToolbarStateChange,
  pauseEmulatorPanel,
  performEmulatorDebugAction,
  resumeEmulatorPanel,
  stopAndCloseEmulatorPanel,
  onEmulatorPanelClosed
} from './emulatorUI';
import { registerRomHotReload } from './extention/romHotReload';
import { clearSymbolMetadataCache } from './emulatorUI/symbolCache';
import { breakpointListener } from './extention/breakpoint_listener';


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
  const devectorOutput = vscode.window.createOutputChannel('Devector');
  context.subscriptions.push(devectorOutput);

  // Clear symbol metadata caches when workspace folders change (multi-root or folder switches)
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearSymbolMetadataCache();
    })
  );


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


  // Register DefinitionProvider for .include directive paths
  // This enables Ctrl+hover underline and click navigation to included files
  const asmDefinitionProvider = vscode.languages.registerDefinitionProvider(
      { language: 'asm' }, { provideDefinition: provideIncludeDefinition });
  context.subscriptions.push(asmDefinitionProvider);

  // It provides symbol definition navigation in asm files
  // It enables Ctrl+hover underline and click navigation to symbol definitions
  // It uses cached symbol metadata from debug files.
  const asmSymbolDefinitionProvider = vscode.languages.registerDefinitionProvider(
    { language: 'asm' }, { provideDefinition: provideSymbolDefinition });
  context.subscriptions.push(asmSymbolDefinitionProvider);

  // Hover provider for asm files to show emulator symbol info when paused
  const asmHoverProvider = vscode.languages.registerHoverProvider(
    { language: 'asm' }, { provideHover: provideSymbolHover }
  );
  context.subscriptions.push(asmHoverProvider);


  // Persist breakpoints whenever they change in the debugger model
  const breakpointProvider = vscode.debug.onDidChangeBreakpoints(async (ev) =>
    {breakpointListener(ev, devectorOutput);});
  context.subscriptions.push(breakpointProvider);

  // Register ROM hot-reload functionality
  registerRomHotReload(context, devectorOutput);
}

export function deactivate() {
  clearSymbolMetadataCache();
}

////////////////////////////////////////////////////////////////////////////////
//
// ANYTHING BELOW UNCHECKED YET
//
////////////////////////////////////////////////////////////////////////////////
