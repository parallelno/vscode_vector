import * as vscode from 'vscode';
import { Emulator } from './emulator';
import * as path from 'path';
import * as fs from 'fs';
import { Hardware } from './emulator/hardware';
import { HardwareReq } from './emulator/hardware_reqs';
import { BpStatus } from './emulator/breakpoint';
import { ACTIVE_AREA_H, ACTIVE_AREA_W, BORDER_LEFT, FRAME_H, FRAME_W, SCAN_ACTIVE_AREA_TOP } from './emulator/display';
import { getWebviewContent } from './emulatorUI/webviewContent';
import { getDebugLine } from './emulatorUI/debugOutput';
import { handleMemoryDumpControlMessage, resetMemoryDumpState, updateMemoryDumpFromHardware } from './emulatorUI/memoryDump';
import { disposeHardwareStatsTracking, resetHardwareStatsTracking, tryCollectHardwareStats } from './emulatorUI/hardwareStats';
import { parseAddressLike } from './emulatorUI/utils';
import { MemoryAccessLog } from './emulator/debugger';
import { ProjectInfo } from './extention/project_info';
import { DEBUG_FILE_SUFFIX } from './extention/consts';
import * as ext_consts from './extention/consts';
import * as consts from './emulatorUI/consts';
import {
  SourceLineRef,
  loadBreakpointsFromToken,
  syncEditorBreakpointsFromHardware,
  normalizeFileKey,
  formatFileLineKey,
  coerceAddressList,
} from './emulatorUI/breakpoints';

// set to true to enable instruction logging to file
const log_tick_to_file = false;

let lastBreakpointSource: {
  absoluteRomPath: string;
  absoluteDebugPath?: string;
  hardware?: Hardware | null;
  log?: vscode.OutputChannel } | null = null;

let lastAddressSourceMap: Map<number, SourceLineRef> | null = null;
type SymbolSource = { fileKey: string; line: number };
type SymbolMeta = { value: number; kind: 'label' | 'const'; source?: SymbolSource };
type SymbolCache = {
  byName: Map<string, SymbolMeta>;
  byLowerCase: Map<string, SymbolMeta>;
  lineAddresses: Map<string, Map<number, number[]>>;
  filePaths: Map<string, string>;
};

type DataLineSpan = { start: number; byteLength: number; unitBytes: number };
type DataLineCache = Map<string, Map<number, DataLineSpan>>;
type DataAddressEntry = { fileKey: string; line: number; span: DataLineSpan };

let lastSymbolCache: SymbolCache | null = null;
let dataLineSpanCache: DataLineCache | null = null;
let dataAddressLookup: Map<number, DataAddressEntry> | null = null;
let highlightContext: vscode.ExtensionContext | null = null;
let pausedLineDecoration: vscode.TextEditorDecorationType | null = null;
let unmappedAddressDecoration: vscode.TextEditorDecorationType | null = null;
let lastHighlightedEditor: vscode.TextEditor | null = null;
let lastHighlightedLine: number | null = null;
let lastHighlightedFilePath: string | null = null;
let lastHighlightDecoration: vscode.DecorationOptions | null = null;
let lastHighlightIsUnmapped: boolean = false;
let currentToolbarIsRunning = true;
let dataReadDecoration: vscode.TextEditorDecorationType | null = null;
let dataWriteDecoration: vscode.TextEditorDecorationType | null = null;
let lastDataAccessLog: MemoryAccessLog | null = null;

export type DebugAction = 'pause' | 'run' | 'stepOver' | 'stepInto' | 'stepOut' | 'stepFrame' | 'step256' | 'restart';
type ToolbarListener = (isRunning: boolean) => void;
type PanelClosedListener = () => void;

const toolbarListeners = new Set<ToolbarListener>();
const panelClosedListeners = new Set<PanelClosedListener>();

let currentPanelController: {
  pause: () => void;
  resume: () => void;
  stepFrame: () => void;
  performDebugAction: (action: DebugAction) => void;
  stopAndClose: () => void;
} | null = null;

// View modes for display rendering
type ViewMode = 'full' | 'noBorder';
let currentViewMode: ViewMode = 'noBorder';

