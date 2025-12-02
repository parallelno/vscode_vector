import * as vscode from 'vscode';
import { Emulator } from './emulator';
import * as path from 'path';
import * as fs from 'fs';
import { Hardware } from './hardware';
import { HardwareReq } from './hardware_reqs';
import { FRAME_H, FRAME_LEN, FRAME_W } from './display';
import Memory, { AddrSpace } from './memory';
import CPU, { CpuState } from './cpu_i8080';

const log_every_frame = false;
const log_tick_to_file = false;

let currentPanelController: { pause: () => void; resume: () => void; runFrame: () => void; } | null = null;

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

  let debugStream: fs.WriteStream | null = null;


  // Create an output channel for per-instruction logs and attach a hook
  const emuOutput = vscode.window.createOutputChannel('Devector');
  context.subscriptions.push(emuOutput);
  // Bring the output channel forward so users see logs by default
  try {
    emuOutput.show(true);
    emuOutput.appendLine('Devector logging enabled');
  } catch (e) {}

  // prepare instruction debug log next to the ROM file (now that emuOutput exists)
  try {
    if (log_tick_to_file && romPath) {
      const parsed = path.parse(romPath);
      const logName = parsed.name + '.debug.log';
      const logPath = path.join(parsed.dir, logName);
      debugStream = fs.createWriteStream(logPath, { flags: 'w' });
      try { emuOutput.appendLine(`Instruction debug log: ${logPath}`); } catch (e) {}
    }
  } catch (e) { debugStream = null; }

  // Announce ROM load (path, size, load addr)
  try {
    const size = fs.statSync(romPath).size;
    emuOutput.appendLine(`ROM loaded: ${romPath} size=${size} bytes`);
    try { panel.webview.postMessage({ type: 'romLoaded', path: romPath, size, addr: 0x0100 }); } catch (e) {}
  } catch (e) {}

  // dispose the Output channel when the panel is closed
  panel.onDidDispose(
    () => {
      try { emuOutput.dispose(); }
      catch (e) {}
      try { if (debugStream) { debugStream.end(); } }
      catch (ee) {}
    }, null, context.subscriptions
  );

  // attach debugger and sync breakpoints from the compiled token file, if available
  emu.hardware?.Request(HardwareReq.DEBUG_ATTACH, { data: true });
  emu.hardware?.Request(HardwareReq.RUN);

  const appliedBreakpoints = loadBreakpointsFromToken(romPath, emu.hardware, emuOutput);
  if (appliedBreakpoints > 0) {
    try { emuOutput.appendLine(`Loaded ${appliedBreakpoints} breakpoint(s) from token file.`); } catch (e) {}
  }

  // expose pause/resume controls and a 'run N instructions' helper for external commands
  currentPanelController = {
    pause: () => {
      emu.hardware?.Request(HardwareReq.STOP);
      printDebugState('Pause:', emu.hardware!, emuOutput, panel);
    },
    resume: () => {
      let running = emu.hardware?.Request(HardwareReq.IS_RUNNING)['isRunning'] ?? false;
      if (!running) {
        emu.hardware?.Request(HardwareReq.RUN);
        tick();
      }
    },
    runFrame: () => {
      emu.hardware?.Request(HardwareReq.STOP);
      tick(true); }
  };

  // attach per-instruction callback to hardware (if available)
  try {
    if (log_every_frame && emu.hardware) {
      emu.hardware.debugInstructionCallback = (hw) => {
        try {
          const line = getDebugLine(hw)
          if (debugStream && line) {
            debugStream.write(line + '\n');
          }
        } catch (e) { }
      };
    }
  } catch (e) { }

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
      emu.hardware?.Request(HardwareReq.STOP);
    }
  }, undefined, context.subscriptions);

  async function tick(log_every_frame: boolean = false)
  {
    emu.hardware?.Request(HardwareReq.EXECUTE_FRAME);
    const out = emu.hardware?.display?.GetFrame() || new Uint32Array(FRAME_LEN);
    try {
      panel.webview.postMessage({ type: 'frame', width: FRAME_W, height: FRAME_H, data: out.buffer });
    }
    catch (e) { /* ignore frame conversion errors */ }


    // logging
    if (log_every_frame){
      printDebugState('hw stats:', emu.hardware!, emuOutput, panel);
    }
    let running = emu.hardware?.Request(HardwareReq.IS_RUNNING)['isRunning'] ?? false;
    if (!running) {
      printDebugState('Break:', emu.hardware!, emuOutput, panel);
      return
    }

    // schedule next frame at ~50fps
    setTimeout(tick, 1000 / 50);
  }

  tick();

  panel.onDidDispose(() => {
    // Stop the emulation hardware thread to free resources
    try { emu.hardware?.Request(HardwareReq.EXIT); } catch (e) {}
    try { if (debugStream) { debugStream.end(); } } catch (e) {}
    currentPanelController = null;
  }, null, context.subscriptions);
}


