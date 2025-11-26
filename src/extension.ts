import * as vscode from 'vscode';
import * as path from 'path';
import { assemble } from './assembler';
import { openEmulatorPanel, pauseEmulatorPanel, resumeEmulatorPanel, runFramePanel } from './emulatorUI';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('i8080.compile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showErrorMessage('Open an .asm file to compile'); return; }
    const doc = editor.document;
    if (!doc.fileName.endsWith('.asm')) { vscode.window.showWarningMessage('File does not have .asm extension, still attempting to assemble.'); }
    const src = doc.getText();
    // pass the document file path so assembler can resolve .include relative paths
    const res = assemble(src, doc.fileName);
    if (!res.success) { vscode.window.showErrorMessage('Assemble failed: ' + (res.errors || []).join('; ')); return; }
    const outPath = doc.fileName.replace(/\.asm$/i, '.bin');
    const fs = require('fs');
    fs.writeFileSync(outPath, res.output);
    vscode.window.showInformationMessage(`Assembled to ${path.basename(outPath)}`);
  });

  context.subscriptions.push(disposable);

  const runDisposable = vscode.commands.registerCommand('i8080.run', async () => {
    openEmulatorPanel(context);
  });
  context.subscriptions.push(runDisposable);

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
}

export function deactivate() {}