export async function openEmulatorPanel(
  context: vscode.ExtensionContext,
  logChannel?: vscode.OutputChannel,
  project?: ProjectInfo)
{
  if (!project) {
    // No project provided, open a file picker for ROM/FDD files
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'ROM Files': ['rom', 'fdd'], 'All Files': ['*'] },
      openLabel: 'Open ROM in Devector Emulator'
    });
    if (!uris || uris.length === 0) {
      return;
    }
    const romUri = uris[0];

    project = new ProjectInfo({
      name: path.basename(romUri.fsPath, path.extname(romUri.fsPath)),
      romPath: romUri.fsPath
    });
  }


  if (!fs.existsSync(project.absolute_rom_path!)) {
    vscode.window.showErrorMessage(`File not found: ${project.absolute_rom_path!}`);
    return;
  }

  const panel = vscode.window.createWebviewPanel('Devector', 'Vector-06C Emulator', vscode.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'images'))]
  });
  let panelDisposed = false;

  const html = getWebviewContent();
  panel.webview.html = html;
  highlightContext = context;
  ensureHighlightDecoration(context);
  currentToolbarIsRunning = true;
  resetHardwareStatsTracking();
  resetMemoryDumpState();


  // Create an output channel for per-instruction logs and attach a hook
  const ownsOutputChannel = !logChannel;
  const devectorOutput = logChannel ?? vscode.window.createOutputChannel('Devector');
  if (ownsOutputChannel) {
    context.subscriptions.push(devectorOutput);
  }
  // Bring the output channel forward so users see logs by default
  try {
    devectorOutput.show(true);
    devectorOutput.appendLine('Devector logging enabled');
  } catch (e) {}

  const emu = new Emulator(context.extensionPath, project);
  const emuResult = emu.result;
  if (!emuResult.success){
    devectorOutput.appendLine('Devector Errors: ' + emuResult.errors?.join("\n") || "Unknown error");
    return;
  }
  if (emuResult.warnings?.length) {
    devectorOutput.appendLine('Devector Warnings: ' + emuResult.warnings.join("\n"));
  }

  if (emuResult.printMessages?.length) {
    devectorOutput.appendLine('Devector: ' + emuResult.printMessages.join("\n"));
  }


  let debugStream: fs.WriteStream | null = null;

  // prepare instruction debug log next to the ROM file (now that emuOutput exists)
  try {
    if (log_tick_to_file) {
      const parsed = path.parse(project.absolute_rom_path!);
      const logName = parsed.name + ext_consts.DEBUG_LOG_SUFFIX;
      const logPath = path.join(parsed.dir, logName);

      debugStream = fs.createWriteStream(logPath, { flags: 'w' });
      debugStream.on('error', (err) => {
        try { devectorOutput.appendLine(`Debug log error: ${err}`); } catch (e) {}
      });
      debugStream.on('open', () => {
        try { devectorOutput.appendLine(`Debug log file created: ${logPath}`); } catch (e) {}
      });
    }
  } catch (e) { debugStream = null; }

  // Announce ROM load (path, size, load addr)
  try {
    const size = fs.statSync(project.absolute_rom_path!).size;
    devectorOutput.appendLine(`File loaded: ${project.absolute_rom_path!} size=${size} bytes`);
    try { panel.webview.postMessage({ type: 'romLoaded', path: project.absolute_rom_path!, size, addr: 0x0100 }); } catch (e) {}
  } catch (e) {}


  try {
    panel.webview.postMessage({ type: 'setSpeed', speed: project.settings.speed });
  } catch (e) {}
  try {
    panel.webview.postMessage({ type: 'setViewMode', viewMode: project.settings.viewMode });
  } catch (e) {}
  try {
    panel.webview.postMessage({ type: 'setRamDiskSaveOnRestart', value: project.settings.saveRamDiskOnRestart });
  } catch (e) {}



  // dispose the Output channel when the panel is closed
  panel.onDidDispose(
    async () => {
      panelDisposed = true;
      try { emu.hardware?.Request(HardwareReq.STOP); } catch (e) {}
      if (emu.hardware) {
        // Save the RAM Disk
        if (project && project.settings && project.settings.saveRamDiskOnRestart)
        {
          // Ensure the RAM Disk path is initialized
          if (!project.absolute_ram_disk_path) project.init_ram_disk_path();
          if (!fs.existsSync(project.absolute_ram_disk_path!))
          {
            const action = await vscode.window.showWarningMessage(
              `RAM Disk file not found. Create a new RAM Disk file for project '${project.name}'?`,
              'Create',
              'Cancel'
            );
            if (action === 'Create')
            {
              const saveUri = await vscode.window.showSaveDialog({
                filters: { 'RAM Disk Image': ['bin', 'dat'] },
                title: 'Select RAM Disk File',
                defaultUri: vscode.Uri.file(project.absolute_ram_disk_path!)
              });
              if (saveUri) {
                  project!.settings.ramDiskPath = path.relative(project!.projectDir!, saveUri.fsPath);
                  project!.save();
              }
            }
          }
          // Save the RAM Disk to file
          emu.SaveRamDisk();
        }
        try { emu.Destructor(); } catch (e) {}
      }

      try {
        if (debugStream) {
          debugStream.end();
          debugStream = null;
        } }
      catch (ee) {}

      try {
        if (ownsOutputChannel) {
          devectorOutput.dispose();
        }
      }
      catch (e) {}

      project!.save();


      currentPanelController = null;
      lastBreakpointSource = null;
      clearHighlightedSourceLine();
      lastAddressSourceMap = null;
      clearDataLineHighlights();
      lastDataAccessLog = null;
      clearSymbolMetadataCache();
      highlightContext = null;
      resetMemoryDumpState();
      disposeHardwareStatsTracking();

      try { emitToolbarState(false); } catch (e) {}
      for (const listener of panelClosedListeners) {
        try { listener(); } catch (err) { console.error('Emulator panel close listener failed', err); }
      }

    }, null, context.subscriptions
  );

  // attach debugger and sync breakpoints from the compiled token file, if available
  emu.hardware?.Request(HardwareReq.DEBUG_ATTACH, { data: true });
  emu.hardware?.Request(HardwareReq.RUN);

  // TODO: check if appliedBreakpoints was useful
  const { applied: appliedBreakpoints, addressSourceMap } = loadBreakpointsFromToken(
    project.absolute_rom_path!,
    emu.hardware,
    {
      log: devectorOutput,
      debugPath: project.absolute_debug_path!,
      cacheSymbolMetadata,
      clearSymbolMetadataCache,
    });
  lastAddressSourceMap = addressSourceMap;

  lastBreakpointSource = {
    absoluteRomPath: project.absolute_rom_path!,

    absoluteDebugPath: project.absolute_debug_path!,
    hardware: emu.hardware,
    log: devectorOutput };

  // TODO: implement if still needed. it was for printing per instruction log
  // attach per-instruction callback to hardware (if available)
  // try {
  //   if (log_tick_to_file && emu.hardware) {
  //     emu.hardware.debugInstructionCallback = (hw) => {
  //       try {
  //         const line = getDebugLine(hw)
  //         if (debugStream && line) {
  //           debugStream.write(line + '\n', (err) => {
  //             if (err) {
  //                try { devectorOutput.appendLine(`Log write error: ${err}`); } catch (e) {}
  //             }
  //           });
  //         }
  //       } catch (e) { }
  //     };
  //   }
  // } catch (e) { }

  const sendHardwareStats = (force: boolean = false) => {
    const snapshot = tryCollectHardwareStats(emu.hardware, force);

    if (!snapshot) return;
    try {
      panel.webview.postMessage(snapshot);
    } catch (e) {
      /* ignore stats sync errors */
    }
  };


  /**
   * Send the current display frame to the webview.
   * @param forceStats If true, bypasses the throttling mechanism to force an immediate
   *                   hardware stats update. Use this after debug actions (pause, step, break)
   *                   to ensure the Register panel is synchronized with the highlighted source line.
   */
  const sendFrameToWebview = (forceStats: boolean = false) => {
    if (emu.hardware){
      try {
        // TODO: implement vsync handling if needed
        const sync = false;
        const fullFrame = emu.hardware.Request(HardwareReq.GET_FRAME, {"vsync": sync})["data"];

        let crop: {x: number, y: number, w: number, h: number} = { x: 0, y: 0, w: FRAME_W, h: FRAME_H };
        let aspect = FRAME_W / FRAME_H;
        if (currentViewMode === 'noBorder') {
          crop = { x: BORDER_LEFT, y: SCAN_ACTIVE_AREA_TOP, w: ACTIVE_AREA_W, h: ACTIVE_AREA_H };
          aspect = 4/3;
        }
        panel.webview.postMessage(
          { type: 'frame',
            width: FRAME_W, height: FRAME_H,
            crop: crop,
            aspect: aspect,
            data: fullFrame.buffer });
      }
      catch (e) { /* ignore frame conversion errors */ }
    }
    sendHardwareStats(forceStats);
  };

  const postToolbarState = (isRunning: boolean) => {
    try {
      panel.webview.postMessage({ type: 'toolbarState', isRunning });
    } catch (e) { /* ignore toolbar sync errors */ }
  };

  const emitToolbarState = (isRunning: boolean) => {
    currentToolbarIsRunning = isRunning;
    postToolbarState(isRunning);
    for (const listener of toolbarListeners) {
      try { listener(isRunning); } catch (err) {
        console.error('Emulator toolbar listener failed', err);
      }
    }
    if (isRunning) {
      clearHighlightedSourceLine();
      clearDataLineHighlights();
      lastDataAccessLog = null;
      try {
        emu.hardware?.Request(HardwareReq.DEBUG_MEM_ACCESS_LOG_RESET);
      } catch (err) {
        /* ignore */
      }
    } else {
      refreshDataLineHighlights(emu.hardware);
    }
  };

  const syncToolbarState = () => {
    postToolbarState(currentToolbarIsRunning);
  };

  const handleDebugAction = (action?: DebugAction) => {
    if (!action || !emu.hardware) return;
    switch (action) {
    case 'pause':
        emu.hardware.Request(HardwareReq.STOP);
        sendFrameToWebview(true);
        printDebugState('Pause:', emu.hardware, devectorOutput, panel);
        syncEditorBreakpointsFromHardware(emu.hardware, lastAddressSourceMap);
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
        sendFrameToWebview(true);
        printDebugState('Step into:', emu.hardware, devectorOutput, panel);
        break;

      case 'stepOver':
        emu.hardware.Request(HardwareReq.STOP);
        const addr = emu.hardware.Request(HardwareReq.GET_STEP_OVER_ADDR)['data'];
        emu.hardware.Request(HardwareReq.DEBUG_BREAKPOINT_ADD, { addr: addr, autoDel: true });
        printDebugState('Step over:', emu.hardware, devectorOutput, panel);
        emu.hardware.Request(HardwareReq.RUN);
        emitToolbarState(true);
        tick();
        break;

      case 'stepOut':
        emu.hardware.Request(HardwareReq.STOP);
        // TODO: implement proper step out
        emu.hardware?.Request(HardwareReq.EXECUTE_INSTR);
        sendFrameToWebview(true);
        printDebugState('Step out (NOT IMPLEMENTED):', emu.hardware, devectorOutput, panel);
        break;

      case 'stepFrame':
        emu.hardware.Request(HardwareReq.STOP);
        emu.hardware.Request(HardwareReq.EXECUTE_FRAME_NO_BREAKS);
        sendFrameToWebview(true);
        printDebugState('Run frame:', emu.hardware, devectorOutput, panel);
        emitToolbarState(false);
        break;

      case 'step256':
        emu.hardware.Request(HardwareReq.STOP);
        for (let i = 0; i < 256; i++) {
          emu.hardware.Request(HardwareReq.EXECUTE_INSTR);
        }
        sendFrameToWebview(true);
        printDebugState('Step 256:', emu.hardware, devectorOutput, panel);
        break;

      case 'restart':
        emu.hardware.Request(HardwareReq.STOP);
        emu.hardware.Request(HardwareReq.RESET);
        emu.hardware.Request(HardwareReq.RESTART);
        emu.Load();
        emu.hardware.Request(HardwareReq.RUN);
        emitToolbarState(true);
        tick();
        break;

      default:
        break;
    }
  };

  currentPanelController = {
    pause: () => { handleDebugAction('pause'); },
    resume: () => { handleDebugAction('run'); },
    stepFrame: () => { handleDebugAction('stepFrame'); },
    performDebugAction: (action: DebugAction) => { handleDebugAction(action); },
    stopAndClose: () => {
      if (panelDisposed) return;
      try { emu.hardware?.Request(HardwareReq.STOP); } catch (e) {}
      emitToolbarState(false);
      try { panel.dispose(); } catch (e) {}
    }
  };

  updateMemoryDumpFromHardware(panel, emu.hardware, 'pc');
  sendHardwareStats(true);

  panel.webview.onDidReceiveMessage(msg => {
    if (msg && msg.type === 'key') {
      // keyboard events: forward to keyboard handling
      const action: string = msg.kind === 'down' ? 'down' : 'up';
      emu.hardware?.Request(HardwareReq.KEY_HANDLING, { "scancode": msg.code, "action": action });

    }
    else if (msg && msg.type === 'stop') {
      emu.hardware?.Request(HardwareReq.STOP);
      emitToolbarState(false);
    }
    else if (msg && msg.type === 'debugAction') {
      handleDebugAction(msg.action);
    }
    else if (msg && msg.type === 'memoryDumpControl') {
      handleMemoryDumpControlMessage(msg, panel, emu.hardware);
    }
    else if (msg && msg.type === 'speedChange') {
      const speedValue = msg.speed;
      if (speedValue === 'max') {
        project!.settings.speed = 'max';
      } else {
        const parsed = parseFloat(speedValue);
        if (!isNaN(parsed) && parsed > 0) {
          project!.settings.speed = parsed;
        }
      }
    }
    else if (msg && msg.type === 'viewModeChange') {
      const viewMode = msg.viewMode;
      if (viewMode === 'full' || viewMode === 'noBorder') {
        currentViewMode = viewMode;
        // Re-send current frame with new view mode
        sendFrameToWebview(false);
      }
    }
    else if (msg && msg.type === 'ramDiskSaveOnRestartChange') {
      let enable = !!msg.value;
      project!.settings.saveRamDiskOnRestart = enable;
    }
  }, undefined, context.subscriptions);

  panel.onDidChangeViewState(() => {
    if (panel.visible) {
      syncToolbarState();
      // Re-send the current frame to the webview to restore canvas content
      // that may have been discarded while the tab was hidden
      sendFrameToWebview();
      try {
        panel.webview.postMessage({ type: 'setSpeed', speed: project!.settings.speed });
      } catch (e) {}
      try {
        panel.webview.postMessage({ type: 'setViewMode', viewMode: currentViewMode });
      } catch (e) {}
      try {
        panel.webview.postMessage({ type: 'setRamDiskSaveOnRestart', value: project!.settings.saveRamDiskOnRestart });
      } catch (e) {}
    }
  }, null, context.subscriptions);

  const editorVisibilityDisposable = vscode.window.onDidChangeVisibleTextEditors(() => {
    if (!currentToolbarIsRunning) {
      // Reapply execution highlight when editor visibility changes
      reapplyExecutionHighlight();
      // Reapply data line highlights (reads/writes)
      if (lastDataAccessLog) {
        applyDataLineHighlightsFromSnapshot(lastDataAccessLog);
      }
    }
  });
  context.subscriptions.push(editorVisibilityDisposable);

  async function tick(log_every_frame: boolean = false)
  {
    let running = true;

    do {
      let startTime = performance.now();

      emu.hardware?.Request(HardwareReq.EXECUTE_FRAME);
      sendFrameToWebview();

      // logging
      if (log_every_frame){
        printDebugState('hw stats:', emu.hardware!, devectorOutput, panel, false);
      }

      running = emu.hardware?.Request(HardwareReq.IS_RUNNING)['isRunning'] ?? false;

      // throttle to approx real-time, adjusted by emulation speed
      const elapsed = performance.now() - startTime;
      let delay: number;
      if (project!.settings.speed === 'max') {
        delay = 0; // no delay for max speed
      } else {
        const targetFrameTime = (1000 / 60) / project!.settings.speed;
        delay = Math.max(0, targetFrameTime - elapsed);
      }
      await new Promise(resolve => setTimeout(resolve, delay));

    } while (running && !panelDisposed);

    // If the panel is gone, skip post-break work
    if (panelDisposed) return;

    // Force hardware stats update (bypassing throttle) when breaking to
    // ensure Register panel is synchronized
    sendFrameToWebview(true);
    printDebugState('Break:', emu.hardware!, devectorOutput, panel);
    syncEditorBreakpointsFromHardware(emu.hardware, lastAddressSourceMap);
    emitToolbarState(false);
  }

  emitToolbarState(true);
  tick();
}

