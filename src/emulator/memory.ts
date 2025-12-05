import * as fs from 'fs';

export enum AddrSpace { RAM = 0, STACK = 1 }
export enum MemType { ROM = 0, RAM = 1 }

export const ROM_LOAD_ADDR = 0x0100;
export const MEM_64K = 64 * 1024;
export const RAM_DISK_PAGE_LEN = MEM_64K;
export const RAMDISK_PAGES_MAX = 4;
export const MEMORY_RAMDISK_LEN = RAMDISK_PAGES_MAX * MEM_64K;
export const RAM_DISK_MAX = 8;

export const MEMORY_MAIN_LEN = MEM_64K;
export const MEMORY_GLOBAL_LEN = MEMORY_MAIN_LEN + MEMORY_RAMDISK_LEN * RAM_DISK_MAX;

export const MAPPING_MODE_MASK = 0b11110000;

export type MemoryAccessSnapshot = {
  reads: number[];
  writes: number[];
  values: Record<number, number>;
};

export class MemMapping {
  pageRam: number = 0;     // 0-1 bits, The index of the RAM Disk 64k page accessed in the Memory-Mapped Mode
  pageStack: number = 0;   // 2-3 bits, The index of the RAM Disk 64k page accessed in the Stack Mode
  modeStack: boolean = false;  // 4 bit, Enables the Stack Mode
  modeRamA: boolean = false;   // 5 bit, Enables the Memory-Mapped Mode with mapping for range [0xA000-0xDFFF]
  modeRam8: boolean = false;   // 6 bit, Enables the Memory-Mapped Mode with mapping for range [0x8000-0x9FFF]
  modeRamE: boolean = false;   // 7 bit, Enables the Memory-Mapped Mode with mapping for range [0xE000-0xFFFF]

  get byte(): number {
    let data = (this.pageRam) | ((this.pageStack) << 2);
    data |= (this.modeStack ? 0b00010000 : 0);
    data |= (this.modeRamA ? 0b00100000 : 0);
    data |= (this.modeRam8 ? 0b01000000 : 0);
    data |= (this.modeRamE ? 0b10000000 : 0);
    return data;
  }

  set byte(data: number) {
    this.pageRam = data & 0x03;
    this.pageStack = (data >> 2) & 0x03;
    this.modeStack = (data & 0b00010000) !== 0;
    this.modeRamA = (data & 0b00100000) !== 0;
    this.modeRam8 = (data & 0b01000000) !== 0;
    this.modeRamE = (data & 0b10000000) !== 0;
  }

  Erase(): void {
    this.pageRam = 0;
    this.pageStack = 0;
    this.modeStack = false;
    this.modeRamA = false;
    this.modeRam8 = false;
    this.modeRamE = false;
  }

  IsRamModeEnabled(): boolean {
    return this.modeRamA || this.modeRam8 || this.modeRamE;
  }
};


type GetGlobalAddrFuncType = (addr: number, addrSpace: AddrSpace) => number;

export class Update {
  mappings: MemMapping[] = Array.from({length: RAM_DISK_MAX}, () => new MemMapping());
  // current active mapping state
  ramdiskIdx = 0;
};

export class MemState {
	update: Update = new Update();
  ram: Uint8Array | null = null;
  GetGlobalAddrFunc: GetGlobalAddrFuncType | null = null;

  constructor(_getGlobalAddrFunc: GetGlobalAddrFuncType | null,
              ram: Uint8Array | null) {
    this.GetGlobalAddrFunc = _getGlobalAddrFunc;
    this.ram = ram;
  }
}

export class Memory {
  ram: Uint8Array = new Uint8Array(MEMORY_GLOBAL_LEN);
  rom: Uint8Array = new Uint8Array(0);

  _state = new MemState(this.GetGlobalAddr.bind(this), this.ram);

  private accessLog = {
    reads: new Set<number>(),
    writes: new Set<number>(),
    values: new Map<number, number>()
  };

  // number of RAM Disks with mapping enabled
  // used to detect exceptions
  mappingsEnabled = 0;

  memType: MemType = MemType.ROM;
  ramDiskClearAfterRestart: boolean = false;

