import { HardwareReq } from './hardware_reqs';
import * as CpuI8080 from './cpu_i8080';
import Memory, { MEMORY_GLOBAL_LEN, MEMORY_MAIN_LEN, AddrSpace } from './memory';
import IO from './io';
import { KbOperation, Keyboard } from './keyboard';
import { Display, FRAME_W } from './display';
import { TimerI8253 } from './timer_i8253';
import { AYWrapper, SoundAY8910 } from './sound_ay8910';
import { Fdc1793 } from './fdc_wd1793';
import { DebugFunc, DebugReqHandlingFunc, ReqData } from './hardware_types';
import { Audio } from './audio';
import * as type from './type';
import { performance } from 'perf_hooks';
import { PerfProfiler } from './perf_profiler';

enum Status {
			RUN = 0,
			STOP = 1,
			EXIT = 2,
}
// execution speed settings.
enum ExecSpeed {
  _1PERCENT = 0,
	_20PERCENT = 1,
	HALF = 2,
	NORMAL = 3,
	X2 = 4,
	MAX = 5
};
// the values represent the delay per frame in milliseconds.
const execDelays: number[] = [
	1996.800,
	99.840,
	39.936,
	19.968,
	9.984,
	0.0
];

// Extention thread. Use Hardware.Request(HardwareReq....) to interact with Hardware.
export class Hardware
{
  status: Status = Status.STOP;
  execSpeed: ExecSpeed = ExecSpeed.NORMAL; // execution speed

  private _profiler?: PerfProfiler;
  // enabled when bordelsess drawing is enabled
  private _borderFill: boolean = true;
  // optimization disables producing sound and rasterization
  private _optimize: boolean = false;

  private _cpu?: CpuI8080.CPU;
  private _memory?: Memory;
  private _keyboard?: Keyboard;
  private _io?: IO;
  private _display?: Display;
  private _timer?: TimerI8253;
  private _ay?: SoundAY8910;
  private _ayWrapper?: AYWrapper;
  private _fdc?: Fdc1793;
  private _audio?: Audio;

  Debug?: DebugFunc | null = null;
  DebugReqHandling?: DebugReqHandlingFunc | null = null;

  debugAttached: boolean = false;
  result: type.EmulatorResult = new type.EmulatorResult();

  constructor(
    bootRom: Uint8Array | undefined,
    ramDisk: Uint8Array | undefined)
  {
    this._memory = new Memory(bootRom, ramDisk);
    this.result.add(this._memory.result);

    this._keyboard = new Keyboard();
    this._timer = new TimerI8253();
    this._ay = new SoundAY8910();
    this._ayWrapper = new AYWrapper(this._ay);
    this._audio = new Audio(this._timer, this._ayWrapper);
    this._fdc = new Fdc1793();
    this._io = new IO(this._keyboard, this._memory, this._timer, this._ay, this._fdc);
    this._cpu = new CpuI8080.CPU(
      this._memory, this._io.PortIn.bind(this._io), this._io.PortOut.bind(this._io));
    this._display = new Display(this._memory, this._io);

    if (process.env.VECTOR_PROFILE === '1'){
      this._profiler = new PerfProfiler();
    }

    this.Reset();
  }

  // Extension thread
  Destructor()
  {
    this.ReqHandling(HardwareReq.STOP);
    this.ReqHandling(HardwareReq.EXIT);
  }

