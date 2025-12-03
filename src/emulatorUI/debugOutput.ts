import CPU, { CpuState } from "../cpu_i8080";
import { FRAME_W } from "../display";
import { Hardware } from "../hardware";
import { AddrSpace } from "../memory";

// helper: read cpu/memory state and return a compact debug object
export function getDebugState(hardware: Hardware)
{
  const state = hardware?.cpu?.state ?? new CpuState();
  const pc = state.regs.pc.word;
  const global_addr = hardware?.memory?.GetGlobalAddr(pc, AddrSpace.RAM) ?? 0;
  const opcode = hardware?.memory?.GetByte(pc) ?? 0;
  const byte1 = hardware?.memory?.GetByte(pc + 1) ?? 0;
  const byte2 = hardware?.memory?.GetByte(pc + 2) ?? 0;
  const instr_len = CPU.GetInstrLen(opcode);
  return { global_addr, state, opcode, byte1, byte2, instr_len};
}



export function getDebugLine(hardware: Hardware): string {
  let line = '';
  try {
      const s = getDebugState(hardware!);

      const addrHex = s.global_addr.toString(16).toUpperCase().padStart(6, '0');
      const opHex = s.opcode.toString(16).toUpperCase().padStart(2, '0');
      const byteHex1 = s.instr_len > 1 ?
                      s.byte1.toString(16).toUpperCase().padStart(2, '0') :
                      '  ';
      const byteHex2 = s.instr_len > 2 ?
                      s.byte2.toString(16).toUpperCase().padStart(2, '0') :
                      '  ';
      const framebufferIdx = hardware.display ? hardware.display.framebufferIdx : 0;
      const x = framebufferIdx % FRAME_W;
      const y = (framebufferIdx / FRAME_W) | 0;
      const scrollIdx = hardware.display ? hardware.display.scrollIdx : 0;
      const cc = s.state.cc;

      line = `${addrHex}  ${opHex} ${byteHex1} ${byteHex2}  `+
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
    }
    catch (e) {
      return '(error reading state)';
    }

    return line;
}