  constructor(pathBootData: string, ramDiskDataPath: string, ramDiskClearAfterRestart: boolean) {
    if (pathBootData) {
      try {
        // check if file exists
        if (fs.existsSync(pathBootData)) {
          this.rom = fs.readFileSync(pathBootData);
        }
        else {
          console.error(`ROM file not found: ${pathBootData}`);
        }
      } catch (err) {
        console.error(`Failed to load ROM from ${pathBootData}:`, err);
        process.exit(1);
      }
    }
    this.ramDiskClearAfterRestart = ramDiskClearAfterRestart;
  }

  private normalizeAddr(addr: number): number {
    return addr & 0xffff;
  }

  private recordRead(addr: number, value: number) {
    const normalized = this.normalizeAddr(addr);
    this.accessLog.reads.add(normalized);
    this.accessLog.values.set(normalized, value & 0xff);
  }

  private recordWrite(addr: number, value: number) {
    const normalized = this.normalizeAddr(addr);
    this.accessLog.writes.add(normalized);
    this.accessLog.values.set(normalized, value & 0xff);
  }

  snapshotAccessLog(): MemoryAccessSnapshot {
    const values: Record<number, number> = {};
    this.accessLog.values.forEach((value, key) => {
      values[key] = value;
    });
    return {
      reads: Array.from(this.accessLog.reads),
      writes: Array.from(this.accessLog.writes),
      values
    };
  }

  clearAccessLog(): void {
    this.accessLog.reads.clear();
    this.accessLog.writes.clear();
    this.accessLog.values.clear();
  }

  get state(): MemState {
    return this._state;
  }

  Init()
  {
    if (this.ramDiskClearAfterRestart)
    {
      // clear the RAM including ramdisk regions
      this.ram.fill(0);
    }
    else {
      // clear the main RAM only
      this.ram.fill(0, 0, MEMORY_MAIN_LEN);
    }

    // default to ROM and reset mapping state
    this.memType = MemType.ROM;

    // recompute active mapping (clear mappings or apply defaults)
    this.InitRamDiskMapping();
  }

  InitRamDiskMapping() {
    for (let mapping of this._state.update.mappings) {
      mapping.Erase();
    }

    this._state.update.ramdiskIdx = 0;
    this.mappingsEnabled = 0;
  }

  Restart() {
	this.memType = MemType.RAM;
	this.InitRamDiskMapping();
  }

  SetMemType(_memType: MemType) {
	this.memType = _memType;
  }

  SetRam(_addr: number, _data: Uint8Array) {
    this.ram.set(_data, _addr);
  }

  SetByteGlobal(globalAddr: number, data: number) {
    this.ram[globalAddr] = data;
  }

  GetByteGlobal(globalAddr: number): number {
    return this.ram[globalAddr];
  }

  GetByte(addr: number, addrSpace: AddrSpace = AddrSpace.RAM): number {
  const globalAddr = this.GetGlobalAddr(addr, addrSpace);

  return this.memType === MemType.ROM && globalAddr < this.rom.length ?
    this.rom[globalAddr] : this.ram[globalAddr];
  }

  CpuReadInstr(addr: number, addrSpace: AddrSpace, byteNum: number): number {
    const globalAddr = this.GetGlobalAddr(addr, addrSpace);
    const val = this.memType === MemType.ROM && globalAddr < this.rom.length ?
      this.rom[globalAddr] : this.ram[globalAddr];

    // TODO: fix the debug later
    // this.mState.debug.instrGlobalAddr = _byteNum === 0 ? globalAddr : this.mState.debug.instrGlobalAddr;
    // this.mState.debug.instr.array[_byteNum] = val;

    return val;
  }

  // CpuInvokesRst7()
  // {
    // TODO: fix the debug later
    // m_state.debug.instr.array[0] = 0xFF; // OPCODE_RST7
  //}

