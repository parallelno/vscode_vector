import * as fs from 'fs';
import * as path from 'path';

type SourceOrigin = {
  file?: string;
  line: number;
  macroScope?: string;
  macroInstance?: {
    name: string;
    ordinal: number;
    callerFile?: string;
    callerLine?: number;
  };
};

type AssembleResult = {
  success: boolean;
  output?: Buffer;
  map?: Record<number, number>; // source line (1-based) -> address
  errors?: string[];
  warnings?: string[];
  labels?: Record<string, { addr: number; line: number; src?: string }>;
  origins?: SourceOrigin[];
};

type MacroParam = { name: string; defaultValue?: string };

type MacroDefinition = {
  name: string;
  params: MacroParam[];
  body: Array<{ line: string; origin: SourceOrigin }>;
  startLine: number;
  sourceFile?: string;
  invocationCount: number;
  normalLabels: Set<string>;
};

const MAX_MACRO_DEPTH = 32;

function stripInlineComment(line: string): string {
  return line.replace(/\/\/.*$|;.*$/, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitTopLevelArgs(text: string): string[] {
  if (!text.trim()) return [];
  const result: string[] = [];
  let current = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';
    if (!inDouble && ch === '\'' && prev !== '\\') {
      inSingle = !inSingle;
    } else if (!inSingle && ch === '"' && prev !== '\\') {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble) {
      if (ch === '(') depth++;
      else if (ch === ')' && depth > 0) depth--;
      else if (ch === ',' && depth === 0) {
        result.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  result.push(current.trim());
  return result;
}

function substituteIdentifiers(source: string, replacements: Record<string, string>): string {
  let output = source;
  for (const [token, value] of Object.entries(replacements)) {
    const pattern = new RegExp(`\\b${escapeRegExp(token)}\\b`, 'g');
    output = output.replace(pattern, value);
  }
  return output;
}

const regCodes: Record<string, number> = {
  B: 0,
  C: 1,
  D: 2,
  E: 3,
  H: 4,
  L: 5,
  M: 6,
  A: 7
};

const mviOpcodes = {
  B: 0x06,
  C: 0x0e,
  D: 0x16,
  E: 0x1e,
  H: 0x26,
  L: 0x2e,
  M: 0x36,
  A: 0x3e
} as Record<string, number>;

function toByte(v: string): number | null {
  if (/^0x[0-9a-fA-F]+$/.test(v)) return parseInt(v.slice(2), 16) & 0xff;
  if (/^[0-9]+$/.test(v)) return parseInt(v, 10) & 0xff;
  // binary forms: b010101 or %0101 with optional underscores
  if (/^b[01_]+$/i.test(v)) return parseInt(v.slice(1).replace(/_/g, ''), 2) & 0xff;
  if (/^%[01_]+$/.test(v)) return parseInt(v.slice(1).replace(/_/g, ''), 2) & 0xff;
  return null;
}

// Parse a numeric token without masking so we can check its full width
function parseNumberFull(v: string): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^\$[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(1), 16);
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  if (/^b[01_]+$/i.test(s)) return parseInt(s.slice(1).replace(/_/g, ''), 2);
  if (/^%[01_]+$/.test(s)) return parseInt(s.slice(1).replace(/_/g, ''), 2);
  return null;
}

function parseAddressToken(v: string, labels?: Map<string, { addr: number; line: number; src?: string }>, consts?: Map<string, number>): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16) & 0xffff;
  if (/^\$[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(1), 16) & 0xffff;
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10) & 0xffff;

  // support simple arithmetic chains like "a + b - 1" where tokens can be
  // numeric, global labels, or constants (from `consts`). This evaluates left
  // to right; local (@) labels are not resolved here (caller should use
  // `resolveAddressToken` which understands scope).
  const exprParts = s.split(/\s*([+-])\s*/);
  if (exprParts.length > 1) {
    let acc: number | null = null;
    for (let pi = 0; pi < exprParts.length; pi += 2) {
      const tok = exprParts[pi].trim();
      let val: number | null = null;
      // numeric literal
      val = parseNumberFull(tok);
      if (val === null) {
        if (consts && consts.has(tok)) val = consts.get(tok)!;
        else if (labels && labels.has(tok)) val = labels.get(tok)!.addr;
        else val = null;
      }
      if (val === null) return null;
      if (acc === null) acc = val;
      else {
        const op = exprParts[pi - 1];
        if (op === '+') acc = acc + val;
        else acc = acc - val;
      }
    }
    return (acc! & 0xffff);
  }

  if (consts && consts.has(s)) return consts.get(s)! & 0xffff;
  if (labels && labels.has(s)) return labels.get(s)!.addr & 0xffff;
  return null;
}

type LocalLabelRecord = { key: string; line: number };
type LocalLabelScopeIndex = Map<string, Map<string, LocalLabelRecord[]>>;

type ExpressionEvalContext = {
  labels: Map<string, { addr: number; line: number; src?: string }>;
  consts: Map<string, number>;
  localsIndex: LocalLabelScopeIndex;
  scopes: string[];
  lineIndex: number; // 1-based index in the expanded source list
};

type IfFrame = {
  effective: boolean;
  suppressed: boolean;
  origin?: SourceOrigin;
  lineIndex: number;
};

type ExprToken =
  | { type: 'number'; value: number }
  | { type: 'identifier'; name: string }
  | { type: 'operator'; op: string }
  | { type: 'paren'; value: '(' | ')' };

const MULTI_CHAR_OPERATORS = ['&&', '||', '==', '!=', '<=', '>=', '<<', '>>'];
const SINGLE_CHAR_OPERATORS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '<', '>']);

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_@]/.test(ch);
}

function isIdentifierPart(ch: string): boolean {
  return /[A-Za-z0-9_@.]/.test(ch);
}

function parseCharLiteral(expr: string, start: number): { value: number; nextIndex: number } {
  const quote = expr[start]!;
  let i = start + 1;
  let buffer = '';
  while (i < expr.length && expr[i] !== quote) {
    let ch = expr[i]!;
    if (ch === '\\') {
      i++;
      if (i >= expr.length) throw new Error('Unterminated character literal in expression');
      const esc = expr[i]!;
      switch (esc) {
        case 'n': ch = '\n'; break;
        case 'r': ch = '\r'; break;
        case 't': ch = '\t'; break;
        case '0': ch = '\0'; break;
        case '\\': ch = '\\'; break;
        case '\'': ch = '\''; break;
        case '"': ch = '"'; break;
        default: ch = esc;
      }
    }
    buffer += ch;
    i++;
  }
  if (i >= expr.length || expr[i] !== quote) {
    throw new Error('Unterminated character literal in expression');
  }
  if (!buffer.length) throw new Error('Empty character literal in expression');
  if (buffer.length > 1) throw new Error('Multi-character literals are not supported in expressions');
  const value = buffer.charCodeAt(0) & 0xff;
  return { value, nextIndex: i + 1 };
}

function tokenizeConditionExpression(expr: string): ExprToken[] {
  const tokens: ExprToken[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const two = expr.slice(i, i + 2);
    if (MULTI_CHAR_OPERATORS.includes(two)) {
      tokens.push({ type: 'operator', op: two });
      i += 2;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i++;
      continue;
    }
    if (SINGLE_CHAR_OPERATORS.has(ch)) {
      tokens.push({ type: 'operator', op: ch });
      i++;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      const literal = parseCharLiteral(expr, i);
      tokens.push({ type: 'number', value: literal.value });
      i = literal.nextIndex;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < expr.length && /[0-9a-fA-F]/.test(expr[j]!)) j++;
      if (j === i + 1) throw new Error('Malformed hex literal in expression');
      const value = parseInt(expr.slice(i + 1, j), 16);
      tokens.push({ type: 'number', value });
      i = j;
      continue;
    }
    if (ch === '0' && (expr[i + 1] === 'x' || expr[i + 1] === 'X')) {
      let j = i + 2;
      while (j < expr.length && /[0-9a-fA-F]/.test(expr[j]!)) j++;
      if (j === i + 2) throw new Error('Malformed hex literal in expression');
      const value = parseInt(expr.slice(i + 2, j), 16);
      tokens.push({ type: 'number', value });
      i = j;
      continue;
    }
    if (ch === '0' && (expr[i + 1] === 'b' || expr[i + 1] === 'B')) {
      let j = i + 2;
      while (j < expr.length && /[01_]/.test(expr[j]!)) j++;
      if (j === i + 2) throw new Error('Malformed binary literal in expression');
      const value = parseInt(expr.slice(i + 2, j).replace(/_/g, ''), 2);
      tokens.push({ type: 'number', value });
      i = j;
      continue;
    }
    if (ch === '%') {
      let j = i + 1;
      while (j < expr.length && /[01_]/.test(expr[j]!)) j++;
      if (j === i + 1) throw new Error('Malformed binary literal in expression');
      const value = parseInt(expr.slice(i + 1, j).replace(/_/g, ''), 2);
      tokens.push({ type: 'number', value });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < expr.length && /[0-9]/.test(expr[j]!)) j++;
      const value = parseInt(expr.slice(i, j), 10);
      tokens.push({ type: 'number', value });
      i = j;
      continue;
    }
    if (isIdentifierStart(ch)) {
      let j = i + 1;
      while (j < expr.length && isIdentifierPart(expr[j]!)) j++;
      const ident = expr.slice(i, j);
      if (/^b[01_]+$/i.test(ident)) {
        const value = parseInt(ident.slice(1).replace(/_/g, ''), 2);
        tokens.push({ type: 'number', value });
      } else {
        tokens.push({ type: 'identifier', name: ident });
      }
      i = j;
      continue;
    }
    throw new Error(`Unexpected character '${ch}' in expression`);
  }
  return tokens;
}

