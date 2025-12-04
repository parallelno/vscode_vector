#!/usr/bin/env node
/**
 * run_emulator_tests.ts
 *
 * A comprehensive test runner for the i8080 CPU emulator.
 * Tests assemble `.asm` test files and validate the emulation results
 * against expected CPU state (registers, flags, memory).
 *
 * Test definitions specify:
 * - Source assembly file
 * - Number of instructions to execute
 * - Expected final CPU state (registers, flags, memory values)
 *
 * Usage: npm run test-emulator
 */

import * as fs from 'fs';
import * as path from 'path';
import { assemble } from '../assembler';

// Import hardware components directly to avoid VS Code dependencies
const { Hardware } = require('../hardware');
const { HardwareReq } = require('../hardware_reqs');
const { ROM_LOAD_ADDR } = require('../memory');

// Test case types
type ExpectedFlags = {
  z?: boolean;  // Zero flag
  s?: boolean;  // Sign flag
  p?: boolean;  // Parity flag
  c?: boolean;  // Carry flag
  ac?: boolean; // Auxiliary carry flag
};

type ExpectedRegisters = {
  a?: number;
  b?: number;
  c?: number;
  d?: number;
  e?: number;
  h?: number;
  l?: number;
  sp?: number;
  pc?: number;
};

type ExpectedMemory = {
  [address: number]: number;
};

type EmulatorTestExpectations = {
  success?: boolean;
  registers?: ExpectedRegisters;
  flags?: ExpectedFlags;
  memory?: ExpectedMemory;
  hlt?: boolean;  // Expect HLT to be executed
};

type EmulatorTestCase = {
  name: string;
  sourceFile: string;
  description?: string;
  instructionCount: number;  // Number of instructions to execute
  expect: EmulatorTestExpectations;
};

type EmulatorTestResult = {
  name: string;
  durationMs: number;
  passed: boolean;
  details: string[];
};

const repoRoot = path.resolve(__dirname, '..', '..');
const emulatorTestDir = path.join(repoRoot, '.test', 'emulator');

