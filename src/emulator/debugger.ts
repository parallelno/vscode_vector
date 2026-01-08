import { DebugFunc, DebugReqHandlingFunc } from "./hardware_types";

type DebugHardware = {
  AttachDebugFuncs: (debugFunc: DebugFunc, debugReqHandlingFunc: DebugReqHandlingFunc) => void;
  Request: (req: HardwareReq, data?: ReqData) => any;
};
import { HardwareReq } from './hardware_reqs';
import { CpuState } from './cpu_i8080';
import { MemState } from './memory';
import { ReqData } from './hardware_types';
import Breakpoints from './breakpoints';
import { BP_MEM_PAGES, BpCondition, BpOperand, BpStatus, Breakpoint } from './breakpoint';
import { DisplayState } from './display';
import { IOState } from './io';

/////////////////////////////////////////////////////////////
//
// Memory Access Log
//
/////////////////////////////////////////////////////////////

// Tracks memory access from last break
export class MemoryAccessLog {
  // addr -> [value, accessTimes]
  reads: Map<number, [number, number]>;
  writes: Map<number, [number, number]>;

  constructor() {
    this.reads = new Map<number, [number, number]>();
    this.writes = new Map<number, [number, number]>();
  }

  Reset(): void {
    this.reads.clear();
    this.writes.clear();
  }

  Read(addr: number, value: number): void {
    const entry = this.reads.get(addr);
    if (entry) {
      entry[1] += 1;
    } else {
      this.reads.set(addr, [value, 1]);
    }
  }

  Write(addr: number, value: number): void {
    const entry = this.writes.get(addr);
    if (entry) {
      entry[1] += 1;
    } else {
      this.writes.set(addr, [value, 1]);
    }
  }

  Clone(): MemoryAccessLog {
    const copy = new MemoryAccessLog();
    this.reads.forEach((value, key) => {
      // Deep copy the tuple
      copy.reads.set(key, [value[0], value[1]]);
    });
    this.writes.forEach((value, key) => {
      copy.writes.set(key, [value[0], value[1]]);
    });
    return copy;
  }
};


/////////////////////////////////////////////////////////////
//
// Debugger
//
/////////////////////////////////////////////////////////////

export default class Debugger {
  private hardware: DebugHardware;
  private _breakpoints = new Breakpoints();
  private _memAccessLog = new MemoryAccessLog();

  constructor(hardware: DebugHardware)
  {
    this.hardware = hardware;
    hardware.AttachDebugFuncs(this.Debug.bind(this), this.DebugReqHandling.bind(this));
  }

  Destructor() {
    this.hardware.Request(HardwareReq.DEBUG_ATTACH, {"data": false});
  }

  // Called from the Hardware thread
  // Has to be called after Hardware Reset, loading the rom file, fdd immage,
  // attach/dettach debugger, and other operations that change the Hardware
  // states because this func stores the last state of Hardware
  Reset(_resetRecorder: boolean,
    cpuState: CpuState, memState: MemState,
    ioState: IOState, displayState: DisplayState)
  {

    this._memAccessLog.Reset();

    // m_traceLog.Reset();
    // if (_resetRecorder) recorder.Reset(
    //   cpuState, memState, ioState, displayState);
  }

