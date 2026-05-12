import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DiffHunk, FileContext } from './types.js';

export async function getGitDiff(arg?: string): Promise<string> {
  let cmd = '';

  if (!arg) {
    cmd = 'git diff --cached';
    return execSync(cmd, { encoding: 'utf8' });
  }

  // Defensive: ensure arg is string before using .includes
  if (typeof arg === 'string' && (arg.includes('...') || arg.includes('..'))) {
    cmd = `git diff ${arg}`;
    return execSync(cmd, { encoding: 'utf8' });
  }

  // File diff mode: git diff -- <file>
  cmd = `git diff -- "${arg}"`;
  let output = execSync(cmd, { encoding: 'utf8' });
  if (!output.trim()) {
    // Fallback: git diff HEAD -- <file>
    cmd = `git diff HEAD -- "${arg}"`;
    output = execSync(cmd, { encoding: 'utf8' });
  }
  return output;
}

export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diff.split('\n');

  let currentFile = '';
  let hunkLines: string[] = [];
  let oldStart = 0, oldLines = 0, newStart = 0, newLines = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (hunkLines.length && currentFile) {
        hunks.push({ file: currentFile, oldStart, oldLines, newStart, newLines, lines: hunkLines });
        hunkLines = [];
      }
      const match = / b\/(.*)$/.exec(line);
      if (match) currentFile = match[1];
    }

    else if (line.startsWith('@@')) {
      if (hunkLines.length && currentFile) {
        hunks.push({ file: currentFile, oldStart, oldLines, newStart, newLines, lines: hunkLines });
        hunkLines = [];
      }

      const m = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        oldStart = +m[1];
        oldLines = m[2] !== undefined ? +m[2] : 1;
        newStart = +m[3];
        newLines = m[4] !== undefined ? +m[4] : 1;
      }
    }

    else if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
      hunkLines.push(line);
    }
  }

  if (hunkLines.length && currentFile) {
    hunks.push({ file: currentFile, oldStart, oldLines, newStart, newLines, lines: hunkLines });
  }

  return hunks;
}

const CONTEXT_LINES = 8;

export function extractFileContexts(hunks: DiffHunk[]): FileContext[] {
  const result: FileContext[] = [];
  const fileToChangedLines: Record<string, Set<number>> = {};

  for (const hunk of hunks) {
    if (!fileToChangedLines[hunk.file]) fileToChangedLines[hunk.file] = new Set();

    let newLineNum = hunk.newStart;

    for (const l of hunk.lines) {
      if (l.startsWith('+') && !l.startsWith('+++')) {
        fileToChangedLines[hunk.file].add(newLineNum);
      }
      if (!l.startsWith('-')) newLineNum++;
    }
  }

  for (const file in fileToChangedLines) {
    let filePath = file;

    if (!fs.existsSync(filePath)) {
      filePath = path.join(process.cwd(), file);
      if (!fs.existsSync(filePath)) continue;
    }

    const fileLines = fs.readFileSync(filePath, 'utf8').split('\n');
    const changedLines = Array.from(fileToChangedLines[file]).sort((a, b) => a - b);

    // Build initial ranges around each changed line
    type RangeBlock = { start: number; end: number; lines: number[] };
    const ranges: RangeBlock[] = [];
    for (const lineNum of changedLines) {
      const start = Math.max(0, lineNum - 1 - CONTEXT_LINES);
      const end = Math.min(fileLines.length, lineNum + CONTEXT_LINES);
      ranges.push({ start, end, lines: [lineNum] });
    }

    // Merge overlapping or touching ranges
    const merged: RangeBlock[] = [];
    for (const range of ranges) {
      if (merged.length > 0) {
        const last = merged[merged.length - 1];
        if (range.start <= last.end) {
          last.end = Math.max(last.end, range.end);
          last.lines.push(...range.lines);
          continue;
        }
      }
      merged.push({ start: range.start, end: range.end, lines: [...range.lines] });
    }

    // Generate one FileContext per merged range
    for (const block of merged) {
      const sortedChanged = [...new Set(block.lines)].sort((a, b) => a - b);
      const minChanged = sortedChanged[0];
      const maxChanged = sortedChanged[sortedChanged.length - 1];

      result.push({
        file,
        preContext: fileLines.slice(block.start, minChanged - 1),
        postContext: fileLines.slice(maxChanged, block.end),
        changedLines: sortedChanged
      });
    }
  }

  const aggregated = new Map<string, FileContext>();

  for (const ctx of result) {
    if (!aggregated.has(ctx.file)) {
      aggregated.set(ctx.file, {
        file: ctx.file,
        changedLines: [...ctx.changedLines],
        preContext: [...ctx.preContext],
        postContext: [...ctx.postContext],
      });
      continue;
    }

    const existing = aggregated.get(ctx.file)!;

    // merge changedLines
    existing.changedLines = Array.from(
      new Set([...existing.changedLines, ...ctx.changedLines])
    ).sort((a, b) => a - b);

    // merge preContext (dedupe, preserve order)
    const preSet = new Set(existing.preContext);
    for (const line of ctx.preContext) {
      if (!preSet.has(line)) {
        preSet.add(line);
        existing.preContext.push(line);
      }
    }

    // merge postContext (dedupe, preserve order)
    const postSet = new Set(existing.postContext);
    for (const line of ctx.postContext) {
      if (!postSet.has(line)) {
        postSet.add(line);
        existing.postContext.push(line);
      }
    }
  }

  return Array.from(aggregated.values());
}