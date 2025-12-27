import { argsAfterToken } from './common';
import { evaluateExpression } from './expression';
import { ExpressionEvalContext, LocalLabelScopeIndex, SourceOrigin } from './types';

export type AlignDirectiveEntry = { value: number };

export function handleAlignFirstPass(params: {
  line: string;
  tokens: string[];
  tokenOffsets: number[];
  lineIndex: number;
  directiveIndex: number;
  origin: SourceOrigin | undefined;
  originDesc: string;
  sourcePath: string | undefined;
  labels: Map<string, { addr: number; line: number; src?: string }>;
  consts: Map<string, number>;
  localsIndex: LocalLabelScopeIndex;
  scopes: string[];
  alignDirectives: Array<AlignDirectiveEntry | undefined>;
  pendingDirectiveLabel: string | null;
  makeScopeKey: (orig?: SourceOrigin) => string;
  registerLabel: (name: string, address: number, origin: SourceOrigin | undefined, fallbackLine: number, scopeKey: string) => void;
  errors: string[];
  addr: number;
}): { handled: boolean; addr: number; pendingDirectiveLabel: string | null } {
  const {
    line,
    tokens,
    tokenOffsets,
    lineIndex,
    directiveIndex,
    origin,
    originDesc,
    sourcePath,
    labels,
    consts,
    localsIndex,
    scopes,
    alignDirectives,
    pendingDirectiveLabel,
    makeScopeKey,
    registerLabel,
    errors,
    addr
  } = params;

  const exprText = argsAfterToken(line, tokens[0], tokenOffsets[0]).trim();
  if (!exprText.length) {
    errors.push(`Missing value for .align at ${originDesc}`);
    return { handled: true, addr, pendingDirectiveLabel };
  }

  const ctx: ExpressionEvalContext = { labels, consts, localsIndex, scopes, lineIndex };
  let alignment = 0;
  try {
    alignment = evaluateExpression(exprText, ctx, true);
  } catch (err: any) {
    errors.push(`Failed to evaluate .align at ${originDesc}: ${err?.message || err}`);
    return { handled: true, addr, pendingDirectiveLabel };
  }
  if (alignment <= 0) {
    errors.push(`.align value must be positive at ${originDesc}`);
    return { handled: true, addr, pendingDirectiveLabel };
  }
  if ((alignment & (alignment - 1)) !== 0) {
    errors.push(`.align value must be a power of two at ${originDesc}`);
    return { handled: true, addr, pendingDirectiveLabel };
  }

  const remainder = addr % alignment;
  const alignedAddr = remainder === 0 ? addr : addr + (alignment - remainder);
  if (alignedAddr > 0x10000) {
    errors.push(`.align would move address beyond 0x10000 at ${originDesc}`);
    return { handled: true, addr, pendingDirectiveLabel };
  }

  alignDirectives[directiveIndex] = { value: alignment };
  let nextPending = pendingDirectiveLabel;
  if (pendingDirectiveLabel) {
    const newScope = makeScopeKey(origin);
    const fallbackLine = origin && typeof origin.line === 'number' ? origin.line : lineIndex;
    registerLabel(pendingDirectiveLabel, alignedAddr, origin, fallbackLine, newScope);
    nextPending = null;
  }

  return { handled: true, addr: alignedAddr, pendingDirectiveLabel: nextPending };
}

export function handleAlignSecondPass(params: {
  directive: AlignDirectiveEntry | undefined;
  addr: number;
  out: number[];
}): { handled: boolean; addr: number } {
  const { directive, addr: currentAddr, out } = params;
  if (!directive) return { handled: false, addr: currentAddr };

  const alignment = directive.value;
  if (alignment <= 0) return { handled: true, addr: currentAddr };

  const remainder = currentAddr % alignment;
  if (remainder === 0) return { handled: true, addr: currentAddr };

  const gap = alignment - remainder;
  for (let k = 0; k < gap; k++) out.push(0);
  return { handled: true, addr: currentAddr + gap };
}
