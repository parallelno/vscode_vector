import { evaluateExpression } from './expression';
import { parseNumberFull } from './utils';
import { ExpressionEvalContext, LocalLabelScopeIndex } from './types';
import {
  expandMacroScopeChain,
  extractMacroScope,
  formatMacroScopedName,
  resolveScopedConst
} from './labels';

type LabelMap = Map<string, { addr: number; line: number; src?: string }>;

export type AssemblyEvalState = {
  labels: LabelMap;
  consts: Map<string, number>;
  localsIndex: LocalLabelScopeIndex;
  scopes: string[];
  originLines?: Array<number | undefined>;
};

function buildEvalContext(state: AssemblyEvalState, lineIndex: number, locationCounter?: number): ExpressionEvalContext {
  const scopeKey = lineIndex > 0 && lineIndex - 1 < state.scopes.length ? state.scopes[lineIndex - 1] : undefined;
  return {
    labels: state.labels,
    consts: state.consts,
    localsIndex: state.localsIndex,
    scopes: state.scopes,
    lineIndex,
    macroScope: extractMacroScope(scopeKey),
    locationCounter,
    originLine: state.originLines ? state.originLines[lineIndex - 1] : undefined
  };
}

function resolveVariableStoreKey(
  name: string,
  state: AssemblyEvalState,
  srcLine: number
): { key: string; alias?: string } {
  const scopeKey = srcLine > 0 && srcLine - 1 < state.scopes.length ? state.scopes[srcLine - 1] : undefined;
  const macroScope = extractMacroScope(scopeKey);

  if (macroScope) {
    const chain = expandMacroScopeChain(macroScope);
    for (const scope of chain) {
      const scoped = formatMacroScopedName(name, scope);
      if (state.consts.has(scoped)) {
        return { key: scoped, alias: name };
      }
    }
    return { key: formatMacroScopedName(name, macroScope), alias: name };
  }

  return { key: name };
}

export function evaluateExpressionValue(
  expr: string,
  lineIndex: number,
  errorLabel: string,
  state: AssemblyEvalState,
  locationCounter?: number
): { value: number | null; error?: string } {
  const ctx = buildEvalContext(state, lineIndex, locationCounter);
  try {
    const value = evaluateExpression(expr, ctx, true);
    return { value };
  } catch (err: any) {
    return { value: null, error: `${errorLabel}: ${err?.message || err}` };
  }
}

export function processVariableAssignment(
  name: string,
  rhs: string,
  srcLine: number,
  originDesc: string,
  state: AssemblyEvalState,
  errors: string[],
  locationCounter?: number
): void {
  const scopeKey = srcLine > 0 && srcLine - 1 < state.scopes.length ? state.scopes[srcLine - 1] : undefined;
  let val: number | null = parseNumberFull(rhs);
  if (val === null) {
    const scopedConst = resolveScopedConst(rhs, state.consts, scopeKey);
    if (scopedConst !== undefined) val = scopedConst;
    else if (state.labels.has(rhs)) val = state.labels.get(rhs)!.addr;
  }

  if (val === null) {
    const ctx: ExpressionEvalContext = buildEvalContext(state, srcLine, locationCounter);
    try {
      val = evaluateExpression(rhs, ctx, true);
    } catch (err: any) {
      errors.push(`Failed to evaluate expression '${rhs}' for ${name} at ${originDesc}: ${err?.message || err}`);
      val = null;
    }
  }

  if (val !== null) {
    const { key, alias } = resolveVariableStoreKey(name, state, srcLine);
    state.consts.set(key, val);
    if (alias && alias !== key) state.consts.set(alias, val);
  }
}