export function reloadEmulatorBreakpointsFromFile()
: number
{
  if (!lastBreakpointSource) return 0;
  const { applied, addressSourceMap } = loadBreakpointsFromToken(
    lastBreakpointSource.absoluteRomPath,
    lastBreakpointSource.hardware,
    {
      log: lastBreakpointSource.log,
      debugPath: lastBreakpointSource.absoluteDebugPath,
      cacheSymbolMetadata,
      clearSymbolMetadataCache,
    });
  lastAddressSourceMap = addressSourceMap;
  return applied;
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
    if (!currentToolbarIsRunning) {
      refreshDataLineHighlights(hardware);
    }
  }
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

export function performEmulatorDebugAction(action: DebugAction): boolean {
  if (currentPanelController) {
    currentPanelController.performDebugAction(action);
    return true;
  }
  vscode.window.showWarningMessage('Emulator panel not open');
  return false;
}

export function stopAndCloseEmulatorPanel(): void {
  if (currentPanelController) {
    currentPanelController.stopAndClose();
  } else {
    vscode.window.showWarningMessage('Emulator panel not open');
  }
}

export function onEmulatorToolbarStateChange(listener: (isRunning: boolean) => void): vscode.Disposable {
  toolbarListeners.add(listener);
  return {
    dispose: () => toolbarListeners.delete(listener)
  };
}

