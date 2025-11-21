import Memory, { AddrSpace } from './memory';

export type Registers = {
  A: number;
  B: number;
  C: number;
  D: number;
  E: number;
  H: number;
  L: number;
  SP: number;
  PC: number;
  flags: { Z: boolean; S: boolean; P: boolean; CY: boolean; AC: boolean };
};

export default class CPU {
  memory: Memory;
  regs: Registers;
  io?: any;
  interruptsEnabled = false;
  running = false;
  breakpoints = new Set<number>();
  // cycle counter (CPU cycles)
  cycles = 0;
  // Optional hook: called after each executed instruction when available.
  onInstruction?: (info: { addr: number; opcode: number; regs: Registers }) => void;

  // Precomputed parity table (true = even parity). Use this instead of
  // recomputing parity bit-by-bit for speed and to match the C++ table.
  private static readonly PARITY_TABLE: boolean[] = (() => {
    const t: boolean[] = new Array(256);
    for (let i = 0; i < 256; i++) {
      let p = 0;
      let v = i;
      for (let b = 0; b < 8; b++) {
        if (v & (1 << b)) p++;
      }
      t[i] = (p % 2) === 0;
    }
    return t;
  })();

  constructor() {
    this.memory = new Memory();
    this.regs = { A: 0, B: 0, C: 0, D: 0, E: 0, H: 0, L: 0, SP: 0x0000, PC: 0, flags: { Z: false, S: false, P: false, CY: false, AC: false } };
  }

  load(buffer: Buffer, address = 0) {
    this.memory.loadRom(buffer, address);
    this.setPC(address);
  }

  readByte(addr: number, addrSpace: AddrSpace = AddrSpace.RAM) { return this.memory.getByte(addr & 0xffff, addrSpace); }
  writeByte(addr: number, v: number, addrSpace: AddrSpace = AddrSpace.RAM) { this.memory.writeByte(addr & 0xffff, v & 0xff, addrSpace); }

  getReg(code: number) {
    switch (code) {
      case 0: return this.regs.B;
      case 1: return this.regs.C;
      case 2: return this.regs.D;
      case 3: return this.regs.E;
      case 4: return this.regs.H;
      case 5: return this.regs.L;
      case 6: // M (memory at HL)
        const hl = (this.regs.H << 8) | this.regs.L;
        return this.readByte(hl);
      case 7: return this.regs.A;
    }
    return 0;
  }

  setReg(code: number, val: number) {
    val &= 0xff;
    switch (code) {
      case 0: this.regs.B = val; break;
      case 1: this.regs.C = val; break;
      case 2: this.regs.D = val; break;
      case 3: this.regs.E = val; break;
      case 4: this.regs.H = val; break;
      case 5: this.regs.L = val; break;
      case 6: // M
        const hl = (this.regs.H << 8) | this.regs.L;
        this.writeByte(hl, val); break;
      case 7: this.regs.A = val; break;
    }
    // Do not change flags on plain register write; instructions explicitly update flags.
  }

  // Helper: parity (true if even number of 1 bits) - use lookup table
  parityEven(v: number) { return CPU.PARITY_TABLE[v & 0xff]; }

  // Return a shallow snapshot copy of registers suitable for logging.
  snapshotRegs(): Registers {
    return {
      A: this.regs.A,
      B: this.regs.B,
      C: this.regs.C,
      D: this.regs.D,
      E: this.regs.E,
      H: this.regs.H,
      L: this.regs.L,
      SP: this.regs.SP,
      PC: this.regs.PC,
      flags: { Z: this.regs.flags.Z, S: this.regs.flags.S, P: this.regs.flags.P, CY: this.regs.flags.CY, AC: this.regs.flags.AC }
    };
  }

  packFlags(): number {
    // PSW: S Z 0 AC 0 P 1 CY
    let b = 0;
    if (this.regs.flags.S) b |= 0x80;
    if (this.regs.flags.Z) b |= 0x40;
    if (this.regs.flags.AC) b |= 0x10;
    if (this.regs.flags.P) b |= 0x04;
    b |= 0x02; // bit 1 set
    if (this.regs.flags.CY) b |= 0x01;
    return b & 0xff;
  }

  unpackFlags(b: number) {
    this.regs.flags.S = !!(b & 0x80);
    this.regs.flags.Z = !!(b & 0x40);
    this.regs.flags.AC = !!(b & 0x10);
    this.regs.flags.P = !!(b & 0x04);
    this.regs.flags.CY = !!(b & 0x01);
  }

