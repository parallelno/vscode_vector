import { Breakpoint } from './breakpoint';
import { CpuState } from './cpu_i8080';
import { MemState } from './memory';
import { BpStatus } from './breakpoint';


export default class Breakpoints {
  private _breakpoints = new Map<number, Breakpoint>();
  private _updates: number = 0;

  Add(bp: Breakpoint): void {
    this._updates++;
    if (this._breakpoints.has(bp.addr)) {
      let old_bp = this._breakpoints.get(bp.addr)!;
      old_bp.Update(bp);
    }
    this._breakpoints.set(bp.addr, bp);
  }

  Del(addr: number): void {
    if (this._breakpoints.delete(addr)) {
      this._updates++;
    }
  }

  Check(cpuState: CpuState, memState: MemState): boolean {
    let bp = this._breakpoints.get(cpuState.regs.pc.word)
    if (bp === undefined) return false;

    let status = bp.CheckStatus(cpuState, memState);

    if (bp.autoDel) {
      this.Del(bp.addr);
      this._updates++;
    }

    return status;
  }

  Clear(): void {
    this._breakpoints.clear();
    this._updates++;
  }

  GetStatus(addr: number): BpStatus{
    return this._breakpoints.get(addr)?.status ?? BpStatus.DELETED;
  }

  SetStatus(addr: number, status: BpStatus){
    this._updates++;
    let bp = this._breakpoints.get(addr);
    if (bp !== undefined) {
      bp.status = status;
      return;
    }
    this._breakpoints.set(addr, new Breakpoint(addr));
  }

  get updates (): number {
    return this._updates;
  }

}