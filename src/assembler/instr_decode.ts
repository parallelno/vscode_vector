import { CpuType } from "../extention/project_info"
import { ensureImmediateRange, InstructionContext, resolveAddressToken } from "./instructions";
import { ExpressionEvalContext, SourceOrigin } from "./types";
import { evaluateExpression } from "./expression";
import { describeOrigin, formatMacroCallStack } from "./utils";

// Instruction info for Intel 8080.
// A key is the concatenation of mnemonic and operands separated by commas.
// An immediate value is shown by 'N'.
// For example, "LD (0x100), A" is represented as 'LD (N),A'.
// 'RST N' is an alias for all RST instructions. Further decoding is needed to
// get the actual opcode.
// The value is a tuple of [opcode, size in bytes, immediate data size in bytes]
export const INSTR_I8080: Record<string, [number, number, number]> = {
  'NOP': [0x00, 1, 0],
  'LXI B,N': [0x01, 3, 2], 'LXI D,N': [0x11, 3, 2], 'LXI H,N': [0x21, 3, 2], 'LXI SP,N': [0x31, 3, 2],
  'STAX B': [0x02, 1, 0], 'STAX D': [0x12, 1, 0],
  'LDAX B': [0x0A, 1, 0], 'LDAX D': [0x1A, 1, 0],
  'SHLD N': [0x22, 3, 2], 'LHLD N': [0x2A, 3, 2],
  'STA N': [0x32, 3, 2], 'LDA N': [0x3A, 3, 2],
  'INX B': [0x03, 1, 0], 'INX D': [0x13, 1, 0], 'INX H': [0x23, 1, 0], 'INX SP': [0x33, 1, 0],
  'DCX B': [0x0B, 1, 0], 'DCX D': [0x1B, 1, 0], 'DCX H': [0x2B, 1, 0], 'DCX SP': [0x3B, 1, 0],
  'INR B': [0x04, 1, 0], 'INR D': [0x14, 1, 0], 'INR H': [0x24, 1, 0], 'INR M': [0x34, 1, 0],
  'INR C': [0x0C, 1, 0], 'INR E': [0x1C, 1, 0], 'INR L': [0x2C, 1, 0], 'INR A': [0x3C, 1, 0],
  'DCR B': [0x05, 1, 0], 'DCR D': [0x15, 1, 0], 'DCR H': [0x25, 1, 0], 'DCR M': [0x35, 1, 0],
  'DCR C': [0x0D, 1, 0], 'DCR E': [0x1D, 1, 0], 'DCR L': [0x2D, 1, 0], 'DCR A': [0x3D, 1, 0],
  'MVI B,N': [0x06, 2, 1], 'MVI D,N': [0x16, 2, 1], 'MVI H,N': [0x26, 2, 1], 'MVI M,N': [0x36, 2, 1],
  'MVI C,N': [0x0E, 2, 1], 'MVI E,N': [0x1E, 2, 1], 'MVI L,N': [0x2E, 2, 1], 'MVI A,N': [0x3E, 2, 1],
  'RLC': [0x07, 1, 0], 'RAL': [0x17, 1, 0], 'DAA': [0x27, 1, 0], 'STC': [0x37, 1, 0],
  'DAD B': [0x09, 1, 0], 'DAD D': [0x19, 1, 0], 'DAD H': [0x29, 1, 0], 'DAD SP': [0x39, 1, 0],
  'RRC': [0x0F, 1, 0], 'RAR': [0x1F, 1, 0], 'CMA': [0x2F, 1, 0], 'CMC': [0x3F, 1, 0],
  // MOV
  'MOV B,B': [0x40, 1, 0], 'MOV B,C': [0x41, 1, 0], 'MOV B,D': [0x42, 1, 0], 'MOV B,E': [0x43, 1, 0],
  'MOV B,H': [0x44, 1, 0], 'MOV B,L': [0x45, 1, 0], 'MOV B,M': [0x46, 1, 0], 'MOV B,A': [0x47, 1, 0],
  'MOV C,B': [0x48, 1, 0], 'MOV C,C': [0x49, 1, 0], 'MOV C,D': [0x4A, 1, 0], 'MOV C,E': [0x4B, 1, 0],
  'MOV C,H': [0x4C, 1, 0], 'MOV C,L': [0x4D, 1, 0], 'MOV C,M': [0x4E, 1, 0], 'MOV C,A': [0x4F, 1, 0],
  'MOV D,B': [0x50, 1, 0], 'MOV D,C': [0x51, 1, 0], 'MOV D,D': [0x52, 1, 0], 'MOV D,E': [0x53, 1, 0],
  'MOV D,H': [0x54, 1, 0], 'MOV D,L': [0x55, 1, 0], 'MOV D,M': [0x56, 1, 0], 'MOV D,A': [0x57, 1, 0],
  'MOV E,B': [0x58, 1, 0], 'MOV E,C': [0x59, 1, 0], 'MOV E,D': [0x5A, 1, 0], 'MOV E,E': [0x5B, 1, 0],
  'MOV E,H': [0x5C, 1, 0], 'MOV E,L': [0x5D, 1, 0], 'MOV E,M': [0x5E, 1, 0], 'MOV E,A': [0x5F, 1, 0],
  'MOV H,B': [0x60, 1, 0], 'MOV H,C': [0x61, 1, 0], 'MOV H,D': [0x62, 1, 0], 'MOV H,E': [0x63, 1, 0],
  'MOV H,H': [0x64, 1, 0], 'MOV H,L': [0x65, 1, 0], 'MOV H,M': [0x66, 1, 0], 'MOV H,A': [0x67, 1, 0],
  'MOV L,B': [0x68, 1, 0], 'MOV L,C': [0x69, 1, 0], 'MOV L,D': [0x6A, 1, 0], 'MOV L,E': [0x6B, 1, 0],
  'MOV L,H': [0x6C, 1, 0], 'MOV L,L': [0x6D, 1, 0], 'MOV L,M': [0x6E, 1, 0], 'MOV L,A': [0x6F, 1, 0],
  'MOV M,B': [0x70, 1, 0], 'MOV M,C': [0x71, 1, 0], 'MOV M,D': [0x72, 1, 0], 'MOV M,E': [0x73, 1, 0],
  'MOV M,H': [0x74, 1, 0], 'MOV M,L': [0x75, 1, 0],                          'MOV M,A': [0x77, 1, 0],
  'MOV A,B': [0x78, 1, 0], 'MOV A,C': [0x79, 1, 0], 'MOV A,D': [0x7A, 1, 0], 'MOV A,E': [0x7B, 1, 0],
  'MOV A,H': [0x7C, 1, 0], 'MOV A,L': [0x7D, 1, 0], 'MOV A,M': [0x7E, 1, 0], 'MOV A,A': [0x7F, 1, 0],
  'HLT': [0x76, 1, 0],
  'ADD B': [0x80, 1, 0], 'ADD C': [0x81, 1, 0], 'ADD D': [0x82, 1, 0], 'ADD E': [0x83, 1, 0],
  'ADD H': [0x84, 1, 0], 'ADD L': [0x85, 1, 0], 'ADD M': [0x86, 1, 0], 'ADD A': [0x87, 1, 0],
  'ADC B': [0x88, 1, 0], 'ADC C': [0x89, 1, 0], 'ADC D': [0x8A, 1, 0], 'ADC E': [0x8B, 1, 0],
  'ADC H': [0x8C, 1, 0], 'ADC L': [0x8D, 1, 0], 'ADC M': [0x8E, 1, 0], 'ADC A': [0x8F, 1, 0],
  'SUB B': [0x90, 1, 0], 'SUB C': [0x91, 1, 0], 'SUB D': [0x92, 1, 0], 'SUB E': [0x93, 1, 0],
  'SUB H': [0x94, 1, 0], 'SUB L': [0x95, 1, 0], 'SUB M': [0x96, 1, 0], 'SUB A': [0x97, 1, 0],
  'SBB B': [0x98, 1, 0], 'SBB C': [0x99, 1, 0], 'SBB D': [0x9A, 1, 0], 'SBB E': [0x9B, 1, 0],
  'SBB H': [0x9C, 1, 0], 'SBB L': [0x9D, 1, 0], 'SBB M': [0x9E, 1, 0], 'SBB A': [0x9F, 1, 0],
  'AND B': [0xA0, 1, 0], 'AND C': [0xA1, 1, 0], 'AND D': [0xA2, 1, 0], 'AND E': [0xA3, 1, 0],
  'AND H': [0xA4, 1, 0], 'AND L': [0xA5, 1, 0], 'AND M': [0xA6, 1, 0], 'AND A': [0xA7, 1, 0],
  'XRA B': [0xA8, 1, 0], 'XRA C': [0xA9, 1, 0], 'XRA D': [0xAA, 1, 0], 'XRA E': [0xAB, 1, 0],
  'XRA H': [0xAC, 1, 0], 'XRA L': [0xAD, 1, 0], 'XRA M': [0xAE, 1, 0], 'XRA A': [0xAF, 1, 0],
  'ORA B': [0xB0, 1, 0], 'ORA C': [0xB1, 1, 0], 'ORA D': [0xB2, 1, 0], 'ORA E': [0xB3, 1, 0],
  'ORA H': [0xB4, 1, 0], 'ORA L': [0xB5, 1, 0], 'ORA M': [0xB6, 1, 0], 'ORA A': [0xB7, 1, 0],
  'CMP B': [0xB8, 1, 0], 'CMP C': [0xB9, 1, 0], 'CMP D': [0xBA, 1, 0], 'CMP E': [0xBB, 1, 0],
  'CMP H': [0xBC, 1, 0], 'CMP L': [0xBD, 1, 0], 'CMP M': [0xBE, 1, 0], 'CMP A': [0xBF, 1, 0],
  'RNZ': [0xC0, 1, 0], 'RZ': [0xC8, 1, 0], 'RNC': [0xD0, 1, 0], 'RC': [0xD8, 1, 0],
  'RPO': [0xE0, 1, 0], 'RPE': [0xE8, 1, 0], 'RP': [0xF0, 1, 0], 'RM': [0xF8, 1, 0],
  'RET': [0xC9, 1, 0],
  'POP B': [0xC1, 1, 0], 'POP D': [0xD1, 1, 0], 'POP H': [0xE1, 1, 0], 'POP PSW': [0xF1, 1, 0],
  'JNZ N': [0xC2, 3, 2], 'JZ N': [0xCA, 3, 2], 'JNC N': [0xD2, 3, 2], 'JC N': [0xDA, 3, 2],
  'JPO N': [0xE2, 3, 2], 'JPE N': [0xEA, 3, 2], 'JP N': [0xF2, 3, 2], 'JM N': [0xFA, 3, 2],
  'JMP N': [0xC3, 3, 2],
  'OUT N': [0xD3, 2, 1], 'IN N': [0xDB, 2, 1],
  'XTHL': [0xE3, 1, 0],
  'DI': [0xF3, 1, 0], 'EI': [0xFB, 1, 0],
  'CNZ N': [0xC4, 3, 2], 'CZ N': [0xCC, 3, 2], 'CNC N': [0xD4, 3, 2], 'CC N': [0xDC, 3, 2],
  'CPO N': [0xE4, 3, 2], 'CPE N': [0xEC, 3, 2], 'CP N': [0xF4, 3, 2], 'CM N': [0xFC, 3, 2],
  'CALL N': [0xCD, 3, 2],
  'PUSH B': [0xC5, 1, 0], 'PUSH D': [0xD5, 1, 0], 'PUSH H': [0xE5, 1, 0], 'PUSH PSW': [0xF5, 1, 0],
  'ADI N': [0xC6, 2, 1], 'SUI N': [0xD6, 2, 1], 'ANI N': [0xE6, 2, 1], 'ORI N': [0xF6, 2, 1],
  'RST 0': [0xC7, 1, 1], 'RST 1': [0xCF, 1, 1], 'RST 2': [0xD7, 1, 1], 'RST 3': [0xDF, 1, 1],
  'RST 4': [0xE7, 1, 1], 'RST 5': [0xEF, 1, 1], 'RST 6': [0xF7, 1, 1], 'RST 7': [0xFF, 1, 1],
  'PCHL': [0xE9, 1, 0],
  'SPHL': [0xF9, 1, 0],
  'XCHG': [0xEB, 1, 0],
  'ACI N': [0xCE, 2, 1], 'SBI N': [0xDE, 2, 1], 'XRI N': [0xEE, 2, 1], 'CPI N': [0xFE, 2, 1],
}

