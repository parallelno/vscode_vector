import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as ext_utils from './utils';
import * as ext_prg from './project';
import { collectIncludeFiles } from '../assembler/includes';
import { ProjectInfo } from './project_info';
import { HardwareReq } from '../emulator/hardware_reqs';
import { getActiveHardware, getRunningProjectInfo } from '../emulatorUI';
import { Hardware } from '../emulator/hardware';
import { ROM_LOAD_ADDR } from '../emulator/memory';

const LABEL_SEARCH_RADIUS = 100;
const PC_MASK = 0xffff;


type ExecutionSnapshot = {
  pc: number | undefined;
  nearbyLabels: Array<{ name: string; addr: number; distance: number }>;
  oldDebugData: any;
};


// Register the ROM hot reload feature in the extension
export function registerRomHotReload(
  context: vscode.ExtensionContext,
  devectorOutput: vscode.OutputChannel)
{
  let romHotReloadPromise: Promise<void> = Promise.resolve();

  const disposable = vscode.workspace.onDidSaveTextDocument((doc) => {
    const projectInfo = getRunningProjectInfo();
    if (!projectInfo) return;
    if (doc.isUntitled) return;
    if (doc.uri.scheme !== 'file') return;
    const ext = path.extname(doc.fileName).toLowerCase();
    if (ext !== '.asm') return;
    const savedPath = doc.uri.fsPath;
    romHotReloadPromise = romHotReloadPromise.then(async () => {
      await handleRomHotReload(devectorOutput, savedPath, projectInfo);
    }).catch((err) => {
      ext_utils.logOutput(
        devectorOutput,
        'Devector: ROM hot reload failed: ' +
        (err instanceof Error ? err.message : String(err)));
    });
  });

  context.subscriptions.push(disposable);
}


// Handle ROM hot reload when a source file is saved
async function handleRomHotReload(
  devectorOutput: vscode.OutputChannel,
  savedPath: string,
  project: ProjectInfo | undefined)
{
  if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) return;
  const normalizedTarget = ext_utils.normalizeFsPath(savedPath);
  if (!project?.settings.RomHotReload) return;
  const mainAsm = project.absolute_asm_path;
  if (!mainAsm || !fs.existsSync(mainAsm)) return;

  let source: string;
  try {
    source = fs.readFileSync(mainAsm!, 'utf8');
  } catch (err) {
    ext_utils.logOutput(
      devectorOutput,
      `Devector: ROM hot reload skipped for ${project.name}: ` +
      (err instanceof Error ? err.message : String(err)));
    return;
  }

  let includes: Set<string>;
  try {
    includes = collectIncludeFiles(source, mainAsm!, mainAsm!, project.absolute_path);
  } catch (err) {
    ext_utils.logOutput(
      devectorOutput,
      `Devector: ROM hot reload include scan failed for ${project.name}: ` +
      (err instanceof Error ? err.message : String(err)));
    return;
  }
  includes.add(mainAsm!);
  const normalizedIncludes = new Set(Array.from(includes).map(ext_utils.normalizeFsPath));
  if (!normalizedIncludes.has(normalizedTarget)) return;

  await performRomHotReload(devectorOutput, project);
}