  // Returns true if the execution breaks
  ExecuteInstruction(): boolean
  {
    // mem debug init
    this._memory?.state.debug.Init();

    let break_ = false;
    let executed = false;
    while (!break_ && !executed)
    {
      if (this._profiler && this._profiler.shouldSample(this._cpu!.state.cc / 4))
      {
        const t0 = performance.now();
        this._display?.Rasterize(this._borderFill, this._optimize);
        const t1 = performance.now();
        this._cpu?.ExecuteMachineCycle(this._display?.IsIRQ() ?? false);
        const t2 = performance.now();
        this._audio?.Clock(2, this._io?.GetBeeper() ?? 0, this._optimize);
        const t3 = performance.now();

        executed = this._cpu?.IsInstructionExecuted() ?? false;
        if (executed) {
          break_ ||= this.Debug!(this._cpu!.state, this._memory!.state, this._io!.state, this._display!.state);
        }
        if (this._memory?.IsException())
        {
          this._memory.InitRamDiskMapping(); // reset RAM Disk mode collision
          console.log("ERROR: more than one RAM Disk has mapping enabled");
          break_ = true;
        }
        const t4 = performance.now();
        this._profiler?.recordSample(t1-t0, t2-t1, t3-t2, t4-t3);
      }
      else
      {
        this._display?.Rasterize(this._borderFill, this._optimize);
        this._cpu?.ExecuteMachineCycle(this._display?.IsIRQ() ?? false);
        this._audio?.Clock(2, this._io?.GetBeeper() ?? 0, this._optimize);
        executed = this._cpu?.IsInstructionExecuted() ?? false;
        if (executed) {
          break_ ||= this.Debug!(this._cpu!.state, this._memory!.state, this._io!.state, this._display!.state);
        }
        if (this._memory?.IsException())
        {
          this._memory.InitRamDiskMapping(); // reset RAM Disk mode collision
          console.log("ERROR: more than one RAM Disk has mapping enabled");
          break_ = true;
        }
      }
    }
    return break_;
  }

  // UI thread. It returns when the request is fulfilled
  Request(req: HardwareReq, data: ReqData = {}): ReqData
  {
    return this.ReqHandling(req, data);
  }


