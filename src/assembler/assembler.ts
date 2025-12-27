import * as path from 'path';
import {
  AssembleResult,
  ExpressionEvalContext,
  IfFrame,
  LocalLabelScopeIndex,
  PrintMessage,
  SourceOrigin } from './types';
import {
  stripInlineComment,
  parseNumberFull,
  describeOrigin
} from './utils';

import { evaluateExpression } from './expression';
import { prepareMacros, expandMacroInvocations } from './macro';
import { expandLoopDirectives } from './loops';
import { applyOptionalBlocks } from './optional';
import { processIncludes } from './includes';
import { registerLabel as registerLabelHelper, getScopeKey, formatMacroScopedName, resolveScopedConst } from './labels';
import { isAddressDirective, checkLabelOnDirective, tokenize } from './common';
import { handleDB, handleDW, handleDD, handleStorage, DataContext } from './data';
import {
  handleIfDirective,
  handleEndifDirective,
  handlePrintDirective,
  handleErrorDirective,
  handleEncodingDirective,
  handleTextDirective,
  DirectiveContext
} from './directives';
import { handleIncbinFirstPass,
  handleIncbinSecondPass,
  IncbinContext } from './incbin';
import {
  InstructionContext
} from './instructions';
import { AssemblyEvalState,
  evaluateExpressionValue,
  processVariableAssignment } from './pass_helpers';
import { createAssembleAndWrite } from './assemble_write';
import { AlignDirectiveEntry, handleAlignFirstPass, handleAlignSecondPass } from './align';
import { handleOrgFirstPass, handleOrgSecondPass } from './org';
import { INSTR_SIZES } from './first_pass_instr';
import { INSTR_OPCODES, instructionEncoding } from './second_pass_instr';