  // accessed by the CPU
  // byteNum = 0 for the first byte stored by instr, 1 for the second
  // byteNum is 0 or 1
  CpuRead(addr: number, addrSpace: AddrSpace, byteNum: number): number {
    const globalAddr = this.GetGlobalAddr(addr, addrSpace);

    // debug
    // TODO: fix the debug later
    // this.mState.debug.readGlobalAddr[byteNum] = globalAddr;
    // this.mState.debug.readLen = byteNum + 1;

    // return byte
    const value = this.memType === MemType.ROM && globalAddr < this.rom.length ?
      this.rom[globalAddr] : this.ram[globalAddr];
    this.recordRead(addr, value);
    return value;
  }

  // accessed by the CPU
  // byteNum = 0 for the first byte stored by instr, 1 for the second
  // byteNum is 0 or 1
  CpuWrite(addr: number, value: number, addrSpace: AddrSpace = AddrSpace.RAM, byteNum: number): void {
    const globalAddr = this.GetGlobalAddr(addr, addrSpace);

    // debug
    // TODO: fix the debug later
    // this.mState.debug.beforeWrite[byteNum] = this.ram[globalAddr];
    // this.mState.debug.writeGlobalAddr[byteNum] = globalAddr;
    // this.mState.debug.writeLen = byteNum + 1;

    // this.mState.debug.write[byteNum] = value;

    // store byte
    this.ram[globalAddr] = value;
    this.recordWrite(addr, value);
  }

  // Read 4 bytes from every screen buffer.
  // All of these bytes are visually at the same position on the screen
  GetScreenBytes(screenAddrOffset: number): number {
    const byte8 = this.GetByte(0x8000 + screenAddrOffset);
    const byteA = this.GetByte(0xA000 + screenAddrOffset);
    const byteC = this.GetByte(0xC000 + screenAddrOffset);
    const byteE = this.GetByte(0xE000 + screenAddrOffset);
    return (byte8 << 24) | (byteA << 16) | (byteC << 8) | byteE;
  }

  // Convert a 16-bit addr to a global addr depending on the ram/stack mapping modes
  GetGlobalAddr(addr: number, addrSpace: AddrSpace): number {
    addr = addr & 0xffff;
    let mapping = this._state.update.mappings;
    let ramdiskIdx = this._state.update.ramdiskIdx;

    // if no mapping enabled, return addr
    if (!(mapping[ramdiskIdx].byte & MAPPING_MODE_MASK)) return addr;

    const md = mapping[ramdiskIdx];

    // STACK mapping
    if (md.modeStack && addrSpace === AddrSpace.STACK)
    {
      const pageStack = mapping[ramdiskIdx].pageStack;
      const pageIndex = pageStack + 1 + ramdiskIdx * 4;
      return pageIndex * RAM_DISK_PAGE_LEN + addr;
    }

    // The ram mapping can be applied to a stack operation as well if the addr falls into the ram-mapping range
    if ((md.modeRamA && addr >= 0xA000 && addr < 0xE000) ||
        (md.modeRam8 && addr >= 0x8000 && addr < 0xA000) ||
        (md.modeRamE && addr >= 0xE000))
    {
      const pageRam = mapping[ramdiskIdx].pageRam;
      const pageIndex = pageRam + 1 + ramdiskIdx * 4;
      return pageIndex * RAM_DISK_PAGE_LEN + addr;
    }

    return addr;
  }

  // It raises an exception if the mapping is enabled for more than one RAM Disk.
  // It used the first enabled RAM Disk during an exception
  SetRamDiskMode(diskIdx: number, data: number)
  {
    this._state.update.mappings[diskIdx].byte = data;

    // Check how many mappings are enabled
    this.mappingsEnabled = 0;
    for (let i = 0; i < RAM_DISK_MAX; i++)
    {
      const mappingByte = this._state.update.mappings[i].byte;
      if (mappingByte & MAPPING_MODE_MASK) {
        this.mappingsEnabled++;
        if (this.mappingsEnabled > 1) {
          break;
        }
        this._state.update.ramdiskIdx = i;
      }
    }
  }

  // It raises an exception if the mapping is enabled for more than one RAM Disk.
  IsException()
  {
    const exception = this.mappingsEnabled > 1;
    // Reset the counter for the next check
    this.mappingsEnabled = 0;
    return exception;
  }
}

export default Memory;
