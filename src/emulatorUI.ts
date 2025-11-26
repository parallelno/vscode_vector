import * as vscode from 'vscode';
import { Emulator } from './emulator';
import * as path from 'path';
import * as fs from 'fs';
import { HardwareReq } from './hardware_reqs';
import { FRAME_H, FRAME_LEN, FRAME_W } from './display';

let currentPanelController: { pause: () => void; resume: () => void; runInstructions?: (count: number) => void } | null = null;

export async function openEmulatorPanel(context: vscode.ExtensionContext)
{
  const panel = vscode.window.createWebviewPanel('Devector', 'Vector-06C Emulator', vscode.ViewColumn.One, {
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

  let romPath: string = candidates && candidates.length ? candidates[0].fsPath : '';
  const emu = new Emulator('', {}, romPath);

  // Create an output channel for per-instruction logs and attach a hook
  const emuOutput = vscode.window.createOutputChannel('Devector');
  context.subscriptions.push(emuOutput);
  // Bring the output channel forward so users see logs by default
  try {
    emuOutput.show(true);
    emuOutput.appendLine('Devector logging enabled');
  } catch (e) {}

  // Announce ROM load (path, size, load addr)
  try {
    const size = fs.statSync(romPath).size;
    emuOutput.appendLine(`ROM loaded: ${romPath} size=${size} bytes`);
    try { panel.webview.postMessage({ type: 'romLoaded', path: romPath, size, addr: 0x0100 }); } catch (e) {}
  } catch (e) {}

  // dispose the Output channel when the panel is closed
  panel.onDidDispose(() => { try { emuOutput.dispose(); } catch (e) {} }, null, context.subscriptions);

  // start emulation loop: Vector-06C: at 3 MHz and 50Hz
  const machineCyclesPerFrame = 59904 / 4;
  let running = true;

  // expose pause/resume controls and a 'run N instructions' helper for external commands
  currentPanelController = {
    pause: () => {
      running = false;
      try {
        // log current PC/opcode/regs to output channel and webview
        // const addr = emu.regs.PC & 0xffff;
        // const opcode = (emu as any).cpu.readByte(addr) & 0xff;
        // const regs = (emu as any).cpu.snapshotRegs ? (emu as any).cpu.snapshotRegs() : emu.regs;
        // const addrHex = addr.toString(16).padStart(4, '0');
        // const opHex = opcode.toString(16).padStart(2, '0');
        // const flagsStr = 'S=' + (regs.flags.S ? '1' : '0') + ' Z=' + (regs.flags.Z ? '1' : '0') + ' AC=' + (regs.flags.AC ? '1' : '0') + ' P=' + (regs.flags.P ? '1' : '0') + ' CY=' + (regs.flags.CY ? '1' : '0');
        // const hl = ((regs.H << 8) | regs.L) & 0xffff;
        // let mVal = 0;
        // try { mVal = (emu as any).cpu.readByte(hl) & 0xff; } catch (e) {}
        // const mHex = mVal.toString(16).padStart(2, '0');
        // const pcHex = (regs.PC & 0xffff).toString(16).padStart(4,'0');
        // const line = `PAUSE ${addrHex}: ${opHex} PC=${pcHex} A=${regs.A.toString(16).padStart(2,'0')} B=${regs.B.toString(16).padStart(2,'0')} C=${regs.C.toString(16).padStart(2,'0')} D=${regs.D.toString(16).padStart(2,'0')} E=${regs.E.toString(16).padStart(2,'0')} H=${regs.H.toString(16).padStart(2,'0')} L=${regs.L.toString(16).padStart(2,'0')} M=${mHex} SP=${regs.SP.toString(16).padStart(4,'0')} ${flagsStr}`;
        // try { emuOutput.appendLine(line); } catch(e) {}
        // try { panel.webview.postMessage({ type: 'pause', addr, opcode, regs, m: mVal, pc: regs.PC }); } catch(e) {}
      } catch (e) {}
    },
    resume: () => { if (!running) { running = true; tick(); } },
    runInstructions: (count: number) => {
      // stop regular frame loop while we run instructions
      running = false;
      try {
        // const result = emu.runUntilBreakpointOrHalt(count);
        // After running, emit a pause-like log
        try {
          // const addr = emu.regs.PC & 0xffff;
          // const opcode = (emu as any).cpu.readByte(addr) & 0xff;
          // const regs = (emu as any).cpu.snapshotRegs ? (emu as any).cpu.snapshotRegs() : emu.regs;
          // const addrHex = addr.toString(16).padStart(4, '0');
          // const opHex = opcode.toString(16).padStart(2, '0');
          // const flagsStr = 'S=' + (regs.flags.S ? '1' : '0') + ' Z=' + (regs.flags.Z ? '1' : '0') + ' AC=' + (regs.flags.AC ? '1' : '0') + ' P=' + (regs.flags.P ? '1' : '0') + ' CY=' + (regs.flags.CY ? '1' : '0');
          // const hl = ((regs.H << 8) | regs.L) & 0xffff;
          // let mVal = 0;
          // try { mVal = (emu as any).cpu.readByte(hl) & 0xff; } catch (e) {}
          // const mHex = mVal.toString(16).padStart(2, '0');
          // const pcHex = (regs.PC & 0xffff).toString(16).padStart(4,'0');
          // const line = `RUN ${count.toString(16)}: ${addrHex}: ${opHex} PC=${pcHex} A=${regs.A.toString(16).padStart(2,'0')} B=${regs.B.toString(16).padStart(2,'0')} C=${regs.C.toString(16).padStart(2,'0')} D=${regs.D.toString(16).padStart(2,'0')} E=${regs.E.toString(16).padStart(2,'0')} H=${regs.H.toString(16).padStart(2,'0')} L=${regs.L.toString(16).padStart(2,'0')} M=${mHex} SP=${regs.SP.toString(16).padStart(4,'0')} ${flagsStr}`;
          // try { emuOutput.appendLine(line); } catch (e) {}
          // try { panel.webview.postMessage({ type: 'pause', addr, opcode, regs, m: mVal, pc: regs.PC }); } catch (e) {}
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
      // const op = (keyboard as any).KeyHandling(msg.code, msg.kind === 'down' ? 'down' : 'up');
      // if (op === 'RESTART') {
      //   // quick restart: reload ROM and reset PC/SP
      //   if (romBuf) {
      //     emu.load(Buffer.from(romBuf), 0x0100);
      //     emu.regs.PC = 0x0000;
      //     emu.regs.SP = 0x0000;
      //   }
      // }
    } else if (msg && msg.type === 'stop') {
      running = false;
    }
  }, undefined, context.subscriptions);

  async function tick()
  {
    if (!running) return;

    const res = emu.hardware?.Request(HardwareReq.EXECUTE_FRAME_NO_BREAKS);
    const out = emu.hardware?.display?.GetFrame() || new Uint32Array(FRAME_LEN);

    try {
      panel.webview.postMessage({ type: 'frame', width: FRAME_W, height: FRAME_H, data: out.buffer });
    }
    catch (e) { /* ignore frame conversion errors */ }

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
  <canvas id="screen" width="256" height="256"></canvas>
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
