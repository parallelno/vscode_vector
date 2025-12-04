/**
 * CPU (i8080) Unit Tests
 * 
 * This test suite verifies the correctness of the Intel 8080 CPU emulation.
 * Tests cover:
 * - Register operations (MOV, MVI, LXI)
 * - Arithmetic operations (ADD, ADC, SUB, SBB, INR, DCR, DAD, DAA)
 * - Logical operations (ANA, ORA, XRA, CMP)
 * - Immediate operations (ADI, ACI, SUI, SBI, ANI, ORI, XRI, CPI)
 * - Rotate operations (RLC, RRC, RAL, RAR)
 * - Branch operations (JMP, Jcc, CALL, RET)
 * - Stack operations (PUSH, POP)
 * - Flag calculations (Z, S, P, C, AC)
 * - Memory operations (LDA, STA, LDAX, STAX, LHLD, SHLD)
 */

import CPU, { CpuState, RegPair, AF } from '../cpu_i8080';
import Memory, { AddrSpace, MemType } from '../memory';

type CpuTestExpectation = {
    a?: number;
    b?: number;
    c?: number;
    d?: number;
    e?: number;
    h?: number;
    l?: number;
    sp?: number;
    pc?: number;
    flagZ?: boolean;
    flagS?: boolean;
    flagP?: boolean;
    flagC?: boolean;
    flagAC?: boolean;
    memoryAt?: { addr: number; value: number }[];
};

type CpuTestCase = {
    name: string;
    description?: string;
    setup: (cpu: CPU, mem: Memory) => void;
    program: number[];  // Machine code bytes to execute
    cycles?: number;    // Number of machine cycles to execute (default: enough to execute program)
    numInstructions?: number; // Exact number of instructions to execute (overrides cycles)
    expect: CpuTestExpectation;
};

type CpuTestResult = {
    name: string;
    passed: boolean;
    details: string[];
    durationMs: number;
};

// Helper to create a minimal memory mock for testing
function createTestMemory(): Memory {
    // Create memory without boot path (testing mode)
    const mem = new Memory('', '', false);
    mem.Init();
    mem.SetMemType(MemType.RAM);
    return mem;
}

// Helper to create CPU with test memory
function createTestCpu(): { cpu: CPU; memory: Memory } {
    const memory = createTestMemory();
    const cpu = new CPU(
        memory,
        (port) => 0x00,  // Default input
        (port, val) => {} // Default output
    );
    return { cpu, memory };
}

// Load program into memory at address 0
function loadProgram(memory: Memory, program: number[], startAddr: number = 0): void {
    for (let i = 0; i < program.length; i++) {
        memory.ram[startAddr + i] = program[i];
    }
}

// Execute CPU until instruction completes or cycle limit reached
function executeInstructions(cpu: CPU, maxCycles: number = 100): void {
    let cyclesExecuted = 0;
    while (cyclesExecuted < maxCycles) {
        cpu.ExecuteMachineCycle(false);
        cyclesExecuted++;
        if (cpu.IsInstructionExecuted()) {
            break;
        }
    }
}

// Execute a fixed number of complete instructions
function executeNInstructions(cpu: CPU, count: number): void {
    for (let i = 0; i < count; i++) {
        // Execute machine cycles until instruction completes
        do {
            cpu.ExecuteMachineCycle(false);
        } while (!cpu.IsInstructionExecuted() && !cpu.hlta);
        
        // Break if halted
        if (cpu.hlta) break;
    }
}

// Execute exactly one complete instruction
function executeOneInstruction(cpu: CPU): void {
    do {
        cpu.ExecuteMachineCycle(false);
    } while (!cpu.IsInstructionExecuted() && !cpu.hlta);
}