// Test case definitions
const tests: EmulatorTestCase[] = [
  // Basic data transfer tests
  {
    name: 'MVI loads immediate value into register A',
    sourceFile: 'mvi_a.asm',
    instructionCount: 1,
    expect: {
      registers: { a: 0x42 }
    }
  },
  {
    name: 'MOV transfers register B to A',
    sourceFile: 'mov_a_b.asm',
    instructionCount: 2,
    expect: {
      registers: { a: 0x55, b: 0x55 }
    }
  },
  {
    name: 'LXI loads 16-bit immediate into register pair',
    sourceFile: 'lxi_h.asm',
    instructionCount: 1,
    expect: {
      registers: { h: 0x12, l: 0x34 }
    }
  },

  // Arithmetic tests
  {
    name: 'ADD adds register to accumulator',
    sourceFile: 'add_b.asm',
    instructionCount: 3,
    expect: {
      registers: { a: 0x33 },
      flags: { z: false, s: false, c: false }
    }
  },
  {
    name: 'ADD sets carry flag on overflow',
    sourceFile: 'add_carry.asm',
    instructionCount: 3,
    expect: {
      registers: { a: 0x00 },
      flags: { z: true, c: true }
    }
  },
  {
    name: 'SUB subtracts register from accumulator',
    sourceFile: 'sub_b.asm',
    instructionCount: 3,
    expect: {
      registers: { a: 0x05 },
      flags: { z: false, s: false, c: false }
    }
  },
  {
    name: 'SUB sets zero flag when result is zero',
    sourceFile: 'sub_zero.asm',
    instructionCount: 3,
    expect: {
      registers: { a: 0x00 },
      flags: { z: true }
    }
  },
  {
    name: 'INR increments register',
    sourceFile: 'inr_b.asm',
    instructionCount: 2,
    expect: {
      registers: { b: 0x10 }
    }
  },
  {
    name: 'DCR decrements register',
    sourceFile: 'dcr_b.asm',
    instructionCount: 2,
    expect: {
      registers: { b: 0x0E }
    }
  },
  {
    name: 'DAD adds register pair to HL',
    sourceFile: 'dad_b.asm',
    instructionCount: 3,
    expect: {
      registers: { h: 0x22, l: 0x22 }
    }
  },

  // Logical operations tests
  {
    name: 'ANA performs AND operation',
    sourceFile: 'ana_b.asm',
    instructionCount: 3,
    expect: {
      registers: { a: 0x10 },
      flags: { z: false, c: false }
    }
  },
  {
    name: 'ORA performs OR operation',
    sourceFile: 'ora_b.asm',
    instructionCount: 3,
    expect: {
      registers: { a: 0x3F },
      flags: { z: false, c: false }
    }
  },
  {
    name: 'XRA performs XOR operation',
    sourceFile: 'xra_b.asm',
    instructionCount: 3,
    expect: {
      registers: { a: 0x2F },
      flags: { z: false, c: false }
    }
  },
  {
    name: 'XRA A clears accumulator and sets zero flag',
    sourceFile: 'xra_a.asm',
    instructionCount: 2,
    expect: {
      registers: { a: 0x00 },
      flags: { z: true, c: false }
    }
  },
  {
    name: 'CMP sets flags without modifying accumulator',
    sourceFile: 'cmp_b.asm',
    instructionCount: 3,
    expect: {
      registers: { a: 0x20, b: 0x10 },
      flags: { z: false, c: false }
    }
  },

  // Rotate operations tests
  {
    name: 'RLC rotates accumulator left',
    sourceFile: 'rlc.asm',
    instructionCount: 2,
    expect: {
      registers: { a: 0x05 },
      flags: { c: true }
    }
  },
  {
    name: 'RRC rotates accumulator right',
    sourceFile: 'rrc.asm',
    instructionCount: 2,
    expect: {
      registers: { a: 0xC1 },  // 10000011 -> 11000001
      flags: { c: true }
    }
  },

  // Stack operations tests
  {
    name: 'PUSH and POP preserve register pair',
    sourceFile: 'push_pop.asm',
    instructionCount: 4,
    expect: {
      registers: { b: 0xAB, c: 0xCD }
    }
  },

  // Control flow tests
  {
    name: 'JMP transfers control to target address',
    sourceFile: 'jmp.asm',
    instructionCount: 2,
    expect: {
      registers: { a: 0xBB }
    }
  },
  {
    name: 'JNZ jumps when zero flag is not set',
    sourceFile: 'jnz.asm',
    instructionCount: 3,
    expect: {
      registers: { a: 0xCC }
    }
  },
  {
    name: 'JZ does not jump when zero flag is not set',
    sourceFile: 'jz_not_taken.asm',
    instructionCount: 3,
    expect: {
      registers: { a: 0xDD }
    }
  },
  {
    name: 'CALL and RET handle subroutine correctly',
    sourceFile: 'call_ret.asm',
    instructionCount: 4,
    expect: {
      registers: { a: 0xEE }
    }
  },

  // Memory operations tests
  {
    name: 'STA stores accumulator in memory',
    sourceFile: 'sta.asm',
    instructionCount: 2,
    expect: {
      memory: { 0x0200: 0x77 }
    }
  },
  {
    name: 'LDA loads accumulator from memory',
    sourceFile: 'lda.asm',
    instructionCount: 3,
    expect: {
      registers: { a: 0x99 }
    }
  },
  {
    name: 'MOV M,r stores register to memory pointed by HL',
    sourceFile: 'mov_m_r.asm',
    instructionCount: 3,
    expect: {
      memory: { 0x0200: 0x88 }
    }
  },

  // Flag manipulation tests
  {
    name: 'STC sets carry flag',
    sourceFile: 'stc.asm',
    instructionCount: 1,
    expect: {
      flags: { c: true }
    }
  },
  {
    name: 'CMC complements carry flag',
    sourceFile: 'cmc.asm',
    instructionCount: 2,
    expect: {
      flags: { c: false }
    }
  },
  {
    name: 'CMA complements accumulator',
    sourceFile: 'cma.asm',
    instructionCount: 2,
    expect: {
      registers: { a: 0x0F }
    }
  },

  // Complex test cases
  {
    name: 'ADC adds with carry correctly',
    sourceFile: 'adc_carry.asm',
    instructionCount: 5,
    expect: {
      registers: { a: 0x11 }
    }
  },
  {
    name: 'SBB subtracts with borrow correctly',
    sourceFile: 'sbb_carry.asm',
    instructionCount: 5,
    expect: {
      registers: { a: 0x0E }
    }
  },
  {
    name: 'INX increments register pair',
    sourceFile: 'inx_h.asm',
    instructionCount: 2,
    expect: {
      registers: { h: 0x10, l: 0x00 }
    }
  },
  {
    name: 'DCX decrements register pair',
    sourceFile: 'dcx_h.asm',
    instructionCount: 2,
    expect: {
      registers: { h: 0x0F, l: 0xFF }
    }
  },
];

