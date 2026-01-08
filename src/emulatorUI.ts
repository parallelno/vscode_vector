import * as vscode from 'vscode';
import { Emulator } from './emulator';
import * as path from 'path';
import * as fs from 'fs';
import { Hardware } from './emulator/hardware';
import { HardwareReq } from './emulator/hardware_reqs';
import { ACTIVE_AREA_H, ACTIVE_AREA_W, BORDER_LEFT, FRAME_H, FRAME_W, SCAN_ACTIVE_AREA_TOP } from './emulator/display';
import { getWebviewContent } from './emulatorUI/webviewContent';
import { getDebugLine } from './emulatorUI/debugOutput';
import { handleMemoryDumpControlMessage, resetMemoryDumpState, updateMemoryDumpFromHardware } from './emulatorUI/memoryDump';
import { disposeHardwareStatsTracking, resetHardwareStatsTracking, tryCollectHardwareStats } from './emulatorUI/hardwareStats';
import { parseAddressLike } from './emulatorUI/utils';
import { ProjectInfo } from './extention/project_info';
import { DEBUG_FILE_SUFFIX } from './extention/consts';
import * as ext_consts from './extention/consts';
import {
  SourceLineRef,
  loadBreakpointsFromToken,
  syncEditorBreakpointsFromHardware,
  normalizeFileKey,
  formatFileLineKey,
  coerceAddressList,
  setNormalizeFileKeyProjectDir,
} from './emulatorUI/breakpoints';
import {
  DataAddressEntry,
  DataDirectiveHoverInfo,
  DataLineSpan,
  HoverSymbolInfo,
  InstructionHoverInfo,
  resolveDataDirectiveHoverForMemory,
  resolveInstructionHoverForMemory,
  resolveHoverSymbol,
} from './emulatorUI/hover';
import {
  clearDataLineHighlights,
  clearHighlightedSourceLine,
  highlightSourceFromHardware,
  reapplyDataHighlightsFromCache,
  reapplyExecutionHighlight,
  refreshDataLineHighlights,
  setHighlightContext,
} from './emulatorUI/highlight';

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
  projectDir?: string;
};

type DataLineCache = Map<string, Map<number, DataLineSpan>>;

