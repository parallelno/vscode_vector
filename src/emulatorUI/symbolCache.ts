import * as fs from 'fs';
import * as path from 'path';
import * as ext_utils from '../extention/utils';
import { coerceAddressList, normalizeFileKey, setNormalizeFileKeyProjectDir } from './breakpoints';
import { parseAddressLike } from './utils';
import { resolveHoverSymbol } from './hover';
import type { DataAddressEntry, DataLineSpan, HoverSymbolInfo } from './hover';

export type SymbolSource = { fileKey: string; line: number };
export type SymbolMeta = { value: number; kind: 'label' | 'const'; source?: SymbolSource };
export type MacroMeta = { kind: 'macro'; source?: SymbolSource; params?: string[] };
export type SymbolCache = {
  byName: Map<string, SymbolMeta>;
  lineAddresses: Map<string, Map<number, number[]>>;
  projectDir?: string;
  filePaths: Map<string, string>;
  macros: Map<string, MacroMeta>;
};

type DataLineCache = Map<string, Map<number, DataLineSpan>>;

const debugPathCache = new Map<string, string | null>();
let lastSymbolCache: SymbolCache | null = null;
let dataLineSpanCache: DataLineCache | null = null;
let dataAddressLookup: Map<number, DataAddressEntry> | null = null;

function resolveProjectDirFromTokens(tokens: any, tokenPath?: string): string | undefined {
  const projectDirRaw = typeof tokens?.projectDir === 'string' ? tokens.projectDir : undefined;
  if (projectDirRaw) {
    if (path.isAbsolute(projectDirRaw)) return path.normalize(projectDirRaw);
    if (tokenPath) return path.resolve(path.dirname(tokenPath), projectDirRaw);
    const workspaceDir = process.cwd();
    return path.normalize(path.resolve(workspaceDir, projectDirRaw));
  }
  const projectFile = typeof tokens?.projectFile === 'string' ? tokens.projectFile : undefined;
  if (projectFile) {
    const resolved = path.isAbsolute(projectFile)
      ? path.normalize(projectFile)
      : tokenPath ? path.resolve(path.dirname(tokenPath), projectFile) : path.resolve(process.cwd(), projectFile);
    return path.dirname(resolved);
  }
  return tokenPath ? path.dirname(tokenPath) : undefined;
}

function resolveTokenFileReference(tokenPath: string | undefined, fileKey: string, projectDir?: string): string {
  if (!fileKey) return fileKey;
  if (path.isAbsolute(fileKey)) return path.normalize(fileKey);
  const baseDir = projectDir || (tokenPath ? path.dirname(tokenPath) : process.cwd());
  return path.normalize(path.resolve(baseDir, fileKey));
}

function clearCaches() {
  lastSymbolCache = null;
  dataLineSpanCache = null;
  dataAddressLookup = null;
  debugPathCache.clear();
  setNormalizeFileKeyProjectDir(undefined);
}

export function clearSymbolMetadataCache() {
  clearCaches();
}

function loadSymbolCacheFromDebugFile(tokenPath: string): boolean {
  try {
    const text = fs.readFileSync(tokenPath, 'utf8');
    const tokens = JSON.parse(text);
    cacheSymbolMetadata(tokens, tokenPath);
    return !!lastSymbolCache;
  } catch (e) {
    return false;
  }
}

function documentCoveredByCurrentCache(documentPath: string): boolean {
  if (!lastSymbolCache) return false;
  const normalizedDoc = ext_utils.normalizeFsPath(documentPath);
  for (const p of lastSymbolCache.filePaths.values()) {
    if (ext_utils.normalizeFsPath(p) === normalizedDoc) return true;
  }
  return false;
}

function rememberDebugPath(documentPath: string, debugPath?: string) {
  const normalizedDoc = ext_utils.normalizeFsPath(documentPath);
  debugPathCache.set(normalizedDoc, debugPath ? path.normalize(debugPath) : null);
}

async function resolveDebugPathForDocument(documentPath: string): Promise<string | undefined> {
  const normalizedDoc = ext_utils.normalizeFsPath(documentPath);
  const cached = debugPathCache.get(normalizedDoc);
  if (cached !== undefined) return cached || undefined;

  const project = await ext_utils.findProjectForAsmFile(documentPath);
  const debugPath = project?.absolute_debug_path;
  if (debugPath && fs.existsSync(debugPath)) {
    rememberDebugPath(documentPath, debugPath);
    return debugPath;
  }
  return undefined;
}

function resolveSymbolSource(symbol: SymbolMeta, filePaths: Map<string, string>): { filePath: string; line: number } | undefined {
  if (!symbol || !symbol.source) return undefined;
  const pathResolved = filePaths.get(symbol.source.fileKey);
  if (!pathResolved) return undefined;
  return { filePath: pathResolved, line: symbol.source.line };
}

