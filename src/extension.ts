import * as vscode from 'vscode';
import * as path from 'path';
import * as ext_utils from './extention/utils';
import * as ext_prg from './extention/project';
import * as ext_consts from './extention/consts';
import { provideDefinition } from './extention/provider_include';
import { provideSymbolDefinition } from './extention/provider_symbol_definition';
import { createProject } from './extention/cmd_create_project';
import { compileProject } from './extention/cmd_compile_project';
import { toggleBreakpointFromArg } from './extention/cmd_toggle_bp';
import { provideHover } from './extention/provider_hover';
import {provideDebugConfigurations, resolveDebugConfiguration} from './extention/provider_debug_conf';


export function activate(context: vscode.ExtensionContext)
{
  const pendingBreakpointAsmPaths = new Set<string>();
  let breakpointCompilePromise: Promise<void> = Promise.resolve();

  let suppressBreakpointValidation = false;
  const devectorOutput = vscode.window.createOutputChannel('Devector');
  context.subscriptions.push(devectorOutput);


  const createProjectDisposable = vscode.commands.registerCommand(
    ext_consts.EXTENTION_NAME + '.createProject', () => createProject(devectorOutput, context));
  context.subscriptions.push(createProjectDisposable);

  const compileProjectDisposable = vscode.commands.registerCommand(
    ext_consts.EXTENTION_NAME + '.compileProject',() => compileProject(devectorOutput, context));
  context.subscriptions.push(compileProjectDisposable);

  // Register a debug configuration provider so the debugger is visible and
  // VS Code can present debug configurations and a F5 launch option.
  const dbgProvider: vscode.DebugConfigurationProvider = {
    provideDebugConfigurations,
    resolveDebugConfiguration: (folder, config, token) =>
      resolveDebugConfiguration(devectorOutput, context, folder, config, token)
  };
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(ext_consts.EXTENTION_NAME, dbgProvider));


  // Toggle breakpoint command: toggles a SourceBreakpoint at the current cursor line
  // const toggleBp = vscode.commands.registerCommand(
  //   ext_consts.EXTENTION_NAME + '.toggleBreakpoint', () => toggleBreakpoint());
  // context.subscriptions.push(toggleBp);

////////////////////////////////////////////////////////////////////////////////
//
// ANYTHING BELOW UNCHECKED YET
//
////////////////////////////////////////////////////////////////////////////////

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




  // TODO: it excessively compiles all projects on each breakpoint change!!!
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
        // compile project for the affected asm paths
        await ext_prg.compileProjectsForBreakpointChanges(devectorOutput);

      }).catch((err) => {
        ext_utils.logOutput(
          devectorOutput,
          'Devector: breakpoint-triggered project compile failed: ' +
          (err instanceof Error ? err.message : String(err)));
      });
  }));
}

export function deactivate() {}