import Memory, { AddrSpace } from './memory';

// consts
export const OPCODE_RST0: number = 0xC7;
export const OPCODE_RST7: number = 0xFF;
export const OPCODE_HLT: number = 0x76;
export const OPCODE_PCHL: number = 0xE9;
export const OPCODE_JNZ: number = 0xC2;
export const OPCODE_JZ: number = 0xCA;
export const OPCODE_JNC: number = 0xD2;
export const OPCODE_JC: number = 0xDA;
export const OPCODE_JPO: number = 0xE2;
export const OPCODE_JPE: number = 0xEA;
export const OPCODE_JP: number = 0xF2;
export const OPCODE_JM: number = 0xFA;
export const OPCODE_DB: number = 0x10;

// opcode type
// order: branch instructions first then subroutines instruction first.
export const OPTYPE_C__: number = 0;
export const OPTYPE_CAL: number = 1;
export const OPTYPE_J__: number = 2;
export const OPTYPE_JMP: number = 3;
export const OPTYPE_R__: number = 4;
export const OPTYPE_RET: number = 5;
export const OPTYPE_PCH: number = 6;
export const OPTYPE_RST: number = 7;
export const OPTYPE_ALL: number = 8;

export const CLOCK: number = 3000000;

// a number of clock cycles one machine cycle takes
const MACHINE_CC: number = 4;
// machine_cycle index indicating the instruction executon is over
const FIRST_MACHINE_CICLE_IDX: number = 0;
const PSW_INIT: number = 0b00000010;

export class RegPair {
  h: number = 0;
  l: number = 0;

  constructor(val: number = 0) {
    this.word = val & 0xffff;
  }
  get word(): number {
    return (this.h << 8) | this.l;
  }
  set word(value: number) {
    this.h = (value >> 8) & 0xff;
    this.l = value & 0xff;
  }
  clone(): RegPair {
    return new RegPair(this.word);
  }
}

export class Reg {
  _v: number = 0;

  constructor(val: number = 0) {
    this._v = val & 0xff;
  }
  get v(): number {
    return this._v;
  }
  set v(val: number) {
    this._v = val & 0xff;
  }
  clone(): Reg {
    return new Reg(this._v);
  }
}

export class AF {
  a: number = 0;
  c: boolean = false; // carry flag
  _1: boolean = true; // unused, always 1 in Vector06c
  p: boolean = false; // parity flag
  _3: boolean = false; // unused, always 0 in Vector06c
  ac: boolean = false; // auxiliary carry (half-carry) flag
  _5: boolean = false; // unused, always 0 in Vector06c
  z: boolean = false; // zero flag
  s: boolean = false; // sign flag

  constructor() {
    this.word = PSW_INIT;
  }

  get f(): number {
    let f = 0;
    if (this.s) f |=  0b10000000;
    if (this.z) f |=  0b01000000;
    if (this.ac) f |= 0b00010000;
    if (this.p) f |=  0b00000100;
    if (this.c) f |=  0b00000001;
    return f | PSW_INIT;
  }

  set f(value: number) {
    this.s = (value &  0b10000000) !== 0;
    this.z = (value &  0b01000000) !== 0;
    this.ac = (value & 0b00010000) !== 0;
    this.p = (value &  0b00000100) !== 0;
    this.c = (value &  0b00000001) !== 0;
  }

  get word(): number {
    return (this.a << 8) | this.f;
  }
  set word(val: number) {
    this.a = (val >> 8) & 0xff;
    this.f = val;
  }
  clone(): AF {
    const copy = new AF();
    copy.word = this.word;
    return copy;
  }
}

export type Registers = {
  pc: RegPair; // program counter
  sp: RegPair; // stack pointer
  af: AF;     // accumulator & flags
  bc: RegPair; // BC register pair
  de: RegPair; // DE register pair
  hl: RegPair; // HL register pair
  ir: Reg   // internal register to fetch instructions
  tmp: Reg  // internal temporary register
  act: Reg  // internal temporaty accumulator
  wz: RegPair  // internal address register
};

export class Int {
  mc: number = 0; // machine cycle index of the currently executed instruction
  inte: boolean = false; // set if an iterrupt enabled
  iff: boolean = false; // set by the 50 Hz interruption timer. it is ON until an iterruption call (RST7)
  hlta: boolean = false; // indicates that HLT instruction is executed
  eiPending: boolean = false; // if set, the interruption call is pending until the next instruction
  clone(): Int {
    const copy = new Int();
    copy.mc = this.mc;
    copy.inte = this.inte;
    copy.iff = this.iff;
    copy.hlta = this.hlta;
    copy.eiPending = this.eiPending;
    return copy;
  }
}

export class CpuState{
  cc: number = 0; // clock cycles, debug related data
  regs: Registers = {
    pc: new RegPair(),
    sp: new RegPair(),
    af: new AF(),
    bc: new RegPair(),
    de: new RegPair(),
    hl: new RegPair(),
    ir: new Reg(),
    tmp: new Reg(),
    act: new Reg(),
    wz: new RegPair()
  };
  ints: Int = new Int();
  clone(): CpuState {
    const copy = new CpuState();
    copy.cc = this.cc;
    copy.regs = {
      pc: this.regs.pc.clone(),
      sp: this.regs.sp.clone(),
      af: this.regs.af.clone(),
      bc: this.regs.bc.clone(),
      de: this.regs.de.clone(),
      hl: this.regs.hl.clone(),
      ir: this.regs.ir.clone(),
      tmp: this.regs.tmp.clone(),
      act: this.regs.act.clone(),
      wz: this.regs.wz.clone()
    };
    copy.ints = this.ints.clone();
    return copy;
  }
}

export class CPU
{
  memory?: Memory;
  private _state: CpuState = new CpuState();
  Input?: ((port: number) => number);
  Output?: ((port: number, value: number) => void);

  get state(): CpuState {
    return this._state;
  }

  get cc(): number {
    return this._state.cc;
  }
  get pc(): number {
    return this._state.regs.pc.word;
  }
  get sp(): number {
    return this._state.regs.sp.word;
  }
  get psw(): AF {
    return this._state.regs.af;
  }
  get bc(): RegPair {
    return this._state.regs.bc;
  }
  get de(): RegPair {
    return this._state.regs.de;
  }
  get hl(): RegPair {
    return this._state.regs.hl;
  }
  get a(): number {
    return this._state.regs.af.a;
  }
  get f(): number {
    return this._state.regs.af.f;
  }
  get b(): number {
    return this._state.regs.bc.h;
  }
  get c(): number {
    return this._state.regs.bc.l;
  }
  get d(): number {
    return this._state.regs.de.h;
  }
  get e(): number {
    return this._state.regs.de.l;
  }
  get h(): number {
    return this._state.regs.hl.h;
  }
  get l(): number {
    return this._state.regs.hl.l;
  }
  get flagS(): boolean {
    return this._state.regs.af.s;
  }
  get flagZ(): boolean {
    return this._state.regs.af.z;
  }
  get flagAC(): boolean {
    return this._state.regs.af.ac;
  }
  get flagP(): boolean {
    return this._state.regs.af.p;
  }
  get flagC(): boolean {
    return this._state.regs.af.c;
  }
  get inte(): boolean {
    return this._state.ints.inte;
  }
  get iff(): boolean {
    return this._state.ints.iff;
  }
  get hlta(): boolean {
    return this._state.ints.hlta;
  }
  get machineCycling(): number {
    return this._state.ints.mc;
  }

