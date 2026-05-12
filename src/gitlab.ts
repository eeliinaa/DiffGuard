// GitLab API integration (PAT auth, inline MR discussions, fallback notes)
import axios from 'axios';
import {
  AIReviewResult,
  FileContext,
  GitLabConfig,
  GitLabDiffPosition,
  GitLabInlinePosition,
  GitLabMRVersion,
  MRDiffResult,
  MRPositionMap,
  ResolveContext,
  ResolvedPositionProvider,
  ReviewComment,
} from './types.js';

const MAX_NOTE_SIZE = 1_000_000;
const TRUNCATION_SUFFIX = '\n\n*(truncated — exceeded GitLab note size limit)*';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** djb2 hash — deterministic 8-char hex used for body markers. */
function djb2Hash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  return hash.toString(16).padStart(8, '0');
}

function truncateBody(body: string): string {
  if (body.length <= MAX_NOTE_SIZE) {
    return body;
  }
  const limit = MAX_NOTE_SIZE - TRUNCATION_SUFFIX.length;
  const lines = body.split('\n');
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    // +1 for the newline that join('\n') adds between lines
    const added = (kept.length === 0 ? 0 : 1) + line.length;
    if (length + added > limit) break;
    kept.push(line);
    length += added;
  }
  return kept.join('\n') + TRUNCATION_SUFFIX;
}

// ---------------------------------------------------------------------------
// Dedupe keys
// ---------------------------------------------------------------------------

/**
 * Normalized semantic key for an inline discussion.
 * Stable across minor AI wording changes (whitespace, casing).
 */
function buildInlineDedupeKey(comment: ReviewComment, snappedLine: number): string {
  const normalizedMessage = comment.message.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${comment.file}:${snappedLine}:${comment.ruleId ?? 'no-rule'}:${normalizedMessage}`;
}

/**
 * Stable hash over the full set of fallback comments, order-independent.
 * Used to prevent reposting identical fallback summary notes on reruns.
 */
function buildFallbackHash(comments: ReviewComment[]): string {
  const entries = comments
    .map(c => {
      const msg = c.message.toLowerCase().replace(/\s+/g, ' ').trim();
      return `${c.file}:${c.lineHint ?? 'null'}:${c.ruleId ?? 'no-rule'}:${msg}`;
    })
    .sort();
  return djb2Hash(entries.join('|'));
}

// ---------------------------------------------------------------------------
// Body formatters
// ---------------------------------------------------------------------------

function formatInlineBody(comment: ReviewComment, snappedLine: number): string {
  const lines: string[] = [];
  lines.push(`[${comment.severity.toUpperCase()}]`);
  lines.push(comment.message);
  if (snappedLine !== comment.lineHint) {
    lines.push(`(Detected near line ${comment.lineHint}.)`);
  }
  lines.push('');
  lines.push('Suggestion:');
  lines.push(comment.suggestion);
  if (comment.ruleId) {
    lines.push('');
    lines.push('Rule:');
    lines.push(comment.ruleId);
  }
  return lines.join('\n');
}

function buildFallbackNoteBody(
  comments: ReviewComment[],
  overallSummary: string,
  hash: string,
): string {
  const byFile = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    const existing = byFile.get(comment.file) ?? [];
    existing.push(comment);
    byFile.set(comment.file, existing);
  }

  const sections: string[] = [];
  for (const [file, fileComments] of byFile) {
    const lines = [`### ${file}`];
    for (const c of fileComments) {
      lines.push(`- [${c.severity}]: ${c.message}`);
      lines.push(`  suggestion: ${c.suggestion}`);
    }
    sections.push(lines.join('\n'));
  }

  const body =
    sections.length > 0
      ? `${overallSummary}\n\n${sections.join('\n\n')}`
      : overallSummary;

  return `${body}\n\n[DiffGuard Summary Hash: ${hash}]`;
}

// ---------------------------------------------------------------------------
// GitLab API: fetch MR diff version metadata
// ---------------------------------------------------------------------------

