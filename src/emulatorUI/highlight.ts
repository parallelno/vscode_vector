import * as vscode from 'vscode';
import * as path from 'path';
import { Hardware } from '../emulator/hardware';
import { HardwareReq } from '../emulator/hardware_reqs';
import { MemoryAccessLog } from '../emulator/debugger';
import { SourceLineRef, normalizeFileKey } from './breakpoints';
import * as consts from './consts';
import { DataAddressEntry, extractDataDirectiveInfo, formatHexByte, formatInstructionHoverText } from './hover';
import { getDebugLine } from './debugOutput';

let highlightContext: vscode.ExtensionContext | null = null;
let pausedLineDecoration: vscode.TextEditorDecorationType | null = null;
let unmappedAddressDecoration: vscode.TextEditorDecorationType | null = null;
let lastHighlightedEditor: vscode.TextEditor | null = null;
let lastHighlightedLine: number | null = null;
let lastHighlightedFilePath: string | null = null;
let lastHighlightDecoration: vscode.DecorationOptions | null = null;
let lastHighlightIsUnmapped = false;

let dataReadDecoration: vscode.TextEditorDecorationType | null = null;
let dataWriteDecoration: vscode.TextEditorDecorationType | null = null;
let lastDataAccessLog: MemoryAccessLog | null = null;

export function setHighlightContext(context: vscode.ExtensionContext | null): void {
  highlightContext = context;
}

function ensureHighlightDecoration(context: vscode.ExtensionContext) {
  if (!pausedLineDecoration) {
    pausedLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(129, 127, 38, 0.45)',
      overviewRulerColor: 'rgba(200, 200, 175, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Full
    });
    context.subscriptions.push(pausedLineDecoration);
  }
  if (!unmappedAddressDecoration) {
    unmappedAddressDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(200, 180, 0, 0.35)',
      overviewRulerColor: 'rgba(255, 220, 100, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Full
    });
    context.subscriptions.push(unmappedAddressDecoration);
  }
}

export function clearHighlightedSourceLine(): void {
  if (lastHighlightedEditor) {
    try {
      if (pausedLineDecoration) {
        lastHighlightedEditor.setDecorations(pausedLineDecoration, []);
      }
      if (unmappedAddressDecoration) {
        lastHighlightedEditor.setDecorations(unmappedAddressDecoration, []);
      }
    } catch (e) { /* ignore decoration clearing errors */ }
  }
  lastHighlightedEditor = null;
  lastHighlightedLine = null;
  lastHighlightedFilePath = null;
  lastHighlightDecoration = null;
  lastHighlightIsUnmapped = false;
}

export function reapplyExecutionHighlight(isToolbarRunning: boolean): void {
  if (!lastHighlightedFilePath || !lastHighlightDecoration || isToolbarRunning) {
    return;
  }
  if (!highlightContext) return;

  const editor = vscode.window.visibleTextEditors.find(
    (ed: vscode.TextEditor) => ed.document.uri.fsPath === lastHighlightedFilePath
  );

  if (!editor) {
    return;
  }

  const decorationType = lastHighlightIsUnmapped
    ? unmappedAddressDecoration
    : pausedLineDecoration;

  if (!decorationType) {
    return;
  }

  try {
    editor.setDecorations(decorationType, [lastHighlightDecoration]);
    lastHighlightedEditor = editor;
  } catch (e) {
    /* ignore decoration reapply errors */
  }
}

function isSkippableHighlightLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith(';') || trimmed.startsWith('//')) return true;
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx >= 0) {
    const before = trimmed.slice(0, colonIdx).trim();
    const after = trimmed.slice(colonIdx + 1).trim();
    if (/^[A-Za-z_.$@?][\w.$@?]*$/.test(before) && (!after || after.startsWith(';') || after.startsWith('//'))) {
      return true;
    }
  }
  const equMatch = trimmed.match(/^([A-Za-z_.$@?][\w.$@?]*)\s+(equ)\b/i);
  if (equMatch && !trimmed.includes(':')) return true;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx > 0) {
    const lhs = trimmed.slice(0, eqIdx).trim();
    const rhs = trimmed.slice(eqIdx + 1).trim();
    if (/^[A-Za-z_.$@?][\w.$@?]*$/.test(lhs) && rhs && !rhs.startsWith(';') && !trimmed.includes(':')) {
      return true;
    }
  }
  return false;
}

