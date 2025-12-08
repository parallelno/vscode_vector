import { HardwareReq } from './hardware_reqs';
import CPU, { CpuState } from './cpu_i8080';
import Memory, { MemState } from './memory';
import IO from './io';
import { Keyboard } from './keyboard';
import { Display } from './display';
import { TimerI8253 } from './timer_i8253';
import { AYWrapper, SoundAY8910 } from './sound_ay8910';
import { Fdc1793 } from './fdc_wd1793';
import { DebugFunc, DebugReqHandlingFunc, ReqData } from './hardware_types';
import { cp } from 'fs';
import { Audio } from './audio';
import { setFlagsFromString } from 'v8';

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

export class Hardware
{
  status: Status = Status.STOP;
  execSpeed: ExecSpeed = ExecSpeed.NORMAL; // execution speed

  _cpu?: CPU;
  _memory?: Memory;
  _keyboard?: Keyboard;
  io?: IO;
  _display?: Display;
  _timer?: TimerI8253;
  _ay?: SoundAY8910;
  _ayWrapper?: AYWrapper;
  _fdc?: Fdc1793;
  _audio?: Audio;

  // Optional callback invoked after each instruction is executed.
  // The callback is called from the hardware execution thread.
  debugInstructionCallback?: ((hw: Hardware) => void) | null = null;

  Debug?: DebugFunc | null = null;
  DebugReqHandling?: DebugReqHandlingFunc | null = null;

  debugAttached: boolean = false;

  constructor(
    pathBootData: string,
    ramDiskDataPath: string,
    ramDiskClearAfterRestart: boolean)
  {
    this._memory = new Memory(
      pathBootData, ramDiskDataPath, ramDiskClearAfterRestart);
    this._keyboard = new Keyboard();
    this._timer = new TimerI8253();
    this._ay = new SoundAY8910();
    this._ayWrapper = new AYWrapper(this._ay);
    this._audio = new Audio(this._timer, this._ayWrapper);
    this._fdc = new Fdc1793();
    this.io = new IO(this._keyboard, this._memory, this._timer, this._ay, this._fdc);
    this._cpu = new CPU(
      this._memory, this.io.PortIn.bind(this.io), this.io.PortOut.bind(this.io));
    this._display = new Display(this._memory, this.io);


    this.Init();
  }

  Destructor()
  {
    // Save RAM disk data before destruction
    this._memory?.SaveRamDiskData();
    this.ReqHandling(HardwareReq.EXIT);
  }

  // when HW needs Reset
  Init()
  {
    this._memory?.Init();
    this._display?.Init();
    this.io?.Init();
  }

  // Returns true if the execution breaks
  ExecuteInstruction(): boolean
  {
    // mem debug init
    //this._memory?.DebugInit();

    do
    {
      this._display?.Rasterize();
      this._cpu?.ExecuteMachineCycle(this._display?.IsIRQ() ?? false);
      this._audio?.Clock(2, this.io?.GetBeeper() ?? 0);

    } while (!this._cpu?.IsInstructionExecuted());

    // invoke per-instruction debug callback (if attached)
    try {
      if (this.debugInstructionCallback) {
        this.debugInstructionCallback(this);
      }
    } catch (e) {
      console.error('debugInstructionCallback error', e);
    }

    // debug per instruction
    try {
      if (this.debugAttached && this.Debug && this._cpu && this._memory /*&& this.io && this._display*/)
      {
          const break_ = this.Debug(this._cpu.state, this._memory.state /*, this.io.state, this._display.state*/);
          if (break_) return true;
      }
    } catch (e) {
        console.error('Debug per instruction error', e);
    }

    if (this._memory?.IsException())
    {
      this._memory.InitRamDiskMapping(); // reset RAM Disk mode collision
      console.log("ERROR: more than one RAM Disk has mapping enabled");
      return true;
    }

    return false;
  }

  // UI thread. It return when the request fulfilled
  Request(req: HardwareReq, data: ReqData = {}): ReqData
  {
    return this.ReqHandling(req, data);
  }


