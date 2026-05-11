import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DiffHunk, FileContext } from './types.js';

export async function getGitDiff(arg?: string): Promise<string> {
  let cmd = '';

  if (!arg) cmd = 'git diff --cached';
  else if (arg.includes('...') || arg.includes('..')) cmd = `git diff ${arg}`;
  else cmd = `git diff -- ${arg}`;

  return execSync(cmd, { encoding: 'utf8' });
}

export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diff.split('\n');

  let currentFile = '';
  let hunkLines: string[] = [];
  let oldStart = 0, oldLines = 0, newStart = 0, newLines = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = / b\/(.*)$/.exec(line);
      if (match) currentFile = match[1];
    }

    else if (line.startsWith('@@')) {
      if (hunkLines.length && currentFile) {
        hunks.push({ file: currentFile, oldStart, oldLines, newStart, newLines, lines: hunkLines });
        hunkLines = [];
      }

      const m = /@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(line);
      if (m) {
        oldStart = +m[1];
        oldLines = +m[2];
        newStart = +m[3];
        newLines = +m[4];
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

export function extractFileContexts(hunks: DiffHunk[], contextLines = 100): FileContext[] {
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

    for (const lineNum of changedLines) {
      const preStart = Math.max(0, lineNum - 1 - contextLines);
      const postEnd = Math.min(fileLines.length, lineNum + contextLines);

      result.push({
        file,
        preContext: fileLines.slice(preStart, lineNum - 1),
        postContext: fileLines.slice(lineNum, postEnd),
        changedLines: [lineNum]
      });
    }
  }

  return result;
}