// helper: read cpu/memory state and return a compact debug object
function getDebugState(hardware: Hardware)
{
  const state = hardware?.cpu?.state ?? new CpuState();
  const pc = state.regs.pc.word;
  const global_addr = hardware?.memory?.GetGlobalAddr(pc, AddrSpace.RAM) ?? 0;
  const opcode = hardware?.memory?.GetByte(pc) ?? 0;
  const byte1 = hardware?.memory?.GetByte(pc + 1) ?? 0;
  const byte2 = hardware?.memory?.GetByte(pc + 2) ?? 0;
  const instr_len = CPU.GetInstrLen(opcode);
  return { global_addr, state, opcode, byte1, byte2, instr_len};
}

function printDebugState(
  header:string, hardware: Hardware,
  emuOutput: vscode.OutputChannel,
  panel: vscode.WebviewPanel)
{
  const line = getDebugLine(hardware);
  try {
    emuOutput.appendLine((header ? header + ' ' : '') + line);
  } catch (e) {}

  // try { panel.webview.postMessage(
  //       { type: 'pause', addr: s.pc, opcode: s.opcode, regs: s.state.regs, m: mVal, pc: s.state.regs.pc.word });
  //     } catch (e) {}
}

function getDebugLine(hardware: Hardware): string {
  let line = '';
  try {
      const s = getDebugState(hardware!);

      const addrHex = s.global_addr.toString(16).toUpperCase().padStart(6, '0');
      const opHex = s.opcode.toString(16).toUpperCase().padStart(2, '0');
      const byteHex1 = s.instr_len > 1 ?
                      s.byte1.toString(16).toUpperCase().padStart(2, '0') :
                      '  ';
      const byteHex2 = s.instr_len > 2 ?
                      s.byte2.toString(16).toUpperCase().padStart(2, '0') :
                      '  ';
      const framebufferIdx = hardware.display ? hardware.display.framebufferIdx : 0;
      const x = framebufferIdx % FRAME_W;
      const y = (framebufferIdx / FRAME_W) | 0;
      const scrollIdx = hardware.display ? hardware.display.scrollIdx : 0;
      const cc = s.state.cc;

      line = `${addrHex}  ${opHex} ${byteHex1} ${byteHex2}  `+
        `A=${(s.state.regs.af.a).toString(16).toUpperCase().padStart(2,'0')} `+
        `BC=${(s.state.regs.bc.word).toString(16).toUpperCase().padStart(4,'0')} `+
        `DE=${(s.state.regs.de.word).toString(16).toUpperCase().padStart(4,'0')} `+
        `HL=${(s.state.regs.hl.word).toString(16).toUpperCase().padStart(4,'0')} `+
        `SP=${(s.state.regs.sp.word).toString(16).toUpperCase().padStart(4,'0')} ` +
        `S${s.state.regs.af.s ? '1' : '0'} ` +
        `Z${s.state.regs.af.z ? '1' : '0'} ` +
        `AC${s.state.regs.af.ac ? '1' : '0'} ` +
        `P${s.state.regs.af.p ? '1' : '0'} ` +
        `CY${s.state.regs.af.c ? '1' : '0'} ` +
        `CC=${cc.toString(10).toUpperCase().padStart(12,'0')} ` +
        `scr=${x.toString(10).toUpperCase().padStart(3,'0')}/` +
        `${y.toString(10).toUpperCase().padStart(3,'0')} ` +
        `scrl=${scrollIdx.toString(16).toUpperCase().padStart(2,'0')}`;
    }
    catch (e) {
      return '(error reading state)';
    }

    return line;
}