  constructor(
    memory?: Memory,
    input?: (port: number) => number,
    output?: (port: number, value: number) => void
  )
  {
    this.memory = memory;
    this.Input = input;
    this.Output = output;
    this.Init();
  }

  Init(rndRegs: boolean = false) {
    if (rndRegs) {
      this._state.regs.af.word = Math.floor(Math.random() * 0x100);
      this._state.regs.bc.word = Math.floor(Math.random() * 0x10000);
      this._state.regs.de.word = Math.floor(Math.random() * 0x10000);
      this._state.regs.hl.word = Math.floor(Math.random() * 0x10000);
    } else {
      this._state.regs.af.word = PSW_INIT;
      this._state.regs.bc.word = 0;
      this._state.regs.de.word = 0;
      this._state.regs.hl.word = 0;
    }

    this.Reset();
  }

  Reset() {
    this._state.cc = 0;
    this._state.regs.pc.word = 0;
    this._state.regs.sp.word = 0;
    this._state.regs.ir.v = 0;
    this._state.regs.tmp.v = 0;
    this._state.regs.act.v = 0;
    this._state.regs.wz.word = 0;
    this._state.ints = new Int();
  }

  ExecuteMachineCycle(irq: boolean)
  {
    this._state.ints.iff ||= irq && this.state.ints.inte;

    if (this._state.ints.mc == 0)
    {
		  // interrupt processing
      if (this._state.ints.iff && !this._state.ints.eiPending)
      {
        this._state.ints.inte = false;
        this._state.ints.iff = false;
        this._state.ints.hlta = false;
        this._state.regs.ir.v = OPCODE_RST7;
        this.memory?.CpuInvokesRst7();
      }
      // normal instruction execution
      else
      {
        this._state.ints.eiPending = false;
        this._state.regs.ir.v = this.ReadInstrMovePC(0);
      }
    }
    this.Decode();
    this._state.cc += MACHINE_CC;
  }

  IsInstructionExecuted(): boolean {
    return this._state.ints.mc === FIRST_MACHINE_CICLE_IDX || this._state.ints.hlta;
  }

  // an instruction execution time in macine cycles. each machine cycle is 4 cc
  private static readonly M_CYCLES: number[] =
  [
    //  0  1  2  3  4  5  6  7  8  9  A  B  C  D  E  F
    1, 3, 2, 2, 2, 2, 2, 1, 1, 3, 2, 2, 2, 2, 2, 1, // 0
    1, 3, 2, 2, 2, 2, 2, 1, 1, 3, 2, 2, 2, 2, 2, 1, // 1
    1, 3, 5, 2, 2, 2, 2, 1, 1, 3, 5, 2, 2, 2, 2, 1, // 2
    1, 3, 4, 2, 3, 3, 3, 1, 1, 3, 4, 2, 2, 2, 2, 1, // 3

    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, // 4
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, // 5
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, // 6
    2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, // 7

    1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 2, 1, // 8
    1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 2, 1, // 9
    1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 2, 1, // A
    1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 2, 1, // B

    4, 3, 3, 3, 6, 4, 2, 4, 4, 3, 3, 3, 6, 6, 2, 4, // C
    4, 3, 3, 3, 6, 4, 2, 4, 4, 3, 3, 3, 6, 6, 2, 4, // D
    4, 3, 3, 6, 6, 4, 2, 4, 4, 2, 3, 1, 6, 6, 2, 4, // E
    4, 3, 3, 1, 6, 4, 2, 4, 4, 2, 3, 1, 6, 6, 2, 4  // F
  ];

  GetInstrCC(opcode: number): number
  {
    return CPU.M_CYCLES[opcode] * 4;
  }

  // instruction lengths in bytes
  private static readonly INSTR_LENS: number[] =
  [
    1,3,1,1,1,1,2,1,1,1,1,1,1,1,2,1,
    1,3,1,1,1,1,2,1,1,1,1,1,1,1,2,1,
    1,3,3,1,1,1,2,1,1,1,3,1,1,1,2,1,
    1,3,3,1,1,1,2,1,1,1,3,1,1,1,2,1,
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
    1,1,3,3,3,1,2,1,1,1,3,1,3,3,2,1,
    1,1,3,2,3,1,2,1,1,1,3,2,3,1,2,1,
    1,1,3,1,3,1,2,1,1,1,3,1,3,1,2,1,
    1,1,3,1,3,1,2,1,1,1,3,1,3,1,2,1
  ];

  static GetInstrLen(opcode: number): number
  {
    return CPU.INSTR_LENS[opcode];
  }

  // order: branch instructions first then subroutines instruction first.
// 0 - c*
// 1 - call
// 2 - j*
// 3 - jmp
// 4 - r*
// 5 - ret
// 6 - pchl
// 7 - rst
// 8 - other
  private static readonly INSTR_TYPES: number[] =
  [
    8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
    8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
    8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
    8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,

    8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
    8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
    8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
    8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,

    8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
    8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
    8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
    8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,

    4, 8, 2, 3, 0, 8, 8, 7, 4, 5, 2, 8, 0, 1, 8, 7,
    4, 8, 2, 8, 0, 8, 8, 7, 4, 8, 2, 8, 0, 8, 8, 7,
    4, 8, 2, 8, 0, 8, 8, 7, 4, 6, 2, 8, 0, 8, 8, 7,
    4, 8, 2, 8, 0, 8, 8, 7, 4, 8, 2, 8, 0, 8, 8, 7,
  ];

  static GetInstrType(opcode: number): number
  {
	  return CPU.INSTR_TYPES[opcode];
  }

