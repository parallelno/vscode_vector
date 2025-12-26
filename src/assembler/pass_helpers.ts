import { evaluateExpression } from './expression';
import { parseNumberFull } from './utils';
import { ExpressionEvalContext, LocalLabelScopeIndex } from './types';

type LabelMap = Map<string, { addr: number; line: number; src?: string }>;

export type AssemblyEvalState = {
  labels: LabelMap;
  consts: Map<string, number>;
  localsIndex: LocalLabelScopeIndex;
  scopes: string[];
  originLines?: Array<number | undefined>;
};

function buildEvalContext(state: AssemblyEvalState, lineIndex: number): ExpressionEvalContext {
  return {
    labels: state.labels,
    consts: state.consts,
    localsIndex: state.localsIndex,
    scopes: state.scopes,
    lineIndex,
    originLine: state.originLines ? state.originLines[lineIndex - 1] : undefined
  };
}

export function evaluateExpressionValue(
  expr: string,
  lineIndex: number,
  errorLabel: string,
  state: AssemblyEvalState
): { value: number | null; error?: string } {
  const ctx = buildEvalContext(state, lineIndex);
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
  errors: string[]
): void {
  let val: number | null = parseNumberFull(rhs);
  if (val === null) {
    if (state.consts.has(rhs)) val = state.consts.get(rhs)!;
    else if (state.labels.has(rhs)) val = state.labels.get(rhs)!.addr;
  }

  if (val === null) {
    const ctx: ExpressionEvalContext = buildEvalContext(state, srcLine);
    try {
      val = evaluateExpression(rhs, ctx, true);
    } catch (err: any) {
      errors.push(`Failed to evaluate expression '${rhs}' for ${name} at ${originDesc}: ${err?.message || err}`);
      val = null;
    }
  }

  if (val !== null) {
    state.consts.set(name, val);
  }
}
