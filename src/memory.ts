export enum AddrSpace { RAM = 0, STACK = 1 }

export const ROM_LOAD_ADDR = 0x0100;
export const MEM_64K = 64 * 1024;
export const RAM_DISK_PAGE_LEN = MEM_64K;
export const RAMDISK_PAGES_MAX = 4;
export const MEMORY_RAMDISK_LEN = RAMDISK_PAGES_MAX * MEM_64K;
export const RAM_DISK_MAX = 8;

export const MEMORY_MAIN_LEN = MEM_64K;
export const MEMORY_GLOBAL_LEN = MEMORY_MAIN_LEN + MEMORY_RAMDISK_LEN * RAM_DISK_MAX;

export const MAPPING_MODE_MASK = 0b11110000;

export type Mapping = {
  data: number; // 8-bit mapping control
  modeRam8: boolean;
  modeRamA: boolean;
  modeRamE: boolean;
  modeStack: boolean;
  pageRam: number;
  pageStack: number;
};

export class Memory {
  ram: Uint8Array;
  rom: Uint8Array;
  mappings: Mapping[];
  // current active mapping state
  mappingData = 0;
  ramdiskIdx = 0;
  memType: number = 0; // 0 = ROM, 1 = RAM

  constructor() {
    this.ram = new Uint8Array(MEMORY_GLOBAL_LEN);
    this.rom = new Uint8Array(0);
    this.mappings = new Array(RAM_DISK_MAX).fill(0).map(() => ({
      data: 0,
      modeRam8: false,
      modeRamA: false,
      modeRamE: false,
      modeStack: false,
      pageRam: 0,
      pageStack: 0
    }));
    this.mappingData = 0;
    this.ramdiskIdx = 0;
  }

  // Load ROM bytes into the ROM buffer and optionally copy into RAM at given address
  loadRom(buf: Buffer, addr = ROM_LOAD_ADDR) {
    this.rom = new Uint8Array(buf.length);
    for (let i = 0; i < buf.length; i++) this.rom[i] = buf[i];
    // also map ROM bytes into low 64k ram region (so code that reads memory via ram reads the same)
    for (let i = 0; i < this.rom.length; i++) {
      const a = (addr + i) & 0xffff;
      this.ram[a] = this.rom[i];
    }
    // set memory type to ROM (like C++ Init behaviour)
    this.setMemType(0);
  }

  setMemType(mt: number) { this.memType = mt; }

  isRomEnabled() { return this.memType === 0; }

  // Set raw byte in the global address space
  setByte(addr: number, value: number) {
    const g = addr & 0xffff;
    this.ram[g] = value & 0xff;
  }

  // Get byte considering ROM/RAM state and mapping
  getByte(addr: number, addrSpace: AddrSpace = AddrSpace.RAM): number {
    const global = this.getGlobalAddr(addr, addrSpace);
    if (this.isRomEnabled() && global < this.rom.length) return this.rom[global];
    return this.ram[global];
  }

  // Writes considering mapping (writes to RAM disk regions write to ram)
  writeByte(addr: number, value: number, addrSpace: AddrSpace = AddrSpace.RAM) {
    const global = this.getGlobalAddr(addr, addrSpace);
    this.ram[global] = value & 0xff;
  }

  // Convert a 16-bit address + addrSpace to a global address in the big ram array
  getGlobalAddr(addr: number, addrSpace: AddrSpace = AddrSpace.RAM): number {
    addr = addr & 0xffff;
    // if no mapping enabled, return addr
    if (!(this.mappingData & MAPPING_MODE_MASK)) return addr;

    const md = this.mappingData;
    const modeRam8 = (md & 0b10000000) !== 0;
    const modeRamA = (md & 0b01000000) !== 0;
    const modeRamE = (md & 0b00100000) !== 0;
    const modeStack = (md & 0b00001000) !== 0;

    // STACK mapping
    if (modeStack && addrSpace === AddrSpace.STACK) {
      const pageStack = this.mappings[this.ramdiskIdx].pageStack || 0;
      const pageIndex = pageStack + 1 + this.ramdiskIdx * 4;
      return (pageIndex * RAM_DISK_PAGE_LEN + addr) & (MEMORY_GLOBAL_LEN - 1);
    }

    // RAM mapping for ranges
    if ((modeRamA && addr >= 0xA000 && addr < 0xE000) ||
        (modeRam8 && addr >= 0x8000 && addr < 0xA000) ||
        (modeRamE && addr >= 0xE000)) {
      const pageRam = this.mappings[this.ramdiskIdx].pageRam || 0;
      const pageIndex = pageRam + 1 + this.ramdiskIdx * 4;
      return (pageIndex * RAM_DISK_PAGE_LEN + addr) & (MEMORY_GLOBAL_LEN - 1);
    }

    return addr;
  }

  // Configure a RAM disk mapping entry; data is the control byte similar to C++ SetRamDiskMode
  setRamDiskMode(diskIdx: number, data: number) {
    const idx = diskIdx & (RAM_DISK_MAX - 1);
    this.mappings[idx].data = data & 0xff;
    this.mappings[idx].modeRam8 = !!(data & 0b10000000);
    this.mappings[idx].modeRamA = !!(data & 0b01000000);
    this.mappings[idx].modeRamE = !!(data & 0b00100000);
    this.mappings[idx].modeStack = !!(data & 0b00010000);
    this.mappings[idx].pageRam = (data >> 5) & 0x03;
    this.mappings[idx].pageStack = (data >> 0) & 0x03;

    // recompute active mapping: choose first mapping with MAPPING_MODE_MASK set
    this.mappingData = 0;
    let enabled = 0;
    for (let i = 0; i < RAM_DISK_MAX; i++) {
      if (this.mappings[i].data & MAPPING_MODE_MASK) {
        enabled++;
        if (enabled === 1) {
          this.mappingData = this.mappings[i].data;
          this.ramdiskIdx = i;
        }
      }
    }
  }

  // Read 4 screen bytes like C++ GetScreenBytes
  getScreenBytes(screenAddrOffset: number): number {
    const offset = screenAddrOffset & 0xffff;
    const b8 = this.getByte(0x8000 + offset);
    const bA = this.getByte(0xA000 + offset);
    const bC = this.getByte(0xC000 + offset);
    const bE = this.getByte(0xE000 + offset);
    return (b8 << 24) | (bA << 16) | (bC << 8) | bE;
  }
}

export default Memory;