export function assemble(
  source: string,
  sourcePath?: string,
  projectFile?: string)
  : AssembleResult
{
  let expanded: { lines: string[]; origins: SourceOrigin[] };

  try {
    expanded = processIncludes(source, sourcePath, sourcePath, projectFile, 0);
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

  const loopExpanded = expandLoopDirectives(macroExpanded.lines, macroExpanded.origins, sourcePath);
  if (loopExpanded.errors.length) {
    return { success: false, errors: loopExpanded.errors, origins: loopExpanded.origins };
  }
  const optionalResult = applyOptionalBlocks(loopExpanded.lines, loopExpanded.origins);
  if (optionalResult.errors.length) {
    return { success: false, errors: optionalResult.errors, origins: optionalResult.origins };
  }

  const lines = optionalResult.lines;
  const origins = optionalResult.origins;
  const originLines = origins.map((o) => o?.line);
  const labels = new Map<string, { addr: number; line: number; src?: string }>();
  const consts = new Map<string, number>();
  const constOrigins = new Map<string, { line: number; src?: string }>();
  const pendingConsts: Array<{
    name: string;
    rhs: string;
    line: number;
    origin: SourceOrigin | undefined;
    originDesc: string;
    locationCounter?: number;
    lastError?: string }> = [];
  // Track which identifiers are variables (can be reassigned)
  const variables = new Set<string>();
  // localsIndex: scopeKey -> (localName -> array of { key, line }) ordered by appearance
  const localsIndex: LocalLabelScopeIndex = new Map();
  // global numeric id counters per local name to ensure exported keys are unique
  const globalLocalCounters = new Map<string, number>();
  const scopes: string[] = new Array(lines.length);
  const alignDirectives: Array<AlignDirectiveEntry | undefined> = new Array(lines.length);
  let directiveCounter = 0;

  // Initialize the current address counter to 0
  let addr = 0;
  const errors: string[] = [];
  const warnings: string[] = [];
  const printMessages: PrintMessage[] = [];
  const ifStack: IfFrame[] = [];

  // Directive and data helpers share these contexts to mutate shared state
  const directiveCtx: DirectiveContext = {
    labels,
    consts,
    variables,
    errors,
    warnings,
    printMessages,
    textEncoding: 'ascii',
    textCase: 'mixed',
    localsIndex,
    scopes
  };
  const dataCtx: DataContext = {
    labels,
    consts,
    localsIndex,
    scopes,
    errors
  };
  const incbinCtx: IncbinContext = { labels, consts, localsIndex, scopes, errors, projectFile };

  const evalState: AssemblyEvalState = { labels, consts, localsIndex, scopes, originLines };

  function allocateLocalKey(name: string, origin: SourceOrigin | undefined, fallbackLine: number, scopeKey: string): string {
    const localName = name.slice(1);
    let fileMap = localsIndex.get(scopeKey);
    if (!fileMap) {
      fileMap = new Map();
      localsIndex.set(scopeKey, fileMap);
    }

    let arr = fileMap.get(localName);
    if (!arr) {
      arr = [];
      fileMap.set(localName, arr);
    }

    const gid = globalLocalCounters.get(localName) || 0;
    globalLocalCounters.set(localName, gid + 1);
    const key = '@' + localName + '_' + gid;
    arr.push({ key, line: origin ? origin.line : fallbackLine });
    return key;
  }

  function tryEvaluateConstant(rhs: string, lineIndex: number, origin?: SourceOrigin, locationCounter?: number): { value: number | null; error?: string } {
    let val: number | null = parseNumberFull(rhs);
    if (val === null) {
      const scopeKey = lineIndex > 0 && lineIndex - 1 < scopes.length ? scopes[lineIndex - 1] : undefined;
      const scoped = resolveScopedConst(rhs, consts, scopeKey, origin?.macroScope);
      if (scoped !== undefined) {
        val = scoped;
      } else if (labels.has(rhs)) {
        val = labels.get(rhs)!.addr;
      }
    }

    if (val === null) {
      const ctx: ExpressionEvalContext = {
        labels,
        consts,
        localsIndex,
        scopes,
        lineIndex,
        macroScope: origin?.macroScope,
        locationCounter
      };
      try {
        val = evaluateExpression(rhs, ctx, true);
      } catch (err: any) {
        return { value: null, error: err?.message || String(err) };
      }
    }

    return { value: val };
  }

  function resolvePendingConstants(): void {
    let madeProgress = true;
    while (pendingConsts.length && madeProgress) {
      madeProgress = false;
      for (let idx = pendingConsts.length - 1; idx >= 0; idx--) {
        const pending = pendingConsts[idx];
        const result = tryEvaluateConstant(pending.rhs, pending.line, pending.origin, pending.locationCounter);
        if (result.value !== null) {
          consts.set(pending.name, result.value);
          constOrigins.set(pending.name, { line: pending.line, src: pending.origin?.file || sourcePath });
          pendingConsts.splice(idx, 1);
          madeProgress = true;
        } else {
          pending.lastError = result.error;
        }
      }
    }

    if (pendingConsts.length) {
      for (const pending of pendingConsts) {
        const detail = pending.lastError ? `: ${pending.lastError}` : '';
        errors.push(`Failed to resolve constant '${pending.name}' at ${pending.originDesc}${detail} (expression: ${pending.rhs})`);
      }
    }
  }

  // Helper to register a label using the imported function
  function registerLabel(
    name: string, address: number, origin: SourceOrigin | undefined,
    fallbackLine: number, scopeKey: string)
  {
    registerLabelHelper(name, address, origin, fallbackLine, scopeKey,
                        labels, localsIndex, globalLocalCounters, errors,
                        sourcePath);
  }

  // Helper to create scope key
  function makeScopeKey(orig?: SourceOrigin): string {
    return getScopeKey(orig, sourcePath, directiveCounter);
  }

  function scopedConstName(name: string, origin: SourceOrigin | undefined): string {
    return formatMacroScopedName(name, origin?.macroScope);
  }


  //////////////////////////////////////////////////////////////////////////////
  //
  // First pass: labels and address calculation
  //
  //////////////////////////////////////////////////////////////////////////////

  for (let i = 0; i < lines.length; i++)
  {
    const raw = lines[i];
    const line = stripInlineComment(raw).trim();
    if (!line) continue;

    directiveCtx.locationCounter = addr;
    dataCtx.locationCounter = addr;
    incbinCtx.locationCounter = addr;
    directiveCtx.currentMacroScope = origins[i]?.macroScope;
    directiveCtx.currentOriginLine = origins[i]?.line;

    // Update directive counter and scope key when file changes
    if (i > 0) {
      const prev = origins[i - 1];
      const curr = origins[i];
      const prevKey = prev && prev.file ? path.resolve(prev.file) : (sourcePath ? path.resolve(sourcePath) : '<memory>');
      const currKey = curr && curr.file ? path.resolve(curr.file) : (sourcePath ? path.resolve(sourcePath) : '<memory>');
      if (prevKey !== currKey) {
        directiveCounter++;
      }
    }

    scopes[i] = makeScopeKey(origins[i]);
    const originDesc = describeOrigin(origins[i], i + 1, sourcePath);

    // Check for labels on directives that don't allow them
    if (checkLabelOnDirective(line, 'if')) {
      errors.push(`Labels are not allowed on .if directives at ${originDesc}`);
      continue;
    }
    if (checkLabelOnDirective(line, 'endif')) {
      errors.push(`Labels are not allowed on .endif directives at ${originDesc}`);
      continue;
    }
    if (checkLabelOnDirective(line, 'print')) {
      errors.push(`Labels are not allowed on .print directives at ${originDesc}`);
      continue;
    }
    if (checkLabelOnDirective(line, 'error')) {
      errors.push(`Labels are not allowed on .error directives at ${originDesc}`);
      continue;
    }

    // Handle .endif directive
    if (handleEndifDirective(line, origins[i], i + 1, sourcePath, ifStack, directiveCtx)) {
      continue;
    }

    // Handle .if directive
    if (handleIfDirective(line, origins[i], i + 1, sourcePath, ifStack, directiveCtx)) {
      continue;
    }

    const blockActive = ifStack.length === 0 ? true : ifStack[ifStack.length - 1].effective;
    if (!blockActive) continue;

    // Skip .print and .error directives in first pass
    if (/^\.print\b/i.test(line)) {
      continue;
    }
    if (/^\.error\b/i.test(line)) {
      continue;
    }

    if (/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:\s*[A-Za-z_][A-Za-z0-9_]*\s+\.var\b/i.test(line)) {
      errors.push(`Labels are not allowed on .var directives at ${originDesc}`);
      continue;
    }

    // .var directive: "NAME .var InitialValue" (label optional)
    const varMatch = line.match(/^([A-Za-z_@][A-Za-z0-9_@.]*)\s*:?[\t ]+\.var\b(.*)$/i);
    if (varMatch) {
      const rawName = varMatch[1];
      const rhs = (varMatch[2] || '').trim();
      if (!rhs.length) {
        errors.push(`Missing initial value for .var ${rawName} at ${i + 1}`);
        continue;
      }

      const isLocal = rawName.startsWith('@');
      const scopeKey = scopes[i];
      const storeName = isLocal ? allocateLocalKey(rawName, origins[i], i + 1, scopeKey) : scopedConstName(rawName, origins[i]);

      const result = tryEvaluateConstant(rhs, i + 1, origins[i], addr);
      if (result.value === null) {
        const detail = result.error ? `: ${result.error}` : '';
        errors.push(`Bad initial value '${rhs}' for .var ${rawName} at ${originDesc}${detail}`);
      } else {
        consts.set(storeName, result.value);
        constOrigins.set(storeName, { line: i + 1, src: origins[i]?.file || sourcePath });
        variables.add(rawName);
        variables.add(storeName); // Track scoped name to avoid reassignment warnings
      }
      continue;
    }

    const tokenized = tokenize(line);
    const tokens = tokenized.tokens;
    const tokenOffsets = tokenized.offsets;
    if (!tokens.length) continue;
    let pendingDirectiveLabel: string | null = null;

    // simple constant / EQU handling: "NAME = expr" or "NAME EQU expr"
    if (tokens.length >= 3 && (tokens[1] === '=' || tokens[1].toUpperCase() === 'EQU')) {
      const rawName = tokens[0].endsWith(':') ? tokens[0].slice(0, -1) : tokens[0];
      // Skip variable assignments in first pass (they'll be processed in second pass)
      if (variables.has(rawName)) {
        continue;
      }
      const rhs = tokens.slice(2).join(' ').trim();

      const isLocal = rawName.startsWith('@');
      const scopeKey = scopes[i];
      const storeName = isLocal ? allocateLocalKey(rawName, origins[i], i + 1, scopeKey) : scopedConstName(rawName, origins[i]);

      // Disallow reassignment for globals before attempting resolution
      if (!isLocal && consts.has(storeName) && !variables.has(storeName)) {
        errors.push(`Cannot reassign constant '${rawName}' at ${i + 1} (use .var to create a variable instead)`);
        continue;
      }

      const result = tryEvaluateConstant(rhs, i + 1, origins[i], addr);
      if (result.value !== null) {
        consts.set(storeName, result.value);
        constOrigins.set(storeName, { line: i + 1, src: origins[i]?.file || sourcePath });
      } else {
        pendingConsts.push({ name: storeName, rhs, line: i + 1, origin: origins[i], originDesc, locationCounter: addr });
      }
      continue;
    }
    const assignMatch = line.match(/^([A-Za-z_@][A-Za-z0-9_@.]*)\s*:?\s*=\s*(.+)$/);
    if (assignMatch) {
      const rawName = assignMatch[1];
      // Skip variable assignments in first pass
      if (variables.has(rawName)) {
        continue;
      }

      const isLocal = rawName.startsWith('@');
      const scopeKey = scopes[i];
      const storeName = isLocal ? allocateLocalKey(rawName, origins[i], i + 1, scopeKey) : scopedConstName(rawName, origins[i]);

      if (!isLocal && consts.has(storeName) && !variables.has(storeName)) {
        errors.push(`Cannot reassign constant '${rawName}' at ${i + 1} (use .var to create a variable instead)`);
        continue;
      }

      const rhs = assignMatch[2].trim();
      const result = tryEvaluateConstant(rhs, i + 1, origins[i], addr);
      if (result.value !== null) {
        consts.set(storeName, result.value);
        constOrigins.set(storeName, { line: i + 1, src: origins[i]?.file || sourcePath });
      } else {
        pendingConsts.push({ name: storeName, rhs, line: i + 1, origin: origins[i], originDesc, locationCounter: addr });
      }
      continue;
    }
    const equMatch = line.match(/^([A-Za-z_@][A-Za-z0-9_@.]*)\s*:?\s+EQU\s+(.+)$/i);
    if (equMatch) {
      const rawName = equMatch[1];
      // Skip variable assignments in first pass
      if (variables.has(rawName)) {
        continue;
      }

      const isLocal = rawName.startsWith('@');
      const scopeKey = scopes[i];
      const storeName = isLocal ? allocateLocalKey(rawName, origins[i], i + 1, scopeKey) : scopedConstName(rawName, origins[i]);

      if (!isLocal && consts.has(storeName) && !variables.has(storeName)) {
        errors.push(`Cannot reassign constant '${rawName}' at ${i + 1} (use .var to create a variable instead)`);
        continue;
      }

      const rhs = equMatch[2].trim();
      const result = tryEvaluateConstant(rhs, i + 1, origins[i], addr);
      if (result.value !== null) {
        consts.set(storeName, result.value);
        constOrigins.set(storeName, { line: i + 1, src: origins[i]?.file || sourcePath });
      } else {
        pendingConsts.push({ name: storeName, rhs, line: i + 1, origin: origins[i], originDesc, locationCounter: addr });
      }
      continue;
    }

    // Handle label definitions
    if (tokens[0].endsWith(':')) {
      const candidate = tokens[0].slice(0, -1);
      tokens.shift();
      tokenOffsets.shift();
      const nextToken = tokens.length ? tokens[0] : '';
      if (isAddressDirective(nextToken)) {
        pendingDirectiveLabel = candidate;
      } else {
        registerLabel(candidate, addr, origins[i], i + 1, scopes[i]);
      }
      if (!tokens.length) {
        continue;
      }
    } else if (tokens.length >= 2 && isAddressDirective(tokens[1])) {
      pendingDirectiveLabel = tokens[0];
      tokens.shift();
      tokenOffsets.shift();
    }

    const op = tokens[0].toUpperCase();

    if (op === 'DB' || op === '.BYTE') {
      addr += handleDB(line, tokens, tokenOffsets, i + 1, origins[i], sourcePath, dataCtx, undefined, { defer: true });
      continue;
    }

    if (op === 'DW' || op === '.WORD') {
      addr += handleDW(line, tokens, tokenOffsets, i + 1, origins[i], sourcePath, dataCtx, undefined, { defer: true });
      continue;
    }

    if (op === 'DD' || op === '.DWORD') {
      addr += handleDD(line, tokens, tokenOffsets, i + 1, origins[i], sourcePath, dataCtx, undefined, { defer: true });
      continue;
    }

    if (op === '.STORAGE' || op === '.DS') {
      const { size } = handleStorage(line, tokens, tokenOffsets, i + 1, origins[i], sourcePath, dataCtx);
      addr += size;
      continue;
    }

    if (op === '.ENCODING'){
      handleEncodingDirective(line, origins[i], i + 1, sourcePath, directiveCtx, tokenOffsets, tokens)
      continue;
    }

    if (op === '.TEXT') {
      addr += handleTextDirective(line, origins[i], i + 1, sourcePath, directiveCtx, tokenOffsets, tokens);
      continue;
    }

    if (op === '.INCBIN') {
      addr += handleIncbinFirstPass(line, tokens, tokenOffsets, i + 1, origins[i], sourcePath, incbinCtx);
      continue;
    }

    if (op === '.ORG' || op === 'ORG') {
      const result = handleOrgFirstPass({
        line,
        tokens,
        tokenOffsets,
        lineIndex: i + 1,
        origin: origins[i],
        sourcePath,
        scopes,
        localsIndex,
        labels,
        pendingDirectiveLabel,
        makeScopeKey,
        registerLabel,
        errors,
        addr,
        originDesc
      });
      directiveCounter++;
      addr = result.addr;
      pendingDirectiveLabel = result.pendingDirectiveLabel;
      continue;
    }

    if (op === '.ALIGN' || op === 'ALIGN') {
      const result = handleAlignFirstPass({
        line,
        tokens,
        tokenOffsets,
        lineIndex: i + 1,
        directiveIndex: i,
        origin: origins[i],
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
      });
      addr = result.addr;
      pendingDirectiveLabel = result.pendingDirectiveLabel;
      continue;
    }

    // Instruction size lookup
    if (INSTR_SIZES.hasOwnProperty(op)) {
      addr += INSTR_SIZES[op];
      continue;
    }

    // unknown -> error with source context
    const sourceLine = (lines[i] || '').trim();
    errors.push(`Unknown or unsupported opcode '${op}' at ${describeOrigin(origins[i], i + 1, sourcePath)}: ${sourceLine}`);
  }

  // Check for any unclosed .if directives and report errors
  if (ifStack.length) {
    for (let idx = ifStack.length - 1; idx >= 0; idx--) {
      const frame = ifStack[idx];
      errors.push(`Missing .endif for .if at ${describeOrigin(frame.origin, frame.lineIndex, sourcePath)}`);
    }
  }

  // Resolve any constants that referenced yet-to-be-defined symbols during the first pass
  resolvePendingConstants();

  if (errors.length) return { success: false, errors, origins };




  //////////////////////////////////////////////////////////////////////////////
  //
  // Second pass: generate bytes and source-line map
  //
  //////////////////////////////////////////////////////////////////////////////

  addr = 0;
  const out: number[] = [];
  const map: Record<number, number> = {};
  const dataLineSpans: Array<{ start: number; byteLength: number; unitBytes: number } | undefined> = new Array(lines.length);
  const directiveCtxSecond: DirectiveContext = {
    labels,
    consts,
    variables,
    errors,
    warnings,
    printMessages,
    textEncoding: 'ascii',
    textCase: 'mixed',
    localsIndex,
    scopes
  };
  const dataCtxSecond: DataContext = { labels, consts, localsIndex, scopes, errors };
  const incbinCtxSecond: IncbinContext = { labels, consts, localsIndex, scopes, errors, projectFile };
  const instrCtx: InstructionContext = { labels, consts, localsIndex, scopes, errors, originLines };

  const ifStackSecond: IfFrame[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const srcLine = i + 1;
    const line = stripInlineComment(raw).trim();
    if (!line) continue;

    directiveCtxSecond.locationCounter = addr;
    dataCtxSecond.locationCounter = addr;
    incbinCtxSecond.locationCounter = addr;
    instrCtx.locationCounter = addr;
    directiveCtxSecond.currentMacroScope = origins[i]?.macroScope;
    directiveCtxSecond.currentOriginLine = origins[i]?.line;

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
    const labelPrintMatch = line.match(/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:?\s*\.print\b/i);
    if (labelPrintMatch && line[0] !== '.') {
      errors.push(`Labels are not allowed on .print directives at ${originDesc}`);
      continue;
    }
    const labelErrorMatch = line.match(/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:?\s*\.error\b/i);
    if (labelErrorMatch && line[0] !== '.') {
      errors.push(`Labels are not allowed on .error directives at ${originDesc}`);
      continue;
    }
    const labelVarMatch = line.match(/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:\s*[A-Za-z_][A-Za-z0-9_]*\s+\.var\b/i);
    if (labelVarMatch) {
      errors.push(`Labels are not allowed on .var directives at ${originDesc}`);
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
      const ctx: ExpressionEvalContext = {
        labels,
        consts,
        localsIndex,
        scopes,
        lineIndex: srcLine,
        locationCounter: addr,
        macroScope: origins[i]?.macroScope,
        originLine: origins[i]?.line
      };
      let conditionResult = false;
      if (!parentActive) {
        try {
          evaluateExpression(expr, ctx, false);
        } catch (err: any) {
          errors.push(`Failed to parse .if expression at ${originDesc}: ${err?.message || err}`);
        }
      } else {
        try {
          const value = evaluateExpression(expr, ctx, true);
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

    if (handlePrintDirective(line, origins[i], srcLine, sourcePath, directiveCtxSecond)) {
      map[srcLine] = addr;
      continue;
    }

    if (handleErrorDirective(line, origins[i], srcLine, sourcePath, directiveCtxSecond)) {
      map[srcLine] = addr;
      return { success: false, errors, origins };
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*:$/.test(line)) continue; // label only

    // Skip .var directive in second pass (already processed in first pass)
    if (/^[A-Za-z_@][A-Za-z0-9_@.]*\s*:?\s+\.var\b/i.test(line)) {
      continue;
    }

    const tokenizedSecond = tokenize(line);
    const tokens = tokenizedSecond.tokens;
    const tokenOffsets = tokenizedSecond.offsets;
    let leadingLabel: string | null = null;
    if (!tokens.length) continue;
    if (tokens[0].endsWith(':')) {
      leadingLabel = tokens[0].slice(0, -1);
      tokens.shift();
      tokenOffsets.shift();
      if (!tokens.length) { map[srcLine] = addr; continue; }
    } else if (tokens.length >= 2 && /^\.?org$/i.test(tokens[1])) {
      tokens.shift();
      tokenOffsets.shift();
    }

    if (leadingLabel && tokens.length >= 2 && tokens[1].toUpperCase() === '.VAR') {
      errors.push(`Labels are not allowed on .var directives at ${originDesc}`);
      continue;
    }

    map[srcLine] = addr;
    const lineStartAddr = addr;

    // Process variable assignments in second pass, but skip constant assignments
    if (tokens.length >= 3 && (tokens[1] === '=' || tokens[1].toUpperCase() === 'EQU')) {
      const name = leadingLabel ?? tokens[0];
      if (variables.has(name)) {
        const rhs = tokens.slice(2).join(' ').trim();
        processVariableAssignment(name, rhs, srcLine, originDesc, evalState, errors, lineStartAddr);
      }
      continue;
    }
    if (leadingLabel && tokens.length >= 1 && (tokens[0] === '=' || tokens[0].toUpperCase() === 'EQU')) {
      const name = leadingLabel;
      if (variables.has(name)) {
        const rhs = tokens.slice(1).join(' ').trim();
        processVariableAssignment(name, rhs, srcLine, originDesc, evalState, errors, lineStartAddr);
      }
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*:?\s*=/.test(line) || /^[A-Za-z_][A-Za-z0-9_]*\s*:?\s+EQU\b/i.test(line)) {
      const assignMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:?\s*(?:=|EQU)\s*(.+)$/i);
      if (assignMatch) {
        const name = assignMatch[1];
        if (variables.has(name)) {
          const rhs = assignMatch[2].trim();
          processVariableAssignment(name, rhs, srcLine, originDesc, evalState, errors, lineStartAddr);
        }
      }
      continue;
    }

    const op = tokens[0].toUpperCase();

    if (op === 'DB' || op === '.BYTE') {
      const emitted = handleDB(line, tokens, tokenOffsets, srcLine, origins[i], sourcePath, dataCtxSecond, out);
      if (emitted > 0) {
        dataLineSpans[i] = { start: lineStartAddr, byteLength: emitted, unitBytes: 1 };
      }
      addr += emitted;
      continue;
    }

    if (op === 'DW' || op === '.WORD') {
      const emitted = handleDW(line, tokens, tokenOffsets, srcLine, origins[i], sourcePath, dataCtxSecond, out);
      if (emitted > 0) {
        dataLineSpans[i] = { start: lineStartAddr, byteLength: emitted, unitBytes: 2 };
      }
      addr += emitted;
      continue;
    }

    if (op === 'DD' || op === '.DWORD') {
      const emitted = handleDD(line, tokens, tokenOffsets, srcLine, origins[i], sourcePath, dataCtxSecond, out);
      if (emitted > 0) {
        dataLineSpans[i] = { start: lineStartAddr, byteLength: emitted, unitBytes: 4 };
      }
      addr += emitted;
      continue;
    }

    if (op === '.STORAGE' || op === '.DS') {
      const { size, filled } = handleStorage(line, tokens, tokenOffsets, srcLine, origins[i], sourcePath, dataCtxSecond, out);
      if (filled && size > 0) {
        dataLineSpans[i] = { start: lineStartAddr, byteLength: size, unitBytes: 1 };
      }
      addr += size;
      continue;
    }

    if (op === '.ORG' || op === 'ORG') {
      const result = handleOrgSecondPass({
        line,
        tokens,
        tokenOffsets,
        labels,
        consts,
        errors,
        addr,
        lineIndex: srcLine,
        origins,
        sourcePath,
        scopes,
        map
      });
      addr = result.addr;
      if (result.handled) continue;
    }

    if (op === '.ALIGN' || op === 'ALIGN') {
      const result = handleAlignSecondPass({ directive: alignDirectives[i], addr, out });
      addr = result.addr;
      if (result.handled) continue;
    }

    if (op === '.ENCODING'){
      handleEncodingDirective(line, origins[i], srcLine, sourcePath, directiveCtxSecond, tokenOffsets, tokens);
      continue;
    }

    const textAddrRef = { value: addr };

    if (op === '.TEXT') {
      addr = handleTextDirective(
        line,
        origins[i],
        srcLine,
        sourcePath,
        directiveCtxSecond,
        tokenOffsets,
        tokens,
        out,
        textAddrRef
      );
      continue;
    }

    if (op === '.INCBIN') {
      const emitted = handleIncbinSecondPass(line, tokens, tokenOffsets, srcLine, origins[i], sourcePath, incbinCtxSecond, out);
      addr += emitted;
      continue;
    }

    // Instruction encoding
    if (INSTR_OPCODES.hasOwnProperty(op) === true) {
      const emitted = instructionEncoding(tokens, srcLine, origins[i], instrCtx, out);
      addr += emitted;
      continue;
    }

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
  const constsOut: Record<string, number> = {};
  for (const [k, v] of consts) constsOut[k] = v;
  const constOriginsOut: Record<string, { line: number; src?: string }> = {};
  for (const [k, v] of constOrigins) constOriginsOut[k] = v;
  const dataSpanOut: Record<number, { start: number; byteLength: number; unitBytes: number }> = {};
  for (let idx = 0; idx < dataLineSpans.length; idx++) {
    const span = dataLineSpans[idx];
    if (!span) continue;
    dataSpanOut[idx + 1] = span;
  }

  return {
    success: true,
    output: Buffer.from(out),
    map,
    labels: labelsOut,
    consts: constsOut,
    constOrigins: constOriginsOut,
    dataLineSpans: dataSpanOut,
    warnings,
    printMessages,
    origins };
}


// convenience when using from extension (no bound project file)
export const assembleAndWrite = createAssembleAndWrite(assemble);

// helper to bind a specific project file for include resolution
export function assembleAndWriteWithProject(projectFile?: string) {
  return createAssembleAndWrite(assemble, projectFile);
}
