import { ensureImmediateRange, InstructionContext, resolveAddressToken } from "./instructions";
import { INSTR_SIZES } from "./first_pass_instr";
import { ExpressionEvalContext } from "./types";
import { evaluateConditionExpression } from "./expression";

export const INSTR_OPCODES: Record<string, number | Record<string, number | Record<string, number>>> = {
  'NOP': 0x00,
  'LXI': {'B': 0x01, 'D': 0x11, 'H': 0x21, 'SP': 0x31 },
  'STAX': {'B': 0x02, 'D': 0x12 }, 'LDAX': {'B': 0x0A, 'D': 0x1A },
  'SHLD': 0x22, 'LHLD': 0x2A,
  'STA': 0x32, 'LDA': 0x3A,
  'INX': {'B': 0x03, 'D': 0x13, 'H': 0x23, 'SP': 0x33 },
  'DCX': {'B': 0x0B, 'D': 0x1B, 'H': 0x2B, 'SP': 0x3B },
  'INR': {'B': 0x04, 'D': 0x14, 'H': 0x24, 'M': 0x34, 'C': 0x0C, 'E': 0x1C, 'L': 0x2C, 'A': 0x3C },
  'DCR': {'B': 0x05, 'D': 0x15, 'H': 0x25, 'M': 0x35, 'C': 0x0D, 'E': 0x1D, 'L': 0x2D, 'A': 0x3D },
  'MVI': {'B': 0x06, 'D': 0x16, 'H': 0x26, 'M': 0x36, 'C': 0x0E, 'E': 0x1E, 'L': 0x2E, 'A': 0x3E },
  'RLC': 0x07, 'RAL': 0x17, 'DAA': 0x27, 'STC': 0x37,
  'DAD': {'B': 0x09, 'D': 0x19, 'H': 0x29, 'SP': 0x39},
  'RRC': 0x0F, 'RAR': 0x1F, 'CMA': 0x2F, 'CMC': 0x3F,
  'MOV': {'B': {'B': 0x40, 'C': 0x41, 'D': 0x42, 'E': 0x43, 'H': 0x44, 'L': 0x45, 'M': 0x46, 'A': 0x47 },
          'C': {'B': 0x48, 'C': 0x49, 'D': 0x4A, 'E': 0x4B, 'H': 0x4C, 'L': 0x4D, 'M': 0x4E, 'A': 0x4F },
          'D': {'B': 0x50, 'C': 0x51, 'D': 0x52, 'E': 0x53, 'H': 0x54, 'L': 0x55, 'M': 0x56, 'A': 0x57 },
          'E': {'B': 0x58, 'C': 0x59, 'D': 0x5A, 'E': 0x5B, 'H': 0x5C, 'L': 0x5D, 'M': 0x5E, 'A': 0x5F },
          'H': {'B': 0x60, 'C': 0x61, 'D': 0x62, 'E': 0x63, 'H': 0x64, 'L': 0x65, 'M': 0x66, 'A': 0x67 },
          'L': {'B': 0x68, 'C': 0x69, 'D': 0x6A, 'E': 0x6B, 'H': 0x6C, 'L': 0x6D, 'M': 0x6E, 'A': 0x6F },
          'M': {'B': 0x70, 'C': 0x71, 'D': 0x72, 'E': 0x73, 'H': 0x74, 'L': 0x75,            'A': 0x77 },
          'A': {'B': 0x78, 'C': 0x79, 'D': 0x7A, 'E': 0x7B, 'H': 0x7C, 'L': 0x7D, 'M': 0x7E, 'A': 0x7F } },
  'HLT': 0x76,
  'ADD': {'B': 0x80, 'C': 0x81, 'D': 0x82, 'E': 0x83, 'H': 0x84, 'L': 0x85, 'M': 0x86, 'A': 0x87 },
  'ADC': {'B': 0x88, 'C': 0x89, 'D': 0x8A, 'E': 0x8B, 'H': 0x8C, 'L': 0x8D, 'M': 0x8E, 'A': 0x8F },
  'SUB': {'B': 0x90, 'C': 0x91, 'D': 0x92, 'E': 0x93, 'H': 0x94, 'L': 0x95, 'M': 0x96, 'A': 0x97 },
  'SBB': {'B': 0x98, 'C': 0x99, 'D': 0x9A, 'E': 0x9B, 'H': 0x9C, 'L': 0x9D, 'M': 0x9E, 'A': 0x9F },
  'ANA': {'B': 0xA0, 'C': 0xA1, 'D': 0xA2, 'E': 0xA3, 'H': 0xA4, 'L': 0xA5, 'M': 0xA6, 'A': 0xA7 },
  'XRA': {'B': 0xA8, 'C': 0xA9, 'D': 0xAA, 'E': 0xAB, 'H': 0xAC, 'L': 0xAD, 'M': 0xAE, 'A': 0xAF },
  'ORA': {'B': 0xB0, 'C': 0xB1, 'D': 0xB2, 'E': 0xB3, 'H': 0xB4, 'L': 0xB5, 'M': 0xB6, 'A': 0xB7 },
  'CMP': {'B': 0xB8, 'C': 0xB9, 'D': 0xBA, 'E': 0xBB, 'H': 0xBC, 'L': 0xBD, 'M': 0xBE, 'A': 0xBF },
  'RNZ': 0xC0, 'RNC': 0xD0, 'RPO': 0xE0, 'RP': 0xF0, 'RZ': 0xC8, 'RC': 0xD8, 'RPE': 0xE8, 'RM': 0xF8,
  'RET': 0xC9,
  'POP': {'B': 0xC1, 'D': 0xD1, 'H': 0xE1, 'PSW': 0xF1 },
  'JNZ': 0xC2, 'JNC': 0xD2, 'JPO': 0xE2, 'JP': 0xF2, 'JZ': 0xCA, 'JC': 0xDA, 'JPE': 0xEA, 'JM': 0xFA,
  'JMP': 0xC3,
  'OUT': 0xD3, 'IN': 0xDB,
  'XTHL': 0xE3,
  'DI': 0xF3, 'EI': 0xFB,
  'CNZ': 0xC4, 'CNC': 0xD4, 'CPO': 0xE4, 'CP': 0xF4, 'CZ': 0xCC, 'CC': 0xDC, 'CPE': 0xEC, 'CM': 0xFC,
  'CALL': 0xCD,
  'PUSH': {'B': 0xC5, 'D': 0xD5, 'H': 0xE5, 'PSW': 0xF5 },
  'ADI': 0xC6, 'SUI': 0xD6, 'ANI': 0xE6, 'ORI': 0xF6,
  'RST': {'0': 0xC7, '1': 0xCF, '2': 0xD7, '3': 0xDF, '4': 0xE7, '5': 0xEF, '6': 0xF7, '7': 0xFF },
  'PCHL': 0xE9,
  'SPHL': 0xF9,
  'XCHG': 0xEB,
  'ACI': 0xCE, 'SBI': 0xDE, 'XRI': 0xEE, 'CPI': 0xFE
};