export async function fetchMRVersion(config: GitLabConfig): Promise<GitLabMRVersion> {
  const apiBase = `${config.baseUrl}/api/v4`;
  const url = `${apiBase}/projects/${encodeURIComponent(config.projectId)}/merge_requests/${config.mrIid}/versions`;
  const response = await axios.get<
    Array<{
      base_commit_sha: string;
      start_commit_sha: string;
      head_commit_sha: string;
      created_at: string;
    }>
  >(url, { headers: { 'PRIVATE-TOKEN': config.token } });

  const versions = response.data;
  if (!versions || versions.length === 0) {
    throw new Error('GitLab versions API returned empty array');
  }

  // Sort descending by created_at — explicit, safe across self-hosted instances
  const sorted = [...versions].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const latest = sorted[0];

  if (!latest.base_commit_sha || !latest.start_commit_sha || !latest.head_commit_sha) {
    throw new Error('GitLab versions API returned incomplete SHA data');
  }

  return {
    base_sha: latest.base_commit_sha,
    start_sha: latest.start_commit_sha,
    head_sha: latest.head_commit_sha,
  };
}

// ---------------------------------------------------------------------------
// GitLab API: fetch existing inline discussion keys (cross-run dedupe)
// ---------------------------------------------------------------------------

export async function fetchExistingDiscussionKeys(config: GitLabConfig): Promise<Set<string>> {
  const apiBase = `${config.baseUrl}/api/v4`;
  const keys = new Set<string>();
  try {
    const url = `${apiBase}/projects/${encodeURIComponent(config.projectId)}/merge_requests/${config.mrIid}/discussions`;
    const response = await axios.get<Array<{ notes: Array<{ body: string }> }>>(url, {
      headers: { 'PRIVATE-TOKEN': config.token },
    });
    const marker = /\[DiffGuardKey:([^\]]+)\]/;
    for (const discussion of response.data) {
      for (const note of discussion.notes ?? []) {
        const match = marker.exec(note.body);
        if (match) {
          keys.add(match[1]);
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[DiffGuard] Warning: could not fetch existing discussions for dedupe: ${message}`,
    );
  }
  return keys;
}

// ---------------------------------------------------------------------------
// GitLab API: fetch existing fallback note hashes (cross-run dedupe)
// ---------------------------------------------------------------------------

export async function fetchExistingNoteHashes(config: GitLabConfig): Promise<Set<string>> {
  const apiBase = `${config.baseUrl}/api/v4`;
  const hashes = new Set<string>();
  try {
    const url = `${apiBase}/projects/${encodeURIComponent(config.projectId)}/merge_requests/${config.mrIid}/notes`;
    const response = await axios.get<Array<{ body: string }>>(url, {
      headers: { 'PRIVATE-TOKEN': config.token },
    });
    const marker = /\[DiffGuard Summary Hash: ([a-f0-9]+)\]/;
    for (const note of response.data) {
      const match = marker.exec(note.body);
      if (match) {
        hashes.add(match[1]);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[DiffGuard] Warning: could not fetch existing notes for dedupe: ${message}`);
  }
  return hashes;
}

// ---------------------------------------------------------------------------
// Position providers — pluggable strategy for resolving inline comment positions
// ---------------------------------------------------------------------------

/**
 * Local-mode provider: snaps comment lineHint to the nearest changed line
 * within ±3 from the FileContext extracted from the local git diff.
 */
export class LocalPositionProvider implements ResolvedPositionProvider {
  constructor(private fileContexts: FileContext[]) {}

  resolve(
    comment: ReviewComment,
    { version }: ResolveContext,
  ): { position: GitLabInlinePosition; snappedLine: number } | null {
    if (comment.lineHint === null) return null;

    const ctx = this.fileContexts.find(fc => fc.file === comment.file);
    if (!ctx) return null;

    const lineHint = comment.lineHint;
    let nearest: number | null = null;
    let nearestDist = Infinity;

    for (const cl of ctx.changedLines) {
      const dist = Math.abs(cl - lineHint);
      if (dist <= 3 && dist < nearestDist) {
        nearest = cl;
        nearestDist = dist;
      }
    }

    if (nearest === null) return null;

    return {
      position: {
        position_type: 'text',
        base_sha: version.base_sha,
        start_sha: version.start_sha,
        head_sha: version.head_sha,
        new_path: comment.file,
        new_line: nearest,
      },
      snappedLine: nearest,
    };
  }
}

/**
 * MR-mode provider: resolves inline position using the native GitLab diff
 * position map (new_line values from /changes API). O(n) scan per file —
 * acceptable given small n (diff lines per file).
 */
export class MRPositionProvider implements ResolvedPositionProvider {
  constructor(private positionMap: MRPositionMap) {}

  resolve(
    comment: ReviewComment,
    { version }: ResolveContext,
  ): { position: GitLabInlinePosition; snappedLine: number } | null {
    if (comment.lineHint === null) return null;

    const positions = this.positionMap.get(comment.file);
    if (!positions || positions.length === 0) return null;

    const lineHint = comment.lineHint;
    let nearest: GitLabDiffPosition | null = null;
    let nearestDist = Infinity;

    for (const pos of positions) {
      const dist = Math.abs(pos.new_line - lineHint);
      if (dist <= 3 && dist < nearestDist) {
        nearest = pos;
        nearestDist = dist;
      }
    }

    if (nearest === null) return null;

    return {
      position: {
        position_type: 'text',
        base_sha: version.base_sha,
        start_sha: version.start_sha,
        head_sha: version.head_sha,
        new_path: nearest.new_path,
        new_line: nearest.new_line,
      },
      snappedLine: nearest.new_line,
    };
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function postGitLabMR(
  result: AIReviewResult,
  config: GitLabConfig,
  provider: ResolvedPositionProvider,
  version: GitLabMRVersion,
  existingState?: { discussionKeys: Set<string>; noteHashes: Set<string> },
): Promise<void> {
  if (result.comments.length === 0) return;

  const apiBase = `${config.baseUrl}/api/v4`;
  const projectPath = `${apiBase}/projects/${encodeURIComponent(config.projectId)}/merge_requests/${config.mrIid}`;

  const existingKeys = new Set<string>(existingState?.discussionKeys);

  const fallback: ReviewComment[] = [];

  for (const comment of result.comments) {
    const positioned = provider.resolve(comment, { version });

    if (!positioned) {
      fallback.push(comment);
      continue;
    }

    const { position, snappedLine } = positioned;
    const key = buildInlineDedupeKey(comment, snappedLine);

    if (existingKeys.has(key)) {
      console.error(`[DiffGuard] Skipping duplicate inline comment: ${key}`);
      continue;
    }

    const body = `${formatInlineBody(comment, snappedLine)}\n[DiffGuardKey:${key}]`;

    try {
      await axios.post(
        `${projectPath}/discussions`,
        { body, position },
        { headers: { 'PRIVATE-TOKEN': config.token } },
      );
      existingKeys.add(key);
      await sleep(150);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[DiffGuard] Warning: failed to post inline comment for ${comment.file}:${comment.lineHint}: ${message}`,
      );
      fallback.push(comment);
    }
  }

  if (fallback.length === 0) return;

  // Fallback summary note with cross-run dedupe
  const hash = buildFallbackHash(fallback);
  const existingHashes = existingState?.noteHashes ?? new Set<string>();

  if (existingHashes.has(hash)) {
    console.error(`[DiffGuard] Skipping duplicate fallback summary note (hash: ${hash})`);
    return;
  }

  const noteBody = truncateBody(buildFallbackNoteBody(fallback, result.summary, hash));

  try {
    await axios.post(
      `${projectPath}/notes`,
      { body: noteBody },
      { headers: { 'PRIVATE-TOKEN': config.token } },
    );
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')) {
      throw new Error('GitLab request timeout');
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`GitLab API error: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// GitLab MR diff fetcher — builds FileContext[] and MRPositionMap from API
// ---------------------------------------------------------------------------

type GitLabDiffEntry = {
  diff: string;
  new_path: string;
  old_path: string;
  deleted_file: boolean;
  too_large: boolean;
};

/**
 * Fetches all changed files from a GitLab MR using the /changes endpoint.
 * Returns FileContext[] for the AI pipeline and an MRPositionMap
 * for native inline comment positioning.
 *
 * MR mode only — never touches local git state.
 */
export async function getMergeRequestFileContexts(config: GitLabConfig): Promise<MRDiffResult> {
  const apiBase = `${config.baseUrl}/api/v4`;
  const positionMap: MRPositionMap = new Map();
  const fileContexts: FileContext[] = [];

  const url = `${apiBase}/projects/${encodeURIComponent(config.projectId)}/merge_requests/${config.mrIid}/changes`;
  const response = await axios.get<{ changes: GitLabDiffEntry[] }>(url, {
    headers: { 'PRIVATE-TOKEN': config.token },
  });
  const allEntries: GitLabDiffEntry[] = response.data.changes ?? [];

  for (const entry of allEntries) {
    // Skip binary / empty diffs
    if (entry.too_large || !entry.diff) continue;

    if (entry.deleted_file) {
      // Include deleted file in AI context only — no positionMap entries
      // (inline comments cannot be placed on deleted-only files)
      const preContext: string[] = [];
      for (const line of entry.diff.split('\n')) {
        if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) continue;
        if (line.startsWith('-')) {
          preContext.push(line.slice(1));
        }
      }
      fileContexts.push({
        file: entry.old_path,
        preContext,
        postContext: [],
        changedLines: [],
        contextType: 'deleted',
      });
      continue;
    }

    // Non-deleted file — parse diff hunk by hunk with strict per-hunk counter reset
    const changedLines: number[] = [];
    const preContextBuffer: string[] = [];
    const postContextBuffer: string[] = [];
    let seenPlus = false;
    let newLineNum = 0;
    let oldLineNum = 0;

    for (const line of entry.diff.split('\n')) {
      if (line.startsWith('@@')) {
        // Reset both counters per hunk (symmetric) — prevents drift in renamed/moved hunks
        const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (m) {
          oldLineNum = parseInt(m[1], 10);
          newLineNum = parseInt(m[2], 10);
        }
        continue;
      }

      // Skip diff file header lines (present in some API responses)
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
        continue;
      }

      if (line.startsWith('+')) {
        changedLines.push(newLineNum);
        const existing = positionMap.get(entry.new_path) ?? [];
        existing.push({ new_line: newLineNum, new_path: entry.new_path });
        positionMap.set(entry.new_path, existing);
        // Clear postContextBuffer — lines accumulated between two change blocks
        // are not true "post context" if more changes follow
        if (seenPlus) postContextBuffer.length = 0;
        seenPlus = true;
        newLineNum++;
      } else if (line.startsWith('-')) {
        // Deletion: advance old-file counter only; include in preContext if before first addition
        oldLineNum++;
        if (!seenPlus) {
          preContextBuffer.push(line.slice(1));
        }
      } else if (line.startsWith(' ')) {
        // Context line: advance both counters symmetrically
        newLineNum++;
        oldLineNum++;
        if (!seenPlus) {
          preContextBuffer.push(line.slice(1));
        } else {
          postContextBuffer.push(line.slice(1));
        }
      }
    }

    fileContexts.push({
      file: entry.new_path,
      preContext: preContextBuffer,
      postContext: postContextBuffer,
      changedLines,
      contextType: 'changed',
    });
  }

  console.error(`[DiffGuard] Fetched ${fileContexts.length} file(s) from GitLab MR changes`);
  return { fileContexts, positionMap };
}