  // internal thread
  ReqHandling(req: HardwareReq, data: ReqData = {}): ReqData
  {

    let out: ReqData = {};
    if (!this._cpu || !this._memory || !this._io || !this._display) return out;

    switch (req)
    {
    case HardwareReq.RUN:
      this.Run();
      break;

    case HardwareReq.STOP:
      this.Stop();
      break;

    case HardwareReq.IS_RUNNING:
      out = {"isRunning": this.status == Status.RUN};
      break;

    case HardwareReq.EXIT:
      this.status = Status.EXIT;
      break;

    case HardwareReq.RESET:
      this.Reset();
      break;

    case HardwareReq.RESTART:
      this.Restart();
      break;

    case HardwareReq.EXECUTE_INSTR:
      this.ExecuteInstruction();
      break;

    case HardwareReq.EXECUTE_FRAME_NO_BREAKS:
    {
      this.ExecuteFrame();
      break;
    }

    case HardwareReq.EXECUTE_FRAME:
    {
      this.ExecuteFrame(true);
      break;
    }

    case HardwareReq.GET_CC:
      out = {"cc": this._cpu?.cc };
      break;

/*
    case HardwareReq.GET_REGS:
      out = this.GetRegs();
      break;
*/
    case HardwareReq.GET_REG_PC:
      out = {"pc": this._cpu?.pc };
      break;

    case HardwareReq.SET_REG_PC:
      const pc: number = data["pc"];
      if (pc === undefined) {
        break;
      }
      this._cpu.state.regs.pc.word = pc;
      break;
/*
    case HardwareReq.GET_RUSLAT_HISTORY:
      out = {"data": this._io?.GetRusLatHistory()};
      break;

    case HardwareReq.GET_IO_PALETTE:
    {
      out = {"data": this._io?.GetPalette()};
      break;
    }
    case HardwareReq.GET_IO_PORTS:
    {
      out = {"data": this._io?.GetPorts()};
      break;
    }

    case HardwareReq.GET_IO_PALETTE_COMMIT_TIME:
    {
      out = {"paletteCommitTime": this._io?.GetPaletteCommitTime()};
      break;
    }

    case HardwareReq.SET_IO_PALETTE_COMMIT_TIME:
    {
      this._io?.SetPaletteCommitTime(dataJ["paletteCommitTime"]);
      break;
    }

    case HardwareReq.GET_DISPLAY_BORDER_LEFT:
    {
      const data = this._display?.GetBorderLeft();
      out = {"borderLeft": data};
      break;
    }

    case HardwareReq.SET_DISPLAY_BORDER_LEFT:
    {
      this._display?.SetBorderLeft(dataJ["borderLeft"]);
      break;
    }

    case HardwareReq.GET_DISPLAY_IRQ_COMMIT_PXL:
    {
      const data = this._display?.GetIrqCommitPxl();
      out = {"irqCommitPxl": data};
      break;
    }

    case HardwareReq.SET_DISPLAY_IRQ_COMMIT_PXL:
    {
      this._display?.SetIrqCommitPxl(dataJ["irqCommitPxl"]);
      break;
    }

    case HardwareReq.GET_IO_DISPLAY_MODE:
      out = {"data": this._io?.GetDisplayMode()};
      break;

    case HardwareReq.GET_BYTE_GLOBAL:
      out = this.GetByteGlobal(dataJ);
      break;
    */
    case HardwareReq.GET_BYTE_RAM:{
      const byte = this._memory.GetByte(data["addr"], AddrSpace.RAM);
      out = {"data": byte};
      break;
    }
    case HardwareReq.GET_CPU_STATE:
      out = {"data": this._cpu?.state.clone() || new CpuI8080.CpuState()};
      break;

    case HardwareReq.GET_INSTR:{
      const addr: number = data["addr"] as number;
      const opcode: number = this._memory.GetByte(addr, AddrSpace.RAM);
      const instr_len = CpuI8080.CPU.GetInstrLen(opcode);
      const bytes: number[] = [opcode];
      if (instr_len > 1)
        bytes.push(this._memory.GetByte(addr + 1, AddrSpace.RAM));
      if (instr_len > 2)
        bytes.push(this._memory.GetByte(addr + 2, AddrSpace.RAM));
      out = {"data": bytes};
      break;
    }
    /*
    case HardwareReq.GET_THREE_BYTES_RAM:
      out = this.Get3Bytes(dataJ, AddrSpace.RAM);
      break;

    case HardwareReq.GET_MEM_STRING_GLOBAL:
      out = this.GetMemString(dataJ);
      break;
*/
    case HardwareReq.GET_WORD_STACK:
      out = this.GetWord(data, AddrSpace.STACK);
      break;

    case HardwareReq.GET_STACK_SAMPLE:
      out = this.GetStackSample(data);
      break;

    case HardwareReq.GET_DISPLAY_DATA:
      out = {
        "rasterLine": this._display?.rasterLine,
        "rasterPixel": this._display?.rasterPixel,
        "frameNum": this._display?.frameNum,
        "scrollIdx": this._display?.scrollIdx
      };
      break;

    case HardwareReq.GET_FRAME:
      const sync = data["vsync"] || false;
      out = {"data": this._display.GetFrame(sync)};
      break;

    case HardwareReq.GET_MEMORY_MAPPING:
      const idx = this._memory.state.update.ramdiskIdx;
      out = {
        "mapping": this._memory.state.update.mappings[idx].clone(),
        "ramdiskIdx": idx,
        };
      break;

    case HardwareReq.GET_MEMORY_MAPPINGS:{
      const idx = this._memory.state.update.ramdiskIdx;
      out = {
        "mappings": this._memory.state.update.mappings.map(m => m.clone()),
        "ramdiskIdx": idx,
        };
      break;
    }

    case HardwareReq.GET_GLOBAL_ADDR_RAM:
      out = {"data": this._memory.GetGlobalAddr(data["addr"], AddrSpace.RAM)};
      break;
/*
    case HardwareReq.GET_FDC_INFO: {
      auto info = this.fdc.GetFdcInfo();
      out = {
        {"drive", info.drive},
        {"side", info.side},
        {"track", info.track},
        {"lastS", info.lastS},
        {"wait", info.irq},
        {"cmd", info.cmd},
        {"rwLen", info.rwLen},
        {"position", info.position},
        };
      break;
    }

    case HardwareReq.GET_FDD_INFO: {
      auto info = m_fdc.GetFddInfo(dataJ["driveIdx"]);
      out = {
        {"path", info.path},
        {"updated", info.updated},
        {"reads", info.reads},
        {"writes", info.writes},
        {"mounted", info.mounted},
        };
      break;
    }

    case HardwareReq.GET_FDD_IMAGE:
      out = {
        {"data", m_fdc.GetFddImage(dataJ["driveIdx"])},
        };
      break;
*/
    case HardwareReq.GET_STEP_OVER_ADDR:
      out = {"data": this.GetStepOverAddr()};
      break;
/*
    case HardwareReq.GET_IO_PORTS_IN_DATA:
    {
      auto portsData = m_io.GetPortsInData();
      out = {
        {"data0", portsData->data0},
        {"data1", portsData->data1},
        {"data2", portsData->data2},
        {"data3", portsData->data3},
        {"data4", portsData->data4},
        {"data5", portsData->data5},
        {"data6", portsData->data6},
        {"data7", portsData->data7},
        };
      break;
    }
    case HardwareReq.GET_IO_PORTS_OUT_DATA:
    {
      auto portsData = m_io.GetPortsOutData();
      out = {
        {"data0", portsData->data0},
        {"data1", portsData->data1},
        {"data2", portsData->data2},
        {"data3", portsData->data3},
        {"data4", portsData->data4},
        {"data5", portsData->data5},
        {"data6", portsData->data6},
        {"data7", portsData->data7},
        };
      break;
    }
*/
    case HardwareReq.SET_MEM:
      this._memory.SetRam(data["addr"], data["data"]);
      break;

    case HardwareReq.SET_RAM_DISK:
      this._memory.SetRam(MEMORY_MAIN_LEN, data["data"]);
      break;
/*
    case HardwareReq.SET_BYTE_GLOBAL:
      m_memory.SetByteGlobal(dataJ["addr"], dataJ["data"]);
      break;

    case HardwareReq.SET_CPU_SPEED:
    {
      int speed = dataJ["speed"];
      speed = std::clamp(speed, 0, int(sizeof(m_execDelays) - 1));
      m_execSpeed = static_cast<ExecSpeed>(speed);
      if (m_execSpeed == ExecSpeed::_20PERCENT) { m_audio.Mute(true); }
      else { m_audio.Mute(false); }
      break;
    }

    */
    case HardwareReq.GET_RAM_DISK:
      out = {"data": this._memory.ram.subarray(MEMORY_MAIN_LEN, MEMORY_GLOBAL_LEN)};
      break;

    case HardwareReq.GET_MEM_DEBUG_STATE:
      out = {"data": this._memory.state.debug.clone()};
      break;

    case HardwareReq.GET_MEM_RANGE:{
      let addr = data["addr"];
      let length = Math.max(0, data["length"]);
      addr = Math.min(Math.max(0, addr), MEMORY_GLOBAL_LEN - 1);
      const endAddr = Math.min(addr + length, MEMORY_GLOBAL_LEN);
      out = {"data": this._memory.ram.subarray(addr, endAddr)};
      break;
    }
    case HardwareReq.GET_HW_MAIN_STATS:
    {
      if (this._cpu && this._display && this._io) {
        const hl = this._cpu.state.regs.hl.word;
        out = {
          "cpu_state": this._cpu.state.clone(),
          "rasterLine": this._display.rasterLine,
          "rasterPixel": this._display.rasterPixel,
          "frameCc": (this._display.rasterPixel + this._display.rasterLine * FRAME_W) >> 2,
          "frameNum": this._display.frameNum,
          "displayMode": this._io.displayMode,
          "scrollIdx": this._display.scrollIdx,
          "rusLat": this._io.ruslat,
          "inte": this._cpu.state.ints.inte,
          "iff": this._cpu.state.ints.iff,
          "hlta": this._cpu.state.ints.hlta,
          "palette": this._io.palette.slice(),
          "m": this._memory?.GetByte(hl, AddrSpace.RAM) || 0,
        };
      }
      break;
    }
    /*
    case HardwareReq.IS_MEMROM_ENABLED:
      out = {
        {"data", m_memory.IsRomEnabled() },
        };
      break;
*/
    case HardwareReq.KEY_HANDLING:
    {
      const code = data["scancode"];
      const action = data["action"];

      const op = this._keyboard?.KeyHandling(code, action) ?? KbOperation.NONE;

      if (op == KbOperation.RESET) {
        this.Reset();
      }
      else if (op == KbOperation.RESTART) {
        this.Restart();
      }
      break;
    }
    /*
    case HardwareReq.GET_SCROLL_VERT:
      out = {
        {"scrollVert", m_display.GetScrollVert()}
        };
      break;
*/
    case HardwareReq.DISMOUNT_FDD:{
      const driveIdx = data.fddIdx;
      if (driveIdx === undefined) {
        break;
      }
      const old_img = this._fdc?.Dismount(driveIdx);
      out = {data: old_img};
      break;
    }

    case HardwareReq.MOUNT_FDD:{
      const driveIdx = data.fddIdx;
      const path = data.path;
      const disk_data = data.data;
      if (!disk_data || !path || driveIdx === undefined) {
        break;
      }
      this._fdc?.Mount({fddIdx: driveIdx, data: disk_data, path: path});
      break;
    }

    case HardwareReq.DISMOUNT_FDD_ALL:
      const old_imgs = this._fdc?.DismountAll() || [];
      out = {data: old_imgs};
      break;

    case HardwareReq.RESET_UPDATE_FDD:
      this._fdc?.ResetUpdate(data.driveIdx);
      break;

    case HardwareReq.DEBUG_ATTACH:
      this.debugAttached = data.data;
      break;

    case HardwareReq.OPTIMIZE:
      this._optimize = data.data;
      break;

    case HardwareReq.BORDER_FILL:
      this._borderFill = data.data;
      break;

    default:
      if (this.DebugReqHandling && this._cpu && this._memory && this._io && this._display){
        out = this.DebugReqHandling(req, data, this._cpu.state, this._memory.state, this._io.state, this._display.state);
      }
      break;
    }

    return out;
  }