export function onEmulatorPanelClosed(listener: PanelClosedListener): vscode.Disposable {
  panelClosedListeners.add(listener);
  return {
    dispose: () => panelClosedListeners.delete(listener)
  };
}

export type HoverSymbolInfo = { value: number; kind: 'label' | 'const' | 'line' };

export type InstructionHoverInfo = {
  display: string;
  address: number;
  bytes: number[];
};

const lxiRegisterByOpcode: Record<number, string> = {
  0x01: 'b',
  0x11: 'd',
  0x21: 'h',
  0x31: 'sp'
};

const mviRegisterByOpcode: Record<number, string> = {
  0x06: 'b',
  0x0E: 'c',
  0x16: 'd',
  0x1E: 'e',
  0x26: 'h',
  0x2E: 'l',
  0x36: 'm',
  0x3E: 'a'
};

const jumpMnemonicByOpcode: Record<number, string> = {
  0xC2: 'jnz',
  0xCA: 'jz',
  0xD2: 'jnc',
  0xDA: 'jc',
  0xE2: 'jpo',
  0xEA: 'jpe',
  0xF2: 'jp',
  0xFA: 'jm',
  0xC3: 'jmp'
};

const callMnemonicByOpcode: Record<number, string> = {
  0xC4: 'cnz',
  0xCC: 'cz',
  0xD4: 'cnc',
  0xDC: 'cc',
  0xE4: 'cpo',
  0xEC: 'cpe',
  0xF4: 'cp',
  0xFC: 'cm',
  0xCD: 'call'
};

const byteImmediateMnemonicByOpcode: Record<number, string> = {
  0xC6: 'adi',
  0xCE: 'aci',
  0xD6: 'sui',
  0xDE: 'sbi',
  0xE6: 'ani',
  0xEE: 'xri',
  0xF6: 'ori',
  0xFE: 'cpi'
};

const wordAddressMnemonicByOpcode: Record<number, string> = {
  0x32: 'sta',
  0x3A: 'lda',
  0x22: 'shld',
  0x2A: 'lhld'
};

function stripAsmComment(text: string): string {
  return text.replace(/\/\/.*$|;.*$/, '').trim();
}

