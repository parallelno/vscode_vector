import * as vscode from 'vscode';
import { Emulator } from './emulator';
import * as path from 'path';
import * as fs from 'fs';
import { Hardware } from './hardware';
import { HardwareReq } from './hardware_reqs';
import { FRAME_H, FRAME_LEN, FRAME_W } from './display';
import Memory, { AddrSpace, MAPPING_MODE_MASK } from './memory';
import CPU, { CpuState } from './cpu_i8080';

const log_every_frame = false;
const log_tick_to_file = false;

type SourceLineRef = { file: string; line: number };

let lastBreakpointSource: { romPath: string; hardware?: Hardware | null; log?: vscode.OutputChannel } | null = null;
let lastAddressSourceMap: Map<number, SourceLineRef> | null = null;
let highlightContext: vscode.ExtensionContext | null = null;
let pausedLineDecoration: vscode.TextEditorDecorationType | null = null;
let lastHighlightedEditor: vscode.TextEditor | null = null;
let currentToolbarIsRunning = true;

let currentPanelController: { pause: () => void; resume: () => void; stepFrame: () => void; } | null = null;

const MEMORY_DUMP_LINE_BYTES = 16;
const MEMORY_DUMP_LINES = 16;
const MEMORY_DUMP_TOTAL_BYTES = MEMORY_DUMP_LINE_BYTES * MEMORY_DUMP_LINES;
const MEMORY_ADDRESS_MASK = 0xffff;
let memoryDumpFollowPc = true;
let memoryDumpStartAddr = 0;
let memoryDumpAnchorAddr = 0;
const STACK_SAMPLE_OFFSETS = [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10];
let hwStatsStartTime = Date.now();
let hwStatsLastUpdate: number | null = null;
const HW_STATS_FRAME_INTERVAL = 50;
let hwStatsFrameCountdown = HW_STATS_FRAME_INTERVAL;

export async function openEmulatorPanel(context: vscode.ExtensionContext, logChannel?: vscode.OutputChannel)
{
  const panel = vscode.window.createWebviewPanel('Devector', 'Vector-06C Emulator', vscode.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'images'))]
  });

  const html = getWebviewContent();
  panel.webview.html = html;
  highlightContext = context;
  ensureHighlightDecoration(context);
  currentToolbarIsRunning = true;
  hwStatsStartTime = Date.now();
  hwStatsLastUpdate = null;
  hwStatsFrameCountdown = 0;
  memoryDumpFollowPc = true;
  memoryDumpStartAddr = 0;
  memoryDumpAnchorAddr = 0;

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
  const ownsOutputChannel = !logChannel;
  const emuOutput = logChannel ?? vscode.window.createOutputChannel('Devector');
  if (ownsOutputChannel) {
    context.subscriptions.push(emuOutput);
  }
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
      try {
        if (ownsOutputChannel) {
          emuOutput.dispose();
        }
      }
      catch (e) {}
      try { if (debugStream) { debugStream.end(); } }
      catch (ee) {}
    }, null, context.subscriptions
  );

  // attach debugger and sync breakpoints from the compiled token file, if available
  emu.hardware?.Request(HardwareReq.DEBUG_ATTACH, { data: true });
  emu.hardware?.Request(HardwareReq.RUN);

  const appliedBreakpoints = loadBreakpointsFromToken(romPath, emu.hardware, emuOutput);

  lastBreakpointSource = { romPath, hardware: emu.hardware, log: emuOutput };

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

  const sendHardwareStats = (force: boolean = false) => {
    if (!force) {
      hwStatsFrameCountdown--;
      if (hwStatsFrameCountdown > 0) {
        return;
      }
    }
    hwStatsFrameCountdown = HW_STATS_FRAME_INTERVAL;
    const snapshot = collectHardwareStats(emu.hardware);
    if (!snapshot) return;
    try {
      panel.webview.postMessage(snapshot);
    } catch (e) {
      /* ignore stats sync errors */
    }
  };

  const sendFrameToWebview = () => {
    const out = emu.hardware?.display?.GetFrame() || new Uint32Array(FRAME_LEN);
    try {
      panel.webview.postMessage({ type: 'frame', width: FRAME_W, height: FRAME_H, data: out.buffer });
    }
    catch (e) { /* ignore frame conversion errors */ }
    sendHardwareStats();
  };

  const postToolbarState = (isRunning: boolean) => {
    try {
      panel.webview.postMessage({ type: 'toolbarState', isRunning });
    } catch (e) { /* ignore toolbar sync errors */ }
  };

  const emitToolbarState = (isRunning: boolean) => {
    currentToolbarIsRunning = isRunning;
    postToolbarState(isRunning);
    if (isRunning) {
      clearHighlightedSourceLine();
    }
  };

  const syncToolbarState = () => {
    postToolbarState(currentToolbarIsRunning);
  };

  const handleDebugAction = (action?: string) => {
    if (!action || !emu.hardware) return;
    switch (action) {
      case 'pause':
        emu.hardware.Request(HardwareReq.STOP);
        sendFrameToWebview();
        printDebugState('Pause:', emu.hardware, emuOutput, panel);
        emitToolbarState(false);
        break;
      case 'run':
        emu.hardware.Request(HardwareReq.RUN);
        emitToolbarState(true);
        tick();
        break;
      case 'stepInto':
        emu.hardware.Request(HardwareReq.STOP);
        emu.hardware?.Request(HardwareReq.EXECUTE_INSTR);
        sendFrameToWebview();
        printDebugState('Step into:', emu.hardware, emuOutput, panel);
        break;
      case 'stepOver':
        emu.hardware.Request(HardwareReq.STOP);
        // TODO: implement proper step over by setting a temporary breakpoint after the CALL/RET
        emu.hardware?.Request(HardwareReq.EXECUTE_INSTR);
        sendFrameToWebview();
        printDebugState('Step over (NOT IMPLEMENTED):', emu.hardware, emuOutput, panel);
        break;
      case 'stepOut':
        emu.hardware.Request(HardwareReq.STOP);
        // TODO: implement proper step out
        emu.hardware?.Request(HardwareReq.EXECUTE_INSTR);
        sendFrameToWebview();
        printDebugState('Step out (NOT IMPLEMENTED):', emu.hardware, emuOutput, panel);
        break;
      case 'stepFrame':
        emu.hardware.Request(HardwareReq.STOP);
        emu.hardware.Request(HardwareReq.EXECUTE_FRAME_NO_BREAKS);
        sendFrameToWebview();
        printDebugState('Run frame:', emu.hardware, emuOutput, panel);
        emitToolbarState(false);
        break;
      case 'step256':
        emu.hardware.Request(HardwareReq.STOP);
        for (let i = 0; i < 256; i++) {
          emu.hardware.Request(HardwareReq.EXECUTE_INSTR);
        }
        sendFrameToWebview();
        printDebugState('Step 256:', emu.hardware, emuOutput, panel);
        break;
      case 'restart':
        emu.hardware.Request(HardwareReq.STOP);
        emu.hardware.Request(HardwareReq.RESET);
        emu.hardware.Request(HardwareReq.RESTART);
        emu.Load(romPath);
        emu.hardware.Request(HardwareReq.RUN);
        emitToolbarState(true);
        tick();
        break;
      default:
        break;
    }
  };

  currentPanelController = {
    pause: () => {
      emu.hardware?.Request(HardwareReq.STOP);
      printDebugState('Pause:', emu.hardware!, emuOutput, panel);
      emitToolbarState(false);
    },
    resume: () => {
      let running = emu.hardware?.Request(HardwareReq.IS_RUNNING)['isRunning'] ?? false;
      if (!running) {
        emu.hardware?.Request(HardwareReq.RUN);
        emitToolbarState(true);
        tick();
      }
    },
    stepFrame: () => {
      if (!emu.hardware) return;
      emu.hardware.Request(HardwareReq.STOP);
      emu.hardware.Request(HardwareReq.EXECUTE_FRAME_NO_BREAKS);
      sendFrameToWebview();
      printDebugState('Run frame:', emu.hardware, emuOutput, panel);
      emitToolbarState(false);
    }
  };

  updateMemoryDumpFromHardware(panel, emu.hardware, 'pc');
  sendHardwareStats(true);

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
      emitToolbarState(false);
    } else if (msg && msg.type === 'debugAction') {
      handleDebugAction(msg.action);
    } else if (msg && msg.type === 'memoryDumpControl') {
      handleMemoryDumpControlMessage(msg, panel, emu.hardware);
    }
  }, undefined, context.subscriptions);

  panel.onDidChangeViewState(() => {
    if (panel.visible) {
      syncToolbarState();
    }
  }, null, context.subscriptions);

  async function tick(log_every_frame: boolean = false)
  {
    let running = true;

    do {
      let startTime = performance.now();

      emu.hardware?.Request(HardwareReq.EXECUTE_FRAME);
      sendFrameToWebview();

      // logging
      if (log_every_frame){
        printDebugState('hw stats:', emu.hardware!, emuOutput, panel, false);
      }

      running = emu.hardware?.Request(HardwareReq.IS_RUNNING)['isRunning'] ?? false;

      // throttle to approx real-time
      const elapsed = performance.now() - startTime;
      if (elapsed < 1000/60) {
        await new Promise(resolve => setTimeout(resolve, 1000/60 - elapsed));
      }

    } while (running);


    printDebugState('Break:', emu.hardware!, emuOutput, panel);
    emitToolbarState(false);
  }

  emitToolbarState(true);
  tick();

  panel.onDidDispose(() => {
    // Stop the emulation hardware thread to free resources
    try { emu.hardware?.Request(HardwareReq.EXIT); } catch (e) {}
    try { if (debugStream) { debugStream.end(); } } catch (e) {}
    currentPanelController = null;
    lastBreakpointSource = null;
    clearHighlightedSourceLine();
    lastAddressSourceMap = null;
    highlightContext = null;
    memoryDumpFollowPc = true;
    memoryDumpStartAddr = 0;
    memoryDumpAnchorAddr = 0;
    hwStatsLastUpdate = null;
    hwStatsFrameCountdown = HW_STATS_FRAME_INTERVAL;
  }, null, context.subscriptions);
}

