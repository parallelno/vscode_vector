import * as vscode from 'vscode';
import { Emulator } from './emulator';
import * as path from 'path';
import * as fs from 'fs';
import { Hardware } from './emulator/hardware';
import { HardwareReq } from './emulator/hardware_reqs';
import { FRAME_H, FRAME_LEN, FRAME_W } from './emulator/display';
import Memory, { AddrSpace, MAPPING_MODE_MASK, MemoryAccessSnapshot } from './emulator/memory';
import CPU, { CpuState } from './emulator/cpu_i8080';
import IO from './emulator/io';
import { getWebviewContent } from './emulatorUI/webviewContent';
import { getDebugLine, getDebugState } from './emulatorUI/debugOutput';
import { handleMemoryDumpControlMessage, resetMemoryDumpState, updateMemoryDumpFromHardware } from './emulatorUI/memoryDump';
import { disposeHardwareStatsTracking, resetHardwareStatsTracking, tryCollectHardwareStats } from './emulatorUI/hardwareStats';
import { parseAddressLike } from './emulatorUI/utils';
import { KbOperation } from './emulator/keyboard';

// set to true to enable instruction logging to file
const log_tick_to_file = false;

// Decoration colors
const UNMAPPED_ADDRESS_COLOR = '#ffcc00';

type SourceLineRef = { file: string; line: number };

