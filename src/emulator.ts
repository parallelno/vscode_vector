import CPU from './cpu';

// Thin wrapper kept for compatibility: previous code imported `{ Emulator }` from
// `./emulator`. We expose `Emulator` which composes the new `CPU` class and
// forwards the commonly used properties and methods (memory, regs, load,
// runCycles, breakpoints, cycles).
export class Emulator {
  cpu: CPU;
  constructor() {
    this.cpu = new CPU();
  }

  get memory() { return this.cpu.memory; }
  get regs() { return this.cpu.regs; }
  get cycles() { return this.cpu.cycles; }
  get breakpoints() { return this.cpu.breakpoints; }
  get isRunning() { return this.cpu.isRunning; }

  load(buffer: Buffer, address = 0) { return this.cpu.load(buffer, address); }
  runCycles(target: number, cb?: (cyclesAdvanced: number) => void) { return this.cpu.runCycles(target, cb); }
  step() {
    const addr = this.cpu.regs.PC;
    const opcode = this.cpu.readByte(addr);
    const res = this.cpu.step();
    if (this.cpu.onInstruction) this.cpu.onInstruction({ addr, opcode, regs: this.cpu.snapshotRegs() });
    return res;
  }
  runUntilBreakpointOrHalt(maxSteps = 100000) { return this.cpu.runUntilBreakpointOrHalt(maxSteps); }
}