function resolveSymbolValue(name: string, ctx: ExpressionEvalContext): number | null {
  if (!name) return null;
  const lowered = name.toLowerCase();
  if (lowered === 'true') return 1;
  if (lowered === 'false') return 0;
  if (ctx.consts.has(name)) return ctx.consts.get(name)!;
  if (ctx.labels.has(name)) return ctx.labels.get(name)!.addr;
  if (name[0] === '@') {
    if (ctx.lineIndex <= 0) return null;
    const scopeKey = ctx.scopes[ctx.lineIndex - 1];
    if (!scopeKey) return null;
    const fileMap = ctx.localsIndex.get(scopeKey);
    if (!fileMap) return null;
    const arr = fileMap.get(name.slice(1));
    if (!arr || !arr.length) return null;
    let chosen = arr[0];
    for (const entry of arr) {
      if ((entry.line || 0) <= ctx.lineIndex) chosen = entry;
      else break;
    }
    const key = chosen.key;
    if (ctx.labels.has(key)) return ctx.labels.get(key)!.addr;
    return null;
  }
  return null;
}

class ConditionExpressionParser {
  private index = 0;

  constructor(private readonly tokens: ExprToken[], private readonly ctx: ExpressionEvalContext) {}

  parseExpression(allowEval: boolean): number {
    const value = this.parseLogicalOr(allowEval);
    if (this.index < this.tokens.length) {
      throw new Error(`Unexpected token '${this.describeToken(this.tokens[this.index]!)}' in expression`);
    }
    return allowEval ? value : 0;
  }

  private parseLogicalOr(allowEval: boolean): number {
    let value = this.parseLogicalAnd(allowEval);
    let matched = false;
    while (this.matchOperator('||')) {
      matched = true;
      const rhs = this.parseLogicalAnd(allowEval && value === 0);
      if (allowEval) value = (value !== 0 || rhs !== 0) ? 1 : 0;
    }
    if (!allowEval) return 0;
    return matched ? (value !== 0 ? 1 : 0) : value;
  }

  private parseLogicalAnd(allowEval: boolean): number {
    let value = this.parseBitwiseOr(allowEval);
    let matched = false;
    while (this.matchOperator('&&')) {
      matched = true;
      const rhs = this.parseBitwiseOr(allowEval && value !== 0);
      if (allowEval) value = (value !== 0 && rhs !== 0) ? 1 : 0;
    }
    if (!allowEval) return 0;
    return matched ? (value !== 0 ? 1 : 0) : value;
  }

  private parseBitwiseOr(allowEval: boolean): number {
    let value = this.parseBitwiseXor(allowEval);
    while (this.matchOperator('|')) {
      const rhs = this.parseBitwiseXor(allowEval);
      if (allowEval) value = (value | 0) | (rhs | 0);
    }
    return allowEval ? value : 0;
  }

  private parseBitwiseXor(allowEval: boolean): number {
    let value = this.parseBitwiseAnd(allowEval);
    while (this.matchOperator('^')) {
      const rhs = this.parseBitwiseAnd(allowEval);
      if (allowEval) value = (value | 0) ^ (rhs | 0);
    }
    return allowEval ? value : 0;
  }

  private parseBitwiseAnd(allowEval: boolean): number {
    let value = this.parseEquality(allowEval);
    while (this.matchOperator('&')) {
      const rhs = this.parseEquality(allowEval);
      if (allowEval) value = (value | 0) & (rhs | 0);
    }
    return allowEval ? value : 0;
  }

  private parseEquality(allowEval: boolean): number {
    let value = this.parseRelational(allowEval);
    let matched = false;
    while (true) {
      if (this.matchOperator('==')) {
        matched = true;
        const rhs = this.parseRelational(allowEval);
        if (allowEval) value = value === rhs ? 1 : 0;
      } else if (this.matchOperator('!=')) {
        matched = true;
        const rhs = this.parseRelational(allowEval);
        if (allowEval) value = value !== rhs ? 1 : 0;
      } else {
        break;
      }
    }
    if (!allowEval) return 0;
    return matched ? (value !== 0 ? 1 : 0) : value;
  }

  private parseRelational(allowEval: boolean): number {
    let value = this.parseShift(allowEval);
    let matched = false;
    while (true) {
      if (this.matchOperator('<')) {
        matched = true;
        const rhs = this.parseShift(allowEval);
        if (allowEval) value = value < rhs ? 1 : 0;
      } else if (this.matchOperator('>')) {
        matched = true;
        const rhs = this.parseShift(allowEval);
        if (allowEval) value = value > rhs ? 1 : 0;
      } else if (this.matchOperator('<=')) {
        matched = true;
        const rhs = this.parseShift(allowEval);
        if (allowEval) value = value <= rhs ? 1 : 0;
      } else if (this.matchOperator('>=')) {
        matched = true;
        const rhs = this.parseShift(allowEval);
        if (allowEval) value = value >= rhs ? 1 : 0;
      } else {
        break;
      }
    }
    if (!allowEval) return 0;
    return matched ? (value !== 0 ? 1 : 0) : value;
  }

  private parseShift(allowEval: boolean): number {
    let value = this.parseAdditive(allowEval);
    while (true) {
      if (this.matchOperator('<<')) {
        const rhs = this.parseAdditive(allowEval);
        if (allowEval) value = (value | 0) << (rhs & 31);
      } else if (this.matchOperator('>>')) {
        const rhs = this.parseAdditive(allowEval);
        if (allowEval) value = (value | 0) >> (rhs & 31);
      } else {
        break;
      }
    }
    return allowEval ? value : 0;
  }

  private parseAdditive(allowEval: boolean): number {
    let value = this.parseMultiplicative(allowEval);
    while (true) {
      if (this.matchOperator('+')) {
        const rhs = this.parseMultiplicative(allowEval);
        if (allowEval) value = value + rhs;
      } else if (this.matchOperator('-')) {
        const rhs = this.parseMultiplicative(allowEval);
        if (allowEval) value = value - rhs;
      } else {
        break;
      }
    }
    return allowEval ? value : 0;
  }

  private parseMultiplicative(allowEval: boolean): number {
    let value = this.parseUnary(allowEval);
    while (true) {
      if (this.matchOperator('*')) {
        const rhs = this.parseUnary(allowEval);
        if (allowEval) value = value * rhs;
      } else if (this.matchOperator('/')) {
        const rhs = this.parseUnary(allowEval);
        if (allowEval) {
          if (rhs === 0) throw new Error('Division by zero in expression');
          value = value / rhs;
        }
      } else if (this.matchOperator('%')) {
        const rhs = this.parseUnary(allowEval);
        if (allowEval) {
          if (rhs === 0) throw new Error('Modulo by zero in expression');
          value = value % rhs;
        }
      } else {
        break;
      }
    }
    return allowEval ? value : 0;
  }

  private parseUnary(allowEval: boolean): number {
    if (this.matchOperator('+')) return this.parseUnary(allowEval);
    if (this.matchOperator('-')) {
      const val = this.parseUnary(allowEval);
      return allowEval ? -val : 0;
    }
    if (this.matchOperator('!')) {
      const val = this.parseUnary(allowEval);
      return allowEval ? (val ? 0 : 1) : 0;
    }
    if (this.matchOperator('~')) {
      const val = this.parseUnary(allowEval);
      return allowEval ? (~val) | 0 : 0;
    }
    return this.parsePrimary(allowEval);
  }

  private parsePrimary(allowEval: boolean): number {
    const token = this.tokens[this.index];
    if (!token) throw new Error('Unexpected end of expression');
    if (token.type === 'paren' && token.value === '(') {
      this.index++;
      const value = this.parseLogicalOr(allowEval);
      if (!this.matchParen(')')) throw new Error('Unmatched ( in expression');
      return allowEval ? value : 0;
    }
    if (token.type === 'number') {
      this.index++;
      return allowEval ? token.value : 0;
    }
    if (token.type === 'identifier') {
      this.index++;
      if (!allowEval) return 0;
      const resolved = resolveSymbolValue(token.name, this.ctx);
      if (resolved === null) throw new Error(`Undefined symbol '${token.name}' in expression`);
      return resolved;
    }
    if (token.type === 'paren' && token.value === ')') {
      throw new Error('Unmatched ) in expression');
    }
    throw new Error(`Unexpected token '${this.describeToken(token)}' in expression`);
  }

  private matchOperator(op: string): boolean {
    const token = this.tokens[this.index];
    if (token && token.type === 'operator' && token.op === op) {
      this.index++;
      return true;
    }
    return false;
  }

  private matchParen(value: '(' | ')'): boolean {
    const token = this.tokens[this.index];
    if (token && token.type === 'paren' && token.value === value) {
      this.index++;
      return true;
    }
    return false;
  }

  private describeToken(token: ExprToken): string {
    if (token.type === 'number') return token.value.toString();
    if (token.type === 'identifier') return token.name;
    if (token.type === 'operator') return token.op;
    return token.value;
  }
}

function evaluateConditionExpression(expr: string, ctx: ExpressionEvalContext, allowEval = true): number {
  const tokens = tokenizeConditionExpression(expr);
  const parser = new ConditionExpressionParser(tokens, ctx);
  return parser.parseExpression(allowEval);
}

function resolveLocalLabelKey(name: string, originFile?: string, sourcePath?: string): string {
  if (!name || name[0] !== '@') return name;
  // strip leading @ and append '_' + basename without extension of the file
  const baseFile = originFile || sourcePath;
  const base = baseFile ? path.basename(baseFile, path.extname(baseFile)) : 'memory';
  return '@' + name.slice(1) + '_' + base;
}

function describeOrigin(origin?: SourceOrigin, fallbackLine?: number, sourcePath?: string): string {
  const file = origin?.file || sourcePath || '<memory>';
  const line = origin?.line ?? fallbackLine ?? 0;
  return `${file}:${line}`;
}