  Decode()
  {
    let BC = this._state.regs.bc;
    let DE = this._state.regs.de;
    let HL = this._state.regs.hl;
    let SP = this._state.regs.sp;
    let AF = this._state.regs.af;

    const FZ = AF.z;
    const FS = AF.s;
    const FP = AF.p;

	  switch (this._state.regs.ir.v)
	  {
    	case 0x7F: AF.a = this.MOVRegReg(AF.a, AF.a); break; // MOV AF.a,AF.a
      case 0x78: AF.a = this.MOVRegReg(AF.a, BC.h); break; // MOV AF.a,BC.h
      case 0x79: AF.a = this.MOVRegReg(AF.a, BC.l); break; // MOV AF.a,BC.l
      case 0x7A: AF.a = this.MOVRegReg(AF.a, DE.h); break; // MOV AF.a,DE.h
      case 0x7B: AF.a = this.MOVRegReg(AF.a, DE.l); break; // MOV AF.a,DE.l
      case 0x7C: AF.a = this.MOVRegReg(AF.a, HL.h); break; // MOV AF.a,HL.h
      case 0x7D: AF.a = this.MOVRegReg(AF.a, HL.l); break; // MOV AF.a,HL.l

      case 0x47: BC.h = this.MOVRegReg(BC.h, AF.a); break; // MOV BC.h,AF.a
      case 0x40: BC.h = this.MOVRegReg(BC.h, BC.h); break; // MOV BC.h,BC.h
      case 0x41: BC.h = this.MOVRegReg(BC.h, BC.l); break; // MOV BC.h,BC.l
      case 0x42: BC.h = this.MOVRegReg(BC.h, DE.h); break; // MOV BC.h,DE.h
      case 0x43: BC.h = this.MOVRegReg(BC.h, DE.l); break; // MOV BC.h,DE.l
      case 0x44: BC.h = this.MOVRegReg(BC.h, HL.h); break; // MOV BC.h,HL.h
      case 0x45: BC.h = this.MOVRegReg(BC.h, HL.l); break; // MOV BC.h,HL.l
      case 0x4F: BC.l = this.MOVRegReg(BC.l, AF.a); break; // MOV BC.l,AF.a
      case 0x48: BC.l = this.MOVRegReg(BC.l, BC.h); break; // MOV BC.l,BC.h
      case 0x49: BC.l = this.MOVRegReg(BC.l, BC.l); break; // MOV BC.l,BC.l
      case 0x4A: BC.l = this.MOVRegReg(BC.l, DE.h); break; // MOV BC.l,DE.h
      case 0x4B: BC.l = this.MOVRegReg(BC.l, DE.l); break; // MOV BC.l,DE.l
      case 0x4C: BC.l = this.MOVRegReg(BC.l, HL.h); break; // MOV BC.l,HL.h
      case 0x4D: BC.l = this.MOVRegReg(BC.l, HL.l); break; // MOV BC.l,HL.l

      case 0x57: DE.h = this.MOVRegReg(DE.h, AF.a); break; // MOV DE.h,AF.a
      case 0x50: DE.h = this.MOVRegReg(DE.h, BC.h); break; // MOV DE.h,BC.h
      case 0x51: DE.h = this.MOVRegReg(DE.h, BC.l); break; // MOV DE.h,BC.l
      case 0x52: DE.h = this.MOVRegReg(DE.h, DE.h); break; // MOV DE.h,DE.h
      case 0x53: DE.h = this.MOVRegReg(DE.h, DE.l); break; // MOV DE.h,DE.l
      case 0x54: DE.h = this.MOVRegReg(DE.h, HL.h); break; // MOV DE.h,HL.h
      case 0x55: DE.h = this.MOVRegReg(DE.h, HL.l); break; // MOV DE.h,HL.l

      case 0x5F: DE.l = this.MOVRegReg(DE.l, AF.a); break; // MOV DE.l,AF.a
      case 0x58: DE.l = this.MOVRegReg(DE.l, BC.h); break; // MOV DE.l,BC.h
      case 0x59: DE.l = this.MOVRegReg(DE.l, BC.l); break; // MOV DE.l,BC.l
      case 0x5A: DE.l = this.MOVRegReg(DE.l, DE.h); break; // MOV DE.l,DE.h
      case 0x5B: DE.l = this.MOVRegReg(DE.l, DE.l); break; // MOV DE.l,DE.l
      case 0x5C: DE.l = this.MOVRegReg(DE.l, HL.h); break; // MOV DE.l,HL.h
      case 0x5D: DE.l = this.MOVRegReg(DE.l, HL.l); break; // MOV DE.l,HL.l

      case 0x67: HL.h = this.MOVRegReg(HL.h, AF.a); break; // MOV HL.h,AF.a
      case 0x60: HL.h = this.MOVRegReg(HL.h, BC.h); break; // MOV HL.h,BC.h
      case 0x61: HL.h = this.MOVRegReg(HL.h, BC.l); break; // MOV HL.h,BC.l
      case 0x62: HL.h = this.MOVRegReg(HL.h, DE.h); break; // MOV HL.h,DE.h
      case 0x63: HL.h = this.MOVRegReg(HL.h, DE.l); break; // MOV HL.h,DE.l
      case 0x64: HL.h = this.MOVRegReg(HL.h, HL.h); break; // MOV HL.h,HL.h
      case 0x65: HL.h = this.MOVRegReg(HL.h, HL.l); break; // MOV HL.h,HL.l
      case 0x6F: HL.l = this.MOVRegReg(HL.l, AF.a); break; // MOV HL.l,AF.a
      case 0x68: HL.l = this.MOVRegReg(HL.l, BC.h); break; // MOV HL.l,BC.h
      case 0x69: HL.l = this.MOVRegReg(HL.l, BC.l); break; // MOV HL.l,BC.l
      case 0x6A: HL.l = this.MOVRegReg(HL.l, DE.h); break; // MOV HL.l,DE.h
      case 0x6B: HL.l = this.MOVRegReg(HL.l, DE.l); break; // MOV HL.l,DE.l
      case 0x6C: HL.l = this.MOVRegReg(HL.l, HL.h); break; // MOV HL.l,HL.h
      case 0x6D: HL.l = this.MOVRegReg(HL.l, HL.l); break; // MOV HL.l,HL.l

      case 0x7E: AF.a = this.LoadRegPtr(AF.a, HL.word); break; // MOV AF.a,M
      case 0x46: BC.h = this.LoadRegPtr(BC.h, HL.word); break; // MOV BC.h,M
      case 0x4E: BC.l = this.LoadRegPtr(BC.l, HL.word); break; // MOV BC.l,M
      case 0x56: DE.h = this.LoadRegPtr(DE.h, HL.word); break; // MOV DE.h,M
      case 0x5E: DE.l = this.LoadRegPtr(DE.l, HL.word); break; // MOV DE.l,M
      case 0x66: HL.h = this.LoadRegPtr(HL.h, HL.word); break; // MOV HL.h,M
      case 0x6E: HL.l = this.LoadRegPtr(HL.l, HL.word); break; // MOV HL.l,M

      case 0x77: this.MOVMemReg(AF.a); break; // MOV M,AF.a
      case 0x70: this.MOVMemReg(BC.h); break; // MOV M,BC.h
      case 0x71: this.MOVMemReg(BC.l); break; // MOV M,BC.l
      case 0x72: this.MOVMemReg(DE.h); break; // MOV M,DE.h
      case 0x73: this.MOVMemReg(DE.l); break; // MOV M,DE.l
      case 0x74: this.MOVMemReg(HL.h); break; // MOV M,HL.h
      case 0x75: this.MOVMemReg(HL.l); break; // MOV M,HL.l

      case 0x3E: AF.a = this.MVIRegData(AF.a); break; // MVI AF.a,uint8_t
      case 0x06: BC.h = this.MVIRegData(BC.h); break; // MVI BC.h,uint8_t
      case 0x0E: BC.l = this.MVIRegData(BC.l); break; // MVI BC.l,uint8_t
      case 0x16: DE.h = this.MVIRegData(DE.h); break; // MVI DE.h,uint8_t
      case 0x1E: DE.l = this.MVIRegData(DE.l); break; // MVI DE.l,uint8_t
      case 0x26: HL.h = this.MVIRegData(HL.h); break; // MVI HL.h,uint8_t
      case 0x2E: HL.l = this.MVIRegData(HL.l); break; // MVI HL.l,uint8_t
      case 0x36: this.MVIMemData(); break; // MVI M,uint8_t

      case 0x0A: AF.a = this.LoadRegPtr(AF.a, BC.word); break; // LDAX BC.h
      case 0x1A: AF.a = this.LoadRegPtr(AF.a, DE.word); break; // LDAX DE.h
      case 0x3A: this.LDA(); break; // LDA word

      case 0x02: this.STAX(BC.word); break; // STAX BC.h
      case 0x12: this.STAX(DE.word); break; // STAX DE.h
      case 0x32: this.STA(); break; // STA word

      case 0x01: this.LXI(BC); break; // LXI BC.h,word
      case 0x11: this.LXI(DE); break; // LXI DE.h,word
      case 0x21: this.LXI(HL); break; // LXI HL.h,word
      case 0x31: this.LXI(SP); break; // LXI SP,word
      case 0x2A: this.LHLD(); break; // LHLD
      case 0x22: this.SHLD(); break; // SHLD
      case 0xF9: this.SPHL(); break; // SPHL

      case 0xEB: this.XCHG(); break; // XCHG
      case 0xE3: this.XTHL(); break; // XTHL

      case 0xC5: this.PUSH(BC.h, BC.l); break; // PUSH BC.h
      case 0xD5: this.PUSH(DE.h, DE.l); break; // PUSH DE.h
      case 0xE5: this.PUSH(HL.h, HL.l); break; // PUSH HL.h
      case 0xF5: this.PUSH(AF.a, AF.f); break; // PUSH PSW
      case 0xC1: BC.word = this.POP(BC.word); break; // POP BC.h
      case 0xD1: DE.word = this.POP(DE.word); break; // POP DE.h
      case 0xE1: HL.word = this.POP(HL.word); break; // POP HL.h
      case 0xF1: AF.word = this.POP(AF.word); break; // POP PSW

      case 0x87: AF.a = this.ADD(AF.a, AF.a, false); break; // ADD AF.a
      case 0x80: AF.a = this.ADD(AF.a, BC.h, false); break; // ADD BC.h
      case 0x81: AF.a = this.ADD(AF.a, BC.l, false); break; // ADD BC.l
      case 0x82: AF.a = this.ADD(AF.a, DE.h, false); break; // ADD DE.h
      case 0x83: AF.a = this.ADD(AF.a, DE.l, false); break; // ADD DE.l
      case 0x84: AF.a = this.ADD(AF.a, HL.h, false); break; // ADD HL.h
      case 0x85: AF.a = this.ADD(AF.a, HL.l, false); break; // ADD HL.l
      case 0x86: this.ADDMem(false); break; // ADD M
      case 0xC6: this.ADI(false); break; // ADI uint8_t

      case 0x8F: AF.a = this.ADD(AF.a, AF.a, this._state.regs.af.c); break; // ADC AF.a
      case 0x88: AF.a = this.ADD(AF.a, BC.h, this._state.regs.af.c); break; // ADC BC.h
      case 0x89: AF.a = this.ADD(AF.a, BC.l, this._state.regs.af.c); break; // ADC BC.l
      case 0x8A: AF.a = this.ADD(AF.a, DE.h, this._state.regs.af.c); break; // ADC DE.h
      case 0x8B: AF.a = this.ADD(AF.a, DE.l, this._state.regs.af.c); break; // ADC DE.l
      case 0x8C: AF.a = this.ADD(AF.a, HL.h, this._state.regs.af.c); break; // ADC HL.h
      case 0x8D: AF.a = this.ADD(AF.a, HL.l, this._state.regs.af.c); break; // ADC HL.l
      case 0x8E: this.ADDMem(this._state.regs.af.c); break; // ADC M
      case 0xCE: this.ADI(this._state.regs.af.c); break; // ACI uint8_t

      case 0x97: AF.a = this.SUB(AF.a, AF.a, false); break; // SUB AF.a
      case 0x90: AF.a = this.SUB(AF.a, BC.h, false); break; // SUB BC.h
      case 0x91: AF.a = this.SUB(AF.a, BC.l, false); break; // SUB BC.l
      case 0x92: AF.a = this.SUB(AF.a, DE.h, false); break; // SUB DE.h
      case 0x93: AF.a = this.SUB(AF.a, DE.l, false); break; // SUB DE.l
      case 0x94: AF.a = this.SUB(AF.a, HL.h, false); break; // SUB HL.h
      case 0x95: AF.a = this.SUB(AF.a, HL.l, false); break; // SUB HL.l
      case 0x96: this.SUBMem(false); break; // SUB M
      case 0xD6: this.SBI(false); break; // SUI uint8_t

      case 0x9F: AF.a = this.SUB(AF.a, AF.a, this._state.regs.af.c); break; // SBB AF.a
      case 0x98: AF.a = this.SUB(AF.a, BC.h, this._state.regs.af.c); break; // SBB BC.h
      case 0x99: AF.a = this.SUB(AF.a, BC.l, this._state.regs.af.c); break; // SBB BC.l
      case 0x9A: AF.a = this.SUB(AF.a, DE.h, this._state.regs.af.c); break; // SBB DE.h
      case 0x9B: AF.a = this.SUB(AF.a, DE.l, this._state.regs.af.c); break; // SBB DE.l
      case 0x9C: AF.a = this.SUB(AF.a, HL.h, this._state.regs.af.c); break; // SBB HL.h
      case 0x9D: AF.a = this.SUB(AF.a, HL.l, this._state.regs.af.c); break; // SBB HL.l
      case 0x9E: this.SUBMem(this._state.regs.af.c); break; // SBB M
      case 0xDE: this.SBI(this._state.regs.af.c); break; // SBI uint8_t

      case 0x09: this.DAD(BC); break; // DAD BC.h
      case 0x19: this.DAD(DE); break; // DAD DE.h
      case 0x29: this.DAD(HL); break; // DAD HL.h
      case 0x39: this.DAD(SP); break; // DAD SP

      case 0x3C: AF.a = this.INR(AF.a); break; // INR AF.a
      case 0x04: BC.h = this.INR(BC.h); break; // INR BC.h
      case 0x0C: BC.l = this.INR(BC.l); break; // INR BC.l
      case 0x14: DE.h = this.INR(DE.h); break; // INR DE.h
      case 0x1C: DE.l = this.INR(DE.l); break; // INR DE.l
      case 0x24: HL.h = this.INR(HL.h); break; // INR HL.h
      case 0x2C: HL.l = this.INR(HL.l); break; // INR HL.l
      case 0x34: this.INRMem(); break; // INR M

      case 0x3D: AF.a = this.DCR(AF.a); break; // DCR AF.a
      case 0x05: BC.h = this.DCR(BC.h); break; // DCR BC.h
      case 0x0D: BC.l = this.DCR(BC.l); break; // DCR BC.l
      case 0x15: DE.h = this.DCR(DE.h); break; // DCR DE.h
      case 0x1D: DE.l = this.DCR(DE.l); break; // DCR DE.l
      case 0x25: HL.h = this.DCR(HL.h); break; // DCR HL.h
      case 0x2D: HL.l = this.DCR(HL.l); break; // DCR HL.l
      case 0x35: this.DCRMem(); break; // DCR M

      case 0x03: this.INX(BC); break; // INX BC.h
      case 0x13: this.INX(DE); break; // INX DE.h
      case 0x23: this.INX(HL); break; // INX HL.h
      case 0x33: this.INX(SP); break; // INX SP

      case 0x0B: this.DCX(BC); break; // DCX BC.h
      case 0x1B: this.DCX(DE); break; // DCX DE.h
      case 0x2B: this.DCX(HL); break; // DCX HL.h
      case 0x3B: this.DCX(SP); break; // DCX SP

      case 0x27: this.DAA(); break; // DAA
      case 0x2F: AF.a = (~AF.a) & 0xFF; break; // CMA
      case 0x37: this._state.regs.af.c = true; break; // STC
      case 0x3F: this._state.regs.af.c = !this._state.regs.af.c; break; // CMC

      case 0x07: this.RLC(); break; // RLC
      case 0x0F: this.RRC(); break; // RRC
      case 0x17: this.RAL(); break; // RAL
      case 0x1F: this.RAR(); break; // RAR

      case 0xA7: this.ANA(AF.a); break; // ANA AF.a
      case 0xA0: this.ANA(BC.h); break; // ANA BC.h
      case 0xA1: this.ANA(BC.l); break; // ANA BC.l
      case 0xA2: this.ANA(DE.h); break; // ANA DE.h
      case 0xA3: this.ANA(DE.l); break; // ANA DE.l
      case 0xA4: this.ANA(HL.h); break; // ANA HL.h
      case 0xA5: this.ANA(HL.l); break; // ANA HL.l
      case 0xA6: this.ANAMem(); break; // ANA M
      case 0xE6: this.ANI(); break; // ANI uint8_t

      case 0xAF: this.XRA(AF.a); break; // XRA AF.a
      case 0xA8: this.XRA(BC.h); break; // XRA BC.h
      case 0xA9: this.XRA(BC.l); break; // XRA BC.l
      case 0xAA: this.XRA(DE.h); break; // XRA DE.h
      case 0xAB: this.XRA(DE.l); break; // XRA DE.l
      case 0xAC: this.XRA(HL.h); break; // XRA HL.h
      case 0xAD: this.XRA(HL.l); break; // XRA HL.l
      case 0xAE: this.XRAMem(); break; // XRA M
      case 0xEE: this.XRI(); break; // XRI uint8_t

      case 0xB7: this.ORA(AF.a); break; // ORA AF.a
      case 0xB0: this.ORA(BC.h); break; // ORA BC.h
      case 0xB1: this.ORA(BC.l); break; // ORA BC.l
      case 0xB2: this.ORA(DE.h); break; // ORA DE.h
      case 0xB3: this.ORA(DE.l); break; // ORA DE.l
      case 0xB4: this.ORA(HL.h); break; // ORA HL.h
      case 0xB5: this.ORA(HL.l); break; // ORA HL.l
      case 0xB6: this.ORAMem(); break; // ORA M
      case 0xF6: this.ORI(); break; // ORI uint8_t

      case 0xBF: this.CMP(AF.a); break; // CMP AF.a
      case 0xB8: this.CMP(BC.h); break; // CMP BC.h
      case 0xB9: this.CMP(BC.l); break; // CMP BC.l
      case 0xBA: this.CMP(DE.h); break; // CMP DE.h
      case 0xBB: this.CMP(DE.l); break; // CMP DE.l
      case 0xBC: this.CMP(HL.h); break; // CMP HL.h
      case 0xBD: this.CMP(HL.l); break; // CMP HL.l
      case 0xBE: this.CMPMem(); break; // CMP M
      case 0xFE: this.CPI(); break; // CPI uint8_t

      case 0xC3: this.JMP(); break; // JMP
      case 0xCB: this.JMP(); break; // undocumented JMP
      case 0xC2: this.JMP(FZ == false); break; // JNZ
      case 0xCA: this.JMP(FZ == true); break; // JZ
      case 0xD2: this.JMP(this._state.regs.af.c == false); break; // JNC
      case 0xDA: this.JMP(this._state.regs.af.c == true); break; // JC
      case 0xE2: this.JMP(FP == false); break; // JPO
      case 0xEA: this.JMP(FP == true); break; // JPE
      case 0xF2: this.JMP(FS == false); break; // JP
      case 0xFA: this.JMP(FS == true); break; // JM

      case 0xE9: this.PCHL(); break; // PCHL
      case 0xCD: this.CALL(); break; // CALL
      case 0xDD: this.CALL(); break; // undocumented CALL
      case 0xED: this.CALL(); break; // undocumented CALL
      case 0xFD: this.CALL(); break; // undocumented CALL

      case 0xC4: this.CALL(FZ == false); break; // CNZ
      case 0xCC: this.CALL(FZ == true); break; // CZ
      case 0xD4: this.CALL(this._state.regs.af.c == false); break; // CNC
      case 0xDC: this.CALL(this._state.regs.af.c == true); break; // CC
      case 0xE4: this.CALL(FP == false); break; // CPO
      case 0xEC: this.CALL(FP == true); break; // CPE
      case 0xF4: this.CALL(FS == false); break; // CP
      case 0xFC: this.CALL(FS == true); break; // CM

      case 0xC9: this.RET(); break; // RET
      case 0xD9: this.RET(); break; // undocumented RET
      case 0xC0: this.RETCond(FZ == false); break; // RNZ
      case 0xC8: this.RETCond(FZ == true); break; // RZ
      case 0xD0: this.RETCond(this._state.regs.af.c == false); break; // RNC
      case 0xD8: this.RETCond(this._state.regs.af.c == true); break; // RC
      case 0xE0: this.RETCond(FP == false); break; // RPO
      case 0xE8: this.RETCond(FP == true); break; // RPE
      case 0xF0: this.RETCond(FS == false); break; // RP
      case 0xF8: this.RETCond(FS == true); break; // RM

      case 0xC7: this.RST(0); break; // RST 0
      case 0xCF: this.RST(1); break; // RST 1
      case 0xD7: this.RST(2); break; // RST 2
      case 0xDF: this.RST(3); break; // RST 3
      case 0xE7: this.RST(4); break; // RST 4
      case 0xEF: this.RST(5); break; // RST 5
      case 0xF7: this.RST(6); break; // RST 6
      case 0xFF: this.RST(7); break; // RST 7

      case 0xDB: this.IN_(); break; // IN
      case 0xD3: this.OUT_(); break; // OUT

      case 0xF3: this._state.ints.inte = false; break; // DI
      case 0xFB: this._state.ints.inte = true; this._state.ints.eiPending = true; break; // EI
      case 0x76: this.HLT(); break; // HLT

      case 0x00: break; // NOP
      case 0x08: break; // undocumented NOP
      case 0x10: break; // undocumented NOP
      case 0x18: break; // undocumented NOP
      case 0x20: break; // undocumented NOP
      case 0x28: break; // undocumented NOP
      case 0x30: break; // undocumented NOP
      case 0x38: break; // undocumented NOP


    default:
      console.log("Handling undocumented instruction. Opcode: {}", this._state.regs.ir.v);
      throw new Error("Exit: UNRECOGNIZED_CPU_INSTR");
      break;
    }

    this._state.ints.mc++;
    this._state.ints.mc %= CPU.M_CYCLES[this._state.regs.ir.v];
  }



////////////////////////////////////////////////////////////////////////////
//
// Memory helpers
//
////////////////////////////////////////////////////////////////////////////

