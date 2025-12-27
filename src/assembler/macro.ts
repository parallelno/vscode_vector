import { MacroDefinition, MacroParam, SourceOrigin } from './types';
import {
  stripInlineComment,
  splitTopLevelArgs,
  substituteIdentifiers,
  escapeRegExp,
  detectNormalLabelName,
  describeOrigin
} from './utils';

const MAX_MACRO_DEPTH = 32;

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

export function prepareMacros(lines: string[], origins: SourceOrigin[], sourcePath?: string) {
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
    let raw = pi < args.length ? args[pi] : undefined;
    if (raw === undefined || raw === '') {
      if (param.defaultValue !== undefined) {
        raw = substituteIdentifiers(param.defaultValue, values);
      } else {
        errors.push(`Macro '${macroName}' requires value for parameter '${param.name}' at ${describeOrigin(origin, undefined, sourcePath)}`);
        return { kind: 'error' };
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
      text = substituteMacroParams(text, replacements);
    }
    if (call.definition.normalLabels.size) {
      text = substituteIdentifiers(text, labelReplacements);
    }
    const macroScope = origin.macroScope ? `${origin.macroScope}::${call.scopeName}` : call.scopeName;
    out.push({
      line: text,
      origin: {
        file: entry.origin.file,
        line: entry.origin.line,
        macroScope,
        macroInstance: {
          name: call.definition.name,
          ordinal: call.ordinal,
          callerFile: origin.file,
          callerLine: origin.line,
          callerMacro: origin.macroInstance
        }
      }
    });
  }
  return out;
}

// Replace macro parameters while wrapping expressions used with < or >
function substituteMacroParams(source: string, replacements: Record<string, string>): string {
  let output = source;
  for (const [token, value] of Object.entries(replacements)) {
    const pattern = new RegExp(`(?:(<|>)[\t ]*)?\\b${escapeRegExp(token)}\\b`, 'g');
    output = output.replace(pattern, (_match, prefix: string | undefined) => {
      const trimmed = value.trim();
      if (prefix) {
        return `${prefix}(${trimmed})`;
      }
      const needsWrap = /[+\-*/%&|^<>\s]/.test(trimmed) && !(trimmed.startsWith('(') && trimmed.endsWith(')'));
      return needsWrap ? `(${trimmed})` : trimmed;
    });
  }
  return output;
}

export function expandMacroInvocations(
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