// Define CPU test cases
const cpuTests: CpuTestCase[] = [
    // =====================
    // MOV Register-Register Tests
    // =====================
    {
        name: 'MOV B,A - Copy A to B',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x42;
            cpu.state.regs.bc.h = 0x00;
        },
        program: [0x47], // MOV B,A
        expect: {
            a: 0x42,
            b: 0x42
        }
    },
    {
        name: 'MOV A,B - Copy B to A',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x00;
            cpu.state.regs.bc.h = 0x55;
        },
        program: [0x78], // MOV A,B
        expect: {
            a: 0x55,
            b: 0x55
        }
    },
    {
        name: 'MOV H,L - Copy L to H',
        setup: (cpu, mem) => {
            cpu.state.regs.hl.h = 0x00;
            cpu.state.regs.hl.l = 0xAB;
        },
        program: [0x65], // MOV H,L
        expect: {
            h: 0xAB,
            l: 0xAB
        }
    },

    // =====================
    // MVI Immediate Tests
    // =====================
    {
        name: 'MVI A,0x55 - Load immediate to A',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x00;
        },
        program: [0x3E, 0x55], // MVI A,0x55
        expect: {
            a: 0x55
        }
    },
    {
        name: 'MVI B,0xFF - Load immediate to B',
        setup: (cpu, mem) => {
            cpu.state.regs.bc.h = 0x00;
        },
        program: [0x06, 0xFF], // MVI B,0xFF
        expect: {
            b: 0xFF
        }
    },
    {
        name: 'MVI C,0x12 - Load immediate to C',
        setup: (cpu, mem) => {
            cpu.state.regs.bc.l = 0x00;
        },
        program: [0x0E, 0x12], // MVI C,0x12
        expect: {
            c: 0x12
        }
    },

    // =====================
    // LXI Register Pair Tests
    // =====================
    {
        name: 'LXI B,0x1234 - Load 16-bit immediate to BC',
        setup: (cpu, mem) => {
            cpu.state.regs.bc.word = 0x0000;
        },
        program: [0x01, 0x34, 0x12], // LXI B,0x1234
        expect: {
            b: 0x12,
            c: 0x34
        }
    },
    {
        name: 'LXI H,0xABCD - Load 16-bit immediate to HL',
        setup: (cpu, mem) => {
            cpu.state.regs.hl.word = 0x0000;
        },
        program: [0x21, 0xCD, 0xAB], // LXI H,0xABCD
        expect: {
            h: 0xAB,
            l: 0xCD
        }
    },
    {
        name: 'LXI SP,0x4000 - Load 16-bit immediate to SP',
        setup: (cpu, mem) => {
            cpu.state.regs.sp.word = 0x0000;
        },
        program: [0x31, 0x00, 0x40], // LXI SP,0x4000
        expect: {
            sp: 0x4000
        }
    },

    // =====================
    // ADD Tests with Flags
    // =====================
    {
        name: 'ADD B - Simple addition, no flags',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x10;
            cpu.state.regs.bc.h = 0x05;
        },
        program: [0x80], // ADD B
        expect: {
            a: 0x15,
            flagZ: false,
            flagS: false,
            flagC: false
        }
    },
    {
        name: 'ADD B - Result is zero, Zero flag set',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x00;
            cpu.state.regs.bc.h = 0x00;
        },
        program: [0x80], // ADD B
        expect: {
            a: 0x00,
            flagZ: true,
            flagP: true  // 0 has even parity
        }
    },
    {
        name: 'ADD B - Overflow sets Carry flag',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0xFF;
            cpu.state.regs.bc.h = 0x01;
        },
        program: [0x80], // ADD B
        expect: {
            a: 0x00,
            flagZ: true,
            flagC: true
        }
    },
    {
        name: 'ADD B - Negative result sets Sign flag',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x7F;
            cpu.state.regs.bc.h = 0x01;
        },
        program: [0x80], // ADD B
        expect: {
            a: 0x80,
            flagS: true,
            flagZ: false,
            flagC: false
        }
    },
    {
        name: 'ADD B - Auxiliary carry (half-carry) test',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x0F;
            cpu.state.regs.bc.h = 0x01;
        },
        program: [0x80], // ADD B
        expect: {
            a: 0x10,
            flagAC: true,
            flagC: false
        }
    },

    // =====================
    // ADC Tests (Add with Carry)
    // =====================
    {
        name: 'ADC B - Add with carry flag set',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x10;
            cpu.state.regs.bc.h = 0x05;
            cpu.state.regs.af.c = true;
        },
        program: [0x88], // ADC B
        expect: {
            a: 0x16, // 0x10 + 0x05 + 1
            flagC: false
        }
    },
    {
        name: 'ADC B - Add with carry causing overflow',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0xFF;
            cpu.state.regs.bc.h = 0x00;
            cpu.state.regs.af.c = true;
        },
        program: [0x88], // ADC B
        expect: {
            a: 0x00,
            flagZ: true,
            flagC: true
        }
    },

    // =====================
    // SUB Tests
    // =====================
    {
        name: 'SUB B - Simple subtraction',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x20;
            cpu.state.regs.bc.h = 0x05;
        },
        program: [0x90], // SUB B
        expect: {
            a: 0x1B,
            flagZ: false,
            flagC: false
        }
    },
    {
        name: 'SUB B - Result zero',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x55;
            cpu.state.regs.bc.h = 0x55;
        },
        program: [0x90], // SUB B
        expect: {
            a: 0x00,
            flagZ: true,
            flagC: false
        }
    },
    {
        name: 'SUB B - Borrow sets Carry flag',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x00;
            cpu.state.regs.bc.h = 0x01;
        },
        program: [0x90], // SUB B
        expect: {
            a: 0xFF,
            flagC: true,
            flagS: true
        }
    },

    // =====================
    // SBB Tests (Subtract with Borrow)
    // =====================
    {
        name: 'SBB B - Subtract with borrow flag set',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x20;
            cpu.state.regs.bc.h = 0x05;
            cpu.state.regs.af.c = true;
        },
        program: [0x98], // SBB B
        expect: {
            a: 0x1A, // 0x20 - 0x05 - 1
            flagC: false
        }
    },

    // =====================
    // INR Tests (Increment)
    // =====================
    {
        name: 'INR A - Simple increment',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x10;
        },
        program: [0x3C], // INR A
        expect: {
            a: 0x11,
            flagZ: false
        }
    },
    {
        name: 'INR A - Wrap around (0xFF + 1 = 0x00)',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0xFF;
        },
        program: [0x3C], // INR A
        expect: {
            a: 0x00,
            flagZ: true,
            flagAC: true  // Half-carry on 0xF -> 0x0
        }
    },
    {
        name: 'INR B - Increment B register',
        setup: (cpu, mem) => {
            cpu.state.regs.bc.h = 0x7F;
        },
        program: [0x04], // INR B
        expect: {
            b: 0x80,
            flagS: true,
            flagAC: true
        }
    },

    // =====================
    // DCR Tests (Decrement)
    // =====================
    {
        name: 'DCR A - Simple decrement',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x10;
        },
        program: [0x3D], // DCR A
        expect: {
            a: 0x0F,
            flagZ: false
        }
    },
    {
        name: 'DCR A - Decrement to zero',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x01;
        },
        program: [0x3D], // DCR A
        expect: {
            a: 0x00,
            flagZ: true
        }
    },
    {
        name: 'DCR A - Wrap around (0x00 - 1 = 0xFF)',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x00;
        },
        program: [0x3D], // DCR A
        expect: {
            a: 0xFF,
            flagS: true,
            flagZ: false
        }
    },

    // =====================
    // INX/DCX Tests (16-bit increment/decrement)
    // =====================
    {
        name: 'INX B - Increment BC pair',
        setup: (cpu, mem) => {
            cpu.state.regs.bc.word = 0x00FF;
        },
        program: [0x03], // INX B
        expect: {
            b: 0x01,
            c: 0x00
        }
    },
    {
        name: 'DCX H - Decrement HL pair',
        setup: (cpu, mem) => {
            cpu.state.regs.hl.word = 0x0100;
        },
        program: [0x2B], // DCX H
        expect: {
            h: 0x00,
            l: 0xFF
        }
    },

    // =====================
    // DAD Tests (16-bit addition)
    // =====================
    {
        name: 'DAD B - Add BC to HL',
        setup: (cpu, mem) => {
            cpu.state.regs.hl.word = 0x1000;
            cpu.state.regs.bc.word = 0x0234;
        },
        program: [0x09], // DAD B
        expect: {
            h: 0x12,
            l: 0x34,
            flagC: false
        }
    },
    {
        name: 'DAD B - Overflow sets Carry',
        setup: (cpu, mem) => {
            cpu.state.regs.hl.word = 0xFF00;
            cpu.state.regs.bc.word = 0x0200;
        },
        program: [0x09], // DAD B
        expect: {
            h: 0x01,
            l: 0x00,
            flagC: true
        }
    },

    // =====================
    // Logical Operations
    // =====================
    {
        name: 'ANA B - AND A with B',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0xFF;
            cpu.state.regs.bc.h = 0x0F;
        },
        program: [0xA0], // ANA B
        expect: {
            a: 0x0F,
            flagC: false,
            flagZ: false
        }
    },
    {
        name: 'ANA B - AND result zero',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0xF0;
            cpu.state.regs.bc.h = 0x0F;
        },
        program: [0xA0], // ANA B
        expect: {
            a: 0x00,
            flagZ: true,
            flagC: false
        }
    },
    {
        name: 'ORA B - OR A with B',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0xF0;
            cpu.state.regs.bc.h = 0x0F;
        },
        program: [0xB0], // ORA B
        expect: {
            a: 0xFF,
            flagC: false,
            flagS: true
        }
    },
    {
        name: 'XRA B - XOR A with B',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0xFF;
            cpu.state.regs.bc.h = 0xFF;
        },
        program: [0xA8], // XRA B
        expect: {
            a: 0x00,
            flagZ: true,
            flagC: false
        }
    },
    {
        name: 'XRA A - Clear A (common idiom)',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x55;
        },
        program: [0xAF], // XRA A
        expect: {
            a: 0x00,
            flagZ: true,
            flagC: false
        }
    },

    // =====================
    // CMP Tests (Compare)
    // =====================
    {
        name: 'CMP B - A equals B sets Zero flag',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x55;
            cpu.state.regs.bc.h = 0x55;
        },
        program: [0xB8], // CMP B
        expect: {
            a: 0x55, // A unchanged
            flagZ: true,
            flagC: false
        }
    },
    {
        name: 'CMP B - A less than B sets Carry',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x10;
            cpu.state.regs.bc.h = 0x20;
        },
        program: [0xB8], // CMP B
        expect: {
            a: 0x10, // A unchanged
            flagZ: false,
            flagC: true
        }
    },
    {
        name: 'CMP B - A greater than B',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x30;
            cpu.state.regs.bc.h = 0x10;
        },
        program: [0xB8], // CMP B
        expect: {
            a: 0x30, // A unchanged
            flagZ: false,
            flagC: false
        }
    },

    // =====================
    // Immediate Operations
    // =====================
    {
        name: 'ADI 0x10 - Add immediate',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x05;
        },
        program: [0xC6, 0x10], // ADI 0x10
        expect: {
            a: 0x15,
            flagC: false
        }
    },
    {
        name: 'SUI 0x05 - Subtract immediate',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x20;
        },
        program: [0xD6, 0x05], // SUI 0x05
        expect: {
            a: 0x1B,
            flagC: false
        }
    },
    {
        name: 'ANI 0x0F - AND immediate',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0xFF;
        },
        program: [0xE6, 0x0F], // ANI 0x0F
        expect: {
            a: 0x0F,
            flagC: false
        }
    },
    {
        name: 'ORI 0xF0 - OR immediate',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x0F;
        },
        program: [0xF6, 0xF0], // ORI 0xF0
        expect: {
            a: 0xFF,
            flagC: false
        }
    },
    {
        name: 'XRI 0xFF - XOR immediate',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x55;
        },
        program: [0xEE, 0xFF], // XRI 0xFF
        expect: {
            a: 0xAA,
            flagC: false
        }
    },
    {
        name: 'CPI 0x55 - Compare immediate (equal)',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x55;
        },
        program: [0xFE, 0x55], // CPI 0x55
        expect: {
            a: 0x55,
            flagZ: true,
            flagC: false
        }
    },

    // =====================
    // Rotate Operations
    // =====================
    {
        name: 'RLC - Rotate left circular',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x80;
            cpu.state.regs.af.c = false;
        },
        program: [0x07], // RLC
        expect: {
            a: 0x01,
            flagC: true
        }
    },
    {
        name: 'RRC - Rotate right circular',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x01;
            cpu.state.regs.af.c = false;
        },
        program: [0x0F], // RRC
        expect: {
            a: 0x80,
            flagC: true
        }
    },
    {
        name: 'RAL - Rotate left through carry',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x80;
            cpu.state.regs.af.c = true;
        },
        program: [0x17], // RAL
        expect: {
            a: 0x01,
            flagC: true
        }
    },
    {
        name: 'RAR - Rotate right through carry',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x01;
            cpu.state.regs.af.c = true;
        },
        program: [0x1F], // RAR
        expect: {
            a: 0x80,
            flagC: true
        }
    },

    // =====================
    // Flag Operations
    // =====================
    {
        name: 'STC - Set carry flag',
        setup: (cpu, mem) => {
            cpu.state.regs.af.c = false;
        },
        program: [0x37], // STC
        expect: {
            flagC: true
        }
    },
    {
        name: 'CMC - Complement carry flag',
        setup: (cpu, mem) => {
            cpu.state.regs.af.c = false;
        },
        program: [0x3F], // CMC
        expect: {
            flagC: true
        }
    },
    {
        name: 'CMC - Complement carry (true to false)',
        setup: (cpu, mem) => {
            cpu.state.regs.af.c = true;
        },
        program: [0x3F], // CMC
        expect: {
            flagC: false
        }
    },

    // =====================
    // Jump Tests
    // =====================
    {
        name: 'JMP - Unconditional jump',
        setup: (cpu, mem) => {},
        program: [0xC3, 0x10, 0x00], // JMP 0x0010
        numInstructions: 1,
        expect: {
            pc: 0x0010
        }
    },
    {
        name: 'JZ - Jump if zero (flag set)',
        setup: (cpu, mem) => {
            cpu.state.regs.af.z = true;
        },
        program: [0xCA, 0x20, 0x00], // JZ 0x0020
        numInstructions: 1,
        expect: {
            pc: 0x0020
        }
    },
    {
        name: 'JZ - Jump if zero (flag not set)',
        setup: (cpu, mem) => {
            cpu.state.regs.af.z = false;
        },
        program: [0xCA, 0x20, 0x00], // JZ 0x0020
        numInstructions: 1,
        expect: {
            pc: 0x0003  // No jump, PC advances past instruction
        }
    },
    {
        name: 'JNZ - Jump if not zero (flag not set)',
        setup: (cpu, mem) => {
            cpu.state.regs.af.z = false;
        },
        program: [0xC2, 0x30, 0x00], // JNZ 0x0030
        numInstructions: 1,
        expect: {
            pc: 0x0030
        }
    },
    {
        name: 'JC - Jump if carry (flag set)',
        setup: (cpu, mem) => {
            cpu.state.regs.af.c = true;
        },
        program: [0xDA, 0x40, 0x00], // JC 0x0040
        numInstructions: 1,
        expect: {
            pc: 0x0040
        }
    },
    {
        name: 'JNC - Jump if no carry (flag not set)',
        setup: (cpu, mem) => {
            cpu.state.regs.af.c = false;
        },
        program: [0xD2, 0x50, 0x00], // JNC 0x0050
        numInstructions: 1,
        expect: {
            pc: 0x0050
        }
    },

    // =====================
    // PUSH/POP Tests
    // =====================
    {
        name: 'PUSH B / POP D - Stack round-trip',
        setup: (cpu, mem) => {
            cpu.state.regs.sp.word = 0x1000;
            cpu.state.regs.bc.word = 0x1234;
            cpu.state.regs.de.word = 0x0000;
        },
        program: [0xC5, 0xD1], // PUSH B, POP D
        numInstructions: 2,
        expect: {
            d: 0x12,
            e: 0x34,
            sp: 0x1000  // SP returns to original
        }
    },
    {
        name: 'PUSH PSW / POP PSW - Preserve flags',
        setup: (cpu, mem) => {
            cpu.state.regs.sp.word = 0x1000;
            cpu.state.regs.af.a = 0xAB;
            cpu.state.regs.af.z = true;
            cpu.state.regs.af.s = true;
            cpu.state.regs.af.c = true;
        },
        program: [0xF5, 0x3E, 0x00, 0xF1], // PUSH PSW, MVI A,0, POP PSW
        numInstructions: 3,
        expect: {
            a: 0xAB,
            flagZ: true,
            flagS: true,
            flagC: true,
            sp: 0x1000
        }
    },

    // =====================
    // Memory Access Tests
    // =====================
    {
        name: 'LDA - Load A from memory',
        setup: (cpu, mem) => {
            mem.ram[0x0100] = 0x42;
            cpu.state.regs.af.a = 0x00;
        },
        program: [0x3A, 0x00, 0x01], // LDA 0x0100
        expect: {
            a: 0x42
        }
    },
    {
        name: 'STA - Store A to memory',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x55;
            mem.ram[0x0100] = 0x00;
        },
        program: [0x32, 0x00, 0x01], // STA 0x0100
        expect: {
            memoryAt: [{ addr: 0x0100, value: 0x55 }]
        }
    },
    {
        name: 'MOV A,M - Load A from address in HL',
        setup: (cpu, mem) => {
            cpu.state.regs.hl.word = 0x0200;
            mem.ram[0x0200] = 0x77;
            cpu.state.regs.af.a = 0x00;
        },
        program: [0x7E], // MOV A,M
        expect: {
            a: 0x77
        }
    },
    {
        name: 'MOV M,A - Store A to address in HL',
        setup: (cpu, mem) => {
            cpu.state.regs.hl.word = 0x0200;
            cpu.state.regs.af.a = 0x99;
            mem.ram[0x0200] = 0x00;
        },
        program: [0x77], // MOV M,A
        expect: {
            memoryAt: [{ addr: 0x0200, value: 0x99 }]
        }
    },
    {
        name: 'LDAX B - Load A from address in BC',
        setup: (cpu, mem) => {
            cpu.state.regs.bc.word = 0x0300;
            mem.ram[0x0300] = 0xAA;
            cpu.state.regs.af.a = 0x00;
        },
        program: [0x0A], // LDAX B
        expect: {
            a: 0xAA
        }
    },
    {
        name: 'STAX D - Store A to address in DE',
        setup: (cpu, mem) => {
            cpu.state.regs.de.word = 0x0400;
            cpu.state.regs.af.a = 0xBB;
            mem.ram[0x0400] = 0x00;
        },
        program: [0x12], // STAX D
        expect: {
            memoryAt: [{ addr: 0x0400, value: 0xBB }]
        }
    },
    {
        name: 'LHLD - Load HL from memory',
        setup: (cpu, mem) => {
            mem.ram[0x0500] = 0x34;  // Low byte
            mem.ram[0x0501] = 0x12;  // High byte
            cpu.state.regs.hl.word = 0x0000;
        },
        program: [0x2A, 0x00, 0x05], // LHLD 0x0500
        expect: {
            h: 0x12,
            l: 0x34
        }
    },
    {
        name: 'SHLD - Store HL to memory',
        setup: (cpu, mem) => {
            cpu.state.regs.hl.word = 0xABCD;
            mem.ram[0x0600] = 0x00;
            mem.ram[0x0601] = 0x00;
        },
        program: [0x22, 0x00, 0x06], // SHLD 0x0600
        expect: {
            memoryAt: [
                { addr: 0x0600, value: 0xCD },  // Low byte
                { addr: 0x0601, value: 0xAB }   // High byte
            ]
        }
    },

    // =====================
    // Exchange Operations
    // =====================
    {
        name: 'XCHG - Exchange DE and HL',
        setup: (cpu, mem) => {
            cpu.state.regs.de.word = 0x1234;
            cpu.state.regs.hl.word = 0x5678;
        },
        program: [0xEB], // XCHG
        expect: {
            d: 0x56,
            e: 0x78,
            h: 0x12,
            l: 0x34
        }
    },

    // =====================
    // Parity Tests
    // =====================
    {
        name: 'ANA A - Even parity (8 bits set)',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0xFF;  // 8 bits set = even parity
        },
        program: [0xA7], // ANA A (no change, but sets flags)
        expect: {
            a: 0xFF,
            flagP: true  // Even parity
        }
    },
    {
        name: 'ANA A - Odd parity (7 bits set)',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x7F;  // 7 bits set = odd parity
        },
        program: [0xA7], // ANA A
        expect: {
            a: 0x7F,
            flagP: false  // Odd parity
        }
    },

    // =====================
    // NOP Test
    // =====================
    {
        name: 'NOP - No operation',
        setup: (cpu, mem) => {
            cpu.state.regs.af.a = 0x55;
            cpu.state.regs.bc.word = 0x1234;
        },
        program: [0x00], // NOP
        numInstructions: 1,
        expect: {
            a: 0x55,  // Unchanged
            b: 0x12,  // Unchanged
            c: 0x34,  // Unchanged
            pc: 0x01  // PC advanced by 1
        }
    },

    // =====================
    // CALL/RET Test
    // =====================
    {
        name: 'CALL and RET - Subroutine call and return',
        setup: (cpu, mem) => {
            cpu.state.regs.sp.word = 0x1000;
            // Set up a simple subroutine at 0x0010 that just returns
            mem.ram[0x0010] = 0xC9; // RET
        },
        program: [0xCD, 0x10, 0x00], // CALL 0x0010
        numInstructions: 2,  // CALL + RET
        expect: {
            pc: 0x0003,  // After CALL and RET, back to address after CALL
            sp: 0x1000   // Stack restored
        }
    },

    // =====================
    // RST Test
    // =====================
    {
        name: 'RST 0 - Restart to address 0x0000',
        setup: (cpu, mem) => {
            cpu.state.regs.sp.word = 0x1000;
            cpu.state.regs.pc.word = 0x0100;
            // Put RST 0 at address 0x0100
            mem.ram[0x0100] = 0xC7; // RST 0
        },
        program: [], // Program loaded in setup
        numInstructions: 1,
        expect: {
            pc: 0x0000,
            sp: 0x0FFE  // Two bytes pushed
        }
    },
];