export function pauseEmulatorPanel() {
  if (currentPanelController) currentPanelController.pause();
  else vscode.window.showWarningMessage('Emulator panel not open');
}

export function resumeEmulatorPanel() {
  if (currentPanelController) currentPanelController.resume();
  else vscode.window.showWarningMessage('Emulator panel not open');
}

export function runFramePanel() {
  if (currentPanelController && currentPanelController.runFrame) {
    currentPanelController.runFrame();
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
          // msg.data is an ArrayBuffer containing native RGBA bytes (R,G,B,A per pixel)
          try {
            const buf = new Uint8ClampedArray(msg.data);
            const img = new ImageData(buf, w, h);
            // scale canvas to fit container
            canvas.width = w; canvas.height = h;
            ctx.putImageData(img, 0, 0);
          } catch (e) {
            // If that fails, try interpreting data as a 32-bit view and fall back
            try {
              const src32 = new Uint32Array(msg.data);
              const buf = new Uint8ClampedArray(src32.buffer);
              const img = new ImageData(buf, w, h);
              canvas.width = w; canvas.height = h;
              ctx.putImageData(img, 0, 0);
            } catch (ee) { /* ignore */ }
          }
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

function loadBreakpointsFromToken(romPath: string, hardware: Hardware | undefined | null, log?: vscode.OutputChannel): number {
  if (!hardware || !romPath) return 0;
  const tokenPath = deriveTokenPath(romPath);
  if (!tokenPath || !fs.existsSync(tokenPath)) return 0;

  let tokens: any;
  try {
    tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch (err) {
    try { log?.appendLine(`Failed to parse token file ${tokenPath}: ${err}`); } catch (e) {}
    return 0;
  }

  const desired = collectBreakpointAddresses(tokens);
  if (!desired.size) return 0;

  try { hardware.Request(HardwareReq.DEBUG_BREAKPOINT_DEL_ALL); } catch (e) {}
  for (const [addr, meta] of desired) {
    try { hardware.Request(HardwareReq.DEBUG_BREAKPOINT_ADD, { addr }); } catch (e) {}
    if (meta.enabled === false) {
      try { hardware.Request(HardwareReq.DEBUG_BREAKPOINT_DISABLE, { addr }); } catch (e) {}
    }
  }

  try {
    log?.appendLine(`Applied ${desired.size} breakpoint${desired.size === 1 ? '' : 's'} from ${path.basename(tokenPath)}`);
  } catch (e) {}
  return desired.size;
}

function deriveTokenPath(romPath: string): string {
  if (!romPath) return '';
  if (/\.[^/.]+$/.test(romPath)) return romPath.replace(/\.[^/.]+$/, '.debug.json');
  return romPath + '.debug.json';
}

type BreakpointMeta = { enabled?: boolean };

function collectBreakpointAddresses(tokens: any): Map<number, BreakpointMeta> {
  const resolved = new Map<number, BreakpointMeta>();
  if (!tokens || typeof tokens !== 'object') return resolved;

  const labelAddrByName = new Map<string, number>();
  const lineAddrByFileLine = new Map<string, number>();

  if (tokens.labels && typeof tokens.labels === 'object') {
    for (const [labelName, rawInfo] of Object.entries(tokens.labels)) {
      const info = rawInfo as any;
      const addr = parseAddressLike(info?.addr ?? info?.address);
      if (addr === undefined) continue;
      labelAddrByName.set(labelName, addr);
      const srcBase = normalizeFileKey(typeof info?.src === 'string' ? info.src : undefined);
      const lineNum = typeof info?.line === 'number' ? info.line : undefined;
      if (srcBase && lineNum !== undefined) {
        lineAddrByFileLine.set(formatFileLineKey(srcBase, lineNum), addr);
      }
    }
  }

  if (tokens.lineAddresses && typeof tokens.lineAddresses === 'object') {
    for (const [fileKeyRaw, entries] of Object.entries(tokens.lineAddresses)) {
      if (!entries || typeof entries !== 'object') continue;
      const normalizedFileKey = typeof fileKeyRaw === 'string' ? fileKeyRaw.toLowerCase() : undefined;
      if (!normalizedFileKey) continue;
      for (const [lineKey, addrRaw] of Object.entries(entries as Record<string, any>)) {
        const addr = parseAddressLike(addrRaw);
        if (addr === undefined) continue;
        const lineNum = Number(lineKey);
        if (!Number.isFinite(lineNum)) continue;
        lineAddrByFileLine.set(formatFileLineKey(normalizedFileKey, lineNum), addr);
      }
    }
  }

  const registerBreakpoint = (addr: number | undefined, enabled: boolean | undefined) => {
    if (addr === undefined) return;
    const normalized = addr & 0xffff;
    if (!resolved.has(normalized)) {
      resolved.set(normalized, { enabled });
      return;
    }
    if (enabled !== undefined) resolved.set(normalized, { enabled });
  };

  const resolveEnabled = (entry: any): boolean | undefined => {
    if (!entry || typeof entry !== 'object') return undefined;
    if (typeof entry.enabled === 'boolean') return entry.enabled;
    if (typeof entry.status === 'number') return entry.status !== 0;
    return undefined;
  };

    const resolveAddress = (entry: any, fileKey?: string): number | undefined => {
    if (!entry || typeof entry !== 'object') return parseAddressLike(entry);
    const direct = parseAddressLike(entry.addr ?? entry.address);
    if (direct !== undefined) return direct;
    if (typeof entry.label === 'string') {
      const byLabel = labelAddrByName.get(entry.label);
      if (byLabel !== undefined) return byLabel;
    }
    if (fileKey && typeof entry.line === 'number') {
        const fromLine = lineAddrByFileLine.get(formatFileLineKey(fileKey, entry.line));
      if (fromLine !== undefined) return fromLine;
    }
    return undefined;
  };

  const processEntry = (entry: any, fileKey?: string) => {
    const normalizedFile = fileKey ? normalizeFileKey(fileKey) : undefined;
    const addr = resolveAddress(entry, normalizedFile);
    if (addr === undefined) return;
    registerBreakpoint(addr, resolveEnabled(entry));
  };

  const bpData = tokens.breakpoints;
  if (Array.isArray(bpData)) {
    for (const entry of bpData) processEntry(entry);
  } else if (bpData && typeof bpData === 'object') {
    for (const [fileKey, entries] of Object.entries(bpData)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) processEntry(entry, fileKey);
    }
  }

  return resolved;
}

function parseAddressLike(value: any): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value & 0xffff;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return parseInt(trimmed.slice(2), 16) & 0xffff;
    if (/^\$[0-9a-fA-F]+$/.test(trimmed)) return parseInt(trimmed.slice(1), 16) & 0xffff;
    if (/^[0-9]+$/.test(trimmed)) return parseInt(trimmed, 10) & 0xffff;
  }
  return undefined;
}

function normalizeFileKey(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  return path.basename(filePath).toLowerCase();
}

function formatFileLineKey(fileKey: string, line: number): string {
  return `${fileKey}#${line}`;
}