function formatHexByte(value: number): string {
  return '0x' + (value & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

function formatHexWord(value: number): string {
  return '0x' + (value & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

function formatInstructionHoverText(opcode: number, bytes: number[], sourceLine: string): string {
  const byteImm = bytes.length >= 2 ? bytes[1] & 0xff : undefined;
  const wordImm = bytes.length >= 3 ? ((bytes[1] & 0xff) | ((bytes[2] & 0xff) << 8)) & 0xffff : undefined;

  if (opcode in lxiRegisterByOpcode && wordImm !== undefined) {
    return `lxi ${lxiRegisterByOpcode[opcode]}, ${formatHexWord(wordImm)}`;
  }
  if (opcode in mviRegisterByOpcode && byteImm !== undefined) {
    return `mvi ${mviRegisterByOpcode[opcode]}, ${formatHexByte(byteImm)}`;
  }
  if (opcode in wordAddressMnemonicByOpcode && wordImm !== undefined) {
    return `${wordAddressMnemonicByOpcode[opcode]} ${formatHexWord(wordImm)}`;
  }
  if (opcode in jumpMnemonicByOpcode && wordImm !== undefined) {
    return `${jumpMnemonicByOpcode[opcode]} ${formatHexWord(wordImm)}`;
  }
  if (opcode in callMnemonicByOpcode && wordImm !== undefined) {
    return `${callMnemonicByOpcode[opcode]} ${formatHexWord(wordImm)}`;
  }
  if (opcode === 0xD3 && byteImm !== undefined) {
    return `out ${formatHexByte(byteImm)}`;
  }
  if (opcode === 0xDB && byteImm !== undefined) {
    return `in ${formatHexByte(byteImm)}`;
  }
  if (opcode in byteImmediateMnemonicByOpcode && byteImm !== undefined) {
    return `${byteImmediateMnemonicByOpcode[opcode]} ${formatHexByte(byteImm)}`;
  }

  const sanitized = stripAsmComment(sourceLine);
  if (sanitized.length) return sanitized;
  return `opcode 0x${opcode.toString(16).toUpperCase().padStart(2, '0')}`;
}

export function resolveInstructionHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  address: number)
  : InstructionHoverInfo | undefined
{
  if (!lastBreakpointSource?.hardware || currentToolbarIsRunning) return undefined;

  let hardware = lastBreakpointSource.hardware;

  const normalizedAddr = address & 0xffff;
  const instr = hardware.Request(HardwareReq.GET_INSTR, { "addr": normalizedAddr })['data'] as number[];
  const opcode = instr[0];
  const bytes = instr;

  const sourceLine = document.lineAt(position.line).text;
  const display = formatInstructionHoverText(opcode, bytes, sourceLine);
  return { display, address: normalizedAddr, bytes };
}

export function resolveEmulatorHoverSymbol(identifier: string, location?: { filePath?: string; line?: number }): HoverSymbolInfo | undefined {
  if (!lastSymbolCache) return undefined;
  const token = (identifier || '').trim();
  if (token) {
    const exact = lastSymbolCache.byName.get(token) || lastSymbolCache.byLowerCase.get(token.toLowerCase());
    if (exact) return exact;
  }
  if (location?.filePath && location.line !== undefined) {
    const fileKey = normalizeFileKey(location.filePath);
    const perLine = fileKey ? lastSymbolCache.lineAddresses.get(fileKey) : undefined;
    const addrs = perLine?.get(location.line);
    const addr = addrs && addrs.length ? addrs[0] : undefined;
    if (addr !== undefined) {
      return { value: addr, kind: 'line' };
    }
  }
  return undefined;
}

export function resolveSymbolDefinition(identifier: string): { filePath: string; line: number } | undefined {
  if (!lastSymbolCache) return undefined;
  const token = (identifier || '').trim();
  if (!token) return undefined;
  const symbol = lastSymbolCache.byName.get(token) || lastSymbolCache.byLowerCase.get(token.toLowerCase());
  if (!symbol) return undefined;
  return resolveSymbolSource(symbol, lastSymbolCache.filePaths);
}

export function isEmulatorPanelPaused(): boolean {
  return !!currentPanelController && !currentToolbarIsRunning;
}

export type DataDirectiveHoverInfo = {
  value: number;
  address: number;
  unitBytes: number;
  directive: 'byte' | 'word';
  range: vscode.Range;
  sourceValue?: number;
};

export function resolveDataDirectiveHover(document: vscode.TextDocument, position: vscode.Position): DataDirectiveHoverInfo | undefined {
  if (!lastBreakpointSource?.hardware || currentToolbarIsRunning) return undefined;
  if (!dataLineSpanCache || dataLineSpanCache.size === 0) return undefined;
  const fileKey = normalizeFileKey(document.uri.fsPath);
  if (!fileKey) return undefined;
  const lineSpans = dataLineSpanCache.get(fileKey);
  if (!lineSpans) return undefined;
  const lineNumber = position.line + 1;
  const span = lineSpans.get(lineNumber);
  if (!span) return undefined;
  const lineText = document.lineAt(position.line).text;
  const directiveInfo = extractDataDirectiveInfo(lineText);
  if (!directiveInfo) return undefined;
  const { directive, ranges } = directiveInfo;
  if ((directive === 'byte' && span.unitBytes !== 1) || (directive === 'word' && span.unitBytes !== 2)) {
    // directive mismatch; fallback to unitBytes to infer
  }
  const matchIndex = ranges.findIndex(range => position.character >= range.start && position.character < range.end);
  if (matchIndex < 0) return undefined;
  const byteOffset = matchIndex * span.unitBytes;
  if (byteOffset >= span.byteLength) return undefined;
  const addr = (span.start + byteOffset) & 0xffff;
  const value = readMemoryValueForSpan(lastBreakpointSource.hardware, addr, span.unitBytes);
  if (value === undefined) return undefined;
  const tokenRange = ranges[matchIndex];
  const literalRange = new vscode.Range(position.line, tokenRange.start, position.line, tokenRange.end);
  const literalText = document.getText(literalRange);
  const sourceValue = parseDataLiteralValue(literalText, span.unitBytes);
  return {
    value,
    address: addr,
    unitBytes: span.unitBytes,
    directive,
    range: literalRange,
    sourceValue
  };
}

function resolveTokenFileReference(tokenPath: string | undefined, fileKey: string): string {
  if (!fileKey) return fileKey;
  if (path.isAbsolute(fileKey)) return path.normalize(fileKey);
  const baseDir = tokenPath ? path.dirname(tokenPath) : process.cwd();
  return path.normalize(path.resolve(baseDir, fileKey));
}

function clearSymbolMetadataCache() {
  lastSymbolCache = null;
  dataLineSpanCache = null;
  dataAddressLookup = null;
}

function loadSymbolCacheFromDebugFile(tokenPath: string): boolean {
  try {
    const text = fs.readFileSync(tokenPath, 'utf8');
    const tokens = JSON.parse(text);
    cacheSymbolMetadata(tokens, tokenPath);
    return !!lastSymbolCache;
  } catch (e) {
    return false;
  }
}

// Best-effort lazy load: look for a debug file next to the source document.
export async function ensureSymbolCacheForDocument(documentPath?: string): Promise<boolean> {
  if (lastSymbolCache) return true;
  if (!documentPath) return false;
  const dir = path.dirname(documentPath);
  const base = path.basename(documentPath, path.extname(documentPath));
  const candidate = path.join(dir, base + DEBUG_FILE_SUFFIX);
  if (fs.existsSync(candidate)) {
    if (loadSymbolCacheFromDebugFile(candidate)) return true;
  }
  // fallback: first *.debug.json in the same folder
  try {
    const entries = fs.readdirSync(dir, 'utf8');
    const debugFiles = entries.filter(f => f.toLowerCase().endsWith(DEBUG_FILE_SUFFIX));
    debugFiles.sort();
    for (const f of debugFiles) {
      const full = path.join(dir, f);
      if (loadSymbolCacheFromDebugFile(full)) return true;
    }
  } catch (_) {}
  return !!lastSymbolCache;
}

function resolveSymbolSource(symbol: SymbolMeta, filePaths: Map<string, string>): { filePath: string; line: number } | undefined {
  if (!symbol || !symbol.source) return undefined;
  const pathResolved = filePaths.get(symbol.source.fileKey);
  if (!pathResolved) return undefined;
  return { filePath: pathResolved, line: symbol.source.line };
}

function cacheSymbolMetadata(tokens: any, tokenPath?: string) {
  if (!tokens || typeof tokens !== 'object') {
    clearSymbolMetadataCache();
    return;
  }
  const byName = new Map<string, SymbolMeta>();
  const byLowerCase = new Map<string, SymbolMeta>();
  const filePaths = new Map<string, string>();
  const registerFilePath = (fileKey: string, resolvedPath: string) => {
    if (!fileKey || !resolvedPath) return;
    if (!filePaths.has(fileKey)) filePaths.set(fileKey, resolvedPath);
  };
  const registerSymbol = (name: string | undefined, meta: SymbolMeta) => {
    if (!name) return;
    byName.set(name, meta);
    const lower = name.toLowerCase();
    if (lower) {
      byLowerCase.set(lower, meta);
    }
  };
  if (tokens.labels && typeof tokens.labels === 'object') {
    for (const [labelName, rawInfo] of Object.entries(tokens.labels as Record<string, any>)) {
      const info: any = rawInfo;
      const addr = parseAddressLike(info?.addr ?? info?.address);
      if (addr === undefined) continue;
      const srcKey = normalizeFileKey(info?.src);
      const lineNum = typeof info?.line === 'number' ? info.line : undefined;
      const source: SymbolSource | undefined = (srcKey && lineNum) ? { fileKey: srcKey, line: lineNum } : undefined;
      if (srcKey && info?.src) {
        const resolvedPath = resolveTokenFileReference(tokenPath, info.src);
        if (resolvedPath) registerFilePath(srcKey, resolvedPath);
      }
      registerSymbol(labelName, { value: addr, kind: 'label', source });
    }
  }
  if (tokens.consts && typeof tokens.consts === 'object') {
    for (const [constName, rawValue] of Object.entries(tokens.consts as Record<string, any>)) {
      let resolved: number | undefined;
      let source: SymbolSource | undefined;
      if (rawValue && typeof rawValue === 'object') {
        if (typeof rawValue.value === 'number' && Number.isFinite(rawValue.value)) {
          resolved = rawValue.value;
        } else if (rawValue.hex !== undefined) {
          resolved = parseAddressLike(rawValue.hex);
        } else {
          resolved = parseAddressLike(rawValue.value);
        }
        const srcKey = normalizeFileKey(rawValue.src);
        const lineNum = typeof rawValue.line === 'number' ? rawValue.line : undefined;
        if (srcKey && lineNum) {
          source = { fileKey: srcKey, line: lineNum };
          if (rawValue.src) {
            const resolvedPath = resolveTokenFileReference(tokenPath, rawValue.src);
            if (resolvedPath) registerFilePath(srcKey, resolvedPath);
          }
        }
      } else {
        resolved = parseAddressLike(rawValue);
      }
      if (resolved === undefined) continue;
      registerSymbol(constName, { value: resolved, kind: 'const', source });
    }
  }

  const lineAddresses = new Map<string, Map<number, number[]>>();
  const dataLines: DataLineCache = new Map();
  const addressLookup = new Map<number, DataAddressEntry>();
  if (tokens.lineAddresses && typeof tokens.lineAddresses === 'object') {
    for (const [fileKeyRaw, entries] of Object.entries(tokens.lineAddresses as Record<string, any>)) {
      if (!entries || typeof entries !== 'object') continue;
      const normalizedKey = normalizeFileKey(fileKeyRaw);
      if (!normalizedKey) continue;
      const resolvedPath = resolveTokenFileReference(tokenPath, fileKeyRaw);
      if (resolvedPath) registerFilePath(normalizedKey, resolvedPath);
      const perLine = new Map<number, number[]>();
      for (const [lineKey, addrRaw] of Object.entries(entries as Record<string, any>)) {
        const lineNum = Number(lineKey);
        if (!Number.isFinite(lineNum)) continue;
        const addresses = coerceAddressList(addrRaw);
        if (!addresses.length) continue;
        let existing = perLine.get(lineNum);
        if (!existing) {
          perLine.set(lineNum, [...addresses]);
        } else {
          for (const addr of addresses) {
            if (!existing.includes(addr)) existing.push(addr);
          }
        }
      }
      if (perLine.size) {
        lineAddresses.set(normalizedKey, perLine);
      }
    }
  }
  if (tokens.dataLines && typeof tokens.dataLines === 'object') {
    for (const [fileKeyRaw, entries] of Object.entries(tokens.dataLines as Record<string, any>)) {
      if (!entries || typeof entries !== 'object') continue;
      const normalizedKey = normalizeFileKey(fileKeyRaw);
      if (!normalizedKey) continue;
      const resolvedPath = resolveTokenFileReference(tokenPath, fileKeyRaw);
      if (resolvedPath) registerFilePath(normalizedKey, resolvedPath);
      let perLine = dataLines.get(normalizedKey);
      if (!perLine) {
        perLine = new Map();
        dataLines.set(normalizedKey, perLine);
      }
      for (const [lineKey, rawSpan] of Object.entries(entries as Record<string, any>)) {
        const start = parseAddressLike((rawSpan as any)?.addr ?? (rawSpan as any)?.start ?? rawSpan);
        const byteLength = Number((rawSpan as any)?.byteLength ?? (rawSpan as any)?.length ?? 0);
        const unitBytes = Number((rawSpan as any)?.unitBytes ?? (rawSpan as any)?.unit ?? 1);
        const lineNum = Number(lineKey);
        if (start === undefined || !Number.isFinite(lineNum) || byteLength <= 0) continue;
        const span: DataLineSpan = {
          start: start & 0xffff,
          byteLength,
          unitBytes: unitBytes > 0 ? unitBytes : 1
        };
        perLine.set(lineNum, span);
        for (let offset = 0; offset < span.byteLength; offset++) {
          const addr = (span.start + offset) & 0xffff;
          if (!addressLookup.has(addr)) {
            addressLookup.set(addr, { fileKey: normalizedKey, line: lineNum, span });
          }
        }
      }
    }
  }

  lastSymbolCache = { byName, byLowerCase, lineAddresses, filePaths };
  dataLineSpanCache = dataLines.size ? dataLines : null;
  dataAddressLookup = addressLookup.size ? addressLookup : null;
}

function ensureHighlightDecoration(context: vscode.ExtensionContext) {
  if (!pausedLineDecoration) {
    pausedLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(129, 127, 38, 0.45)',
      overviewRulerColor: 'rgba(200, 200, 175, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Full
    });
    context.subscriptions.push(pausedLineDecoration);
  }
  if (!unmappedAddressDecoration) {
    unmappedAddressDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(200, 180, 0, 0.35)',
      overviewRulerColor: 'rgba(255, 220, 100, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Full
    });
    context.subscriptions.push(unmappedAddressDecoration);
  }
}

