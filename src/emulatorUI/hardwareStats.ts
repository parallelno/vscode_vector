import { Hardware } from '../emulator/hardware';
import { FRAME_W } from '../emulator/display';
import Memory, { AddrSpace, MAPPING_MODE_MASK } from '../emulator/memory';
import { CpuState } from '../emulator/cpu_i8080';

const MEMORY_ADDRESS_MASK = 0xffff;
const STACK_SAMPLE_OFFSETS = [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10];
const HW_STATS_FRAME_INTERVAL = 50;

let hwStatsStartTime = Date.now();
let hwStatsLastUpdate: number | null = null;
let hwStatsFrameCountdown = HW_STATS_FRAME_INTERVAL;

const clamp16 = (value: number): number => (Number(value) >>> 0) & MEMORY_ADDRESS_MASK;

type StackEntry = { offset: number; value: number };

export type RamDiskMappingSnapshot = {
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
      stackEntries.push({ offset, value });
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

export function resetHardwareStatsTracking(): void {
  hwStatsStartTime = Date.now();
  hwStatsLastUpdate = null;
  hwStatsFrameCountdown = 0;
}

export function disposeHardwareStatsTracking(): void {
  hwStatsLastUpdate = null;
  hwStatsFrameCountdown = HW_STATS_FRAME_INTERVAL;
}

export function tryCollectHardwareStats(
  hardware: Hardware | undefined | null,
  force = false
): HardwareStatsMessage | null {
  if (!force) {
    hwStatsFrameCountdown--;
    if (hwStatsFrameCountdown > 0) {
      return null;
    }
  }
  hwStatsFrameCountdown = HW_STATS_FRAME_INTERVAL;
  return collectHardwareStats(hardware);
}
