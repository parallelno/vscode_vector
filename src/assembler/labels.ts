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
  directiveCounter: number
): string {
  let key = getFileKey(orig, sourcePath) + '::' + directiveCounter;
  if (orig?.macroScope) key += `::${orig.macroScope}`;
  return key;
}
