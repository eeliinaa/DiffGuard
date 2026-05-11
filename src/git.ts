import { DiffHunk, FileContext } from './types';
export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diff.split('\n');
  let currentFile = '';
  let hunkLines: string[] = [];
  let oldStart = 0, oldLines = 0, newStart = 0, newLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git')) {
      const match = / b\/(.*)$/.exec(line);
      if (match) currentFile = match[1];
    } else if (line.startsWith('@@')) {
      if (hunkLines.length && currentFile) {
        hunks.push({ file: currentFile, oldStart, oldLines, newStart, newLines, lines: hunkLines });
        hunkLines = [];
      }
      const m = /@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(line);
      if (m) {
        oldStart = parseInt(m[1], 10);
        oldLines = parseInt(m[2], 10);
        newStart = parseInt(m[3], 10);
        newLines = parseInt(m[4], 10);
      }
    } else if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
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
      const preContext = fileLines.slice(preStart, lineNum - 1);
      const postContext = fileLines.slice(lineNum, postEnd);
      result.push({ file, preContext, postContext, changedLines: [lineNum] });
    }
  }
  return result;
}
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DiffHunk, FileContext } from './types';

// Extract git diff for staged, diff range, or file
export async function getGitDiff(arg?: string): Promise<string> {
  let cmd = '';
  if (!arg) {
    // staged
    cmd = 'git diff --cached';
  } else if (arg.includes('...') || arg.includes('..')) {
    // diff range
    cmd = `git diff ${arg}`;
  } else {
    // single file
    cmd = `git diff ${arg}`;
  }
  try {
    const out = execSync(cmd, { encoding: 'utf8' });
    return out;
  } catch (err) {
    throw new Error(`Failed to run git diff: ${err}`);
  }
}

// Minimal unified diff parser: returns array of DiffHunk objects
export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diff.split('\n');
  let currentFile = '';
  let hunkLines: string[] = [];
  let oldStart = 0, oldLines = 0, newStart = 0, newLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git')) {
      // New file
      const match = / b\/(.*)$/.exec(line);
      if (match) currentFile = match[1];
    } else if (line.startsWith('@@')) {
      // Flush previous hunk
      if (hunkLines.length && currentFile) {
        hunks.push({ file: currentFile, oldStart, oldLines, newStart, newLines, lines: hunkLines });
        hunkLines = [];
      }
      // Parse hunk header
      const m = /@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(line);
      if (m) {
        oldStart = parseInt(m[1], 10);
        oldLines = parseInt(m[2], 10);
        newStart = parseInt(m[3], 10);
        newLines = parseInt(m[4], 10);
      }
    } else if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
      hunkLines.push(line);
    }
  }
  // Last hunk
  if (hunkLines.length && currentFile) {
    hunks.push({ file: currentFile, oldStart, oldLines, newStart, newLines, lines: hunkLines });
  }
  return hunks;
}

// Extract file context (±contextLines) for each changed line in each file
export function extractFileContexts(hunks: DiffHunk[], contextLines = 100): FileContext[] {
  const result: FileContext[] = [];
  const fileToChangedLines: Record<string, Set<number>> = {};
  // Collect changed lines per file
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
  // For each file, extract context
  for (const file in fileToChangedLines) {
    let filePath = file;
    if (!fs.existsSync(filePath)) {
      // Try relative to cwd
      filePath = path.join(process.cwd(), file);
      if (!fs.existsSync(filePath)) continue;
    }
    const fileLines = fs.readFileSync(filePath, 'utf8').split('\n');
    const changedLines = Array.from(fileToChangedLines[file]).sort((a, b) => a - b);
    // For each changed line, extract context
    for (const lineNum of changedLines) {
      const preStart = Math.max(0, lineNum - 1 - contextLines);
      const postEnd = Math.min(fileLines.length, lineNum + contextLines);
      const preContext = fileLines.slice(preStart, lineNum - 1);
      const postContext = fileLines.slice(lineNum, postEnd);
      result.push({ file, preContext, postContext, changedLines: [lineNum] });
    }
  }
  return result;
}
