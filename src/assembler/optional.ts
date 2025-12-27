import { SourceOrigin } from './types';
import { stripInlineComment } from './utils';

export type OptionalBlock = {
    id: number;
    parent: number | null;
    start: number;
    end: number;
    defs: Set<string>;
    used: boolean;
};

export function applyOptionalBlocks(
  lines: string[],
  origins: SourceOrigin[]
): { lines: string[]; origins: SourceOrigin[]; errors: string[] }
{
  const errors: string[] = [];
  const blocks: OptionalBlock[] = [];
  const lineBlock: number[] = new Array(lines.length).fill(-1);
  const stack: number[] = [];

  const startRegex = /^\.(?:opt|optional)\b/i;
  const endRegex = /^\.(?:endopt|endoptional)\b/i;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = stripInlineComment(lines[i] || '').trim();
    if (startRegex.test(trimmed)) {
      const id = blocks.length;
      blocks.push({ id, parent: stack.length ? stack[stack.length - 1] : null, start: i, end: -1, defs: new Set(), used: false });
      stack.push(id);
      lineBlock[i] = id;
      continue;
    }
    if (endRegex.test(trimmed)) {
      if (!stack.length) {
        errors.push(`.endoptional/.endopt without matching start at line ${i + 1}`);
        continue;
      }
      const id = stack.pop()!;
      blocks[id].end = i;
      lineBlock[i] = id;
      continue;
    }
    if (stack.length) {
      lineBlock[i] = stack[stack.length - 1];
    }
  }

  if (stack.length) {
    for (const id of stack.reverse()) {
      errors.push(`Missing .endoptional/.endopt for block starting at line ${blocks[id].start + 1}`);
    }
  }

  if (!blocks.length) return { lines, origins, errors };

  // Collect definitions inside blocks (labels and equates)
  for (let i = 0; i < lines.length; i++) {
    const b = lineBlock[i];
    if (b === -1) continue;
    const line = stripInlineComment(lines[i]).trim();
    if (!line || startRegex.test(line) || endRegex.test(line)) continue;

    const labelMatch = line.match(/^\s*([@A-Za-z_][A-Za-z0-9_@.]*)\s*:/);
    if (labelMatch) {
      blocks[b].defs.add(labelMatch[1]);
      continue;
    }

    const equMatch = line.match(/^\s*([@A-Za-z_][A-Za-z0-9_@.]*)\s*:?(?:=|EQU)\b/);
    if (equMatch) {
      blocks[b].defs.add(equMatch[1]);
    }
  }

  const defToBlock = new Map<string, number>();
  for (const blk of blocks) {
    for (const d of blk.defs) {
      if (!defToBlock.has(d)) defToBlock.set(d, blk.id);
    }
  }

  // Scan for external references to those defs
  const identRe = /[@A-Za-z_][A-Za-z0-9_@.]*/g;
  for (let i = 0; i < lines.length; i++) {
    const currentBlock = lineBlock[i];
    const line = stripInlineComment(lines[i]);
    if (!line) continue;
    // Skip block markers
    if (startRegex.test(line) || endRegex.test(line)) continue;

    let m: RegExpExecArray | null;
    identRe.lastIndex = 0;
    while ((m = identRe.exec(line)) !== null) {
      const name = m[0];
      const defBlock = defToBlock.get(name);
      if (defBlock === undefined) continue;
      if (defBlock === currentBlock) continue;
      // Mark block as externally used and propagate to parents
      let b = defBlock;
      while (b !== null && b !== undefined && b >= 0) {
        if (blocks[b].used) {
          b = blocks[b].parent ?? -1;
          continue;
        }
        blocks[b].used = true;
        b = blocks[b].parent ?? -1;
      }
    }
  }

  // Filter out unused optional blocks; always drop the marker lines themselves
  const outLines: string[] = [];
  const outOrigins: SourceOrigin[] = [];
  for (let i = 0; i < lines.length; i++) {
    const b = lineBlock[i];
    if (b === -1) {
      outLines.push(lines[i]);
      outOrigins.push(origins[i]);
      continue;
    }
    const isMarker = startRegex.test(stripInlineComment(lines[i]).trim()) || endRegex.test(stripInlineComment(lines[i]).trim());
    if (!blocks[b].used) {
      // Skip entirely
      continue;
    }
    if (isMarker) continue; // drop marker lines even when kept
    outLines.push(lines[i]);
    outOrigins.push(origins[i]);
  }

  return { lines: outLines, origins: outOrigins, errors };
}
