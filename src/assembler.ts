import * as fs from 'fs';
import * as path from 'path';

type AssembleResult = {
  success: boolean;
  output?: Buffer;
  map?: Record<number, number>; // source line (1-based) -> address
  errors?: string[];
  warnings?: string[];
  labels?: Record<string, { addr: number; line: number; src?: string }>;
  origins?: Array<{ file?: string; line: number }>;
};

const regCodes: Record<string, number> = {
  B: 0,
  C: 1,
  D: 2,
  E: 3,
  H: 4,
  L: 5,
  M: 6,
  A: 7
};

const mviOpcodes = {
  B: 0x06,
  C: 0x0e,
  D: 0x16,
  E: 0x1e,
  H: 0x26,
  L: 0x2e,
  M: 0x36,
  A: 0x3e
} as Record<string, number>;

function toByte(v: string): number | null {
  if (/^0x[0-9a-fA-F]+$/.test(v)) return parseInt(v.slice(2), 16) & 0xff;
  if (/^[0-9]+$/.test(v)) return parseInt(v, 10) & 0xff;
  // binary forms: b010101 or %0101 with optional underscores
  if (/^b[01_]+$/i.test(v)) return parseInt(v.slice(1).replace(/_/g, ''), 2) & 0xff;
  if (/^%[01_]+$/.test(v)) return parseInt(v.slice(1).replace(/_/g, ''), 2) & 0xff;
  return null;
}

// Parse a numeric token without masking so we can check its full width
function parseNumberFull(v: string): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^\$[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(1), 16);
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  if (/^b[01_]+$/i.test(s)) return parseInt(s.slice(1).replace(/_/g, ''), 2);
  if (/^%[01_]+$/.test(s)) return parseInt(s.slice(1).replace(/_/g, ''), 2);
  return null;
}

function parseAddressToken(v: string, labels?: Map<string, { addr: number; line: number; src?: string }>, consts?: Map<string, number>): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16) & 0xffff;
  if (/^\$[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(1), 16) & 0xffff;
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10) & 0xffff;

  // support simple arithmetic chains like "a + b - 1" where tokens can be
  // numeric, global labels, or constants (from `consts`). This evaluates left
  // to right; local (@) labels are not resolved here (caller should use
  // `resolveAddressToken` which understands scope).
  const exprParts = s.split(/\s*([+-])\s*/);
  if (exprParts.length > 1) {
    let acc: number | null = null;
    for (let pi = 0; pi < exprParts.length; pi += 2) {
      const tok = exprParts[pi].trim();
      let val: number | null = null;
      // numeric literal
      val = parseNumberFull(tok);
      if (val === null) {
        if (consts && consts.has(tok)) val = consts.get(tok)!;
        else if (labels && labels.has(tok)) val = labels.get(tok)!.addr;
        else val = null;
      }
      if (val === null) return null;
      if (acc === null) acc = val;
      else {
        const op = exprParts[pi - 1];
        if (op === '+') acc = acc + val;
        else acc = acc - val;
      }
    }
    return (acc! & 0xffff);
  }

  if (consts && consts.has(s)) return consts.get(s)! & 0xffff;
  if (labels && labels.has(s)) return labels.get(s)!.addr & 0xffff;
  return null;
}

function resolveLocalLabelKey(name: string, originFile?: string, sourcePath?: string): string {
  if (!name || name[0] !== '@') return name;
  // strip leading @ and append '_' + basename without extension of the file
  const baseFile = originFile || sourcePath;
  const base = baseFile ? path.basename(baseFile, path.extname(baseFile)) : 'memory';
  return '@' + name.slice(1) + '_' + base;
}

