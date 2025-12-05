import memory from './memory';
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
const PSW_NUL_FLAGS: number = ~0b00101000;

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
    if (this.s) f |= 0b10000000;
    if (this.z) f |= 0b01000000;
    if (this.ac) f |= 0b00100000;;
    if (this.p) f |= 0b00000100;
    if (this.c) f |= 0b00000001;
    return f | PSW_INIT;
  }

  set f(value: number) {
    this.s = (value & 0b10000000) !== 0;
    this.z = (value & 0b01000000) !== 0;
    this.ac = (value & 0b00100000) !== 0;
    this.p = (value & 0b00000100) !== 0;
    this.c = (value & 0b00000001) !== 0;
  }

  get word(): number {
    return (this.a << 8) | this.f;
  }
  set word(val: number) {
    this.a = (val >> 8) & 0xff;
    this.f = val;
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
}

export default class CPU
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

  Init() {
    // TODO: all regs must be rundom at init
    this._state.regs.af.word = PSW_INIT;
    this._state.regs.bc.word = 0;
    this._state.regs.de.word = 0;
    this._state.regs.hl.word = 0;

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
        // TODO: check this
        //this.memory?.CpuInvokesRst7();
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

  GetInstrType(opcode: number): number
  {
	  return CPU.INSTR_TYPES[opcode];
  }

  Decode()
  {
	  switch (this._state.regs.ir.v)
	  {
    	case 0x7F: this._state.regs.af.a = this.MOVRegReg(this._state.regs.af.a, this._state.regs.af.a); break; // MOV A,A
      case 0x78: this._state.regs.af.a = this.MOVRegReg(this._state.regs.af.a, this._state.regs.bc.h); break; // MOV A,B
      case 0x79: this._state.regs.af.a = this.MOVRegReg(this._state.regs.af.a, this._state.regs.bc.l); break; // MOV A,C
      case 0x7A: this._state.regs.af.a = this.MOVRegReg(this._state.regs.af.a, this._state.regs.de.h); break; // MOV A,D
      case 0x7B: this._state.regs.af.a = this.MOVRegReg(this._state.regs.af.a, this._state.regs.de.l); break; // MOV A,E
      case 0x7C: this._state.regs.af.a = this.MOVRegReg(this._state.regs.af.a, this._state.regs.hl.h); break; // MOV A,H
      case 0x7D: this._state.regs.af.a = this.MOVRegReg(this._state.regs.af.a, this._state.regs.hl.l); break; // MOV A,L

      case 0x47: this._state.regs.bc.h = this.MOVRegReg(this._state.regs.bc.h, this._state.regs.af.a); break; // MOV B,A
      case 0x40: this._state.regs.bc.h = this.MOVRegReg(this._state.regs.bc.h, this._state.regs.bc.h); break; // MOV B,B
      case 0x41: this._state.regs.bc.h = this.MOVRegReg(this._state.regs.bc.h, this._state.regs.bc.l); break; // MOV B,C
      case 0x42: this._state.regs.bc.h = this.MOVRegReg(this._state.regs.bc.h, this._state.regs.de.h); break; // MOV B,D
      case 0x43: this._state.regs.bc.h = this.MOVRegReg(this._state.regs.bc.h, this._state.regs.de.l); break; // MOV B,E
      case 0x44: this._state.regs.bc.h = this.MOVRegReg(this._state.regs.bc.h, this._state.regs.hl.h); break; // MOV B,H
      case 0x45: this._state.regs.bc.h = this.MOVRegReg(this._state.regs.bc.h, this._state.regs.hl.l); break; // MOV B,L
      case 0x4F: this._state.regs.bc.l = this.MOVRegReg(this._state.regs.bc.l, this._state.regs.af.a); break; // MOV C,A
      case 0x48: this._state.regs.bc.l = this.MOVRegReg(this._state.regs.bc.l, this._state.regs.bc.h); break; // MOV C,B
      case 0x49: this._state.regs.bc.l = this.MOVRegReg(this._state.regs.bc.l, this._state.regs.bc.l); break; // MOV C,C
      case 0x4A: this._state.regs.bc.l = this.MOVRegReg(this._state.regs.bc.l, this._state.regs.de.h); break; // MOV C,D
      case 0x4B: this._state.regs.bc.l = this.MOVRegReg(this._state.regs.bc.l, this._state.regs.de.l); break; // MOV C,E
      case 0x4C: this._state.regs.bc.l = this.MOVRegReg(this._state.regs.bc.l, this._state.regs.hl.h); break; // MOV C,H
      case 0x4D: this._state.regs.bc.l = this.MOVRegReg(this._state.regs.bc.l, this._state.regs.hl.l); break; // MOV C,L

      case 0x57: this._state.regs.de.h = this.MOVRegReg(this._state.regs.de.h, this._state.regs.af.a); break; // MOV D,A
      case 0x50: this._state.regs.de.h = this.MOVRegReg(this._state.regs.de.h, this._state.regs.bc.h); break; // MOV D,B
      case 0x51: this._state.regs.de.h = this.MOVRegReg(this._state.regs.de.h, this._state.regs.bc.l); break; // MOV D,C
      case 0x52: this._state.regs.de.h = this.MOVRegReg(this._state.regs.de.h, this._state.regs.de.h); break; // MOV D,D
      case 0x53: this._state.regs.de.h = this.MOVRegReg(this._state.regs.de.h, this._state.regs.de.l); break; // MOV D,E
      case 0x54: this._state.regs.de.h = this.MOVRegReg(this._state.regs.de.h, this._state.regs.hl.h); break; // MOV D,H
      case 0x55: this._state.regs.de.h = this.MOVRegReg(this._state.regs.de.h, this._state.regs.hl.l); break; // MOV D,L

      case 0x5F: this._state.regs.de.l = this.MOVRegReg(this._state.regs.de.l, this._state.regs.af.a); break; // MOV E,A
      case 0x58: this._state.regs.de.l = this.MOVRegReg(this._state.regs.de.l, this._state.regs.bc.h); break; // MOV E,B
      case 0x59: this._state.regs.de.l = this.MOVRegReg(this._state.regs.de.l, this._state.regs.bc.l); break; // MOV E,C
      case 0x5A: this._state.regs.de.l = this.MOVRegReg(this._state.regs.de.l, this._state.regs.de.h); break; // MOV E,D
      case 0x5B: this._state.regs.de.l = this.MOVRegReg(this._state.regs.de.l, this._state.regs.de.l); break; // MOV E,E
      case 0x5C: this._state.regs.de.l = this.MOVRegReg(this._state.regs.de.l, this._state.regs.hl.h); break; // MOV E,H
      case 0x5D: this._state.regs.de.l = this.MOVRegReg(this._state.regs.de.l, this._state.regs.hl.l); break; // MOV E,L

      case 0x67: this._state.regs.hl.h = this.MOVRegReg(this._state.regs.hl.h, this._state.regs.af.a); break; // MOV H,A
      case 0x60: this._state.regs.hl.h = this.MOVRegReg(this._state.regs.hl.h, this._state.regs.bc.h); break; // MOV H,B
      case 0x61: this._state.regs.hl.h = this.MOVRegReg(this._state.regs.hl.h, this._state.regs.bc.l); break; // MOV H,C
      case 0x62: this._state.regs.hl.h = this.MOVRegReg(this._state.regs.hl.h, this._state.regs.de.h); break; // MOV H,D
      case 0x63: this._state.regs.hl.h = this.MOVRegReg(this._state.regs.hl.h, this._state.regs.de.l); break; // MOV H,E
      case 0x64: this._state.regs.hl.h = this.MOVRegReg(this._state.regs.hl.h, this._state.regs.hl.h); break; // MOV H,H
      case 0x65: this._state.regs.hl.h = this.MOVRegReg(this._state.regs.hl.h, this._state.regs.hl.l); break; // MOV H,L
      case 0x6F: this._state.regs.hl.l = this.MOVRegReg(this._state.regs.hl.l, this._state.regs.af.a); break; // MOV L,A
      case 0x68: this._state.regs.hl.l = this.MOVRegReg(this._state.regs.hl.l, this._state.regs.bc.h); break; // MOV L,B
      case 0x69: this._state.regs.hl.l = this.MOVRegReg(this._state.regs.hl.l, this._state.regs.bc.l); break; // MOV L,C
      case 0x6A: this._state.regs.hl.l = this.MOVRegReg(this._state.regs.hl.l, this._state.regs.de.h); break; // MOV L,D
      case 0x6B: this._state.regs.hl.l = this.MOVRegReg(this._state.regs.hl.l, this._state.regs.de.l); break; // MOV L,E
      case 0x6C: this._state.regs.hl.l = this.MOVRegReg(this._state.regs.hl.l, this._state.regs.hl.h); break; // MOV L,H
      case 0x6D: this._state.regs.hl.l = this.MOVRegReg(this._state.regs.hl.l, this._state.regs.hl.l); break; // MOV L,L

      case 0x7E: this._state.regs.af.a = this.LoadRegPtr(this._state.regs.af.a, this._state.regs.hl.word); break; // MOV A,M
      case 0x46: this._state.regs.bc.h = this.LoadRegPtr(this._state.regs.bc.h, this._state.regs.hl.word); break; // MOV B,M
      case 0x4E: this._state.regs.bc.l = this.LoadRegPtr(this._state.regs.bc.l, this._state.regs.hl.word); break; // MOV C,M
      case 0x56: this._state.regs.de.h = this.LoadRegPtr(this._state.regs.de.h, this._state.regs.hl.word); break; // MOV D,M
      case 0x5E: this._state.regs.de.l = this.LoadRegPtr(this._state.regs.de.l, this._state.regs.hl.word); break; // MOV E,M
      case 0x66: this._state.regs.hl.h = this.LoadRegPtr(this._state.regs.hl.h, this._state.regs.hl.word); break; // MOV H,M
      case 0x6E: this._state.regs.hl.l = this.LoadRegPtr(this._state.regs.hl.l, this._state.regs.hl.word); break; // MOV L,M

      case 0x77: this.MOVMemReg(this._state.regs.af.a); break; // MOV M,A
      case 0x70: this.MOVMemReg(this._state.regs.bc.h); break; // MOV M,B
      case 0x71: this.MOVMemReg(this._state.regs.bc.l); break; // MOV M,C
      case 0x72: this.MOVMemReg(this._state.regs.de.h); break; // MOV M,D
      case 0x73: this.MOVMemReg(this._state.regs.de.l); break; // MOV M,E
      case 0x74: this.MOVMemReg(this._state.regs.hl.h); break; // MOV M,H
      case 0x75: this.MOVMemReg(this._state.regs.hl.l); break; // MOV M,L

      case 0x3E: this._state.regs.af.a = this.MVIRegData(this._state.regs.af.a); break; // MVI A,uint8_t
      case 0x06: this._state.regs.bc.h = this.MVIRegData(this._state.regs.bc.h); break; // MVI B,uint8_t
      case 0x0E: this._state.regs.bc.l = this.MVIRegData(this._state.regs.bc.l); break; // MVI C,uint8_t
      case 0x16: this._state.regs.de.h = this.MVIRegData(this._state.regs.de.h); break; // MVI D,uint8_t
      case 0x1E: this._state.regs.de.l = this.MVIRegData(this._state.regs.de.l); break; // MVI E,uint8_t
      case 0x26: this._state.regs.hl.h = this.MVIRegData(this._state.regs.hl.h); break; // MVI H,uint8_t
      case 0x2E: this._state.regs.hl.l = this.MVIRegData(this._state.regs.hl.l); break; // MVI L,uint8_t
      case 0x36: this.MVIMemData(); break; // MVI M,uint8_t

      case 0x0A: this._state.regs.af.a = this.LoadRegPtr(this._state.regs.af.a, this._state.regs.bc.word); break; // LDAX B
      case 0x1A: this._state.regs.af.a = this.LoadRegPtr(this._state.regs.af.a, this._state.regs.de.word); break; // LDAX D
      case 0x3A: this.LDA(); break; // LDA word

      case 0x02: this.STAX(this._state.regs.bc.word); break; // STAX B
      case 0x12: this.STAX(this._state.regs.de.word); break; // STAX D
      case 0x32: this.STA(); break; // STA word

      case 0x01: this.LXI(this._state.regs.bc); break; // LXI B,word
      case 0x11: this.LXI(this._state.regs.de); break; // LXI D,word
      case 0x21: this.LXI(this._state.regs.hl); break; // LXI H,word
      case 0x31: this.LXI(this._state.regs.sp); break; // LXI SP,word
      case 0x2A: this.LHLD(); break; // LHLD
      case 0x22: this.SHLD(); break; // SHLD
      case 0xF9: this.SPHL(); break; // SPHL

      case 0xEB: this.XCHG(); break; // XCHG
      case 0xE3: this.XTHL(); break; // XTHL

      case 0xC5: this.PUSH(this._state.regs.bc.h, this._state.regs.bc.l); break; // PUSH B
      case 0xD5: this.PUSH(this._state.regs.de.h, this._state.regs.de.l); break; // PUSH D
      case 0xE5: this.PUSH(this._state.regs.hl.h, this._state.regs.hl.l); break; // PUSH H
      case 0xF5: this.PUSH(this._state.regs.af.a, this._state.regs.af.f); break; // PUSH PSW
      case 0xC1: this._state.regs.bc.word = this.POP(this._state.regs.bc.word); break; // POP B
      case 0xD1: this._state.regs.de.word = this.POP(this._state.regs.de.word); break; // POP D
      case 0xE1: this._state.regs.hl.word = this.POP(this._state.regs.hl.word); break; // POP H
      case 0xF1: this._state.regs.af.word = this.POP(this._state.regs.af.word); break; // POP PSW

      case 0x87: this._state.regs.af.a = this.ADD(this._state.regs.af.a, this._state.regs.af.a, false); break; // ADD A
      case 0x80: this._state.regs.af.a = this.ADD(this._state.regs.af.a, this._state.regs.bc.h, false); break; // ADD B
      case 0x81: this._state.regs.af.a = this.ADD(this._state.regs.af.a, this._state.regs.bc.l, false); break; // ADD C
      case 0x82: this._state.regs.af.a = this.ADD(this._state.regs.af.a, this._state.regs.de.h, false); break; // ADD D
      case 0x83: this._state.regs.af.a = this.ADD(this._state.regs.af.a, this._state.regs.de.l, false); break; // ADD E
      case 0x84: this._state.regs.af.a = this.ADD(this._state.regs.af.a, this._state.regs.hl.h, false); break; // ADD H
      case 0x85: this._state.regs.af.a = this.ADD(this._state.regs.af.a, this._state.regs.hl.l, false); break; // ADD L
      case 0x86: this.ADDMem(false); break; // ADD M
      case 0xC6: this.ADI(false); break; // ADI uint8_t

      case 0x8F: this._state.regs.af.a = this.ADD(this._state.regs.af.a, this._state.regs.af.a, true); break; // ADC A
      case 0x88: this._state.regs.af.a = this.ADD(this._state.regs.af.a, this._state.regs.bc.h, true); break; // ADC B
      case 0x89: this._state.regs.af.a = this.ADD(this._state.regs.af.a, this._state.regs.bc.l, true); break; // ADC C
      case 0x8A: this._state.regs.af.a = this.ADD(this._state.regs.af.a, this._state.regs.de.h, true); break; // ADC D
      case 0x8B: this._state.regs.af.a = this.ADD(this._state.regs.af.a, this._state.regs.de.l, true); break; // ADC E
      case 0x8C: this._state.regs.af.a = this.ADD(this._state.regs.af.a, this._state.regs.hl.h, true); break; // ADC H
      case 0x8D: this._state.regs.af.a = this.ADD(this._state.regs.af.a, this._state.regs.hl.l, true); break; // ADC L
      case 0x8E: this.ADDMem(true); break; // ADC M
      case 0xCE: this.ADI(true); break; // ACI uint8_t

      case 0x97: this._state.regs.af.a = this.SUB(this._state.regs.af.a, this._state.regs.af.a, false); break; // SUB A
      case 0x90: this._state.regs.af.a = this.SUB(this._state.regs.af.a, this._state.regs.bc.h, false); break; // SUB B
      case 0x91: this._state.regs.af.a = this.SUB(this._state.regs.af.a, this._state.regs.bc.l, false); break; // SUB C
      case 0x92: this._state.regs.af.a = this.SUB(this._state.regs.af.a, this._state.regs.de.h, false); break; // SUB D
      case 0x93: this._state.regs.af.a = this.SUB(this._state.regs.af.a, this._state.regs.de.l, false); break; // SUB E
      case 0x94: this._state.regs.af.a = this.SUB(this._state.regs.af.a, this._state.regs.hl.h, false); break; // SUB H
      case 0x95: this._state.regs.af.a = this.SUB(this._state.regs.af.a, this._state.regs.hl.l, false); break; // SUB L
      case 0x96: this.SUBMem(false); break; // SUB M
      case 0xD6: this.SBI(false); break; // SUI uint8_t

      case 0x9F: this._state.regs.af.a = this.SUB(this._state.regs.af.a, this._state.regs.af.a, this._state.regs.af.c); break; // SBB A
      case 0x98: this._state.regs.af.a = this.SUB(this._state.regs.af.a, this._state.regs.bc.h, this._state.regs.af.c); break; // SBB B
      case 0x99: this._state.regs.af.a = this.SUB(this._state.regs.af.a, this._state.regs.bc.l, this._state.regs.af.c); break; // SBB C
      case 0x9A: this._state.regs.af.a = this.SUB(this._state.regs.af.a, this._state.regs.de.h, this._state.regs.af.c); break; // SBB D
      case 0x9B: this._state.regs.af.a = this.SUB(this._state.regs.af.a, this._state.regs.de.l, this._state.regs.af.c); break; // SBB E
      case 0x9C: this._state.regs.af.a = this.SUB(this._state.regs.af.a, this._state.regs.hl.h, this._state.regs.af.c); break; // SBB H
      case 0x9D: this._state.regs.af.a = this.SUB(this._state.regs.af.a, this._state.regs.hl.l, this._state.regs.af.c); break; // SBB L
      case 0x9E: this.SUBMem(this._state.regs.af.c); break; // SBB M
      case 0xDE: this.SBI(this._state.regs.af.c); break; // SBI uint8_t

      case 0x09: this.DAD(this._state.regs.bc); break; // DAD B
      case 0x19: this.DAD(this._state.regs.de); break; // DAD D
      case 0x29: this.DAD(this._state.regs.hl); break; // DAD H
      case 0x39: this.DAD(this._state.regs.sp); break; // DAD SP

      case 0x3C: this._state.regs.af.a = this.INR(this._state.regs.af.a); break; // INR A
      case 0x04: this._state.regs.bc.h = this.INR(this._state.regs.bc.h); break; // INR B
      case 0x0C: this._state.regs.bc.l = this.INR(this._state.regs.bc.l); break; // INR C
      case 0x14: this._state.regs.de.h = this.INR(this._state.regs.de.h); break; // INR D
      case 0x1C: this._state.regs.de.l = this.INR(this._state.regs.de.l); break; // INR E
      case 0x24: this._state.regs.hl.h = this.INR(this._state.regs.hl.h); break; // INR H
      case 0x2C: this._state.regs.hl.l = this.INR(this._state.regs.hl.l); break; // INR L
      case 0x34: this.INRMem(); break; // INR M

      case 0x3D: this._state.regs.af.a = this.DCR(this._state.regs.af.a); break; // DCR A
      case 0x05: this._state.regs.bc.h = this.DCR(this._state.regs.bc.h); break; // DCR B
      case 0x0D: this._state.regs.bc.l = this.DCR(this._state.regs.bc.l); break; // DCR C
      case 0x15: this._state.regs.de.h = this.DCR(this._state.regs.de.h); break; // DCR D
      case 0x1D: this._state.regs.de.l = this.DCR(this._state.regs.de.l); break; // DCR E
      case 0x25: this._state.regs.hl.h = this.DCR(this._state.regs.hl.h); break; // DCR H
      case 0x2D: this._state.regs.hl.l = this.DCR(this._state.regs.hl.l); break; // DCR L
      case 0x35: this.DCRMem(); break; // DCR M

      case 0x03: this.INX(this._state.regs.bc); break; // INX B
      case 0x13: this.INX(this._state.regs.de); break; // INX D
      case 0x23: this.INX(this._state.regs.hl); break; // INX H
      case 0x33: this.INX(this._state.regs.sp); break; // INX SP

      case 0x0B: this.DCX(this._state.regs.bc); break; // DCX B
      case 0x1B: this.DCX(this._state.regs.de); break; // DCX D
      case 0x2B: this.DCX(this._state.regs.hl); break; // DCX H
      case 0x3B: this.DCX(this._state.regs.sp); break; // DCX SP

      case 0x27: this.DAA(); break; // DAA
      case 0x2F: this._state.regs.af.a = (~this._state.regs.af.a) & 0xFF; break; // CMA
      case 0x37: this._state.regs.af.c = true; break; // STC
      case 0x3F: this._state.regs.af.c = !this._state.regs.af.c; break; // CMC

      case 0x07: this.RLC(); break; // RLC
      case 0x0F: this.RRC(); break; // RRC
      case 0x17: this.RAL(); break; // RAL
      case 0x1F: this.RAR(); break; // RAR

      case 0xA7: this.ANA(this._state.regs.af.a); break; // ANA A
      case 0xA0: this.ANA(this._state.regs.bc.h); break; // ANA B
      case 0xA1: this.ANA(this._state.regs.bc.l); break; // ANA C
      case 0xA2: this.ANA(this._state.regs.de.h); break; // ANA D
      case 0xA3: this.ANA(this._state.regs.de.l); break; // ANA E
      case 0xA4: this.ANA(this._state.regs.hl.h); break; // ANA H
      case 0xA5: this.ANA(this._state.regs.hl.l); break; // ANA L
      case 0xA6: this.ANAMem(); break; // ANA M
      case 0xE6: this.ANI(); break; // ANI uint8_t

      case 0xAF: this.XRA(this._state.regs.af.a); break; // XRA A
      case 0xA8: this.XRA(this._state.regs.bc.h); break; // XRA B
      case 0xA9: this.XRA(this._state.regs.bc.l); break; // XRA C
      case 0xAA: this.XRA(this._state.regs.de.h); break; // XRA D
      case 0xAB: this.XRA(this._state.regs.de.l); break; // XRA E
      case 0xAC: this.XRA(this._state.regs.hl.h); break; // XRA H
      case 0xAD: this.XRA(this._state.regs.hl.l); break; // XRA L
      case 0xAE: this.XRAMem(); break; // XRA M
      case 0xEE: this.XRI(); break; // XRI uint8_t

      case 0xB7: this.ORA(this._state.regs.af.a); break; // ORA A
      case 0xB0: this.ORA(this._state.regs.bc.h); break; // ORA B
      case 0xB1: this.ORA(this._state.regs.bc.l); break; // ORA C
      case 0xB2: this.ORA(this._state.regs.de.h); break; // ORA D
      case 0xB3: this.ORA(this._state.regs.de.l); break; // ORA E
      case 0xB4: this.ORA(this._state.regs.hl.h); break; // ORA H
      case 0xB5: this.ORA(this._state.regs.hl.l); break; // ORA L
      case 0xB6: this.ORAMem(); break; // ORA M
      case 0xF6: this.ORI(); break; // ORI uint8_t

      case 0xBF: this.CMP(this._state.regs.af.a); break; // CMP A
      case 0xB8: this.CMP(this._state.regs.bc.h); break; // CMP B
      case 0xB9: this.CMP(this._state.regs.bc.l); break; // CMP C
      case 0xBA: this.CMP(this._state.regs.de.h); break; // CMP D
      case 0xBB: this.CMP(this._state.regs.de.l); break; // CMP E
      case 0xBC: this.CMP(this._state.regs.hl.h); break; // CMP H
      case 0xBD: this.CMP(this._state.regs.hl.l); break; // CMP L
      case 0xBE: this.CMPMem(); break; // CMP M
      case 0xFE: this.CPI(); break; // CPI uint8_t

      case 0xC3: this.JMP(); break; // JMP
      case 0xCB: this.JMP(); break; // undocumented JMP
      case 0xC2: this.JMP(this._state.regs.af.z == false); break; // JNZ
      case 0xCA: this.JMP(this._state.regs.af.z == true); break; // JZ
      case 0xD2: this.JMP(this._state.regs.af.c == false); break; // JNC
      case 0xDA: this.JMP(this._state.regs.af.c == true); break; // JC
      case 0xE2: this.JMP(this._state.regs.af.p == false); break; // JPO
      case 0xEA: this.JMP(this._state.regs.af.p == true); break; // JPE
      case 0xF2: this.JMP(this._state.regs.af.s == false); break; // JP
      case 0xFA: this.JMP(this._state.regs.af.s == true); break; // JM

      case 0xE9: this.PCHL(); break; // PCHL
      case 0xCD: this.CALL(); break; // CALL
      case 0xDD: this.CALL(); break; // undocumented CALL
      case 0xED: this.CALL(); break; // undocumented CALL
      case 0xFD: this.CALL(); break; // undocumented CALL

      case 0xC4: this.CALL(this._state.regs.af.z == false); break; // CNZ
      case 0xCC: this.CALL(this._state.regs.af.z == true); break; // CZ
      case 0xD4: this.CALL(this._state.regs.af.c == false); break; // CNC
      case 0xDC: this.CALL(this._state.regs.af.c == true); break; // CC
      case 0xE4: this.CALL(this._state.regs.af.p == false); break; // CPO
      case 0xEC: this.CALL(this._state.regs.af.p == true); break; // CPE
      case 0xF4: this.CALL(this._state.regs.af.s == false); break; // CP
      case 0xFC: this.CALL(this._state.regs.af.s == true); break; // CM
      case 0xC9: this.RET(); break; // RET
      case 0xD9: this.RET(); break; // undocumented RET
      case 0xC0: this.RETCond(this._state.regs.af.z == false); break; // RNZ
      case 0xC8: this.RETCond(this._state.regs.af.z == true); break; // RZ
      case 0xD0: this.RETCond(this._state.regs.af.c == false); break; // RNC
      case 0xD8: this.RETCond(this._state.regs.af.c == true); break; // RC
      case 0xE0: this.RETCond(this._state.regs.af.p == false); break; // RPO
      case 0xE8: this.RETCond(this._state.regs.af.p == true); break; // RPE
      case 0xF0: this.RETCond(this._state.regs.af.s == false); break; // RP
      case 0xF8: this.RETCond(this._state.regs.af.s == true); break; // RM

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
