const fs = require('fs');
const path = require('path');

function walkDir(dir, filelist = []) {
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walkDir(full, filelist);
    else filelist.push(full);
  }
  return filelist;
}

function findAsmFiles(root) {
  return walkDir(root).filter(f => f.toLowerCase().endsWith('.asm'));
}

// Expand .include directives (up to 16) and return lines + origins like the assembler
function processContent(filePath, depth = 0) {
  if (depth > 16) throw new Error(`Include recursion too deep when processing ${filePath}`);
  const text = fs.readFileSync(filePath, 'utf8');
  const srcLines = text.split(/\r?\n/);
  const outLines = [];
  const origins = [];
  for (let i = 0; i < srcLines.length; i++) {
    const raw = srcLines[i];
    const trimmed = raw.replace(/;.*$/, '').trim();
    const m = trimmed.match(/^\.include\s+["']([^"']+)["']/i);
    if (m) {
      let inc = m[1];
      let incPath = inc;
      if (!path.isAbsolute(incPath)) {
        const baseDir = path.dirname(filePath);
        incPath = path.resolve(baseDir, incPath);
      }
      try {
        const nested = processContent(incPath, depth + 1);
        for (let k = 0; k < nested.lines.length; k++) {
          outLines.push(nested.lines[k]);
          origins.push(nested.origins[k]);
        }
      } catch (err) {
        // If include fails, record the line as-is and origin
        outLines.push(raw);
        origins.push({ file: filePath, line: i + 1 });
      }
      continue;
    }
    outLines.push(raw);
    origins.push({ file: filePath, line: i + 1 });
  }
  return { lines: outLines, origins };
}

function main() {
  const root = process.cwd();
  const asmFiles = findAsmFiles(root);
  const occurrences = new Map();

  for (const f of asmFiles) {
    let expanded;
    try {
      expanded = processContent(f, 0);
    } catch (err) {
      // fallback: treat file as single source
      const text = fs.readFileSync(f, 'utf8');
      expanded = { lines: text.split(/\r?\n/), origins: text.split(/\r?\n/).map((l, idx) => ({ file: f, line: idx + 1 })) };
    }

    const lines = expanded.lines;
    const origins = expanded.origins;

    // localsIndex: scopeKey -> (localName -> array of { key, line }) ordered by appearance
    const localsIndex = new Map();
    let directiveCounter = 0;

    function getFileKey(orig) {
      return orig && orig.file ? path.resolve(orig.file) : path.resolve(f);
    }
    function getScopeKey(orig) {
      return getFileKey(orig) + '::' + directiveCounter;
    }

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const withoutComments = raw.replace(/;.*$/, '');
      if (!withoutComments.trim()) continue;

      // record current scope key for this line (before any .org on this line takes effect)
      const orig = origins[i];
      const scopeKey = getScopeKey(orig);

      // handle optional leading label (either with colon or bare before an opcode/directive)
      const tokens = withoutComments.trim().split(/\s+/);
      let labelHere = null;
      if (tokens[0].endsWith(':')) {
        labelHere = tokens[0].slice(0, -1);
      } else if (tokens.length >= 2 && /^\.?org$/i.test(tokens[1])) {
        labelHere = tokens[0];
      }

      const op = tokens[0].toUpperCase();

      if (labelHere) {
        if (labelHere[0] === '@') {
          const localName = labelHere.slice(1);
          let fileMap = localsIndex.get(scopeKey);
          if (!fileMap) { fileMap = new Map(); localsIndex.set(scopeKey, fileMap); }
          let arr = fileMap.get(localName);
          if (!arr) { arr = []; fileMap.set(localName, arr); }
          const id = arr.length;
          const key = '@' + localName + '_' + id;
          arr.push({ key, line: orig ? orig.line : i + 1 });
          const info = { name: key, file: orig && orig.file ? orig.file : f, line: orig ? orig.line : i + 1, text: raw.trim() };
          if (!occurrences.has(key)) occurrences.set(key, []);
          // avoid recording the same origin twice (can happen if a file is included and also scanned directly)
          const arrOcc = occurrences.get(key);
          if (!arrOcc.some(it => it.file === info.file && it.line === info.line)) arrOcc.push(info);
        } else {
          const key = labelHere;
          const info = { name: key, file: orig && orig.file ? orig.file : f, line: orig ? orig.line : i + 1, text: raw.trim() };
          if (!occurrences.has(key)) occurrences.set(key, []);
          const arrOcc = occurrences.get(key);
          if (!arrOcc.some(it => it.file === info.file && it.line === info.line)) arrOcc.push(info);
        }
      }

      // If this line is an .org directive, it creates a new (narrower) scope for following labels.
      if (/^\.?org$/i.test(op) || /^\.ORG$/i.test(op)) {
        directiveCounter++;
        // handle case where there was a bare label before .org: assembler registers it in the new scope
        if (labelHere) {
          const newScopeKey = getFileKey(orig) + '::' + directiveCounter;
          if (labelHere[0] === '@') {
            const localName = labelHere.slice(1);
            let fileMap = localsIndex.get(newScopeKey);
            if (!fileMap) { fileMap = new Map(); localsIndex.set(newScopeKey, fileMap); }
            let arr = fileMap.get(localName);
            if (!arr) { arr = []; fileMap.set(localName, arr); }
            const id = arr.length;
            const key = '@' + localName + '_' + id;
            arr.push({ key, line: orig ? orig.line : i + 1 });
            const info = { name: key, file: orig && orig.file ? orig.file : f, line: orig ? orig.line : i + 1, text: raw.trim() };
            if (!occurrences.has(key)) occurrences.set(key, []);
            occurrences.get(key).push(info);
          } else {
            const key = labelHere;
            const info = { name: key, file: orig && orig.file ? orig.file : f, line: orig ? orig.line : i + 1, text: raw.trim() };
            if (!occurrences.has(key)) occurrences.set(key, []);
            occurrences.get(key).push(info);
          }
        }
      }
    }
  }

  // Filter duplicates (more than one occurrence)
  const dupKeys = Array.from(occurrences.keys()).filter(k => occurrences.get(k).length > 1);
  if (!dupKeys.length) return;

  for (const k of dupKeys) {
    const items = occurrences.get(k);
    console.log(`Duplicated label: ${k} (total ${items.length})`);
    for (const it of items) {
      console.log(`  ${it.file}:${it.line}: ${it.text}`);
    }
    console.log('');
  }
}

main();