  // Hardware thread
  Debug(cpuState: CpuState, memState: MemState,
    ioState: IOState, displayState: DisplayState): boolean
  {
    // reads check
    for (let i = 0; i < memState.debug.readLen; i++)
    {
      const globalAddr = memState.debug.readGlobalAddr[i];
      const val = memState.debug.read[i];

      this._memAccessLog.Read(globalAddr, val);

      // TODO: implement watchpoints
      //this._debugData.GetWatchpoints().Check(Watchpoint::Access::R, globalAddr, val);
    }

    // writes check
    for (let i = 0; i < memState.debug.writeLen; i++)
    {
      const globalAddr = memState.debug.writeGlobalAddr[i];
      const val = memState.debug.write[i];

      this._memAccessLog.Write(globalAddr, val);

      // TODO: implement watchpoints
      //this._debugData.GetWatchpoints().Check(Watchpoint::Access::W, globalAddr, val);
    }
/*
    // code perf
    // TODO: check if the debugData window is open
    this._debugData.CheckCodePerfs(cpuState->regs.pc.word, cpuState->cc);
*/
    let break_ = false;
/*
    // check scripts
    // TODO: check if the debugData window is open
    break_ |= this._debugData.GetScripts().Check(
      cpuState, memState, ioState, displayState);

    // check watchpoint status
    break_ |= this._debugData.GetWatchpoints().CheckBreak();
*/
    // check breakpoints
    break_ ||= this._breakpoints.Check(cpuState, memState);
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
    ioState: IOState, displayState: DisplayState): ReqData
  {
    let out: ReqData = {};

    switch (req)
    {
    case HardwareReq.DEBUG_RESET:
      this.Reset(reqData["resetRecorder"], cpuState, memState, ioState, displayState);
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
      this._breakpoints.Clear();
      break;

    case HardwareReq.DEBUG_BREAKPOINT_DEL:
      this._breakpoints.Del(reqData["addr"]);
      break;

    case HardwareReq.DEBUG_BREAKPOINT_ADD: {
      const addr = reqData["addr"];
      if (addr === undefined) {
        break;
      }
      const pageIdx: boolean[] = new Array(BP_MEM_PAGES).fill(true);
      const status: BpStatus = reqData["status"] ?? BpStatus.ACTIVE;
      const autoDel = reqData["autoDel"] ?? false;
      const operand = reqData["operand"] ?? BpOperand.A;
      const cond = reqData["cond"] ?? BpCondition.ANY;
      const value = reqData["value"] ?? 0;
      const comment = reqData["comment"] ?? "";

      this._breakpoints.Add(new Breakpoint(addr, pageIdx, status, autoDel, operand, cond, value, comment));
      break;
    }
    case HardwareReq.DEBUG_BREAKPOINT_SET_STATUS:
      this._breakpoints.SetStatus(
        reqData["addr"], reqData["status"] );
      break;

    case HardwareReq.DEBUG_BREAKPOINT_ACTIVE:
      this._breakpoints.SetStatus(
        reqData["addr"], BpStatus.ACTIVE);
      break;

    case HardwareReq.DEBUG_BREAKPOINT_DISABLE:
      this._breakpoints.SetStatus(
        reqData["addr"], BpStatus.DISABLED);
      break;

    case HardwareReq.DEBUG_BREAKPOINT_GET_ALL:
      out = { "data": this._breakpoints.GetAll() };
      break;

    case HardwareReq.DEBUG_BREAKPOINT_GET_STATUS:
      out = {"status": this._breakpoints.GetStatus(reqData["addr"])};
      break;

    case HardwareReq.DEBUG_BREAKPOINT_GET_UPDATES:
      out = {"updates": this._breakpoints.updates};
      break;


    //////////////////
    //
    // Watchpoints
    //
    /////////////////
/*
    case HardwareReq.DEBUG_WATCHPOINT_DEL_ALL:
      this._debugData.GetWatchpoints().Clear();
      break;

    case HardwareReq.DEBUG_WATCHPOINT_DEL:
      this._debugData.GetWatchpoints().Del(reqData["id"]);
      break;

    case HardwareReq.DEBUG_WATCHPOINT_ADD: {
      Watchpoint::Data wpData{ reqData["data0"], reqData["data1"] };
      this._debugData.GetWatchpoints().Add({ std::move(wpData), reqData["comment"] });
      break;
    }
    case HardwareReq.DEBUG_WATCHPOINT_GET_UPDATES:
      out = nlohmann::json{ {"updates", static_cast<uint64_t>(this._debugData.GetWatchpoints().GetUpdates()) } };
      break;

    case HardwareReq.DEBUG_WATCHPOINT_GET_ALL:
      for (const auto& [id, wp] : this._debugData.GetWatchpoints().GetAll())
      {
        out.push_back({
            {"data0", wp.data.data0},
            {"data1", wp.data.data1},
            {"comment", wp.comment}
          });
      }
      break;
*/
    //////////////////
    //
    // Memory Access Log
    //
    /////////////////

    case HardwareReq.DEBUG_MEM_ACCESS_LOG_RESET:
      this._memAccessLog.Reset();
      break;

    case HardwareReq.DEBUG_MEM_ACCESS_LOG_GET:
      out = {"data": this._memAccessLog.Clone()};
      break;

/*
    case HardwareReq.DEBUG_MEMORY_EDIT_EXISTS:
      out = { {"data", this._debugData.GetMemoryEdit(reqData["addr"]) != nullptr } };
      break;

    //////////////////
    //
    // Code Perfs
    //
    /////////////////

    case HardwareReq.DEBUG_CODE_PERF_DEL_ALL:
      this._debugData.DelAllCodePerfs();
      break;

    case HardwareReq.DEBUG_CODE_PERF_DEL:
      this._debugData.DelCodePerf(reqData["addr"]);
      break;

    case HardwareReq.DEBUG_CODE_PERF_ADD:
      this._debugData.SetCodePerf(reqData);
      break;

    case HardwareReq.DEBUG_CODE_PERF_GET:
    {
      auto codePerf = this._debugData.GetCodePerf(reqData["addr"]);
      if (codePerf)
      {
        out = { {"data", codePerf->ToJson()} };
      }
      break;
    }

    case HardwareReq.DEBUG_CODE_PERF_EXISTS:
      out = { {"data", this._debugData.GetCodePerf(reqData["addr"]) != nullptr } };
      break;

    //////////////////
    //
    // Scripts
    //
    /////////////////

    case HardwareReq.DEBUG_SCRIPT_DEL_ALL:
      this._debugData.GetScripts().Clear();
      break;

    case HardwareReq.DEBUG_SCRIPT_DEL:
      this._debugData.GetScripts().Del(reqData["id"]);
      break;

    case HardwareReq.DEBUG_SCRIPT_ADD: {
      this._debugData.GetScripts().Add(reqData);
      break;
    }
    case HardwareReq.DEBUG_SCRIPT_GET_UPDATES:
      out = nlohmann::json{ {"updates", static_cast<uint64_t>(this._debugData.GetScripts().GetUpdates()) } };
      break;

    case HardwareReq.DEBUG_SCRIPT_GET_ALL:
      for (const auto& [id, script] : this._debugData.GetScripts().GetAll())
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