function resolvePreferredHighlightLine(
  filePath: string,
  addr: number,
  lineAddresses: Map<string, Map<number, number[]>> | null | undefined,
  doc?: vscode.TextDocument): number | undefined
{
  if (!lineAddresses || lineAddresses.size === 0) return undefined;
  const fileKey = normalizeFileKey(filePath);
  if (!fileKey) return undefined;
  const perLine = lineAddresses.get(fileKey);
  if (!perLine || perLine.size === 0) return undefined;
  const normalizedAddr = addr & 0xffff;
  const candidates: number[] = [];
  for (const [lineNumber, lineAddrs] of perLine.entries()) {
    for (const lineAddr of lineAddrs) {
      if ((lineAddr & 0xffff) === normalizedAddr) {
        candidates.push(lineNumber);
        break;
      }
    }
  }
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => b - a);
  if (doc) {
    for (const lineNumber of candidates) {
      const idx = lineNumber - 1;
      if (idx < 0 || idx >= doc.lineCount) continue;
      const text = doc.lineAt(idx).text;
      if (!isSkippableHighlightLine(text)) {
        return lineNumber;
      }
    }
  }
  return candidates[0];
}

function disassembleInstructionAt(hardware: Hardware | undefined | null, addr: number)
: string | undefined
{
  if (!hardware) return undefined;

  const instr = hardware.Request(HardwareReq.GET_INSTR, { "addr": addr })['data'] as number[];
  const opcode = instr.shift() ?? 0;
  const bytes = instr;

  const listing = bytes.map(formatHexByte).join(' ');
  const display = formatInstructionHoverText(opcode, bytes, '');
  return `${display} (bytes: ${listing})`;
}