  // HW reset (BLK + VVOD keys)
  Reset()
  {
    this._memory?.Reset();
    this._display?.Reset();
    this._io?.Reset();
    this._cpu?.Reset();
    this._audio?.Reset();
  }

  // HW restart (BLK + SBR keys)
  Restart()
  {
    this._cpu?.Reset();
    this._audio?.Reset();
    this._memory?.Restart();
  }

  Stop()
  {
    this.status = Status.STOP;
    this._audio?.Pause(true);
  }

  // to continue execution
  Run()
  {
    this.status = Status.RUN;
    this._audio?.Pause(false);
  }
/*
  GetByteGlobal(const nlohmann::json _globalAddrJ)
  -> nlohmann::json
  {
    GlobalAddr globalAddr = _globalAddrJ["globalAddr"];
    uint8_t val = m_memory.GetRam()->at(globalAddr);
    nlohmann::json out = {
      {"data", val}
    };
    return out;
  }

  Get3Bytes(addrJ: ReqData, addrSpace: AddrSpace) ReqData
  {
    const addr: number = addrJ["addr"];
    const data: number = m_memory.GetByte(addr, addrSpace) |
      m_memory.GetByte(addr + 1, addrSpace) << 8 |
      m_memory.GetByte(addr + 2, addrSpace) << 16;

    const out: ReqData = {
      "data": data,
    };
    return out;
  }

  static constexpr int BYTES_IN_LINE = 16;
  static constexpr int CHARS_IN_LINE = BYTES_IN_LINE; // 1 char per byte
  static constexpr int HEX_LEN = 3;
  static constexpr int HEX_CHARS_IN_LINE = BYTES_IN_LINE * HEX_LEN; // FF and space
  static constexpr int SPACE_LEN = 1;
  static constexpr int NEWLINE_LEN = 1;
  static constexpr int EOF_LEN = 1;
  static constexpr int LINES_MAX = 16;
  static const int LINE_LEN_MAX = HEX_CHARS_IN_LINE + 1 + CHARS_IN_LINE + NEWLINE_LEN;

  static char hex_data[LINE_LEN_MAX * LINES_MAX + EOF_LEN] = { 0 };

  GetMemString(const nlohmann::json _dataJ)
  -> nlohmann::json
  {
    GlobalAddr globalAddr = _dataJ["addr"];
    Addr len = _dataJ["len"];
    len = len > 255 ? 255 : len;
    int char_idx = 0;
    int line_len = len < BYTES_IN_LINE ? len : BYTES_IN_LINE;

    for (Addr addrOffset = 0; addrOffset < len; addrOffset++)
    {
      auto c = m_memory.GetByteGlobal(globalAddr + addrOffset);
      int x = addrOffset % BYTES_IN_LINE;
      int y = addrOffset / BYTES_IN_LINE;

      // hex
      int hex_idx = LINE_LEN_MAX * y + x * HEX_LEN;
      uint8_t l = c & 0x0F;
      uint8_t h = (c >> 4) & 0x0F;
      hex_data[hex_idx] = h < 10 ? ('0' + h) : ('A' + h - 10);
      hex_data[hex_idx + 1] = l < 10 ? ('0' + l) : ('A' + l - 10);
      hex_data[hex_idx + 2] = ' ';

      if (x == 0)
      {
        // a break between hex and chars
        hex_data[LINE_LEN_MAX * y + HEX_LEN * line_len] = ' ';
      }

      // char
      char_idx = LINE_LEN_MAX * y + HEX_LEN * line_len + SPACE_LEN + x;
      hex_data[char_idx] = c > 31 && c < 127 ? (char)c : '.';

      // newline
      if (x == LINE_LEN_MAX - 1){
        int newline_idx = LINE_LEN_MAX * y + HEX_CHARS_IN_LINE + 1 + CHARS_IN_LINE;
        hex_data[newline_idx] = '\n';
      }
    }

    // end of file
    hex_data[char_idx + 1] = '\0';

    nlohmann::json out = {
      {"data", hex_data },
    };
    return out;
  }
*/

