import { Hardware } from '../emulator/hardware';
import { FRAME_W } from '../emulator/display';
import Memory, { AddrSpace, MAPPING_MODE_MASK, MemMapping } from '../emulator/memory';
import { CpuState } from '../emulator/cpu_i8080';
import { HardwareReq } from '../emulator/hardware_reqs';

const MEMORY_ADDRESS_MASK = 0xffff;
const STACK_SAMPLE_OFFSETS = [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10];
const HW_STATS_FRAME_INTERVAL = 50;

let hwStatsStartTime = Date.now();
let hwStatsLastUpdate: number | null = null;
let hwStatsFrameCountdown = HW_STATS_FRAME_INTERVAL;

// TODO: optimize clamp16 usage throughout the codebase
const clamp16 = (value: number): number => (Number(value) >>> 0) & MEMORY_ADDRESS_MASK;

type StackEntry = { offset: number; value: number };

export type HardwareStatsMessage = {
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
      activeMapping: MemMapping | null;
      mappings: MemMapping[];
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

async function collectHardwareStats(hardware: Hardware | undefined | null): Promise<HardwareStatsMessage | null> {
  if (!hardware) return null;

  const hwStats = await hardware.Request(HardwareReq.GET_HW_MAIN_STATS);
  const cpuState: CpuState = hwStats["cpu_state"];

  const now = Date.now();
  const uptimeMs = Math.max(0, now - hwStatsStartTime);
  const deltaMs = hwStatsLastUpdate ? Math.max(0, now - hwStatsLastUpdate) : 0;
  hwStatsLastUpdate = now;

  const stackEntries: StackEntry[] = [];
  const sp = cpuState.regs.sp.word;
  const stack_sample: number[] = (await hardware.Request(HardwareReq.GET_STACK_SAMPLE, { "addr": sp }))["data"];
  // TODO: optimize top use the request result directly without copying
  for (const offset of STACK_SAMPLE_OFFSETS)
  {
    const word: number = stack_sample.shift() ?? 0;
    stackEntries.push({ offset, value: word });
  }
  const mByte = hwStats["m"];

  const rasterPixel = hwStats["rasterPixel"];
  const rasterLine = hwStats["rasterLine"];
  const scrollIdx = hwStats["scrollIdx"];
  const frames = hwStats["frameNum"]
  const frameCc = hwStats["frameCc"];
  const framebufferIdx = frameCc >> 2;


  const displayMode = hwStats["displayMode"] ? '512' : '256';
  const rusLat = hwStats["rusLat"] ?? false;

  const ramDiskState = await hardware.Request(HardwareReq.GET_MEMORY_MAPPINGS);
  const ramdiskIdx = ramDiskState["ramdiskIdx"] as number;
  const ramdiskMappings = ramDiskState["mappings"] as MemMapping[];

  return {
    type: 'hardwareStats',
    timestamp: now,
    uptimeMs,
    deltaMs,
    regs: {
      pc: cpuState.regs.pc.word,
      sp: cpuState.regs.sp.word,
      af: cpuState.regs.af.word,
      bc: cpuState.regs.bc.word,
      de: cpuState.regs.de.word,
      hl: cpuState.regs.hl.word,
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
      cycles: cpuState.cc,
      frames,
      frameCc,
      rasterLine,
      rasterPixel,
      // TODO: check if it is useful to have both frameCc and framebufferIdx
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
        activeMapping: ramdiskMappings[ramdiskIdx],
        mappings: ramdiskMappings
      },
      fdc: {
        available: false
      }
    }
  };
}

export function resetHardwareStatsTracking(): void {
  hwStatsStartTime = Date.now();
  hwStatsLastUpdate = null;
  hwStatsFrameCountdown = 0;
}

export function disposeHardwareStatsTracking(): void {
  hwStatsLastUpdate = null;
  hwStatsFrameCountdown = HW_STATS_FRAME_INTERVAL;
}

export async function tryCollectHardwareStats(
  hardware: Hardware | undefined | null,
  force = false
): Promise<HardwareStatsMessage | null> {
  if (!force) {
    hwStatsFrameCountdown--;
    if (hwStatsFrameCountdown > 0) {
      return null;
    }
  }
  hwStatsFrameCountdown = HW_STATS_FRAME_INTERVAL;
  return collectHardwareStats(hardware);
}