  // _byteNum is the instruction number of byte (0, 2)
  ReadInstrMovePC(byteNum: number): number
  {
    let opcode: number = this.memory?.CpuReadInstr(this._state.regs.pc.word, AddrSpace.RAM, byteNum) ?? 0x00;
    this._state.regs.pc.word++;
    return opcode;
  }

  ReadByte(addr: number, addrSpace: AddrSpace = AddrSpace.RAM, byteNum: number = 0): number
  {
    return this.memory?.CpuRead(addr & 0xFFFF, addrSpace, byteNum) ?? 0x00;
  }

  WriteByte(addr: number, value: number,
    addrSpace: AddrSpace, byteNum: number)
  {
    this.memory?.CpuWrite(addr & 0xFFFF, value, addrSpace, byteNum);
  }

////////////////////////////////////////////////////////////////////////////
//
// Instruction helpers
//
////////////////////////////////////////////////////////////////////////////

  private static readonly parityTable: boolean[] =
  [
    true, false, false, true, false, true, true, false, false, true, true, false, true, false, false, true,
    false, true, true, false, true, false, false, true, true, false, false, true, false, true, true, false,
    false, true, true, false, true, false, false, true, true, false, false, true, false, true, true, false,
    true, false, false, true, false, true, true, false, false, true, true, false, true, false, false, true,
    false, true, true, false, true, false, false, true, true, false, false, true, false, true, true, false,
    true, false, false, true, false, true, true, false, false, true, true, false, true, false, false, true,
    true, false, false, true, false, true, true, false, false, true, true, false, true, false, false, true,
    false, true, true, false, true, false, false, true, true, false, false, true, false, true, true, false,
    false, true, true, false, true, false, false, true, true, false, false, true, false, true, true, false,
    true, false, false, true, false, true, true, false, false, true, true, false, true, false, false, true,
    true, false, false, true, false, true, true, false, false, true, true, false, true, false, false, true,
    false, true, true, false, true, false, false, true, true, false, false, true, false, true, true, false,
    true, false, false, true, false, true, true, false, false, true, true, false, true, false, false, true,
    false, true, true, false, true, false, false, true, true, false, false, true, false, true, true, false,
    false, true, true, false, true, false, false, true, true, false, false, true, false, true, true, false,
    true, false, false, true, false, true, true, false, false, true, true, false, true, false, false, true,
  ];

