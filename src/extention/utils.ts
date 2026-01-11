import * as fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import type { PrintMessage } from '../assembler/types';
import * as ext_types from './project_info';
import * as ext_consts from './consts';
import { resolveIncludePath } from '../assembler/utils';
import { collectIncludeFiles } from '../assembler/includes';


export function readTemplateMainAsm(
	logChannel: vscode.OutputChannel,
	context: vscode.ExtensionContext,
	template_main_asm_path: string)
  : string | undefined
{
	const templatePath = path.join(context.extensionPath, template_main_asm_path);
	try {
		return fs.readFileSync(templatePath, 'utf8');
	} catch (err) {
		logOutput(logChannel,
      `Devector: Failed to read '${ext_consts.MAIN_ASM}' template.`, true);

    return undefined;
	}
};


export function initLaunchConfiguration(
  logChannel: vscode.OutputChannel,
  workspaceRoot: string,
  project: ext_types.ProjectInfo,
  opts: { configName: string; extraProps?: Record<string, any> } = {configName: ext_consts.VS_CODE_LAUNCH_RUN})
  : boolean
{
  if (!workspaceRoot) return false;

  const vscodeDir = path.join(workspaceRoot, ext_consts.VS_CODE_DIR);
  const launchPath = path.join(vscodeDir, ext_consts.VS_CODE_LAUNCH_JSON);
  const enforcedProps = { run: true, ...(opts.extraProps || {}) } as Record<string, any>;

  let launchData: { version?: string; configurations?: any[] } = {
    version: '0.2.0',
    configurations: []
  };
  let dirty = false;

  if (fs.existsSync(launchPath)) {
    try {
      const raw = fs.readFileSync(launchPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        launchData = parsed;
      }
    } catch (err) {
      logOutput(logChannel, `Devector: Failed to parse existing '${ext_consts.VS_CODE_LAUNCH_JSON}', recreating.`, true);
      dirty = true;
    }
  } else {
    dirty = true;
  }

  if (!Array.isArray(launchData.configurations)) {
    launchData.configurations = [];
    dirty = true;
  }

  if (!launchData.version) {
    launchData.version = '0.2.0';
    dirty = true;
  }

  const configs = launchData.configurations as any[];
  let targetConfig = configs.find((cfg) => cfg && cfg.name === opts.configName);

  const resolvedProgram = resolveWorkspaceVariablePath(targetConfig?.program, workspaceRoot);
  if (targetConfig)
    {
    if (resolvedProgram !== project.absolute_path ||
      targetConfig.type !== ext_consts.EXTENTION_NAME ||
      targetConfig.request !== 'launch')
    {
      targetConfig.type = ext_consts.EXTENTION_NAME;
      targetConfig.request = 'launch';
      targetConfig.program = "${workspaceFolder}/" + project.relative_path!;
      dirty = true;
    }
    for (const [key, value] of Object.entries(enforcedProps)) {
      if (targetConfig[key] !== value) {
        targetConfig[key] = value;
        dirty = true;
      }
    }
  } else {
    targetConfig = {
      name: opts.configName,
      type: ext_consts.EXTENTION_NAME,
      request: 'launch',
      program: "${workspaceFolder}/" + project.relative_path!
    } as any;
    for (const [key, value] of Object.entries(enforcedProps)) {
      targetConfig[key] = value;
    }
    configs.push(targetConfig);
    dirty = true;
  }

  if (!dirty) return false;

  try {
    if (!fs.existsSync(vscodeDir)) {
      fs.mkdirSync(vscodeDir, { recursive: true });
    }
    fs.writeFileSync(launchPath, JSON.stringify(launchData, null, 4), 'utf8');
    return true;
  } catch (err) {
    logOutput(logChannel, `Devector: Failed to write '${ext_consts.VS_CODE_LAUNCH_JSON}': ` + (err instanceof Error ? err.message : String(err)), true);
    return false;
  }
};


