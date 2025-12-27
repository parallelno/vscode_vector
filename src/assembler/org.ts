import { argsAfterToken } from './common';
import { parseNumberFull, describeOrigin } from './utils';
import { LocalLabelScopeIndex, SourceOrigin } from './types';
import { resolveScopedConst } from './labels';

export function handleOrgFirstPass(params: {
  line: string;
  tokens: string[];
  tokenOffsets: number[];
  lineIndex: number;
  origin: SourceOrigin | undefined;
  sourcePath: string | undefined;
  scopes: string[];
  localsIndex: LocalLabelScopeIndex;
  labels: Map<string, { addr: number; line: number; src?: string }>;
  pendingDirectiveLabel: string | null;
  makeScopeKey: (orig?: SourceOrigin) => string;
  registerLabel: (name: string, address: number, origin: SourceOrigin | undefined, fallbackLine: number, scopeKey: string) => void;
  errors: string[];
  addr: number;
  originDesc: string;
}): { handled: boolean; addr: number; pendingDirectiveLabel: string | null } {
  const {
    line,
    tokens,
    tokenOffsets,
    lineIndex,
    origin,
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
  } = params;

  const rest = argsAfterToken(line, tokens[0], tokenOffsets[0]);
  const aTok = rest.trim().split(/\s+/)[0];
  const org = origin;
  let val: number | null = null;
  const num = parseNumberFull(aTok);
  if (num !== null) val = num & 0xffff;
  else if (aTok && aTok[0] === '@') {
    // try to resolve local label in current scope
    const scopeKey = makeScopeKey(org);
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
  if (val === null) {
    errors.push(`Bad ORG address '${aTok}' at ${originDesc}`);
    return { handled: true, addr, pendingDirectiveLabel };
  }

  const nextAddr = val;
  let nextPending = pendingDirectiveLabel;
  // .org defines a new (narrower) scope region for subsequent labels
  if (pendingDirectiveLabel) {
    const newScope = makeScopeKey(org);
    const fallbackLine = org && typeof org.line === 'number' ? org.line : lineIndex;
    registerLabel(pendingDirectiveLabel, nextAddr, org, fallbackLine, newScope);
    nextPending = null;
  }

  return { handled: true, addr: nextAddr, pendingDirectiveLabel: nextPending };
}

export function handleOrgSecondPass(params: {
  line: string;
  tokens: string[];
  tokenOffsets: number[];
  labels: Map<string, { addr: number; line: number; src?: string }>;
  consts: Map<string, number>;
  errors: string[];
  addr: number;
  lineIndex: number;
  origins: SourceOrigin[];
  sourcePath: string | undefined;
  scopes: string[];
  map: Record<number, number>;
}): { handled: boolean; addr: number } {
  const { line, tokens, tokenOffsets, labels, consts, errors, addr: currentAddr, lineIndex, origins, sourcePath, scopes, map } = params;
  const scopeKey = lineIndex > 0 && lineIndex - 1 < scopes.length ? scopes[lineIndex - 1] : undefined;
  const originDesc = describeOrigin(origins[lineIndex - 1], lineIndex, sourcePath);
  const rest = argsAfterToken(line, tokens[0], tokenOffsets[0]);
  const aTok = rest.trim().split(/\s+/)[0];
  const val = parseNumberFull(aTok);
  if (val === null) {
    const parsed = parseNumberFull(aTok);
    const addrVal = parsed ?? null;
    if (addrVal === null) {
      const labelVal = labels.has(aTok) ? labels.get(aTok)!.addr : null;
      const constVal = resolveScopedConst(aTok, consts, scopeKey);
      const constResolved = constVal !== undefined ? constVal : null;
      const resolved = labelVal !== null ? labelVal : constResolved;
      if (resolved === null) {
        errors.push(`Bad ORG address '${aTok}' at ${originDesc}`);
        return { handled: true, addr: currentAddr };
      }
      map[lineIndex] = resolved & 0xffff;
      return { handled: true, addr: resolved & 0xffff };
    }
  }
  const finalVal = val !== null ? val & 0xffff : parseNumberFull(aTok);
  if (finalVal === null) {
    errors.push(`Bad ORG address '${aTok}' at ${originDesc}`);
    return { handled: true, addr: currentAddr };
  }
  map[lineIndex] = finalVal & 0xffff;
  return { handled: true, addr: finalVal & 0xffff };
}