let lastSymbolCache: SymbolCache | null = null;
let dataLineSpanCache: DataLineCache | null = null;
let dataAddressLookup: Map<number, DataAddressEntry> | null = null;
let currentToolbarIsRunning = true;

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
  getProjectInfo: () => ProjectInfo | undefined;
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
  setHighlightContext(context);
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

  const emu = await Emulator.create(context.extensionPath, project);
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
    panel.webview.postMessage({ type: 'setSpeed', speed: project.settings.Speed });
  } catch (e) {}
  try {
    panel.webview.postMessage({ type: 'setViewMode', viewMode: project.settings.ViewMode });
  } catch (e) {}
  try {
    panel.webview.postMessage({ type: 'setRamDiskSaveOnRestart', value: project.settings.SaveRamDiskOnRestart });
  } catch (e) {}



  // dispose the Output channel when the panel is closed
  panel.onDidDispose(
    async () => {
      panelDisposed = true;
      try { await emu.hardware?.Request(HardwareReq.STOP); } catch (e) {}
      if (emu.hardware) {
        // Save the RAM Disk
        if (project && project.settings && project.settings.SaveRamDiskOnRestart)
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
                  project!.settings.RamDiskPath = path.relative(project!.projectDir!, saveUri.fsPath);
                  project!.save();
              }
            }
          }
          // Save the RAM Disk to file
          await emu.SaveRamDisk();
        }
        try { await emu.Destructor(); } catch (e) {}
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
      clearSymbolMetadataCache();
      setHighlightContext(null);
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

  const sendHardwareStats = async (force: boolean = false) => {
    const snapshot = await tryCollectHardwareStats(emu.hardware, force);

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
  const sendFrameToWebview = async (forceStats: boolean = false) => {
    if (emu.hardware){
      try {
        // TODO: implement vsync handling if needed
        const sync = false;
        const fullFrame = (await emu.hardware.Request(HardwareReq.GET_FRAME, {"vsync": sync}))["data"];

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
    await sendHardwareStats(forceStats);
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
      try {
        emu.hardware?.Request(HardwareReq.DEBUG_MEM_ACCESS_LOG_RESET);
      } catch (err) {
        /* ignore */
      }
    } else {
      refreshDataLineHighlights(emu.hardware, dataAddressLookup, lastSymbolCache?.filePaths);
    }
  };

  const syncToolbarState = () => {
    postToolbarState(currentToolbarIsRunning);
  };

  const handleDebugAction = async (action?: DebugAction) => {
    if (!action || !emu.hardware) return;
    switch (action) {
    case 'pause':
        await emu.hardware.Request(HardwareReq.STOP);
        await sendFrameToWebview(true);
        printDebugState('Pause:', emu.hardware, devectorOutput, panel);
        syncEditorBreakpointsFromHardware(emu.hardware, lastAddressSourceMap);
        emitToolbarState(false);
        break;

      case 'run':
        await emu.hardware.Request(HardwareReq.RUN);
        emitToolbarState(true);
        tick();
        break;

      case 'stepInto':
        await emu.hardware.Request(HardwareReq.STOP);
        await emu.hardware?.Request(HardwareReq.EXECUTE_INSTR);
        await sendFrameToWebview(true);
        printDebugState('Step into:', emu.hardware, devectorOutput, panel);
        break;

      case 'stepOver':
        await emu.hardware.Request(HardwareReq.STOP);
        const addr = (await emu.hardware.Request(HardwareReq.GET_STEP_OVER_ADDR))['data'];
        await emu.hardware.Request(HardwareReq.DEBUG_BREAKPOINT_ADD, { addr: addr, autoDel: true });
        printDebugState('Step over:', emu.hardware, devectorOutput, panel);
        await emu.hardware.Request(HardwareReq.RUN);
        emitToolbarState(true);
        tick();
        break;

      case 'stepOut':
        await emu.hardware.Request(HardwareReq.STOP);
        // TODO: implement proper step out
        await emu.hardware?.Request(HardwareReq.EXECUTE_INSTR);
        await sendFrameToWebview(true);
        printDebugState('Step out (NOT IMPLEMENTED):', emu.hardware, devectorOutput, panel);
        break;

      case 'stepFrame':
        await emu.hardware.Request(HardwareReq.STOP);
        await emu.hardware.Request(HardwareReq.EXECUTE_FRAME_NO_BREAKS);
        await sendFrameToWebview(true);
        printDebugState('Run frame:', emu.hardware, devectorOutput, panel);
        emitToolbarState(false);
        break;

      case 'step256':
        await emu.hardware.Request(HardwareReq.STOP);
        for (let i = 0; i < 256; i++) {
          await emu.hardware.Request(HardwareReq.EXECUTE_INSTR);
        }
        await sendFrameToWebview(true);
        printDebugState('Step 256:', emu.hardware, devectorOutput, panel);
        break;

      case 'restart':
        await emu.hardware.Request(HardwareReq.STOP);
        await emu.hardware.Request(HardwareReq.RESET);
        await emu.hardware.Request(HardwareReq.RESTART);
        await emu.Load();
        await emu.hardware.Request(HardwareReq.RUN);
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
    },
    getProjectInfo: () => {
      return project;
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
        project!.settings.Speed = 'max';
      } else {
        const parsed = parseFloat(speedValue);
        if (!isNaN(parsed) && parsed > 0) {
          project!.settings.Speed = parsed;
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
      project!.settings.SaveRamDiskOnRestart = enable;
    }
  }, undefined, context.subscriptions);

  panel.onDidChangeViewState(() => {
    if (panel.visible) {
      syncToolbarState();
      // Re-send the current frame to the webview to restore canvas content
      // that may have been discarded while the tab was hidden
      sendFrameToWebview();
      try {
        panel.webview.postMessage({ type: 'setSpeed', speed: project!.settings.Speed });
      } catch (e) {}
      try {
        panel.webview.postMessage({ type: 'setViewMode', viewMode: currentViewMode });
      } catch (e) {}
      try {
        panel.webview.postMessage({ type: 'setRamDiskSaveOnRestart', value: project!.settings.SaveRamDiskOnRestart });
      } catch (e) {}
    }
  }, null, context.subscriptions);

  const editorVisibilityDisposable = vscode.window.onDidChangeVisibleTextEditors(() => {
    if (!currentToolbarIsRunning) {
      // Reapply execution highlight when editor visibility changes
      reapplyExecutionHighlight(currentToolbarIsRunning);
      // Reapply data line highlights (reads/writes)
      reapplyDataHighlightsFromCache(dataAddressLookup, lastSymbolCache?.filePaths);
    }
  });
  context.subscriptions.push(editorVisibilityDisposable);

  async function tick(log_every_frame: boolean = false)
  {
    let running = true;

    do {
      let startTime = performance.now();

      await emu.hardware?.Request(HardwareReq.EXECUTE_FRAME);
      await sendFrameToWebview();

      // logging
      if (log_every_frame){
        printDebugState('hw stats:', emu.hardware!, devectorOutput, panel, false);
      }

      const runningResp = await emu.hardware?.Request(HardwareReq.IS_RUNNING);
      running = runningResp?.['isRunning'] ?? false;

      // throttle to approx real-time, adjusted by emulation speed
      const elapsed = performance.now() - startTime;
      let delay: number;
      if (project!.settings.Speed === 'max') {
        delay = 0; // no delay for max speed
      } else {
        const targetFrameTime = (1000 / 60) / project!.settings.Speed;
        delay = Math.max(0, targetFrameTime - elapsed);
      }
      await new Promise(resolve => setTimeout(resolve, delay));

    } while (running && !panelDisposed);

    // If the panel is gone, skip post-break work
    if (panelDisposed) return;

    // Force hardware stats update (bypassing throttle) when breaking to
    // ensure Register panel is synchronized
    await sendFrameToWebview(true);
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
    highlightSourceFromHardware(hardware, lastAddressSourceMap, lastSymbolCache?.lineAddresses);
    updateMemoryDumpFromHardware(panel, hardware, 'pc');
    if (!currentToolbarIsRunning) {
      refreshDataLineHighlights(hardware, dataAddressLookup, lastSymbolCache?.filePaths);
    }
  }
}

export function pauseEmulatorPanel() {
  if (currentPanelController) currentPanelController.pause();
}

export function resumeEmulatorPanel() {
  if (currentPanelController) currentPanelController.resume();
}

export function stepFramePanel() {
  if (currentPanelController && currentPanelController.stepFrame) {
    currentPanelController.stepFrame();
  }
}

export function performEmulatorDebugAction(action: DebugAction): boolean {
  if (currentPanelController) {
    currentPanelController.performDebugAction(action);
    return true;
  }
  return false;
}

export function stopAndCloseEmulatorPanel(): void {
  if (currentPanelController) {
    currentPanelController.stopAndClose();
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


export function resolveInstructionHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  address: number)
  : InstructionHoverInfo | undefined
{
  return resolveInstructionHoverForMemory(lastBreakpointSource?.hardware, document, position, address, currentToolbarIsRunning);
}

export function resolveEmulatorHoverSymbol(identifier: string, location?: { filePath?: string; line?: number }): HoverSymbolInfo | undefined {
  return resolveHoverSymbol(identifier, location, lastSymbolCache);
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

export function isEmulatorRunning(): boolean {
  return !!currentPanelController && currentToolbarIsRunning;
}

export function getRunningProjectInfo(): ProjectInfo | undefined {
  return currentPanelController?.getProjectInfo();
}

export function getActiveHardware(): Hardware | undefined {
  return lastBreakpointSource?.hardware ?? undefined;
}

export function resolveDataDirectiveHover(document: vscode.TextDocument, position: vscode.Position): DataDirectiveHoverInfo | undefined {
  return resolveDataDirectiveHoverForMemory(
    document,
    position,
    lastBreakpointSource?.hardware,
    currentToolbarIsRunning,
    dataLineSpanCache
  );
}

function resolveProjectDirFromTokens(tokens: any, tokenPath?: string): string | undefined {
  const projectDirRaw = typeof tokens?.projectDir === 'string' ? tokens.projectDir : undefined;
  if (projectDirRaw) {
    if (path.isAbsolute(projectDirRaw)) return path.normalize(projectDirRaw);
    if (tokenPath) return path.resolve(path.dirname(tokenPath), projectDirRaw);
    const workspaceDir = process.cwd();
    return path.normalize(path.resolve(workspaceDir, projectDirRaw));
  }
  const projectFile = typeof tokens?.projectFile === 'string' ? tokens.projectFile : undefined;
  if (projectFile) {
    const resolved = path.isAbsolute(projectFile)
      ? path.normalize(projectFile)
      : tokenPath ? path.resolve(path.dirname(tokenPath), projectFile) : path.resolve(process.cwd(), projectFile);
    return path.dirname(resolved);
  }
  return tokenPath ? path.dirname(tokenPath) : undefined;
}

function resolveTokenFileReference(tokenPath: string | undefined, fileKey: string, projectDir?: string): string {
  if (!fileKey) return fileKey;
  if (path.isAbsolute(fileKey)) return path.normalize(fileKey);
  const baseDir = projectDir || (tokenPath ? path.dirname(tokenPath) : process.cwd());
  return path.normalize(path.resolve(baseDir, fileKey));
}

function clearSymbolMetadataCache() {
  lastSymbolCache = null;
  dataLineSpanCache = null;
  dataAddressLookup = null;
  setNormalizeFileKeyProjectDir(undefined);
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
  const projectDir = resolveProjectDirFromTokens(tokens, tokenPath);

  setNormalizeFileKeyProjectDir(projectDir);
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
      const srcKey = normalizeFileKey(info?.src, projectDir);
      const lineNum = typeof info?.line === 'number' ? info.line : undefined;
      const source: SymbolSource | undefined = (srcKey && lineNum) ? { fileKey: srcKey, line: lineNum } : undefined;
      if (srcKey && info?.src) {
        const resolvedPath = resolveTokenFileReference(tokenPath, info.src, projectDir);
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
        const srcKey = normalizeFileKey(rawValue.src, projectDir);
        const lineNum = typeof rawValue.line === 'number' ? rawValue.line : undefined;
        if (srcKey && lineNum) {
          source = { fileKey: srcKey, line: lineNum };
          if (rawValue.src) {
            const resolvedPath = resolveTokenFileReference(tokenPath, rawValue.src, projectDir);
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
      const normalizedKey = normalizeFileKey(fileKeyRaw, projectDir);
      if (!normalizedKey) continue;
      const resolvedPath = resolveTokenFileReference(tokenPath, fileKeyRaw, projectDir);
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
      const normalizedKey = normalizeFileKey(fileKeyRaw, projectDir);
      if (!normalizedKey) continue;
      const resolvedPath = resolveTokenFileReference(tokenPath, fileKeyRaw, projectDir);
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

  lastSymbolCache = { byName, byLowerCase, lineAddresses, filePaths, projectDir };
  dataLineSpanCache = dataLines.size ? dataLines : null;
  dataAddressLookup = addressLookup.size ? addressLookup : null;
}