// Run a single test case
function runCpuTest(test: CpuTestCase): CpuTestResult {
    const details: string[] = [];
    const start = Date.now();
    
    try {
        const { cpu, memory } = createTestCpu();
        
        // Run setup
        test.setup(cpu, memory);
        
        // Load program
        if (test.program.length > 0) {
            loadProgram(memory, test.program, 0);
            cpu.state.regs.pc.word = 0;
        }
        
        // Execute
        if (test.numInstructions !== undefined) {
            executeNInstructions(cpu, test.numInstructions);
        } else if (test.cycles) {
            for (let i = 0; i < test.cycles; i++) {
                cpu.ExecuteMachineCycle(false);
            }
        } else {
            // Execute single instruction by default for simple tests
            executeOneInstruction(cpu);
        }
        
        // Verify expectations
        const exp = test.expect;
        
        if (exp.a !== undefined && cpu.a !== exp.a) {
            details.push(`A: expected 0x${exp.a.toString(16).toUpperCase()}, got 0x${cpu.a.toString(16).toUpperCase()}`);
        }
        if (exp.b !== undefined && cpu.b !== exp.b) {
            details.push(`B: expected 0x${exp.b.toString(16).toUpperCase()}, got 0x${cpu.b.toString(16).toUpperCase()}`);
        }
        if (exp.c !== undefined && cpu.c !== exp.c) {
            details.push(`C: expected 0x${exp.c.toString(16).toUpperCase()}, got 0x${cpu.c.toString(16).toUpperCase()}`);
        }
        if (exp.d !== undefined && cpu.d !== exp.d) {
            details.push(`D: expected 0x${exp.d.toString(16).toUpperCase()}, got 0x${cpu.d.toString(16).toUpperCase()}`);
        }
        if (exp.e !== undefined && cpu.e !== exp.e) {
            details.push(`E: expected 0x${exp.e.toString(16).toUpperCase()}, got 0x${cpu.e.toString(16).toUpperCase()}`);
        }
        if (exp.h !== undefined && cpu.h !== exp.h) {
            details.push(`H: expected 0x${exp.h.toString(16).toUpperCase()}, got 0x${cpu.h.toString(16).toUpperCase()}`);
        }
        if (exp.l !== undefined && cpu.l !== exp.l) {
            details.push(`L: expected 0x${exp.l.toString(16).toUpperCase()}, got 0x${cpu.l.toString(16).toUpperCase()}`);
        }
        if (exp.sp !== undefined && cpu.sp !== exp.sp) {
            details.push(`SP: expected 0x${exp.sp.toString(16).toUpperCase()}, got 0x${cpu.sp.toString(16).toUpperCase()}`);
        }
        if (exp.pc !== undefined && cpu.pc !== exp.pc) {
            details.push(`PC: expected 0x${exp.pc.toString(16).toUpperCase()}, got 0x${cpu.pc.toString(16).toUpperCase()}`);
        }
        if (exp.flagZ !== undefined && cpu.flagZ !== exp.flagZ) {
            details.push(`Flag Z: expected ${exp.flagZ}, got ${cpu.flagZ}`);
        }
        if (exp.flagS !== undefined && cpu.flagS !== exp.flagS) {
            details.push(`Flag S: expected ${exp.flagS}, got ${cpu.flagS}`);
        }
        if (exp.flagP !== undefined && cpu.flagP !== exp.flagP) {
            details.push(`Flag P: expected ${exp.flagP}, got ${cpu.flagP}`);
        }
        if (exp.flagC !== undefined && cpu.flagC !== exp.flagC) {
            details.push(`Flag C: expected ${exp.flagC}, got ${cpu.flagC}`);
        }
        if (exp.flagAC !== undefined && cpu.flagAC !== exp.flagAC) {
            details.push(`Flag AC: expected ${exp.flagAC}, got ${cpu.flagAC}`);
        }
        if (exp.memoryAt) {
            for (const check of exp.memoryAt) {
                const actual = memory.ram[check.addr];
                if (actual !== check.value) {
                    details.push(`Memory[0x${check.addr.toString(16).toUpperCase()}]: expected 0x${check.value.toString(16).toUpperCase()}, got 0x${actual.toString(16).toUpperCase()}`);
                }
            }
        }
        
    } catch (err: any) {
        details.push(`Exception: ${err.message || err}`);
    }
    
    const durationMs = Date.now() - start;
    return {
        name: test.name,
        passed: details.length === 0,
        details,
        durationMs
    };
}

// Main test runner
function main() {
    console.log('Intel 8080 CPU Unit Tests');
    console.log('='.repeat(60));
    
    const results = cpuTests.map(runCpuTest);
    const passedCount = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed);
    
    for (const res of results) {
        const status = res.passed ? 'PASS' : 'FAIL';
        console.log(`${status.padEnd(4)} ${res.name} (${res.durationMs} ms)`);
        if (!res.passed) {
            for (const detail of res.details) {
                console.log(`     - ${detail}`);
            }
        }
    }
    
    console.log('='.repeat(60));
    console.log(`Results: ${passedCount}/${results.length} passed`);
    
    if (failed.length) {
        console.log(`\nFailed tests: ${failed.map(f => f.name).join(', ')}`);
        process.exitCode = 1;
    }
}

main();
