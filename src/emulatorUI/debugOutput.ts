import * as CpuI8080 from "../emulator/cpu_i8080";
import { Hardware } from "../emulator/hardware";
import { HardwareReq } from "../emulator/hardware_reqs";


// helper: read cpu/memory state and return a compact debug object
export function getDebugState(hardware: Hardware)
: { global_addr: number,
    state: CpuI8080.CpuState,
    instr_bytes: number[]}
{
  const state: CpuI8080.CpuState = hardware?.Request(HardwareReq.GET_CPU_STATE)["data"] ?? new CpuI8080.CpuState();
  //const mem_debug_state = hardware?.Request(HardwareReq.GET_MEM_DEBUG_STATE)["data"] ?? new MemDebug();
  const global_addr = hardware?.Request(HardwareReq.GET_GLOBAL_ADDR_RAM, {'addr': state.regs.pc.word})["data"] ?? 0;
  const instr_bytes = hardware?.Request(HardwareReq.GET_INSTR)["data"] ?? [0];

  return { global_addr, state, instr_bytes};
}

// helper: format a single debug line from hardware state
export function getDebugLine(hardware: Hardware)
: string
{
    const s = getDebugState(hardware!);
    const cc = s.state.cc;

    const addrHex = s.global_addr.toString(16).toUpperCase().padStart(6, '0');
    const opHex = s.instr_bytes[0].toString(16).toUpperCase().padStart(2, '0');
    const byteHex1 = s.instr_bytes.length > 1 ?
                    s.instr_bytes[1].toString(16).toUpperCase().padStart(2, '0') :
                    '  ';
    const byteHex2 = s.instr_bytes.length > 2 ?
                    s.instr_bytes[2].toString(16).toUpperCase().padStart(2, '0') :
                    '  ';

    const display_data = hardware.Request(HardwareReq.GET_DISPLAY_DATA);
    const x = display_data["rasterPixel"];
    const y = display_data["rasterLine"];
    const scrollIdx = display_data["scrollIdx"];

    const line = `${addrHex}  ${opHex} ${byteHex1} ${byteHex2}  `+
      `A=${(s.state.regs.af.a).toString(16).toUpperCase().padStart(2,'0')} `+
      `BC=${(s.state.regs.bc.word).toString(16).toUpperCase().padStart(4,'0')} `+
      `DE=${(s.state.regs.de.word).toString(16).toUpperCase().padStart(4,'0')} `+
      `HL=${(s.state.regs.hl.word).toString(16).toUpperCase().padStart(4,'0')} `+
      `SP=${(s.state.regs.sp.word).toString(16).toUpperCase().padStart(4,'0')} ` +
      `S${s.state.regs.af.s ? '1' : '0'} ` +
      `Z${s.state.regs.af.z ? '1' : '0'} ` +
      `AC${s.state.regs.af.ac ? '1' : '0'} ` +
      `P${s.state.regs.af.p ? '1' : '0'} ` +
      `CY${s.state.regs.af.c ? '1' : '0'} ` +
      `CC=${cc.toString(10).toUpperCase().padStart(12,'0')} ` +
      `scr=${x.toString(10).toUpperCase().padStart(3,'0')}/` +
      `${y.toString(10).toUpperCase().padStart(3,'0')} ` +
      `scrl=${scrollIdx.toString(16).toUpperCase().padStart(2,'0')}`;

    return line;
}