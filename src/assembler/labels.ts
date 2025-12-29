import * as path from 'path';
import { LocalLabelScopeIndex, SourceOrigin } from './types';

export type LabelInfo = {
  addr: number;
  line: number;
  src?: string;
};

export function registerLabel(
  name: string,
  address: number,
  origin: SourceOrigin | undefined,
  fallbackLine: number,
  scopeKey: string,
  labels: Map<string, LabelInfo>,
  localsIndex: LocalLabelScopeIndex,
  globalLocalCounters: Map<string, number>,
  errors: string[],
  sourcePath?: string
): void {
  if (!name) return;

  const srcName = origin && origin.file
    ? path.basename(origin.file)
    : (sourcePath ? path.basename(sourcePath) : undefined);

  if (name[0] === '@') {
    // Local label
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
    labels.set(key, { addr: address, line: origin ? origin.line : fallbackLine, src: srcName });
  } else {
    // Global label
    if (labels.has(name)) {
      const prev = labels.get(name)!;
      errors.push(`Duplicate label '${name}' at ${fallbackLine} (previously at ${prev.line})`);
    } else {
      labels.set(name, { addr: address, line: origin ? origin.line : fallbackLine, src: srcName });
    }
  }
}

export function getFileKey(orig: SourceOrigin | undefined, sourcePath?: string): string {
  return (orig && orig.file) ? path.resolve(orig.file) : (sourcePath ? path.resolve(sourcePath) : '<memory>');
}

export function getScopeKey(
  orig: SourceOrigin | undefined,
  sourcePath: string | undefined,
  globalScopeId: number,
  macroScopeOverride?: string
): string {
  const fileForScope = orig?.macroInstance?.callerFile || orig?.file;
  const fileKey = fileForScope ? path.resolve(fileForScope) : getFileKey(orig, sourcePath);
  const macroScope = macroScopeOverride ?? orig?.macroScope;
  let key = `${fileKey}::${globalScopeId}`;
  if (macroScope) key += `::${macroScope}`;
  return key;
}

// Extract the macro scope portion from a scope key, if present
export function extractMacroScope(scopeKey?: string): string | undefined {
  if (!scopeKey) return undefined;
  const parts = scopeKey.split('::');
  return parts.length >= 3 ? parts.slice(2).join('::') : undefined;
}

// Split a composite macro scope (outer::inner::nested) into a search list from
// most specific to least specific: ['outer::inner::nested', 'outer::inner', 'outer'].
export function expandMacroScopeChain(macroScope?: string): string[] {
  if (!macroScope) return [];
  const parts = macroScope.split('::');
  const chain: string[] = [];
  for (let i = parts.length; i >= 1; i--) {
    chain.push(parts.slice(0, i).join('::'));
  }
  return chain;
}

// Build a unique name for a symbol that should be confined to a macro scope
export function formatMacroScopedName(name: string, macroScope?: string): string {
  return macroScope ? `${macroScope}::${name}` : name;
}

// Resolve a constant value while respecting macro scoping rules (supports nested macro scope chains)
export function resolveScopedConst(
  name: string,
  consts: Map<string, number>,
  scopeKey?: string,
  macroScopeOverride?: string
): number | undefined {
  const macroScope = macroScopeOverride ?? extractMacroScope(scopeKey);
  const scopeChain = expandMacroScopeChain(macroScope);
  const candidateKeys = scopeChain.map((scope) => formatMacroScopedName(name, scope));
  if (consts.has(name)) candidateKeys.push(name);

  for (const key of candidateKeys) {
    if (consts.has(key)) return consts.get(key);
    const lower = key.toLowerCase();
    for (const [k, v] of consts) {
      if (k.toLowerCase() === lower) return v;
    }
  }

  // Fallback: allow matching any scoped symbol whose trailing component matches
  // the requested name. This covers cases where scope information was lost but
  // the macro-scoped constant still exists (e.g., HL_ADVANCE_X::diff_addr).
  const targetLower = name.toLowerCase();
  for (const [k, v] of consts) {
    const parts = k.split('::');
    const tail = parts[parts.length - 1];
    if (tail && tail.toLowerCase() === targetLower) return v;
  }

  return undefined;
}

// Resolve the concrete key for a local label by picking the nearest definition
// in the current scope: prefer the most recent definition at or before the
// reference line; if none exists, fall back to the first definition after it.
export function resolveLocalLabelKey(
  localName: string,
  lineIndex: number,
  scopes: string[],
  localsIndex: LocalLabelScopeIndex,
  referenceLine?: number
): string | null {
  if (!localName || localName[0] !== '@') return null;
  if (lineIndex <= 0 || lineIndex - 1 >= scopes.length) return null;
  const scopeKey = scopes[lineIndex - 1];
  const fileKey = scopeKey.split('::')[0];

  const tryResolve = (arr?: { key: string; line: number }[] | null) => {
    if (!arr || !arr.length) return null;
    const refLine = referenceLine ?? lineIndex;
    let prev: typeof arr[0] | null = null;
    let next: typeof arr[0] | null = null;
    for (const entry of arr) {
      if ((entry.line || 0) <= refLine) {
        prev = entry;
        continue;
      }
      next = entry;
      break;
    }
    const chosen = prev ?? next;
    return chosen ? chosen.key : null;
  };

  // First, attempt within the current scope
  const fileMap = localsIndex.get(scopeKey);
  const scopedKey = tryResolve(fileMap ? fileMap.get(localName.slice(1)) : null);
  if (scopedKey) return scopedKey;

  // Fallback: scan other scopes from the same file (covers cases where a scope
  // boundary was misaligned but the file-level local should still resolve).
  for (const [key, map] of localsIndex.entries()) {
    if (!key.startsWith(fileKey)) continue;
    const altKey = tryResolve(map.get(localName.slice(1)) || null);
    if (altKey) return altKey;
  }

  return null;
}
