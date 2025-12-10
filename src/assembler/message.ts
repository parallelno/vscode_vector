import { ExpressionEvalContext } from './types';
import { splitTopLevelArgs, parseStringLiteral } from './utils';
import { evaluateConditionExpression } from './expression';

export function evaluateMessageArguments(
  directive: '.print' | '.error',
  argsText: string,
  ctx: ExpressionEvalContext,
  originDesc: string
): { output: string; errors: string[] } {
  const parts = argsText.trim().length ? splitTopLevelArgs(argsText) : [];
  const fragments: string[] = [];
  const errors: string[] = [];

  for (const partRaw of parts) {
    const part = partRaw.trim();
    if (!part.length) continue;
    try {
      const literal = parseStringLiteral(part);
      if (literal !== null) {
        fragments.push(literal);
        continue;
      }
    } catch (err: any) {
      errors.push(`Invalid string literal in ${directive} at ${originDesc}: ${err?.message || err}`);
      break;
    }

    try {
      const value = evaluateConditionExpression(part, ctx, true);
      fragments.push(String(value));
    } catch (err: any) {
      errors.push(`Failed to evaluate ${directive} expression '${part}' at ${originDesc}: ${err?.message || err}`);
      break;
    }
  }

  return { output: fragments.join(' '), errors };
}