let lastBreakpointSource: { programPath: string; debugPath?: string; hardware?: Hardware | null; log?: vscode.OutputChannel } | null = null;
let lastAddressSourceMap: Map<number, SourceLineRef> | null = null;
type SymbolMeta = { value: number; kind: 'label' | 'const' };
type SymbolCache = {
  byName: Map<string, SymbolMeta>;
  byLowerCase: Map<string, SymbolMeta>;
  lineAddresses: Map<string, Map<number, number>>;
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
let currentEmulationSpeed: number | 'max' = 1;
let dataReadDecoration: vscode.TextEditorDecorationType | null = null;
let dataWriteDecoration: vscode.TextEditorDecorationType | null = null;
let lastDataAccessSnapshot: MemoryAccessSnapshot | null = null;

let currentPanelController: { pause: () => void; resume: () => void; stepFrame: () => void; } | null = null;

// View modes for display rendering
type ViewMode = 'full' | 'noBorder';
let currentViewMode: ViewMode = 'noBorder';

type OpenEmulatorOptions = {
  /** Path to the ROM or FDD file to load */
  programPath?: string;
  /** Path to the debug symbols file */
  debugPath?: string;
  /** Path to the project.json file (used for saving emulation speed on close) */
  projectPath?: string;
  /** Initial emulation speed to set when starting the emulator */
  initialSpeed?: number | 'max';
  /** Initial view mode for display rendering */
  initialViewMode?: ViewMode;
  /** Path to the RAM disk data file for persistence */
  ramDiskDataPath?: string;
};

export async function openEmulatorPanel(context: vscode.ExtensionContext, logChannel?: vscode.OutputChannel, options?: OpenEmulatorOptions)
{
  const pickProgramFromDialog = async (): Promise<string> => {
    const defaultUri = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
      ? vscode.Uri.file(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'test.rom'))
      : undefined;
    const candidates = await vscode.window.showOpenDialog({
      canSelectMany: false,
      defaultUri,
      filters: { 'File': ['rom', 'fdd'] }
    });
    return candidates && candidates.length ? candidates[0].fsPath : '';
  };

  let programPath = (options?.programPath|| '').trim();
  if (!programPath) {
    programPath = await pickProgramFromDialog();
  }

  if (!programPath) {
    vscode.window.showWarningMessage('File selection cancelled. Emulator not started.');
    return;
  }

  if (!fs.existsSync(programPath)) {
    vscode.window.showErrorMessage(`File not found: ${programPath}`);
    return;
  }

  const panel = vscode.window.createWebviewPanel('Devector', 'Vector-06C Emulator', vscode.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'images'))]
  });

  const html = getWebviewContent();
  panel.webview.html = html;
  highlightContext = context;
  ensureHighlightDecoration(context);
  currentToolbarIsRunning = true;
  resetHardwareStatsTracking();
  resetMemoryDumpState();

  const emu = new Emulator(context.extensionPath, '', {
    ramDiskDataPath: options?.ramDiskDataPath,
    ramDiskClearAfterRestart: !options?.ramDiskDataPath  // Only clear if no persistence path
  }, programPath);

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
    if (log_tick_to_file && programPath) {
      const parsed = path.parse(programPath);
      const logName = parsed.name + '.debug.log';
      const logPath = path.join(parsed.dir, logName);
      debugStream = fs.createWriteStream(logPath, { flags: 'w' });
      debugStream.on('error', (err) => {
        try { emuOutput.appendLine(`Debug log error: ${err}`); } catch (e) {}
      });
      debugStream.on('open', () => {
        try { emuOutput.appendLine(`Debug log file created: ${logPath}`); } catch (e) {}
      });
    }
  } catch (e) { debugStream = null; }

  // Announce ROM load (path, size, load addr)
  try {
    const size = fs.statSync(programPath).size;
    emuOutput.appendLine(`File loaded: ${programPath} size=${size} bytes`);
    try { panel.webview.postMessage({ type: 'romLoaded', path: programPath, size, addr: 0x0100 }); } catch (e) {}
  } catch (e) {}

  // Set initial speed from options if provided
  if (options?.initialSpeed !== undefined) {
    currentEmulationSpeed = options.initialSpeed;
    try {
      panel.webview.postMessage({ type: 'setSpeed', speed: options.initialSpeed });
    } catch (e) {}
  }

  // Set initial view mode from options if provided
  if (options?.initialViewMode !== undefined) {
    currentViewMode = options.initialViewMode;
    try {
      panel.webview.postMessage({ type: 'setViewMode', viewMode: options.initialViewMode });
    } catch (e) {}
  }

  // dispose the Output channel when the panel is closed
  panel.onDidDispose(
    () => {
      if (emu.hardware) {
        try { (emu.hardware as any).debugInstructionCallback = null; } catch (e) {}
        try { emu.hardware.Request(HardwareReq.STOP); } catch (e) {}
        try { emu.hardware.Destructor(); } catch (e) {}
      }

      try {
        if (debugStream) {
          debugStream.end();
          debugStream = null;
        } }
      catch (ee) {}

      try {
        if (ownsOutputChannel) {
          emuOutput.dispose();
        }
      }
      catch (e) {}

      // Save current emulation speed and view mode to project settings if projectPath is available
      // Note: This is a simple read-modify-write operation without file locking.
      // In normal usage (single VSCode instance), this is fine. If multiple instances
      // are saving simultaneously, the last write wins.
      if (options?.projectPath) {
        try {
          const projectText = fs.readFileSync(options.projectPath, 'utf8');
          const projectData = JSON.parse(projectText);
          if (!projectData.settings) {
            projectData.settings = {};
          }
          projectData.settings.speed = currentEmulationSpeed;
          projectData.settings.viewMode = currentViewMode;
          fs.writeFileSync(options.projectPath, JSON.stringify(projectData, null, 4), 'utf8');
        } catch (err) {
          // Silently fail if we can't save the speed (e.g., file permissions, concurrent access)
        }
      }

      currentPanelController = null;
      lastBreakpointSource = null;
      clearHighlightedSourceLine();
      lastAddressSourceMap = null;
      clearDataLineHighlights();
      lastDataAccessSnapshot = null;
      clearSymbolMetadataCache();
      highlightContext = null;
      resetMemoryDumpState();
      disposeHardwareStatsTracking();

    }, null, context.subscriptions
  );

  // attach debugger and sync breakpoints from the compiled token file, if available
  emu.hardware?.Request(HardwareReq.DEBUG_ATTACH, { data: true });
  emu.hardware?.Request(HardwareReq.RUN);

  const appliedBreakpoints = loadBreakpointsFromToken(programPath, emu.hardware, emuOutput, options?.debugPath);

  lastBreakpointSource = { programPath: programPath, debugPath: options?.debugPath, hardware: emu.hardware, log: emuOutput };

  // attach per-instruction callback to hardware (if available)
  try {
    if (log_tick_to_file && emu.hardware) {
      emu.hardware.debugInstructionCallback = (hw) => {
        try {
          const line = getDebugLine(hw)
          if (debugStream && line) {
            debugStream.write(line + '\n', (err) => {
              if (err) {
                 try { emuOutput.appendLine(`Log write error: ${err}`); } catch (e) {}
              }
            });
          }
        } catch (e) { }
      };
    }
  } catch (e) { }

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
   * Crops the full 768×312 framebuffer to show only the active area with 4:3 aspect ratio.
   * The active area is 256 lines tall starting at line 40 (SCAN_ACTIVE_AREA_TOP).
   * For a 4:3 aspect ratio with width 256, height should be 192 (256 / 4 * 3 = 192).
   * The output is cropped to 256×192 and centered within the active area.
   * 
   * @param fullFrame The full 768×312 framebuffer
   * @param displayMode The current display mode (MODE_256 or MODE_512)
   */
  const cropFrameToNoBorder = (fullFrame: Uint32Array, displayMode: boolean): { data: Uint32Array; width: number; height: number } => {
    const SCAN_ACTIVE_AREA_TOP = 40; // 24 vsync + 16 vblank top (from display.ts)
    const ACTIVE_AREA_H = 256; // (from display.ts)
    const BORDER_LEFT = 128; // in 768px buffer (from display.ts)
    
    // For 4:3 aspect ratio with width 256: height = 256 * 3 / 4 = 192
    const OUTPUT_WIDTH = 256;
    const OUTPUT_HEIGHT = Math.floor(OUTPUT_WIDTH * 3 / 4); // 192 for 4:3 aspect ratio
    
    // Center vertically within the 256-line active area: (256 - 192) / 2 = 32
    const verticalOffset = Math.floor((ACTIVE_AREA_H - OUTPUT_HEIGHT) / 2);
    const startLine = SCAN_ACTIVE_AREA_TOP + verticalOffset;
    
    const croppedFrame = new Uint32Array(OUTPUT_WIDTH * OUTPUT_HEIGHT);
    
    // Pixel stepping depends on display mode:
    // MODE_256 (false): Pixels are doubled in buffer → step 2 to get unique pixels
    // MODE_512 (true): Pixels are not doubled → step 1 for consecutive pixels
    // Test: displayMode=false → (false === false) ? 2 : 1 → 2 ✓
    //       displayMode=true  → (true === false) ? 2 : 1 → 1 ✓
    const pixelStep = (displayMode === IO.MODE_256) ? 2 : 1;
    
    for (let y = 0; y < OUTPUT_HEIGHT; y++) {
      const srcY = startLine + y;
      const srcOffset = srcY * FRAME_W + BORDER_LEFT;
      const dstOffset = y * OUTPUT_WIDTH;
      
      // Copy pixels with appropriate stepping based on display mode
      for (let x = 0; x < OUTPUT_WIDTH; x++) {
        croppedFrame[dstOffset + x] = fullFrame[srcOffset + x * pixelStep];
      }
    }
    
    return { data: croppedFrame, width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT };
  };

  /**
   * Send the current display frame to the webview.
   * @param forceStats If true, bypasses the throttling mechanism to force an immediate
   *                   hardware stats update. Use this after debug actions (pause, step, break)
   *                   to ensure the Register panel is synchronized with the highlighted source line.
   */
  const sendFrameToWebview = (forceStats: boolean = false) => {
    if (emu.hardware?.display){
      try {
        const fullFrame = emu.hardware.display.GetFrame();
        
        if (currentViewMode === 'noBorder') {
          // Get current display mode to handle pixel doubling correctly
          const displayMode = emu.hardware.display.io?.GetDisplayMode() ?? IO.MODE_256;
          // Crop to 256×192 active area with 4:3 aspect ratio
          const cropped = cropFrameToNoBorder(fullFrame, displayMode);
          panel.webview.postMessage({ type: 'frame', width: cropped.width, height: cropped.height, data: cropped.data.buffer });
        } else {
          // Send full 768×312 frame
          panel.webview.postMessage({ type: 'frame', width: FRAME_W, height: FRAME_H, data: fullFrame.buffer });
        }
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
    if (isRunning) {
      clearHighlightedSourceLine();
      clearDataLineHighlights();
      lastDataAccessSnapshot = null;
      try {
        emu.hardware?.memory?.clearAccessLog();
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

  const handleDebugAction = (action?: string) => {
    if (!action || !emu.hardware) return;
    switch (action) {
      case 'pause':
        emu.hardware.Request(HardwareReq.STOP);
        sendFrameToWebview(true);
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
        sendFrameToWebview(true);
        printDebugState('Step into:', emu.hardware, emuOutput, panel);
        break;
      case 'stepOver':
        emu.hardware.Request(HardwareReq.STOP);
        // TODO: implement proper step over by setting a temporary breakpoint after the CALL/RET
        emu.hardware?.Request(HardwareReq.EXECUTE_INSTR);
        sendFrameToWebview(true);
        printDebugState('Step over (NOT IMPLEMENTED):', emu.hardware, emuOutput, panel);
        break;
      case 'stepOut':
        emu.hardware.Request(HardwareReq.STOP);
        // TODO: implement proper step out
        emu.hardware?.Request(HardwareReq.EXECUTE_INSTR);
        sendFrameToWebview(true);
        printDebugState('Step out (NOT IMPLEMENTED):', emu.hardware, emuOutput, panel);
        break;
      case 'stepFrame':
        emu.hardware.Request(HardwareReq.STOP);
        emu.hardware.Request(HardwareReq.EXECUTE_FRAME_NO_BREAKS);
        sendFrameToWebview(true);
        printDebugState('Run frame:', emu.hardware, emuOutput, panel);
        emitToolbarState(false);
        break;
      case 'step256':
        emu.hardware.Request(HardwareReq.STOP);
        for (let i = 0; i < 256; i++) {
          emu.hardware.Request(HardwareReq.EXECUTE_INSTR);
        }
        sendFrameToWebview(true);
        printDebugState('Step 256:', emu.hardware, emuOutput, panel);
        break;
      case 'restart':
        emu.hardware.Request(HardwareReq.STOP);
        emu.hardware.Request(HardwareReq.RESET);
        emu.hardware.Request(HardwareReq.RESTART);
        emu.Load(programPath);
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
      sendFrameToWebview(true);
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
      sendFrameToWebview(true);
      printDebugState('Run frame:', emu.hardware, emuOutput, panel);
      emitToolbarState(false);
    }
  };

  updateMemoryDumpFromHardware(panel, emu.hardware, 'pc');
  sendHardwareStats(true);

  panel.webview.onDidReceiveMessage(msg => {
    if (msg && msg.type === 'key') {
      // keyboard events: forward to keyboard handling
      const op = emu.hardware?.keyboard?.KeyHandling(msg.code, msg.kind === 'down' ? 'down' : 'up') ?? KbOperation.NONE;
      if (op === KbOperation.RESET) {
        emu.hardware?.Request(HardwareReq.RESET);
      }
      else if (op === KbOperation.RESTART) {
        emu.hardware?.Request(HardwareReq.RESTART);
      }
    } else if (msg && msg.type === 'stop') {
      emu.hardware?.Request(HardwareReq.STOP);
      emitToolbarState(false);
    } else if (msg && msg.type === 'debugAction') {
      handleDebugAction(msg.action);
    } else if (msg && msg.type === 'memoryDumpControl') {
      handleMemoryDumpControlMessage(msg, panel, emu.hardware);
    } else if (msg && msg.type === 'speedChange') {
      const speedValue = msg.speed;
      if (speedValue === 'max') {
        currentEmulationSpeed = 'max';
      } else {
        const parsed = parseFloat(speedValue);
        if (!isNaN(parsed) && parsed > 0) {
          currentEmulationSpeed = parsed;
        }
      }
    } else if (msg && msg.type === 'viewModeChange') {
      const viewMode = msg.viewMode;
      if (viewMode === 'full' || viewMode === 'noBorder') {
        currentViewMode = viewMode;
        // Re-send current frame with new view mode
        sendFrameToWebview(false);
      }
    }
  }, undefined, context.subscriptions);

  panel.onDidChangeViewState(() => {
    if (panel.visible) {
      syncToolbarState();
      // Re-send the current frame to the webview to restore canvas content
      // that may have been discarded while the tab was hidden
      sendFrameToWebview();
      try {
        panel.webview.postMessage({ type: 'setSpeed', speed: currentEmulationSpeed });
      } catch (e) {}
    }
  }, null, context.subscriptions);

  const editorVisibilityDisposable = vscode.window.onDidChangeVisibleTextEditors(() => {
    if (!currentToolbarIsRunning) {
      // Reapply execution highlight when editor visibility changes
      reapplyExecutionHighlight();
      // Reapply data line highlights (reads/writes)
      if (lastDataAccessSnapshot) {
        applyDataLineHighlightsFromSnapshot(lastDataAccessSnapshot);
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
        printDebugState('hw stats:', emu.hardware!, emuOutput, panel, false);
      }

      running = emu.hardware?.Request(HardwareReq.IS_RUNNING)['isRunning'] ?? false;

      // throttle to approx real-time, adjusted by emulation speed
      const elapsed = performance.now() - startTime;
      let delay: number;
      if (currentEmulationSpeed === 'max') {
        delay = 0; // no delay for max speed
      } else {
        const targetFrameTime = (1000 / 60) / currentEmulationSpeed;
        delay = Math.max(0, targetFrameTime - elapsed);
      }
      await new Promise(resolve => setTimeout(resolve, delay));

    } while (running);

    // Force hardware stats update (bypassing throttle) when breaking to ensure Register panel is synchronized
    sendFrameToWebview(true);
    printDebugState('Break:', emu.hardware!, emuOutput, panel);
    emitToolbarState(false);
  }

  emitToolbarState(true);
  tick();
}

export function reloadEmulatorBreakpointsFromFile(): number {
  if (!lastBreakpointSource) return 0;
  return loadBreakpointsFromToken(
    lastBreakpointSource.programPath,
    lastBreakpointSource.hardware,
    lastBreakpointSource.log,
    lastBreakpointSource.debugPath);
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

export function resolveInstructionHover(document: vscode.TextDocument, position: vscode.Position, address: number): InstructionHoverInfo | undefined {
  if (!lastBreakpointSource?.hardware || currentToolbarIsRunning) return undefined;
  const memory = lastBreakpointSource.hardware?.memory;
  if (!memory) return undefined;
  if (!Number.isFinite(address)) return undefined;
  const normalizedAddr = (address | 0) & 0xffff;
  const opcode = memory.GetByte(normalizedAddr);
  if (typeof opcode !== 'number' || Number.isNaN(opcode)) return undefined;
  const rawLen = CPU.GetInstrLen(opcode);
  const instrLen = Math.max(1, Math.min(3, Number.isFinite(rawLen) ? rawLen : 1));
  const bytes: number[] = [];
  for (let i = 0; i < instrLen; i++) {
    const byteVal = memory.GetByte((normalizedAddr + i) & 0xffff);
    bytes.push(byteVal & 0xff);
  }
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
    const addr = perLine?.get(location.line);
    if (addr !== undefined) {
      return { value: addr, kind: 'line' };
    }
  }
  return undefined;
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


function loadBreakpointsFromToken(
    programPath: string,
    hardware: Hardware | undefined | null,
    log?: vscode.OutputChannel, debugPath?: string): number
{
  lastAddressSourceMap = null;
  clearSymbolMetadataCache();
  if (!hardware || !programPath) return 0;
  const tokenPath = deriveTokenPath(programPath, debugPath);
  if (!tokenPath || !fs.existsSync(tokenPath)) return 0;

  let tokens: any;
  try {
    tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    cacheSymbolMetadata(tokens, tokenPath);
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

function deriveTokenPath(romPath: string, debugPath?: string): string {
  if (debugPath) return debugPath;
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


function normalizeFileKey(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  return path.basename(filePath).toLowerCase();
}

function formatFileLineKey(fileKey: string, line: number): string {
  return `${fileKey}#${line}`;
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
      registerSymbol(labelName, { value: addr, kind: 'label' });
    }
  }
  if (tokens.consts && typeof tokens.consts === 'object') {
    for (const [constName, rawValue] of Object.entries(tokens.consts as Record<string, any>)) {
      let resolved: number | undefined;
      if (rawValue && typeof rawValue === 'object') {
        if (typeof rawValue.value === 'number' && Number.isFinite(rawValue.value)) {
          resolved = rawValue.value;
        } else if (rawValue.hex !== undefined) {
          resolved = parseAddressLike(rawValue.hex);
        } else {
          resolved = parseAddressLike(rawValue.value);
        }
      } else {
        resolved = parseAddressLike(rawValue);
      }
      if (resolved === undefined) continue;
      registerSymbol(constName, { value: resolved, kind: 'const' });
    }
  }

  const lineAddresses = new Map<string, Map<number, number>>();
  const dataLines: DataLineCache = new Map();
  const addressLookup = new Map<number, DataAddressEntry>();
  if (tokens.lineAddresses && typeof tokens.lineAddresses === 'object') {
    for (const [fileKeyRaw, entries] of Object.entries(tokens.lineAddresses as Record<string, any>)) {
      if (!entries || typeof entries !== 'object') continue;
      const normalizedKey = normalizeFileKey(fileKeyRaw);
      if (!normalizedKey) continue;
      const resolvedPath = resolveTokenFileReference(tokenPath, fileKeyRaw);
      if (resolvedPath) registerFilePath(normalizedKey, resolvedPath);
      const perLine = new Map<number, number>();
      for (const [lineKey, addrRaw] of Object.entries(entries as Record<string, any>)) {
        const addr = parseAddressLike(addrRaw);
        if (addr === undefined) continue;
        const lineNum = Number(lineKey);
        if (!Number.isFinite(lineNum)) continue;
        perLine.set(lineNum, addr & 0xffff);
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
  for (const [lineNumber, lineAddr] of perLine.entries()) {
    if ((lineAddr & 0xffff) === normalizedAddr) {
      candidates.push(lineNumber);
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
    const state = getDebugState(hardware);
    const debugLine = getDebugLine(hardware);
    highlightSourceAddress(hardware, state.global_addr, debugLine);
  } catch (e) {
    /* ignore highlight errors */
  }
}

function disassembleInstructionAt(hardware: Hardware | undefined | null, addr: number): string | undefined {
  const memory = hardware?.memory;
  if (!memory) return undefined;
  const normalizedAddr = addr & 0xffff;
  const opcode = memory.GetByte(normalizedAddr);
  if (typeof opcode !== 'number' || Number.isNaN(opcode)) return undefined;
  const rawLen = CPU.GetInstrLen(opcode);
  const instrLen = Math.max(1, Math.min(3, Number.isFinite(rawLen) ? rawLen : 1));
  const bytes: number[] = [];
  for (let i = 0; i < instrLen; i++) {
    const byteVal = memory.GetByte((normalizedAddr + i) & 0xffff);
    if (typeof byteVal !== 'number' || Number.isNaN(byteVal)) return undefined;
    bytes.push(byteVal & 0xff);
  }
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
              color: UNMAPPED_ADDRESS_COLOR,
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

function applyDataLineHighlightsFromSnapshot(snapshot?: MemoryAccessSnapshot) {
  if (!highlightContext) return;
  ensureDataHighlightDecorations(highlightContext);
  if (!snapshot || !dataAddressLookup || !lastSymbolCache || !lastSymbolCache.filePaths.size) {
    clearDataLineHighlights();
    lastDataAccessSnapshot = null;
    return;
  }
  lastDataAccessSnapshot = snapshot;
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
  snapshot.reads.forEach(addr => accumulate(addr, readElements));
  snapshot.writes.forEach(addr => accumulate(addr, writeElements));
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
  if (!hardware?.memory) {
    clearDataLineHighlights();
    lastDataAccessSnapshot = null;
    return;
  }
  applyDataLineHighlightsFromSnapshot(hardware.memory.snapshotAccessLog());
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

function readMemoryValueForSpan(hardware: Hardware | undefined | null, addr: number, unitBytes: number): number | undefined {
  if (!hardware?.memory) return undefined;
  const normalizedAddr = addr & 0xffff;
  if (unitBytes <= 1) {
    return hardware.memory.GetByte(normalizedAddr, AddrSpace.RAM) & 0xff;
  }
  let value = 0;
  for (let i = 0; i < unitBytes; i++) {
    const byte = hardware.memory.GetByte((normalizedAddr + i) & 0xffff, AddrSpace.RAM) & 0xff;
    value |= byte << (8 * i);
  }
  return value >>> 0;
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
      const existing = map.get(normalizedAddr);
      // Prefer lines with higher line numbers for the same address within the same file,
      // since actual code lines come after labels that share the same address.
      // Across different files, keep the first occurrence.
      if (!existing || (existing.file === resolvedPath && lineNum > existing.line)) {
        map.set(normalizedAddr, { file: resolvedPath, line: lineNum });
      }
    }
  }
  const dataLines = tokens?.dataLines;
  if (dataLines && typeof dataLines === 'object') {
    for (const [fileKeyRaw, entries] of Object.entries(dataLines as Record<string, any>)) {
      if (!entries || typeof entries !== 'object') continue;
      const resolvedPath = path.isAbsolute(fileKeyRaw) ? path.normalize(fileKeyRaw) : path.resolve(baseDir, fileKeyRaw);
      for (const [lineKey, rawSpan] of Object.entries(entries as Record<string, any>)) {
        const start = parseAddressLike((rawSpan as any)?.addr ?? (rawSpan as any)?.start ?? rawSpan);
        const byteLength = Number((rawSpan as any)?.byteLength ?? (rawSpan as any)?.length ?? 0);
        const lineNum = Number(lineKey);
        if (start === undefined || byteLength <= 0 || !Number.isFinite(lineNum)) continue;
        for (let offset = 0; offset < byteLength; offset++) {
          const addr = (start + offset) & 0xffff;
          if (!map.has(addr)) {
            map.set(addr, { file: resolvedPath, line: lineNum });
          }
        }
      }
    }
  }
  return map;
}
