import * as vscode from 'vscode';
import { Hardware } from '../hardware';
import Memory from '../memory';
import { parseAddressLike } from './utils';

const MEMORY_ADDRESS_MASK = 0xffff;
const MEMORY_DUMP_LINE_BYTES = 16;
const MEMORY_DUMP_LINES = 16;
const MEMORY_DUMP_TOTAL_BYTES = MEMORY_DUMP_LINE_BYTES * MEMORY_DUMP_LINES;

let memoryDumpFollowPc = true;
let memoryDumpStartAddr = 0;
let memoryDumpAnchorAddr = 0;

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

export function resetMemoryDumpState(): void {
  memoryDumpFollowPc = true;
  memoryDumpStartAddr = 0;
  memoryDumpAnchorAddr = 0;
}

export function updateMemoryDumpFromHardware(
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

export function handleMemoryDumpControlMessage(
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