// Main function to perform ROM hot reload
async function performRomHotReload(
  devectorOutput: vscode.OutputChannel,
  project: ProjectInfo)
{
  const romPath = project.absolute_rom_path;
  if (!romPath) {
    ext_utils.logOutput(devectorOutput, `Devector: ROM hot reload skipped for ${project.name}: ROM path is not set`);
    return;
  }

  ext_utils.logOutput(devectorOutput, `Devector: ROM hot reload triggered for ${project.name}`);

  const snapshot = captureExecutionSnapshot(devectorOutput, project);

  let oldRom = new Uint8Array();
  if (fs.existsSync(romPath)) {
    try {
      ext_utils.logOutput(devectorOutput, `Devector: Reading existing ROM from ${romPath} for comparison`);
      oldRom = fs.readFileSync(romPath);
    } catch (err) {
      ext_utils.logOutput(
        devectorOutput,
        `Devector: Failed to read existing ROM for ${project.name}: ` +
        (err instanceof Error ? err.message : String(err)));
      return;
    }
  } else {
    ext_utils.logOutput(devectorOutput, `Devector: No existing ROM found for ${project.name}; treating as empty before rebuild`);
  }

  ext_utils.logOutput(devectorOutput, 'Devector: Compiling updated ROM for hot reload...');
  const compiled = await ext_prg.compileProjectFile(devectorOutput, project, {
    silent: true,
    reason: 'ROM hot reload',
    includeDependencies: false,
    skipMain: false,
  });
  if (!compiled) {
    ext_utils.logOutput(devectorOutput, `Devector: ROM hot reload skipped for ${project.name}: compilation failed`);
    return;
  }
  if (!fs.existsSync(romPath)) {
    ext_utils.logOutput(devectorOutput, `Devector: ROM hot reload skipped: compiled ROM not found at ${romPath}`);
    return;
  }

  let newRom: Uint8Array;
  try {
    newRom = fs.readFileSync(romPath);
  } catch (err) {
    ext_utils.logOutput(
      devectorOutput,
      `Devector: Failed to read compiled ROM for ${project.name}: ` +
      (err instanceof Error ? err.message : String(err)));
    return;
  }

  // stop emulation
  const hardware = getActiveHardware();
  if (!hardware) {
    ext_utils.logOutput(devectorOutput, `Devector: ROM hot reload skipped for ${project.name}: hardware not available`);
    return;
  }
  const wasRunning = hardware.Request(HardwareReq.IS_RUNNING).isRunning ?? false;
  if (wasRunning) {
    hardware.Request(HardwareReq.STOP);
  }

  ext_utils.logOutput(devectorOutput, 'Devector: Comparing ROM images and applying diff...');
  const result = applyRomDiffToActiveHardware(oldRom, newRom, devectorOutput, hardware);
  if (result.patched === 0) {
    ext_utils.logOutput(devectorOutput, `Devector: ROM hot reload found no differences to apply for ${project.name}`);
  } else {
    ext_utils.logOutput(
      devectorOutput,
      `Devector: ROM hot reload applied ${result.patched} diff chunk(s), ${result.bytes} byte(s) updated for ${project.name}`);
  }

  adjustPcAfterReload(devectorOutput, project, snapshot);

  if (wasRunning) {
    hardware.Request(HardwareReq.RUN);
  }
}



// Capture the current execution state snapshot before ROM hot reload
function captureExecutionSnapshot(
  devectorOutput: vscode.OutputChannel,
  project: ProjectInfo)