  // internal thread
  ReqHandling(req: HardwareReq, data: ReqData = {}): ReqData
  {

    let out: ReqData = {};

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

    case HardwareReq.GET_REG_PC:
      out = {"pc": this._cpu?.GetPC() };
      break;

    case HardwareReq.GET_RUSLAT_HISTORY:
      out = {"data": this.io?.GetRusLatHistory()};
      break;

    case HardwareReq.GET_IO_PALETTE:
    {
      out = {"data": this.io?.GetPalette()};;
      break;
    }
    case HardwareReq.GET_IO_PORTS:
    {
      out = {"data": this.io?.GetPorts()};
      break;
    }

    case HardwareReq.GET_IO_PALETTE_COMMIT_TIME:
    {
      out = {"paletteCommitTime": this.io?.GetPaletteCommitTime()};
      break;
    }

    case HardwareReq.SET_IO_PALETTE_COMMIT_TIME:
    {
      this.io?.SetPaletteCommitTime(dataJ["paletteCommitTime"]);
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
      out = {"data": this.io?.GetDisplayMode()};
      break;

    case HardwareReq.GET_BYTE_GLOBAL:
      out = this.GetByteGlobal(dataJ);
      break;

    case HardwareReq.GET_BYTE_RAM:
      out = this.GetByte(dataJ, AddrSpace.RAM);
      break;

    case HardwareReq.GET_THREE_BYTES_RAM:
      out = this.Get3Bytes(dataJ, AddrSpace.RAM);
      break;

    case HardwareReq.GET_MEM_STRING_GLOBAL:
      out = this.GetMemString(dataJ);
      break;

    case HardwareReq.GET_WORD_STACK:
      out = this.GetWord(dataJ, AddrSpace.STACK);
      break;

    case HardwareReq.GET_STACK_SAMPLE:
      out = this.GetStackSample(dataJ);
      break;

    case HardwareReq.GET_DISPLAY_DATA:
      out = {"rasterLine": this._display?.GetRasterLine(),
        "rasterPixel": this._display?.GetRasterPixel(),
        "frameNum": this._display?.GetFrameNum(),
        };
      break;

    case HardwareReq.GET_MEMORY_MAPPING:
      out = {
        {"mapping", this._memory.GetState().update.mapping.data},
        {"ramdiskIdx", this._memory.GetState().update.ramdiskIdx},
        };
      break;

    case HardwareReq.GET_MEMORY_MAPPINGS:{
      auto mappingsP = this._memory.GetMappingsP();
      out = {{"ramdiskIdx", this._memory.GetState().update.ramdiskIdx}};
      for (auto i=0; i < Memory::RAM_DISK_MAX; i++) {
        out["mapping"+std::to_string(i)] = mappingsP[i].data;
      }
      break;
    }
    case HardwareReq.GET_GLOBAL_ADDR_RAM:
      out = {
        {"data", this._memory.GetGlobalAddr(dataJ["addr"], AddrSpace.RAM)}
        };
      break;

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

    case HardwareReq.GET_STEP_OVER_ADDR:
      out = {
        {"data", GetStepOverAddr()},
        };
      break;

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
      this._memory?.SetRam(data["addr"], data["data"]);
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

    case HardwareReq.GET_HW_MAIN_STATS:
    {
      auto paletteP = m_io.GetPalette();

      out = {{"cc", m_cpu.GetCC()},
        {"rasterLine", m_display.GetRasterLine()},
        {"rasterPixel", m_display.GetRasterPixel()},
        {"frameCc", (m_display.GetRasterPixel() + m_display.GetRasterLine() * Display::FRAME_W) / 4},
        {"frameNum", m_display.GetFrameNum()},
        {"displayMode", m_io.GetDisplayMode()},
        {"scrollVert", m_display.GetScrollVert()},
        {"rusLat", (m_io.GetRusLatHistory() & 0b1000) != 0},
        {"inte", m_cpu.GetState().ints.inte},
        {"iff", m_cpu.GetState().ints.iff},
        {"hlta", m_cpu.GetState().ints.hlta},
        };
        for (int i=0; i < IO::PALETTE_LEN; i++ ){
          out["palette"+std::to_string(i)] = Display::VectorColorToArgb(paletteP->bytes[i]);
        }
      break;
    }
    case HardwareReq.IS_MEMROM_ENABLED:
      out = {
        {"data", m_memory.IsRomEnabled() },
        };
      break;

    case HardwareReq.KEY_HANDLING:
    {
      auto op = m_io.GetKeyboard().KeyHandling(
        dataJ["scancode"], dataJ["action"]);

      if (op == Keyboard::Operation::RESET) {
        Reset();
      }
      else if (op == Keyboard::Operation::RESTART) {
        Restart();
      }
      break;
    }
    case HardwareReq.GET_SCROLL_VERT:
      out = {
        {"scrollVert", m_display.GetScrollVert()}
        };
      break;
*/
    case HardwareReq.LOAD_FDD:
      this._fdc?.Mount(data["driveIdx"], data["data"], data["path"]);
      break;

    case HardwareReq.RESET_UPDATE_FDD:
      this._fdc?.ResetUpdate(data["driveIdx"]);
      break;

    case HardwareReq.DEBUG_ATTACH:
      this.debugAttached = data["data"];
      break;

    default:
      if (this.DebugReqHandling && this._cpu && this._memory /*&& this.io && this._display*/){
        out = this.DebugReqHandling(req, data, this._cpu.state, this._memory.state/*, this.io.state, this.display.state*/);
      }
      break;
    }

    return out;
  }

