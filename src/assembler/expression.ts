import { ExpressionEvalContext } from './types';
import { resolveLocalLabelKey, resolveScopedConst } from './labels';
import { isIdentifierPart, isIdentifierStart } from './utils';

type ExprToken =
  | { type: 'number'; value: number }
  | { type: 'identifier'; name: string }
  | { type: 'location' }
  | { type: 'operator'; op: string }
  | { type: 'paren'; value: '(' | ')' };

const MULTI_CHAR_OPERATORS = ['&&', '||', '==', '!=', '<=', '>=', '<<', '>>'];
const SINGLE_CHAR_OPERATORS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '<', '>']);

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
    if (ch === '%' && /[01_]/.test(expr[i + 1] || '')) {
      let j = i + 1;
      while (j < expr.length && /[01_]/.test(expr[j]!)) j++;
      if (j === i + 1) throw new Error('Malformed binary literal in expression');
      const value = parseInt(expr.slice(i + 1, j).replace(/_/g, ''), 2);
      tokens.push({ type: 'number', value });
      i = j;
      continue;
    }
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
    if (ch === '*') {
      const prev = tokens[tokens.length - 1];
      const prevIsValue =
        prev && ((prev.type === 'number') || (prev.type === 'identifier') || (prev.type === 'location') || (prev.type === 'paren' && prev.value === ')'));
      tokens.push(prevIsValue ? { type: 'operator', op: '*' } : { type: 'location' });
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
    throw new Error(`Unexpected character '${ch}' in expression '${expr}'`);
  }
  return tokens;
}

function resolveSymbolValue(name: string, ctx: ExpressionEvalContext): number | null {
  if (!name) return null;
  const lowered = name.toLowerCase();
  if (lowered === 'true') return 1;
  if (lowered === 'false') return 0;
  const scopeKey = ctx.lineIndex > 0 && ctx.lineIndex - 1 < ctx.scopes.length ? ctx.scopes[ctx.lineIndex - 1] : undefined;
  const constVal = resolveScopedConst(name, ctx.consts, scopeKey, ctx.macroScope);
  // Temporary debug to trace diff_addr scoping issues
  if (lowered === 'diff_addr') {
    console.log('resolveSymbolValue diff_addr', {
      macroScope: ctx.macroScope,
      scopeKey,
      constVal,
      hasKey: ctx.consts.has(name),
      altKey: ctx.macroScope ? `${ctx.macroScope}::${name}` : undefined,
      altHas: ctx.macroScope ? ctx.consts.has(`${ctx.macroScope}::${name}`) : undefined
    });
  }
  if (constVal !== undefined) return constVal;
  if (ctx.labels.has(name)) return ctx.labels.get(name)!.addr;
  for (const [k, v] of ctx.labels) {
    if (k.toLowerCase() === lowered) return v.addr;
  }
  if (name[0] === '@') {
    const key = resolveLocalLabelKey(name, ctx.lineIndex, ctx.scopes, ctx.localsIndex, ctx.originLine);
    if (!key) return null;
    if (ctx.consts.has(key)) return ctx.consts.get(key)!;
    if (ctx.labels.has(key)) return ctx.labels.get(key)!.addr;
    return null;
  }
  return null;
}

class ConditionExpressionParser {
  private index = 0;

  constructor(
    private readonly tokens: ExprToken[],
    private readonly ctx: ExpressionEvalContext,
    private readonly exprText: string
  ) {}

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
            value = Math.trunc(value / rhs);
        }
      } else if (this.matchOperator('%')) {
        const rhs = this.parseUnary(allowEval);
        if (allowEval) {
          if (rhs === 0) throw new Error('Modulo by zero in expression');
          const lhsInt = Math.trunc(value);
          const rhsInt = Math.trunc(rhs);
          value = lhsInt % rhsInt;
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
    // Low byte operator: <N extracts bits 0-7 of the value
    if (this.matchOperator('<')) {
      const val = this.parseUnary(allowEval);
      return allowEval ? (val & 0xff) : 0;
    }
    // High byte operator: >N extracts bits 8-15 of the value
    if (this.matchOperator('>')) {
      const val = this.parseUnary(allowEval);
      return allowEval ? ((val >> 8) & 0xff) : 0;
    }
    return this.parsePrimary(allowEval);
  }

  private parsePrimary(allowEval: boolean): number {
    const token = this.tokens[this.index];
    if (!token) throw new Error(`Unexpected end of expression '${this.exprText}'`);
    if (token.type === 'paren' && token.value === '(') {
      this.index++;
      const value = this.parseLogicalOr(allowEval);
      if (!this.matchParen(')')) throw new Error(`Unmatched ( in expression '${this.exprText}'`);
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
      if (resolved === null) {
        throw new Error(`Undefined symbol '${token.name}' in expression '${this.exprText}'`);
      }
      return resolved;
    }
    if (token.type === 'location') {
      this.index++;
      if (!allowEval) return 0;
      if (this.ctx.locationCounter === undefined) {
        throw new Error(`Location counter '*' is not available in expression '${this.exprText}'`);
      }
      return this.ctx.locationCounter;
    }
    if (token.type === 'paren' && token.value === ')') {
      throw new Error(`Unmatched ) in expression '${this.exprText}'`);
    }
    throw new Error(`Unexpected token '${this.describeToken(token)}' in expression '${this.exprText}'`);
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
    if (token.type === 'location') return '*';
    if (token.type === 'operator') return token.op;
    return token.value;
  }
}

export function evaluateExpression(expr: string, ctx: ExpressionEvalContext, allowEval = true): number {
  const normalized = expr.trim();
  const tokens = tokenizeConditionExpression(normalized);
  const parser = new ConditionExpressionParser(tokens, ctx, normalized);
  return parser.parseExpression(allowEval);
}

// Backcompat: keep old name as alias so existing callers continue to work.
export const evaluateConditionExpression = evaluateExpression;