function highlightSourceAddress(
  hardware: Hardware | undefined | null,
  addressSourceMap: Map<number, SourceLineRef> | null,
  addr?: number,
  debugLine?: string,
  lineAddresses?: Map<string, Map<number, number[]>> | null)
{
  if (!highlightContext || addr === undefined || addr === null) return;
  ensureHighlightDecoration(highlightContext);

  const normalizedAddr = addr & 0xffff;

  if (!addressSourceMap || addressSourceMap.size === 0) {
    clearHighlightedSourceLine();
    return;
  }

  const info = addressSourceMap.get(normalizedAddr);

  if (!info) {
    const editorToUse = lastHighlightedEditor;
    const lineToUse = lastHighlightedLine;
    clearHighlightedSourceLine();

    if (editorToUse && unmappedAddressDecoration && lineToUse !== null) {
      try {
        const doc = editorToUse.document;
        const idx = Math.min(Math.max(lineToUse, 0), doc.lineCount - 1);
        const lineText = doc.lineAt(idx).text;
        const range = new vscode.Range(idx, 0, idx, Math.max(lineText.length, 1));
        const addrHex = '0x' + normalizedAddr.toString(16).toUpperCase().padStart(4, '0');
        const disasm = disassembleInstructionAt(hardware, normalizedAddr);
        const disasmText = disasm ? ` - executing ${disasm}` : ' - executing unmapped code';
        const decoration: vscode.DecorationOptions = {
          range,
          renderOptions: {
            after: {
              contentText: `  No source mapping for address ${addrHex}${disasmText}`,
              color: consts.UNMAPPED_ADDRESS_COLOR,
              fontStyle: 'italic',
              fontWeight: 'normal'
            }
          }
        };
        editorToUse.setDecorations(unmappedAddressDecoration, [decoration]);
        lastHighlightedEditor = editorToUse;
        lastHighlightedLine = idx;
        lastHighlightedFilePath = doc.uri.fsPath;
        lastHighlightDecoration = decoration;
        lastHighlightIsUnmapped = true;
      } catch (err) {
        /* ignore unmapped decoration errors */
      }
    }
    return;
  }

  if (!pausedLineDecoration) return;

  const targetPath = path.resolve(info.file);
  const run = async () => {
    try {
      const uri = vscode.Uri.file(targetPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      let editor = vscode.window.visibleTextEditors.find((ed) => ed.document.uri.fsPath === uri.fsPath);
      if (!editor) {
        const existing = vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({ tab, viewColumn: group.viewColumn })))
          .find(entry => entry.tab.input && (entry.tab.input as any).uri && (entry.tab.input as any).uri.fsPath === uri.fsPath);
        if (existing && existing.viewColumn !== undefined) {
          editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: existing.viewColumn, preserveFocus: false });
        }
      }
      if (!editor) {
        editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
      }
      const preferredLine = resolvePreferredHighlightLine(targetPath, normalizedAddr, lineAddresses, doc) ?? info.line;
      const totalLines = doc.lineCount;
      if (totalLines === 0) return;
      const idx = Math.min(Math.max(preferredLine - 1, 0), totalLines - 1);
      const lineText = doc.lineAt(idx).text;
      const range = new vscode.Range(idx, 0, idx, Math.max(lineText.length, 1));
      const decoration: vscode.DecorationOptions = {
        range,
        renderOptions: debugLine ? {
          after: {
            contentText: '  ' + debugLine,
            color: '#b4ffb0',
            fontStyle: 'normal',
            fontWeight: 'normal'
          }
        } : undefined
      };
      clearHighlightedSourceLine();
      editor.setDecorations(pausedLineDecoration!, [decoration]);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      lastHighlightedEditor = editor;
      lastHighlightedLine = idx;
      lastHighlightedFilePath = targetPath;
      lastHighlightDecoration = decoration;
      lastHighlightIsUnmapped = false;
    } catch (err) {
      /* ignore highlight errors */
    }
  };
  void run();
}

export function highlightSourceFromHardware(
  hardware: Hardware | undefined | null,
  addressSourceMap: Map<number, SourceLineRef> | null,
  lineAddresses: Map<string, Map<number, number[]>> | null | undefined)
: void
{
  if (!hardware || !highlightContext) return;
  try {
    const pc = hardware?.Request(HardwareReq.GET_REG_PC)['pc'] ?? 0;
    const debugLine = getDebugLine(hardware);
    highlightSourceAddress(hardware, addressSourceMap, pc, debugLine, lineAddresses);
  } catch (e) {
    /* ignore highlight errors */
  }
}

function ensureDataHighlightDecorations(context: vscode.ExtensionContext) {
  if (!dataReadDecoration) {
    dataReadDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: false,
      backgroundColor: 'rgba(64, 127, 255, 0.25)'
    });
    context.subscriptions.push(dataReadDecoration);
  }
  if (!dataWriteDecoration) {
    dataWriteDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: false,
      backgroundColor: 'rgba(255, 92, 92, 0.25)'
    });
    context.subscriptions.push(dataWriteDecoration);
  }
}