function detectNormalLabelName(line: string): string | null {
  const stripped = stripInlineComment(line);
  const match = stripped.match(/^\s*([@A-Za-z_][A-Za-z0-9_@.]*)\s*:/);
  if (!match) return null;
  const name = match[1];
  if (!name || name[0] === '@') return null;
  return name;
}

function prepareMacros(lines: string[], origins: SourceOrigin[], sourcePath?: string) {
  const macros = new Map<string, MacroDefinition>();
  const prunedLines: string[] = [];
  const prunedOrigins: SourceOrigin[] = [];
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const origin = origins[i];
    const trimmed = stripInlineComment(line).trim();
    if (!trimmed) {
      prunedLines.push(line);
      prunedOrigins.push(origin);
      continue;
    }
    if (/^\.macro\b/i.test(trimmed)) {
      const headerIndex = i;
      const headerOrigin = origin;
      const headerMatch = trimmed.match(/^\.macro\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\((.*)\))?\s*$/i);
      if (!headerMatch) {
        errors.push(`Malformed .macro directive at ${describeOrigin(origin, i + 1, sourcePath)}`);
        continue;
      }
      const macroName = headerMatch[1];
      const upperName = macroName.toUpperCase();
      const duplicate = macros.has(upperName);
      if (duplicate) {
        errors.push(`Duplicate macro '${macroName}' at ${describeOrigin(origin, i + 1, sourcePath)}`);
      }
      const paramsRaw = headerMatch[2] ? splitTopLevelArgs(headerMatch[2]) : [];
      const params: MacroParam[] = [];
      let paramError = false;
      for (const param of paramsRaw) {
        if (!param.length) continue;
        const idx = param.indexOf('=');
        const name = (idx >= 0 ? param.slice(0, idx) : param).trim();
        const defaultValue = idx >= 0 ? param.slice(idx + 1).trim() : undefined;
        if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          errors.push(`Invalid macro parameter '${param}' in ${macroName} at ${describeOrigin(origin, i + 1, sourcePath)}`);
          paramError = true;
          break;
        }
        params.push({ name, defaultValue: defaultValue && defaultValue.length ? defaultValue : undefined });
      }
      const body: Array<{ line: string; origin: SourceOrigin }> = [];
      const normalLabels = new Set<string>();
      let closed = false;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const innerLine = lines[j];
        const innerOrigin = origins[j];
        const innerTrimmed = stripInlineComment(innerLine).trim();
        if (/^\.macro\b/i.test(innerTrimmed)) {
          errors.push(`Nested .macro is not allowed (inside ${macroName}) at ${describeOrigin(innerOrigin, j + 1, sourcePath)}`);
        }
        if (/^\.endm(acro)?\b/i.test(innerTrimmed)) {
          closed = true;
          break;
        }
        body.push({ line: innerLine, origin: innerOrigin });
        const detected = detectNormalLabelName(innerLine);
        if (detected) normalLabels.add(detected);
      }
      if (!closed) {
        errors.push(`Missing .endmacro for ${macroName} starting at ${describeOrigin(headerOrigin, (headerOrigin?.line) ?? (headerIndex + 1), sourcePath)}`);
      }
      i = j;
      if (!paramError && !duplicate) {
        macros.set(upperName, {
          name: macroName,
          params,
          body,
          startLine: headerOrigin?.line ?? (headerIndex + 1),
          sourceFile: headerOrigin?.file || sourcePath,
          invocationCount: 0,
          normalLabels
        });
      }
      continue;
    }
    if (/^\.endm(acro)?\b/i.test(trimmed)) {
      errors.push(`.endmacro without matching .macro at ${describeOrigin(origin, i + 1, sourcePath)}`);
      continue;
    }
    prunedLines.push(line);
    prunedOrigins.push(origin);
  }

  return { lines: prunedLines, origins: prunedOrigins, macros, errors };
}

type MacroInvocationParse =
  | { kind: 'none' }
  | { kind: 'error' }
  | {
      kind: 'call';
      definition: MacroDefinition;
      paramValues: Record<string, string>;
      labelText?: string;
      scopeName: string;
      ordinal: number;
    };

function parseMacroInvocation(
  line: string,
  origin: SourceOrigin,
  macros: Map<string, MacroDefinition>,
  errors: string[],
  sourcePath?: string
): MacroInvocationParse {
  const withoutComments = stripInlineComment(line);
  if (!withoutComments.trim()) return { kind: 'none' };

  let working = withoutComments;
  let labelText: string | undefined;
  const labelMatch = working.match(/^(\s*)([@A-Za-z_][A-Za-z0-9_@.]*)\s*:\s*(.*)$/);
  if (labelMatch) {
    labelText = `${labelMatch[1] || ''}${labelMatch[2]}:`;
    working = labelMatch[3] || '';
  }
  const statement = working.trim();
  if (!statement.length) return { kind: 'none' };
  const nameMatch = statement.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  if (!nameMatch) return { kind: 'none' };
  const macroName = nameMatch[1];
  const def = macros.get(macroName.toUpperCase());
  if (!def) return { kind: 'none' };
  let idx = nameMatch[0].length;
  while (idx < statement.length && /\s/.test(statement[idx]!)) idx++;
  let hadParens = false;
  let argsText = '';
  if (idx < statement.length) {
    if (statement[idx] !== '(') {
      errors.push(`Macro '${macroName}' must be called with parentheses at ${describeOrigin(origin, undefined, sourcePath)}`);
      return { kind: 'error' };
    }
    hadParens = true;
    let depth = 0;
    let start = idx + 1;
    let inSingle = false;
    let inDouble = false;
    let endIndex = -1;
    for (let i = idx; i < statement.length; i++) {
      const ch = statement[i];
      const prev = i > 0 ? statement[i - 1] : '';
      if (!inDouble && ch === '\'' && prev !== '\\') inSingle = !inSingle;
      else if (!inSingle && ch === '"' && prev !== '\\') inDouble = !inDouble;
      else if (!inSingle && !inDouble) {
        if (ch === '(') {
          if (depth === 0) start = i + 1;
          depth++;
        } else if (ch === ')') {
          depth--;
          if (depth === 0) {
            endIndex = i;
            break;
          }
        }
      }
    }
    if (endIndex === -1) {
      errors.push(`Unterminated macro call '${macroName}' at ${describeOrigin(origin, undefined, sourcePath)}`);
      return { kind: 'error' };
    }
    argsText = statement.slice(start, endIndex);
    const trailing = statement.slice(endIndex + 1).trim();
    if (trailing.length) {
      errors.push(`Unexpected tokens after macro call '${macroName}' at ${describeOrigin(origin, undefined, sourcePath)}`);
      return { kind: 'error' };
    }
  }
  if (!hadParens && def.params.length > 0) {
    errors.push(`Macro '${macroName}' requires parentheses for arguments at ${describeOrigin(origin, undefined, sourcePath)}`);
    return { kind: 'error' };
  }
  const args = hadParens ? splitTopLevelArgs(argsText) : [];
  if (args.length > def.params.length) {
    errors.push(`Macro '${macroName}' received too many arguments at ${describeOrigin(origin, undefined, sourcePath)}`);
    return { kind: 'error' };
  }
  const values: Record<string, string> = {};
  for (let pi = 0; pi < def.params.length; pi++) {
    const param = def.params[pi];
    let raw = pi < args.length ? args[pi] : '';
    if (raw === undefined || raw === '') {
      if (param.defaultValue !== undefined) {
        raw = substituteIdentifiers(param.defaultValue, values);
      } else {
        raw = '0';
      }
    }
    values[param.name] = raw.trim();
  }
  if (!hadParens && def.params.length === 0 && statement.slice(idx).trim().length) {
    errors.push(`Macro '${macroName}' takes no arguments at ${describeOrigin(origin, undefined, sourcePath)}`);
    return { kind: 'error' };
  }
  const ordinal = ++def.invocationCount;
  const scopeName = `${def.name}_${ordinal}`;
  return { kind: 'call', definition: def, paramValues: values, labelText, scopeName, ordinal };
}

function instantiateMacroCall(
  call: Exclude<MacroInvocationParse, { kind: 'none' | 'error' }>,
  origin: SourceOrigin
): Array<{ line: string; origin: SourceOrigin }> {
  const replacements = { ...call.paramValues };
  const labelReplacements: Record<string, string> = {};
  for (const label of call.definition.normalLabels) {
    labelReplacements[label] = `${call.scopeName}.${label}`;
  }
  const out: Array<{ line: string; origin: SourceOrigin }> = [];
  for (const entry of call.definition.body) {
    let text = entry.line;
    if (Object.keys(replacements).length) {
      text = substituteIdentifiers(text, replacements);
    }
    if (call.definition.normalLabels.size) {
      text = substituteIdentifiers(text, labelReplacements);
    }
    out.push({
      line: text,
      origin: {
        file: entry.origin.file,
        line: entry.origin.line,
        macroScope: call.scopeName,
        macroInstance: {
          name: call.definition.name,
          ordinal: call.ordinal,
          callerFile: origin.file,
          callerLine: origin.line
        }
      }
    });
  }
  return out;
}