// Instruction info for Zilog Z80.
// This's a subset of Z80 instructions that matches the I8080 instructions.
// A key is the concatenation of mnemonic and operands separated by commas.
// An immediate value is shown by 'N'.
// For example, "LD (0x100), A" is represented as 'LD (N),A'.
// 'RST N' is an alias for all RST instructions. Further decoding is needed to
// get the actual opcode.
// The value is a tuple of [opcode, size in bytes, immediate data size in bytes]
export const INSTR_Z80: Record<string, [number, number, number]> = {
  'NOP': [0x00, 1, 0],
  // LXI
  'LD BC,N': [0x01, 3, 2], 'LD DE,N': [0x11, 3, 2], 'LD HL,N': [0x21, 3, 2], 'LD SP,N': [0x31, 3, 2],
  // STAX
  'LD (BC),A': [0x02, 1, 0], 'LD (DE),A': [0x12, 1, 0],
  // LDAX
  'LD A,(BC)': [0x0A, 1, 0], 'LD A,(DE)': [0x1A, 1, 0],
  // SHLD, LHLD
  'LD (N),HL': [0x22, 3, 2], 'LD HL,(N)': [0x2A, 3, 2],
  // STA, LDA
  'LD (N),A': [0x32, 3, 2], 'LD A,(N)': [0x3A, 3, 2],
  // INX
  'INC BC': [0x03, 1, 0], 'INC DE': [0x13, 1, 0], 'INC HL': [0x23, 1, 0], 'INC SP': [0x33, 1, 0],
  // DCX
  'DEC BC': [0x0B, 1, 0], 'DEC DE': [0x1B, 1, 0], 'DEC HL': [0x2B, 1, 0], 'DEC SP': [0x3B, 1, 0],
  // INR
  'INC B': [0x04, 1, 0], 'INC D': [0x14, 1, 0], 'INC H': [0x24, 1, 0], 'INC (HL)': [0x34, 1, 0],
  'INC C': [0x0C, 1, 0], 'INC E': [0x1C, 1, 0], 'INC L': [0x2C, 1, 0], 'INC A': [0x3C, 1, 0],
  // DCR
  'DEC B': [0x05, 1, 0], 'DEC D': [0x15, 1, 0], 'DEC H': [0x25, 1, 0], 'DEC (HL)': [0x35, 1, 0],
  'DEC C': [0x0D, 1, 0], 'DEC E': [0x1D, 1, 0], 'DEC L': [0x2D, 1, 0], 'DEC A': [0x3D, 1, 0],
  // MVI
  'LD B,N': [0x06, 2, 1], 'LD D,N': [0x16, 2, 1], 'LD H,N': [0x26, 2, 1], 'LD (HL),N': [0x36, 2, 1],
  'LD C,N': [0x0E, 2, 1], 'LD E,N': [0x1E, 2, 1], 'LD L,N': [0x2E, 2, 1], 'LD A,N': [0x3E, 2, 1],
  // RLC, RAL, DAA, STC,
  'RLCA': [0x07, 1, 0], 'RLA': [0x17, 1, 0], 'DAA': [0x27, 1, 0], 'SCF': [0x37, 1, 0],
  // DAD,
  'ADD HL,BC': [0x09, 1, 0], 'ADD HL,DE': [0x19, 1, 0], 'ADD HL,HL': [0x29, 1, 0], 'ADD HL,SP': [0x39, 1, 0],
  // RRC, RAR, CMA, CMC,
  'RRCA': [0x0F, 1, 0], 'RRA': [0x1F, 1, 0], 'CPL': [0x2F, 1, 0], 'CCF': [0x3F, 1, 0],
  // MOV
  'LD B,B': [0x40, 1, 0], 'LD B,C': [0x41, 1, 0], 'LD B,D': [0x42, 1, 0], 'LD B,E': [0x43, 1, 0],
  'LD B,H': [0x44, 1, 0], 'LD B,L': [0x45, 1, 0], 'LD B,(HL)': [0x46, 1, 0], 'LD B,A': [0x47, 1, 0],
  'LD C,B': [0x48, 1, 0], 'LD C,C': [0x49, 1, 0], 'LD C,D': [0x4A, 1, 0], 'LD C,E': [0x4B, 1, 0],
  'LD C,H': [0x4C, 1, 0], 'LD C,L': [0x4D, 1, 0], 'LD C,(HL)': [0x4E, 1, 0], 'LD C,A': [0x4F, 1, 0],
  'LD D,B': [0x50, 1, 0], 'LD D,C': [0x51, 1, 0], 'LD D,D': [0x52, 1, 0], 'LD D,E': [0x53, 1, 0],
  'LD D,H': [0x54, 1, 0], 'LD D,L': [0x55, 1, 0], 'LD D,(HL)': [0x56, 1, 0], 'LD D,A': [0x57, 1, 0],
  'LD E,B': [0x58, 1, 0], 'LD E,C': [0x59, 1, 0], 'LD E,D': [0x5A, 1, 0], 'LD E,E': [0x5B, 1, 0],
  'LD E,H': [0x5C, 1, 0], 'LD E,L': [0x5D, 1, 0], 'LD E,(HL)': [0x5E, 1, 0], 'LD E,A': [0x5F, 1, 0],
  'LD H,B': [0x60, 1, 0], 'LD H,C': [0x61, 1, 0], 'LD H,D': [0x62, 1, 0], 'LD H,E': [0x63, 1, 0],
  'LD H,H': [0x64, 1, 0], 'LD H,L': [0x65, 1, 0], 'LD H,(HL)': [0x66, 1, 0], 'LD H,A': [0x67, 1, 0],
  'LD L,B': [0x68, 1, 0], 'LD L,C': [0x69, 1, 0], 'LD L,D': [0x6A, 1, 0], 'LD L,E': [0x6B, 1, 0],
  'LD L,H': [0x6C, 1, 0], 'LD L,L': [0x6D, 1, 0], 'LD L,(HL)': [0x6E, 1, 0], 'LD L,A': [0x6F, 1, 0],
  'LD (HL),B': [0x70, 1, 0], 'LD (HL),C': [0x71, 1, 0], 'LD (HL),D': [0x72, 1, 0], 'LD (HL),E': [0x73, 1, 0],
  'LD (HL),H': [0x74, 1, 0], 'LD (HL),L': [0x75, 1, 0],                   'LD (HL),A': [0x77, 1, 0],
  'LD A,B': [0x78, 1, 0], 'LD A,C': [0x79, 1, 0], 'LD A,D': [0x7A, 1, 0], 'LD A,E': [0x7B, 1, 0],
  'LD A,H': [0x7C, 1, 0], 'LD A,L': [0x7D, 1, 0], 'LD A,(HL)': [0x7E, 1, 0], 'LD A,A': [0x7F, 1, 0],
  // HLT
  'HALT': [0x76, 1, 0],
  // ADD
  'ADD A,B': [0x80, 1, 0], 'ADD A,C': [0x81, 1, 0], 'ADD A,D': [0x82, 1, 0], 'ADD A,E': [0x83, 1, 0],
  'ADD A,H': [0x84, 1, 0], 'ADD A,L': [0x85, 1, 0], 'ADD A,(HL)': [0x86, 1, 0], 'ADD A,A': [0x87, 1, 0],
  // ADC
  'ADC A,B': [0x88, 1, 0], 'ADC A,C': [0x89, 1, 0], 'ADC A,D': [0x8A, 1, 0], 'ADC A,E': [0x8B, 1, 0],
  'ADC A,H': [0x8C, 1, 0], 'ADC A,L': [0x8D, 1, 0], 'ADC A,(HL)': [0x8E, 1, 0], 'ADC A,A': [0x8F, 1, 0],
  // SUB
  'SUB B': [0x90, 1, 0], 'SUB C': [0x91, 1, 0], 'SUB D': [0x92, 1, 0], 'SUB E': [0x93, 1, 0],
  'SUB H': [0x94, 1, 0], 'SUB L': [0x95, 1, 0], 'SUB (HL)': [0x96, 1, 0], 'SUB A': [0x97, 1, 0],
  // SBB
  'SBC A,B': [0x98, 1, 0], 'SBC A,C': [0x99, 1, 0], 'SBC A,D': [0x9A, 1, 0], 'SBC A,E': [0x9B, 1, 0],
  'SBC A,H': [0x9C, 1, 0], 'SBC A,L': [0x9D, 1, 0], 'SBC A,(HL)': [0x9E, 1, 0], 'SBC A,A': [0x9F, 1, 0],
  // ANA
  'AND B': [0xA0, 1, 0], 'AND C': [0xA1, 1, 0], 'AND D': [0xA2, 1, 0], 'AND E': [0xA3, 1, 0],
  'AND H': [0xA4, 1, 0], 'AND L': [0xA5, 1, 0], 'AND (HL)': [0xA6, 1, 0], 'AND A': [0xA7, 1, 0],
  // XRA
  'XOR B': [0xA8, 1, 0], 'XOR C': [0xA9, 1, 0], 'XOR D': [0xAA, 1, 0], 'XOR E': [0xAB, 1, 0],
  'XOR H': [0xAC, 1, 0], 'XOR L': [0xAD, 1, 0], 'XOR (HL)': [0xAE, 1, 0], 'XOR A': [0xAF, 1, 0],
  // ORA
  'OR B': [0xB0, 1, 0], 'OR C': [0xB1, 1, 0], 'OR D': [0xB2, 1, 0], 'OR E': [0xB3, 1, 0],
  'OR H': [0xB4, 1, 0], 'OR L': [0xB5, 1, 0], 'OR (HL)': [0xB6, 1, 0], 'OR A': [0xB7, 1, 0],
  // CMP
  'CP B': [0xB8, 1, 0], 'CP C': [0xB9, 1, 0], 'CP D': [0xBA, 1, 0], 'CP E': [0xBB, 1, 0],
  'CP H': [0xBC, 1, 0], 'CP L': [0xBD, 1, 0], 'CP (HL)': [0xBE, 1, 0], 'CP A': [0xBF, 1, 0],
  // RNZ, RZ, RNC, RC
  'RET NZ': [0xC0, 1, 0], 'RET Z': [0xC8, 1, 0], 'RET NC': [0xD0, 1, 0], 'RET C': [0xD8, 1, 0],
  // RPO, RPE, RP, RM
  'RET PO': [0xE0, 1, 0], 'RET PE': [0xE8, 1, 0], 'RET P': [0xF0, 1, 0], 'RET M': [0xF8, 1, 0],
  // RET
  'RET': [0xC9, 1, 0],
  // POP B, POP D, POP H, POP PSW
  'POP BC': [0xC1, 1, 0], 'POP DE': [0xD1, 1, 0], 'POP HL': [0xE1, 1, 0], 'POP AF': [0xF1, 1, 0],
  // JNZ, JZ, JNC, JC
  'JP NZ,N': [0xC2, 3, 2], 'JP Z,N': [0xCA, 3, 2], 'JP NC,N': [0xD2, 3, 2], 'JP C,N': [0xDA, 3, 2],
  // JPO, JPE, JP, JM
  'JP PO,N': [0xE2, 3, 2], 'JP PE,N': [0xEA, 3, 2], 'JP P,N': [0xF2, 3, 2], 'JP M,N': [0xFA, 3, 2],
  // JMP
  'JP N': [0xC3, 3, 2],
  // OUT, IN
  'OUT (N), A': [0xD3, 2, 1], 'IN A,(N)': [0xDB, 2, 1],
  // XTHL
  'EX (SP),HL': [0xE3, 1, 0],
  // DI, EI
  'DI': [0xF3, 1, 0], 'EI': [0xFB, 1, 0],
  // CNZ, CZ, CNC, CC
  'CALL NZ,N': [0xC4, 3, 2], 'CALL Z,N': [0xCC, 3, 2], 'CALL NC,N': [0xD4, 3, 2], 'CALL C,N': [0xDC, 3, 2],
  // CPO, CPE, CP, CM
  'CALL PO,N': [0xE4, 3, 2], 'CALL PE,N': [0xEC, 3, 2], 'CALL P,N': [0xF4, 3, 2], 'CALL M,N': [0xFC, 3, 2],
  // CALL
  'CALL N': [0xCD, 3, 2],
  // PUSH B, PUSH D, PUSH H, PUSH PSW
  'PUSH BC': [0xC5, 1, 0], 'PUSH DE': [0xD5, 1, 0], 'PUSH HL': [0xE5, 1, 0], 'PUSH AF': [0xF5, 1, 0],
  // ADI, SUI, ANI, ORI
  'ADD A,N': [0xC6, 2, 1], 'SUB N': [0xD6, 2, 1], 'AND N': [0xE6, 2, 1], 'OR N': [0xF6, 2, 1],
  // RST
  'RST N': [0xC7, 1, 1], // N = 00H, 08H, 10H, 18H, 20H, 28H, 30H, 38H
  // PCHL
  'JP (HL)': [0xE9, 1, 0],
  // SPHL
  'LD SP, HL': [0xF9, 1, 0],
  // XCHG
  'EX DE, HL': [0xEB, 1, 0],
  // ACI, SBI, XRI, CPI
  'ADC A,N': [0xCE, 2, 1], 'SBC A,N': [0xDE, 2, 1], 'XOR N': [0xEE, 2, 1], 'CP N': [0xFE, 2, 1],
}

