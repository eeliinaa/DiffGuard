import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DiffHunk, FileContext } from './types.js';

export async function getGitDiff(arg?: string): Promise<string> {
  if (!arg) {
    // No user-supplied input — safe to use execSync directly
    return execSync('git diff --cached', { encoding: 'utf8' });
  }

  // Branch range: git diff <ref>..<ref> or <ref>...<ref>
  if (arg.includes('...') || arg.includes('..')) {
    const result = spawnSync('git', ['diff', arg], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git diff failed: ${result.stderr}`);
    }
    return result.stdout;
  }

  // File diff mode — use spawnSync to prevent command injection
  let result = spawnSync('git', ['diff', '--', arg], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git diff failed: ${result.stderr}`);
  }
  if (!result.stdout.trim()) {
    // Fallback: git diff HEAD -- <file>
    result = spawnSync('git', ['diff', 'HEAD', '--', arg], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git diff HEAD failed: ${result.stderr}`);
    }
  }
  return result.stdout;
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

// ---------------------------------------------------------------------------
// chunkFileContexts — split a large FileContext into smaller chunks
// ---------------------------------------------------------------------------

/**
 * Trims preContext and postContext of a chunk until its JSON-serialized size
 * fits within maxTokenChars. Trims from the outermost lines, preferring to
 * trim the longer side first, until the budget is met or context is exhausted.
 */
function trimContextToFit(chunk: FileContext, maxTokenChars: number): FileContext {
  if (JSON.stringify(chunk).length <= maxTokenChars) return chunk;

  let pre = chunk.preContext.slice();
  let post = chunk.postContext.slice();

  while (pre.length > 0 || post.length > 0) {
    if (JSON.stringify({ ...chunk, preContext: pre, postContext: post }).length <= maxTokenChars) {
      break;
    }
    // Trim the longer side first; tie-break by trimming post
    if (pre.length > post.length) {
      pre = pre.slice(1);
    } else if (post.length > 0) {
      post = post.slice(0, -1);
    } else {
      pre = pre.slice(1);
    }
  }

  return { ...chunk, preContext: pre, postContext: post };
}

/**
 * Splits a single FileContext into multiple smaller chunks so that no AI
 * request exceeds the size limits:
 *   - maxLines:      max number of changedLines per chunk (default: 300)
 *   - maxTokenChars: max JSON-serialized size in chars (~12k tokens = 48_000)
 *
 * Both limits are hard — whichever is hit first triggers a split.
 *
 * Splitting strategy:
 *   - changedLines are grouped greedily in blocks of at most maxLines.
 *   - If the file is readable from disk (local mode), each chunk gets a fresh
 *     ±8-line context window around its own changed lines.
 *   - If the file is not on disk (MR mode), the original pre/postContext is
 *     reused for ALL chunks so that every AI request has surrounding context.
 *   - After building each chunk, trimContextToFit enforces the token limit by
 *     trimming context lines if the chunk is still oversized.
 *
 * Returns [ctx] (possibly trimmed) when the input is already within limits or
 * cannot be split further by changed-line groups.
 */
export function chunkFileContexts(
  ctx: FileContext,
  maxLines: number,
  maxTokenChars: number,
): FileContext[] {
  // Fast path: already within both limits
  if (
    ctx.changedLines.length <= maxLines &&
    JSON.stringify(ctx).length <= maxTokenChars
  ) {
    return [ctx];
  }

  // Deleted files / zero changed lines — split by lines impossible; trim context to fit
  if (ctx.changedLines.length === 0) {
    return [trimContextToFit(ctx, maxTokenChars)];
  }

  // Build groups of at most maxLines changed lines each
  const groups: number[][] = [];
  for (let i = 0; i < ctx.changedLines.length; i += maxLines) {
    groups.push(ctx.changedLines.slice(i, i + maxLines));
  }

  if (groups.length <= 1) {
    // Single group (≤maxLines changed lines) but still over token budget.
    // Cannot split further by line groups — trim context to fit instead.
    return [trimContextToFit(ctx, maxTokenChars)];
  }

  // Attempt to read file from disk for accurate per-chunk context
  let fileLines: string[] | null = null;
  for (const candidate of [ctx.file, path.join(process.cwd(), ctx.file)]) {
    if (fs.existsSync(candidate)) {
      fileLines = fs.readFileSync(candidate, 'utf8').split('\n');
      break;
    }
  }

  return groups.map((groupLines): FileContext => {
    let chunk: FileContext;

    if (fileLines) {
      // Local mode: rebuild accurate ±CONTEXT_LINES window for this chunk
      const minChanged = groupLines[0];
      const maxChanged = groupLines[groupLines.length - 1];
      const start = Math.max(0, minChanged - 1 - CONTEXT_LINES);
      const end = Math.min(fileLines.length, maxChanged + CONTEXT_LINES);
      chunk = {
        file: ctx.file,
        preContext: fileLines.slice(start, minChanged - 1),
        postContext: fileLines.slice(maxChanged, end),
        changedLines: groupLines,
        contextType: ctx.contextType,
      };
    } else {
      // MR mode: reuse the original pre/postContext for every chunk so all
      // AI requests receive surrounding context (not just boundary chunks).
      // trimContextToFit below will reduce it per-chunk if still oversized.
      chunk = {
        file: ctx.file,
        preContext: ctx.preContext,
        postContext: ctx.postContext,
        changedLines: groupLines,
        contextType: ctx.contextType,
      };
    }

    return trimContextToFit(chunk, maxTokenChars);
  });
}