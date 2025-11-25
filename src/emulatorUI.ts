import * as vscode from 'vscode';
import { Emulator } from './emulator';
import IO from './io';
import Display from './display';
import Keyboard from './keyboard';
import * as path from 'path';
import * as fs from 'fs';

let currentPanelController: { pause: () => void; resume: () => void; runInstructions?: (count: number) => void } | null = null;

export async function openEmulatorPanel(context: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel('vectorEmu', 'Vector-06C Emulator', vscode.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'images'))]
  });

  const html = getWebviewContent();
  panel.webview.html = html;

  // Ask user to pick a ROM file (default: workspace root test.rom)
  const candidates: vscode.Uri[] | undefined = await vscode.window.showOpenDialog({
    canSelectMany: false,
    defaultUri: vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length ? vscode.Uri.file(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'test.rom')) : undefined,
    filters: { 'ROM': ['rom', 'bin', '*'] }
  });

  let romBuf: Buffer | undefined;
  let romPath: string | undefined;
  if (candidates && candidates.length) {
    romBuf = fs.readFileSync(candidates[0].fsPath);
    romPath = candidates[0].fsPath;
  } else {
    // try workspace test.rom
    const tryPath = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length ? path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'test.rom') : undefined;
    if (tryPath && fs.existsSync(tryPath)) romBuf = fs.readFileSync(tryPath);
  }

  if (!romBuf) {
    vscode.window.showErrorMessage('No ROM selected and no test.rom found in workspace.');
    return;
  }

  const emu = new Emulator();
  // load ROM at 0x0100
  emu.load(Buffer.from(romBuf), 0x0100);
  // ROM is loaded at 0x0100, but execution should start at 0x0000
  emu.regs.PC = 0x0000;

  // wire CPU to IO so IN/OUT opcodes can call into IO

  // create IO and Display instances wired to emulator memory
  const keyboard = new Keyboard();
  const io = new IO(keyboard);
  // attach io to cpu so cpu IN/OUT can call io.portIn/portOut
  try { (emu as any).cpu.io = io; } catch (e) {}
  const disp = new Display(emu.memory, io);

  // Create an output channel for per-instruction logs and attach a hook
  const cpuOutput = vscode.window.createOutputChannel('Vector-06C CPU');
  context.subscriptions.push(cpuOutput);
  // Bring the output channel forward so users see logs by default
  try { cpuOutput.show(true); cpuOutput.appendLine('Vector-06C CPU logging enabled'); } catch (e) {}
  // Announce ROM load (path, size, load addr)
  try {
    const size = romBuf ? romBuf.length : 0;
    const p = romPath || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length ? path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'test.rom') : '<unknown>');
    cpuOutput.appendLine(`ROM loaded: ${p} size=${size} bytes -> 0x0100`);
    try { panel.webview.postMessage({ type: 'romLoaded', path: p, size, addr: 0x0100 }); } catch (e) {}
  } catch (e) {}
  // Forward each executed instruction to the Output channel and to the webview
  try {
    emu.cpu.onInstruction = (info) => {
      try {
        const addrHex = info.addr.toString(16).padStart(4, '0');
        const opHex = (info.opcode & 0xff).toString(16).padStart(2, '0');
        const regs = info.regs;
        const flagsStr = 'S=' + (regs.flags.S ? '1' : '0') + ' Z=' + (regs.flags.Z ? '1' : '0') + ' AC=' + (regs.flags.AC ? '1' : '0') + ' P=' + (regs.flags.P ? '1' : '0') + ' CY=' + (regs.flags.CY ? '1' : '0');
        const hl = ((regs.H << 8) | regs.L) & 0xffff;
        let mVal = 0;
        try { mVal = (emu as any).cpu.readByte(hl) & 0xff; } catch (e) {}
        const mHex = mVal.toString(16).padStart(2, '0');
        const pcHex = (regs.PC).toString(16).padStart(6,'0');
        const line = `${addrHex}: ${opHex} PC=${pcHex} A=${regs.A.toString(16).padStart(2,'0')} B=${regs.B.toString(16).padStart(2,'0')} C=${regs.C.toString(16).padStart(2,'0')} D=${regs.D.toString(16).padStart(2,'0')} E=${regs.E.toString(16).padStart(2,'0')} H=${regs.H.toString(16).padStart(2,'0')} L=${regs.L.toString(16).padStart(2,'0')} M=${mHex} SP=${regs.SP.toString(16).padStart(4,'0')} ${flagsStr}`;
        cpuOutput.appendLine(line);
        // also post to webview so the page can optionally log it
        panel.webview.postMessage({ type: 'instr', addr: info.addr, opcode: info.opcode, regs: info.regs, m: mVal, pc: regs.PC });
      } catch (e) {}
    };
  } catch (e) {}

  panel.onDidDispose(() => { try { cpuOutput.dispose(); } catch (e) {} }, null, context.subscriptions);

  // start emulation loop: Vector-06C: ~59904 cycles per frame at 3 MHz and 50Hz
  const cyclesPerFrame = 59904;
  let running = true;

  // expose pause/resume controls and a 'run N instructions' helper for external commands
  currentPanelController = {
    pause: () => {
      running = false;
      try {
        // log current PC/opcode/regs to output channel and webview
        const addr = emu.regs.PC & 0xffff;
        const opcode = (emu as any).cpu.readByte(addr) & 0xff;
        const regs = (emu as any).cpu.snapshotRegs ? (emu as any).cpu.snapshotRegs() : emu.regs;
        const addrHex = addr.toString(16).padStart(4, '0');
        const opHex = opcode.toString(16).padStart(2, '0');
        const flagsStr = 'S=' + (regs.flags.S ? '1' : '0') + ' Z=' + (regs.flags.Z ? '1' : '0') + ' AC=' + (regs.flags.AC ? '1' : '0') + ' P=' + (regs.flags.P ? '1' : '0') + ' CY=' + (regs.flags.CY ? '1' : '0');
        const hl = ((regs.H << 8) | regs.L) & 0xffff;
        let mVal = 0;
        try { mVal = (emu as any).cpu.readByte(hl) & 0xff; } catch (e) {}
        const mHex = mVal.toString(16).padStart(2, '0');
        const pcHex = (regs.PC & 0xffff).toString(16).padStart(4,'0');
        const line = `PAUSE ${addrHex}: ${opHex} PC=${pcHex} A=${regs.A.toString(16).padStart(2,'0')} B=${regs.B.toString(16).padStart(2,'0')} C=${regs.C.toString(16).padStart(2,'0')} D=${regs.D.toString(16).padStart(2,'0')} E=${regs.E.toString(16).padStart(2,'0')} H=${regs.H.toString(16).padStart(2,'0')} L=${regs.L.toString(16).padStart(2,'0')} M=${mHex} SP=${regs.SP.toString(16).padStart(4,'0')} ${flagsStr}`;
        try { cpuOutput.appendLine(line); } catch(e) {}
        try { panel.webview.postMessage({ type: 'pause', addr, opcode, regs, m: mVal, pc: regs.PC }); } catch(e) {}
      } catch (e) {}
    },
    resume: () => { if (!running) { running = true; tick(); } },
    runInstructions: (count: number) => {
      // stop regular frame loop while we run instructions
      running = false;
      try {
        const result = emu.runUntilBreakpointOrHalt(count);
        // After running, emit a pause-like log
        try {
          const addr = emu.regs.PC & 0xffff;
          const opcode = (emu as any).cpu.readByte(addr) & 0xff;
          const regs = (emu as any).cpu.snapshotRegs ? (emu as any).cpu.snapshotRegs() : emu.regs;
          const addrHex = addr.toString(16).padStart(4, '0');
          const opHex = opcode.toString(16).padStart(2, '0');
          const flagsStr = 'S=' + (regs.flags.S ? '1' : '0') + ' Z=' + (regs.flags.Z ? '1' : '0') + ' AC=' + (regs.flags.AC ? '1' : '0') + ' P=' + (regs.flags.P ? '1' : '0') + ' CY=' + (regs.flags.CY ? '1' : '0');
          const hl = ((regs.H << 8) | regs.L) & 0xffff;
          let mVal = 0;
          try { mVal = (emu as any).cpu.readByte(hl) & 0xff; } catch (e) {}
          const mHex = mVal.toString(16).padStart(2, '0');
          const pcHex = (regs.PC & 0xffff).toString(16).padStart(4,'0');
          const line = `RUN ${count.toString(16)}: ${addrHex}: ${opHex} PC=${pcHex} A=${regs.A.toString(16).padStart(2,'0')} B=${regs.B.toString(16).padStart(2,'0')} C=${regs.C.toString(16).padStart(2,'0')} D=${regs.D.toString(16).padStart(2,'0')} E=${regs.E.toString(16).padStart(2,'0')} H=${regs.H.toString(16).padStart(2,'0')} L=${regs.L.toString(16).padStart(2,'0')} M=${mHex} SP=${regs.SP.toString(16).padStart(4,'0')} ${flagsStr}`;
          try { cpuOutput.appendLine(line); } catch (e) {}
          try { panel.webview.postMessage({ type: 'pause', addr, opcode, regs, m: mVal, pc: regs.PC }); } catch (e) {}
        } catch (e) {}
      } finally {
        // leave emulator paused
        running = false;
      }
    }
  };

  panel.webview.onDidReceiveMessage(msg => {
    if (msg && msg.type === 'key') {
      // keyboard events: forward to keyboard handling
      const op = keyboard.keyHandling(msg.code, msg.kind === 'down' ? 'down' : 'up');
      if (op === 'RESTART') {
        // quick restart: reload ROM and reset PC/SP
        if (romBuf) {
          emu.load(Buffer.from(romBuf), 0x0100);
          emu.regs.PC = 0x0000;
          emu.regs.SP = 0x0000;
        }
      }
    } else if (msg && msg.type === 'stop') {
      running = false;
    }
  }, undefined, context.subscriptions);

  async function tick() {
    if (!running) return;
    // Execute cycle-accurate CPU slices for this frame. `runCycles` will call
    // the provided callback once per 4 CPU cycles (this is where raster/IO
    // should be advanced). Right now the callback is a placeholder.
    const res = emu.runCycles(cyclesPerFrame, (cyclesAdvanced) => {
      // cyclesAdvanced === 4 per callback invocation.
      // advance the rasterizer by one chunk per 4 cycles
      disp.rasterizeChunk();
    });
    if (res.halted) { running = false; return; }
    // request scaled frame from display and post to webview
    const frame = disp.getScaledFrame();
    panel.webview.postMessage({ type: 'frame', width: frame.width, height: frame.height, data: frame.data.buffer });

    // schedule next frame at ~50fps
    setTimeout(tick, 1000 / 50);
  }

  tick();

  panel.onDidDispose(() => {
    currentPanelController = null;
  }, null, context.subscriptions);
}

