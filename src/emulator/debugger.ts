import { Hardware } from './hardware';
import { HardwareReq } from './hardware_reqs';
import { CpuState } from './cpu_i8080';
import { MemState } from './memory';
import { ReqData } from './hardware_types';
import DebugData from '../debugData';
import { BpStatus, Breakpoint } from './breakpoint';


export default class Debugger {
  hardware: Hardware;
  debugData: DebugData;

  constructor(hardware: Hardware)
  {
    this.hardware = hardware;
    this.debugData = new DebugData(hardware);
    hardware.AttachDebugFuncs(this.Debug.bind(this), this.DebugReqHandling.bind(this));
  }

  destructor() {
    this.hardware.Request(HardwareReq.DEBUG_ATTACH, {"data": false});
  }

  // Called from the Hardware thread
  // Has to be called after Hardware Reset, loading the rom file, fdd immage,
  // attach/dettach debugger, and other operations that change the Hardware
  // states because this func stores the last state of Hardware
  Reset(_resetRecorder: boolean,
    cpuState: CpuState, memState: MemState
    /*, IO::State* ioState, Display::State* displayState*/)
  {
    //this.disasm.Reset();
    this.debugData.Reset();

    // m_lastWritesAddrs.fill(uint32_t(LAST_RW_NO_DATA));
    // m_lastReadsAddrs.fill(uint32_t(LAST_RW_NO_DATA));
    // m_lastWritesIdx = 0;
    // m_lastReadsIdx = 0;
    // m_memLastRW.fill(0);

    // m_traceLog.Reset();
    // if (_resetRecorder) recorder.Reset(
    //   cpuState, memState, ioState, displayState);
  }

  //////////////////////////////////////////////////////////////
  //
  // Debug call from the Hardware thread
  //
  //////////////////////////////////////////////////////////////

  // Hardware thread
  Debug(cpuState: CpuState, memState: MemState,
    /*ioState: IOState, displayState: DisplayState*/): boolean
  {
    /*
    // instruction check
    this.debugData.MemRunsUpdate(memState.debug.instrGlobalAddr);

    // reads check
    {
      //std::lock_guard<std::mutex> mlock(m_lastRWMutex);

      for (int i = 0; i < memState.debug.readLen; i++)
      {
        GlobalAddr globalAddr = memState.debug.readGlobalAddr[i];
        uint8_t val = memState.debug.read[i];

        this.debugData.MemReadsUpdate(globalAddr);

        this.debugData.GetWatchpoints().Check(Watchpoint::Access::R, globalAddr, val);

        m_lastReadsAddrs[m_lastReadsIdx++] = globalAddr;
        m_lastReadsIdx %= LAST_RW_MAX;
      }
    }

    // writes check
    {
      std::lock_guard<std::mutex> mlock(m_lastRWMutex);

      for (int i = 0; i < memState.debug.writeLen; i++)
      {
        GlobalAddr globalAddr = memState.debug.writeGlobalAddr[i];
        uint8_t val = memState.debug.write[i];

        // check if the memory is read-only
        auto memEdit = this.debugData.GetMemoryEdit(globalAddr);
        if (memEdit && memEdit->active && memEdit->readonly) {
          memState.debug.write[i] = memState.debug.beforeWrite[i];
          memState.ramP->at(globalAddr) = memState.debug.beforeWrite[i];
          continue;
        };

        this.debugData.MemWritesUpdate(globalAddr);

        this.debugData.GetWatchpoints().Check(Watchpoint::Access::W, globalAddr, val);

        m_lastWritesAddrs[m_lastWritesIdx++] = globalAddr;
        m_lastWritesIdx %= LAST_RW_MAX;
      }
    }

    // code perf
    // TODO: check if the debugData window is open
    this.debugData.CheckCodePerfs(cpuState->regs.pc.word, cpuState->cc);
*/
    let break_ = false;
/*
    // check scripts
    // TODO: check if the debugData window is open
    break_ |= this.debugData.GetScripts().Check(
      cpuState, memState, ioState, displayState);

    // check watchpoint status
    break_ |= this.debugData.GetWatchpoints().CheckBreak();
*/
    // check breakpoints
    break_ ||= this.debugData.breakpoints.Check(cpuState, memState);
/*
    // tracelog
    m_traceLog.Update(*cpuState, *memState, *displayState);

    // recorder
    recorder.Update(cpuState, memState, ioState, displayState);
*/
    return break_;
  }