  // returns the parity of a uint8_t: 0 if a number of set bits of `val` is odd, else 1
  private static GetParity(val: number): boolean {
	  return CPU.parityTable[val];
  }

  private SetZSP(val: number)
  {
    this._state.regs.af.z = val === 0;
    this._state.regs.af.s = (val & 0b10000000) !== 0;
    this._state.regs.af.p = CPU.GetParity(val);
  }


  // rotate register A left
  private RLC()
  {
    this._state.regs.af.c = (this._state.regs.af.a & 0x80) !== 0;
    this._state.regs.af.a = (this._state.regs.af.a << 1) & 0xFF;
    this._state.regs.af.a += this._state.regs.af.c ? 1 : 0;
  }

  // rotate register A right
  private RRC()
  {
    this._state.regs.af.c = (this._state.regs.af.a & 1) !== 0;
    this._state.regs.af.a = this._state.regs.af.a >> 1;
    this._state.regs.af.a |= this._state.regs.af.c ? 1 << 7 : 0;
  }

  // rotate register A left with the carry flag
  private RAL()
  {
    let cy = this._state.regs.af.c;
    this._state.regs.af.c = (this._state.regs.af.a & 0x80) !== 0;
    this._state.regs.af.a = (this._state.regs.af.a << 1) & 0xFF;
    this._state.regs.af.a |= cy ? 1 : 0;
  }

