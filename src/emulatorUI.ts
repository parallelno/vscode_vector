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
import { ProjectInfo } from './extention/project_info';
import * as ext_consts from './extention/consts';
import {
  SourceLineRef,
  loadBreakpointsFromToken,
  syncEditorBreakpointsFromHardware,
} from './emulatorUI/breakpoints';
import {
  DataDirectiveHoverInfo,
  InstructionHoverInfo,
  resolveDataDirectiveHoverForMemory,
  resolveInstructionHoverForMemory,
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
import {
  cacheSymbolMetadata,
  clearSymbolMetadataCache,
  getSymbolCache,
  getDataLineSpanCache,
  getDataAddressLookup,
} from './emulatorUI/symbolCache';

export {
  ensureSymbolCacheForDocument,
  resolveSymbolDefinition,
  resolveEmulatorHoverSymbol,
} from './emulatorUI/symbolCache';

// set to true to enable instruction logging to file
const log_tick_to_file = false;

let lastBreakpointSource: {
  absoluteRomPath: string;
  absoluteDebugPath?: string;
  hardware?: Hardware | null;
  log?: vscode.OutputChannel } | null = null;

let lastAddressSourceMap: Map<number, SourceLineRef> | null = null;
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
    panel.webview.postMessage({ type: 'setSpeed', speed: project.settings.Speed });
    emu.hardware?.Request(HardwareReq.OPTIMIZE, { data: project.settings.Speed === 'max' });
  } catch (e) {}
  try {
    panel.webview.postMessage({ type: 'setViewMode', viewMode: project.settings.ViewMode });
    emu.hardware?.Request(HardwareReq.BORDER_FILL, { data: project.settings.ViewMode === 'full' });
  } catch (e) {}
  try {
    panel.webview.postMessage({ type: 'setRamDiskSaveOnRestart', value: project.settings.SaveRamDiskOnRestart });
  } catch (e) {}



  // dispose the Output channel when the panel is closed
  panel.onDidDispose(
    async () => {
      panelDisposed = true;
      try { emu.hardware?.Request(HardwareReq.STOP); } catch (e) {}
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
      try {
        emu.hardware?.Request(HardwareReq.DEBUG_MEM_ACCESS_LOG_RESET);
      } catch (err) {
        /* ignore */
      }
    } else {
      refreshDataLineHighlights(emu.hardware, getDataAddressLookup(), getSymbolCache()?.filePaths);
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
        emu.hardware?.Request(HardwareReq.OPTIMIZE, { data: true });
      } else {
        const parsed = parseFloat(speedValue);
        if (!isNaN(parsed) && parsed > 0) {
          project!.settings.Speed = parsed;
          emu.hardware?.Request(HardwareReq.OPTIMIZE, { data: false });
        }
      }
    }
    else if (msg && msg.type === 'viewModeChange') {
      const viewMode = msg.viewMode;
      if (viewMode === 'full' || viewMode === 'noBorder')
      {
        emu.hardware?.Request(HardwareReq.BORDER_FILL, { data: viewMode === 'full' });
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
      sendFrameToWebview(true);
      try {
        panel.webview.postMessage({ type: 'setSpeed', speed: project!.settings.Speed });
      } catch (e) {}
      try {
        panel.webview.postMessage({ type: 'setViewMode', viewMode: currentViewMode });
        emu.hardware?.Request(HardwareReq.BORDER_FILL, { data: currentViewMode === 'full' });
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
      reapplyDataHighlightsFromCache(getDataAddressLookup(), getSymbolCache()?.filePaths);
    }
  });
  context.subscriptions.push(editorVisibilityDisposable);

  async function tick(log_every_frame: boolean = false)
  {
    let running = true;
    let startTime = 0;
    do {
      emu.hardware?.Request(HardwareReq.EXECUTE_FRAME);
      sendFrameToWebview();

      // logging
      if (log_every_frame){
        printDebugState('hw stats:', emu.hardware!, devectorOutput, panel, false);
      }

      running = emu.hardware?.Request(HardwareReq.IS_RUNNING)['isRunning'] ?? false;

      // throttle to approx real-time, adjusted by emulation speed
      let delay: number = 0; // no delay for max speed
      if (project!.settings.Speed !== 'max')
      {
        const elapsed = performance.now() - startTime;
        startTime = performance.now();
        const targetFrameTime = (1000 / 50) / project!.settings.Speed;
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
    highlightSourceFromHardware(hardware, lastAddressSourceMap, getSymbolCache()?.lineAddresses);
    updateMemoryDumpFromHardware(panel, hardware, 'pc');
    if (!currentToolbarIsRunning) {
      refreshDataLineHighlights(hardware, getDataAddressLookup(), getSymbolCache()?.filePaths);
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

export function resolveDataDirectiveHover(
  document: vscode.TextDocument,
  position: vscode.Position)
  : DataDirectiveHoverInfo | undefined
{
  return resolveDataDirectiveHoverForMemory(
    document,
    position,
    lastBreakpointSource?.hardware,
    currentToolbarIsRunning,
    getDataLineSpanCache()
  );
}