export function reloadEmulatorBreakpointsFromFile(): number {
  if (!lastBreakpointSource) return 0;
  return loadBreakpointsFromToken(lastBreakpointSource.romPath, lastBreakpointSource.hardware, lastBreakpointSource.log);
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

const clamp16 = (value: number): number => (Number(value) >>> 0) & MEMORY_ADDRESS_MASK;

type StackEntry = { offset: number; addr: number; value: number };

type RamDiskMappingSnapshot = {
  idx: number;
  byte: number;
  enabled: boolean;
  pageRam: number;
  pageStack: number;
  modeStack: boolean;
  modeRamA: boolean;
  modeRam8: boolean;
  modeRamE: boolean;
};

type HardwareStatsMessage = {
  type: 'hardwareStats';
  timestamp: number;
  uptimeMs: number;
  deltaMs: number;
  regs: {
    pc: number;
    sp: number;
    af: number;
    bc: number;
    de: number;
    hl: number;
    m: number | null;
  };
  flags: {
    s: boolean;
    z: boolean;
    ac: boolean;
    p: boolean;
    cy: boolean;
  };
  stack: {
    sp: number;
    entries: StackEntry[];
  };
  hardware: {
    cycles: number;
    frames: number;
    frameCc: number;
    rasterLine: number;
    rasterPixel: number;
    framebufferIdx: number;
    scrollIdx: number;
    displayMode: string;
    rusLat: boolean;
    inte: boolean;
    iff: boolean;
    hlta: boolean;
  };
  peripherals: {
    ramDisk: {
      activeIndex: number;
      activeMapping: RamDiskMappingSnapshot | null;
      mappings: RamDiskMappingSnapshot[];
    };
    fdc: {
      available: boolean;
    };
  };
};

function readStackWord(memory: Memory | undefined | null, addr: number): number | null {
  if (!memory) return null;
  try {
    const base = clamp16(addr);
    const lo = memory.GetByte(base, AddrSpace.STACK) & 0xff;
    const hi = memory.GetByte(clamp16(base + 1), AddrSpace.STACK) & 0xff;
    return ((hi << 8) | lo) & MEMORY_ADDRESS_MASK;
  } catch (e) {
    return null;
  }
}

function collectHardwareStats(hardware: Hardware | undefined | null): HardwareStatsMessage | null {
  if (!hardware || !hardware.cpu) return null;
  const cpuState = hardware.cpu.state ?? new CpuState();
  const now = Date.now();
  const uptimeMs = Math.max(0, now - hwStatsStartTime);
  const deltaMs = hwStatsLastUpdate ? Math.max(0, now - hwStatsLastUpdate) : 0;
  hwStatsLastUpdate = now;

  const stackEntries: StackEntry[] = [];
  if (hardware.memory) {
    for (const offset of STACK_SAMPLE_OFFSETS) {
      const addr = clamp16(cpuState.regs.sp.word + offset);
      const value = readStackWord(hardware.memory, addr);
      if (value === null) continue;
      stackEntries.push({ offset, addr, value });
    }
  }

  const display = hardware.display;
  const rasterLine = display?.rasterLine ?? 0;
  const rasterPixel = display?.rasterPixel ?? 0;
  const frameCc = Math.floor((rasterPixel + rasterLine * FRAME_W) / 4);
  const framebufferIdx = display?.framebufferIdx ?? 0;
  const scrollIdx = display?.scrollIdx ?? 0xff;
  const frames = display?.frameNum ?? 0;

  const displayMode = hardware.io ? (hardware.io.GetDisplayMode() ? '512' : '256') : '256';
  const rusLat = hardware.io?.state?.ruslat ?? false;

  const ramState = hardware.memory?.state;
  const mappings = ramState?.update?.mappings ?? [];
  const ramdiskIdx = ramState?.update?.ramdiskIdx ?? 0;
  const ramDiskMappings = mappings.map((mapping, idx) => {
    const byte = mapping.byte;
    return {
      idx,
      byte,
      enabled: (byte & MAPPING_MODE_MASK) !== 0,
      pageRam: mapping.pageRam,
      pageStack: mapping.pageStack,
      modeStack: mapping.modeStack,
      modeRamA: mapping.modeRamA,
      modeRam8: mapping.modeRam8,
      modeRamE: mapping.modeRamE
    };
  });

  const hlWord = clamp16(cpuState.regs.hl.word);
  const mByte = hardware.memory ? (hardware.memory.GetByte(hlWord, AddrSpace.RAM) & 0xff) : null;

  return {
    type: 'hardwareStats',
    timestamp: now,
    uptimeMs,
    deltaMs,
    regs: {
      pc: clamp16(cpuState.regs.pc.word),
      sp: clamp16(cpuState.regs.sp.word),
      af: clamp16(cpuState.regs.af.word),
      bc: clamp16(cpuState.regs.bc.word),
      de: clamp16(cpuState.regs.de.word),
      hl: hlWord,
      m: mByte
    },
    flags: {
      s: cpuState.regs.af.s,
      z: cpuState.regs.af.z,
      ac: cpuState.regs.af.ac,
      p: cpuState.regs.af.p,
      cy: cpuState.regs.af.c
    },
    stack: {
      sp: clamp16(cpuState.regs.sp.word),
      entries: stackEntries
    },
    hardware: {
      cycles: hardware.cpu.cc ?? 0,
      frames,
      frameCc,
      rasterLine,
      rasterPixel,
      framebufferIdx,
      scrollIdx,
      displayMode,
      rusLat,
      inte: cpuState.ints.inte,
      iff: cpuState.ints.iff,
      hlta: cpuState.ints.hlta
    },
    peripherals: {
      ramDisk: {
        activeIndex: ramdiskIdx,
        activeMapping: ramDiskMappings[ramdiskIdx] ?? null,
        mappings: ramDiskMappings
      },
      fdc: {
        available: false
      }
    }
  };
}

function printDebugState(
  header:string, hardware: Hardware,
  emuOutput: vscode.OutputChannel,
  panel: vscode.WebviewPanel,
  highlightSource: boolean = true)
{
  const line = getDebugLine(hardware);
  try {
    emuOutput.appendLine((header ? header + ' ' : '') + line);
  } catch (e) {}
  if (highlightSource) {
    highlightSourceFromHardware(hardware);
    updateMemoryDumpFromHardware(panel, hardware, 'pc');
  }
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

export function stepFramePanel() {
  if (currentPanelController && currentPanelController.stepFrame) {
    currentPanelController.stepFrame();
  } else {
    vscode.window.showWarningMessage('Emulator panel not open');
  }
}

function getWebviewContent() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body{margin:0;background:#000;color:#fff;font-family:Consolas,monospace;display:flex;flex-direction:column;height:100vh}
    .toolbar{display:flex;gap:8px;padding:8px;background:#111;border-bottom:1px solid #333;flex-wrap:wrap}
    .toolbar button{background:#1e1e1e;border:1px solid #555;color:#fff;padding:3px 5px;border-radius:3px;cursor:pointer;font-size:10px;text-transform:uppercase;letter-spacing:0.05em}
    .toolbar button[data-toggle="run-pause"]{min-width:72px;text-align:center}
    .toolbar button:hover:not(:disabled){background:#2c2c2c}
    .toolbar button:disabled{opacity:0.4;cursor:not-allowed}
    .display-row{display:flex;gap:16px;padding:16px;flex-wrap:wrap;align-items:flex-start;background:#050505}
    .display-row__canvas{flex:0 0 auto;display:flex;justify-content:center;align-items:center}
    .display-row__canvas canvas{display:block;background:#111;border:1px solid #222;max-width:100%;height:auto}
    @media (min-width:900px){
      .display-row__canvas canvas{max-width:512px}
    }
    @media (max-width:768px){
      .display-row{flex-direction:column}
      .display-row__canvas{width:100%}
    }
    .memory-dump{background:#080808;border-top:1px solid #333;padding:8px 12px 16px;font-size:11px;color:#eee}
    .memory-dump__header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
    .memory-dump__title{font-weight:bold;letter-spacing:0.05em;text-transform:uppercase;font-size:11px}
    .memory-dump__header label{display:flex;align-items:center;gap:4px;font-size:11px}
    .memory-dump__header input[type="text"]{background:#111;border:1px solid #444;color:#fff;padding:2px 4px;font-family:Consolas,monospace;font-size:11px;width:72px;text-transform:uppercase}
    .memory-dump__header input[type="checkbox"]{accent-color:#b4ffb0}
    .memory-dump__controls{display:flex;gap:4px;flex-wrap:wrap}
    .memory-dump__controls button{background:#1e1e1e;border:1px solid #555;color:#fff;padding:2px 6px;border-radius:3px;font-size:10px;cursor:pointer}
    .memory-dump__controls button:hover:not(:disabled){background:#333}
    .memory-dump__content{background:#000;border:1px solid #333;font-family:Consolas,monospace;font-size:12px;padding:8px;overflow:auto;max-height:240px;line-height:1.4;white-space:pre-wrap}
    .memory-dump__content .pc-row{background:rgba(180,255,176,0.12)}
    .memory-dump__content .pc-byte{color:#000;background:#b4ffb0;padding:0 1px;border-radius:2px}
    .memory-dump__content .anchor-row{background:rgba(255,209,121,0.12)}
    .memory-dump__content .anchor-byte{color:#000;background:#ffd77a;padding:0 1px;border-radius:2px}
    .memory-dump__content .addr{color:#9ad0ff;margin-right:6px;display:inline-block;width:54px}
    .memory-dump__content .anchor-addr{color:#ffd77a}
    .memory-dump__pc-hint{font-size:11px;color:#b4ffb0;font-family:Consolas,monospace;letter-spacing:0.03em}
    .hw-stats{background:#050505;padding:12px;border-top:1px solid #222;border-bottom:1px solid #222;display:grid;gap:12px;flex:1 1 360px;min-width:300px;max-width:420px}
    .hw-stats__group{background:#0b0b0b;border:1px solid #1f1f1f;padding:10px;border-radius:4px}
    .hw-stats__group-title{font-weight:bold;text-transform:uppercase;font-size:10px;letter-spacing:0.08em;color:#9ad0ff;margin-bottom:6px}
    .hw-regs__grid{display:flex;flex-direction:column;gap:4px;font-size:11px}
    .hw-regs__row{display:grid;grid-template-columns:repeat(4,minmax(0,auto));gap:6px;align-items:center;background:#000;padding:4px;border:1px solid #222;border-radius:3px}
    .hw-regs__label{color:#888;font-size:9px;text-transform:uppercase;letter-spacing:0.04em}
    .hw-regs__value{font-family:Consolas,monospace;color:#fff;font-size:12px}
    .hw-regs__flags{margin-top:6px;display:flex;gap:3px;flex-wrap:wrap;font-size:9px}
    .hw-flag{border:1px solid #333;padding:1px 4px;border-radius:3px;letter-spacing:0.03em;color:#888}
    .hw-flag--on{border-color:#4caf50;color:#4caf50}
    .hw-stack-table{width:100%;border-collapse:collapse;font-size:12px}
    .hw-stack-table th,.hw-stack-table td{border:1px solid #1e1e1e;padding:4px 6px;text-align:left;font-family:Consolas,monospace}
    .hw-stack-table thead th{background:#111;color:#bbb;font-size:10px;text-transform:uppercase;letter-spacing:0.08em}
    .hw-stack-table tbody tr.is-sp{background:rgba(180,255,176,0.08)}
    .hw-stack-table tbody tr:hover{background:rgba(154,208,255,0.08)}
    .hw-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px;font-size:11px}
    .hw-metrics dt{font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.05em}
    .hw-metrics dd{margin:0 0 4px;font-family:Consolas,monospace;color:#fff}
    .hw-peripherals{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
    .hw-peripheral{background:#060606;border:1px solid #1c1c1c;border-radius:3px;padding:8px}
    .hw-peripheral__title{text-transform:uppercase;font-size:10px;color:#ffd77a;margin-bottom:6px;letter-spacing:0.05em}
    .hw-peripheral__placeholder{color:#666;font-size:11px;font-style:italic}
    .hw-chip{border:1px solid #333;padding:2px 6px;border-radius:999px;font-size:10px;text-transform:uppercase;color:#888;display:inline-block;margin:2px 4px 2px 0}
    .hw-chip--on{border-color:#4caf50;color:#4caf50}
    .hw-ramdisk__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px;margin-bottom:6px;font-size:11px}
    .hw-ramdisk__grid span{color:#999;font-size:10px;text-transform:uppercase;letter-spacing:0.05em}
    .hw-ramdisk__grid strong{display:block;font-family:Consolas,monospace;color:#fff}
    .hw-ramdisk__modes{margin-bottom:6px}
    .hw-ramdisk__details{position:relative;margin-top:8px;font-size:11px;color:#bbb}
    .hw-ramdisk__details-note{display:inline-block;padding:4px 6px;border:1px dashed #555;border-radius:3px;background:#111;cursor:help}
    .hw-ramdisk__table-wrapper{display:none;position:absolute;top:110%;left:0;z-index:20;background:#050505;border:1px solid #333;border-radius:4px;padding:8px;box-shadow:0 4px 12px rgba(0,0,0,0.4);min-width:320px;max-height:240px;overflow:auto}
    .hw-ramdisk__details:hover .hw-ramdisk__table-wrapper{display:block}
    .hw-ramdisk__table{width:100%;border-collapse:collapse;font-size:11px}
    .hw-ramdisk__table th,.hw-ramdisk__table td{border:1px solid #1a1a1a;padding:3px 4px;text-align:left;font-family:Consolas,monospace}
    .hw-ramdisk__table th{background:#101010;color:#bbb;font-size:10px;text-transform:uppercase;letter-spacing:0.06em}
    .hw-ramdisk__table tr.is-active{background:rgba(255,215,122,0.08)}
  </style>
</head>
<body>
  <div class="toolbar">
    <button type="button" data-action="pause" data-toggle="run-pause">Pause</button>
    <button type="button" data-action="stepOver">Step Over</button>
    <button type="button" data-action="stepInto">Step Into</button>
    <button type="button" data-action="stepOut">Step Out</button>
    <button type="button" data-action="step256">Step 256</button>
    <button type="button" data-action="stepFrame">Step Frame</button>
    <button type="button" data-action="restart">Restart</button>
  </div>
  <div class="display-row">
    <div class="display-row__canvas">
      <canvas id="screen" width="256" height="256"></canvas>
    </div>
    <div class="hw-stats">
    <div class="hw-stats__group">
      <div class="hw-stats__group-title">Registers</div>
      <div id="hw-regs" class="hw-regs__grid">Waiting for data...</div>
    </div>
    <div class="hw-stats__group">
      <div class="hw-stats__group-title">Stack</div>
      <table class="hw-stack-table">
        <thead>
          <tr><th>Offset</th><th>Addr</th><th>Value</th></tr>
        </thead>
        <tbody id="hw-stack-body"><tr><td colspan="3">Waiting for data...</td></tr></tbody>
      </table>
    </div>
    <div class="hw-stats__group">
      <div class="hw-stats__group-title">Hardware</div>
      <dl id="hw-metrics" class="hw-metrics"></dl>
    </div>
    <div class="hw-stats__group">
      <div class="hw-stats__group-title">Peripherals</div>
      <div class="hw-peripherals">
        <div class="hw-peripheral">
          <div class="hw-peripheral__title">RAM Disk</div>
          <div id="hw-ramdisk">
            <div id="hw-ramdisk-summary" class="hw-ramdisk__grid">
              <div><span>Active</span><strong>—</strong></div>
              <div><span>Status</span><strong>—</strong></div>
              <div><span>RAM Page</span><strong>—</strong></div>
              <div><span>Stack Page</span><strong>—</strong></div>
              <div><span>Mapping Byte</span><strong>—</strong></div>
            </div>
            <div id="hw-ramdisk-modes" class="hw-ramdisk__modes"></div>
              <div class="hw-ramdisk__details">
                <span class="hw-ramdisk__details-note">Hover to view all RAM Disk mappings</span>
                <div class="hw-ramdisk__table-wrapper" role="tooltip" aria-label="RAM Disk mapping details">
                  <table class="hw-ramdisk__table">
                    <thead>
                      <tr><th>Idx</th><th>Enabled</th><th>RAM</th><th>Stack</th><th>Byte</th></tr>
                    </thead>
                    <tbody id="hw-ramdisk-table-body">
                      <tr><td colspan="5">Waiting for data...</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
          </div>
        </div>
        <div class="hw-peripheral">
          <div class="hw-peripheral__title">FDC</div>
          <div class="hw-peripheral__placeholder">Not implemented</div>
        </div>
      </div>
    </div>
    </div>
  </div>
  <div class="memory-dump">
    <div class="memory-dump__header">
      <span class="memory-dump__title">Memory Dump</span>
      <label><input type="checkbox" id="memory-follow" checked /> Follow PC</label>
      <label>Start <input type="text" id="memory-start" value="0000" maxlength="6" spellcheck="false" /></label>
      <span id="memory-pc-hint" class="memory-dump__pc-hint"></span>
      <div class="memory-dump__controls">
        <button type="button" data-mem-delta="-256">-0x100</button>
        <button type="button" data-mem-delta="-16">-0x10</button>
        <button type="button" data-mem-delta="16">+0x10</button>
        <button type="button" data-mem-delta="256">+0x100</button>
        <button type="button" data-mem-action="refresh">Refresh</button>
      </div>
    </div>
    <div class="memory-dump__content" id="memory-dump">Waiting for data...</div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('screen');
    const ctx = canvas.getContext('2d');
    const toolbar = document.querySelector('.toolbar');
    const pauseRunButton = toolbar ? toolbar.querySelector('button[data-action="pause"]') : null;
    const stepButtonActions = ['stepOver','stepInto','stepOut','stepFrame','step256'];
    const memoryDumpContent = document.getElementById('memory-dump');
    const memoryFollowCheckbox = document.getElementById('memory-follow');
    const memoryStartInput = document.getElementById('memory-start');
    const memoryDeltaButtons = document.querySelectorAll('[data-mem-delta]');
    const memoryRefreshButton = document.querySelector('[data-mem-action="refresh"]');
    const memoryPcHint = document.getElementById('memory-pc-hint');
    const hwRegsEl = document.getElementById('hw-regs');
    const hwStackBody = document.getElementById('hw-stack-body');
    const hwMetricsEl = document.getElementById('hw-metrics');
    const hwRamdiskSummary = document.getElementById('hw-ramdisk-summary');
    const hwRamdiskModes = document.getElementById('hw-ramdisk-modes');
    const hwRamdiskTableBody = document.getElementById('hw-ramdisk-table-body');
    const bytesPerRow = 16;
    let memoryDumpState = { startAddr: 0, anchorAddr: 0, bytes: [], pc: 0, followPc: true };

    const setStepButtonsEnabled = (shouldEnable) => {
      if (!toolbar) return;
      stepButtonActions.forEach(action => {
        const btn = toolbar.querySelector('button[data-action="' + action + '"]');
        if (btn instanceof HTMLButtonElement) {
          btn.disabled = !shouldEnable;
        }
      });
    };

    const setRunButtonState = (isRunning) => {
      setStepButtonsEnabled(!isRunning);
      if (!(pauseRunButton instanceof HTMLButtonElement)) return;
      if (isRunning) {
        pauseRunButton.textContent = 'Pause';
        pauseRunButton.setAttribute('data-action', 'pause');
      } else {
        pauseRunButton.textContent = 'Run';
        pauseRunButton.setAttribute('data-action', 'run');
      }
    };

    const clamp16 = (value) => (Number(value) >>> 0) & 0xffff;
    const formatAddress = (value) => clamp16(value).toString(16).toUpperCase().padStart(4, '0');
    const formatAddressWithPrefix = (value) => '0x' + formatAddress(value);
    const formatByte = (value) => ((Number(value) >>> 0) & 0xff).toString(16).toUpperCase().padStart(2, '0');
    const formatSigned = (value) => {
      if (value === 0) return '0';
      return value > 0 ? '+' + value : value.toString();
    };
    const formatNumber = (value) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return '—';
      return num.toLocaleString('en-US');
    };
    const formatDuration = (ms = 0) => {
      if (!Number.isFinite(ms) || ms <= 0) return '0s';
      const totalSeconds = Math.floor(ms / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const millis = Math.floor(ms % 1000);
      const hh = String(hours).padStart(2, '0');
      const mm = String(minutes).padStart(2, '0');
      const ss = String(seconds).padStart(2, '0');
      const mmm = String(millis).padStart(3, '0');
      return hh + ':' + mm + ':' + ss + '.' + mmm;
    };
    const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const wrapByte = (text, addr) => {
      const normalized = clamp16(addr);
      const classes = [];
      if (normalized === clamp16(memoryDumpState.pc)) classes.push('pc-byte');
      const anchorTarget = memoryDumpState.anchorAddr ?? memoryDumpState.startAddr;
      if (normalized === clamp16(anchorTarget)) classes.push('anchor-byte');
      if (!classes.length) return text;
      return '<span class="' + classes.join(' ') + '">' + text + '</span>';
    };
    const postMemoryCommand = (command, extra = {}) => {
      vscode.postMessage({ type: 'memoryDumpControl', command, ...extra });
    };
    const syncMemoryControls = () => {
      if (memoryFollowCheckbox instanceof HTMLInputElement) {
        memoryFollowCheckbox.checked = memoryDumpState.followPc;
      }
      if (memoryStartInput instanceof HTMLInputElement) {
        const isEditing = document.activeElement === memoryStartInput && !memoryDumpState.followPc;
        if (!isEditing || memoryStartInput.value === '') {
          const baseValue = memoryDumpState.anchorAddr ?? memoryDumpState.startAddr;
          memoryStartInput.value = formatAddressWithPrefix(baseValue);
        }
        memoryStartInput.disabled = memoryDumpState.followPc;
        if (memoryDumpState.followPc && document.activeElement === memoryStartInput) {
          memoryStartInput.blur();
        }
      }
      if (memoryPcHint instanceof HTMLElement) {
        memoryPcHint.textContent = memoryDumpState.followPc ? '' : 'PC: ' + formatAddressWithPrefix(memoryDumpState.pc);
      }
    };
    const renderMemoryDump = () => {
      if (!(memoryDumpContent instanceof HTMLElement)) return;
      if (!Array.isArray(memoryDumpState.bytes) || memoryDumpState.bytes.length === 0) {
        memoryDumpContent.textContent = memoryDumpState.followPc ? 'Waiting for data...' : 'No data';
        return;
      }
      const rows = [];
      const normalizedStart = clamp16(memoryDumpState.startAddr);
      const anchorTarget = clamp16(memoryDumpState.anchorAddr ?? memoryDumpState.startAddr);
      const normalizedPc = clamp16(memoryDumpState.pc);
      for (let offset = 0; offset < memoryDumpState.bytes.length; offset += bytesPerRow) {
        const rowStart = clamp16(memoryDumpState.startAddr + offset);
        const rowBytes = memoryDumpState.bytes.slice(offset, offset + bytesPerRow);
        const lineHasPc = normalizedPc >= rowStart && normalizedPc < rowStart + rowBytes.length;
        const lineHasAnchor = anchorTarget >= rowStart && anchorTarget < rowStart + rowBytes.length;
        const hexParts = rowBytes.map((value, idx) => {
          const addr = clamp16(rowStart + idx);
          return wrapByte(formatByte(value ?? 0), addr);
        });
        const asciiParts = rowBytes.map((value, idx) => {
          const addr = clamp16(rowStart + idx);
          const char = value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : '.';
          return wrapByte(escapeHtml(char), addr);
        });
        const rowClasses = ['dump-row'];
        if (lineHasPc) rowClasses.push('pc-row');
        if (lineHasAnchor) rowClasses.push('anchor-row');
        const addrClasses = ['addr'];
        if (lineHasAnchor) addrClasses.push('anchor-addr');
        rows.push('<div class="' + rowClasses.join(' ') + '"><span class="' + addrClasses.join(' ') + '">' + formatAddress(rowStart) + ':</span> ' + hexParts.join(' ') + '  ' + asciiParts.join('') + '</div>');
      }
      memoryDumpContent.innerHTML = rows.join('');
    };
    const renderRegs = (stats) => {
      if (!(hwRegsEl instanceof HTMLElement)) return;
      if (!stats || !stats.regs) {
        hwRegsEl.textContent = 'Waiting for data...';
        return;
      }
      const regs = stats.regs;
      const items = [
        ['PC', formatAddressWithPrefix(regs.pc)],
        ['SP', formatAddressWithPrefix(regs.sp)],
        ['AF', formatAddressWithPrefix(regs.af)],
        ['BC', formatAddressWithPrefix(regs.bc)],
        ['DE', formatAddressWithPrefix(regs.de)],
        ['HL', formatAddressWithPrefix(regs.hl)],
        ['M', regs.m === null || regs.m === undefined ? '—' : '0x' + formatByte(regs.m)]
      ];
      const rows = [];
      for (let i = 0; i < items.length; i += 2) {
        const pair = items.slice(i, i + 2);
        if (pair.length < 2) {
          pair.push(['', '']);
        }
        const cells = pair.map(([label, value]) => '<span class="hw-regs__label">' + (label ?? '') + '</span><strong class="hw-regs__value">' + (value ?? '') + '</strong>');
        rows.push('<div class="hw-regs__row">' + cells.join('') + '</div>');
      }
      hwRegsEl.innerHTML = rows.join('');
      const flags = stats.flags || {};
      const flagOrder = [
        { key: 's', label: 'S' },
        { key: 'z', label: 'Z' },
        { key: 'ac', label: 'AC' },
        { key: 'p', label: 'P' },
        { key: 'cy', label: 'CY' }
      ];
      const flagHtml = flagOrder.map(flag => '<span class="hw-flag ' + (flags[flag.key] ? 'hw-flag--on' : '') + '">' + flag.label + '</span>').join('');
      hwRegsEl.insertAdjacentHTML('beforeend', '<div class="hw-regs__flags" title="Flags">' + flagHtml + '</div>');
    };
    const renderStack = (stats) => {
      if (!(hwStackBody instanceof HTMLElement)) return;
      const stack = stats?.stack;
      const entries = Array.isArray(stack?.entries) ? stack.entries : [];
      if (!entries.length) {
        hwStackBody.innerHTML = '<tr><td colspan="3">No stack data</td></tr>';
        return;
      }
      hwStackBody.innerHTML = entries.map(entry => {
        const offset = formatSigned(entry.offset ?? 0);
        const addr = formatAddressWithPrefix(entry.addr ?? 0);
        const value = formatAddressWithPrefix(entry.value ?? 0);
        const rowClass = entry.offset === 0 ? ' class="is-sp"' : '';
        return '<tr' + rowClass + '><td>' + offset + '</td><td>' + addr + '</td><td>' + value + '</td></tr>';
      }).join('');
    };
    const renderHardwareMetrics = (stats) => {
      if (!(hwMetricsEl instanceof HTMLElement)) return;
      const hw = stats?.hardware;
      if (!hw) {
        hwMetricsEl.textContent = 'Waiting for data...';
        return;
      }
      const metrics = [
        ['Up Time', formatDuration(stats?.uptimeMs ?? 0)],
        ['Δ Update', (stats?.deltaMs ?? 0) > 0 ? Math.round(stats.deltaMs) + ' ms' : '—'],
        ['CPU Cycles', formatNumber(hw.cycles)],
        ['Frames', formatNumber(hw.frames)],
        ['Frame CC', formatNumber(hw.frameCc)],
        ['Raster', hw.rasterLine + ':' + hw.rasterPixel],
        ['Scroll', '0x' + formatByte(hw.scrollIdx ?? 0)],
        ['Display', hw.displayMode + ' px'],
        ['Rus/Lat', hw.rusLat ? 'LAT' : 'RUS'],
        ['INT', hw.inte ? 'Enabled' : 'Disabled'],
        ['IFF', hw.iff ? 'Pending' : 'Idle'],
        ['HLT', hw.hlta ? 'HLT' : 'RUN']
      ];
      hwMetricsEl.innerHTML = metrics.map(([label, value]) => '<dt>' + label + '</dt><dd>' + value + '</dd>').join('');
    };
    const renderRamDisk = (stats) => {
      if (!(hwRamdiskSummary instanceof HTMLElement)) return;
      const ramDisk = stats?.peripherals?.ramDisk;
      if (!ramDisk) {
        hwRamdiskSummary.innerHTML = '<div><span>Active</span><strong>—</strong></div>';
        if (hwRamdiskModes instanceof HTMLElement) {
          hwRamdiskModes.innerHTML = '';
        }
        if (hwRamdiskTableBody instanceof HTMLElement) {
          hwRamdiskTableBody.innerHTML = '<tr><td colspan="5">No RAM Disk info</td></tr>';
        }
        return;
      }
      const active = ramDisk.activeMapping;
      const summaryItems = [
        { label: 'Active', value: ramDisk.activeIndex !== undefined ? '#' + ramDisk.activeIndex : '—' },
        { label: 'Status', value: active ? (active.enabled ? 'Enabled' : 'Disabled') : '—' },
        { label: 'RAM Page', value: active && active.pageRam !== undefined ? active.pageRam.toString() : '—' },
        { label: 'Stack Page', value: active && active.pageStack !== undefined ? active.pageStack.toString() : '—' },
        { label: 'Mapping Byte', value: active ? '0x' + formatByte(active.byte) : '—' }
      ];
      hwRamdiskSummary.innerHTML = summaryItems.map(item => '<div><span>' + item.label + '</span><strong>' + item.value + '</strong></div>').join('');
      if (hwRamdiskModes instanceof HTMLElement) {
        if (active) {
          const chips = [
            { label: 'Stack', enabled: active.modeStack },
            { label: '0x8000', enabled: active.modeRam8 },
            { label: '0xA000', enabled: active.modeRamA },
            { label: '0xE000', enabled: active.modeRamE }
          ];
          hwRamdiskModes.innerHTML = chips.map(chip => '<span class="hw-chip ' + (chip.enabled ? 'hw-chip--on' : '') + '">' + chip.label + '</span>').join('');
        } else {
          hwRamdiskModes.innerHTML = '<span class="hw-chip">No mapping</span>';
        }
      }
      if (hwRamdiskTableBody instanceof HTMLElement) {
        const mappings = Array.isArray(ramDisk.mappings) ? ramDisk.mappings : [];
        if (!mappings.length) {
          hwRamdiskTableBody.innerHTML = '<tr><td colspan="5">No mappings</td></tr>';
        } else {
          hwRamdiskTableBody.innerHTML = mappings.map(mapping => {
            const rowClass = mapping.idx === ramDisk.activeIndex ? ' class="is-active"' : '';
            const enabled = mapping.enabled ? 'ON' : 'OFF';
            return '<tr' + rowClass + '><td>' + mapping.idx + '</td><td>' + enabled + '</td><td>' + mapping.pageRam + '</td><td>' + mapping.pageStack + '</td><td>0x' + formatByte(mapping.byte) + '</td></tr>';
          }).join('');
        }
      }
    };
    const renderHardwareStats = (stats) => {
      if (!stats) return;
      renderRegs(stats);
      renderStack(stats);
      renderHardwareMetrics(stats);
      renderRamDisk(stats);
    };
    const updateMemoryDumpState = (payload) => {
      if (!payload || typeof payload !== 'object') return;
      memoryDumpState = {
        startAddr: clamp16(payload.startAddr ?? 0),
        anchorAddr: clamp16(payload.anchorAddr ?? (payload.startAddr ?? 0)),
        bytes: Array.isArray(payload.bytes)
          ? payload.bytes.map(value => {
              const normalized = Number(value);
              return Number.isFinite(normalized) ? (normalized & 0xff) : 0;
            })
          : [],
        pc: clamp16(payload.pc ?? 0),
        followPc: !!payload.followPc
      };
      syncMemoryControls();
      renderMemoryDump();
    };
    const submitMemoryStart = () => {
      if (!(memoryStartInput instanceof HTMLInputElement)) return;
      const raw = memoryStartInput.value.trim();
      if (!raw) return;
      postMemoryCommand('setBase', { addr: raw });
    };

    syncMemoryControls();
    renderMemoryDump();
    setStepButtonsEnabled(false);

    if (memoryStartInput instanceof HTMLInputElement) {
      memoryStartInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          submitMemoryStart();
        }
      });
      memoryStartInput.addEventListener('blur', () => {
        if (!memoryDumpState.followPc) {
          submitMemoryStart();
        }
      });
    }

    if (memoryFollowCheckbox instanceof HTMLInputElement) {
      memoryFollowCheckbox.addEventListener('change', () => {
        postMemoryCommand('follow', { value: memoryFollowCheckbox.checked });
        if (!memoryFollowCheckbox.checked && memoryPcHint instanceof HTMLElement) {
          memoryPcHint.textContent = 'PC: ' + formatAddressWithPrefix(memoryDumpState.pc);
        }
      });
    }

    Array.from(memoryDeltaButtons).forEach(btn => {
      if (!(btn instanceof HTMLButtonElement)) return;
      btn.addEventListener('click', () => {
        const delta = Number(btn.getAttribute('data-mem-delta'));
        if (Number.isFinite(delta) && delta !== 0) {
          postMemoryCommand('delta', { offset: delta });
        }
      });
    });

    if (memoryRefreshButton instanceof HTMLButtonElement) {
      memoryRefreshButton.addEventListener('click', () => postMemoryCommand('refresh'));
    }

    const shouldForwardKey = (event) => {
      const target = event.target;
      if (!target) return true;
      if (target instanceof HTMLInputElement) return false;
      if (target instanceof HTMLTextAreaElement) return false;
      if (target instanceof HTMLElement && target.isContentEditable) return false;
      return true;
    };

    if (toolbar) {
      toolbar.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const btn = target.closest('button');
        if (!(btn instanceof HTMLButtonElement)) return;
        const action = btn.getAttribute('data-action');
        if (!action || btn.disabled) return;
        vscode.postMessage({ type: 'debugAction', action });
      });
    }

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
      } else if (msg.type === 'toolbarState') {
        setRunButtonState(!!msg.isRunning);
      } else if (msg.type === 'memoryDump') {
        updateMemoryDumpState(msg);
      } else if (msg.type === 'hardwareStats') {
        renderHardwareStats(msg);
      } else if (msg.type === 'romLoaded') {
        try {
          console.log('ROM loaded: ' + (msg.path || '<unknown>') + ' size=' + (msg.size || 0) + ' addr=0x' + (msg.addr !== undefined ? msg.addr.toString(16).padStart(4,'0') : '0100'));
        } catch (e) { }
      }
    });
    // keyboard forwarding
    window.addEventListener('keydown', e => {
      if (!shouldForwardKey(e)) return;
      vscode.postMessage({ type: 'key', kind: 'down', key: e.key, code: e.code });
      e.preventDefault();
    });
    window.addEventListener('keyup', e => {
      if (!shouldForwardKey(e)) return;
      vscode.postMessage({ type: 'key', kind: 'up', key: e.key, code: e.code });
      e.preventDefault();
    });

    postMemoryCommand('refresh');
  </script>
</body>
</html>`;
}

function loadBreakpointsFromToken(romPath: string, hardware: Hardware | undefined | null, log?: vscode.OutputChannel): number {
  lastAddressSourceMap = null;
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

  lastAddressSourceMap = buildAddressToSourceMap(tokens, tokenPath);

  const desired = collectBreakpointAddresses(tokens);

  hardware.Request(HardwareReq.DEBUG_BREAKPOINT_DEL_ALL);

  if (desired.size === 0) {
    try {
      log?.appendLine(`Deleted all breakpoints from ${path.basename(tokenPath)}`);
    } catch (e) {}
    return 0;
  }

  for (const [addr, meta] of desired) {
    try { hardware.Request(HardwareReq.DEBUG_BREAKPOINT_ADD, { addr }); } catch (e) {}
    if (meta.enabled === false) {
      try { hardware.Request(HardwareReq.DEBUG_BREAKPOINT_DISABLE, { addr }); } catch (e) {}
    }
  }

  try {
    log?.appendLine(`Loaded ${desired.size} breakpoint${desired.size === 1 ? '' : 's'} from ${path.basename(tokenPath)}`);
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
    if (/^[0-9a-fA-F]+$/.test(trimmed)) {
      // Treat bare alphanumeric strings containing hex digits as hex (useful for UI inputs like "AB00")
      if (/[a-fA-F]/.test(trimmed)) return parseInt(trimmed, 16) & 0xffff;
      return parseInt(trimmed, 10) & 0xffff;
    }
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

function ensureHighlightDecoration(context: vscode.ExtensionContext) {
  if (pausedLineDecoration) return;
  pausedLineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(129, 127, 38, 0.45)',
    overviewRulerColor: 'rgba(200, 200, 175, 0.8)',
    overviewRulerLane: vscode.OverviewRulerLane.Full
  });
  context.subscriptions.push(pausedLineDecoration);
}

function clearHighlightedSourceLine() {
  if (pausedLineDecoration && lastHighlightedEditor) {
    try {
      lastHighlightedEditor.setDecorations(pausedLineDecoration, []);
    } catch (e) { /* ignore decoration clearing errors */ }
  }
  lastHighlightedEditor = null;
}

function highlightSourceFromHardware(hardware: Hardware | undefined | null) {
  if (!hardware || !highlightContext) return;
  try {
    const state = getDebugState(hardware);
    const debugLine = getDebugLine(hardware);
    highlightSourceAddress(state.global_addr, debugLine);
  } catch (e) {
    /* ignore highlight errors */
  }
}

function highlightSourceAddress(addr?: number, debugLine?: string) {
  if (!highlightContext || addr === undefined || addr === null) return;
  ensureHighlightDecoration(highlightContext);
  if (!pausedLineDecoration || !lastAddressSourceMap || lastAddressSourceMap.size === 0) return;
  const info = lastAddressSourceMap.get(addr & 0xffff);
  if (!info) return;
  const targetPath = path.resolve(info.file);
  const run = async () => {
    try {
      const uri = vscode.Uri.file(targetPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      let editor = vscode.window.visibleTextEditors.find((ed) => ed.document.uri.fsPath === uri.fsPath);
      if (!editor) {
        const existing = vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({ tab, viewColumn: group.viewColumn })))
          .find(entry => entry.tab.input && (entry.tab.input as any).uri && (entry.tab.input as any).uri.fsPath === uri.fsPath);
        if (existing && existing.viewColumn !== undefined) {
          editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: existing.viewColumn, preserveFocus: false });
        }
      }
      if (!editor) {
        editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
      }
      const totalLines = doc.lineCount;
      if (totalLines === 0) return;
      const idx = Math.min(Math.max(info.line - 1, 0), totalLines - 1);
      const lineText = doc.lineAt(idx).text;
      const range = new vscode.Range(idx, 0, idx, Math.max(lineText.length, 1));
      const decoration: vscode.DecorationOptions = {
        range,
        renderOptions: debugLine ? {
          after: {
            contentText: '  ' + debugLine,
            color: '#b4ffb0',
            fontStyle: 'normal',
            fontWeight: 'normal'
          }
        } : undefined
      };
      clearHighlightedSourceLine();
      editor.setDecorations(pausedLineDecoration!, [decoration]);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      lastHighlightedEditor = editor;
    } catch (err) {
      /* ignore highlight errors */
    }
  };
  void run();
}

function normalizeMemoryAddress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const truncated = Math.trunc(value);
  return ((truncated % 0x10000) + 0x10000) & MEMORY_ADDRESS_MASK;
}

function alignMemoryDumpBase(value: number): number {
  const normalized = normalizeMemoryAddress(value);
  return normalized & ~(MEMORY_DUMP_LINE_BYTES - 1);
}

function readMemoryChunk(memory: Memory, baseAddr: number): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < MEMORY_DUMP_TOTAL_BYTES; i++) {
    const addr = (baseAddr + i) & MEMORY_ADDRESS_MASK;
    try {
      bytes.push(memory.GetByteGlobal(addr) & 0xff);
    } catch (e) {
      bytes.push(0);
    }
  }
  return bytes;
}

function updateMemoryDumpFromHardware(
  panel: vscode.WebviewPanel | null,
  hardware: Hardware | undefined | null,
  reason: 'pc' | 'user' = 'pc',
  explicitBase?: number
) {
  if (!panel || !hardware || !hardware.memory) return;
  let nextBase = memoryDumpStartAddr;
  let anchor = memoryDumpAnchorAddr;
  if (reason === 'pc' && memoryDumpFollowPc) {
    const pc = hardware.cpu?.state?.regs.pc.word;
    if (pc !== undefined) {
      anchor = pc;
      nextBase = pc;
    }
  } else if (explicitBase !== undefined) {
    anchor = explicitBase;
    nextBase = explicitBase;
  }
  memoryDumpAnchorAddr = normalizeMemoryAddress(anchor);
  memoryDumpStartAddr = alignMemoryDumpBase(nextBase);
  const bytes = readMemoryChunk(hardware.memory, memoryDumpStartAddr);
  const pc = hardware.cpu?.state?.regs.pc.word ?? 0;
  try {
    panel.webview.postMessage({
      type: 'memoryDump',
      startAddr: memoryDumpStartAddr,
      bytes,
      pc,
      followPc: memoryDumpFollowPc,
      anchorAddr: memoryDumpAnchorAddr
    });
  } catch (e) {
    /* ignore memory dump sync errors */
  }
}

function handleMemoryDumpControlMessage(
  msg: any,
  panel: vscode.WebviewPanel | null,
  hardware: Hardware | undefined | null
) {
  if (!panel || !hardware || !msg || typeof msg !== 'object') return;
  const command = typeof msg.command === 'string' ? msg.command : '';
  switch (command) {
    case 'setBase': {
      const parsed = parseAddressLike(msg.addr);
      if (parsed === undefined) break;
      memoryDumpFollowPc = false;
      updateMemoryDumpFromHardware(panel, hardware, 'user', parsed);
      break;
    }
    case 'delta': {
      const delta = typeof msg.offset === 'number'
        ? msg.offset
        : typeof msg.offset === 'string'
          ? Number.parseInt(msg.offset, 10)
          : NaN;
      if (!Number.isFinite(delta) || delta === 0) break;
      memoryDumpFollowPc = false;
      const target = (memoryDumpStartAddr + delta) & MEMORY_ADDRESS_MASK;
      updateMemoryDumpFromHardware(panel, hardware, 'user', target);
      break;
    }
    case 'follow': {
      memoryDumpFollowPc = !!msg.value;
      updateMemoryDumpFromHardware(panel, hardware, memoryDumpFollowPc ? 'pc' : 'user');
      break;
    }
    case 'refresh': {
      updateMemoryDumpFromHardware(panel, hardware, memoryDumpFollowPc ? 'pc' : 'user');
      break;
    }
    default:
      break;
  }
}

function buildAddressToSourceMap(tokens: any, tokenPath: string): Map<number, SourceLineRef> | null {
  if (!tokens || typeof tokens !== 'object') return null;
  const map = new Map<number, SourceLineRef>();
  const linesByFile = tokens.lineAddresses;
  if (!linesByFile || typeof linesByFile !== 'object') return map;
  const normalizedEntries = new Map<string, Record<string, any>>();
  for (const [rawKey, perLine] of Object.entries(linesByFile as Record<string, Record<string, any>>)) {
    if (!perLine || typeof perLine !== 'object') continue;
    // Only keep keys that look like actual filenames (contain a dot)
    if (typeof rawKey !== 'string' || !rawKey.includes('.')) continue;
    normalizedEntries.set(rawKey, perLine);
  }
  if (!normalizedEntries.size) return map;
  const baseDir = tokenPath ? path.dirname(tokenPath) : '';
  for (const [fileKey, perLine] of normalizedEntries.entries()) {
    if (!perLine || typeof perLine !== 'object') continue;
    const resolvedPath = path.isAbsolute(fileKey) ? path.normalize(fileKey) : path.resolve(baseDir, fileKey);
    for (const [lineKey, addrRaw] of Object.entries(perLine)) {
      const addr = parseAddressLike(addrRaw);
      if (addr === undefined) continue;
      const lineNum = Number(lineKey);
      if (!Number.isFinite(lineNum)) continue;
      const normalizedAddr = addr & 0xffff;
      if (!map.has(normalizedAddr)) {
        map.set(normalizedAddr, { file: resolvedPath, line: lineNum });
      }
    }
  }
  return map;
}