  GetWord(dataIn: ReqData, addrSpace: AddrSpace)
  : ReqData
  {
    const addr: number = dataIn["addr"];
    const l = this._memory?.GetByte(addr, addrSpace) ?? 0;
    const h = this._memory?.GetByte(addr + 1, addrSpace) ?? 0;
    const data: number = h << 8 | l;

    const out = {"data": data};
    return out;
  }

  GetStackSample(dataIn: ReqData)
  : ReqData
  {
    const addr: number = dataIn["addr"];
    let stack_sample: number[] = [];

    for (let offset of [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10])
    {
      const l = this._memory?.GetByte(addr + offset, AddrSpace.STACK) ?? 0;
      const h = this._memory?.GetByte(addr + offset + 1, AddrSpace.STACK) ?? 0;
      const data: number = h << 8 | l;
      stack_sample.push(data);
    }
    return {"data": stack_sample};
  }
/*
  GetRam() const
  -> const Memory::Ram*
  {
    return m_memory.GetRam();
  }
*/

  ExecuteFrame(breaks: boolean = false)
  {
    const frameNum: number = this._display?.frameNum ?? 0;
    do {
      if (this.ExecuteInstruction() && breaks){
        this.Stop();
        break;
      };
    } while (this._display?.frameNum === frameNum);

    this._profiler?.onFrame(this._display?.frameNum ?? 0);
  }