: ExecutionSnapshot
{
  const snapshot: ExecutionSnapshot = {
    pc: undefined,
    nearbyLabels: [],
    oldDebugData: null
  };

  const projectInfo = getRunningProjectInfo();
  if (projectInfo && projectInfo.absolute_path === project.absolute_path) {
    try {
      const hardware = getActiveHardware();
      if (hardware) {
        const pcResult = hardware.Request(HardwareReq.GET_REG_PC);
        if (pcResult && typeof pcResult.pc === 'number') {
          snapshot.pc = pcResult.pc;
          ext_utils.logOutput(devectorOutput, `Devector: Captured PC = 0x${snapshot.pc.toString(16).toUpperCase()}`);
        }
      }
    } catch (err) {
      ext_utils.logOutput(devectorOutput, `Devector: Failed to capture PC: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (snapshot.pc !== undefined) {
    const debugPath = project.absolute_debug_path;
    if (debugPath && fs.existsSync(debugPath)) {
      try {
        const debugText = fs.readFileSync(debugPath, 'utf8');
        snapshot.oldDebugData = JSON.parse(debugText);

        if (snapshot.oldDebugData?.labels) {
          const labels = snapshot.oldDebugData.labels;
          for (const [name, info] of Object.entries(labels)) {
            const labelInfo = info as any;
            let addr: number | undefined;
            if (typeof labelInfo === 'number') {
              addr = labelInfo;
            } else if (typeof labelInfo?.addr === 'string') {
              addr = parseInt(labelInfo.addr, 16);
            } else if (typeof labelInfo?.addr === 'number') {
              addr = labelInfo.addr;
            }

            if (addr !== undefined && !isNaN(addr)) {
              const distance = Math.abs(addr - snapshot.pc);
              if (distance <= LABEL_SEARCH_RADIUS) {
                snapshot.nearbyLabels.push({ name, addr, distance });
              }
            }
          }

          snapshot.nearbyLabels.sort((a, b) => a.distance - b.distance);

          if (snapshot.nearbyLabels.length > 0) {
            ext_utils.logOutput(devectorOutput,
              `Devector: Found ${snapshot.nearbyLabels.length} nearby label(s): ${snapshot.nearbyLabels.map(l => l.name).join(', ')}`);
          }
        }
      } catch (err) {
        ext_utils.logOutput(devectorOutput,
          `Devector: Failed to load old debug metadata: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return snapshot;
}


// Apply a ROM diff by sending memory write requests to the active hardware.
// Returns the number of patched chunks and total bytes patched.
// It assumes the emulator is paused.
export function applyRomDiffToActiveHardware(
  oldRom: Uint8Array,
  newRom: Uint8Array,
  logChannel?: vscode.OutputChannel,
  hardware?: Hardware)
: { patched: number; bytes: number }
{
  if (!hardware) {
    return { patched: 0, bytes: 0 };
  }

  const maxLen = Math.max(oldRom.length, newRom.length);
  let patched = 0;
  let bytes = 0;
  let offset = 0;

  while (offset < maxLen) {
    const oldByte = offset < oldRom.length ? oldRom[offset] : 0;
    const newByte = offset < newRom.length ? newRom[offset] : 0;
    if (oldByte === newByte) {
      offset++;
      continue;
    }

    const start = offset;
    const chunk: number[] = [];
    while (offset < maxLen) {
      const o = offset < oldRom.length ? oldRom[offset] : 0;
      const n = offset < newRom.length ? newRom[offset] : 0;
      if (o === n) break;
      chunk.push(n);
      offset++;
    }

    if (chunk.length) {
      const payload = new Uint8Array(chunk);
      hardware.Request(HardwareReq.SET_MEM, { addr: ROM_LOAD_ADDR + start, data: payload });
      if (logChannel) {
        const addrLabel = '0x' + (ROM_LOAD_ADDR + start).toString(16).toUpperCase();
        logChannel.appendLine(`Devector: Applying ROM diff at ${addrLabel} (${payload.length} byte(s))`);
      }
      patched++;
      bytes += payload.length;
    }
  }
  return { patched, bytes };
}


// Adjust the PC register based on label address changes after ROM hot reload
function adjustPcAfterReload(
  devectorOutput: vscode.OutputChannel,
  project: ProjectInfo,
  snapshot: ExecutionSnapshot)
{
  if (snapshot.pc === undefined || snapshot.nearbyLabels.length === 0) {
    return;
  }

  const debugPath = project.absolute_debug_path;
  if (!debugPath || !fs.existsSync(debugPath)) {
    ext_utils.logOutput(devectorOutput, 'Devector: Cannot adjust PC: new debug metadata not found');
    return;
  }

  let newDebugData: any;
  try {
    const debugText = fs.readFileSync(debugPath, 'utf8');
    newDebugData = JSON.parse(debugText);
  } catch (err) {
    ext_utils.logOutput(devectorOutput,
      `Devector: Failed to load new debug metadata for PC adjustment: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (!newDebugData?.labels) {
    ext_utils.logOutput(devectorOutput, 'Devector: No labels in new debug metadata for PC adjustment');
    return;
  }

  for (const oldLabel of snapshot.nearbyLabels) {
    const newLabelInfo = newDebugData.labels[oldLabel.name];
    if (!newLabelInfo) {
      continue;
    }

    let newAddr: number | undefined;
    if (typeof newLabelInfo === 'number') {
      newAddr = newLabelInfo;
    } else if (typeof newLabelInfo?.addr === 'string') {
      newAddr = parseInt(newLabelInfo.addr, 16);
    } else if (typeof newLabelInfo?.addr === 'number') {
      newAddr = newLabelInfo.addr;
    }

    if (newAddr === undefined || isNaN(newAddr)) {
      continue;
    }

    const oldAddr = oldLabel.addr;
    const shift = newAddr - oldAddr;

    if (shift === 0) {
      ext_utils.logOutput(devectorOutput,
        `Devector: No PC adjustment needed (label '${oldLabel.name}' address unchanged)`);
      return;
    }

    const oldPc = snapshot.pc;
    const newPc = (oldPc + shift) & PC_MASK;

    ext_utils.logOutput(devectorOutput,
      `Devector: Adjusting PC based on label '${oldLabel.name}': 0x${oldAddr.toString(16).toUpperCase()} -> 0x${newAddr.toString(16).toUpperCase()} (shift: ${shift >= 0 ? '+' : ''}${shift})`);
    ext_utils.logOutput(devectorOutput,
      `Devector: Updating PC: 0x${oldPc.toString(16).toUpperCase()} -> 0x${newPc.toString(16).toUpperCase()}`);

    try {
      const hardware = getActiveHardware();
      if (hardware) {
        hardware.Request(HardwareReq.SET_REG_PC, { pc: newPc });

        const verifyResult = hardware.Request(HardwareReq.GET_REG_PC);
        if (verifyResult && verifyResult.pc === newPc) {
          ext_utils.logOutput(devectorOutput, 'Devector: PC register updated successfully');
        } else {
          ext_utils.logOutput(devectorOutput,
            `Devector: Warning: PC verification mismatch. Expected 0x${newPc.toString(16).toUpperCase()}, got 0x${verifyResult?.pc?.toString(16).toUpperCase() ?? 'undefined'}`);
        }
      } else {
        ext_utils.logOutput(devectorOutput, 'Devector: Cannot adjust PC: hardware not available');
      }
    } catch (err) {
      ext_utils.logOutput(devectorOutput,
        `Devector: Failed to update PC register: ${err instanceof Error ? err.message : String(err)}`);
    }

    return;
  }

  ext_utils.logOutput(devectorOutput,
    'Devector: No matching labels found in new debug metadata for PC adjustment');
}