function expandMacroInvocations(
  lines: string[],
  origins: SourceOrigin[],
  macros: Map<string, MacroDefinition>,
  sourcePath?: string
) {
  const outLines: string[] = [];
  const outOrigins: SourceOrigin[] = [];
  const errors: string[] = [];

  function emitLine(line: string, origin: SourceOrigin, depth: number) {
    if (depth > MAX_MACRO_DEPTH) {
      errors.push(`Macro expansion exceeded maximum depth (${MAX_MACRO_DEPTH}) near ${describeOrigin(origin, undefined, sourcePath)}`);
      return;
    }
    const parsed = parseMacroInvocation(line, origin, macros, errors, sourcePath);
    if (parsed.kind === 'none') {
      outLines.push(line);
      outOrigins.push(origin);
      return;
    }
    if (parsed.kind === 'error') {
      return;
    }
    if (parsed.labelText) {
      outLines.push(parsed.labelText);
      outOrigins.push(origin);
    }
    const instantiated = instantiateMacroCall(parsed, origin);
    for (const inst of instantiated) {
      emitLine(inst.line, inst.origin, depth + 1);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    emitLine(lines[i], origins[i], 0);
  }

  return { lines: outLines, origins: outOrigins, errors };
}

export function assemble(source: string, sourcePath?: string): AssembleResult {
  // Expand .include directives and build an origin map so we can report
  // errors/warnings that reference the original file and line number.
  function processContent(content: string, file?: string, depth = 0): { lines: string[]; origins: SourceOrigin[] } {
    if (depth > 16) throw new Error(`Include recursion too deep (>${16}) when processing ${file || '<memory>'}`);
    const outLines: string[] = [];
    const origins: Array<{ file?: string; line: number }> = [];
    const srcLines = content.split(/\r?\n/);
    for (let li = 0; li < srcLines.length; li++) {
      const raw = srcLines[li];
      const trimmed = raw.replace(/\/\/.*$|;.*$/, '').trim();
      // match .include "filename" or .include 'filename'
      const m = trimmed.match(/^\.include\s+["']([^"']+)["']/i);
      if (m) {
        const inc = m[1];
        // resolve path
        let incPath = inc;
        if (!path.isAbsolute(incPath)) {
          const baseDir = file ? path.dirname(file) : (sourcePath ? path.dirname(sourcePath) : process.cwd());
          incPath = path.resolve(baseDir, incPath);
        }
        let incText: string;
        try {
          incText = fs.readFileSync(incPath, 'utf8');
        } catch (err) {
          const em = err && (err as any).message ? (err as any).message : String(err);
          throw new Error(`Failed to include '${inc}' at ${file || sourcePath || '<memory>'}:${li+1} - ${em}`);
        }
        const nested = processContent(incText, incPath, depth + 1);
        for (let k = 0; k < nested.lines.length; k++) {
          outLines.push(nested.lines[k]);
          origins.push(nested.origins[k]);
        }
        continue;
      }
      outLines.push(raw);
      origins.push({ file: file || sourcePath, line: li + 1 });
    }
    return { lines: outLines, origins };
  }

  let expanded: { lines: string[]; origins: SourceOrigin[] };
  try {
    expanded = processContent(source, sourcePath, 0);
  } catch (err: any) {
    return { success: false, errors: [err.message] };
  }
  const macroPrep = prepareMacros(expanded.lines, expanded.origins, sourcePath);
  if (macroPrep.errors.length) {
    return { success: false, errors: macroPrep.errors, origins: expanded.origins };
  }
  const macroExpanded = expandMacroInvocations(macroPrep.lines, macroPrep.origins, macroPrep.macros, sourcePath);
  if (macroExpanded.errors.length) {
    return { success: false, errors: macroExpanded.errors, origins: macroExpanded.origins };
  }
  const lines = macroExpanded.lines;
  const labels = new Map<string, { addr: number; line: number; src?: string }>();
  const consts = new Map<string, number>();
  // localsIndex: scopeKey -> (localName -> array of { key, line }) ordered by appearance
  const localsIndex: LocalLabelScopeIndex = new Map();
  // global numeric id counters per local name to ensure exported keys are unique
  const globalLocalCounters = new Map<string, number>();
  const scopes: string[] = new Array(lines.length);
  let directiveCounter = 0;
  function getFileKey(orig?: SourceOrigin) {
    return (orig && orig.file) ? path.resolve(orig.file) : (sourcePath ? path.resolve(sourcePath) : '<memory>');
  }
  function getScopeKey(orig?: SourceOrigin) {
    let key = getFileKey(orig) + '::' + directiveCounter;
    if (orig?.macroScope) key += `::${orig.macroScope}`;
    return key;
  }

  let addr = 0;
  const errors: string[] = [];
  const warnings: string[] = [];
  const origins = macroExpanded.origins;

  const ifStack: IfFrame[] = [];

  // First pass: labels and address calculation
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripInlineComment(raw).trim();
    if (!line) continue;

    if (i > 0) {
      const prev = origins[i - 1];
      const curr = origins[i];
      const prevKey = prev && prev.file ? path.resolve(prev.file) : (sourcePath ? path.resolve(sourcePath) : '<memory>');
      const currKey = curr && curr.file ? path.resolve(curr.file) : (sourcePath ? path.resolve(sourcePath) : '<memory>');
      if (prevKey !== currKey) {
        directiveCounter++;
      }
    }
    scopes[i] = getScopeKey(origins[i]);
    const originDesc = describeOrigin(origins[i], i + 1, sourcePath);

    const labelIfMatch = line.match(/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:?\s*\.if\b/i);
    if (labelIfMatch && line[0] !== '.') {
      errors.push(`Labels are not allowed on .if directives at ${originDesc}`);
      continue;
    }
    const labelEndifMatch = line.match(/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:?\s*\.endif\b/i);
    if (labelEndifMatch && line[0] !== '.') {
      errors.push(`Labels are not allowed on .endif directives at ${originDesc}`);
      continue;
    }

    const endifMatch = line.match(/^\.endif\b(.*)$/i);
    if (endifMatch) {
      const remainder = (endifMatch[1] || '').trim();
      if (remainder.length) errors.push(`Unexpected tokens after .endif at ${originDesc}`);
      if (!ifStack.length) errors.push(`.endif without matching .if at ${originDesc}`);
      else ifStack.pop();
      continue;
    }

    const ifMatch = line.match(/^\.if\b(.*)$/i);
    if (ifMatch) {
      const expr = (ifMatch[1] || '').trim();
      const parentActive = ifStack.length === 0 ? true : ifStack[ifStack.length - 1].effective;
      if (!expr.length) {
        errors.push(`Missing expression for .if at ${originDesc}`);
        ifStack.push({ effective: false, suppressed: !parentActive, origin: origins[i], lineIndex: i + 1 });
        continue;
      }
      const ctx: ExpressionEvalContext = { labels, consts, localsIndex, scopes, lineIndex: i + 1 };
      let conditionResult = false;
      if (!parentActive) {
        try {
          evaluateConditionExpression(expr, ctx, false);
        } catch (err: any) {
          errors.push(`Failed to parse .if expression at ${originDesc}: ${err?.message || err}`);
        }
      } else {
        try {
          const value = evaluateConditionExpression(expr, ctx, true);
          conditionResult = value !== 0;
        } catch (err: any) {
          errors.push(`Failed to evaluate .if at ${originDesc}: ${err?.message || err}`);
          conditionResult = false;
        }
      }
      const effective = parentActive && conditionResult;
      ifStack.push({ effective, suppressed: !parentActive, origin: origins[i], lineIndex: i + 1 });
      continue;
    }

    const blockActive = ifStack.length === 0 ? true : ifStack[ifStack.length - 1].effective;
    if (!blockActive) continue;

    const tokens = line.split(/\s+/);
    let labelHere: string | null = null;

    // simple constant / EQU handling: "NAME = expr" or "NAME EQU expr"
    if (tokens.length >= 3 && (tokens[1] === '=' || tokens[1].toUpperCase() === 'EQU')) {
      const name = tokens[0];
      const rhs = tokens.slice(2).join(' ').trim();
      let val: number | null = parseNumberFull(rhs);
      if (val === null) {
        if (consts.has(rhs)) val = consts.get(rhs)!;
        else if (labels.has(rhs)) val = labels.get(rhs)!.addr;
      }
      if (val === null) {
        errors.push(`Bad constant value '${rhs}' for ${name} at ${i + 1}`);
      } else {
        consts.set(name, val);
      }
      continue;
    }
    const assignMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (assignMatch) {
      const name = assignMatch[1];
      const rhs = assignMatch[2].trim();
      let val: number | null = parseNumberFull(rhs);
      if (val === null) {
        if (consts.has(rhs)) val = consts.get(rhs)!;
        else if (labels.has(rhs)) val = labels.get(rhs)!.addr;
      }
      if (val === null) errors.push(`Bad constant value '${rhs}' for ${name} at ${i + 1}`);
      else consts.set(name, val);
      continue;
    }
    const equMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+EQU\s+(.+)$/i);
    if (equMatch) {
      const name = equMatch[1];
      const rhs = equMatch[2].trim();
      let val: number | null = parseNumberFull(rhs);
      if (val === null) {
        if (consts.has(rhs)) val = consts.get(rhs)!;
        else if (labels.has(rhs)) val = labels.get(rhs)!.addr;
      }
      if (val === null) errors.push(`Bad constant value '${rhs}' for ${name} at ${i + 1}`);
      else consts.set(name, val);
      continue;
    }


    if (tokens[0].endsWith(':')) {
      labelHere = tokens[0].slice(0, -1);
      tokens.shift();
      const org = origins[i];
      const scopeKey = scopes[i];
      if (labelHere && labelHere[0] === '@') {
        const localName = labelHere.slice(1);
        let fileMap = localsIndex.get(scopeKey);
        if (!fileMap) { fileMap = new Map(); localsIndex.set(scopeKey, fileMap); }
        let arr = fileMap.get(localName);
        if (!arr) { arr = []; fileMap.set(localName, arr); }
        const gid = globalLocalCounters.get(localName) || 0;
        globalLocalCounters.set(localName, gid + 1);
        const key = '@' + localName + '_' + gid;
        arr.push({ key, line: org ? org.line : i + 1 });
        labels.set(key, { addr, line: org ? org.line : i + 1, src: org && org.file ? path.basename(org.file) : (sourcePath ? path.basename(sourcePath) : undefined) });
      } else {
        const key = labelHere;
        if (labels.has(key)) {
          const prev = labels.get(key)!;
          errors.push(`Duplicate label '${labelHere}' at ${i + 1} (previously at ${prev.line})`);
        } else {
          const org = origins[i];
          labels.set(key, { addr, line: org ? org.line : i + 1, src: org && org.file ? path.basename(org.file) : (sourcePath ? path.basename(sourcePath) : undefined) });
        }
      }
      if (!tokens.length) {
        continue;
      }
    } else if (tokens.length >= 2 && /^\.?org$/i.test(tokens[1])) {
      labelHere = tokens[0];
      tokens.shift();
    }

    const op = tokens[0].toUpperCase();

    if (op === 'DB') {
      // DB value [,value]
      const rest = line.slice(2).trim();
      const parts = rest.split(',').map(p => p.trim()).filter(p => p.length > 0);
      // account for multi-char quoted strings which emit multiple bytes
      for (const p of parts) {
        if (/^'.*'$/.test(p)) {
          // number of bytes equals number of characters inside quotes
          addr += Math.max(0, p.length - 2);
        } else {
          addr += 1;
        }
      }
      continue;
    }

    if (op === 'DS') {
      // DS count  (reserve bytes)
      const rest = tokens.slice(1).join(' ').trim();
      const n = parseInt(rest);
      if (isNaN(n) || n < 0) { errors.push(`Bad DS count '${rest}' at ${i + 1}`); continue; }
      addr += n;
      continue;
    }

    if (op === '.ORG' || op === 'ORG') {
      // .org addr
      const rest = tokens.slice(1).join(' ');
      const aTok = rest.trim().split(/\s+/)[0];
      const org = origins[i];
      let val: number | null = null;
      const num = parseNumberFull(aTok);
      if (num !== null) val = num & 0xffff;
      else if (aTok && aTok[0] === '@') {
        // try to resolve local label in current scope
        const scopeKey = getScopeKey(org);
        const fileMap = localsIndex.get(scopeKey);
        if (fileMap) {
          const arr = fileMap.get(aTok.slice(1));
          if (arr && arr.length) {
            // pick first definition (definitions earlier in file would be recorded)
            const key = arr[0].key;
            val = labels.get(key)!.addr & 0xffff;
          }
        }
      } else if (labels.has(aTok)) {
        val = labels.get(aTok)!.addr & 0xffff;
      }
      if (val === null) { errors.push(`Bad ORG address '${aTok}' at ${i + 1}`); continue; }
      addr = val;
      // .org defines a new (narrower) scope region for subsequent labels
      directiveCounter++;
      if (labelHere) {
        const org = origins[i];
        const newScope = getScopeKey(org);
        if (labelHere[0] === '@') {
          const localName = labelHere.slice(1);
          let fileMap = localsIndex.get(newScope);
          if (!fileMap) { fileMap = new Map(); localsIndex.set(newScope, fileMap); }
          let arr = fileMap.get(localName);
          if (!arr) { arr = []; fileMap.set(localName, arr); }
          const gid = globalLocalCounters.get(localName) || 0;
          globalLocalCounters.set(localName, gid + 1);
          const key = '@' + localName + '_' + gid;
          arr.push({ key, line: org ? org.line : i + 1 });
          labels.set(key, { addr, line: org ? org.line : i + 1, src: org && org.file ? path.basename(org.file) : (sourcePath ? path.basename(sourcePath) : undefined) });
        } else {
          const key = labelHere;
          if (labels.has(key)) errors.push(`Duplicate label ${labelHere} at ${i + 1}`);
          labels.set(key, { addr, line: org ? org.line : i + 1, src: org && org.file ? path.basename(org.file) : (sourcePath ? path.basename(sourcePath) : undefined) });
        }
      }
      continue;
    }

    if (op === 'MVI') {
      addr += 2; // opcode + data
      continue;
    }

    // Arithmetic immediate ops: ADI, ACI, SUI, SBI
    if (op === 'ADI' || op === 'ACI' || op === 'SUI' || op === 'SBI') {
      addr += 2;
      continue;
    }

    // Logical immediate ops: ANI, XRI, ORI, CPI
    if (op === 'ANI' || op === 'XRI' || op === 'ORI' || op === 'CPI') {
      addr += 2;
      continue;
    }

    // Single-byte arithmetic/logical ops
    if (op === 'ADC' || op === 'SBB' || op === 'SUB' || op === 'DAD' || op === 'DAA' || op === 'STC' || op === 'CMC' || op === 'ANA' || op === 'XRA' || op === 'ORA' || op === 'CMP') {
      addr += 1;
      continue;
    }

    if (op === 'LDAX' || op === 'STAX') {
      addr += 1;
      continue;
    }

    if (op === 'LHLD' || op === 'SHLD') {
      addr += 3;
      continue;
    }

    // INX/DCX register-pair (16-bit inc/dec)
    if (op === 'INX' || op === 'DCX') { addr += 1; continue; }

    if (op === 'LXI') {
      addr += 3;
      continue;
    }



    if (op === 'MOV') {
      addr += 1;
      continue;
    }

    if (op === 'LDA' || op === 'STA' || op === 'JMP' || op === 'JZ' || op === 'JNZ' || op === 'CALL') {
      addr += 3;
      continue;
    }

    // conditional jumps (JNZ/JZ/JNC/JC/JPO/JPE/JP/JM)
    if (/^J(NZ|Z|NC|C|PO|PE|P|M)$/.test(op)) { addr += 3; continue; }

    if (op === 'ADD' || op === 'INR' || op === 'DCR' || op === 'RET' || op === 'HLT' || op === 'NOP') {
      addr += 1;
      continue;
    }

    // Conditional returns
    if (/^R(NZ|Z|NC|C|PO|PE|P|M)$/.test(op)) { addr += 1; continue; }

    // PUSH/POP (register pairs)
    if (op === 'PUSH' || op === 'POP') { addr += 1; continue; }

    // CALL conditional/unconditional and RST
    if (op === 'CALL' || /^C(NZ|Z|NC|C|PO|PE|P|M)$/.test(op)) { addr += 3; continue; }
    if (op === 'RST') { addr += 1; continue; }

    // IN/OUT immediate
    if (op === 'IN' || op === 'OUT') { addr += 2; continue; }

    // Rotates and single-byte system ops
    if (/^R(LC|RC|AL|AR)$/.test(op) || op === 'EI' || op === 'DI' || op === 'SPHL' || op === 'XTHL' || op === 'XCHG' || op === 'PCHL' || op === 'DAA' || op === 'STC' || op === 'CMC') { addr += 1; continue; }

    if (op === 'XCHG' || op === 'PCHL' || op === 'SPHL' || op === 'XTHL') {
      addr += 1;
      continue;
    }

    // unknown -> error
    errors.push(`Unknown or unsupported opcode '${op}' at line ${i + 1}`);
  }

  if (ifStack.length) {
    for (let idx = ifStack.length - 1; idx >= 0; idx--) {
      const frame = ifStack[idx];
      errors.push(`Missing .endif for .if at ${describeOrigin(frame.origin, frame.lineIndex, sourcePath)}`);
    }
  }

  if (errors.length) return { success: false, errors, origins };

  // Second pass: generate bytes and source-line map
  addr = 0;
  const out: number[] = [];
  const map: Record<number, number> = {};

  // Resolve an address token in second pass: numeric, local (@) or global label
  function resolveAddressToken(arg: string, lineIndex: number): number | null {
    if (!arg) return null;
    const s = arg.trim();
    // simple numeric
    const num = parseNumberFull(s);
    if (num !== null) return num & 0xffff;
      // check simple named constants (e.g. TEMP_BYTE = 0x00)
      if (consts && consts.has(s)) return consts.get(s)! & 0xffff;

    // support simple expressions like "base + 15" where base may be a
    // numeric, a global label, or a local label (@name). RHS must be numeric.
    const em = s.match(/^(.+?)\s*([+-])\s*(0x[0-9a-fA-F]+|\$[0-9a-fA-F]+|[0-9]+)$/);
    if (em) {
      // simple two-term expression fallback (handled by chained evaluator below too)
    }

    // support chained arithmetic like "a + b - 1" where any token may be a
    // numeric, a global label, or a local label (@name). Evaluate left-to-right.
    const exprParts = s.split(/\s*([+-])\s*/);
    if (exprParts.length > 1) {
      let acc: number | null = null;
      for (let pi = 0; pi < exprParts.length; pi += 2) {
        const tok = exprParts[pi].trim();
        let val: number | null = null;
        // numeric
        val = parseNumberFull(tok);
        if (val === null) {
          if (tok[0] === '@') {
            const scopeKey = scopes[lineIndex - 1];
            const fileMap = localsIndex.get(scopeKey);
            if (!fileMap) return null;
            const arr = fileMap.get(tok.slice(1));
            if (!arr || !arr.length) return null;
            let chosen = arr[0];
            for (const entry of arr) {
              if ((entry.line || 0) <= lineIndex) chosen = entry;
              else break;
            }
            const key = chosen.key;
            if (labels.has(key)) val = labels.get(key)!.addr;
            else val = null;
          } else if (labels.has(tok)) {
            val = labels.get(tok)!.addr;
          } else if (consts && consts.has(tok)) {
            val = consts.get(tok)!;
          }
        }
        if (val === null) return null;
        if (acc === null) acc = val;
        else {
          const op = exprParts[pi - 1];
          acc = op === '+' ? (acc + val) : (acc - val);
        }
      }
      return (acc! & 0xffff);
    }

    // local label resolution based on the scope recorded during first pass
    if (s[0] === '@') {
      const scopeKey = scopes[lineIndex - 1];
      const fileMap = localsIndex.get(scopeKey);
      if (!fileMap) return null;
      const arr = fileMap.get(s.slice(1));
      if (!arr || !arr.length) return null;
      let chosen = arr[0];
      for (const entry of arr) {
        if ((entry.line || 0) <= lineIndex) chosen = entry;
        else break;
      }
      const key = chosen.key;
      if (labels.has(key)) return labels.get(key)!.addr & 0xffff;
      return null;
    }

    if (labels.has(s)) return labels.get(s)!.addr & 0xffff;
    return null;
  }

  const ifStackSecond: IfFrame[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const srcLine = i + 1;
    const line = stripInlineComment(raw).trim();
    if (!line) continue;

    const originDesc = describeOrigin(origins[i], srcLine, sourcePath);

    const labelIfMatch = line.match(/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:?\s*\.if\b/i);
    if (labelIfMatch && line[0] !== '.') {
      errors.push(`Labels are not allowed on .if directives at ${originDesc}`);
      continue;
    }
    const labelEndifMatch = line.match(/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:?\s*\.endif\b/i);
    if (labelEndifMatch && line[0] !== '.') {
      errors.push(`Labels are not allowed on .endif directives at ${originDesc}`);
      continue;
    }

    const endifMatch = line.match(/^\.endif\b(.*)$/i);
    if (endifMatch) {
      const remainder = (endifMatch[1] || '').trim();
      if (remainder.length) errors.push(`Unexpected tokens after .endif at ${originDesc}`);
      if (!ifStackSecond.length) errors.push(`.endif without matching .if at ${originDesc}`);
      else ifStackSecond.pop();
      continue;
    }

    const ifMatch = line.match(/^\.if\b(.*)$/i);
    if (ifMatch) {
      const expr = (ifMatch[1] || '').trim();
      const parentActive = ifStackSecond.length === 0 ? true : ifStackSecond[ifStackSecond.length - 1].effective;
      if (!expr.length) {
        errors.push(`Missing expression for .if at ${originDesc}`);
        ifStackSecond.push({ effective: false, suppressed: !parentActive, origin: origins[i], lineIndex: srcLine });
        continue;
      }
      const ctx: ExpressionEvalContext = { labels, consts, localsIndex, scopes, lineIndex: srcLine };
      let conditionResult = false;
      if (!parentActive) {
        try {
          evaluateConditionExpression(expr, ctx, false);
        } catch (err: any) {
          errors.push(`Failed to parse .if expression at ${originDesc}: ${err?.message || err}`);
        }
      } else {
        try {
          const value = evaluateConditionExpression(expr, ctx, true);
          conditionResult = value !== 0;
        } catch (err: any) {
          errors.push(`Failed to evaluate .if at ${originDesc}: ${err?.message || err}`);
          conditionResult = false;
        }
      }
      const effective = parentActive && conditionResult;
      ifStackSecond.push({ effective, suppressed: !parentActive, origin: origins[i], lineIndex: srcLine });
      continue;
    }

    const blockActive = ifStackSecond.length === 0 ? true : ifStackSecond[ifStackSecond.length - 1].effective;
    if (!blockActive) continue;

    if (/^[A-Za-z_][A-Za-z0-9_]*:$/.test(line)) continue; // label only

    const tokens = line.split(/\s+/);
    let labelHere: string | null = null;
    if (tokens[0].endsWith(':')) {
      labelHere = tokens[0].slice(0, -1);
      tokens.shift();
      if (!tokens.length) { map[srcLine] = addr; continue; }
    } else if (tokens.length >= 2 && /^\.?org$/i.test(tokens[1])) {
      labelHere = tokens[0];
      tokens.shift();
    }

    map[srcLine] = addr;

    if (tokens.length >= 3 && (tokens[1] === '=' || tokens[1].toUpperCase() === 'EQU')) {
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line) || /^[A-Za-z_][A-Za-z0-9_]*\s+EQU\b/i.test(line)) {
      continue;
    }

    const op = tokens[0].toUpperCase();

    if (op === 'DB') {
      const rest = line.slice(2).trim();
      const parts = rest.split(',').map(p => p.trim()).filter(p => p.length > 0);
      for (const p of parts) {
        if (/^'.*'$/.test(p)) {
          // multi-char string: emit each character as a byte
          for (let k = 1; k < p.length - 1; k++) {
            out.push(p.charCodeAt(k) & 0xff);
            addr++;
          }
        } else {
          let val = toByte(p);
          if (val === null) {
            errors.push(`Bad DB value '${p}' at ${srcLine}`);
            val = 0;
          }
          out.push(val & 0xff);
          addr++;
        }
      }
      continue;
    }

    if (op === '.ORG' || op === 'ORG') {
      const aTok = tokens.slice(1).join(' ').trim().split(/\s+/)[0];
      const val = parseAddressToken(aTok, labels, consts);
      if (val === null) { errors.push(`Bad ORG address '${aTok}' at ${srcLine}`); continue; }
      addr = val;
      // label for this ORG (if present) was already registered in first pass; nothing to emit
      continue;
    }

    if (op === 'DS') {
      const rest = tokens.slice(1).join(' ').trim();
      const n = parseInt(rest);
      if (isNaN(n) || n < 0) { errors.push(`Bad DS count '${rest}' at ${srcLine}`); continue; }
      // reserve: just advance addr (no bytes emitted)
      addr += n;
      continue;
    }

    if (op === 'LDAX' || op === 'STAX') {
      const reg = tokens[1].toUpperCase();
      let opcode = -1;
      if (op === 'LDAX') {
        if (reg === 'B') opcode = 0x0A;
        if (reg === 'D') opcode = 0x1A;
      } else {
        if (reg === 'B') opcode = 0x02;
        if (reg === 'D') opcode = 0x12;
      }
      if (opcode < 0) { errors.push(`Bad ${op} register '${reg}' at ${srcLine}`); continue; }
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    if (op === 'INX' || op === 'DCX') {
      const rp = tokens[1].toUpperCase();
      const isInx = op === 'INX';
      let opcode = -1;
      if (rp === 'B') opcode = isInx ? 0x03 : 0x0B;
      if (rp === 'D') opcode = isInx ? 0x13 : 0x1B;
      if (rp === 'H') opcode = isInx ? 0x23 : 0x2B;
      if (rp === 'SP') opcode = isInx ? 0x33 : 0x3B;
      if (opcode < 0) { errors.push(`Bad ${op} RP '${rp}' at ${srcLine}`); continue; }
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    if (op === 'LHLD' || op === 'SHLD') {
      const arg = tokens.slice(1).join(' ').trim();
      let target = 0;
      const num = parseNumberFull(arg);
      if (num !== null) {
        target = num;
        if (target > 0xffff) warnings.push(`Address ${arg} (0x${target.toString(16).toUpperCase()}) too large for ${op} at ${srcLine}; truncating to 16-bit`);
      } else {
        const resolvedVal = resolveAddressToken(arg, srcLine);
        if (resolvedVal !== null) target = resolvedVal;
        else { errors.push(`Unknown label or address '${arg}' at ${srcLine}`); target = 0; }
      }
      const opcode = op === 'LHLD' ? 0x2A : 0x22;
      out.push(opcode & 0xff);
      out.push(target & 0xff);
      out.push((target >> 8) & 0xff);
      addr += 3;
      continue;
    }

    if (op === 'XCHG') { out.push(0xEB); addr += 1; continue; }
    if (op === 'PCHL') { out.push(0xE9); addr += 1; continue; }
    if (op === 'SPHL') { out.push(0xF9); addr += 1; continue; }
    if (op === 'XTHL') { out.push(0xE3); addr += 1; continue; }

    if (op === 'MVI') {
      // MVI R,byte
      const args = line.slice(3).trim();
      const m = args.split(',').map(s => s.trim());
      if (m.length !== 2) { errors.push(`Bad MVI syntax at ${srcLine}`); continue; }
      const r = m[0].toUpperCase();
      const rawVal = m[1];
      // Allow numeric literals, constants, labels or simple expressions for the immediate
      let full: number | null = parseNumberFull(rawVal);
      if (full === null) {
        const resolved = resolveAddressToken(rawVal, srcLine);
        if (resolved !== null) full = resolved;
        else {
          // fallback to parseAddressToken which can evaluate simple const/label expressions
          const p = parseAddressToken(rawVal, labels, consts);
          if (p !== null) full = p;
        }
      }
      if (!(r in mviOpcodes) || (full === null)) { errors.push(`Bad MVI operands at ${srcLine}`); continue; }
      if (full > 0xff) warnings.push(`Immediate ${rawVal} (0x${full.toString(16).toUpperCase()}) too large for MVI at ${srcLine}; truncating to 0x${(full & 0xff).toString(16).toUpperCase()}`);
      out.push(mviOpcodes[r]);
      out.push((full & 0xff));
      addr += 2;
      continue;
    }

    if (op === 'MOV') {
      // MOV D,S
      const args = tokens.slice(1).join(' ');
      const m = args.split(',').map(s => s.trim());
      if (m.length !== 2) { errors.push(`Bad MOV syntax at ${srcLine}`); continue; }
      const d = m[0].toUpperCase();
      const s = m[1].toUpperCase();
      if (!(d in regCodes) || !(s in regCodes)) { errors.push(`Bad MOV registers at ${srcLine}`); continue; }
      // Explicitly reject the invalid MOV M,M form which would otherwise
      // encode to 0x76 (HLT) due to the MOV bit-pattern. Treat as an
      // assembler error instead of silently emitting HLT.
      if (d === 'M' && s === 'M') { errors.push(`Invalid MOV M,M at ${srcLine}`); continue; }
      const opcode = 0x40 + (regCodes[d] << 3) + regCodes[s];
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    if (op === 'LDA' || op === 'STA' || op === 'JMP' || op === 'JZ' || op === 'JNZ' || op === 'CALL') {
      const arg = tokens.slice(1).join(' ').trim();
      let target = 0;
      const num = parseNumberFull(arg);
      if (num !== null) {
        target = num;
        if (target > 0xffff) warnings.push(`Address ${arg} (0x${target.toString(16).toUpperCase()}) too large for ${op} at ${srcLine}; truncating to 16-bit`);
      } else {
        const resolvedVal = resolveAddressToken(arg, srcLine);
        if (resolvedVal !== null) target = resolvedVal;
        else { errors.push(`Unknown label or address '${arg}' at ${srcLine}`); target = 0; }
      }
      let opcode = 0;
      if (op === 'LDA') opcode = 0x3A;
      if (op === 'STA') opcode = 0x32;
      if (op === 'JMP') opcode = 0xC3;
      if (op === 'JZ') opcode = 0xCA;
      if (op === 'JNZ') opcode = 0xC2;
      if (op === 'CALL') opcode = 0xCD;
      out.push(opcode & 0xff);
      // little endian address
      out.push(target & 0xff);
      out.push((target >> 8) & 0xff);
      addr += 3;
      continue;
    }

    if (op === 'LXI') {
      // LXI RP, d16  (e.g., LXI B,0x1234)
      const args = line.slice(3).trim();
      const parts = args.split(',').map(s => s.trim());
      if (parts.length !== 2) { errors.push(`Bad LXI syntax at ${srcLine}`); continue; }
      const rp = parts[0].toUpperCase();
      const val = parts[1];
      let opcode = -1;
      if (rp === 'B') opcode = 0x01;
      if (rp === 'D') opcode = 0x11;
      if (rp === 'H') opcode = 0x21;
      if (rp === 'SP') opcode = 0x31;
      if (opcode < 0) { errors.push(`Bad LXI register pair at ${srcLine}`); continue; }
      let target = 0;
      const num = parseNumberFull(val);
      if (num !== null) {
        target = num;
        if (target > 0xffff) warnings.push(`Immediate ${val} (0x${target.toString(16).toUpperCase()}) too large for LXI at ${srcLine}; truncating to 16-bit`);
      } else {
        const resolvedVal = resolveAddressToken(val, srcLine);
        if (resolvedVal !== null) target = resolvedVal;
        else { errors.push(`Bad LXI value '${val}' at ${srcLine}`); target = 0; }
      }
      out.push(opcode & 0xff);
      out.push(target & 0xff);
      out.push((target >> 8) & 0xff);
      addr += 3;
      continue;
    }

    if (op === 'ADD') {
      // ADD r
      const r = tokens[1].toUpperCase();
      if (!(r in regCodes)) { errors.push(`Bad ADD reg at ${srcLine}`); continue; }
      const opcode = 0x80 + regCodes[r];
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    if (op === 'ADC') {
      const r = tokens[1].toUpperCase();
      if (!(r in regCodes)) { errors.push(`Bad ADC reg at ${srcLine}`); continue; }
      out.push((0x88 + regCodes[r]) & 0xff);
      addr += 1; continue;
    }

    if (op === 'SUB') {
      const r = tokens[1].toUpperCase();
      if (!(r in regCodes)) { errors.push(`Bad SUB reg at ${srcLine}`); continue; }
      out.push((0x90 + regCodes[r]) & 0xff);
      addr += 1; continue;
    }

    if (op === 'SBB') {
      const r = tokens[1].toUpperCase();
      if (!(r in regCodes)) { errors.push(`Bad SBB reg at ${srcLine}`); continue; }
      out.push((0x98 + regCodes[r]) & 0xff);
      addr += 1; continue;
    }

    if (op === 'INR' || op === 'DCR') {
      // INR r or DCR r
      const r = tokens[1].toUpperCase();
      if (!(r in regCodes)) { errors.push(`Bad ${op} reg at ${srcLine}`); continue; }
      const base = op === 'INR' ? 0x04 : 0x05;
      const opcode = base + (regCodes[r] << 3);
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    // ANA/ORA/XRA/CMP (register forms)
    if (op === 'ANA' || op === 'XRA' || op === 'ORA' || op === 'CMP') {
      const r = tokens[1].toUpperCase();
      if (!(r in regCodes)) { errors.push(`Bad ${op} reg at ${srcLine}`); continue; }
      let base = 0;
      if (op === 'ANA') base = 0xA0;
      if (op === 'XRA') base = 0xA8;
      if (op === 'ORA') base = 0xB0;
      if (op === 'CMP') base = 0xB8;
      out.push((base + regCodes[r]) & 0xff);
      addr += 1;
      continue;
    }

    // ADI/ACI/SUI/SBI immediate
    if (op === 'ADI' || op === 'ACI' || op === 'SUI' || op === 'SBI') {
      const valTok = tokens[1];
      const full = parseNumberFull(valTok);
      if (full === null) { errors.push(`Bad immediate '${valTok}' at ${srcLine}`); continue; }
      if (full > 0xff) warnings.push(`Immediate ${valTok} (0x${full.toString(16).toUpperCase()}) too large for ${op} at ${srcLine}; truncating to 8-bit`);
      let opcode = 0;
      if (op === 'ADI') opcode = 0xC6;
      if (op === 'ACI') opcode = 0xCE;
      if (op === 'SUI') opcode = 0xD6;
      if (op === 'SBI') opcode = 0xDE;
      out.push(opcode & 0xff);
      out.push(full & 0xff);
      addr += 2; continue;
    }

    // ANI/XRI/ORI/CPI immediate
    if (op === 'ANI' || op === 'XRI' || op === 'ORI' || op === 'CPI') {
      const valTok = tokens[1];
      const full = parseNumberFull(valTok);
      if (full === null) { errors.push(`Bad immediate '${valTok}' at ${srcLine}`); continue; }
      if (full > 0xff) warnings.push(`Immediate ${valTok} (0x${full.toString(16).toUpperCase()}) too large for ${op} at ${srcLine}; truncating to 8-bit`);
      let opcode = 0;
      if (op === 'ANI') opcode = 0xE6;
      if (op === 'XRI') opcode = 0xEE;
      if (op === 'ORI') opcode = 0xF6;
      if (op === 'CPI') opcode = 0xFE;
      out.push(opcode & 0xff);
      out.push(full & 0xff);
      addr += 2; continue;
    }

    // DAD RP
    if (op === 'DAD') {
      const rp = tokens[1].toUpperCase();
      let opcode = -1;
      if (rp === 'B') opcode = 0x09;
      if (rp === 'D') opcode = 0x19;
      if (rp === 'H') opcode = 0x29;
      if (rp === 'SP') opcode = 0x39;
      if (opcode < 0) { errors.push(`Bad DAD RP '${rp}' at ${srcLine}`); continue; }
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    // Rotates
    if (op === 'RLC') { out.push(0x07); addr += 1; continue; }
    if (op === 'RRC') { out.push(0x0F); addr += 1; continue; }
    if (op === 'RAL') { out.push(0x17); addr += 1; continue; }
    if (op === 'RAR') { out.push(0x1F); addr += 1; continue; }

    // EI/DI
    if (op === 'EI') { out.push(0xFB); addr += 1; continue; }
    if (op === 'DI') { out.push(0xF3); addr += 1; continue; }

    // PUSH/POP
    if (op === 'PUSH') {
      const rp = tokens[1].toUpperCase();
      let opcode = -1;
      if (rp === 'B') opcode = 0xC5;
      if (rp === 'D') opcode = 0xD5;
      if (rp === 'H') opcode = 0xE5;
      if (rp === 'PSW' || rp === 'PSW,' ) opcode = 0xF5;
      if (opcode < 0) { errors.push(`Bad PUSH RP '${rp}' at ${srcLine}`); continue; }
      out.push(opcode & 0xff); addr += 1; continue;
    }

    if (op === 'POP') {
      const rp = tokens[1].toUpperCase();
      let opcode = -1;
      if (rp === 'B') opcode = 0xC1;
      if (rp === 'D') opcode = 0xD1;
      if (rp === 'H') opcode = 0xE1;
      if (rp === 'PSW' || rp === 'PSW,') opcode = 0xF1;
      if (opcode < 0) { errors.push(`Bad POP RP '${rp}' at ${srcLine}`); continue; }
      out.push(opcode & 0xff); addr += 1; continue;
    }

    // IN/OUT
    if (op === 'IN') {
      const tok = tokens[1];
      const full = parseNumberFull(tok);
      if (full === null) { errors.push(`Bad IN port '${tok}' at ${srcLine}`); continue; }
      if (full > 0xff) warnings.push(`IN port ${tok} (0x${full.toString(16).toUpperCase()}) too large at ${srcLine}; truncating to 8-bit`);
      out.push(0xDB); out.push(full & 0xff); addr += 2; continue;
    }
    if (op === 'OUT') {
      const tok = tokens[1];
      const full = parseNumberFull(tok);
      if (full === null) { errors.push(`Bad OUT port '${tok}' at ${srcLine}`); continue; }
      if (full > 0xff) warnings.push(`OUT port ${tok} (0x${full.toString(16).toUpperCase()}) too large at ${srcLine}; truncating to 8-bit`);
      out.push(0xD3); out.push(full & 0xff); addr += 2; continue;
    }

    // RST n
    if (op === 'RST') {
      const n = parseInt(tokens[1]);
      if (isNaN(n) || n < 0 || n > 7) { errors.push(`Bad RST vector '${tokens[1]}' at ${srcLine}`); continue; }
      out.push((0xC7 + (n << 3)) & 0xff); addr += 1; continue;
    }

    // Conditional jumps and calls
    const jmpMap: Record<string, number> = { 'JNZ': 0xC2, 'JZ': 0xCA, 'JNC': 0xD2, 'JC': 0xDA, 'JPO': 0xE2, 'JPE': 0xEA, 'JP': 0xF2, 'JM': 0xFA };
    const callMap: Record<string, number> = { 'CNZ': 0xC4, 'CZ': 0xCC, 'CNC': 0xD4, 'CC': 0xDC, 'CPO': 0xE4, 'CPE': 0xEC, 'CP': 0xF4, 'CM': 0xFC };
    const retMap: Record<string, number> = { 'RNZ': 0xC0, 'RZ': 0xC8, 'RNC': 0xD0, 'RC': 0xD8, 'RPO': 0xE0, 'RPE': 0xE8, 'RP': 0xF0, 'RM': 0xF8 };

    if (op in jmpMap) {
      const arg = tokens.slice(1).join(' ').trim();
      let target = 0;
      const num = parseNumberFull(arg);
      if (num !== null) {
        target = num;
        if (target > 0xffff) warnings.push(`Address ${arg} (0x${target.toString(16).toUpperCase()}) too large for ${op} at ${srcLine}; truncating to 16-bit`);
      } else {
        const resolvedVal = resolveAddressToken(arg, srcLine);
        if (resolvedVal !== null) target = resolvedVal;
        else { errors.push(`Unknown label or address '${arg}' at ${srcLine}`); target = 0; }
      }
      out.push(jmpMap[op]); out.push(target & 0xff); out.push((target >> 8) & 0xff); addr += 3; continue;
    }

    if (op in callMap) {
      const arg = tokens.slice(1).join(' ').trim();
      let target = 0;
      const num = parseNumberFull(arg);
      if (num !== null) {
        target = num;
        if (target > 0xffff) warnings.push(`Address ${arg} (0x${target.toString(16).toUpperCase()}) too large for ${op} at ${srcLine}; truncating to 16-bit`);
      } else {
        const resolvedVal = resolveAddressToken(arg, srcLine);
        if (resolvedVal !== null) target = resolvedVal;
        else { errors.push(`Unknown label or address '${arg}' at ${srcLine}`); target = 0; }
      }
      out.push(callMap[op]); out.push(target & 0xff); out.push((target >> 8) & 0xff); addr += 3; continue;
    }

    if (op in retMap) { out.push(retMap[op]); addr += 1; continue; }

    // DAA, STC, CMC
    if (op === 'DAA') { out.push(0x27); addr += 1; continue; }
    if (op === 'STC') { out.push(0x37); addr += 1; continue; }
    if (op === 'CMC') { out.push(0x3F); addr += 1; continue; }

    if (op === 'RET') { out.push(0xC9); addr += 1; continue; }

    if (op === 'HLT') { out.push(0x76); addr += 1; continue; }
    if (op === 'NOP') { out.push(0x00); addr += 1; continue; }

    errors.push(`Unhandled opcode '${op}' at ${srcLine}`);
  }

  if (ifStackSecond.length) {
    for (let idx = ifStackSecond.length - 1; idx >= 0; idx--) {
      const frame = ifStackSecond[idx];
      errors.push(`Missing .endif for .if at ${describeOrigin(frame.origin, frame.lineIndex, sourcePath)}`);
    }
  }

  if (errors.length) return { success: false, errors, origins };

  // convert labels map to plain object for return
  const labelsOut: Record<string, { addr: number; line: number; src?: string }> = {};
  for (const [k, v] of labels) labelsOut[k] = { addr: v.addr, line: v.line, src: v.src };

  return { success: true, output: Buffer.from(out), map, labels: labelsOut, warnings, origins };
}

// convenience when using from extension
export function assembleAndWrite(source: string, outPath: string, sourcePath?: string): { success: boolean; path?: string; errors?: string[] } {
  const startTime = Date.now();
  const res = assemble(source, sourcePath);
  if (!res.success || !res.output) {
    // Improve error messages: include the source line, filename, line number,
    // and file URI / vscode URI so editors/terminals can link to the location.
    const formatted: string[] = [];
    const srcLines = source.split(/\r?\n/);
    if (res.errors && res.errors.length) {
      for (const e of res.errors) {
        // Try to extract a trailing `at <line>` marker from the assembler error
        const m = e.match(/at\s+(\d+)\b/);
        const lineNo = m ? parseInt(m[1], 10) : undefined;
        // Determine origin (file + original line) if available from assemble()
        const origin = (res.origins && lineNo) ? res.origins[lineNo - 1] : undefined;
        let srcText = '';
        let displayPath: string | undefined;
        let displayLine = lineNo;
        if (origin && origin.file) {
          displayPath = path.resolve(origin.file);
          displayLine = origin.line;
          try {
            const fileLines = fs.readFileSync(origin.file, 'utf8').split(/\r?\n/);
            if (fileLines[displayLine - 1]) srcText = fileLines[displayLine - 1].replace(/\t/g, '    ').trim();
          } catch (err) {
            srcText = '';
          }
        } else if (lineNo) {
          displayPath = sourcePath ? path.resolve(sourcePath) : undefined;
          srcText = srcLines[lineNo - 1] ? srcLines[lineNo - 1].replace(/\t/g, '    ').trim() : '';
        }
        let msg = '';
        if (displayPath && displayLine) {
          const fileUri = 'file:///' + displayPath.replace(/\\/g, '/');
          // replace any "at <expandedLine>" in the assembler message with the original source line
          const cleaned = typeof e === 'string' ? e.replace(/at\s+\d+\b/, `at ${displayLine}`) : e;
          msg = `${displayPath}:${displayLine}: ${cleaned}\n> ${srcText}\n${fileUri}:${displayLine}`;
        } else if (displayLine) {
          const cleaned = typeof e === 'string' ? e.replace(/at\s+\d+\b/, `at ${displayLine}`) : e;
          msg = `line ${displayLine}: ${cleaned}\n> ${srcText}`;
        } else {
          msg = e;
        }
        formatted.push(msg);
        // Also print to stderr for immediate feedback when running the assembler
        console.error(msg);
        console.error('');
      }
    }
    return { success: false, errors: formatted.length ? formatted : res.errors };
  }

  // Print warnings (non-fatal) in a similar formatted style so they are visible
  if (res.warnings && res.warnings.length) {
    for (const w of res.warnings) {
      const m = w.match(/at\s+(\d+)\b/);
      const lineNo = m ? parseInt(m[1], 10) : undefined;
      const origin = (res.origins && lineNo) ? res.origins[lineNo - 1] : undefined;
      let srcText = '';
      let displayPath: string | undefined;
      let displayLine = lineNo;
      if (origin && origin.file) {
        displayPath = path.resolve(origin.file);
        displayLine = origin.line;
        try {
          const fileLines = fs.readFileSync(origin.file, 'utf8').split(/\r?\n/);
          if (fileLines[displayLine - 1]) srcText = fileLines[displayLine - 1].replace(/\t/g, '    ').trim();
        } catch (err) {}
      } else if (lineNo) {
        displayPath = sourcePath ? path.resolve(sourcePath) : undefined;
        const srcLines = source.split(/\r?\n/);
        srcText = srcLines[lineNo - 1] ? srcLines[lineNo - 1].replace(/\t/g, '    ').trim() : '';
      }
      if (displayPath && displayLine) {
        const fileUri = 'file:///' + displayPath.replace(/\\/g, '/');
        const cleaned = typeof w === 'string' ? w.replace(/at\s+\d+\b/, `at ${displayLine}`) : w;
        console.warn(`${displayPath}:${displayLine}: ${cleaned}\n> ${srcText}\n${fileUri}:${displayLine}`);
        console.warn('');
      } else if (displayLine) {
        const cleaned = typeof w === 'string' ? w.replace(/at\s+\d+\b/, `at ${displayLine}`) : w;
        console.warn(`line ${displayLine}: ${cleaned}\n> ${srcText}`);
        console.warn('');
      } else {
        console.warn(w);
        console.warn('');
      }
    }
  }
  fs.writeFileSync(outPath, res.output);

  // write token file (JSON) next to outPath, same base name but .json extension
  try {
  // token file uses a `.debug.json` suffix (e.g. `test.rom` -> `test.debug.json`).
  // If the ROM path has no extension, append `.debug.json` verbatim.
  let tokenPath: string;
  if (/\.[^/.]+$/.test(outPath)) tokenPath = outPath.replace(/\.[^/.]+$/, '.debug.json');
  else tokenPath = outPath + '.debug.json';
    const tokens: any = {
      labels: {},
      consts: {}
    };
    if (res.labels) {
      for (const [name, info] of Object.entries(res.labels)) {
        tokens.labels[name] = {
          addr: '0x' + info.addr.toString(16).toUpperCase().padStart(4, '0'),
          src: info.src || (sourcePath ? path.basename(sourcePath) : undefined),
          line: info.line
        };
      }
    }
    tokens.lineAddresses = {};
    if (res.map && res.origins) {
      for (const [lineStr, addrVal] of Object.entries(res.map)) {
        const lineIndex = parseInt(lineStr, 10);
        if (!Number.isFinite(lineIndex) || lineIndex <= 0) continue;
        const origin = res.origins[lineIndex - 1] as { file?: string; line: number } | undefined;
        if (!origin || typeof origin.line !== 'number') continue;
        const originFile = (origin.file || sourcePath);
        if (!originFile) continue;
        const base = path.basename(originFile).toLowerCase();
        if (!tokens.lineAddresses[base]) tokens.lineAddresses[base] = {};
        tokens.lineAddresses[base][origin.line] = '0x' + (addrVal & 0xffff).toString(16).toUpperCase().padStart(4, '0');
      }
    }
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 4), 'utf8');
  } catch (err) {
    // non-fatal: write failed
    console.error('Warning: failed to write token file:', err);
  }

  const durationMs = Date.now() - startTime;
  // Print a concise success message including compile time for CLI/debug usage
  try {
    console.log(`Devector: Compilation succeeded to ${outPath} (${res.output ? res.output.length : 0} bytes) in ${durationMs} ms`);
  } catch (e) {}

  return { success: true, path: outPath, timeMs: durationMs } as any;
}
