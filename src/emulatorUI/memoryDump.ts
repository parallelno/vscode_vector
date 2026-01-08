import * as vscode from 'vscode';
import { Hardware } from '../emulator/hardware';
import Memory, { AddrSpace } from '../emulator/memory';
import { parseAddressLike } from './utils';
import { HardwareReq } from '../emulator/hardware_reqs';

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


export function resetMemoryDumpState(): void {
  memoryDumpFollowPc = true;
  memoryDumpStartAddr = 0;
  memoryDumpAnchorAddr = 0;
}

export async function updateMemoryDumpFromHardware(
  panel: vscode.WebviewPanel | null,
  hardware: Hardware | undefined | null,
  reason: 'pc' | 'user' = 'pc',
  explicitBase?: number)
{
  if (!panel || !hardware) return;
  let nextBase = memoryDumpStartAddr;
  let anchor = memoryDumpAnchorAddr;

  const cpuResp = await hardware.Request(HardwareReq.GET_CPU_STATE);
  const cpuState = cpuResp["data"];

  if (reason === 'pc' && memoryDumpFollowPc)
  {
    const pc = cpuState.regs.pc.word;
    if (pc !== undefined) {
      anchor = pc;
      nextBase = pc;
    }
  }
  else if (explicitBase !== undefined)
  {
    anchor = explicitBase;
    nextBase = explicitBase;
  }

  memoryDumpAnchorAddr = normalizeMemoryAddress(anchor);
  memoryDumpStartAddr = alignMemoryDumpBase(nextBase);

  let bytes: Uint8Array | undefined = undefined;

  const addrSpace: AddrSpace = AddrSpace.GLOBAL;
  switch (addrSpace) {
    case AddrSpace.GLOBAL:
      const memResp = await hardware.Request(
        HardwareReq.GET_MEM_RANGE, { "addr": memoryDumpStartAddr, "len": MEMORY_DUMP_TOTAL_BYTES });
      bytes = memResp?.["data"] ?? [];
      break;
    // case AddrSpace.RAM:
    //   // TODO: implement RAM space dump
    //   break;
    // case AddrSpace.STACK:
    //   // TODO: implement STACK space dump
    //   break;
    default:
      bytes = new Uint8Array(MEMORY_DUMP_TOTAL_BYTES);
      break;
  }

  try {
    panel.webview.postMessage({
      type: 'memoryDump',
      startAddr: memoryDumpStartAddr,
      bytes,
      pc: cpuState.regs.pc.word,
      followPc: memoryDumpFollowPc,
      anchorAddr: memoryDumpAnchorAddr
    });
  } catch (e) {
    /* ignore memory dump sync errors */
  }
}

export async function handleMemoryDumpControlMessage(
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
      await updateMemoryDumpFromHardware(panel, hardware, 'user', parsed);
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
      await updateMemoryDumpFromHardware(panel, hardware, 'user', target);
      break;
    }
    case 'follow': {
      memoryDumpFollowPc = !!msg.value;
      await updateMemoryDumpFromHardware(panel, hardware, memoryDumpFollowPc ? 'pc' : 'user');
      break;
    }
    case 'refresh': {
      await updateMemoryDumpFromHardware(panel, hardware, memoryDumpFollowPc ? 'pc' : 'user');
      break;
    }
    default:
      break;
  }
}