function clearHighlightedSourceLine() {
  if (lastHighlightedEditor) {
    try {
      if (pausedLineDecoration) {
        lastHighlightedEditor.setDecorations(pausedLineDecoration, []);
      }
      if (unmappedAddressDecoration) {
        lastHighlightedEditor.setDecorations(unmappedAddressDecoration, []);
      }
    } catch (e) { /* ignore decoration clearing errors */ }
  }
  lastHighlightedEditor = null;
  lastHighlightedLine = null;
  lastHighlightedFilePath = null;
  lastHighlightDecoration = null;
  lastHighlightIsUnmapped = false;
}

/**
 * Reapplies the execution highlight to the source editor when it becomes visible again.
 * This function is called when the visible editors change (e.g., when tabs are moved or split).
 * It restores the paused line decoration (green highlight) or unmapped address decoration (yellow)
 * to maintain continuity of the debugger state visualization.
 *
 * The function only operates when:
 * - The emulator is paused (not running)
 * - There is a saved highlight state (file path and decoration)
 * - The highlighted file is among the currently visible editors
 */
function reapplyExecutionHighlight() {
  // Only reapply if we have saved highlight state and emulator is paused
  if (!lastHighlightedFilePath || !lastHighlightDecoration || currentToolbarIsRunning) {
    return;
  }

  // Find the editor for the highlighted file in visible editors
  const editor = vscode.window.visibleTextEditors.find(
    (ed: vscode.TextEditor) => ed.document.uri.fsPath === lastHighlightedFilePath
  );

  if (!editor) {
    return;
  }

  // Use the saved flag to determine which decoration type to apply
  const decorationType = lastHighlightIsUnmapped
    ? unmappedAddressDecoration
    : pausedLineDecoration;

  if (!decorationType) {
    return;
  }

  try {
    // Reapply the decoration to the editor
    editor.setDecorations(decorationType, [lastHighlightDecoration]);
    lastHighlightedEditor = editor;
  } catch (e) {
    /* ignore decoration reapply errors */
  }
}


function isSkippableHighlightLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith(';') || trimmed.startsWith('//')) return true;
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx >= 0) {
    const before = trimmed.slice(0, colonIdx).trim();
    const after = trimmed.slice(colonIdx + 1).trim();
    if (/^[A-Za-z_.$@?][\w.$@?]*$/.test(before) && (!after || after.startsWith(';') || after.startsWith('//'))) {
      return true;
    }
  }
  const equMatch = trimmed.match(/^([A-Za-z_.$@?][\w.$@?]*)\s+(equ)\b/i);
  if (equMatch && !trimmed.includes(':')) return true;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx > 0) {
    const lhs = trimmed.slice(0, eqIdx).trim();
    const rhs = trimmed.slice(eqIdx + 1).trim();
    if (/^[A-Za-z_.$@?][\w.$@?]*$/.test(lhs) && rhs && !rhs.startsWith(';') && !trimmed.includes(':')) {
      return true;
    }
  }
  return false;
}