  // Set program counter, wrapping to 16 bits to avoid overflow bugs
  setPC(v: number) { this.regs.PC = v & 0xffff; }

  // Helper to set Z, S, P flags for an 8-bit value
  setZSP(v: number) {
    const b = v & 0xff;
    this.regs.flags.Z = (b === 0);
    this.regs.flags.S = !!(b & 0x80);
    this.regs.flags.P = this.parityEven(b);
  }

  // Addition of two 8-bit values with carryIn (0 or 1). Sets Z,S,P,AC,CY.
  add8(a: number, b: number, carryIn = 0) {
    const full = a + b + carryIn;
    const res = full & 0xff;
    this.regs.flags.CY = full > 0xff;
    this.regs.flags.AC = (((a & 0x0f) + (b & 0x0f) + carryIn) & 0x10) === 0x10;
    this.setZSP(res);
    return res;
  }

  // Subtraction a - b - borrow (borrow 0 or 1). Sets Z,S,P,AC,CY.
  sub8(a: number, b: number, borrow = 0) {
    const full = a - b - borrow;
    const res = full & 0xff;
    this.regs.flags.CY = full < 0;
    // AC for subtraction: borrow from bit 4
    this.regs.flags.AC = (((a & 0x0f) - (b & 0x0f) - borrow) & 0x10) === 0x10;
    this.setZSP(res);
    return res;
  }