function normalizeFsPathSafe(value: string): string {
  try {
    return path.resolve(value).replace(/\\/g, '/').toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function buildElementRanges(elements: Map<number, Set<number>>, doc: vscode.TextDocument): vscode.Range[] {
  const ranges: vscode.Range[] = [];
  for (const [line, elementIndices] of elements) {
    const lineIdx = line - 1;
    if (!Number.isFinite(lineIdx) || lineIdx < 0 || lineIdx >= doc.lineCount) continue;
    const lineText = doc.lineAt(lineIdx).text;
    const directiveInfo = extractDataDirectiveInfo(lineText);
    if (!directiveInfo || !directiveInfo.ranges.length) continue;
    for (const elemIdx of elementIndices) {
      if (elemIdx < 0 || elemIdx >= directiveInfo.ranges.length) continue;
      const tokenRange = directiveInfo.ranges[elemIdx];
      ranges.push(new vscode.Range(lineIdx, tokenRange.start, lineIdx, tokenRange.end));
    }
  }
  return ranges;
}

export function applyDataLineHighlightsFromSnapshot(
  snapshot: MemoryAccessLog | undefined,
  dataAddressLookup: Map<number, DataAddressEntry> | null,
  filePaths: Map<string, string> | null | undefined)
: void
{
  if (!highlightContext) return;
  ensureDataHighlightDecorations(highlightContext);
  if (!snapshot || !dataAddressLookup || !filePaths || !filePaths.size) {
    clearDataLineHighlights();
    lastDataAccessLog = null;
    return;
  }
  lastDataAccessLog = snapshot;

  const accumulate = (addr: number, bucket: Map<string, Map<number, Set<number>>>) => {
    const entry = dataAddressLookup?.get(addr & 0xffff);
    if (!entry) return;
    const resolvedPath = filePaths?.get(entry.fileKey);
    if (!resolvedPath) return;
    const key = normalizeFsPathSafe(resolvedPath);
    const byteOffset = (addr & 0xffff) - entry.span.start;
    const unitBytes = entry.span.unitBytes > 0 ? entry.span.unitBytes : 1;
    if (byteOffset < 0 || byteOffset >= entry.span.byteLength) return;
    const elementIndex = Math.floor(byteOffset / unitBytes);
    let lineMap = bucket.get(key);
    if (!lineMap) {
      lineMap = new Map();
      bucket.set(key, lineMap);
    }
    let elemSet = lineMap.get(entry.line);
    if (!elemSet) {
      elemSet = new Set();
      lineMap.set(entry.line, elemSet);
    }
    elemSet.add(elementIndex);
  };

  const readElements = new Map<string, Map<number, Set<number>>>();
  const writeElements = new Map<string, Map<number, Set<number>>>();
  snapshot.reads.forEach((value, addr) => accumulate(addr, readElements));
  snapshot.writes.forEach((value, addr) => accumulate(addr, writeElements));

  for (const editor of vscode.window.visibleTextEditors) {
    const key = normalizeFsPathSafe(editor.document.uri.fsPath);
    const readMap = readElements.get(key);
    const writeMap = writeElements.get(key);
    if (dataReadDecoration) editor.setDecorations(dataReadDecoration, readMap ? buildElementRanges(readMap, editor.document) : []);
    if (dataWriteDecoration) editor.setDecorations(dataWriteDecoration, writeMap ? buildElementRanges(writeMap, editor.document) : []);
  }
}

export function reapplyDataHighlightsFromCache(
  dataAddressLookup: Map<number, DataAddressEntry> | null,
  filePaths: Map<string, string> | null | undefined): void
{
  applyDataLineHighlightsFromSnapshot(lastDataAccessLog ?? undefined, dataAddressLookup, filePaths);
}

export function clearDataLineHighlights(): void {
  if (!highlightContext) return;
  for (const editor of vscode.window.visibleTextEditors) {
    if (dataReadDecoration) editor.setDecorations(dataReadDecoration, []);
    if (dataWriteDecoration) editor.setDecorations(dataWriteDecoration, []);
  }
  lastDataAccessLog = null;
}

export function refreshDataLineHighlights(
  hardware: Hardware | null | undefined,
  dataAddressLookup: Map<number, DataAddressEntry> | null,
  filePaths: Map<string, string> | null | undefined)
: void
{
  if (!hardware) {
    clearDataLineHighlights();
    lastDataAccessLog = null;
    return;
  }
  const snapshotAccessLog = hardware.Request(HardwareReq.DEBUG_MEM_ACCESS_LOG_GET)['data'] as MemoryAccessLog | undefined;
  applyDataLineHighlightsFromSnapshot(snapshotAccessLog, dataAddressLookup, filePaths);
}