  // Hardware thread
  DebugReqHandling(req: HardwareReq, reqData: ReqData,
    cpuState: CpuState, memState: MemState,
    /*ioState: IOState, displayState: DisplayState*/): ReqData
  {
    let out: ReqData = {};

    switch (req)
    {
    case HardwareReq.DEBUG_RESET:
      this.Reset(reqData["resetRecorder"], cpuState, memState/*, ioState, displayState*/);
      break;

    //////////////////
    //
    // Recorder
    //
    /////////////////
/*
    case HardwareReq.DEBUG_RECORDER_RESET:
      recorder.Reset(cpuState, memState, ioState, displayState);
      break;

    case HardwareReq.DEBUG_RECORDER_PLAY_FORWARD:
      recorder.PlayForward(reqData["frames"], cpuState, memState,
                  ioState, displayState);
      break;

    case HardwareReq.DEBUG_RECORDER_PLAY_REVERSE:
      recorder.PlayReverse(reqData["frames"], cpuState, memState,
                  ioState, displayState);
      break;

    case HardwareReq.DEBUG_RECORDER_GET_STATE_RECORDED:
      out = nlohmann::json{ {"states", recorder.GetStateRecorded() } };
      break;

    case HardwareReq.DEBUG_RECORDER_GET_STATE_CURRENT:
      out = nlohmann::json{ {"states", recorder.GetStateCurrent() } };
      break;

    case HardwareReq.DEBUG_RECORDER_SERIALIZE: {

      out = nlohmann::json{ {"data", nlohmann::json::binary(recorder.Serialize()) } };
      break;
    }
    case HardwareReq.DEBUG_RECORDER_DESERIALIZE: {

      nlohmann::json::binary_t binaryData =
        reqData["data"].get<nlohmann::json::binary_t>();

      std::vector<uint8_t> data(binaryData.begin(), binaryData.end());

      recorder.Deserialize(data, cpuState, memState, ioState, displayState);
      break;
    }
*/
    //////////////////
    //
    // Breakpoints
    //
    /////////////////

    case HardwareReq.DEBUG_BREAKPOINT_DEL_ALL:
      this.debugData.breakpoints.Clear();
      break;

    case HardwareReq.DEBUG_BREAKPOINT_DEL:
      this.debugData.breakpoints.Del(reqData["addr"]);
      break;

    case HardwareReq.DEBUG_BREAKPOINT_ADD: {
      this.debugData.breakpoints.Add(new Breakpoint(reqData["addr"]));
      break;
    }
    case HardwareReq.DEBUG_BREAKPOINT_SET_STATUS:
      this.debugData.breakpoints.SetStatus(
        reqData["addr"], reqData["status"] );
      break;

    case HardwareReq.DEBUG_BREAKPOINT_ACTIVE:
      this.debugData.breakpoints.SetStatus(
        reqData["addr"], BpStatus.ACTIVE);
      break;

    case HardwareReq.DEBUG_BREAKPOINT_DISABLE:
      this.debugData.breakpoints.SetStatus(
        reqData["addr"], BpStatus.DISABLED);
      break;

    case HardwareReq.DEBUG_BREAKPOINT_GET_STATUS:
      out = {"status": this.debugData.breakpoints.GetStatus(reqData["addr"])};
      break;

    case HardwareReq.DEBUG_BREAKPOINT_GET_UPDATES:
      out = {"updates": this.debugData.breakpoints.updates};
      break;


    //////////////////
    //
    // Watchpoints
    //
    /////////////////
/*
    case HardwareReq.DEBUG_WATCHPOINT_DEL_ALL:
      this.debugData.GetWatchpoints().Clear();
      break;

    case HardwareReq.DEBUG_WATCHPOINT_DEL:
      this.debugData.GetWatchpoints().Del(reqData["id"]);
      break;

    case HardwareReq.DEBUG_WATCHPOINT_ADD: {
      Watchpoint::Data wpData{ reqData["data0"], reqData["data1"] };
      this.debugData.GetWatchpoints().Add({ std::move(wpData), reqData["comment"] });
      break;
    }
    case HardwareReq.DEBUG_WATCHPOINT_GET_UPDATES:
      out = nlohmann::json{ {"updates", static_cast<uint64_t>(this.debugData.GetWatchpoints().GetUpdates()) } };
      break;

    case HardwareReq.DEBUG_WATCHPOINT_GET_ALL:
      for (const auto& [id, wp] : this.debugData.GetWatchpoints().GetAll())
      {
        out.push_back({
            {"data0", wp.data.data0},
            {"data1", wp.data.data1},
            {"comment", wp.comment}
          });
      }
      break;

    //////////////////
    //
    // Memory Edits
    //
    /////////////////

    case HardwareReq.DEBUG_MEMORY_EDIT_DEL_ALL:
      this.debugData.DelAllMemoryEdits();
      break;

    case HardwareReq.DEBUG_MEMORY_EDIT_DEL:
      this.debugData.DelMemoryEdit(reqData["addr"]);
      break;

    case HardwareReq.DEBUG_MEMORY_EDIT_ADD:
      this.debugData.SetMemoryEdit(reqData);
      break;

    case HardwareReq.DEBUG_MEMORY_EDIT_GET:
    {
      auto memEdit = this.debugData.GetMemoryEdit(reqData["addr"]);
      if (memEdit)
      {
        out = { {"data", memEdit->ToJson()} };
      }
      break;
    }

    case HardwareReq.DEBUG_MEMORY_EDIT_EXISTS:
      out = { {"data", this.debugData.GetMemoryEdit(reqData["addr"]) != nullptr } };
      break;

    //////////////////
    //
    // Code Perfs
    //
    /////////////////

    case HardwareReq.DEBUG_CODE_PERF_DEL_ALL:
      this.debugData.DelAllCodePerfs();
      break;

    case HardwareReq.DEBUG_CODE_PERF_DEL:
      this.debugData.DelCodePerf(reqData["addr"]);
      break;

    case HardwareReq.DEBUG_CODE_PERF_ADD:
      this.debugData.SetCodePerf(reqData);
      break;

    case HardwareReq.DEBUG_CODE_PERF_GET:
    {
      auto codePerf = this.debugData.GetCodePerf(reqData["addr"]);
      if (codePerf)
      {
        out = { {"data", codePerf->ToJson()} };
      }
      break;
    }

    case HardwareReq.DEBUG_CODE_PERF_EXISTS:
      out = { {"data", this.debugData.GetCodePerf(reqData["addr"]) != nullptr } };
      break;

    //////////////////
    //
    // Scripts
    //
    /////////////////

    case HardwareReq.DEBUG_SCRIPT_DEL_ALL:
      this.debugData.GetScripts().Clear();
      break;

    case HardwareReq.DEBUG_SCRIPT_DEL:
      this.debugData.GetScripts().Del(reqData["id"]);
      break;

    case HardwareReq.DEBUG_SCRIPT_ADD: {
      this.debugData.GetScripts().Add(reqData);
      break;
    }
    case HardwareReq.DEBUG_SCRIPT_GET_UPDATES:
      out = nlohmann::json{ {"updates", static_cast<uint64_t>(this.debugData.GetScripts().GetUpdates()) } };
      break;

    case HardwareReq.DEBUG_SCRIPT_GET_ALL:
      for (const auto& [id, script] : this.debugData.GetScripts().GetAll())
      {
        out.push_back(script.ToJson());
      }
      break;

    //////////////////
    //
    // Trace Log
    //
    /////////////////

    case HardwareReq.DEBUG_TRACE_LOG_ENABLE:
      m_traceLog.SetSaveLog(true, reqData["path"]);
      break;

    case HardwareReq.DEBUG_TRACE_LOG_DISABLE:
      m_traceLog.SetSaveLog(false);
      break;
*/
    default:
      break;
    }

    return out;
  }
}