// Helper functions
function formatHex(value: number, digits: number = 2): string {
  return '0x' + value.toString(16).toUpperCase().padStart(digits, '0');
}

function compareRegisters(
  cpu: any,
  expected: ExpectedRegisters | undefined,
  recorder: string[]
): void {
  if (!expected) return;

  const checks: Array<{ name: string; actual: number; expected: number | undefined }> = [
    { name: 'A', actual: cpu.a, expected: expected.a },
    { name: 'B', actual: cpu.b, expected: expected.b },
    { name: 'C', actual: cpu.c, expected: expected.c },
    { name: 'D', actual: cpu.d, expected: expected.d },
    { name: 'E', actual: cpu.e, expected: expected.e },
    { name: 'H', actual: cpu.h, expected: expected.h },
    { name: 'L', actual: cpu.l, expected: expected.l },
    { name: 'SP', actual: cpu.sp, expected: expected.sp },
    { name: 'PC', actual: cpu.pc, expected: expected.pc },
  ];

  for (const check of checks) {
    if (check.expected !== undefined && check.actual !== check.expected) {
      recorder.push(
        `Register ${check.name} expected ${formatHex(check.expected)} but was ${formatHex(check.actual)}`
      );
    }
  }
}

function compareFlags(
  cpu: any,
  expected: ExpectedFlags | undefined,
  recorder: string[]
): void {
  if (!expected) return;

  const checks: Array<{ name: string; actual: boolean; expected: boolean | undefined }> = [
    { name: 'Z (Zero)', actual: cpu.flagZ, expected: expected.z },
    { name: 'S (Sign)', actual: cpu.flagS, expected: expected.s },
    { name: 'P (Parity)', actual: cpu.flagP, expected: expected.p },
    { name: 'C (Carry)', actual: cpu.flagC, expected: expected.c },
    { name: 'AC (Aux Carry)', actual: cpu.flagAC, expected: expected.ac },
  ];

  for (const check of checks) {
    if (check.expected !== undefined && check.actual !== check.expected) {
      recorder.push(
        `Flag ${check.name} expected ${check.expected} but was ${check.actual}`
      );
    }
  }
}

function compareMemory(
  memory: any,
  expected: ExpectedMemory | undefined,
  recorder: string[]
): void {
  if (!expected) return;

  for (const [addrStr, expectedValue] of Object.entries(expected)) {
    const addr = Number(addrStr);
    const actualValue = memory.GetByte(addr);
    if (actualValue !== expectedValue) {
      recorder.push(
        `Memory at ${formatHex(addr, 4)} expected ${formatHex(expectedValue)} but was ${formatHex(actualValue)}`
      );
    }
  }
}