  Reset()
  {
    this.Init();
    this._cpu?.Reset();
    this._audio?.Reset();
  }

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
  GetRegs() const
  -> nlohmann::json
  {
    auto& cpuState = m_cpu.GetState();
    nlohmann::json out {
      {"cc", cpuState.cc },
      {"pc", cpuState.regs.pc.word },
      {"sp", cpuState.regs.sp.word },
      {"af", cpuState.regs.psw.af.word },
      {"bc", cpuState.regs.bc.word },
      {"de", cpuState.regs.de.word },
      {"hl", cpuState.regs.hl.word },
      {"ints", cpuState.ints.data },
      {"m", m_memory.GetByte(cpuState.regs.hl.word, AddrSpace.RAM)}
    };
    return out;
  }

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

  GetByte(addrJ: ReqData, addrSpace: AddrSpace) ReqData
  {
    const addr = addrJ["addr"];
    const out = {
      "data": m_memory.GetByte(addr, addrSpace)
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

  GetWord(const nlohmann::json _addrJ, const Memory::AddrSpace _addrSpace)
  -> nlohmann::json
  {
    Addr addr = _addrJ["addr"];
    auto data = m_memory.GetByte(addr + 1, _addrSpace) << 8 | m_memory.GetByte(addr, _addrSpace);

    nlohmann::json out = {
      {"data", data}
    };
    return out;
  }

  GetStackSample(const nlohmann::json _addrJ)
  -> nlohmann::json
  {
    Addr addr = _addrJ["addr"];
    auto dataN10 = m_memory.GetByte(addr - 9, AddrSpace.STACK) << 8 | m_memory.GetByte(addr - 10, AddrSpace.STACK);
    auto dataN8 = m_memory.GetByte(addr - 7, AddrSpace.STACK) << 8 | m_memory.GetByte(addr - 8, AddrSpace.STACK);
    auto dataN6 = m_memory.GetByte(addr - 5, AddrSpace.STACK) << 8 | m_memory.GetByte(addr - 6, AddrSpace.STACK);
    auto dataN4 = m_memory.GetByte(addr - 3, AddrSpace.STACK) << 8 | m_memory.GetByte(addr - 4, AddrSpace.STACK);
    auto dataN2 = m_memory.GetByte(addr - 1, AddrSpace.STACK) << 8 | m_memory.GetByte(addr - 2, AddrSpace.STACK);
    auto data = m_memory.GetByte(addr + 1, AddrSpace.STACK) << 8 | m_memory.GetByte(addr, AddrSpace.STACK);
    auto dataP2 = m_memory.GetByte(addr + 3, AddrSpace.STACK) << 8 | m_memory.GetByte(addr + 2, AddrSpace.STACK);
    auto dataP4 = m_memory.GetByte(addr + 5, AddrSpace.STACK) << 8 | m_memory.GetByte(addr + 4, AddrSpace.STACK);
    auto dataP6 = m_memory.GetByte(addr + 7, AddrSpace.STACK) << 8 | m_memory.GetByte(addr + 6, AddrSpace.STACK);
    auto dataP8 = m_memory.GetByte(addr + 9, AddrSpace.STACK) << 8 | m_memory.GetByte(addr + 8, AddrSpace.STACK);
    auto dataP10 = m_memory.GetByte(addr + 11, AddrSpace.STACK) << 8 | m_memory.GetByte(addr + 10, AddrSpace.STACK);

    nlohmann::json out = {
      {"-10", dataN10},
      {"-8", dataN8},
      {"-6", dataN6},
      {"-4", dataN4},
      {"-2", dataN2},
      {"0", data},
      {"2", dataP2},
      {"4", dataP4},
      {"6", dataP6},
      {"8", dataP8},
      {"10", dataP10},
    };
    return out;
  }

  GetRam() const
  -> const Memory::Ram*
  {
    return m_memory.GetRam();
  }

  // UI thread. Non-blocking reading.
  GetFrame(const bool _vsync)
  ->const Display::FrameBuffer*
  {
    return m_display.GetFrame(_vsync);
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
  }
/*
  GetStepOverAddr()
  -> const Addr
  {
    auto pc = m_cpu.GetPC();
    auto sp = m_cpu.GetSP();
    auto opcode = m_memory.GetByte(pc);

    auto im_addr = m_memory.GetByte(pc + 2) << 8 | m_memory.GetByte(pc + 1);
    auto next_pc = pc + CpuI8080::GetInstrLen(opcode);

    switch (CpuI8080::GetInstrType(opcode))
    {
    case CpuI8080::OPTYPE_JMP:
      return im_addr;
    case CpuI8080::OPTYPE_RET:
      return m_memory.GetByte(sp + 1, AddrSpace.STACK) << 8 | m_memory.GetByte(sp, AddrSpace.STACK);
    case CpuI8080::OPTYPE_PCH:
      return m_cpu.GetHL();
    case CpuI8080::OPTYPE_RST:
      return opcode - CpuI8080::OPCODE_RST0;
    default:
      switch (opcode)
      {
      case CpuI8080::OPCODE_JNZ:
        return m_cpu.GetFlagZ() ? next_pc : im_addr;
      case CpuI8080::OPCODE_JZ:
        return m_cpu.GetFlagZ() ? im_addr : next_pc;
      case CpuI8080::OPCODE_JNC:
        return m_cpu.GetFlagC() ? next_pc : im_addr;
      case CpuI8080::OPCODE_JC:
        return m_cpu.GetFlagC() ? im_addr : next_pc;
      case CpuI8080::OPCODE_JPO:
        return m_cpu.GetFlagP() ? next_pc : im_addr;
      case CpuI8080::OPCODE_JPE:
        return m_cpu.GetFlagP() ? im_addr : next_pc;
      case CpuI8080::OPCODE_JP:
        return m_cpu.GetFlagS() ? next_pc : im_addr;
      case CpuI8080::OPCODE_JM:
        return m_cpu.GetFlagS() ? im_addr : next_pc;
      default:
        break;
      }
    }
    return next_pc;
  }
    */

  AttachDebugFuncs(debugFunc: DebugFunc , debugReqHandlingFunc: DebugReqHandlingFunc)
  {
    this.Debug = debugFunc;
    this.DebugReqHandling = debugReqHandlingFunc;
  }

  get display(): Display | undefined { return this._display; }
  get memory(): Memory | undefined { return this._memory; }
  get cpu(): CPU | undefined { return this._cpu; }
  get keyboard(): Keyboard | undefined { return this._keyboard; }
}
