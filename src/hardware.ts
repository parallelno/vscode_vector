import CPU from './cpu_i8080';
import Memory from './memory';
import { Keyboard } from './keyboard';
import IO from './io';
import { Display } from './display';
import { HardwareReq } from './hardware_reqs';
import { ReqData } from './hardware_types';

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

  cpu?: CPU;
  memory?: Memory;
  keyboard?: Keyboard;
  io?: IO;
  _display?: Display;

  constructor(
    pathBootData: string,
    ramDiskDataPath: string,
    ramDiskClearAfterRestart: boolean)
  {
    this.memory = new Memory(
      pathBootData, ramDiskDataPath, ramDiskClearAfterRestart);
    this.keyboard = new Keyboard();
    this.io = new IO();
    this.cpu = new CPU(
      this.memory, this.io.PortIn.bind(this.io), this.io.PortOut.bind(this.io));
    this._display = new Display(this.memory, this.io);

    this.Init();
    this.Execution();
  }

  Destructor()
  {
    this.ReqHandling(HardwareReq.EXIT);
  }

  // when HW needs Reset
  Init()
  {
    this.memory?.Init();
    this._display?.Init();
    this.io?.Init();
  }

  // TODO:
  // 1. reload, reset, update the palette, and other non-hardware-initiated
  //    operations have to reset the playback history
  // 2. navigation. show data as data blocks in the disasm. take the list from the watchpoints
  // 3. aggregation of consts, labels, funcs with default names
  async Execution()
  {
    while (this.status != Status.EXIT)
    {
      let startCC = this.cpu?.cc ?? 0;
      let startFrame = this._display?.frameNum ?? 0;
      let startTime = performance.now();
      let endFrameTime = performance.now();

      while (this.status == Status.RUN)
      {
        let startFrameTime = performance.now();

        let frameNum = this._display?.frameNum ?? 0;

        do // rasterizes a frame
        {
          if (this.ExecuteInstruction())
          {
            this.Stop();
            break;
          };

        } while (this.status == Status.RUN &&
                this._display?.frameNum == frameNum);

        // vsync
        if (this.status == Status.RUN)
        {
          let currentTime = performance.now();
            let frameExecutionDuration = currentTime - startFrameTime;

          let targetFrameDuration = execDelays[this.execSpeed];

          let frameDuration = Math.max(
            frameExecutionDuration,
            targetFrameDuration
          );

          endFrameTime += frameDuration;

          while (performance.now() < endFrameTime)
          {
            await new Promise(resolve => setTimeout(resolve, 1));
          }
        }
      }

      // print out the break statistics
      let elapsedCC = (this.cpu?.cc ?? 0) - startCC;
      if (elapsedCC)
      {
        let elapsedFrames = (this._display?.frameNum ?? 0) - startFrame;
        let elapsedTime = performance.now() - startTime;
        let timeDurationSec = elapsedTime / 1000.0;
        console.log(`Break: elapsed cpu cycles: ${elapsedCC}, elapsed frames: ${elapsedFrames}, elapsed seconds: ${timeDurationSec}`);
      }

      while (this.status == Status.STOP)
      {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }


  // Output true if the execution breaks
  ExecuteInstruction(): boolean
  {
    // mem debug init
    //this.memory?.DebugInit();

    do
    {
      this._display?.Rasterize();
      this.cpu?.ExecuteMachineCycle(this._display?.IsIRQ() ?? false);
      // TODO: add audio support
      //this.audio?.Clock(2, this.io?.GetBeeper() ?? false);

    } while (!this.cpu?.IsInstructionExecuted());

    // debug per instruction
    /*
    // TODO: fix the debug later
    if (this.debugAttached &&
      this.debug?.(this.cpu.GetStateP(), this.memory.GetStateP(), this.io.GetStateP(), this._display.GetStateP()) )
    {
      return true;
    }
    */

    if (this.memory?.IsException())
    {
      this.memory.InitRamDiskMapping(); // reset RAM Disk mode collision
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
      this.ExecuteFrameNoBreaks();
      break;
    }
    case HardwareReq.GET_CC:
      out = {"cc": this.cpu?.cc };
      break;

/*
    case HardwareReq.GET_REGS:
      out = this.GetRegs();
      break;

    case HardwareReq.GET_REG_PC:
      out = {"pc": this.cpu?.GetPC() };
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
        {"mapping", this.memory.GetState().update.mapping.data},
        {"ramdiskIdx", this.memory.GetState().update.ramdiskIdx},
        };
      break;

    case HardwareReq.GET_MEMORY_MAPPINGS:{
      auto mappingsP = this.memory.GetMappingsP();
      out = {{"ramdiskIdx", this.memory.GetState().update.ramdiskIdx}};
      for (auto i=0; i < Memory::RAM_DISK_MAX; i++) {
        out["mapping"+std::to_string(i)] = mappingsP[i].data;
      }
      break;
    }
    case HardwareReq.GET_GLOBAL_ADDR_RAM:
      out = {
        {"data", this.memory.GetGlobalAddr(dataJ["addr"], AddrSpace.RAM)}
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
      this.memory?.SetRam(data["addr"], data["data"]);
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

    case HardwareReq.LOAD_FDD:
      m_fdc.Mount(dataJ["driveIdx"], dataJ["data"], dataJ["path"]);
      break;

    case HardwareReq.RESET_UPDATE_FDD:
      m_fdc.ResetUpdate(dataJ["driveIdx"]);
      break;

    case HardwareReq.DEBUG_ATTACH:
      m_debugAttached = dataJ["data"];
      break;
*/
    default:
      //out = DebugReqHandling(req, dataJ, m_cpu.GetStateP(), m_memory.GetStateP(), m_io.GetStateP(), m_display.GetStateP());
    }

    return out;
  }

  Reset()
  {
    this.Init();
    this.cpu?.Reset();
    // TODO: add support for audio
    //this.audio?.Reset();
  }

  Restart()
  {
    this.cpu?.Reset();
    // TODO: add support for audio
    //this.audio?.Reset();
    this.memory?.Restart();
  }

  Stop()
  {
    this.status = Status.STOP;
    // TODO: add support for audio
    //this.audio?.Pause(true);
  }

  // to continue execution
  Run()
  {
    this.status = Status.RUN;
    // TODO: add support for audio
    //this.audio?.Pause(false);
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
  ExecuteFrameNoBreaks()
  {
    const frameNum: number = this._display?.frameNum ?? 0;
    do {
      this.ExecuteInstruction();
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

  get display(): Display | undefined { return this._display; }
}