export function cacheSymbolMetadata(tokens: any, tokenPath?: string) {
  if (!tokens || typeof tokens !== 'object') {
    clearCaches();
    return;
  }
  const projectDir = resolveProjectDirFromTokens(tokens, tokenPath);

  setNormalizeFileKeyProjectDir(projectDir);
  const byName = new Map<string, SymbolMeta>();
  const filePaths = new Map<string, string>();
  const macros = new Map<string, MacroMeta>();
  const registerFilePath = (fileKey: string, resolvedPath: string) => {
    if (!fileKey || !resolvedPath) return;
    if (!filePaths.has(fileKey)) filePaths.set(fileKey, resolvedPath);
  };
  const registerSymbol = (name: string | undefined, meta: SymbolMeta) => {
    if (!name) return;
    byName.set(name, meta);
  };
  if (tokens.labels && typeof tokens.labels === 'object') {
    for (const [labelName, rawInfo] of Object.entries(tokens.labels as Record<string, any>)) {
      const info: any = rawInfo;
      const addr = parseAddressLike(info?.addr ?? info?.address);
      if (addr === undefined) continue;
      const srcKey = normalizeFileKey(info?.src, projectDir);
      const lineNum = typeof info?.line === 'number' ? info.line : undefined;
      const source: SymbolSource | undefined = (srcKey && lineNum) ? { fileKey: srcKey, line: lineNum } : undefined;
      if (srcKey && info?.src) {
        const resolvedPath = resolveTokenFileReference(tokenPath, info.src, projectDir);
        if (resolvedPath) registerFilePath(srcKey, resolvedPath);
      }
      registerSymbol(labelName, { value: addr, kind: 'label', source });
    }
  }
  if (tokens.consts && typeof tokens.consts === 'object') {
    for (const [constName, rawValue] of Object.entries(tokens.consts as Record<string, any>)) {
      let resolved: number | undefined;
      let source: SymbolSource | undefined;
      if (rawValue && typeof rawValue === 'object') {
        if (typeof rawValue.value === 'number' && Number.isFinite(rawValue.value)) {
          resolved = rawValue.value;
        } else if (rawValue.hex !== undefined) {
          resolved = parseAddressLike(rawValue.hex);
        } else {
          resolved = parseAddressLike(rawValue.value);
        }
        const srcKey = normalizeFileKey(rawValue.src, projectDir);
        const lineNum = typeof rawValue.line === 'number' ? rawValue.line : undefined;
        if (srcKey && lineNum) {
          source = { fileKey: srcKey, line: lineNum };
          if (rawValue.src) {
            const resolvedPath = resolveTokenFileReference(tokenPath, rawValue.src, projectDir);
            if (resolvedPath) registerFilePath(srcKey, resolvedPath);
          }
        }
      } else {
        resolved = parseAddressLike(rawValue);
      }
      if (resolved === undefined) continue;
      registerSymbol(constName, { value: resolved, kind: 'const', source });
    }
  }

  if (tokens.macros && typeof tokens.macros === 'object') {
    for (const [macroName, rawInfo] of Object.entries(tokens.macros as Record<string, any>)) {
      const srcKey = normalizeFileKey((rawInfo as any)?.src, projectDir);
      const lineNum = typeof (rawInfo as any)?.line === 'number' ? (rawInfo as any).line : undefined;
      const params = Array.isArray((rawInfo as any)?.params) ? (rawInfo as any).params as string[] : undefined;
      const source: SymbolSource | undefined = (srcKey && lineNum) ? { fileKey: srcKey, line: lineNum } : undefined;
      if (srcKey && (rawInfo as any)?.src) {
        const resolvedPath = resolveTokenFileReference(tokenPath, (rawInfo as any).src, projectDir);
        if (resolvedPath) registerFilePath(srcKey, resolvedPath);
      }
      const meta: MacroMeta = { kind: 'macro', source, params };
      macros.set(macroName, meta);
      macros.set(macroName.toLowerCase(), meta);
    }
  }

  const lineAddresses = new Map<string, Map<number, number[]>>();
  const dataLines: DataLineCache = new Map();
  const addressLookup = new Map<number, DataAddressEntry>();
  if (tokens.lineAddresses && typeof tokens.lineAddresses === 'object') {
    for (const [fileKeyRaw, entries] of Object.entries(tokens.lineAddresses as Record<string, any>)) {
      if (!entries || typeof entries !== 'object') continue;
      const normalizedKey = normalizeFileKey(fileKeyRaw, projectDir);
      if (!normalizedKey) continue;
      const resolvedPath = resolveTokenFileReference(tokenPath, fileKeyRaw, projectDir);
      if (resolvedPath) registerFilePath(normalizedKey, resolvedPath);
      const perLine = new Map<number, number[]>();
      for (const [lineKey, addrRaw] of Object.entries(entries as Record<string, any>)) {
        const lineNum = Number(lineKey);
        if (!Number.isFinite(lineNum)) continue;
        const addresses = coerceAddressList(addrRaw);
        if (!addresses.length) continue;
        let existing = perLine.get(lineNum);
        if (!existing) {
          perLine.set(lineNum, [...addresses]);
        } else {
          for (const addr of addresses) {
            if (!existing.includes(addr)) existing.push(addr);
          }
        }
      }
      if (perLine.size) {
        lineAddresses.set(normalizedKey, perLine);
      }
    }
  }
  if (tokens.dataLines && typeof tokens.dataLines === 'object') {
    for (const [fileKeyRaw, entries] of Object.entries(tokens.dataLines as Record<string, any>)) {
      if (!entries || typeof entries !== 'object') continue;
      const normalizedKey = normalizeFileKey(fileKeyRaw, projectDir);
      if (!normalizedKey) continue;
      const resolvedPath = resolveTokenFileReference(tokenPath, fileKeyRaw, projectDir);
      if (resolvedPath) registerFilePath(normalizedKey, resolvedPath);
      let perLine = dataLines.get(normalizedKey);
      if (!perLine) {
        perLine = new Map();
        dataLines.set(normalizedKey, perLine);
      }
      for (const [lineKey, rawSpan] of Object.entries(entries as Record<string, any>)) {
        const start = parseAddressLike((rawSpan as any)?.addr ?? (rawSpan as any)?.start ?? rawSpan);
        const byteLength = Number((rawSpan as any)?.byteLength ?? (rawSpan as any)?.length ?? 0);
        const unitBytes = Number((rawSpan as any)?.unitBytes ?? (rawSpan as any)?.unit ?? 1);
        const lineNum = Number(lineKey);
        if (start === undefined || !Number.isFinite(lineNum) || byteLength <= 0) continue;
        const span: DataLineSpan = {
          start: start & 0xffff,
          byteLength,
          unitBytes: unitBytes > 0 ? unitBytes : 1
        };
        perLine.set(lineNum, span);
        for (let offset = 0; offset < span.byteLength; offset++) {
          const addr = (span.start + offset) & 0xffff;
          if (!addressLookup.has(addr)) {
            addressLookup.set(addr, { fileKey: normalizedKey, line: lineNum, span });
          }
        }
      }
    }
  }

  lastSymbolCache = { byName, lineAddresses, filePaths, macros, projectDir };
  dataLineSpanCache = dataLines.size ? dataLines : null;
  dataAddressLookup = addressLookup.size ? addressLookup : null;
}

