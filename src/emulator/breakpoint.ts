import { CpuState } from "./cpu_i8080";
import { MemState, RAM_DISK_MAX, RAMDISK_PAGES_MAX } from "./memory";

// mem pages to check.
// 1 main memory + ramdisk pages
const mem_pages = 1 + RAMDISK_PAGES_MAX * RAM_DISK_MAX;

export enum BpStatus {
  DISABLED = 0,
  ACTIVE,
  DELETED,
  COUNT,
};

enum BpOperand { A = 0, F, B, C, D, E, H, L, PSW, BC, DE, HL, CC, SP, COUNT };
enum BpCondition { ANY = 0, EQU, LESS, GREATER, LESS_EQU, GREATER_EQU, NOT_EQU, INVALID, COUNT };


export class Breakpoint {
  addr: number = 0;
  pageIdx: boolean[] = new Array(mem_pages).fill(true);
  status: BpStatus = BpStatus.ACTIVE;
	autoDel: boolean = false;
  operand: BpOperand = BpOperand.A;
  cond: BpCondition = BpCondition.ANY;
  value: number = 0;
  comment: string = "";

  constructor(
    addr: number,
    pageIdx: boolean[] = new Array(mem_pages).fill(true),
    status: BpStatus = BpStatus.ACTIVE,
    autoDel: boolean = false,
    operand: BpOperand = BpOperand.A,
    cond: BpCondition = BpCondition.ANY,
    value: number = 0,
    comment: string = ""
  ) {
    this.addr = addr;
    this.pageIdx = pageIdx;
    this.status = status;
    this.autoDel = autoDel;
    this.operand = operand;
    this.cond = cond;
    this.value = value;
    this.comment = comment;
  }

  Update(newBp: Breakpoint): void {
    this.addr = newBp.addr;
    this.pageIdx = newBp.pageIdx.slice();
    this.status = newBp.status;
    this.autoDel = newBp.autoDel;
    this.operand = newBp.operand;
    this.cond = newBp.cond;
    this.value = newBp.value;
    this.comment = newBp.comment;
  }

  CheckStatus(cpuState: CpuState, memState: MemState): boolean
  {
    const mapping = memState.update.mappings[memState.update.ramdiskIdx];
    const pageIdx = 1 + mapping.pageRam + 4 * memState.update.ramdiskIdx;

    let active = this.status == BpStatus.ACTIVE && this.pageIdx[pageIdx];
    if (!active) return false;

    if (this.cond == BpCondition.ANY) return true;

    let op: number;
    switch (this.operand)
    {
    case BpOperand.A:
      op = cpuState.regs.af.a;
      break;
    case BpOperand.F:
      op = cpuState.regs.af.f;
      break;
    case BpOperand.B:
      op = cpuState.regs.bc.h;
      break;
    case BpOperand.C:
      op = cpuState.regs.bc.l;
      break;
    case BpOperand.D:
      op = cpuState.regs.de.h;
      break;
    case BpOperand.E:
      op = cpuState.regs.de.l;
      break;
    case BpOperand.H:
      op = cpuState.regs.hl.h;
      break;
    case BpOperand.L:
      op = cpuState.regs.hl.l;
      break;
    case BpOperand.PSW:
      op = cpuState.regs.af.word;
      break;
    case BpOperand.BC:
      op = cpuState.regs.bc.word;
      break;
    case BpOperand.DE:
      op = cpuState.regs.de.word;
      break;
    case BpOperand.HL:
      op = cpuState.regs.hl.word;
      break;
    case BpOperand.CC:
      op = cpuState.cc;
      break;
    case BpOperand.SP:
      op = cpuState.regs.sp.word;
      break;
    default:
      op = 0;
      break;
    }

    switch (this.cond)
    {
    case BpCondition.EQU:
      return op == this.value;
    case BpCondition.LESS:
      return op < this.value;
    case BpCondition.GREATER:
      return op > this.value;
    case BpCondition.LESS_EQU:
      return op <= this.value;
    case BpCondition.GREATER_EQU:
      return op >= this.value;
    case BpCondition.NOT_EQU:
      return op != this.value;
    }
    return false;
  }
}