export const OPERANDS = [
  'A','B','C','D','E','H','L',
  'BC','DE','HL','SP','AF', "AF'", 'PSW',
  '(A)','(B)','(C)','(D)','(E)','(H)','(L)', 'M',
  '(BC)', '(DE)', '(HL)', '(SP)',
  'IX', 'IY', '(IX)', '(IY)', 'IXH', 'IXL', 'IYH', 'IYL', 'I', 'R'];

type InstructionInfo = {opcode: number ; size: number, immSize: number, imm: string | null } | null;
export function getInstructionInfo(
  tokens: string[],
  cpu: CpuType)
  : InstructionInfo | undefined
{
  const {instrKey, immOperand} = tokensToInstrKey(tokens);
  const instrMap = cpu === 'i8080' ? INSTR_I8080 : INSTR_Z80;

  if (instrMap.hasOwnProperty(instrKey)) {
    return {opcode: instrMap[instrKey][0], size: instrMap[instrKey][1], immSize: instrMap[instrKey][2], imm: immOperand};
  }
  return undefined;
}


function tokensToInstrKey(tokens: string[]): { instrKey: string; immOperand: string } {
  const instr = tokens[0].toUpperCase();
  const operands = tokens.slice(1);
  const keyParts: string[] = [];
  const immParts: string[] = [];

  for (const operand of operands) {
    const opUpper = operand.toUpperCase();
    if (OPERANDS.includes(opUpper)) {
      keyParts.push(opUpper);
    } else {
      // Add immediate marker 'N' once for the first immediate part
      if (immParts.length === 0) keyParts.push('N');
      immParts.push(operand);
    }
  }

  const instrKey = operands.length ? `${instr} ${keyParts.join(',')}` : instr;
  return { instrKey, immOperand: immParts.join('') };
}