export function getSymbolCache(): SymbolCache | null {
  return lastSymbolCache;
}

export function getDataLineSpanCache(): DataLineCache | null {
  return dataLineSpanCache;
}

export function getDataAddressLookup(): Map<number, DataAddressEntry> | null {
  return dataAddressLookup;
}

export async function ensureSymbolCacheForDocument(documentPath?: string): Promise<boolean> {
  if (!documentPath) return false;

  if (lastSymbolCache && documentCoveredByCurrentCache(documentPath)) return true;
  if (lastSymbolCache) clearCaches();

  const debugPath = await resolveDebugPathForDocument(documentPath);
  if (debugPath && loadSymbolCacheFromDebugFile(debugPath)) return true;
  return !!lastSymbolCache;
}

export function resolveSymbolDefinition(identifier: string): { filePath: string; line: number } | undefined {
  if (!lastSymbolCache) return undefined;
  const token = (identifier || '').trim();
  if (!token) return undefined;
  const symbol = lastSymbolCache.byName.get(token);
  if (symbol) {
    return resolveSymbolSource(symbol, lastSymbolCache.filePaths);
  }

  const macro = lastSymbolCache.macros.get(token);
  if (macro && macro.source) {
    const pathResolved = lastSymbolCache.filePaths.get(macro.source.fileKey);
    if (pathResolved) {
      return { filePath: pathResolved, line: macro.source.line };
    }
  }
  return undefined;
}

export function resolveEmulatorHoverSymbol(identifier: string, location?: { filePath?: string; line?: number }): HoverSymbolInfo | undefined {
  return resolveHoverSymbol(identifier, location, lastSymbolCache);
}

export function setDebugPathForDocument(documentPath: string, debugPath: string | undefined) {
  rememberDebugPath(documentPath, debugPath);
}

// Utilities exposed for breakpoint/token loaders
export function loadSymbolCacheFromPath(tokenPath: string): boolean {
  return loadSymbolCacheFromDebugFile(tokenPath);
}

export function getProjectDirFromTokens(tokens: any, tokenPath?: string): string | undefined {
  return resolveProjectDirFromTokens(tokens, tokenPath);
}

export function resolveSymbolSourcePath(symbol: SymbolMeta, filePaths: Map<string, string>): { filePath: string; line: number } | undefined {
  return resolveSymbolSource(symbol, filePaths);
}
