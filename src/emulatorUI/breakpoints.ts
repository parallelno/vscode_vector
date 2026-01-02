import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Hardware } from '../emulator/hardware';
import { HardwareReq } from '../emulator/hardware_reqs';
import { BpStatus } from '../emulator/breakpoint';
import { parseAddressLike } from './utils';
import { DEBUG_FILE_SUFFIX } from '../extention/consts';

export type SourceLineRef = { file: string; line: number };
export type BreakpointMeta = { enabled?: boolean };

let currentProjectDirForKeys: string | undefined;

export function setNormalizeFileKeyProjectDir(projectDir?: string): void {
  currentProjectDirForKeys = projectDir ? path.normalize(projectDir) : undefined;
}

export function normalizeFileKey(filePath?: string, projectDir?: string): string | undefined {
  if (!filePath) return undefined;
  const baseDir = projectDir ?? currentProjectDirForKeys;
  const normalizedInput = path.normalize(filePath);
  if (baseDir) {
    const absolute = path.isAbsolute(normalizedInput) ? normalizedInput : path.resolve(baseDir, normalizedInput);
    const relative = path.relative(baseDir, absolute).replace(/\\/g, '/').toLowerCase();
    if (relative) return relative;
  }
  const lowered = normalizedInput.replace(/\\/g, '/').toLowerCase();
  const baseOnly = path.basename(normalizedInput).toLowerCase();
  if (baseOnly && baseOnly !== lowered) return baseOnly;
  return lowered;
}

export function formatFileLineKey(fileKey: string, line: number): string {
  return `${fileKey}#${line}`;
}

export function coerceAddressList(value: any): number[] {
  const result: number[] = [];
  const push = (raw: any) => {
    const parsed = parseAddressLike(raw);
    if (parsed === undefined) return;
    const normalized = parsed & 0xffff;
    if (!result.includes(normalized)) result.push(normalized);
  };
  if (Array.isArray(value)) {
    for (const entry of value) push(entry);
  } else {
    push(value);
  }
  return result;
}

export function deriveTokenPath(romPath: string, debugPath?: string): string {
  if (debugPath) return debugPath;
  if (!romPath) return '';
  if (/\.[^/.]+$/.test(romPath)) return romPath.replace(/\.[^/.]+$/, DEBUG_FILE_SUFFIX);
  return romPath + DEBUG_FILE_SUFFIX;
}