function resolvePreferredHighlightLine(filePath: string, addr: number, doc?: vscode.TextDocument): number | undefined {
  if (!lastSymbolCache || !lastSymbolCache.lineAddresses.size) return undefined;
  const fileKey = normalizeFileKey(filePath);
  if (!fileKey) return undefined;
  const perLine = lastSymbolCache.lineAddresses.get(fileKey);
  if (!perLine || perLine.size === 0) return undefined;
  const normalizedAddr = addr & 0xffff;
  const candidates: number[] = [];
  for (const [lineNumber, lineAddrs] of perLine.entries()) {
    for (const lineAddr of lineAddrs) {
      if ((lineAddr & 0xffff) === normalizedAddr) {
        candidates.push(lineNumber);
        break;
      }
    }
  }
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => b - a);
  if (doc) {
    for (const lineNumber of candidates) {
      const idx = lineNumber - 1;
      if (idx < 0 || idx >= doc.lineCount) continue;
      const text = doc.lineAt(idx).text;
      if (!isSkippableHighlightLine(text)) {
        return lineNumber;
      }
    }
  }
  return candidates[0];
}

function highlightSourceFromHardware(hardware: Hardware | undefined | null) {
  if (!hardware || !highlightContext) return;
  try {
    const pc = hardware?.Request(HardwareReq.GET_REG_PC)['pc'] ?? 0;
    const debugLine = getDebugLine(hardware);
    highlightSourceAddress(hardware, pc, debugLine);
  } catch (e) {
    /* ignore highlight errors */
  }
}

function disassembleInstructionAt(hardware: Hardware | undefined | null, addr: number)
: string | undefined
{
  if (!hardware) return undefined;

  const instr = hardware.Request(HardwareReq.GET_INSTR, { "addr": addr })['data'] as number[];
  const opcode = instr.shift() ?? 0;
  const bytes = instr;

  const listing = bytes.map(formatHexByte).join(' ');
  const display = formatInstructionHoverText(opcode, bytes, '');
  return `${display} (bytes: ${listing})`;
}

function highlightSourceAddress(hardware: Hardware | undefined | null, addr?: number, debugLine?: string) {
  if (!highlightContext || addr === undefined || addr === null) return;
  ensureHighlightDecoration(highlightContext);

  const normalizedAddr = addr & 0xffff;

  // Check if we have a source map and if this address is mapped
  if (!lastAddressSourceMap || lastAddressSourceMap.size === 0) {
    // No source map at all - clear any previous highlights
    clearHighlightedSourceLine();
    return;
  }

  const info = lastAddressSourceMap.get(normalizedAddr);

  // Handle unmapped address case: show yellow highlight with explanation
  if (!info) {
    // Save reference to the currently highlighted editor and line before clearing
    const editorToUse = lastHighlightedEditor;
    const lineToUse = lastHighlightedLine;

    // Clear previous highlight decorations
    clearHighlightedSourceLine();

    // If we have an editor with a previous highlight, show the unmapped indicator there
    if (editorToUse && unmappedAddressDecoration && lineToUse !== null) {
      try {
        const doc = editorToUse.document;
        const idx = Math.min(Math.max(lineToUse, 0), doc.lineCount - 1);
        const lineText = doc.lineAt(idx).text;
        const range = new vscode.Range(idx, 0, idx, Math.max(lineText.length, 1));
        const addrHex = '0x' + normalizedAddr.toString(16).toUpperCase().padStart(4, '0');
        const disasm = disassembleInstructionAt(hardware, normalizedAddr);
        const disasmText = disasm ? ` - executing ${disasm}` : ' - executing unmapped code';
        const decoration: vscode.DecorationOptions = {
          range,
          renderOptions: {
            after: {
              contentText: `  No source mapping for address ${addrHex}${disasmText}`,
              color: consts.UNMAPPED_ADDRESS_COLOR,
              fontStyle: 'italic',
              fontWeight: 'normal'
            }
          }
        };
        editorToUse.setDecorations(unmappedAddressDecoration, [decoration]);
        lastHighlightedEditor = editorToUse;  // Restore the reference
        lastHighlightedLine = idx;  // Restore the line number
        lastHighlightedFilePath = doc.uri.fsPath;
        lastHighlightDecoration = decoration;
        lastHighlightIsUnmapped = true;
      } catch (err) {
        /* ignore unmapped decoration errors */
      }
    }
    return;
  }

  // We have a mapping - show normal green highlight
  if (!pausedLineDecoration) return;

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
      const preferredLine = resolvePreferredHighlightLine(targetPath, normalizedAddr, doc) ?? info.line;
      const totalLines = doc.lineCount;
      if (totalLines === 0) return;
      const idx = Math.min(Math.max(preferredLine - 1, 0), totalLines - 1);
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
      lastHighlightedLine = idx;
      lastHighlightedFilePath = targetPath;
      lastHighlightDecoration = decoration;
      lastHighlightIsUnmapped = false;
    } catch (err) {
      /* ignore highlight errors */
    }
  };
  void run();
}

function ensureDataHighlightDecorations(context: vscode.ExtensionContext) {
  if (!dataReadDecoration) {
    dataReadDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: false,
      backgroundColor: 'rgba(64, 127, 255, 0.25)'
    });
    context.subscriptions.push(dataReadDecoration);
  }
  if (!dataWriteDecoration) {
    dataWriteDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: false,
      backgroundColor: 'rgba(255, 92, 92, 0.25)'
    });
    context.subscriptions.push(dataWriteDecoration);
  }
}

