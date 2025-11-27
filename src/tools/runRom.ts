#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Emulator } from '../emulator';
import { HardwareReq } from '../hardware_reqs';
import { State } from '../cpu_i8080';
import * as os from 'os';
import { assemble } from '../assembler';

// Simple script to run a ROM file in the emulator until it halts or a maximum
// number of instructions is reached. It steps through each instruction and
// prints CPU state.

const START_LOG_ADDR = 0x100;
const DEFAULT_INSTR_MAX = 1000;
let maxInstr = DEFAULT_INSTR_MAX;

const argv = process.argv.slice(2);
if (argv.length < 1) {
  console.log('Usage: npm run run-rom-ts -- <rom-file> [max-instructions]');
  console.log('Example: npm run run-rom-ts -- test.rom 1000');
  process.exit(1);
}

const romPath = argv[0];
if (!fs.existsSync(romPath)) {
  console.error('ROM file not found:', romPath);
  process.exit(2);
}

if (argv.length > 1) {
  maxInstr = parseInt(argv[1], 10) || DEFAULT_INSTR_MAX;
}

console.log('Inited emulator with loaded ROM:', path.resolve(romPath));
let romToLoad = romPath;
if (romPath.endsWith('.asm')) {
  // assemble source and write temporary ROM
  try {
    const src = fs.readFileSync(romPath, 'utf8');
    const res = assemble(src);
    if (!res.success || !res.output) {
      console.error('Assemble failed for', romPath);
      process.exit(3);
    }
    const tmp = path.join(os.tmpdir(), `vscode_vector_${Date.now()}.rom`);
    fs.writeFileSync(tmp, res.output);
    romToLoad = tmp;
    console.log('Assembled ROM written to', tmp);
  } catch (e) {
    console.error('Assemble error:', String(e));
    process.exit(4);
  }
}

// Create emulator and load ROM via constructor
const emu = new Emulator('', {}, romToLoad);


function printState(state?: State) {
  if (!state) {
    console.log('(no cpu state)'); return;
  }
  const r = state.regs;
  const flags =
    `S=${r.af.s?1:0} Z=${r.af.z?1:0} AC=${r.af.ac?1:0} P=${r.af.p?1:0} CY=${r.af.c?1:0}`;

    const pc_str: string = (r.pc.pair).toString(16).padStart(4,'0')
    const sp_str: string = (r.sp.pair).toString(16).padStart(4,'0')
    const a_str: string = (r.af.a).toString(16).padStart(2,'0')
    const b_str: string = (r.bc.h).toString(16).padStart(2,'0')
    const c_str: string = (r.bc.l).toString(16).padStart(2,'0')
    const d_str: string = (r.de.h).toString(16).padStart(2,'0')
    const e_str: string = (r.de.l).toString(16).padStart(2,'0')
    const h_str: string = (r.hl.h).toString(16).padStart(2,'0')
    const l_str: string = (r.hl.l).toString(16).padStart(2,'0')

    const opcode = emu.hardware?.memory?.GetByte(r.pc.pair & 0xffff) ?? 0;
    const b1 = emu.hardware?.memory?.GetByte((r.pc.pair + 1) & 0xffff) ?? 0;
    const b2 = emu.hardware?.memory?.GetByte((r.pc.pair + 2) & 0xffff) ?? 0;
    const opcode_s = opcode.toString(16).padStart(2,'0')
    const b1_s = b1.toString(16).padStart(2,'0')
    const b2_s = b2.toString(16).padStart(2,'0');

    console.log(`${pc_str}: ${opcode_s} ${b1_s} ${b2_s} SP=${sp_str} A=${a_str} B=${b_str} C=${c_str} D=${d_str} E=${e_str} H=${h_str} L=${l_str} Flags=${flags}`);
}

console.log('\nStepping until HLT or ' + maxInstr + ' instructions:');
let print_log = false;
for (let i = 0; i < maxInstr; i++)
{
  if (print_log){
    printState(emu.hardware?.cpu?.state);
  }
  else if ((emu.hardware?.cpu?.state.regs.pc.pair ?? 0) == START_LOG_ADDR){
    print_log = true;
  }

  emu.hardware?.Request(HardwareReq.EXECUTE_INSTR);

  // check for HLT/halt condition
  const halted = emu.hardware?.cpu?.state.ints.hlta ?? false;
  if (halted) {
    console.log('CPU halted.');
    break;
  }
}
console.log('Stop emulation.');

// Print memory dump at PC
const pc = emu.hardware?.cpu?.state.regs.pc.pair ?? 0;
const mem: string[] = [];
for (let addr = pc; addr < pc + 16; addr++)
{
  const byte = emu.hardware?.memory?.GetByte(addr & 0xffff) ?? 0;
  mem.push(byte.toString(16).padStart(2,'0'));
}
const pc_str: string = pc.toString(16).padStart(4,'0');
console.log(`Memory at PC (${pc_str}):`, mem.join(' '));


process.exit(0);