  // Execute a single instruction and return cycles consumed
  step(): { halted: boolean; pc: number; cycles: number } {
    const pc = this.regs.PC;
    const op = this.readByte(pc);
    const instrCycles = this.getInstrCC(op);
    // NOP
    if (op === 0x00) { this.setPC(this.regs.PC + 1); return { halted: false, pc, cycles: instrCycles }; }
    // HLT
    if (op === 0x76) { return { halted: true, pc, cycles: instrCycles }; }

    // MVI r,byte
    const mviList = [0x06, 0x0e, 0x16, 0x1e, 0x26, 0x2e, 0x36, 0x3e];
    if (mviList.includes(op)) {
      const regIndex = mviList.indexOf(op);
      const val = this.readByte(pc + 1);
      this.setReg(regIndex, val);
      this.setPC(this.regs.PC + 2);
      return { halted: false, pc, cycles: instrCycles };
    }

    // MOV r1,r2 (0x40 - 0x7f)
    if ((op & 0xc0) === 0x40) {
      const d = (op >> 3) & 0x7;
      const s = op & 0x7;
      const val = this.getReg(s);
      this.setReg(d, val);
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // LDA (0x3A) little endian address
    if (op === 0x3A) {
      const lo = this.readByte(pc + 1);
      const hi = this.readByte(pc + 2);
      const addr = (hi << 8) | lo;
      this.regs.A = this.readByte(addr);
      this.setPC(this.regs.PC + 3);
      return { halted: false, pc, cycles: instrCycles };
    }

    // LDAX (0x0A, 0x1A) - load A from address in BC or DE
    if (op === 0x0A || op === 0x1A) {
      const addr = op === 0x0A ? ((this.regs.B << 8) | this.regs.C) : ((this.regs.D << 8) | this.regs.E);
      this.regs.A = this.readByte(addr);
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // STAX (0x02, 0x12) - store A into address in BC or DE
    if (op === 0x02 || op === 0x12) {
      const addr = op === 0x02 ? ((this.regs.B << 8) | this.regs.C) : ((this.regs.D << 8) | this.regs.E);
      this.writeByte(addr, this.regs.A);
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // STA (0x32)
    if (op === 0x32) {
      const lo = this.readByte(pc + 1);
      const hi = this.readByte(pc + 2);
      const addr = (hi << 8) | lo;
      this.writeByte(addr, this.regs.A);
      this.setPC(this.regs.PC + 3);
      return { halted: false, pc, cycles: instrCycles };
    }

    // LHLD (0x2A) / SHLD (0x22) - load/store HL direct (little endian addr)
    if (op === 0x2A || op === 0x22) {
      const lo = this.readByte(pc + 1);
      const hi = this.readByte(pc + 2);
      const addr = (hi << 8) | lo;
      if (op === 0x2A) {
        // LHLD: load L from addr, H from addr+1
        this.regs.L = this.readByte(addr);
        this.regs.H = this.readByte((addr + 1) & 0xffff);
      } else {
        // SHLD: store L at addr, H at addr+1
        this.writeByte(addr, this.regs.L);
        this.writeByte((addr + 1) & 0xffff, this.regs.H);
      }
      this.setPC(this.regs.PC + 3);
      return { halted: false, pc, cycles: instrCycles };
    }

    // XCHG (0xEB) - exchange DE and HL
    if (op === 0xEB) {
      const tH = this.regs.H, tL = this.regs.L;
      this.regs.H = this.regs.D; this.regs.L = this.regs.E;
      this.regs.D = tH; this.regs.E = tL;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // CMA (0x2F) - complement accumulator
    if (op === 0x2F) {
      this.regs.A = (~this.regs.A) & 0xff;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // STC (0x37) - set carry, CMC (0x3F) - complement carry
    if (op === 0x37) { this.regs.flags.CY = true; this.setPC(this.regs.PC + 1); return { halted: false, pc, cycles: instrCycles }; }
    if (op === 0x3F) { this.regs.flags.CY = !this.regs.flags.CY; this.setPC(this.regs.PC + 1); return { halted: false, pc, cycles: instrCycles }; }

    // JMP (0xC3), JZ (0xCA), JNZ (0xC2), JNC (0xD2), JC (0xDA), JPO (0xE2), JPE (0xEA), JP (0xF2), JM (0xFA)
    const condJumpTable = [0xC2, 0xCA, 0xD2, 0xDA, 0xE2, 0xEA, 0xF2, 0xFA];
    if (op === 0xC3 || condJumpTable.includes(op)) {
      const lo = this.readByte(pc + 1);
      const hi = this.readByte(pc + 2);
      const addr = (hi << 8) | lo;
      if (op === 0xC3) {
        this.regs.PC = addr;
        return { halted: false, pc, cycles: instrCycles };
      }
      if (condJumpTable.includes(op)) {
        const idx = condJumpTable.indexOf(op);
        const cond = (() => {
          switch (idx) {
            case 0: return !this.regs.flags.Z; // JNZ
            case 1: return this.regs.flags.Z;  // JZ
            case 2: return !this.regs.flags.CY; // JNC
            case 3: return this.regs.flags.CY;  // JC
            case 4: return !this.regs.flags.P;  // JPO
            case 5: return this.regs.flags.P;   // JPE
            case 6: return !this.regs.flags.S;  // JP (positive)
            case 7: return this.regs.flags.S;   // JM (minus)
          }
          return false;
        })();
        if (cond) { this.regs.PC = addr; } else { this.regs.PC += 3; }
        return { halted: false, pc, cycles: instrCycles };
      }
    }

    // Conditional CALLs: CNZ(0xC4), CZ(0xCC), CNC(0xD4), CC(0xDC), CPO(0xE4), CPE(0xEC), CP(0xF4), CM(0xFC)
    const condCallTable = [0xC4, 0xCC, 0xD4, 0xDC, 0xE4, 0xEC, 0xF4, 0xFC];
    if (condCallTable.includes(op)) {
      const idx = condCallTable.indexOf(op);
      const lo = this.readByte(pc + 1);
      const hi = this.readByte(pc + 2);
      const addr = (hi << 8) | lo;
      const cond = (() => {
        switch (idx) {
          case 0: return !this.regs.flags.Z; // NZ
          case 1: return this.regs.flags.Z;  // Z
          case 2: return !this.regs.flags.CY; // NC
          case 3: return this.regs.flags.CY;  // C
          case 4: return !this.regs.flags.P;  // PO (parity odd)
          case 5: return this.regs.flags.P;   // PE (parity even)
          case 6: return !this.regs.flags.S;  // P (positive)
          case 7: return this.regs.flags.S;   // M (minus)
        }
        return false;
      })();
      if (cond) {
        const ret = (pc + 3) & 0xffff;
        this.regs.SP = (this.regs.SP - 1) & 0xffff;
        this.writeByte(this.regs.SP, (ret >> 8) & 0xff, AddrSpace.STACK);
        this.regs.SP = (this.regs.SP - 1) & 0xffff;
        this.writeByte(this.regs.SP, ret & 0xff, AddrSpace.STACK);
        this.regs.PC = addr;
      } else {
        this.setPC(this.regs.PC + 3);
      }
      return { halted: false, pc, cycles: instrCycles };
    }

    // CALL (0xCD)
    if (op === 0xCD) {
      const lo = this.readByte(pc + 1);
      const hi = this.readByte(pc + 2);
      const addr = (hi << 8) | lo;
      const ret = (pc + 3) & 0xffff;
      // push high then low onto stack (stack grows down) - use STACK addrspace
      this.regs.SP = (this.regs.SP - 1) & 0xffff;
      this.writeByte(this.regs.SP, (ret >> 8) & 0xff, AddrSpace.STACK);
      this.regs.SP = (this.regs.SP - 1) & 0xffff;
      this.writeByte(this.regs.SP, ret & 0xff, AddrSpace.STACK);
      this.regs.PC = addr;
      return { halted: false, pc, cycles: instrCycles };
    }
    // Conditional RETs: RNZ(0xC0), RZ(0xC8), RNC(0xD0), RC(0xD8), RPO(0xE0), RPE(0xE8), RP(0xF0), RM(0xF8)
    const condRetTable = [0xC0, 0xC8, 0xD0, 0xD8, 0xE0, 0xE8, 0xF0, 0xF8];
    if (condRetTable.includes(op)) {
      const idx = condRetTable.indexOf(op);
      const cond = (() => {
        switch (idx) {
          case 0: return !this.regs.flags.Z; // RNZ
          case 1: return this.regs.flags.Z;  // RZ
          case 2: return !this.regs.flags.CY; // RNC
          case 3: return this.regs.flags.CY;  // RC
          case 4: return !this.regs.flags.P;  // RPO
          case 5: return this.regs.flags.P;   // RPE
          case 6: return !this.regs.flags.S;  // RP
          case 7: return this.regs.flags.S;   // RM
        }
        return false;
      })();
      if (cond) {
        const low = this.readByte(this.regs.SP, AddrSpace.STACK);
        const high = this.readByte((this.regs.SP + 1) & 0xffff, AddrSpace.STACK);
        this.regs.PC = (high << 8) | low;
        this.regs.SP = (this.regs.SP + 2) & 0xffff;
      } else {
        this.setPC(this.regs.PC + 1);
      }
      return { halted: false, pc, cycles: instrCycles };
    }

    // RET (0xC9)
    if (op === 0xC9) {
      const low = this.readByte(this.regs.SP, AddrSpace.STACK);
      const high = this.readByte((this.regs.SP + 1) & 0xffff, AddrSpace.STACK);
      this.regs.PC = (high << 8) | low;
      this.regs.SP = (this.regs.SP + 2) & 0xffff;
      return { halted: false, pc, cycles: instrCycles };
    }

    // LXI rp, d16 (0x01,0x11,0x21,0x31)
    if (op === 0x01 || op === 0x11 || op === 0x21 || op === 0x31) {
      const lo = this.readByte(pc + 1);
      const hi = this.readByte(pc + 2);
      const val = (hi << 8) | lo;
      if (op === 0x01) { this.regs.B = (val >> 8) & 0xff; this.regs.C = val & 0xff; }
      if (op === 0x11) { this.regs.D = (val >> 8) & 0xff; this.regs.E = val & 0xff; }
      if (op === 0x21) { this.regs.H = (val >> 8) & 0xff; this.regs.L = val & 0xff; }
      if (op === 0x31) { this.regs.SP = val & 0xffff; }
      this.setPC(this.regs.PC + 3);
      return { halted: false, pc, cycles: instrCycles };
    }

    // INX rp (0x03,0x13,0x23,0x33) - increment register pair, no flags affected
    if (op === 0x03 || op === 0x13 || op === 0x23 || op === 0x33) {
      if (op === 0x03) { const v = ((this.regs.B << 8) | this.regs.C) + 1; this.regs.B = (v >> 8) & 0xff; this.regs.C = v & 0xff; }
      if (op === 0x13) { const v = ((this.regs.D << 8) | this.regs.E) + 1; this.regs.D = (v >> 8) & 0xff; this.regs.E = v & 0xff; }
      if (op === 0x23) { const v = ((this.regs.H << 8) | this.regs.L) + 1; this.regs.H = (v >> 8) & 0xff; this.regs.L = v & 0xff; }
      if (op === 0x33) { this.regs.SP = (this.regs.SP + 1) & 0xffff; }
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // DCX rp (0x0B,0x1B,0x2B,0x3B) - decrement register pair, no flags affected
    if (op === 0x0B || op === 0x1B || op === 0x2B || op === 0x3B) {
      if (op === 0x0B) { const v = ((this.regs.B << 8) | this.regs.C) - 1; this.regs.B = (v >> 8) & 0xff; this.regs.C = v & 0xff; }
      if (op === 0x1B) { const v = ((this.regs.D << 8) | this.regs.E) - 1; this.regs.D = (v >> 8) & 0xff; this.regs.E = v & 0xff; }
      if (op === 0x2B) { const v = ((this.regs.H << 8) | this.regs.L) - 1; this.regs.H = (v >> 8) & 0xff; this.regs.L = v & 0xff; }
      if (op === 0x3B) { this.regs.SP = (this.regs.SP - 1) & 0xffff; }
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // DAD rp (0x09,0x19,0x29,0x39) - add register pair to HL, set carry
    if (op === 0x09 || op === 0x19 || op === 0x29 || op === 0x39) {
      const hl = (this.regs.H << 8) | this.regs.L;
      let add = 0;
      if (op === 0x09) add = (this.regs.B << 8) | this.regs.C;
      if (op === 0x19) add = (this.regs.D << 8) | this.regs.E;
      if (op === 0x29) add = (this.regs.H << 8) | this.regs.L;
      if (op === 0x39) add = this.regs.SP;
      const res = hl + add;
      this.regs.flags.CY = res > 0xffff;
      const v = res & 0xffff;
      this.regs.H = (v >> 8) & 0xff; this.regs.L = v & 0xff;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // PUSH rp (0xC5,0xD5,0xE5,0xF5)
    if (op === 0xC5 || op === 0xD5 || op === 0xE5 || op === 0xF5) {
      let high = 0, low = 0;
      if (op === 0xC5) { high = this.regs.B; low = this.regs.C; }
      if (op === 0xD5) { high = this.regs.D; low = this.regs.E; }
      if (op === 0xE5) { high = this.regs.H; low = this.regs.L; }
      if (op === 0xF5) { high = this.regs.A; low = this.packFlags(); }
      this.regs.SP = (this.regs.SP - 1) & 0xffff;
      this.writeByte(this.regs.SP, high & 0xff, AddrSpace.STACK);
      this.regs.SP = (this.regs.SP - 1) & 0xffff;
      this.writeByte(this.regs.SP, low & 0xff, AddrSpace.STACK);
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // POP rp (0xC1,0xD1,0xE1,0xF1)
    if (op === 0xC1 || op === 0xD1 || op === 0xE1 || op === 0xF1) {
      const low = this.readByte(this.regs.SP, AddrSpace.STACK);
      const high = this.readByte((this.regs.SP + 1) & 0xffff, AddrSpace.STACK);
      this.regs.SP = (this.regs.SP + 2) & 0xffff;
      if (op === 0xC1) { this.regs.B = high; this.regs.C = low; }
      if (op === 0xD1) { this.regs.D = high; this.regs.E = low; }
      if (op === 0xE1) { this.regs.H = high; this.regs.L = low; }
      if (op === 0xF1) { this.regs.A = high; this.unpackFlags(low); }
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // XTHL (0xE3) - exchange top of stack with HL
    if (op === 0xE3) {
      const low = this.readByte(this.regs.SP, AddrSpace.STACK);
      const high = this.readByte((this.regs.SP + 1) & 0xffff, AddrSpace.STACK);
      // write HL to stack
      this.writeByte(this.regs.SP, this.regs.L, AddrSpace.STACK);
      this.writeByte((this.regs.SP + 1) & 0xffff, this.regs.H, AddrSpace.STACK);
      // load from stack into HL
      this.regs.L = low;
      this.regs.H = high;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // SPHL (0xF9) - set SP = HL
    if (op === 0xF9) {
      this.regs.SP = (this.regs.H << 8) | this.regs.L;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // DI (0xF3) - disable interrupts
    if (op === 0xF3) {
      this.interruptsEnabled = false;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // EI (0xFB) - enable interrupts (note: simple model, enables immediately)
    if (op === 0xFB) {
      this.interruptsEnabled = true;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // Rotate ops
    // RLC (0x07) - rotate A left. MSB -> carry and LSB
    if (op === 0x07) {
      const a = this.regs.A;
      const msb = (a & 0x80) >>> 7;
      const res = ((a << 1) | msb) & 0xff;
      this.regs.A = res;
      this.regs.flags.CY = !!msb;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // RRC (0x0F) - rotate A right. LSB -> carry and MSB
    if (op === 0x0F) {
      const a = this.regs.A;
      const lsb = a & 0x01;
      const res = ((lsb << 7) | (a >>> 1)) & 0xff;
      this.regs.A = res;
      this.regs.flags.CY = !!lsb;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // RAL (0x17) - rotate left through carry
    if (op === 0x17) {
      const a = this.regs.A;
      const oldCarry = this.regs.flags.CY ? 1 : 0;
      const msb = (a & 0x80) >>> 7;
      const res = ((a << 1) | oldCarry) & 0xff;
      this.regs.A = res;
      this.regs.flags.CY = !!msb;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // RAR (0x1F) - rotate right through carry
    if (op === 0x1F) {
      const a = this.regs.A;
      const oldCarry = this.regs.flags.CY ? 1 : 0;
      const lsb = a & 0x01;
      const res = ((oldCarry << 7) | (a >>> 1)) & 0xff;
      this.regs.A = res;
      this.regs.flags.CY = !!lsb;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // RST n (0xC7, 0xCF, 0xD7, ... 8-step increments) - restart
    if ((op & 0xC7) === 0xC7) {
      const vector = (op >> 3) & 0x7;
      const ret = (pc + 1) & 0xffff;
      this.regs.SP = (this.regs.SP - 1) & 0xffff;
      this.writeByte(this.regs.SP, (ret >> 8) & 0xff, AddrSpace.STACK);
      this.regs.SP = (this.regs.SP - 1) & 0xffff;
      this.writeByte(this.regs.SP, ret & 0xff, AddrSpace.STACK);
      this.regs.PC = vector * 8;
      return { halted: false, pc, cycles: instrCycles };
    }

    // DAA (0x27) - decimal adjust accumulator
    if (op === 0x27) {
      const a = this.regs.A;
      let add = 0;
      // lower nibble
      if ((a & 0x0f) > 9 || this.regs.flags.AC) add |= 0x06;
      // upper nibble / carry
      if (a > 0x99 || this.regs.flags.CY) add |= 0x60;
      const resFull = a + add;
      const res = resFull & 0xff;
      // AC: carry from bit 3 to bit 4
      this.regs.flags.AC = (((a & 0x0f) + (add & 0x0f)) & 0x10) === 0x10;
      // CY: if result > 0xff or we set high nibble carry
      this.regs.flags.CY = resFull > 0xff;
      this.setZSP(res);
      this.regs.A = res;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // Logical ops: ANA/XRA/ORA (register forms)
    if ((op & 0xf8) === 0xA0) { // ANA r
      const r = op & 0x7;
      const val = this.getReg(r);
      const res = this.regs.A & val;
      this.regs.A = res & 0xff;
      this.setZSP(res);
      this.regs.flags.CY = false;
      this.regs.flags.AC = false;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }
    if ((op & 0xf8) === 0xA8) { // XRA r
      const r = op & 0x7;
      const val = this.getReg(r);
      const res = this.regs.A ^ val;
      this.regs.A = res & 0xff;
      this.setZSP(res);
      this.regs.flags.CY = false;
      this.regs.flags.AC = false;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }
    if ((op & 0xf8) === 0xB0) { // ORA r
      const r = op & 0x7;
      const val = this.getReg(r);
      const res = this.regs.A | val;
      this.regs.A = res & 0xff;
      this.setZSP(res);
      this.regs.flags.CY = false;
      this.regs.flags.AC = false;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // ADD r (0x80 + r)
    if ((op & 0xf8) === 0x80) {
      const r = op & 0x7;
      const val = this.getReg(r);
      const res = this.add8(this.regs.A, val, 0);
      this.regs.A = res;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // ADC r (0x88 + r)
    if ((op & 0xf8) === 0x88) {
      const r = op & 0x7;
      const val = this.getReg(r);
      const carryIn = this.regs.flags.CY ? 1 : 0;
      const res = this.add8(this.regs.A, val, carryIn);
      this.regs.A = res;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // SBB r (0x98 + r) - subtract r with borrow
    if ((op & 0xf8) === 0x98) {
      const r = op & 0x7;
      const val = this.getReg(r);
      const borrow = this.regs.flags.CY ? 1 : 0;
      const res = this.sub8(this.regs.A, val, borrow);
      this.regs.A = res;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // SUB r (0x90 + r)
    if ((op & 0xf8) === 0x90) {
      const r = op & 0x7;
      const val = this.getReg(r);
      const res = this.sub8(this.regs.A, val, 0);
      this.regs.A = res;
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // CMP r (0xB8 + r) - compare A with r, set flags, keep A
    if ((op & 0xf8) === 0xB8) {
      const r = op & 0x7;
      const val = this.getReg(r);
      this.sub8(this.regs.A, val, 0);
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // Immediate arithmetic/logical ops
    if (op === 0xC6) { // ADI d8
      const v = this.readByte(pc + 1);
      this.regs.A = this.add8(this.regs.A, v, 0);
      this.setPC(this.regs.PC + 2);
      return { halted: false, pc, cycles: instrCycles };
    }
    if (op === 0xCE) { // ACI d8
      const v = this.readByte(pc + 1);
      const carryIn = this.regs.flags.CY ? 1 : 0;
      this.regs.A = this.add8(this.regs.A, v, carryIn);
      this.setPC(this.regs.PC + 2);
      return { halted: false, pc, cycles: instrCycles };
    }
    if (op === 0xD6) { // SUI d8
      const v = this.readByte(pc + 1);
      this.regs.A = this.sub8(this.regs.A, v, 0);
      this.setPC(this.regs.PC + 2);
      return { halted: false, pc, cycles: instrCycles };
    }
    if (op === 0xDE) { // SBI d8
      const v = this.readByte(pc + 1);
      const borrow = this.regs.flags.CY ? 1 : 0;
      this.regs.A = this.sub8(this.regs.A, v, borrow);
      this.setPC(this.regs.PC + 2);
      return { halted: false, pc, cycles: instrCycles };
    }

    // ANI/XRI/ORI immediate logical
    if (op === 0xE6) { // ANI d8
      const v = this.readByte(pc + 1);
      const res = this.regs.A & v;
      this.regs.A = res & 0xff;
      this.setZSP(res);
      this.regs.flags.CY = false;
      this.regs.flags.AC = false;
      this.setPC(this.regs.PC + 2);
      return { halted: false, pc, cycles: instrCycles };
    }
    if (op === 0xEE) { // XRI d8
      const v = this.readByte(pc + 1);
      const res = this.regs.A ^ v;
      this.regs.A = res & 0xff;
      this.setZSP(res);
      this.regs.flags.CY = false;
      this.regs.flags.AC = false;
      this.setPC(this.regs.PC + 2);
      return { halted: false, pc, cycles: instrCycles };
    }
    if (op === 0xF6) { // ORI d8
      const v = this.readByte(pc + 1);
      const res = this.regs.A | v;
      this.regs.A = res & 0xff;
      this.setZSP(res);
      this.regs.flags.CY = false;
      this.regs.flags.AC = false;
      this.setPC(this.regs.PC + 2);
      return { halted: false, pc, cycles: instrCycles };
    }

    // CPI d8 - compare immediate with A, set flags
    if (op === 0xFE) {
      const v = this.readByte(pc + 1);
      this.sub8(this.regs.A, v, 0);
      this.setPC(this.regs.PC + 2);
      return { halted: false, pc, cycles: instrCycles };
    }

    // IN (0xDB) - input from port (immediate 8-bit) into A
    if (op === 0xDB) {
      const port = this.readByte(pc + 1) & 0xff;
      let val = 0xff;
      if (this.io && typeof this.io.portIn === 'function') {
        val = this.io.portIn(port) & 0xff;
      }
      this.regs.A = val & 0xff;
      this.setPC(this.regs.PC + 2);
      return { halted: false, pc, cycles: instrCycles };
    }

    // OUT (0xD3) - output A to port (immediate 8-bit)
    if (op === 0xD3) {
      const port = this.readByte(pc + 1) & 0xff;
      if (this.io && typeof this.io.portOut === 'function') {
        this.io.portOut(port, this.regs.A & 0xff);
      }
      this.setPC(this.regs.PC + 2);
      return { halted: false, pc, cycles: instrCycles };
    }

    // INR r (0x04 + r<<3) and DCR r (0x05 + r<<3)
    const upper = op & 0b00111000;
    const base = op & 0x07;
    if ((op & 0b11000111) === 0x04) { // INR
      const r = (op >> 3) & 0x7;
      const old = this.getReg(r);
      const val = (old + 1) & 0xff;
      // AC affected: if lower nibble overflows
      this.regs.flags.AC = ((old & 0x0f) + 1) > 0x0f;
      this.setZSP(val);
      this.setReg(r, val);
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }
    if ((op & 0b11000111) === 0x05) { // DCR
      const r = (op >> 3) & 0x7;
      const old = this.getReg(r);
      const val = (old - 1) & 0xff;
      // AC affected for decrement: borrow from bit 4
      this.regs.flags.AC = ((old & 0x0f) - 1) < 0;
      this.setZSP(val);
      this.setReg(r, val);
      this.setPC(this.regs.PC + 1);
      return { halted: false, pc, cycles: instrCycles };
    }

    // Unknown opcode: treat as NOP and advance
    this.setPC(this.regs.PC + 1);
    return { halted: false, pc, cycles: instrCycles };
  }
  // Run until hitting breakpoint or halt, or until cycles consumed via runCycles
  runUntilBreakpointOrHalt(maxSteps = 100000): { halted: boolean; pc: number; stoppedOnBreakpoint: boolean } {
    let steps = 0;
    while (steps++ < maxSteps) {
      if (this.breakpoints.has(this.regs.PC)) return { halted: false, pc: this.regs.PC, stoppedOnBreakpoint: true };
      const startAddr = this.regs.PC;
      const opcode = this.readByte(startAddr);
      const res = this.step();
      // emit hook after executing the instruction
      if (this.onInstruction) this.onInstruction({ addr: startAddr, opcode, regs: this.snapshotRegs() });
      this.cycles += res.cycles;
      if (res.halted) return { halted: true, pc: res.pc, stoppedOnBreakpoint: false };
    }
    return { halted: false, pc: this.regs.PC, stoppedOnBreakpoint: false };
  }

  // Per-opcode machine cycle table (machine cycles). Matches the C++ M_CYCLES table.
  static readonly M_CYCLES: number[] = [
    1, 3, 2, 2, 2, 2, 2, 1, 1, 3, 2, 2, 2, 2, 2, 1,
    1, 3, 2, 2, 2, 2, 2, 1, 1, 3, 2, 2, 2, 2, 2, 1,
    1, 3, 5, 2, 2, 2, 2, 1, 1, 3, 5, 2, 2, 2, 2, 1,
    1, 3, 4, 2, 3, 3, 3, 1, 1, 3, 4, 2, 2, 2, 2, 1,

    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,

    1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 2, 1,
    1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 2, 1,
    1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 2, 1,
    1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 2, 1,

    4, 3, 3, 3, 6, 4, 2, 4, 4, 3, 3, 3, 6, 6, 2, 4,
    4, 3, 3, 3, 6, 4, 2, 4, 4, 3, 3, 3, 6, 6, 2, 4,
    4, 3, 3, 6, 6, 4, 2, 4, 4, 2, 3, 1, 6, 6, 2, 4,
    4, 3, 3, 1, 6, 4, 2, 4, 4, 2, 3, 1, 6, 6, 2, 4
  ];

  // Returns CPU cycles consumed by opcode
  getInstrCC(opcode: number) { return (CPU.M_CYCLES[opcode & 0xff] || 1) * 4; }

  // Run until a target number of CPU cycles is consumed. Calls `on4Cycles` once per 4 cycles advanced. Returns halted flag.
  runCycles(targetCycles: number, on4Cycles?: (cyclesAdvanced: number) => void): { halted: boolean } {
    this.running = true;
    let consumed = 0;
    while (consumed < targetCycles) {
      if (this.breakpoints.has(this.regs.PC)) return { halted: false };
      const startAddr = this.regs.PC;
      const opcode = this.readByte(startAddr);
      const res = this.step();
      // emit hook after executing the instruction
      if (this.onInstruction) this.onInstruction({ addr: startAddr, opcode, regs: this.snapshotRegs() });
      consumed += res.cycles;
      this.cycles += res.cycles;
      // call back per 4 cycles slices
      let slices = Math.floor(res.cycles / 4);
      for (let s = 0; s < slices; s++) {
        if (on4Cycles) on4Cycles(4);
      }
      if (res.halted) return { halted: true };
    }
    this.running = false;
    return { halted: false };
  }

  // Expose running state
  get isRunning() { return this.running; }

  // Trigger a maskable interrupt with a restart vector (0-7). If interruptsEnabled,
  // pushes PC and jumps to vector*8. Returns true if interrupt taken.
  interrupt(vector: number): boolean {
    if (!this.interruptsEnabled) return false;
    this.interruptsEnabled = false; // typically cleared on acknowledge
    const ret = this.regs.PC & 0xffff;
    this.regs.SP = (this.regs.SP - 1) & 0xffff;
    this.writeByte(this.regs.SP, (ret >> 8) & 0xff, AddrSpace.STACK);
    this.regs.SP = (this.regs.SP - 1) & 0xffff;
    this.writeByte(this.regs.SP, ret & 0xff, AddrSpace.STACK);
    this.setPC((vector & 0x7) * 8);
    return true;
  }
}