function deriveProjectDirFromTokens(tokens: any, tokenPath?: string): string | undefined {
  const dirRaw = typeof tokens?.projectDir === 'string' ? tokens.projectDir : undefined;
  if (dirRaw) {
    if (path.isAbsolute(dirRaw)) return path.normalize(dirRaw);
    if (tokenPath) return path.resolve(path.dirname(tokenPath), dirRaw);
    const workspaceDir = process.cwd();
    return path.normalize(path.resolve(workspaceDir, dirRaw));
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

export function collectBreakpointAddresses(tokens: any, projectDir?: string): Map<number, BreakpointMeta> {
  const resolved = new Map<number, BreakpointMeta>();
  if (!tokens || typeof tokens !== 'object') return resolved;

  const labelAddrByName = new Map<string, number>();
  const lineAddrByFileLine = new Map<string, number[]>();

  if (tokens.labels && typeof tokens.labels === 'object') {
    for (const [labelName, rawInfo] of Object.entries(tokens.labels)) {
      const info = rawInfo as any;
      const addr = parseAddressLike(info?.addr ?? info?.address);
      if (addr === undefined) continue;
      labelAddrByName.set(labelName, addr);
      const srcBase = normalizeFileKey(typeof info?.src === 'string' ? info.src : undefined, projectDir);
      const lineNum = typeof info?.line === 'number' ? info.line : undefined;
      if (srcBase && lineNum !== undefined) {
        lineAddrByFileLine.set(formatFileLineKey(srcBase, lineNum), [addr & 0xffff]);
      }
    }
  }

  if (tokens.lineAddresses && typeof tokens.lineAddresses === 'object') {
    for (const [fileKeyRaw, entries] of Object.entries(tokens.lineAddresses)) {
      if (!entries || typeof entries !== 'object') continue;
      const normalizedFileKey = typeof fileKeyRaw === 'string' ? normalizeFileKey(fileKeyRaw, projectDir) : undefined;
      if (!normalizedFileKey) continue;
      for (const [lineKey, addrRaw] of Object.entries(entries as Record<string, any>)) {
        const lineNum = Number(lineKey);
        if (!Number.isFinite(lineNum)) continue;
        const addresses = coerceAddressList(addrRaw);
        if (!addresses.length) continue;
        lineAddrByFileLine.set(formatFileLineKey(normalizedFileKey, lineNum), addresses);
      }
    }
  }

  const registerBreakpoint = (addr: number | undefined, enabled: boolean | undefined) => {
    if (addr === undefined) return;
    const normalized = addr & 0xffff;
    if (!resolved.has(normalized)) {
      resolved.set(normalized, { enabled });
      return;
    }
    if (enabled !== undefined) resolved.set(normalized, { enabled });
  };

  const resolveEnabled = (entry: any): boolean | undefined => {
    if (!entry || typeof entry !== 'object') return undefined;
    if (typeof entry.enabled === 'boolean') return entry.enabled;
    if (typeof entry.status === 'number') return entry.status !== 0;
    return undefined;
  };

  const resolveAddresses = (entry: any, fileKey?: string): number[] => {
    const results: number[] = [];
    const pushAddr = (addr: number | undefined) => {
      if (addr === undefined) return;
      const normalized = addr & 0xffff;
      if (!results.includes(normalized)) results.push(normalized);
    };
    if (!entry || typeof entry !== 'object') {
      pushAddr(parseAddressLike(entry));
      return results;
    }
    const direct = coerceAddressList(entry.addr ?? entry.address);
    for (const addr of direct) pushAddr(addr);
    if (!results.length && typeof entry.label === 'string') {
      pushAddr(labelAddrByName.get(entry.label));
    }
    if (fileKey && typeof entry.line === 'number') {
      const fromLine = lineAddrByFileLine.get(formatFileLineKey(fileKey, entry.line));
      if (fromLine) {
        for (const addr of fromLine) pushAddr(addr);
      }
    }
    return results;
  };

  const processEntry = (entry: any, fileKey?: string) => {
    const normalizedFile = fileKey ? normalizeFileKey(fileKey, projectDir) : undefined;
    const addresses = resolveAddresses(entry, normalizedFile);
    if (!addresses.length) return;
    const enabled = resolveEnabled(entry);
    for (const addr of addresses) {
      registerBreakpoint(addr, enabled);
    }
  };

  const bpData = tokens.breakpoints;
  if (Array.isArray(bpData)) {
    for (const entry of bpData) processEntry(entry);
  } else if (bpData && typeof bpData === 'object') {
    for (const [fileKey, entries] of Object.entries(bpData)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) processEntry(entry, fileKey);
    }
  }

  return resolved;
}

function mapHardwareAddrToEditorLocation(addr: number, lastAddressSourceMap: Map<number, SourceLineRef> | null): { uri: vscode.Uri; range: vscode.Range } | undefined {
  if (!lastAddressSourceMap) return undefined;
  const ref = lastAddressSourceMap.get(addr & 0xffff);
  if (!ref) return undefined;
  const uri = vscode.Uri.file(ref.file);
  const lineIdx = Math.max(ref.line - 1, 0);
  const range = new vscode.Range(lineIdx, 0, lineIdx, 0);
  return { uri, range };
}

export function buildSourceBreakpointsFromHardware(hardware: Hardware | undefined | null, lastAddressSourceMap: Map<number, SourceLineRef> | null): vscode.SourceBreakpoint[] {
  if (!hardware) return [];
  let data: any;
  try {
    data = hardware.Request(HardwareReq.DEBUG_BREAKPOINT_GET_ALL)?.data;
  } catch (err) {
    return [];
  }

  if (!Array.isArray(data)) return [];

  const result: vscode.SourceBreakpoint[] = [];
  for (const entry of data) {
    const addr = typeof entry?.addr === 'number' ? entry.addr : undefined;
    if (addr === undefined) continue;
    const loc = mapHardwareAddrToEditorLocation(addr, lastAddressSourceMap);
    if (!loc) continue;
    const enabled = (entry?.status ?? BpStatus.ACTIVE) !== BpStatus.DISABLED;
    const isAutoDel = entry?.autoDel === true;
    const rawComment = typeof entry?.comment === 'string' ? entry.comment.trim() : '';
    const label = isAutoDel
      ? `[autodel]${rawComment ? ' ' + rawComment : ''}`
      : undefined;

    if (label) {
      result.push(new vscode.SourceBreakpoint(
        new vscode.Location(loc.uri, loc.range),
        enabled,
        undefined,
        undefined,
        label));
    } else {
      result.push(new vscode.SourceBreakpoint(new vscode.Location(loc.uri, loc.range), enabled));
    }
  }
  return result;
}

export function syncEditorBreakpointsFromHardware(hardware: Hardware | undefined | null, lastAddressSourceMap: Map<number, SourceLineRef> | null): void {
  const target = buildSourceBreakpointsFromHardware(hardware, lastAddressSourceMap);
  if (!target) return;

  const targetFiles = new Set(target.map(bp => bp.location.uri.fsPath));
  const existing = vscode.debug.breakpoints.filter(bp => bp instanceof vscode.SourceBreakpoint) as vscode.SourceBreakpoint[];
  const toRemove = existing.filter(bp => targetFiles.has(bp.location.uri.fsPath));

  if (toRemove.length) {
    vscode.debug.removeBreakpoints(toRemove);
  }
  if (target.length) {
    vscode.debug.addBreakpoints(target);
  }
}

export function buildAddressToSourceMap(tokens: any, tokenPath: string, projectDir?: string): Map<number, SourceLineRef> | null {
  if (!tokens || typeof tokens !== 'object') return null;
  const map = new Map<number, SourceLineRef>();
  const linesByFile = tokens.lineAddresses;
  if (!linesByFile || typeof linesByFile !== 'object') return map;
  const normalizedEntries = new Map<string, Record<string, any>>();
  for (const [rawKey, perLine] of Object.entries(linesByFile as Record<string, Record<string, any>>)) {
    if (!perLine || typeof perLine !== 'object') continue;
    if (typeof rawKey !== 'string' || !rawKey.includes('.')) continue;
    normalizedEntries.set(rawKey, perLine);
  }
  if (!normalizedEntries.size) return map;
  const baseDir = projectDir || (tokenPath ? path.dirname(tokenPath) : '');
  for (const [fileKey, perLine] of normalizedEntries.entries()) {
    if (!perLine || typeof perLine !== 'object') continue;
    const resolvedPath = path.isAbsolute(fileKey) ? path.normalize(fileKey) : path.resolve(baseDir, fileKey);
    for (const [lineKey, addrRaw] of Object.entries(perLine)) {
      const lineNum = Number(lineKey);
      if (!Number.isFinite(lineNum)) continue;
      const addresses = coerceAddressList(addrRaw);
      if (!addresses.length) continue;
      for (const addr of addresses) {
        map.set(addr & 0xffff, { file: resolvedPath, line: lineNum });
      }
    }
  }
  const dataLines = tokens?.dataLines;
  if (dataLines && typeof dataLines === 'object') {
    for (const [fileKeyRaw, entries] of Object.entries(dataLines as Record<string, any>)) {
      if (!entries || typeof entries !== 'object') continue;
      const resolvedPath = path.isAbsolute(fileKeyRaw) ? path.normalize(fileKeyRaw) : path.resolve(baseDir, fileKeyRaw);
      for (const [lineKey, rawSpan] of Object.entries(entries as Record<string, any>)) {
        const start = parseAddressLike((rawSpan as any)?.addr ?? (rawSpan as any)?.start ?? rawSpan);
        const lineNum = Number(lineKey);
        if (start === undefined || !Number.isFinite(lineNum)) continue;
        map.set(start & 0xffff, { file: resolvedPath, line: lineNum });
      }
    }
  }
  return map;
}

export function loadBreakpointsFromToken(
  romPath: string,
  hardware: Hardware | undefined | null,
  options: {
    log?: vscode.OutputChannel;
    debugPath?: string;
    cacheSymbolMetadata: (tokens: any, tokenPath: string) => void;
    clearSymbolMetadataCache: () => void;
  }): { applied: number; addressSourceMap: Map<number, SourceLineRef> | null }
{
  options.clearSymbolMetadataCache();
  if (!hardware || !romPath) return { applied: 0, addressSourceMap: null };
  const tokenPath = deriveTokenPath(romPath, options.debugPath);
  if (!tokenPath || !fs.existsSync(tokenPath)) return { applied: 0, addressSourceMap: null };

  let tokens: any;
  try {
    tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    options.cacheSymbolMetadata(tokens, tokenPath);
  } catch (err) {
    try { options.log?.appendLine(`Failed to parse token file ${tokenPath}: ${err}`); } catch (e) {}
    return { applied: 0, addressSourceMap: null };
  }

  const projectDir = deriveProjectDirFromTokens(tokens, tokenPath);
  setNormalizeFileKeyProjectDir(projectDir);

  const addressSourceMap = buildAddressToSourceMap(tokens, tokenPath, projectDir);
  const desired = collectBreakpointAddresses(tokens, projectDir);

  hardware.Request(HardwareReq.DEBUG_BREAKPOINT_DEL_ALL);

  if (desired.size === 0) {
    try {
      options.log?.appendLine(`Deleted all breakpoints from ${path.basename(tokenPath)}`);
    } catch (e) {}
    return { applied: 0, addressSourceMap };
  }

  for (const [addr, meta] of desired) {
    const status: BpStatus = (meta.enabled === false) ? BpStatus.DISABLED : BpStatus.ACTIVE;
    hardware.Request(HardwareReq.DEBUG_BREAKPOINT_ADD, { addr: addr, status: status });
  }

  try {
    options.log?.appendLine(`Loaded ${desired.size} breakpoint${desired.size === 1 ? '' : 's'} from ${path.basename(tokenPath)}`);
  } catch (e) {}
  return { applied: desired.size, addressSourceMap };
}