// Generate machine code for an instruction line
// Returns the length of the instruction in bytes, or 0 on error
export function instructionEncoding(
  tokens: string[],
  cpu: CpuType,
  srcLine: number,
  origin: SourceOrigin | undefined,
  ctx: InstructionContext,
  out: number[]
): number
{
  const instrInfo = getInstructionInfo(tokens, cpu);

  if (!instrInfo) {
    const stack = formatMacroCallStack(origin);
    ctx.errors.push(`Invalid instruction or operands at ${describeOrigin(origin, srcLine)}${stack}`);
    return 0;
  }

  // Emit opcode
  out.push(instrInfo.opcode);
  if (instrInfo.immSize === 0) return instrInfo.size;

  // Handle instructions with immediate data
  if (instrInfo.imm?.length === 0) {
    const stack = formatMacroCallStack(origin);
    ctx.errors.push(`Missing immediate data at ${describeOrigin(origin, srcLine)}${stack}`);
    return 0;
  }

  // Expression evaluation
  const originLine = ctx.originLines ? ctx.originLines[srcLine - 1] : undefined;
  const exprCtx: ExpressionEvalContext = {
    labels: ctx.labels,
    consts: ctx.consts,
    localsIndex: ctx.localsIndex,
    scopes: ctx.scopes,
    lineIndex: srcLine,
    originLine,
    locationCounter: ctx.locationCounter
  };
  let full: number | null = null;
  try {
    full = evaluateExpression(instrInfo.imm!, exprCtx, true);
  } catch (err: any) {
    // Fall through to error below
  }

  if (full === null) {
    const stack = formatMacroCallStack(origin);
    ctx.errors.push(`Unable to resolve immediate value '${instrInfo.imm}' at ${describeOrigin(origin, srcLine)}${stack}`);
    return 0;
  }

  const bits = instrInfo.immSize === 2 ? 16 : 8;
  if (!ensureImmediateRange(
    full, bits, `Immediate ${instrInfo.imm!}`, tokens[0], srcLine, ctx.errors, origin))
  {
    return 0;
  }
  // Emit immediate data
  if (instrInfo.immSize === 1) {
    out.push(full & 0xFF);
  }
  if (instrInfo.immSize === 2) {
    out.push(full & 0xFF);
    out.push((full >> 8) & 0xFF);
  }

  return instrInfo.size;
}