function runTestCase(test: EmulatorTestCase): EmulatorTestResult {
  const filePath = path.join(emulatorTestDir, test.sourceFile);
  const details: string[] = [];
  const start = Date.now();

  // Check if source file exists
  if (!fs.existsSync(filePath)) {
    return {
      name: test.name,
      durationMs: Date.now() - start,
      passed: false,
      details: [`Test source not found: ${test.sourceFile}`]
    };
  }

  // Assemble the source
  const source = fs.readFileSync(filePath, 'utf8');
  const assembleResult = assemble(source, filePath);

  if (!assembleResult.success || !assembleResult.output) {
    return {
      name: test.name,
      durationMs: Date.now() - start,
      passed: false,
      details: ['Assembly failed: ' + (assembleResult.errors?.join(', ') || 'unknown error')]
    };
  }

  // Create hardware and load ROM
  let hw: any;
  try {
    hw = new Hardware('', '', true);
    hw.Request(HardwareReq.SET_MEM, { data: assembleResult.output, addr: ROM_LOAD_ADDR });
    hw.Request(HardwareReq.RESTART);
    // Set PC to ROM_LOAD_ADDR (0x100) to match the .org directive in test files.
    // All test assembly files use .org 0x100 which matches ROM_LOAD_ADDR.
    hw.cpu.state.regs.pc.word = ROM_LOAD_ADDR;
  } catch (e) {
    return {
      name: test.name,
      durationMs: Date.now() - start,
      passed: false,
      details: [`Hardware initialization failed: ${e}`]
    };
  }

  // Execute instructions
  try {
    for (let i = 0; i < test.instructionCount; i++) {
      hw.Request(HardwareReq.EXECUTE_INSTR);
    }
  } catch (e) {
    return {
      name: test.name,
      durationMs: Date.now() - start,
      passed: false,
      details: [`Execution failed: ${e}`]
    };
  }

  // Validate expectations
  const cpu = hw.cpu;
  const memory = hw.memory;

  compareRegisters(cpu, test.expect.registers, details);
  compareFlags(cpu, test.expect.flags, details);
  compareMemory(memory, test.expect.memory, details);

  if (test.expect.hlt !== undefined) {
    const isHalted = cpu.hlta;
    if (isHalted !== test.expect.hlt) {
      details.push(`Expected HLT state ${test.expect.hlt} but was ${isHalted}`);
    }
  }

  return {
    name: test.name,
    durationMs: Date.now() - start,
    passed: details.length === 0,
    details
  };
}

function generateReport(results: EmulatorTestResult[]): void {
  const passedCount = results.filter(r => r.passed).length;
  const failedCount = results.length - passedCount;
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.log('\n' + '='.repeat(70));
  console.log('                       EMULATOR TEST REPORT');
  console.log('='.repeat(70) + '\n');

  // Group by category (based on test name prefix)
  const categories: Map<string, EmulatorTestResult[]> = new Map();
  for (const result of results) {
    // Extract category from test name (first word before space)
    const match = result.name.match(/^(\w+)/);
    const category = match ? match[1] : 'Other';
    if (!categories.has(category)) {
      categories.set(category, []);
    }
    categories.get(category)!.push(result);
  }

  // Print results by category
  for (const [category, categoryResults] of categories) {
    const categoryPassed = categoryResults.filter(r => r.passed).length;
    console.log(`\n${category} Tests (${categoryPassed}/${categoryResults.length}):`);
    console.log('-'.repeat(50));

    for (const res of categoryResults) {
      const status = res.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      const time = `(${res.durationMs}ms)`;
      console.log(`  ${status} ${res.name} ${time}`);
      if (!res.passed) {
        for (const detail of res.details) {
          console.log(`       - ${detail}`);
        }
      }
    }
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total Tests:  ${results.length}`);
  console.log(`Passed:       \x1b[32m${passedCount}\x1b[0m`);
  console.log(`Failed:       ${failedCount > 0 ? '\x1b[31m' + failedCount + '\x1b[0m' : failedCount}`);
  console.log(`Duration:     ${totalDuration}ms`);
  console.log(`Pass Rate:    ${((passedCount / results.length) * 100).toFixed(1)}%`);
  console.log('='.repeat(70) + '\n');
}

function main(): void {
  console.log('i8080 Emulator Test Suite');
  console.log(`Running ${tests.length} tests...\n`);

  const results = tests.map(runTestCase);
  generateReport(results);

  const failedCount = results.filter(r => !r.passed).length;
  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

main();
