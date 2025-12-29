import { ExpressionEvalContext, LocalLabelScopeIndex, LoopExpansionResult, SourceOrigin } from './types';
import { stripInlineComment, describeOrigin } from './utils';
import { evaluateExpression } from './expression';

const LOOP_MAX_ITERATIONS = 100000;

export function expandLoopDirectives(lines: string[], origins: SourceOrigin[], sourcePath?: string): LoopExpansionResult {
  const outLines: string[] = [];
  const outOrigins: SourceOrigin[] = [];
  const errors: string[] = [];
  const constState = new Map<string, number>();
  const dummyLabels = new Map<string, { addr: number; line: number; src?: string }>();
  const dummyLocals: LocalLabelScopeIndex = new Map();
  const dummyScopes: string[] = [];
  type IfFrame = { active: boolean; anyTrue: boolean; parentActive: boolean };
  const ifStack: IfFrame[] = [];

  const isActive = () => ifStack.length ? ifStack[ifStack.length - 1]!.active : true;

  function describeLine(idx: number): string {
    return describeOrigin(origins[idx], idx + 1, sourcePath);
  }

  function evalExpr(expr: string, idx: number): number | null {
    const ctx: ExpressionEvalContext = {
      labels: dummyLabels,
      consts: constState,
      localsIndex: dummyLocals,
      scopes: dummyScopes,
      lineIndex: origins[idx]?.line ?? (idx + 1)
    };
    try {
      return evaluateExpression(expr, ctx, true);
    } catch (err: any) {
      const msg = err?.message || String(err);
      // During loop expansion we may see forward references or symbols that are
      // defined later (e.g., variables or labels). Ignore those undefined
      // symbol errors here and let the main assembly pass report them if needed.
      if (!/Undefined symbol/i.test(msg) && !/Location counter '\*' is not available/i.test(msg)) {
        errors.push(`Failed to evaluate expression '${expr}' at ${describeLine(idx)}: ${msg}`);
      }
      return null;
    }
  }

  function tryRecordConstant(trimmed: string, idx: number) {
    const assignMatch = trimmed.match(/^([A-Za-z_@][A-Za-z0-9_@.]*)\s*:??\s*=\s*(.+)$/);
    if (assignMatch) {
      const [, name, rhsRaw] = assignMatch;
      const rhs = rhsRaw.trim();
      const val = evalExpr(rhs, idx);
      if (val !== null && Number.isFinite(val)) constState.set(name, val);
      return;
    }
    const equMatch = trimmed.match(/^([A-Za-z_@][A-Za-z0-9_@.]*)\s*:??\s+EQU\s+(.+)$/i);
    if (equMatch) {
      const [, name, rhsRaw] = equMatch;
      const rhs = rhsRaw.trim();
      const val = evalExpr(rhs, idx);
      if (val !== null && Number.isFinite(val)) constState.set(name, val);
      return;
    }
  }

  function findMatchingEndloop(startIdx: number, limitIdx: number): number {
    let depth = 1;
    for (let i = startIdx; i < limitIdx; i++) {
      const innerTrimmed = stripInlineComment(lines[i]).trim();
      if (!innerTrimmed) continue;
      if (/^\.loop\b/i.test(innerTrimmed)) depth++;
      else if (/^\.endloop\b/i.test(innerTrimmed)) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function processRange(startIdx: number, endIdx: number) {
    let i = startIdx;
    while (i < endIdx) {
      const raw = lines[i];
      const trimmed = stripInlineComment(raw).trim();
      if (!trimmed) {
        outLines.push(raw);
        outOrigins.push(origins[i]);
        i++;
        continue;
      }

      if (/^\.if\b/i.test(trimmed)) {
        const expr = trimmed.replace(/^\.if\b/i, '').trim();
        const parentActive = isActive();
        const condVal = expr.length ? evalExpr(expr, i) : null;
        const truthy = condVal === null ? true : condVal !== 0;
        const frame: IfFrame = { active: parentActive && truthy, anyTrue: truthy, parentActive };
        ifStack.push(frame);
        outLines.push(raw);
        outOrigins.push(origins[i]);
        i++;
        continue;
      }

      if (/^\.elseif\b/i.test(trimmed)) {
        if (!ifStack.length) {
          errors.push(`.elseif without matching .if at ${describeLine(i)}`);
          outLines.push(raw);
          outOrigins.push(origins[i]);
          i++;
          continue;
        }
        const prev = ifStack[ifStack.length - 1]!;
        const parentActive = prev.parentActive;
        const condVal = trimmed.replace(/^\.elseif\b/i, '').trim();
        const evaluated = condVal.length ? evalExpr(condVal, i) : null;
        const truthy = evaluated === null ? true : evaluated !== 0;
        const alreadyTrue = prev.anyTrue;
        prev.active = parentActive && !alreadyTrue && truthy;
        prev.anyTrue = alreadyTrue || truthy;
        outLines.push(raw);
        outOrigins.push(origins[i]);
        i++;
        continue;
      }

      if (/^\.else\b/i.test(trimmed)) {
        if (!ifStack.length) {
          errors.push(`.else without matching .if at ${describeLine(i)}`);
          outLines.push(raw);
          outOrigins.push(origins[i]);
          i++;
          continue;
        }
        const prev = ifStack[ifStack.length - 1]!;
        prev.active = prev.parentActive && !prev.anyTrue;
        prev.anyTrue = true;
        outLines.push(raw);
        outOrigins.push(origins[i]);
        i++;
        continue;
      }

      if (/^\.endif\b/i.test(trimmed)) {
        if (!ifStack.length) {
          errors.push(`.endif without matching .if at ${describeLine(i)}`);
        } else {
          ifStack.pop();
        }
        outLines.push(raw);
        outOrigins.push(origins[i]);
        i++;
        continue;
      }

      if (/^\.loop\b/i.test(trimmed)) {
        if (!isActive()) {
          outLines.push(raw);
          outOrigins.push(origins[i]);
          i++;
          continue;
        }
        if (/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:?[ \t]*\.loop\b/i.test(trimmed)) {
          errors.push(`Labels are not allowed on .loop directives at ${describeLine(i)}`);
        }
        const expr = trimmed.replace(/^\.loop\b/i, '').trim();
        if (!expr.length) {
          errors.push(`Missing loop count for .loop at ${describeLine(i)}`);
        }
        const bodyStart = i + 1;
        const bodyEnd = findMatchingEndloop(bodyStart, endIdx);
        if (bodyEnd === -1) {
          errors.push(`Missing .endloop for .loop at ${describeLine(i)}`);
          return;
        }
        let iterations = 0;
        if (expr.length) {
          const evaluated = evalExpr(expr, i);
          if (evaluated !== null) {
            if (!Number.isFinite(evaluated)) errors.push(`.loop count at ${describeLine(i)} must be finite`);
            else {
              const truncated = Math.trunc(evaluated);
              if (truncated !== evaluated) {
                errors.push(`.loop count at ${describeLine(i)} must be an integer (got ${evaluated})`);
              } else if (truncated < 0) {
                errors.push(`.loop count at ${describeLine(i)} must be non-negative (got ${evaluated})`);
              } else if (truncated > LOOP_MAX_ITERATIONS) {
                errors.push(`.loop count at ${describeLine(i)} exceeds max of ${LOOP_MAX_ITERATIONS}`);
              } else {
                iterations = truncated;
              }
            }
          }
        }
        for (let iter = 0; iter < iterations; iter++) {
          processRange(bodyStart, bodyEnd);
        }
        i = bodyEnd + 1;
        continue;
      }

      if (/^\.endloop\b/i.test(trimmed)) {
        if (!isActive()) {
          outLines.push(raw);
          outOrigins.push(origins[i]);
          i++;
          continue;
        }
        if (/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:?[ \t]*\.endloop\b/i.test(trimmed)) {
          errors.push(`Labels are not allowed on .endloop directives at ${describeLine(i)}`);
        } else {
          errors.push(`.endloop without matching .loop at ${describeLine(i)}`);
        }
        i++;
        continue;
      }

      outLines.push(raw);
      outOrigins.push(origins[i]);
      if (isActive()) {
        tryRecordConstant(trimmed, i);
      }
      i++;
    }
  }

  processRange(0, lines.length);
  return { lines: outLines, origins: outOrigins, errors };
}