export function pauseEmulatorPanel() {
  if (currentPanelController) currentPanelController.pause();
  else vscode.window.showWarningMessage('Emulator panel not open');
}

export function resumeEmulatorPanel() {
  if (currentPanelController) currentPanelController.resume();
  else vscode.window.showWarningMessage('Emulator panel not open');
}

export function run10KInstructionsPanel() {
  if (currentPanelController && currentPanelController.runInstructions) {
    // run 0x10000 instructions then pause
    currentPanelController.runInstructions(0x10000);
  } else {
    vscode.window.showWarningMessage('Emulator panel not open');
  }
}

function getWebviewContent() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>body{margin:0;background:#000;color:#fff}canvas{display:block;margin:0 auto;background:#111}</style>
</head>
<body>
  <canvas id="screen" width="256" height="192"></canvas>
  <script>
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('screen');
    const ctx = canvas.getContext('2d');
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'frame') {
        const w = msg.width, h = msg.height;
        const buf = new Uint8ClampedArray(msg.data);
        const img = new ImageData(buf, w, h);
        // scale canvas to fit container
        canvas.width = w; canvas.height = h;
        ctx.putImageData(img, 0, 0);
      } else if (msg.type === 'instr') {
        try {
          const a = msg.addr.toString(16).padStart(4,'0');
          const o = (msg.opcode & 0xff).toString(16).padStart(2,'0');
          const regs = msg.regs || {};
          const flagsStr = 'S=' + ((regs.flags && regs.flags.S) ? '1' : '0') + ' Z=' + ((regs.flags && regs.flags.Z) ? '1' : '0') + ' AC=' + ((regs.flags && regs.flags.AC) ? '1' : '0') + ' P=' + ((regs.flags && regs.flags.P) ? '1' : '0') + ' CY=' + ((regs.flags && regs.flags.CY) ? '1' : '0');
          const mHex = (msg.m !== undefined) ? msg.m.toString(16).padStart(2,'0') : '??';
          const pcHex = (msg.pc !== undefined) ? (msg.pc & 0xffff).toString(16).padStart(4,'0') : ((msg.regs && msg.regs.PC) ? (msg.regs.PC & 0xffff).toString(16).padStart(4,'0') : '????');
          console.log('CPU ' + a + ': ' + o + ' PC=' + pcHex + ' M=' + mHex + ' ' + flagsStr, msg.regs);
        } catch (e) { /* ignore malformed messages */ }
      } else if (msg.type === 'pause') {
        try {
          const a = msg.addr.toString(16).padStart(4,'0');
          const o = (msg.opcode & 0xff).toString(16).padStart(2,'0');
          const regs = msg.regs || {};
          const flagsStr = 'S=' + ((regs.flags && regs.flags.S) ? '1' : '0') + ' Z=' + ((regs.flags && regs.flags.Z) ? '1' : '0') + ' AC=' + ((regs.flags && regs.flags.AC) ? '1' : '0') + ' P=' + ((regs.flags && regs.flags.P) ? '1' : '0') + ' CY=' + ((regs.flags && regs.flags.CY) ? '1' : '0');
          const mHex = (msg.m !== undefined) ? msg.m.toString(16).padStart(2,'0') : '??';
          const pcHex = (msg.pc !== undefined) ? (msg.pc & 0xffff).toString(16).padStart(4,'0') : ((msg.regs && msg.regs.PC) ? (msg.regs.PC & 0xffff).toString(16).padStart(4,'0') : '????');
          console.log('--- PAUSED --- CPU ' + a + ': ' + o + ' PC=' + pcHex + ' M=' + mHex + ' ' + flagsStr, msg.regs);
        } catch (e) { /* ignore malformed messages */ }
      }
      else if (msg.type === 'romLoaded') {
        try {
          console.log('ROM loaded: ' + (msg.path || '<unknown>') + ' size=' + (msg.size || 0) + ' addr=0x' + (msg.addr !== undefined ? msg.addr.toString(16).padStart(4,'0') : '0100'));
        } catch (e) { }
      }
    });
    // keyboard forwarding
    window.addEventListener('keydown', e => {
      vscode.postMessage({ type: 'key', kind: 'down', key: e.key, code: e.code });
      e.preventDefault();
    });
    window.addEventListener('keyup', e => {
      vscode.postMessage({ type: 'key', kind: 'up', key: e.key, code: e.code });
      e.preventDefault();
    });
  </script>
</body>
</html>`;
}
