import { CpuState } from "./cpu_i8080";
import { HardwareReq } from "./hardware_reqs";
import { MemState } from "./memory";

export type ReqData = {
  [ key: string ]: any
};

export type DebugFunc = ((cpuState: CpuState , memoryState: MemState/*, ioState: IO.State, displayState: Display.State*/) => boolean);
export type DebugReqHandlingFunc =
  ((req: HardwareReq,
    data: ReqData,
    cpuState: CpuState ,
    memoryState: MemState/*,
    ioState: IO.State,
    displayState: Display.State*/) => ReqData);