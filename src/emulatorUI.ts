import * as vscode from 'vscode';
import { Emulator } from './emulator';
import * as path from 'path';
import * as fs from 'fs';
import { Hardware } from './emulator/hardware';
import { HardwareReq } from './emulator/hardware_reqs';
import { FRAME_H, FRAME_LEN, FRAME_W } from './emulator/display';
import Memory, { AddrSpace, MAPPING_MODE_MASK, MemoryAccessSnapshot } from './emulator/memory';
import CPU, { CpuState } from './emulator/cpu_i8080';
import { getWebviewContent } from './emulatorUI/webviewContent';
import { getDebugLine, getDebugState } from './emulatorUI/debugOutput';
import { handleMemoryDumpControlMessage, resetMemoryDumpState, updateMemoryDumpFromHardware } from './emulatorUI/memoryDump';
import { disposeHardwareStatsTracking, resetHardwareStatsTracking, tryCollectHardwareStats } from './emulatorUI/hardwareStats';
import { parseAddressLike } from './emulatorUI/utils';
import { KbOperation } from './emulator/keyboard';

const log_every_frame = false;
const log_tick_to_file = false;

type SourceLineRef = { file: string; line: number };

let lastBreakpointSource: { romPath: string; hardware?: Hardware | null; log?: vscode.OutputChannel } | null = null;
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
let lastHighlightedEditor: vscode.TextEditor | null = null;
let lastHighlightAddress: number | undefined = undefined;
let lastHighlightDebugLine: string | undefined = undefined;
let currentToolbarIsRunning = true;
let dataReadDecoration: vscode.TextEditorDecorationType | null = null;
let dataWriteDecoration: vscode.TextEditorDecorationType | null = null;
let lastDataAccessSnapshot: MemoryAccessSnapshot | null = null;

let currentPanelController: { pause: () => void; resume: () => void; stepFrame: () => void; } | null = null;


type OpenEmulatorOptions = { romPath?: string };

export async function openEmulatorPanel(context: vscode.ExtensionContext, logChannel?: vscode.OutputChannel, options?: OpenEmulatorOptions)
{
  const pickRomFromDialog = async (): Promise<string> => {
    const defaultUri = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
      ? vscode.Uri.file(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'test.rom'))
      : undefined;
    const candidates = await vscode.window.showOpenDialog({
      canSelectMany: false,
      defaultUri,
      filters: { 'ROM': ['rom', 'bin', '*'] }
    });
    return candidates && candidates.length ? candidates[0].fsPath : '';
  };

  let romPath = (options?.romPath || '').trim();
  if (!romPath) {
    romPath = await pickRomFromDialog();
  }

  if (!romPath) {
    vscode.window.showWarningMessage('ROM selection cancelled. Emulator not started.');
    return;
  }

  if (!fs.existsSync(romPath)) {
    vscode.window.showErrorMessage(`ROM file not found: ${romPath}`);
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
    const out = emu.hardware?.display?.GetFrame() || new Uint32Array(FRAME_LEN);
    try {
      panel.webview.postMessage({ type: 'frame', width: FRAME_W, height: FRAME_H, data: out.buffer });
    }
    catch (e) { /* ignore frame conversion errors */ }
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
      // Clear saved highlight state when resuming
      lastHighlightAddress = undefined;
      lastHighlightDebugLine = undefined;
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
    }
  }, undefined, context.subscriptions);

  panel.onDidChangeViewState(() => {
    if (panel.visible) {
      syncToolbarState();
      // Re-send the current frame to the webview to restore canvas content
      // that may have been discarded while the tab was hidden
      sendFrameToWebview();
    }
  }, null, context.subscriptions);

  const editorVisibilityDisposable = vscode.window.onDidChangeVisibleTextEditors(() => {
    if (!currentToolbarIsRunning) {
      // Reapply paused line highlight when editors become visible again
      reapplyPausedLineHighlight();
      // Also reapply data line highlights if available
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

      // throttle to approx real-time
      const elapsed = performance.now() - startTime;
      if (elapsed < 1000/60) {
        await new Promise(resolve => setTimeout(resolve, 1000/60 - elapsed));
      }

    } while (running);

    // Force hardware stats update (bypassing throttle) when breaking to ensure Register panel is synchronized
    sendFrameToWebview(true);
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
    // Clear saved highlight state on panel disposal
    lastHighlightAddress = undefined;
    lastHighlightDebugLine = undefined;
    lastAddressSourceMap = null;
    clearDataLineHighlights();
    lastDataAccessSnapshot = null;
    clearSymbolMetadataCache();
    highlightContext = null;
    resetMemoryDumpState();
    disposeHardwareStatsTracking();
  }, null, context.subscriptions);
}

export function reloadEmulatorBreakpointsFromFile(): number {
  if (!lastBreakpointSource) return 0;
  return loadBreakpointsFromToken(lastBreakpointSource.romPath, lastBreakpointSource.hardware, lastBreakpointSource.log);
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


function loadBreakpointsFromToken(romPath: string, hardware: Hardware | undefined | null, log?: vscode.OutputChannel): number {
  lastAddressSourceMap = null;
  clearSymbolMetadataCache();
  if (!hardware || !romPath) return 0;
  const tokenPath = deriveTokenPath(romPath);
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
  // NOTE: We intentionally do NOT clear lastHighlightAddress and lastHighlightDebugLine here
  // because they are used to restore the highlight when editors change visibility.
  // They are cleared explicitly when the emulator resumes or when the panel is disposed.
}

function reapplyPausedLineHighlight() {
  // Reapply the paused line highlight if we have saved state
  if (lastHighlightAddress !== undefined && !currentToolbarIsRunning) {
    highlightSourceAddress(lastHighlightAddress, lastHighlightDebugLine);
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
    highlightSourceAddress(state.global_addr, debugLine);
  } catch (e) {
    /* ignore highlight errors */
  }
}

function highlightSourceAddress(addr?: number, debugLine?: string) {
  if (!highlightContext || addr === undefined || addr === null) return;
  ensureHighlightDecoration(highlightContext);
  if (!pausedLineDecoration || !lastAddressSourceMap || lastAddressSourceMap.size === 0) return;
  const normalizedAddr = addr & 0xffff;
  const info = lastAddressSourceMap.get(normalizedAddr);
  if (!info) return;
  
  // Save the highlight state for restoration when editors change visibility
  lastHighlightAddress = normalizedAddr;
  lastHighlightDebugLine = debugLine;
  
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