  // rotate register A right with the carry flag
  private RAR()
  {
    let cy = this._state.regs.af.c;
    this._state.regs.af.c = (this._state.regs.af.a & 1) !== 0;
    this._state.regs.af.a = this._state.regs.af.a >> 1;
    this._state.regs.af.a |= cy ? 1 << 7 : 0;
  }

  private MOVRegReg(regDest: number, regSrc: number): number
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.tmp.v = regSrc;
      return regDest;
    default:
      return this._state.regs.tmp.v;
    }
  }

  private LoadRegPtr(regDest: number, addr: number): number
  {
    switch (this._state.ints.mc) {
    case 0:
      return regDest;
    default:
      return this.ReadByte(addr);
    }
  }

  private MOVMemReg(sss: number)
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.tmp.v = sss;
      return;
    case 1:
      this.WriteByte(this._state.regs.hl.word, this._state.regs.tmp.v, AddrSpace.RAM, 0);
      return;
    }
  }

  private MVIRegData(regDest: number): number
  {
    switch (this._state.ints.mc) {
    case 0:
      return regDest;
    default:
      return this.ReadInstrMovePC(1);
    }
  }

  private MVIMemData()
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      this._state.regs.tmp.v = this.ReadInstrMovePC(1);
      return;
    case 2:
      this.WriteByte(this._state.regs.hl.word, this._state.regs.tmp.v, AddrSpace.RAM, 0);
      return;
    }
  }

  LDA()
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      this._state.regs.wz.l = this.ReadInstrMovePC(1);
      return;
    case 2:
      this._state.regs.wz.h = this.ReadInstrMovePC(2);
      return;
    case 3:
      this._state.regs.af.a = this.ReadByte(this._state.regs.wz.word);
      return;
    }
  }

  private STA()
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      this._state.regs.wz.l = this.ReadInstrMovePC(1);
      return;
    case 2:
      this._state.regs.wz.h = this.ReadInstrMovePC(2);
      return;
    case 3:
      this.WriteByte(this._state.regs.wz.word, this._state.regs.af.a, AddrSpace.RAM, 0);
      return;
    }
  }

  private STAX(addr: number)
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      this.WriteByte(addr, this._state.regs.af.a, AddrSpace.RAM, 0);
      return;
    }
  }

  private LXI(regPair: RegPair)
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      return;
    default:
      regPair.l = this.ReadInstrMovePC(1);
      regPair.h = this.ReadInstrMovePC(2);
      return;
    }
  }

  private LHLD()
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      this._state.regs.wz.l = this.ReadInstrMovePC(1);
      return;
    case 2:
      this._state.regs.wz.h = this.ReadInstrMovePC(2);
      return;
    case 3:
      this._state.regs.hl.l = this.ReadByte(this._state.regs.wz.word, AddrSpace.RAM, 0);
      this._state.regs.wz.word++;
      return;
    case 4:
      this._state.regs.hl.h = this.ReadByte(this._state.regs.wz.word, AddrSpace.RAM, 1);
      return;
    }
  }

  private SHLD()
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      this._state.regs.wz.l = this.ReadInstrMovePC(1);
      return;
    case 2:
      this._state.regs.wz.h = this.ReadInstrMovePC(2);
      return;
    case 3:
      this.WriteByte(this._state.regs.wz.word, this._state.regs.hl.l, AddrSpace.RAM, 0);
      this._state.regs.wz.word++;
      return;
    case 4:
      this.WriteByte(this._state.regs.wz.word, this._state.regs.hl.h, AddrSpace.RAM, 1);
      return;
    }
  }

  private SPHL()
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      this._state.regs.sp.word = this._state.regs.hl.word;
      return;
    }
  }

  private XCHG()
  {
    this._state.regs.tmp.v = this._state.regs.de.h;
    this._state.regs.de.h = this._state.regs.hl.h;
    this._state.regs.hl.h = this._state.regs.tmp.v;

    this._state.regs.tmp.v = this._state.regs.de.l;
    this._state.regs.de.l = this._state.regs.hl.l;
    this._state.regs.hl.l = this._state.regs.tmp.v;
  }

  private XTHL()
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      this._state.regs.wz.l = this.ReadByte(this._state.regs.sp.word, AddrSpace.STACK, 0);
      return;
    case 2:
      this._state.regs.wz.h = this.ReadByte(this._state.regs.sp.word + 1, AddrSpace.STACK, 1);
      return;
    case 3:
      this.WriteByte(this._state.regs.sp.word, this._state.regs.hl.l, AddrSpace.STACK, 1);
      return;
    case 4:
      this.WriteByte(this._state.regs.sp.word + 1, this._state.regs.hl.h, AddrSpace.STACK, 0);
      return;
    case 5:
      this._state.regs.hl.word = this._state.regs.wz.word;
      return;
    }
  }

  private PUSH(hb: number, lb: number)
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.sp.word--;
      return;
    case 1:
      this.WriteByte(this._state.regs.sp.word, hb, AddrSpace.STACK, 0);
      return;
    case 2:
      this._state.regs.sp.word--;
      return;
    case 3:
      this.WriteByte(this._state.regs.sp.word, lb, AddrSpace.STACK, 1);
      return;
    }
  }

  private POP(regPair: number): number
  {
    switch (this._state.ints.mc) {
    case 0:
      return regPair;
    case 1:
      return regPair;
    default:
      let regL: number = this.ReadByte(this._state.regs.sp.word, AddrSpace.STACK, 0);
      this._state.regs.sp.word++;
      let regH: number = this.ReadByte(this._state.regs.sp.word, AddrSpace.STACK, 1);
      this._state.regs.sp.word++;
      return (regH << 8) | regL;
    }
  }

  // adds a value (+ an optional carry flag) to a register
  private ADD(a: number, b: number, cy: boolean): number
  {
    let result: number = a + b + (cy ? 1 : 0);
    this._state.regs.af.c = ((result ^ a ^ b) & 0x100) !== 0;
    this._state.regs.af.ac = ((result ^ a ^ b) & 0x10) !== 0;
    result &= 0xFF;
    this.SetZSP(result);
    return result;
  }

  private ADDMem(cy: boolean)
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.act.v = this._state.regs.af.a;
      return;
    case 1:
      this._state.regs.tmp.v = this.ReadByte(this._state.regs.hl.word);
      this._state.regs.af.a = this.ADD(this._state.regs.act.v, this._state.regs.tmp.v, cy);
      return;
    }
  }

  private ADI(cy: boolean)
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.act.v = this._state.regs.af.a;
      return;
    case 1:
      this._state.regs.tmp.v = this.ReadInstrMovePC(1);
      this._state.regs.af.a = this.ADD(this._state.regs.act.v, this._state.regs.tmp.v, cy);
      return;
    }
  }

  // substracts a uint8_t (+ an optional carry flag) from a register
  // see https://stackoverflow.com/a/8037485
  private SUB(a: number, b: number, cy: boolean): number
  {
    let result = this.ADD(a, (~b & 0xFF), !cy);
    this._state.regs.af.c = !this._state.regs.af.c;
    return result;
  }

  private SUBMem(cy: boolean)
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.act.v = this._state.regs.af.a;
      return;
    case 1:
      this._state.regs.tmp.v = this.ReadByte(this._state.regs.hl.word);
      this._state.regs.af.a = this.SUB(this._state.regs.act.v, this._state.regs.tmp.v, cy);
      return;
    }
  }

  private SBI(cy: boolean)
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.act.v = this._state.regs.af.a;
      return;
    case 1:
      this._state.regs.tmp.v = this.ReadInstrMovePC(1);
      this._state.regs.af.a = this.SUB(this._state.regs.act.v, this._state.regs.tmp.v, cy);
      return;
    }
  }

  private DAD(regPair: RegPair)
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1: {
        this._state.regs.act.v = regPair.l;
        this._state.regs.tmp.v = this._state.regs.hl.l;
        const res: number = this._state.regs.act.v + this._state.regs.tmp.v;
        this._state.regs.af.c = (res & 0x100) !== 0;
        this._state.regs.hl.l = res & 0xFF;
        return;
      }
    case 2: {
        this._state.regs.act.v = regPair.h;
        this._state.regs.tmp.v = this._state.regs.hl.h;
        const result: number = this._state.regs.act.v + this._state.regs.tmp.v + (this._state.regs.af.c ? 1 : 0);
        this._state.regs.af.c = (result & 0x100) !== 0;
        this._state.regs.hl.h = result & 0xFF;
        return;
      }
    }
  }

  private INR(regDest: number): number
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.tmp.v = regDest;
      this._state.regs.tmp.v++;
      this._state.regs.af.ac = (this._state.regs.tmp.v & 0xF) == 0;
      this.SetZSP(this._state.regs.tmp.v);
      return regDest;
    default:
      return this._state.regs.tmp.v;
    }
  }

  private INRMem()
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      this._state.regs.tmp.v = this.ReadByte(this._state.regs.hl.word);
      this._state.regs.tmp.v++;
      this._state.regs.af.ac = (this._state.regs.tmp.v & 0xF) == 0;
      this.SetZSP(this._state.regs.tmp.v);
      return;
    case 2:
      this.WriteByte(this._state.regs.hl.word, this._state.regs.tmp.v, AddrSpace.RAM, 0);
      return;
    }
  }

  private DCR(regDest: number): number
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.tmp.v = regDest;
      this._state.regs.tmp.v--;
      this._state.regs.af.ac = !((this._state.regs.tmp.v & 0xF) == 0xF);
      this.SetZSP(this._state.regs.tmp.v);
      return regDest;
    default:
      return this._state.regs.tmp.v;
    }
  }

  private DCRMem()
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      this._state.regs.tmp.v = this.ReadByte(this._state.regs.hl.word);
      this._state.regs.tmp.v--;
      this._state.regs.af.ac = !((this._state.regs.tmp.v & 0xF) == 0xF);
      this.SetZSP(this._state.regs.tmp.v);
      return;
    case 2:
      this.WriteByte(this._state.regs.hl.word, this._state.regs.tmp.v, AddrSpace.RAM, 0);
      return;
    }
  }

  private INX(regPair: RegPair)
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.wz.word = (regPair.word + 1) & 0xFFFF;
      return;
    case 1:
      regPair.word = this._state.regs.wz.word;
      return;
    }
  }

  private DCX(regPair: RegPair)
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.wz.word = (regPair.word - 1) & 0xFFFF;
      return;
    case 1:
      regPair.word = this._state.regs.wz.word;
      return;
    }
  }

  // Decimal Adjust Accumulator: the eight-bit number in register this._state.regs.af.a is adjusted
  // to form two four-bit binary-coded-decimal digits.
  // For example, if this._state.regs.af.a=$2B and DAA is executed, this._state.regs.af.a becomes $31.
  private DAA()
  {
    let cy: boolean = this._state.regs.af.c;
    let correction: number = 0;

    const lsb: number = (this._state.regs.af.a & 0x0F);
    const msb: number = (this._state.regs.af.a >> 4);

    if (this._state.regs.af.ac || lsb > 9)
    {
      correction += 0x06;
    }

    if (this._state.regs.af.c || msb > 9 || (msb >= 9 && lsb > 9))
    {
      correction += 0x60;
      cy = true;
    }

    this._state.regs.af.a = this.ADD(this._state.regs.af.a, correction, false);
    this._state.regs.af.c = cy;
  }

  private ANA(sss: number)
  {
    this._state.regs.act.v = this._state.regs.af.a;
    this._state.regs.tmp.v = sss;
    this._state.regs.af.a = this._state.regs.act.v & this._state.regs.tmp.v;
    this._state.regs.af.c = false;
    this._state.regs.af.ac = ((this._state.regs.act.v | this._state.regs.tmp.v) & 0x08) != 0;
    this.SetZSP(this._state.regs.af.a);
  }

  private ANAMem()
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.act.v = this._state.regs.af.a;
      return;
    case 1:
      this._state.regs.tmp.v = this.ReadByte(this._state.regs.hl.word);
      this._state.regs.af.a = this._state.regs.act.v & this._state.regs.tmp.v;
      this._state.regs.af.c = false;
      this._state.regs.af.ac = ((this._state.regs.act.v | this._state.regs.tmp.v) & 0x08) != 0;
      this.SetZSP(this._state.regs.af.a);
      return;
    }
  }

  private ANI()
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.act.v = this._state.regs.af.a;
      return;
    case 1:
      this._state.regs.tmp.v = this.ReadInstrMovePC(1);
      this._state.regs.af.a = this._state.regs.act.v & this._state.regs.tmp.v;
      this._state.regs.af.c = false;
      this._state.regs.af.ac = ((this._state.regs.act.v | this._state.regs.tmp.v) & 0x08) != 0;
      this.SetZSP(this._state.regs.af.a);
      return;
    }
  }

  // executes a logic "xor" between register this._state.regs.af.a and a uint8_t, then stores the
  // result in register this._state.regs.af.a
  private XRA(sss: number)
  {
    this._state.regs.act.v = this._state.regs.af.a;
    this._state.regs.tmp.v = sss;
    this._state.regs.af.a = this._state.regs.act.v ^ this._state.regs.tmp.v;
    this._state.regs.af.c = false;
    this._state.regs.af.ac = false;
    this.SetZSP(this._state.regs.af.a);
  }

  private XRAMem()
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.act.v = this._state.regs.af.a;
      return;
    case 1:
      this._state.regs.tmp.v = this.ReadByte(this._state.regs.hl.word);
      this._state.regs.af.a = this._state.regs.act.v ^ this._state.regs.tmp.v;
      this._state.regs.af.c = false;
      this._state.regs.af.ac = false;
      this.SetZSP(this._state.regs.af.a);
      return;
    }
  }

  private XRI()
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.act.v = this._state.regs.af.a;
      return;
    case 1:
      this._state.regs.tmp.v = this.ReadInstrMovePC(1);
      this._state.regs.af.a = this._state.regs.act.v ^ this._state.regs.tmp.v;
      this._state.regs.af.c = false;
      this._state.regs.af.ac = false;
      this.SetZSP(this._state.regs.af.a);
      return;
    }
  }

  // executes a logic "or" between register this._state.regs.af.a and a uint8_t, then stores the
  // result in register this._state.regs.af.a
  private ORA(sss: number)
  {
    this._state.regs.act.v = this._state.regs.af.a;
    this._state.regs.tmp.v = sss;
    this._state.regs.af.a = this._state.regs.act.v | this._state.regs.tmp.v;
    this._state.regs.af.c = false;
    this._state.regs.af.ac = false;
    this.SetZSP(this._state.regs.af.a);
  }

  private ORAMem()
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.act.v = this._state.regs.af.a;
      return;
    case 1:
      this._state.regs.tmp.v = this.ReadByte(this._state.regs.hl.word);
      this._state.regs.af.a = this._state.regs.act.v | this._state.regs.tmp.v;
      this._state.regs.af.c = false;
      this._state.regs.af.ac = false;
      this.SetZSP(this._state.regs.af.a);
      return;
    }
  }

  private ORI()
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.act.v = this._state.regs.af.a;
      return;
    case 1:
      this._state.regs.tmp.v = this.ReadInstrMovePC(1);
      this._state.regs.af.a = this._state.regs.act.v | this._state.regs.tmp.v;
      this._state.regs.af.c = false;
      this._state.regs.af.ac = false;
      this.SetZSP(this._state.regs.af.a);
      return;
    }
  }

  // compares the register this._state.regs.af.a to another uint8_t
  private CMP(sss: number)
  {
    this.SUB(this._state.regs.af.a, sss, false);
  }

  private CMPMem()
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.act.v = this._state.regs.af.a;
      return;
    case 1: {
        this._state.regs.tmp.v = this.ReadByte(this._state.regs.hl.word);
        this.SUB(this._state.regs.act.v, this._state.regs.tmp.v, false);
        return;
      }
    }
  }

  private CPI()
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.act.v = this._state.regs.af.a;
      return;
    case 1:
      this._state.regs.tmp.v = this.ReadInstrMovePC(1);
      this.SUB(this._state.regs.act.v, this._state.regs.tmp.v, false);
      return;
    }
  }

  private JMP(condition: boolean = true)
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      this._state.regs.wz.l = this.ReadInstrMovePC(1);
      return;
    case 2:
      this._state.regs.wz.h = this.ReadInstrMovePC(2);
      if (condition)
      {
        this._state.regs.pc.word = this._state.regs.wz.word;
      }
      return;
    }
  }

  private PCHL()
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      this._state.regs.pc.word = this._state.regs.hl.word;
      return;
    }
  }

  // pushes the current pc to the stack, then jumps to an address
  private CALL(condition: boolean = true)
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.sp.word -= condition ? 1 : 0;
      return;
    case 1:
      this._state.regs.wz.l = this.ReadInstrMovePC(1);
      return;
    case 2:
      this._state.regs.wz.h = this.ReadInstrMovePC(2);
      return;
    case 3:
      if (condition)	{
        this.WriteByte(this._state.regs.sp.word, this._state.regs.pc.h, AddrSpace.STACK, 0);
        this._state.regs.sp.word--;
      }
      else {
        // end execution
        this._state.ints.mc = 5;
      }
      return;
    case 4:
      this.WriteByte(this._state.regs.sp.word, this._state.regs.pc.l, AddrSpace.STACK, 1);
      return;
    case 5:
      this._state.regs.pc.word = this._state.regs.wz.word;
      return;
    }
  }

  // pushes the current pc to the stack, then jumps to an address
  private RST(arg: number)
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.sp.word--;
      return;
    case 1:
      this.WriteByte(this._state.regs.sp.word, this._state.regs.pc.h, AddrSpace.STACK, 0);
      this._state.regs.sp.word--;
      return;
    case 2:
      this._state.regs.wz.h = 0;
      this._state.regs.wz.l = arg << 3;
      this.WriteByte(this._state.regs.sp.word, this._state.regs.pc.l, AddrSpace.STACK, 1);
      return;
    case 3:
      this._state.regs.pc.word = this._state.regs.wz.word;
      return;
    }
  }

  // returns from subroutine
  private RET()
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      this._state.regs.wz.l = this.ReadByte(this._state.regs.sp.word, AddrSpace.STACK, 0);
      this._state.regs.sp.word++;
      return;
    case 2:
      this._state.regs.wz.h = this.ReadByte(this._state.regs.sp.word, AddrSpace.STACK, 1);
      this._state.regs.sp.word++;
      this._state.regs.pc.word = this._state.regs.wz.word;
      return;
    }
  }

  // returns from subroutine if a condition is met
  private RETCond(condition: boolean)
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      if (!condition) this._state.ints.mc = 3;
      return;
    case 2:
      this._state.regs.wz.l = this.ReadByte(this._state.regs.sp.word, AddrSpace.STACK, 0);
      this._state.regs.sp.word++;
      return;
    case 3:
      this._state.regs.wz.h = this.ReadByte(this._state.regs.sp.word, AddrSpace.STACK, 1);
      this._state.regs.sp.word++;
      this._state.regs.pc.word = this._state.regs.wz.word;
      return;
    }
  }

  private IN_()
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      this._state.regs.wz.h = 0;
      this._state.regs.wz.l = this.ReadInstrMovePC(1);
      return;
    case 2:
      this._state.regs.af.a = this.Input?.(this._state.regs.wz.l) ?? 0x00;
      return;
    }
  }

  private OUT_()
  {
    switch (this._state.ints.mc) {
    case 0:
      return;
    case 1:
      this._state.regs.wz.h = 0;
      this._state.regs.wz.l = this.ReadInstrMovePC(1);
      this.Output?.(this._state.regs.wz.l, this._state.regs.af.a);
      return;
    case 2:
      return;
    }
  }

  private HLT()
  {
    switch (this._state.ints.mc) {
    case 0:
      this._state.regs.pc.word--;
      return;
    case 1:
      this.ReadInstrMovePC(0);
      // to loop into the M2 of HLT
      if (!this._state.ints.iff) {
        this._state.ints.hlta = true;
        this._state.ints.mc--;
        this._state.regs.pc.word--;
      }
      return;
	  }
  }
}