export function resolveWorkspaceVariablePath(
  value: string | undefined, workspaceRoot: string)
  : string | undefined
{
  if (!value) return undefined;
  try {
    const replaced = value.replace(/\$\{workspaceFolder\}/g, workspaceRoot);
    return path.resolve(replaced);
  } catch {
    return value;
  }
};

export function logOutput(
  logChannel: vscode.OutputChannel, message: string, reveal: boolean = false)
{
	try {
			logChannel.appendLine(message);
			if (reveal) logChannel.show(true);
	} catch (e) { /* ignore output channel errors */ }
};

export function sanitizeFileName(value: string, fallback: string): string
{
  const sanitized = value
    .replace(/[\/\\?%*:|"<>]/g, '_')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/(\.|\s)+$/g, '');

  return sanitized.length > 0 ? sanitized.normalize('NFC') : fallback;
};

////////////////////////////////////////////////////////////////////////////////
//
// ANYTHING BELOW UNCHECKED YET
//
////////////////////////////////////////////////////////////////////////////////

export function emitPrintMessages(
  logChannel: vscode.OutputChannel, messages?: PrintMessage[])
{
	if (!messages || !messages.length) return;
	for (const msg of messages) {
		let originLabel: string | undefined;
		if (msg.origin?.file) {
			const base = path.basename(msg.origin.file);
			if (msg.origin.line) originLabel = `${base}:${msg.origin.line}`;
			else originLabel = base;
		} else if (msg.origin?.line) {
			originLabel = `line ${msg.origin.line}`;
		} else if (msg.lineIndex) {
			originLabel = `line ${msg.lineIndex}`;
		}
		const prefix = originLabel ? `[.print ${originLabel}]` : '[.print]';
		const text = (msg.text ?? '').toString();
		logOutput(logChannel, `${prefix} ${text}`, true);
	}
};


export function emitWarnings(
  logChannel: vscode.OutputChannel, warnings?: string[])
{
	if (!warnings || !warnings.length) return;
	for (const warning of warnings) {
		logOutput(logChannel, `Devector warning: ${warning}`, true);
	}
};


// gather included files (resolve .include recursively)
export function findIncludedFiles(
  srcPath: string,
  content: string,
  out = new Set<string>(),
  depth = 0,
  mainAsm?: string,
  projectFile?: string)
  : Set<string>
{
  if (!srcPath) return out;
  if (depth > 16) return out;
  const mainPath = mainAsm ?? srcPath;
  out.add(path.resolve(srcPath));
  const lines = content.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    // strip comments
    const trimmed = raw.replace(/\/\/.*$|;.*$/, '').trim();
    const m = trimmed.match(/^\.include\s+["']([^"']+)["']/i);
    if (!m) continue;

    const incPath = resolveIncludePath(m[1], srcPath, mainPath, projectFile);
    if (!incPath) continue;
    const resolvedInc = path.resolve(incPath);
    if (out.has(resolvedInc)) continue;
    try {
      const incText = fs.readFileSync(resolvedInc, 'utf8');
      findIncludedFiles(resolvedInc, incText, out, depth + 1, mainPath, projectFile);
    } catch (err) {
      // ignore missing include here; assembler would've reported it.
    }
  }
  return out;
}

export function reportInvalidBreakpointLine()
{
	vscode.window.setStatusBarMessage(
    'Breakpoints can only target label or instruction lines.', 3000);
};




export function isAsmBreakpointLine(doc: vscode.TextDocument, line: number)
: boolean
{
  if (!doc || line < 0 || line >= doc.lineCount) return false;
  const text = doc.lineAt(line).text;
  const trimmed = text.trim();
  if (!trimmed.length) return false;
  if (trimmed.startsWith(';') || trimmed.startsWith('//')) return false;
  if (trimmed.startsWith('.')) return false;
  return true;
};


export function normalizeFsPath(value: string)
: string
{
  try {
    return path.resolve(value).replace(/\\/g, '/').toLowerCase();
  } catch {
    return value.toLowerCase();
  }
};

export function getOpenDocumentByFsPath(fsPath: string)
: vscode.TextDocument | undefined
{
  const target = normalizeFsPath(fsPath);
  return vscode.workspace.textDocuments.find(
    (doc) => normalizeFsPath(doc.uri.fsPath) === target);
};


export const openDocument = async (logChannel: vscode.OutputChannel, uri: vscode.Uri): Promise<vscode.TextDocument | undefined> => {
  const existing = getOpenDocumentByFsPath(uri.fsPath);
  if (existing) return existing;
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch (err) {
    logOutput(logChannel, 'Devector: Failed to open document for breakpoint validation: ' + (err instanceof Error ? err.message : String(err)));
    return undefined;
  }
};


export function resolveProjectDirFromTokens(tokens: any, tokenPath?: string): string | undefined {
  if (!tokens) return undefined;
  const dirRaw = typeof tokens.projectDir === 'string' ? tokens.projectDir : undefined;
  const baseDir = tokenPath ? path.dirname(tokenPath) : undefined;
  if (dirRaw) {
    if (path.isAbsolute(dirRaw)) return path.normalize(dirRaw);
    if (baseDir) return path.normalize(path.resolve(baseDir, dirRaw));
    const workspaceDir = process.cwd();
    return path.normalize(path.resolve(workspaceDir, dirRaw));
  }
  const projectFile = typeof tokens.projectFile === 'string' ? tokens.projectFile : undefined;
  if (projectFile) {
    if (path.isAbsolute(projectFile)) return path.dirname(path.normalize(projectFile));
    if (baseDir) return path.dirname(path.resolve(baseDir, projectFile));
    return path.dirname(path.resolve(process.cwd(), projectFile));
  }
  return baseDir;
}

export function resolveProjectFileFromTokens(tokens: any, tokenPath?: string): string | undefined {
  if (!tokens) return undefined;
  const projectFile = typeof tokens.projectFile === 'string' ? tokens.projectFile : undefined;
  if (!projectFile) return undefined;
  if (path.isAbsolute(projectFile)) return path.normalize(projectFile);
  const projectDir = resolveProjectDirFromTokens(tokens, tokenPath);
  if (projectDir) return path.normalize(path.resolve(projectDir, projectFile));
  const baseDir = tokenPath ? path.dirname(tokenPath) : process.cwd();
  return path.normalize(path.resolve(baseDir, projectFile));
}

export function normalizeDebugFileKey(filePath: string, projectDir?: string): string | undefined {
  if (!filePath) return undefined;
  const normalized = path.normalize(filePath);
  if (projectDir) {
    const absolute = path.isAbsolute(normalized) ? normalized : path.resolve(projectDir, normalized);
    const relative = path.relative(projectDir, absolute).replace(/\\/g, '/').toLowerCase();
    if (relative) return relative;
  }
  const base = path.basename(normalized).toLowerCase();
  return base || undefined;
}


function lookupLineAddress(
  tokens: any, filePath: string, line: number, tokenPath?: string)
  : string | string[] | undefined
{
  if (!tokens || !tokens.lineAddresses) return undefined;
  const projectDir = resolveProjectDirFromTokens(tokens, tokenPath);
  const candidates = new Set<string>();
  const primary = normalizeDebugFileKey(filePath, projectDir);
  const fallback = normalizeDebugFileKey(filePath, undefined);
  if (primary) candidates.add(primary);
  if (fallback) candidates.add(fallback);
  let perFile: any;
  for (const key of candidates) {
    perFile = tokens.lineAddresses[key];
    if (perFile) break;
  }
  if (!perFile) return undefined;
  const normalizeValues = (value: any): string[] => {
    const out: string[] = [];
    const pushVal = (v: any) => {
      if (typeof v === 'string' && v) {
        if (!out.includes(v)) out.push(v);
        return;
      }
      if (typeof v === 'number' && Number.isFinite(v)) {
        const hex = '0x' + (v & 0xffff).toString(16).toUpperCase().padStart(4, '0');
        if (!out.includes(hex)) out.push(hex);
      }
    };
    if (Array.isArray(value)) {
      for (const v of value) pushVal(v);
    } else {
      pushVal(value);
    }
    return out;
  };

  const combined: string[] = [];
  const pushAll = (value: any) => {
    const vals = normalizeValues(value);
    for (const v of vals) if (!combined.includes(v)) combined.push(v);
  };
  pushAll(perFile[line]);
  pushAll(perFile[String(line)]);

  if (!combined.length) return undefined;
  return combined.length === 1 ? combined[0] : combined;
};

export function attachAddressFromTokens(
  tokens: any, filePath: string, line: number, entry: Record<string, any>, tokenPath?: string)
{
  if (!entry || entry.addr) return;
  const addr = lookupLineAddress(tokens, filePath, line, tokenPath);
  if (addr) entry.addr = addr;
};


function gatherAsmPaths(
  items?: readonly vscode.Breakpoint[])
  : Set<string>
{
  const additional = new Set<string>();
  if (!items) return additional;
  for (const bp of items)
  {
    if (!(bp instanceof vscode.SourceBreakpoint)) continue;
    const uri = bp.location?.uri;
    if (!uri || uri.scheme !== 'file') continue;
    if (!uri.fsPath.toLowerCase().endsWith('.asm')) continue;
    additional.add(path.resolve(uri.fsPath));
  }
  return additional;
};

export function collectAsmPathsFromEvent(
  ev: vscode.BreakpointsChangeEvent)
  : Set<string>
{
  const added = gatherAsmPaths(ev.added);
  const removed = gatherAsmPaths(ev.removed);
  const changed = gatherAsmPaths(ev.changed);
  let result: Set<string> = new Set<string>([...added, ...removed, ...changed]);

  return result;
}


export async function findInvalidBreakpoints(
  devectorOutput: vscode.OutputChannel,
  items?: readonly vscode.Breakpoint[])
  : Promise<vscode.SourceBreakpoint[]>
{
  const invalid: vscode.SourceBreakpoint[] = [];
  if (!items) return invalid;
  for (const bp of items) {
    if (!(bp instanceof vscode.SourceBreakpoint)) continue;
    const uri = bp.location?.uri;
    if (!uri || uri.scheme !== 'file') continue;
    if (!uri.fsPath.toLowerCase().endsWith('.asm')) continue;
    const doc = await openDocument(devectorOutput, uri);
    if (!doc) continue;
    const line = bp.location.range.start.line;
    if (!isAsmBreakpointLine(doc, line)) invalid.push(bp);
  }
  return invalid;
}


// Helper utilities for breakpoint targeting
export function looksLikeFsPath(value: string): boolean {
  return path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
};

export function normalizeUri(value: any): vscode.Uri | undefined {
  if (!value) return undefined;
  if (value instanceof vscode.Uri) return value;
  if (typeof value === 'string') {
    try {
      return looksLikeFsPath(value) ? vscode.Uri.file(value) : vscode.Uri.parse(value);
    } catch (_) {
      return undefined;
    }
  }
  if (typeof value === 'object') {
    if (typeof value.fsPath === 'string') return normalizeUri(value.fsPath);
    if (typeof value.path === 'string') {
      if (value.scheme === 'file') return normalizeUri(value.path);
      try {
        if (value.scheme) return vscode.Uri.parse(`${value.scheme}://${value.authority || ''}${value.path}`);
      } catch (_) {
        return undefined;
      }
      return normalizeUri(value.path);
    }
    if (typeof value.scheme === 'string' && typeof value.authority === 'string' && typeof value.path === 'string') {
      try {
        return vscode.Uri.parse(`${value.scheme}://${value.authority}${value.path}`);
      } catch (_) { return undefined; }
    }
  }
  return undefined;
};


// Helper to write breakpoints for the active asm editor into its tokens file
export async function writeBreakpointsForActiveEditor()
{
  const ed2 = vscode.window.activeTextEditor;
  if (!ed2) return;
  const doc2 = ed2.document;
  if (!doc2 || doc2.isUntitled || !doc2.fileName.endsWith('.asm')) return;
  const src2 = doc2.getText();
  const mainPath2 = doc2.fileName;
  try {
    let tokenPath2: string;
    const outPath2 = mainPath2.replace(/\.asm$/i, '.rom');
    if (/\.[^/.]+$/.test(outPath2)) tokenPath2 = outPath2.replace(/\.[^/.]+$/, ext_consts.DEBUG_FILE_SUFFIX);
    else tokenPath2 = outPath2 + ext_consts.DEBUG_FILE_SUFFIX;
    if (!fs.existsSync(tokenPath2)) return;
    const tokenText2 = fs.readFileSync(tokenPath2, 'utf8');
    const tokens2 = JSON.parse(tokenText2);
    const projectDir = resolveProjectDirFromTokens(tokens2, tokenPath2) || path.dirname(mainPath2);
    const projectFile = resolveProjectFileFromTokens(tokens2, tokenPath2);
    const included = findIncludedFiles(mainPath2, src2, new Set<string>(), 0, mainPath2, projectFile);
    tokens2.breakpoints = {};
    const fileKeyToPaths = new Map<string, Set<string>>();
    for (const f of Array.from(included)) {
      const key = normalizeDebugFileKey(f, projectDir);
      if (!key) continue;
      let s = fileKeyToPaths.get(key);
      if (!s) { s = new Set(); fileKeyToPaths.set(key, s); }
      s.add(path.resolve(f));
    }
    const allBps2 = vscode.debug.breakpoints;
    for (const bp of allBps2) {
      if ((bp as vscode.SourceBreakpoint).location) {
        const srcBp = bp as vscode.SourceBreakpoint;
        const uri = srcBp.location.uri;
        if (!uri || uri.scheme !== 'file') continue;
        const bpPath = path.resolve(uri.fsPath);
        const bpKey = normalizeDebugFileKey(bpPath, projectDir);
        if (!bpKey || !fileKeyToPaths.has(bpKey)) continue;
        const pathsForBase = fileKeyToPaths.get(bpKey)!;
        if (!pathsForBase.has(bpPath)) continue;
        const lineNum = srcBp.location.range.start.line + 1;
        const entry = { line: lineNum, enabled: !!bp.enabled } as any;
        if (tokens2.labels) {
          for (const [labelName, labInfo] of Object.entries(tokens2.labels)) {
            try {
              const labelKey = normalizeDebugFileKey((labInfo as any).src, projectDir);
              if (labelKey && labelKey === bpKey && (labInfo as any).line === lineNum) {
                entry.label = labelName;
                entry.addr = (labInfo as any).addr;
                break;
              }
            } catch (e) {}
          }
        }
        attachAddressFromTokens(tokens2, bpPath, lineNum, entry, tokenPath2);
        if (!tokens2.breakpoints[bpKey]) tokens2.breakpoints[bpKey] = [];
        tokens2.breakpoints[bpKey].push(entry);
      }
    }
    fs.writeFileSync(tokenPath2, JSON.stringify(tokens2, null, 4), 'utf8');
  } catch (e) {
    console.error('writeBreakpointsForActiveEditor failed:', e);
  }
}


function applyLine(
  current: number | undefined,
  raw: any,
  opts: { oneBased?: boolean } = {})
  : number | undefined
{
  if (current !== undefined) return current;
  if (raw === undefined || raw === null) return current;
  const num = Number(raw);
  if (!Number.isFinite(num)) return current;
  const normalized = opts.oneBased ? num - 1 : num;
  return Math.max(0, Math.floor(normalized));
};



/**
 * Extract a target from an arbitrary argument.
 * The target is an object with two properties: `uri` and `line`.
 * The `uri` property is a URI that points to a file, and the `line` property is a 0-based line number.
 * The function will recursively traverse the argument and return the first target it finds.
 * If no target is found, the function returns an object with `undefined` properties.
 * @param {any} arg - The argument to extract the target from.
 * @returns {{ uri?: vscode.Uri; line?: number }} - The extracted target.
 */
export function extractTargetFromArg(arg: any)
: { uri?: vscode.Uri; line?: number }
{
  let uri: vscode.Uri | undefined;
  let line: number | undefined;

  const visit = (node: any) => {
    if (node === undefined || node === null) return;
    if (uri && line !== undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const maybeUri = normalizeUri(node);
    if (maybeUri && !uri) uri = maybeUri;
    if (typeof node === 'number') {
      line = applyLine(line, node);
      return;
    }
    if (typeof node !== 'object') return;

    const candidate = node as any;
    if (candidate.uri) {
      const parsed = normalizeUri(candidate.uri);
      if (parsed && !uri) uri = parsed;
    }
    if (candidate.resource) {
      const parsed = normalizeUri(candidate.resource);
      if (parsed && !uri) uri = parsed;
    }
    if (candidate.document?.uri) {
      const parsed = normalizeUri(candidate.document.uri);
      if (parsed && !uri) uri = parsed;
    }
    if (candidate.source?.path) {
      const parsed = normalizeUri(candidate.source.path);
      if (parsed && !uri) uri = parsed;
    }
    if (candidate.location) {
      const loc = candidate.location;
      if (loc.uri) {
        const parsed = normalizeUri(loc.uri);
        if (parsed && !uri) uri = parsed;
      }
      if (loc.range) visit(loc.range);
    }
    if (candidate.editor) visit(candidate.editor);
    if (candidate.textEditor) visit(candidate.textEditor);
    if (candidate.range) visit(candidate.range);
    if (candidate.selection) visit(candidate.selection);
    if (candidate.selections) visit(candidate.selections);
    if (candidate.position) visit(candidate.position);
    if (candidate.active) visit(candidate.active);
    if (candidate.start) visit(candidate.start);
    if (candidate.end) visit(candidate.end);
    if (candidate.anchor) visit(candidate.anchor);
    if (candidate.line !== undefined) line = applyLine(line, candidate.line);
    if (candidate.lineNumber !== undefined) line = applyLine(line, candidate.lineNumber, { oneBased: true });
    if (candidate.startLine !== undefined) line = applyLine(line, candidate.startLine);
    if (candidate.startLineNumber !== undefined) line = applyLine(line, candidate.startLineNumber, { oneBased: true });
    if (candidate.lineno !== undefined) line = applyLine(line, candidate.lineno, { oneBased: true });
  };

  visit(arg);
  return { uri, line };
};


export function projectOwnsAsm(project: ext_types.ProjectInfo, normalizedTarget: string): boolean {
  project.init_asm_path();
  project.init_debug_path();
  const mainAsm = project.absolute_asm_path;
  if (!mainAsm || !fs.existsSync(mainAsm)) return false;

  let source: string;
  try {
    source = fs.readFileSync(mainAsm, 'utf8');
  } catch (_) {
    return false;
  }

  let includes: Set<string>;
  try {
    includes = collectIncludeFiles(source, mainAsm, mainAsm, project.absolute_path);
  } catch (_) {
    return false;
  }
  includes.add(path.resolve(mainAsm));
  for (const inc of includes) {
    if (normalizeFsPath(inc) === normalizedTarget) return true;
  }
  return false;
}


export async function findProjectForAsmFile(documentPath: string): Promise<ext_types.ProjectInfo | undefined> {
  const normalizedTarget = normalizeFsPath(documentPath);
  const candidates = collectProjectFilesNear(documentPath);
  for (const projectPath of candidates) {
    const project = ext_types.ProjectInfo.createFromFileSync(projectPath);
    if (project.error) continue;
    if (projectOwnsAsm(project, normalizedTarget)) return project;
  }
  return undefined;
}


export function collectProjectFilesNear(documentPath: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  let cursor = path.dirname(documentPath);
  while (true) {
    try {
      for (const entry of fs.readdirSync(cursor)) {
        if (!entry.toLowerCase().endsWith(ext_consts.PROJECT_FILE_SUFFIX)) continue;
        const full = path.join(cursor, entry);
        const normalized = normalizeFsPath(full);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        results.push(full);
      }
    } catch (_) {}
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return results;
}