// Generate machine code for an instruction line
// Returns the length of the instruction in bytes, or 0 on error
export function instructionEncoding(
  tokens: string[],
  srcLine: number,
  ctx: InstructionContext,
  out: number[]
): number
{
  let opcode: number = -1;
  // Possible immediate data token index
  let possible_imm_idx = -1;
  const first_token = tokens[0].toUpperCase();
  const second_element = INSTR_OPCODES[first_token];

  // Handle one token instructions
  if (typeof second_element === "number") {
    opcode = second_element as number;
    possible_imm_idx = 1;
  }
  else{
    // Handle two token instructions
    const second_token = tokens[1].toUpperCase().replace(',', '');
    const third_element = second_element[second_token];
    if (typeof third_element === "number") {
      opcode = third_element as number;
      possible_imm_idx = 2;
    }
    else{
      // Handle three token instructions
      const third_token = tokens[2].toUpperCase();
      const fourth_element = third_element[third_token];
      opcode = fourth_element;
      possible_imm_idx = 3;
    }
  }
  if (opcode === -1) {
    ctx.errors.push(`Invalid instruction or operands at ${srcLine}`);
    return 0;
  }
  // Emit opcode
  out.push(opcode);

  const instr_len = INSTR_SIZES[first_token];
  if (instr_len === 1) return instr_len;

  // Handle instructions with immediate data
  if (possible_imm_idx === -1) {
    ctx.errors.push(`Missing immediate data at ${srcLine}`);
    return 0;
  }

  // Combine remaining tokens for immediate data
  const rawVal = tokens.slice(possible_imm_idx).join(' ');
  if (!rawVal) {
    ctx.errors.push(`Missing immediate data at ${srcLine}`);
    return 0;
  }

  // Expression evaluation
  const exprCtx: ExpressionEvalContext = {
    labels: ctx.labels,
    consts: ctx.consts,
    localsIndex: ctx.localsIndex,
    scopes: ctx.scopes,
    lineIndex: srcLine
  };
  let full: number | null = null;
  try {
    full = evaluateConditionExpression(rawVal, exprCtx, true);
  } catch (err: any) {
    // Fall through to error below
  }

  if (full === null) {
    ctx.errors.push(`Unable to resolve immediate value '${rawVal}' at ${srcLine}`);
    return 0;
  }

  const bits = instr_len === 3 ? 16 : 8;
  if (!ensureImmediateRange(
    full, bits, `Immediate ${rawVal}`, first_token, srcLine, ctx.errors))
  {
    return 0;
  }
  // Emit immediate data
  if (instr_len === 2) {
    out.push(full & 0xFF);
  }
  if (instr_len === 3) {
    out.push(full & 0xFF);
    out.push((full >> 8) & 0xFF);
  }

  return instr_len;
}