function normalizeFsPathSafe(value: string): string {
  try {
    return path.resolve(value).replace(/\\/g, '/').toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function buildElementRanges(elements: Map<number, Set<number>>, doc: vscode.TextDocument): vscode.Range[] {
  const ranges: vscode.Range[] = [];
  for (const [line, elementIndices] of elements) {
    const lineIdx = line - 1;
    if (!Number.isFinite(lineIdx) || lineIdx < 0 || lineIdx >= doc.lineCount) continue;
    const lineText = doc.lineAt(lineIdx).text;
    const directiveInfo = extractDataDirectiveInfo(lineText);
    if (!directiveInfo || !directiveInfo.ranges.length) continue;
    for (const elemIdx of elementIndices) {
      // Skip if the element index doesn't match a parsed token
      // (can happen if source was edited or byte spans differ from token count)
      if (elemIdx < 0 || elemIdx >= directiveInfo.ranges.length) continue;
      const tokenRange = directiveInfo.ranges[elemIdx];
      ranges.push(new vscode.Range(lineIdx, tokenRange.start, lineIdx, tokenRange.end));
    }
  }
  return ranges;
}

function applyDataLineHighlightsFromSnapshot(snapshot?: MemoryAccessLog) {
  if (!highlightContext) return;
  ensureDataHighlightDecorations(highlightContext);
  if (!snapshot || !dataAddressLookup || !lastSymbolCache || !lastSymbolCache.filePaths.size) {
    clearDataLineHighlights();
    lastDataAccessLog = null;
    return;
  }
  lastDataAccessLog = snapshot;

  // Accumulate which element indices were accessed for each line
  // bucket maps: fileKey -> Map<line, Set<elementIndex>>
  const accumulate = (addr: number, bucket: Map<string, Map<number, Set<number>>>) => {
    const entry = dataAddressLookup?.get(addr & 0xffff);
    if (!entry) return;
    const resolvedPath = lastSymbolCache?.filePaths.get(entry.fileKey);
    if (!resolvedPath) return;
    const key = normalizeFsPathSafe(resolvedPath);
    // Calculate which element this address corresponds to
    const byteOffset = (addr & 0xffff) - entry.span.start;
    // Guard against invalid span data
    const unitBytes = entry.span.unitBytes > 0 ? entry.span.unitBytes : 1;
    if (byteOffset < 0 || byteOffset >= entry.span.byteLength) return;
    const elementIndex = Math.floor(byteOffset / unitBytes);
    let lineMap = bucket.get(key);
    if (!lineMap) {
      lineMap = new Map();
      bucket.set(key, lineMap);
    }
    let elemSet = lineMap.get(entry.line);
    if (!elemSet) {
      elemSet = new Set();
      lineMap.set(entry.line, elemSet);
    }
    elemSet.add(elementIndex);
  };
  const readElements = new Map<string, Map<number, Set<number>>>();
  const writeElements = new Map<string, Map<number, Set<number>>>();
  // TODO: improve performance and UI information by using value. Currently we ignore it.
  snapshot.reads.forEach((value, addr) => accumulate(addr, readElements));
  snapshot.writes.forEach((value, addr) => accumulate(addr, writeElements));
  for (const editor of vscode.window.visibleTextEditors) {
    const key = normalizeFsPathSafe(editor.document.uri.fsPath);
    const readMap = readElements.get(key);
    const writeMap = writeElements.get(key);
    if (dataReadDecoration) editor.setDecorations(dataReadDecoration, readMap ? buildElementRanges(readMap, editor.document) : []);
    if (dataWriteDecoration) editor.setDecorations(dataWriteDecoration, writeMap ? buildElementRanges(writeMap, editor.document) : []);
  }
}

function clearDataLineHighlights() {
  if (!highlightContext) return;
  for (const editor of vscode.window.visibleTextEditors) {
    if (dataReadDecoration) editor.setDecorations(dataReadDecoration, []);
    if (dataWriteDecoration) editor.setDecorations(dataWriteDecoration, []);
  }
}

function refreshDataLineHighlights(hardware?: Hardware | null) {
  // TODO: check if it is useful
  if (!hardware) {
    clearDataLineHighlights();
    lastDataAccessLog = null;
    return;
  }
  const snapshotAccessLog = hardware.Request(HardwareReq.DEBUG_MEM_ACCESS_LOG_GET)['data'] as MemoryAccessLog | undefined;
  applyDataLineHighlightsFromSnapshot(snapshotAccessLog);
}

type DirectiveValueRange = { start: number; end: number };

function extractDataDirectiveInfo(lineText: string): { directive: 'byte' | 'word'; ranges: DirectiveValueRange[] } | undefined {
  if (!lineText.trim()) return undefined;
  const commentMatch = lineText.search(/(;|\/\/)/);
  const workingText = commentMatch >= 0 ? lineText.slice(0, commentMatch) : lineText;
  const directiveRegex = /(?:^|[\s\t])((?:\.?(?:db|byte))|(?:\.?(?:dw|word)))\b/i;
  const match = directiveRegex.exec(workingText);
  if (!match || match.index === undefined) return undefined;
  const token = match[1] || '';
  const directive: 'byte' | 'word' = token.toLowerCase().includes('w') ? 'word' : 'byte';
  const matchText = match[0];
  const tokenStart = (match.index ?? 0) + matchText.lastIndexOf(token);
  const valuesOffset = tokenStart + token.length;
  const valuesSegment = workingText.slice(valuesOffset);
  const ranges = splitArgsWithRanges(valuesSegment, valuesOffset);
  if (!ranges.length) return undefined;
  return { directive, ranges };
}

function splitArgsWithRanges(text: string, offset: number): DirectiveValueRange[] {
  const ranges: DirectiveValueRange[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let tokenStart = -1;
  const pushToken = (endIndex: number) => {
    if (tokenStart === -1) return;
    let startIdx = tokenStart;
    let endIdx = endIndex;
    while (startIdx < endIdx && /\s/.test(text[startIdx]!)) startIdx++;
    while (endIdx > startIdx && /\s/.test(text[endIdx - 1]!)) endIdx--;
    if (startIdx < endIdx) {
      ranges.push({ start: offset + startIdx, end: offset + endIdx });
    }
    tokenStart = -1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const prev = i > 0 ? text[i - 1]! : '';
    if (!inDouble && ch === '\'' && prev !== '\\') {
      if (tokenStart === -1) tokenStart = i;
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"' && prev !== '\\') {
      if (tokenStart === -1) tokenStart = i;
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === '(') {
      if (tokenStart === -1) tokenStart = i;
      depth++;
      continue;
    }
    if (ch === ')' && depth > 0) {
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) {
      pushToken(i);
      continue;
    }
    if (tokenStart === -1 && !/\s/.test(ch)) {
      tokenStart = i;
    }
  }
  pushToken(text.length);
  return ranges;
}

// unitBytes is 1 for byte, 2 for word
function readMemoryValueForSpan(hardware: Hardware | undefined | null, addr: number, unitBytes: number): number | undefined {
  if (!hardware) return undefined;

  const normalizedAddr = addr & 0xffff;
  const bytes = hardware.Request(HardwareReq.GET_MEM_RANGE, {"addr": normalizedAddr, "length": unitBytes})['data'] as number[];

  if (unitBytes === 1) return bytes[0];

  const word = (bytes[1] << 8) | bytes[0];
  return word;
}

function parseDataLiteralValue(text: string, unitBytes: number): number | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed.length) return undefined;
  let value: number | undefined;
  const normalizeUnderscore = (s: string) => s.replace(/_/g, '');
  if (/^0x[0-9a-fA-F_]+$/.test(trimmed)) value = parseInt(normalizeUnderscore(trimmed.slice(2)), 16);
  else if (/^\$[0-9a-fA-F_]+$/.test(trimmed)) value = parseInt(normalizeUnderscore(trimmed.slice(1)), 16);
  else if (/^0b[01_]+$/i.test(trimmed)) value = parseInt(normalizeUnderscore(trimmed.slice(2)), 2);
  else if (/^b[01_]+$/i.test(trimmed)) value = parseInt(normalizeUnderscore(trimmed.slice(1)), 2);
  else if (/^%[01_]+$/.test(trimmed)) value = parseInt(normalizeUnderscore(trimmed.slice(1)), 2);
  else if (/^[-+]?[0-9]+$/.test(trimmed)) value = parseInt(trimmed, 10);
  else if (/^'(.|\\.)'$/.test(trimmed)) {
    const inner = trimmed.slice(1, trimmed.length - 1);
    value = inner.length === 1 ? inner.charCodeAt(0) : inner.charCodeAt(inner.length - 1);
  }
  if (value === undefined || Number.isNaN(value)) return undefined;
  const mask = unitBytes >= 4 ? 0xffffffff : ((1 << (unitBytes * 8)) >>> 0) - 1;
  return value & mask;
}