  GetStepOverAddr(): number
  {
    const pc = this._cpu?.pc ?? 0;
    const sp = this._cpu?.sp ?? 0;
    const opcode = this._memory?.GetByte(pc) ?? 0;

    const im_addr = (this._memory?.GetByte(pc + 2) ?? 0) << 8 | (this._memory?.GetByte(pc + 1) ?? 0);
    const next_pc = pc + CpuI8080.CPU.GetInstrLen(opcode);

    switch (CpuI8080.CPU.GetInstrType(opcode))
    {
    case CpuI8080.OPTYPE_JMP:
      return im_addr;
    case CpuI8080.OPTYPE_RET:
      return (this._memory?.GetByte((sp ?? 0) + 1, AddrSpace.STACK) ?? 0) << 8 | (this._memory?.GetByte(sp ?? 0, AddrSpace.STACK) ?? 0);
    case CpuI8080.OPTYPE_PCH:
      return this._cpu?.hl.word ?? 0;
    case CpuI8080.OPTYPE_RST:
      return opcode - CpuI8080.OPCODE_RST0;
    default:
      switch (opcode)
      {
      case CpuI8080.OPCODE_JNZ:
        return this._cpu?.flagZ ? next_pc : im_addr;
      case CpuI8080.OPCODE_JZ:
        return this._cpu?.flagZ ? im_addr : next_pc;
      case CpuI8080.OPCODE_JNC:
        return this._cpu?.flagC ? next_pc : im_addr;
      case CpuI8080.OPCODE_JC:
        return this._cpu?.flagC ? im_addr : next_pc;
      case CpuI8080.OPCODE_JPO:
        return this._cpu?.flagP ? next_pc : im_addr;
      case CpuI8080.OPCODE_JPE:
        return this._cpu?.flagP ? im_addr : next_pc;
      case CpuI8080.OPCODE_JP:
        return this._cpu?.flagS ? next_pc : im_addr;
      case CpuI8080.OPCODE_JM:
        return this._cpu?.flagS ? im_addr : next_pc;
      default:
        break;
      }
    }
    return next_pc;
  }

  AttachDebugFuncs(debugFunc: DebugFunc , debugReqHandlingFunc: DebugReqHandlingFunc)
  {
    this.Debug = debugFunc;
    this.DebugReqHandling = debugReqHandlingFunc;
  }
}