export function assemble(source: string, sourcePath?: string): AssembleResult {
  // Expand .include directives and build an origin map so we can report
  // errors/warnings that reference the original file and line number.
  function processContent(content: string, file?: string, depth = 0): { lines: string[]; origins: Array<{ file?: string; line: number }> } {
    if (depth > 16) throw new Error(`Include recursion too deep (>${16}) when processing ${file || '<memory>'}`);
    const outLines: string[] = [];
    const origins: Array<{ file?: string; line: number }> = [];
    const srcLines = content.split(/\r?\n/);
    for (let li = 0; li < srcLines.length; li++) {
      const raw = srcLines[li];
      const trimmed = raw.replace(/\/\/.*$|;.*$/, '').trim();
      // match .include "filename" or .include 'filename'
      const m = trimmed.match(/^\.include\s+["']([^"']+)["']/i);
      if (m) {
        const inc = m[1];
        // resolve path
        let incPath = inc;
        if (!path.isAbsolute(incPath)) {
          const baseDir = file ? path.dirname(file) : (sourcePath ? path.dirname(sourcePath) : process.cwd());
          incPath = path.resolve(baseDir, incPath);
        }
        let incText: string;
        try {
          incText = fs.readFileSync(incPath, 'utf8');
        } catch (err) {
          const em = err && (err as any).message ? (err as any).message : String(err);
          throw new Error(`Failed to include '${inc}' at ${file || sourcePath || '<memory>'}:${li+1} - ${em}`);
        }
        const nested = processContent(incText, incPath, depth + 1);
        for (let k = 0; k < nested.lines.length; k++) {
          outLines.push(nested.lines[k]);
          origins.push(nested.origins[k]);
        }
        continue;
      }
      outLines.push(raw);
      origins.push({ file: file || sourcePath, line: li + 1 });
    }
    return { lines: outLines, origins };
  }

  let expanded: { lines: string[]; origins: Array<{ file?: string; line: number }> };
  try {
    expanded = processContent(source, sourcePath, 0);
  } catch (err: any) {
    return { success: false, errors: [err.message] };
  }
  const lines = expanded.lines;
  const labels = new Map<string, { addr: number; line: number; src?: string }>();
  const consts = new Map<string, number>();
  // localsIndex: scopeKey -> (localName -> array of { key, line }) ordered by appearance
  const localsIndex = new Map<string, Map<string, Array<{ key: string; line: number }>>>();
  // global numeric id counters per local name to ensure exported keys are unique
  const globalLocalCounters = new Map<string, number>();
  const scopes: string[] = new Array(lines.length);
  let directiveCounter = 0;
  function getFileKey(orig?: { file?: string; line: number }) {
    return (orig && orig.file) ? path.resolve(orig.file) : (sourcePath ? path.resolve(sourcePath) : '<memory>');
  }
  function getScopeKey(orig?: { file?: string; line: number }) {
    return getFileKey(orig) + '::' + directiveCounter;
  }

  let addr = 0;
  const errors: string[] = [];
  const warnings: string[] = [];
  const origins = expanded.origins;

  // First pass: labels and address calculation
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\/\/.*$|;.*$/, '').trim();
    if (!line) continue;
    // handle optional leading label (either with colon or bare before an opcode/directive)
    const tokens = line.split(/\s+/);
    let labelHere: string | null = null;
    // If the origin file changed from the previous line, treat it as a scope boundary
    if (i > 0) {
      const prev = origins[i - 1];
      const curr = origins[i];
      const prevKey = prev && prev.file ? path.resolve(prev.file) : (sourcePath ? path.resolve(sourcePath) : '<memory>');
      const currKey = curr && curr.file ? path.resolve(curr.file) : (sourcePath ? path.resolve(sourcePath) : '<memory>');
      if (prevKey !== currKey) {
        directiveCounter++;
      }
    }
    // record current scope key for this line (before any .org on this line takes effect)
    scopes[i] = getScopeKey(origins[i]);

    // simple constant / EQU handling: "NAME = expr" or "NAME EQU expr"
    if (tokens.length >= 3 && (tokens[1] === '=' || tokens[1].toUpperCase() === 'EQU')) {
      const name = tokens[0];
      const rhs = tokens.slice(2).join(' ').trim();
      // try numeric then label/const resolution
      let val: number | null = parseNumberFull(rhs);
      if (val === null) {
        if (consts.has(rhs)) val = consts.get(rhs)!;
        else if (labels.has(rhs)) val = labels.get(rhs)!.addr;
      }
      if (val === null) {
        errors.push(`Bad constant value '${rhs}' for ${name} at ${i + 1}`);
      } else {
        consts.set(name, val);
      }
      continue;
    }
    // also support forms with no whitespace tokens (e.g. "NAME=16") or explicit EQU
    const assignMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (assignMatch) {
      const name = assignMatch[1];
      const rhs = assignMatch[2].trim();
      let val: number | null = parseNumberFull(rhs);
      if (val === null) {
        if (consts.has(rhs)) val = consts.get(rhs)!;
        else if (labels.has(rhs)) val = labels.get(rhs)!.addr;
      }
      if (val === null) errors.push(`Bad constant value '${rhs}' for ${name} at ${i + 1}`);
      else consts.set(name, val);
      continue;
    }
    const equMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+EQU\s+(.+)$/i);
    if (equMatch) {
      const name = equMatch[1];
      const rhs = equMatch[2].trim();
      let val: number | null = parseNumberFull(rhs);
      if (val === null) {
        if (consts.has(rhs)) val = consts.get(rhs)!;
        else if (labels.has(rhs)) val = labels.get(rhs)!.addr;
      }
      if (val === null) errors.push(`Bad constant value '${rhs}' for ${name} at ${i + 1}`);
      else consts.set(name, val);
      continue;
    }


    if (tokens[0].endsWith(':')) {
      labelHere = tokens[0].slice(0, -1);
      tokens.shift();
      const org = origins[i];
      const scopeKey = scopes[i];
      // local label
      if (labelHere && labelHere[0] === '@') {
        const localName = labelHere.slice(1);
        let fileMap = localsIndex.get(scopeKey);
        if (!fileMap) { fileMap = new Map(); localsIndex.set(scopeKey, fileMap); }
        let arr = fileMap.get(localName);
        if (!arr) { arr = []; fileMap.set(localName, arr); }
        // assign a globally unique integer id for this local name
        const gid = globalLocalCounters.get(localName) || 0;
        globalLocalCounters.set(localName, gid + 1);
        const key = '@' + localName + '_' + gid;
        arr.push({ key, line: org ? org.line : i + 1 });
        labels.set(key, { addr, line: org ? org.line : i + 1, src: org && org.file ? path.basename(org.file) : (sourcePath ? path.basename(sourcePath) : undefined) });
      } else {
        const key = labelHere;
        if (labels.has(key)) {
          const prev = labels.get(key)!;
          errors.push(`Duplicate label '${labelHere}' at ${i + 1} (previously at ${prev.line})`);
        } else {
          const org = origins[i];
          labels.set(key, { addr, line: org ? org.line : i + 1, src: org && org.file ? path.basename(org.file) : (sourcePath ? path.basename(sourcePath) : undefined) });
        }
      }
      if (!tokens.length) {
        continue;
      }
    } else if (tokens.length >= 2 && /^\.?org$/i.test(tokens[1])) {
      // bare label before a directive, e.g. "start .org 0x100"
      labelHere = tokens[0];
      tokens.shift();
    }

    const op = tokens[0].toUpperCase();

    if (op === 'DB') {
      // DB value [,value]
      const rest = line.slice(2).trim();
      const parts = rest.split(',').map(p => p.trim()).filter(p => p.length > 0);
      // account for multi-char quoted strings which emit multiple bytes
      for (const p of parts) {
        if (/^'.*'$/.test(p)) {
          // number of bytes equals number of characters inside quotes
          addr += Math.max(0, p.length - 2);
        } else {
          addr += 1;
        }
      }
      continue;
    }

    if (op === 'DS') {
      // DS count  (reserve bytes)
      const rest = tokens.slice(1).join(' ').trim();
      const n = parseInt(rest);
      if (isNaN(n) || n < 0) { errors.push(`Bad DS count '${rest}' at ${i + 1}`); continue; }
      addr += n;
      continue;
    }

    if (op === '.ORG' || op === 'ORG') {
      // .org addr
      const rest = tokens.slice(1).join(' ');
      const aTok = rest.trim().split(/\s+/)[0];
      const org = origins[i];
      let val: number | null = null;
      const num = parseNumberFull(aTok);
      if (num !== null) val = num & 0xffff;
      else if (aTok && aTok[0] === '@') {
        // try to resolve local label in current scope
        const scopeKey = getScopeKey(org);
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
      if (val === null) { errors.push(`Bad ORG address '${aTok}' at ${i + 1}`); continue; }
      addr = val;
      // .org defines a new (narrower) scope region for subsequent labels
      directiveCounter++;
      if (labelHere) {
        const org = origins[i];
        const newScope = getScopeKey(org);
        if (labelHere[0] === '@') {
          const localName = labelHere.slice(1);
          let fileMap = localsIndex.get(newScope);
          if (!fileMap) { fileMap = new Map(); localsIndex.set(newScope, fileMap); }
          let arr = fileMap.get(localName);
          if (!arr) { arr = []; fileMap.set(localName, arr); }
          const gid = globalLocalCounters.get(localName) || 0;
          globalLocalCounters.set(localName, gid + 1);
          const key = '@' + localName + '_' + gid;
          arr.push({ key, line: org ? org.line : i + 1 });
          labels.set(key, { addr, line: org ? org.line : i + 1, src: org && org.file ? path.basename(org.file) : (sourcePath ? path.basename(sourcePath) : undefined) });
        } else {
          const key = labelHere;
          if (labels.has(key)) errors.push(`Duplicate label ${labelHere} at ${i + 1}`);
          labels.set(key, { addr, line: org ? org.line : i + 1, src: org && org.file ? path.basename(org.file) : (sourcePath ? path.basename(sourcePath) : undefined) });
        }
      }
      continue;
    }

    if (op === 'MVI') {
      addr += 2; // opcode + data
      continue;
    }

    // Arithmetic immediate ops: ADI, ACI, SUI, SBI
    if (op === 'ADI' || op === 'ACI' || op === 'SUI' || op === 'SBI') {
      addr += 2;
      continue;
    }

    // Logical immediate ops: ANI, XRI, ORI, CPI
    if (op === 'ANI' || op === 'XRI' || op === 'ORI' || op === 'CPI') {
      addr += 2;
      continue;
    }

    // Single-byte arithmetic/logical ops
    if (op === 'ADC' || op === 'SBB' || op === 'SUB' || op === 'DAD' || op === 'DAA' || op === 'STC' || op === 'CMC' || op === 'ANA' || op === 'XRA' || op === 'ORA' || op === 'CMP') {
      addr += 1;
      continue;
    }

    if (op === 'LDAX' || op === 'STAX') {
      addr += 1;
      continue;
    }

    if (op === 'LHLD' || op === 'SHLD') {
      addr += 3;
      continue;
    }

    // INX/DCX register-pair (16-bit inc/dec)
    if (op === 'INX' || op === 'DCX') { addr += 1; continue; }

    if (op === 'LXI') {
      addr += 3;
      continue;
    }



    if (op === 'MOV') {
      addr += 1;
      continue;
    }

    if (op === 'LDA' || op === 'STA' || op === 'JMP' || op === 'JZ' || op === 'JNZ' || op === 'CALL') {
      addr += 3;
      continue;
    }

    // conditional jumps (JNZ/JZ/JNC/JC/JPO/JPE/JP/JM)
    if (/^J(NZ|Z|NC|C|PO|PE|P|M)$/.test(op)) { addr += 3; continue; }

    if (op === 'ADD' || op === 'INR' || op === 'DCR' || op === 'RET' || op === 'HLT' || op === 'NOP') {
      addr += 1;
      continue;
    }

    // Conditional returns
    if (/^R(NZ|Z|NC|C|PO|PE|P|M)$/.test(op)) { addr += 1; continue; }

    // PUSH/POP (register pairs)
    if (op === 'PUSH' || op === 'POP') { addr += 1; continue; }

    // CALL conditional/unconditional and RST
    if (op === 'CALL' || /^C(NZ|Z|NC|C|PO|PE|P|M)$/.test(op)) { addr += 3; continue; }
    if (op === 'RST') { addr += 1; continue; }

    // IN/OUT immediate
    if (op === 'IN' || op === 'OUT') { addr += 2; continue; }

    // Rotates and single-byte system ops
    if (/^R(LC|RC|AL|AR)$/.test(op) || op === 'EI' || op === 'DI' || op === 'SPHL' || op === 'XTHL' || op === 'XCHG' || op === 'PCHL' || op === 'DAA' || op === 'STC' || op === 'CMC') { addr += 1; continue; }

    if (op === 'XCHG' || op === 'PCHL' || op === 'SPHL' || op === 'XTHL') {
      addr += 1;
      continue;
    }

    // unknown -> error
    errors.push(`Unknown or unsupported opcode '${op}' at line ${i + 1}`);
  }

  if (errors.length) return { success: false, errors, origins };

  // Second pass: generate bytes and source-line map
  addr = 0;
  const out: number[] = [];
  const map: Record<number, number> = {};

  // Resolve an address token in second pass: numeric, local (@) or global label
  function resolveAddressToken(arg: string, lineIndex: number): number | null {
    if (!arg) return null;
    const s = arg.trim();
    // simple numeric
    const num = parseNumberFull(s);
    if (num !== null) return num & 0xffff;
      // check simple named constants (e.g. TEMP_BYTE = 0x00)
      if (consts && consts.has(s)) return consts.get(s)! & 0xffff;

    // support simple expressions like "base + 15" where base may be a
    // numeric, a global label, or a local label (@name). RHS must be numeric.
    const em = s.match(/^(.+?)\s*([+-])\s*(0x[0-9a-fA-F]+|\$[0-9a-fA-F]+|[0-9]+)$/);
    if (em) {
      // simple two-term expression fallback (handled by chained evaluator below too)
    }

    // support chained arithmetic like "a + b - 1" where any token may be a
    // numeric, a global label, or a local label (@name). Evaluate left-to-right.
    const exprParts = s.split(/\s*([+-])\s*/);
    if (exprParts.length > 1) {
      let acc: number | null = null;
      for (let pi = 0; pi < exprParts.length; pi += 2) {
        const tok = exprParts[pi].trim();
        let val: number | null = null;
        // numeric
        val = parseNumberFull(tok);
        if (val === null) {
          if (tok[0] === '@') {
            const scopeKey = scopes[lineIndex - 1];
            const fileMap = localsIndex.get(scopeKey);
            if (!fileMap) return null;
            const arr = fileMap.get(tok.slice(1));
            if (!arr || !arr.length) return null;
            let chosen = arr[0];
            for (const entry of arr) {
              if ((entry.line || 0) <= lineIndex) chosen = entry;
              else break;
            }
            const key = chosen.key;
            if (labels.has(key)) val = labels.get(key)!.addr;
            else val = null;
          } else if (labels.has(tok)) {
            val = labels.get(tok)!.addr;
          } else if (consts && consts.has(tok)) {
            val = consts.get(tok)!;
          }
        }
        if (val === null) return null;
        if (acc === null) acc = val;
        else {
          const op = exprParts[pi - 1];
          acc = op === '+' ? (acc + val) : (acc - val);
        }
      }
      return (acc! & 0xffff);
    }

    // local label resolution based on the scope recorded during first pass
    if (s[0] === '@') {
      const scopeKey = scopes[lineIndex - 1];
      const fileMap = localsIndex.get(scopeKey);
      if (!fileMap) return null;
      const arr = fileMap.get(s.slice(1));
      if (!arr || !arr.length) return null;
      let chosen = arr[0];
      for (const entry of arr) {
        if ((entry.line || 0) <= lineIndex) chosen = entry;
        else break;
      }
      const key = chosen.key;
      if (labels.has(key)) return labels.get(key)!.addr & 0xffff;
      return null;
    }

    if (labels.has(s)) return labels.get(s)!.addr & 0xffff;
    return null;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const srcLine = i + 1;
    const line = raw.replace(/\/\/.*$|;.*$/, '').trim();
    if (!line) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*:$/.test(line)) continue; // label only

    // handle optional leading label on the same line
    const tokens = line.split(/\s+/);
    let labelHere: string | null = null;
    if (tokens[0].endsWith(':')) {
      labelHere = tokens[0].slice(0, -1);
      tokens.shift();
      if (!tokens.length) { map[srcLine] = addr; continue; }
    } else if (tokens.length >= 2 && /^\.?org$/i.test(tokens[1])) {
      labelHere = tokens[0];
      tokens.shift();
    }

    map[srcLine] = addr;

    // skip simple constant definitions in second pass (NAME = expr, NAME=expr or NAME EQU expr)
    if (tokens.length >= 3 && (tokens[1] === '=' || tokens[1].toUpperCase() === 'EQU')) {
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line) || /^[A-Za-z_][A-Za-z0-9_]*\s+EQU\b/i.test(line)) {
      continue;
    }

    const op = tokens[0].toUpperCase();

    if (op === 'DB') {
      const rest = line.slice(2).trim();
      const parts = rest.split(',').map(p => p.trim()).filter(p => p.length > 0);
      for (const p of parts) {
        if (/^'.*'$/.test(p)) {
          // multi-char string: emit each character as a byte
          for (let k = 1; k < p.length - 1; k++) {
            out.push(p.charCodeAt(k) & 0xff);
            addr++;
          }
        } else {
          let val = toByte(p);
          if (val === null) {
            errors.push(`Bad DB value '${p}' at ${srcLine}`);
            val = 0;
          }
          out.push(val & 0xff);
          addr++;
        }
      }
      continue;
    }

    if (op === '.ORG' || op === 'ORG') {
      const aTok = tokens.slice(1).join(' ').trim().split(/\s+/)[0];
      const val = parseAddressToken(aTok, labels, consts);
      if (val === null) { errors.push(`Bad ORG address '${aTok}' at ${srcLine}`); continue; }
      addr = val;
      // label for this ORG (if present) was already registered in first pass; nothing to emit
      continue;
    }

    if (op === 'DS') {
      const rest = tokens.slice(1).join(' ').trim();
      const n = parseInt(rest);
      if (isNaN(n) || n < 0) { errors.push(`Bad DS count '${rest}' at ${srcLine}`); continue; }
      // reserve: just advance addr (no bytes emitted)
      addr += n;
      continue;
    }

    if (op === 'LDAX' || op === 'STAX') {
      const reg = tokens[1].toUpperCase();
      let opcode = -1;
      if (op === 'LDAX') {
        if (reg === 'B') opcode = 0x0A;
        if (reg === 'D') opcode = 0x1A;
      } else {
        if (reg === 'B') opcode = 0x02;
        if (reg === 'D') opcode = 0x12;
      }
      if (opcode < 0) { errors.push(`Bad ${op} register '${reg}' at ${srcLine}`); continue; }
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    if (op === 'INX' || op === 'DCX') {
      const rp = tokens[1].toUpperCase();
      const isInx = op === 'INX';
      let opcode = -1;
      if (rp === 'B') opcode = isInx ? 0x03 : 0x0B;
      if (rp === 'D') opcode = isInx ? 0x13 : 0x1B;
      if (rp === 'H') opcode = isInx ? 0x23 : 0x2B;
      if (rp === 'SP') opcode = isInx ? 0x33 : 0x3B;
      if (opcode < 0) { errors.push(`Bad ${op} RP '${rp}' at ${srcLine}`); continue; }
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    if (op === 'LHLD' || op === 'SHLD') {
      const arg = tokens.slice(1).join(' ').trim();
      let target = 0;
      const num = parseNumberFull(arg);
      if (num !== null) {
        target = num;
        if (target > 0xffff) warnings.push(`Address ${arg} (0x${target.toString(16).toUpperCase()}) too large for ${op} at ${srcLine}; truncating to 16-bit`);
      } else {
        const resolvedVal = resolveAddressToken(arg, srcLine);
        if (resolvedVal !== null) target = resolvedVal;
        else { errors.push(`Unknown label or address '${arg}' at ${srcLine}`); target = 0; }
      }
      const opcode = op === 'LHLD' ? 0x2A : 0x22;
      out.push(opcode & 0xff);
      out.push(target & 0xff);
      out.push((target >> 8) & 0xff);
      addr += 3;
      continue;
    }

    if (op === 'XCHG') { out.push(0xEB); addr += 1; continue; }
    if (op === 'PCHL') { out.push(0xE9); addr += 1; continue; }
    if (op === 'SPHL') { out.push(0xF9); addr += 1; continue; }
    if (op === 'XTHL') { out.push(0xE3); addr += 1; continue; }

    if (op === 'MVI') {
      // MVI R,byte
      const args = line.slice(3).trim();
      const m = args.split(',').map(s => s.trim());
      if (m.length !== 2) { errors.push(`Bad MVI syntax at ${srcLine}`); continue; }
      const r = m[0].toUpperCase();
      const rawVal = m[1];
      // Allow numeric literals, constants, labels or simple expressions for the immediate
      let full: number | null = parseNumberFull(rawVal);
      if (full === null) {
        const resolved = resolveAddressToken(rawVal, srcLine);
        if (resolved !== null) full = resolved;
        else {
          // fallback to parseAddressToken which can evaluate simple const/label expressions
          const p = parseAddressToken(rawVal, labels, consts);
          if (p !== null) full = p;
        }
      }
      if (!(r in mviOpcodes) || (full === null)) { errors.push(`Bad MVI operands at ${srcLine}`); continue; }
      if (full > 0xff) warnings.push(`Immediate ${rawVal} (0x${full.toString(16).toUpperCase()}) too large for MVI at ${srcLine}; truncating to 0x${(full & 0xff).toString(16).toUpperCase()}`);
      out.push(mviOpcodes[r]);
      out.push((full & 0xff));
      addr += 2;
      continue;
    }

    if (op === 'MOV') {
      // MOV D,S
      const args = tokens.slice(1).join(' ');
      const m = args.split(',').map(s => s.trim());
      if (m.length !== 2) { errors.push(`Bad MOV syntax at ${srcLine}`); continue; }
      const d = m[0].toUpperCase();
      const s = m[1].toUpperCase();
      if (!(d in regCodes) || !(s in regCodes)) { errors.push(`Bad MOV registers at ${srcLine}`); continue; }
      // Explicitly reject the invalid MOV M,M form which would otherwise
      // encode to 0x76 (HLT) due to the MOV bit-pattern. Treat as an
      // assembler error instead of silently emitting HLT.
      if (d === 'M' && s === 'M') { errors.push(`Invalid MOV M,M at ${srcLine}`); continue; }
      const opcode = 0x40 + (regCodes[d] << 3) + regCodes[s];
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    if (op === 'LDA' || op === 'STA' || op === 'JMP' || op === 'JZ' || op === 'JNZ' || op === 'CALL') {
      const arg = tokens.slice(1).join(' ').trim();
      let target = 0;
      const num = parseNumberFull(arg);
      if (num !== null) {
        target = num;
        if (target > 0xffff) warnings.push(`Address ${arg} (0x${target.toString(16).toUpperCase()}) too large for ${op} at ${srcLine}; truncating to 16-bit`);
      } else {
        const resolvedVal = resolveAddressToken(arg, srcLine);
        if (resolvedVal !== null) target = resolvedVal;
        else { errors.push(`Unknown label or address '${arg}' at ${srcLine}`); target = 0; }
      }
      let opcode = 0;
      if (op === 'LDA') opcode = 0x3A;
      if (op === 'STA') opcode = 0x32;
      if (op === 'JMP') opcode = 0xC3;
      if (op === 'JZ') opcode = 0xCA;
      if (op === 'JNZ') opcode = 0xC2;
      if (op === 'CALL') opcode = 0xCD;
      out.push(opcode & 0xff);
      // little endian address
      out.push(target & 0xff);
      out.push((target >> 8) & 0xff);
      addr += 3;
      continue;
    }

    if (op === 'LXI') {
      // LXI RP, d16  (e.g., LXI B,0x1234)
      const args = line.slice(3).trim();
      const parts = args.split(',').map(s => s.trim());
      if (parts.length !== 2) { errors.push(`Bad LXI syntax at ${srcLine}`); continue; }
      const rp = parts[0].toUpperCase();
      const val = parts[1];
      let opcode = -1;
      if (rp === 'B') opcode = 0x01;
      if (rp === 'D') opcode = 0x11;
      if (rp === 'H') opcode = 0x21;
      if (rp === 'SP') opcode = 0x31;
      if (opcode < 0) { errors.push(`Bad LXI register pair at ${srcLine}`); continue; }
      let target = 0;
      const num = parseNumberFull(val);
      if (num !== null) {
        target = num;
        if (target > 0xffff) warnings.push(`Immediate ${val} (0x${target.toString(16).toUpperCase()}) too large for LXI at ${srcLine}; truncating to 16-bit`);
      } else {
        const resolvedVal = resolveAddressToken(val, srcLine);
        if (resolvedVal !== null) target = resolvedVal;
        else { errors.push(`Bad LXI value '${val}' at ${srcLine}`); target = 0; }
      }
      out.push(opcode & 0xff);
      out.push(target & 0xff);
      out.push((target >> 8) & 0xff);
      addr += 3;
      continue;
    }

    if (op === 'ADD') {
      // ADD r
      const r = tokens[1].toUpperCase();
      if (!(r in regCodes)) { errors.push(`Bad ADD reg at ${srcLine}`); continue; }
      const opcode = 0x80 + regCodes[r];
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    if (op === 'ADC') {
      const r = tokens[1].toUpperCase();
      if (!(r in regCodes)) { errors.push(`Bad ADC reg at ${srcLine}`); continue; }
      out.push((0x88 + regCodes[r]) & 0xff);
      addr += 1; continue;
    }

    if (op === 'SUB') {
      const r = tokens[1].toUpperCase();
      if (!(r in regCodes)) { errors.push(`Bad SUB reg at ${srcLine}`); continue; }
      out.push((0x90 + regCodes[r]) & 0xff);
      addr += 1; continue;
    }

    if (op === 'SBB') {
      const r = tokens[1].toUpperCase();
      if (!(r in regCodes)) { errors.push(`Bad SBB reg at ${srcLine}`); continue; }
      out.push((0x98 + regCodes[r]) & 0xff);
      addr += 1; continue;
    }

    if (op === 'INR' || op === 'DCR') {
      // INR r or DCR r
      const r = tokens[1].toUpperCase();
      if (!(r in regCodes)) { errors.push(`Bad ${op} reg at ${srcLine}`); continue; }
      const base = op === 'INR' ? 0x04 : 0x05;
      const opcode = base + (regCodes[r] << 3);
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    // ANA/ORA/XRA/CMP (register forms)
    if (op === 'ANA' || op === 'XRA' || op === 'ORA' || op === 'CMP') {
      const r = tokens[1].toUpperCase();
      if (!(r in regCodes)) { errors.push(`Bad ${op} reg at ${srcLine}`); continue; }
      let base = 0;
      if (op === 'ANA') base = 0xA0;
      if (op === 'XRA') base = 0xA8;
      if (op === 'ORA') base = 0xB0;
      if (op === 'CMP') base = 0xB8;
      out.push((base + regCodes[r]) & 0xff);
      addr += 1;
      continue;
    }

    // ADI/ACI/SUI/SBI immediate
    if (op === 'ADI' || op === 'ACI' || op === 'SUI' || op === 'SBI') {
      const valTok = tokens[1];
      const full = parseNumberFull(valTok);
      if (full === null) { errors.push(`Bad immediate '${valTok}' at ${srcLine}`); continue; }
      if (full > 0xff) warnings.push(`Immediate ${valTok} (0x${full.toString(16).toUpperCase()}) too large for ${op} at ${srcLine}; truncating to 8-bit`);
      let opcode = 0;
      if (op === 'ADI') opcode = 0xC6;
      if (op === 'ACI') opcode = 0xCE;
      if (op === 'SUI') opcode = 0xD6;
      if (op === 'SBI') opcode = 0xDE;
      out.push(opcode & 0xff);
      out.push(full & 0xff);
      addr += 2; continue;
    }

    // ANI/XRI/ORI/CPI immediate
    if (op === 'ANI' || op === 'XRI' || op === 'ORI' || op === 'CPI') {
      const valTok = tokens[1];
      const full = parseNumberFull(valTok);
      if (full === null) { errors.push(`Bad immediate '${valTok}' at ${srcLine}`); continue; }
      if (full > 0xff) warnings.push(`Immediate ${valTok} (0x${full.toString(16).toUpperCase()}) too large for ${op} at ${srcLine}; truncating to 8-bit`);
      let opcode = 0;
      if (op === 'ANI') opcode = 0xE6;
      if (op === 'XRI') opcode = 0xEE;
      if (op === 'ORI') opcode = 0xF6;
      if (op === 'CPI') opcode = 0xFE;
      out.push(opcode & 0xff);
      out.push(full & 0xff);
      addr += 2; continue;
    }

    // DAD RP
    if (op === 'DAD') {
      const rp = tokens[1].toUpperCase();
      let opcode = -1;
      if (rp === 'B') opcode = 0x09;
      if (rp === 'D') opcode = 0x19;
      if (rp === 'H') opcode = 0x29;
      if (rp === 'SP') opcode = 0x39;
      if (opcode < 0) { errors.push(`Bad DAD RP '${rp}' at ${srcLine}`); continue; }
      out.push(opcode & 0xff);
      addr += 1;
      continue;
    }

    // Rotates
    if (op === 'RLC') { out.push(0x07); addr += 1; continue; }
    if (op === 'RRC') { out.push(0x0F); addr += 1; continue; }
    if (op === 'RAL') { out.push(0x17); addr += 1; continue; }
    if (op === 'RAR') { out.push(0x1F); addr += 1; continue; }

    // EI/DI
    if (op === 'EI') { out.push(0xFB); addr += 1; continue; }
    if (op === 'DI') { out.push(0xF3); addr += 1; continue; }

    // PUSH/POP
    if (op === 'PUSH') {
      const rp = tokens[1].toUpperCase();
      let opcode = -1;
      if (rp === 'B') opcode = 0xC5;
      if (rp === 'D') opcode = 0xD5;
      if (rp === 'H') opcode = 0xE5;
      if (rp === 'PSW' || rp === 'PSW,' ) opcode = 0xF5;
      if (opcode < 0) { errors.push(`Bad PUSH RP '${rp}' at ${srcLine}`); continue; }
      out.push(opcode & 0xff); addr += 1; continue;
    }

    if (op === 'POP') {
      const rp = tokens[1].toUpperCase();
      let opcode = -1;
      if (rp === 'B') opcode = 0xC1;
      if (rp === 'D') opcode = 0xD1;
      if (rp === 'H') opcode = 0xE1;
      if (rp === 'PSW' || rp === 'PSW,') opcode = 0xF1;
      if (opcode < 0) { errors.push(`Bad POP RP '${rp}' at ${srcLine}`); continue; }
      out.push(opcode & 0xff); addr += 1; continue;
    }

    // IN/OUT
    if (op === 'IN') {
      const tok = tokens[1];
      const full = parseNumberFull(tok);
      if (full === null) { errors.push(`Bad IN port '${tok}' at ${srcLine}`); continue; }
      if (full > 0xff) warnings.push(`IN port ${tok} (0x${full.toString(16).toUpperCase()}) too large at ${srcLine}; truncating to 8-bit`);
      out.push(0xDB); out.push(full & 0xff); addr += 2; continue;
    }
    if (op === 'OUT') {
      const tok = tokens[1];
      const full = parseNumberFull(tok);
      if (full === null) { errors.push(`Bad OUT port '${tok}' at ${srcLine}`); continue; }
      if (full > 0xff) warnings.push(`OUT port ${tok} (0x${full.toString(16).toUpperCase()}) too large at ${srcLine}; truncating to 8-bit`);
      out.push(0xD3); out.push(full & 0xff); addr += 2; continue;
    }

    // RST n
    if (op === 'RST') {
      const n = parseInt(tokens[1]);
      if (isNaN(n) || n < 0 || n > 7) { errors.push(`Bad RST vector '${tokens[1]}' at ${srcLine}`); continue; }
      out.push((0xC7 + (n << 3)) & 0xff); addr += 1; continue;
    }

    // Conditional jumps and calls
    const jmpMap: Record<string, number> = { 'JNZ': 0xC2, 'JZ': 0xCA, 'JNC': 0xD2, 'JC': 0xDA, 'JPO': 0xE2, 'JPE': 0xEA, 'JP': 0xF2, 'JM': 0xFA };
    const callMap: Record<string, number> = { 'CNZ': 0xC4, 'CZ': 0xCC, 'CNC': 0xD4, 'CC': 0xDC, 'CPO': 0xE4, 'CPE': 0xEC, 'CP': 0xF4, 'CM': 0xFC };
    const retMap: Record<string, number> = { 'RNZ': 0xC0, 'RZ': 0xC8, 'RNC': 0xD0, 'RC': 0xD8, 'RPO': 0xE0, 'RPE': 0xE8, 'RP': 0xF0, 'RM': 0xF8 };

    if (op in jmpMap) {
      const arg = tokens.slice(1).join(' ').trim();
      let target = 0;
      const num = parseNumberFull(arg);
      if (num !== null) {
        target = num;
        if (target > 0xffff) warnings.push(`Address ${arg} (0x${target.toString(16).toUpperCase()}) too large for ${op} at ${srcLine}; truncating to 16-bit`);
      } else {
        const resolvedVal = resolveAddressToken(arg, srcLine);
        if (resolvedVal !== null) target = resolvedVal;
        else { errors.push(`Unknown label or address '${arg}' at ${srcLine}`); target = 0; }
      }
      out.push(jmpMap[op]); out.push(target & 0xff); out.push((target >> 8) & 0xff); addr += 3; continue;
    }

    if (op in callMap) {
      const arg = tokens.slice(1).join(' ').trim();
      let target = 0;
      const num = parseNumberFull(arg);
      if (num !== null) {
        target = num;
        if (target > 0xffff) warnings.push(`Address ${arg} (0x${target.toString(16).toUpperCase()}) too large for ${op} at ${srcLine}; truncating to 16-bit`);
      } else {
        const resolvedVal = resolveAddressToken(arg, srcLine);
        if (resolvedVal !== null) target = resolvedVal;
        else { errors.push(`Unknown label or address '${arg}' at ${srcLine}`); target = 0; }
      }
      out.push(callMap[op]); out.push(target & 0xff); out.push((target >> 8) & 0xff); addr += 3; continue;
    }

    if (op in retMap) { out.push(retMap[op]); addr += 1; continue; }

    // DAA, STC, CMC
    if (op === 'DAA') { out.push(0x27); addr += 1; continue; }
    if (op === 'STC') { out.push(0x37); addr += 1; continue; }
    if (op === 'CMC') { out.push(0x3F); addr += 1; continue; }

    if (op === 'RET') { out.push(0xC9); addr += 1; continue; }

    if (op === 'HLT') { out.push(0x76); addr += 1; continue; }
    if (op === 'NOP') { out.push(0x00); addr += 1; continue; }

    errors.push(`Unhandled opcode '${op}' at ${srcLine}`);
  }

  if (errors.length) return { success: false, errors, origins };

  // convert labels map to plain object for return
  const labelsOut: Record<string, { addr: number; line: number; src?: string }> = {};
  for (const [k, v] of labels) labelsOut[k] = { addr: v.addr, line: v.line, src: v.src };

  return { success: true, output: Buffer.from(out), map, labels: labelsOut, warnings, origins };
}

// convenience when using from extension
export function assembleAndWrite(source: string, outPath: string, sourcePath?: string): { success: boolean; path?: string; errors?: string[] } {
  const startTime = Date.now();
  const res = assemble(source, sourcePath);
  if (!res.success || !res.output) {
    // Improve error messages: include the source line, filename, line number,
    // and file URI / vscode URI so editors/terminals can link to the location.
    const formatted: string[] = [];
    const srcLines = source.split(/\r?\n/);
    if (res.errors && res.errors.length) {
      for (const e of res.errors) {
        // Try to extract a trailing `at <line>` marker from the assembler error
        const m = e.match(/at\s+(\d+)\b/);
        const lineNo = m ? parseInt(m[1], 10) : undefined;
        // Determine origin (file + original line) if available from assemble()
        const origin = (res.origins && lineNo) ? res.origins[lineNo - 1] : undefined;
        let srcText = '';
        let displayPath: string | undefined;
        let displayLine = lineNo;
        if (origin && origin.file) {
          displayPath = path.resolve(origin.file);
          displayLine = origin.line;
          try {
            const fileLines = fs.readFileSync(origin.file, 'utf8').split(/\r?\n/);
            if (fileLines[displayLine - 1]) srcText = fileLines[displayLine - 1].replace(/\t/g, '    ').trim();
          } catch (err) {
            srcText = '';
          }
        } else if (lineNo) {
          displayPath = sourcePath ? path.resolve(sourcePath) : undefined;
          srcText = srcLines[lineNo - 1] ? srcLines[lineNo - 1].replace(/\t/g, '    ').trim() : '';
        }
        let msg = '';
        if (displayPath && displayLine) {
          const fileUri = 'file:///' + displayPath.replace(/\\/g, '/');
          // replace any "at <expandedLine>" in the assembler message with the original source line
          const cleaned = typeof e === 'string' ? e.replace(/at\s+\d+\b/, `at ${displayLine}`) : e;
          msg = `${displayPath}:${displayLine}: ${cleaned}\n> ${srcText}\n${fileUri}:${displayLine}`;
        } else if (displayLine) {
          const cleaned = typeof e === 'string' ? e.replace(/at\s+\d+\b/, `at ${displayLine}`) : e;
          msg = `line ${displayLine}: ${cleaned}\n> ${srcText}`;
        } else {
          msg = e;
        }
        formatted.push(msg);
        // Also print to stderr for immediate feedback when running the assembler
        console.error(msg);
        console.error('');
      }
    }
    return { success: false, errors: formatted.length ? formatted : res.errors };
  }

  // Print warnings (non-fatal) in a similar formatted style so they are visible
  if (res.warnings && res.warnings.length) {
    for (const w of res.warnings) {
      const m = w.match(/at\s+(\d+)\b/);
      const lineNo = m ? parseInt(m[1], 10) : undefined;
      const origin = (res.origins && lineNo) ? res.origins[lineNo - 1] : undefined;
      let srcText = '';
      let displayPath: string | undefined;
      let displayLine = lineNo;
      if (origin && origin.file) {
        displayPath = path.resolve(origin.file);
        displayLine = origin.line;
        try {
          const fileLines = fs.readFileSync(origin.file, 'utf8').split(/\r?\n/);
          if (fileLines[displayLine - 1]) srcText = fileLines[displayLine - 1].replace(/\t/g, '    ').trim();
        } catch (err) {}
      } else if (lineNo) {
        displayPath = sourcePath ? path.resolve(sourcePath) : undefined;
        const srcLines = source.split(/\r?\n/);
        srcText = srcLines[lineNo - 1] ? srcLines[lineNo - 1].replace(/\t/g, '    ').trim() : '';
      }
      if (displayPath && displayLine) {
        const fileUri = 'file:///' + displayPath.replace(/\\/g, '/');
        const cleaned = typeof w === 'string' ? w.replace(/at\s+\d+\b/, `at ${displayLine}`) : w;
        console.warn(`${displayPath}:${displayLine}: ${cleaned}\n> ${srcText}\n${fileUri}:${displayLine}`);
        console.warn('');
      } else if (displayLine) {
        const cleaned = typeof w === 'string' ? w.replace(/at\s+\d+\b/, `at ${displayLine}`) : w;
        console.warn(`line ${displayLine}: ${cleaned}\n> ${srcText}`);
        console.warn('');
      } else {
        console.warn(w);
        console.warn('');
      }
    }
  }
  fs.writeFileSync(outPath, res.output);

  // write token file (JSON) next to outPath, same base name but .json extension
  try {
  // token file uses a `.debug.json` suffix (e.g. `test.rom` -> `test.debug.json`).
  // If the ROM path has no extension, append `.debug.json` verbatim.
  let tokenPath: string;
  if (/\.[^/.]+$/.test(outPath)) tokenPath = outPath.replace(/\.[^/.]+$/, '.debug.json');
  else tokenPath = outPath + '.debug.json';
    const tokens: any = {
      labels: {},
      consts: {}
    };
    if (res.labels) {
      for (const [name, info] of Object.entries(res.labels)) {
        tokens.labels[name] = {
          addr: '0x' + info.addr.toString(16).toUpperCase().padStart(4, '0'),
          src: info.src || (sourcePath ? path.basename(sourcePath) : undefined),
          line: info.line
        };
      }
    }
    tokens.lineAddresses = {};
    if (res.map && res.origins) {
      for (const [lineStr, addrVal] of Object.entries(res.map)) {
        const lineIndex = parseInt(lineStr, 10);
        if (!Number.isFinite(lineIndex) || lineIndex <= 0) continue;
        const origin = res.origins[lineIndex - 1] as { file?: string; line: number } | undefined;
        if (!origin || typeof origin.line !== 'number') continue;
        const originFile = (origin.file || sourcePath);
        if (!originFile) continue;
        const base = path.basename(originFile).toLowerCase();
        if (!tokens.lineAddresses[base]) tokens.lineAddresses[base] = {};
        tokens.lineAddresses[base][origin.line] = '0x' + (addrVal & 0xffff).toString(16).toUpperCase().padStart(4, '0');
      }
    }
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 4), 'utf8');
  } catch (err) {
    // non-fatal: write failed
    console.error('Warning: failed to write token file:', err);
  }

  const durationMs = Date.now() - startTime;
  // Print a concise success message including compile time for CLI/debug usage
  try {
    console.log(`Devector: Compilation succeeded to ${outPath} (${res.output ? res.output.length : 0} bytes) in ${durationMs} ms`);
  } catch (e) {}

  return { success: true, path: outPath, timeMs: durationMs } as any;
}
