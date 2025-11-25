#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Emulator } from '../emulator';

function usage() {
  console.log('Usage: npm run run-rom-ts -- <rom-file> [instructionCount]');
  console.log('Example: npm run run-rom-ts -- test.rom 65536');
}

const argv = process.argv.slice(2);
if (argv.length < 1) {
  usage();
  process.exit(1);
}
const romPath = argv[0];
const count = argv[1] ? parseInt(argv[1], 10) : 0x10000;
if (!fs.existsSync(romPath)) {
  console.error('ROM file not found:', romPath);
  process.exit(2);
}
const romBuf = fs.readFileSync(romPath);

const emu = new Emulator();
emu.load(Buffer.from(romBuf), 0x0100);
emu.regs.PC = 0x0000;
emu.regs.SP = 0x0000;

function dumpRegs(regs: any) {
  const flags = `S=${regs.flags.S?1:0} Z=${regs.flags.Z?1:0} AC=${regs.flags.AC?1:0} P=${regs.flags.P?1:0} CY=${regs.flags.CY?1:0}`;
  console.log(`PC=${(regs.PC&0xffff).toString(16).padStart(4,'0')} SP=${(regs.SP&0xffff).toString(16).padStart(4,'0')} A=${(regs.A&0xff).toString(16).padStart(2,'0')} B=${(regs.B&0xff).toString(16).padStart(2,'0')} C=${(regs.C&0xff).toString(16).padStart(2,'0')} D=${(regs.D&0xff).toString(16).padStart(2,'0')} E=${(regs.E&0xff).toString(16).padStart(2,'0')} H=${(regs.H&0xff).toString(16).padStart(2,'0')} L=${(regs.L&0xff).toString(16).padStart(2,'0')} ${flags}`);
}

console.log('Loaded ROM:', path.resolve(romPath), 'size=', romBuf.length, 'instructions=', count);
console.log('Initial registers:');
dumpRegs(emu.regs);

const res = emu.runUntilBreakpointOrHalt(count);

console.log('\nRun completed. result:', res);
console.log('Final registers:');
dumpRegs(emu.regs);

try {
  const pc = emu.regs.PC & 0xffff;
  const mem: string[] = [];
  for (let i = 0; i < 16; i++) mem.push(emu.memory.getByte((pc + i) & 0xffff).toString(16).padStart(2,'0'));
  console.log(`Memory @ PC (${pc.toString(16).padStart(4,'0')}):`, mem.join(' '));
} catch (e) {
  // ignore
}

process.exit(0);
