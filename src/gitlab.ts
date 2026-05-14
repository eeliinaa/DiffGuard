// GitLab API integration (PAT auth, inline MR discussions, fallback notes)
import axios from 'axios';
import {
  AIReviewResult,
  FileContext,
  GitLabConfig,
  GitLabDiffPosition,
  GitLabInlinePosition,
  GitLabMRVersion,
  InlineMRIssue,
  MRDiffResult,
  MRPositionMap,
  ResolveContext,
  ResolvedPositionProvider,
  ReviewComment,
} from './types.js';
import { buildFanOutQueue, FanOutItem, validateFanOutIntegrity } from './gitlab/fanout.js';
import { clusterComments, clusteredToReviewComment } from './gitlab/clustering.js';
import { validateAndRepairPosition, validateGitLabPosition } from './gitlab/positionValidator.js';

const INLINE_SNAP_TOLERANCE = 3; // lines
const POST_RATE_LIMIT_DELAY_MS = 120;
const AXIOS_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function validateGitLabBaseUrl(config: GitLabConfig): void {
  const { baseUrl, allowInsecureHttp } = config;
  if (baseUrl.startsWith('https://')) return;
  const hostname = (() => {
    try { return new URL(baseUrl).hostname; } catch { return ''; }
  })();
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('192.168.')
  ) return;
  if (allowInsecureHttp === true) return;
  throw new Error(`[DiffGuard] Insecure baseUrl — HTTPS required: ${baseUrl}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Body formatters
// ---------------------------------------------------------------------------

function formatInlineBody(comment: ReviewComment, snappedLine: number): string {
  const lines: string[] = [];
  lines.push(`[${comment.severity.toUpperCase()}]`);
  lines.push('');
  lines.push('Violating statement:');
  lines.push(`\`${comment.violatingStatement}\``);
  lines.push('');
  lines.push('Why it violates:');
  lines.push(comment.message);
  if (comment.executionPath) {
    lines.push('');
    lines.push('Execution path:');
    lines.push(comment.executionPath);
  }
  if (comment.lineHint != null && snappedLine !== comment.lineHint) {
    lines.push(`(Detected near line ${comment.lineHint}.)`);
  }
  lines.push('');
  lines.push('Fix:');
  lines.push(comment.suggestion);
  if (comment.ruleId) {
    lines.push('');
    lines.push('Rule:');
    lines.push(comment.ruleId);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// GitLab API: fetch MR diff version metadata
// ---------------------------------------------------------------------------

export async function fetchMRVersion(config: GitLabConfig): Promise<GitLabMRVersion> {
  validateGitLabBaseUrl(config);
  const apiBase = `${config.baseUrl}/api/v4`;
  const url = `${apiBase}/projects/${encodeURIComponent(config.projectId)}/merge_requests/${config.mrIid}/versions`;
  const response = await axios.get<
    Array<{
      base_commit_sha: string;
      start_commit_sha: string;
      head_commit_sha: string;
      created_at: string;
    }>
  >(url, { headers: { 'PRIVATE-TOKEN': config.token }, timeout: AXIOS_TIMEOUT_MS });

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
  validateGitLabBaseUrl(config);
  const apiBase = `${config.baseUrl}/api/v4`;
  const keys = new Set<string>();
  try {
    const baseUrl = `${apiBase}/projects/${encodeURIComponent(config.projectId)}/merge_requests/${config.mrIid}/discussions`;
    const marker = /\[DiffGuardKey:([^\]]+)\]/;
    let page = 1;
    while (true) {
      const response = await axios.get<Array<{ notes: Array<{ body: string }> }>>(baseUrl, {
        headers: { 'PRIVATE-TOKEN': config.token },
        params: { per_page: 100, page },
        timeout: AXIOS_TIMEOUT_MS,
      });
      const discussions = response.data;
      for (const discussion of discussions) {
        for (const note of discussion.notes ?? []) {
          const match = marker.exec(note.body);
          if (match) {
            keys.add(match[1]);
          }
        }
      }
      if (discussions.length < 100) break;
      page++;
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
  validateGitLabBaseUrl(config);
  const apiBase = `${config.baseUrl}/api/v4`;
  const hashes = new Set<string>();
  try {
    const baseUrl = `${apiBase}/projects/${encodeURIComponent(config.projectId)}/merge_requests/${config.mrIid}/notes`;
    const marker = /\[DiffGuard Summary Hash: ([a-f0-9]+)\]/;
    let page = 1;
    while (true) {
      const response = await axios.get<Array<{ body: string }>>(baseUrl, {
        headers: { 'PRIVATE-TOKEN': config.token },
        params: { per_page: 100, page },
        timeout: AXIOS_TIMEOUT_MS,
      });
      const notes = response.data;
      for (const note of notes) {
        const match = marker.exec(note.body);
        if (match) {
          hashes.add(match[1]);
        }
      }
      if (notes.length < 100) break;
      page++;
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
      if (dist <= INLINE_SNAP_TOLERANCE && dist < nearestDist) {
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
    const positions = this.positionMap.get(comment.file);
    if (!positions || positions.length === 0) return null;

    let nearest: GitLabDiffPosition | null = null;
    let nearestDist = Infinity;

    // ─────────────────────────────────────────────
    // 1. PRIORITY: lineHint snapping (if available)
    // ─────────────────────────────────────────────
    if (comment.lineHint !== null && comment.lineHint !== undefined) {
      for (const pos of positions) {
        const dist = Math.abs(pos.new_line - comment.lineHint);
        if (dist <= INLINE_SNAP_TOLERANCE && dist < nearestDist) {
          nearest = pos;
          nearestDist = dist;
        }
      }
    }

    // ─────────────────────────────────────────────
    // 2. FALLBACK: no lineHint or no snap match → first changed line in the file
    // ─────────────────────────────────────────────
    if (nearest === null) {
      nearest = positions[0];
    }

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
// Retry helpers
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS_CODES = [429, 502, 503, 504];

function isRetryable(err: unknown): boolean {
  if (axios.isAxiosError(err) && err.response?.status !== undefined) {
    return RETRYABLE_STATUS_CODES.includes(err.response.status);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function postGitLabMR(
  result: AIReviewResult,
  config: GitLabConfig,
  provider: ResolvedPositionProvider,
  version: GitLabMRVersion,
  existingState?: {
    discussionKeys: Set<string>;
    noteHashes?: Set<string>;
    /** MR diff position map — required for hard-guarantee inline validation. */
    positionMap?: MRPositionMap;
  },
): Promise<void> {
  validateGitLabBaseUrl(config);

  const totalComments = result.comments.length;
  console.error(`[DiffGuard][FANOUT] total AI comments: ${totalComments}`);

  if (totalComments === 0) return;

  const apiBase = `${config.baseUrl}/api/v4`;
  const projectPath = `${apiBase}/projects/${encodeURIComponent(
    config.projectId,
  )}/merge_requests/${config.mrIid}`;

  const existingKeys = new Set(existingState?.discussionKeys);
  const positionMap = existingState?.positionMap;

  // ---------------------------------------------------------
  // STEP 0: SMART CLUSTERING — group AI comments by root cause before posting
  // Reduces GitLab noise: N raw comments → ≤N root-cause comments.
  // ---------------------------------------------------------
  const clusteringResult = clusterComments(result);
  const clusteredResult: AIReviewResult = {
    summary: clusteringResult.summary,
    comments: clusteringResult.comments.map(clusteredToReviewComment),
  };
  const clusteredCount = clusteredResult.comments.length;
  console.error(
    `[DiffGuard][Clustering] ${totalComments} AI comment(s) → ${clusteredCount} cluster(s)`,
  );

  // ---------------------------------------------------------
  // STEP 1: BUILD FAN-OUT QUEUE — 1 AI comment = 1 FanOutItem (integrity enforced)
  // ---------------------------------------------------------
  const fanoutQueue = buildFanOutQueue(clusteredResult, provider, version, existingKeys);
  validateFanOutIntegrity(clusteredCount, fanoutQueue);

  // ---------------------------------------------------------
  // STEP 1.5: HARD GUARANTEE — validate and repair every inline position
  //
  // Applies only when positionMap is available (MR mode).
  // For each inline item:
  //   - VALID   → keep as-is, log [Position][VALID]
  //   - INVALID → attempt repair (snap ±2, or first changed line in file)
  //   - Cannot repair → downgrade to global, log [Position][FALLBACK]
  // ---------------------------------------------------------
  if (positionMap) {
    for (const item of fanoutQueue) {
      if (item.type !== 'inline' || item.position === undefined) continue;

      const validated = validateAndRepairPosition(item.position, positionMap);

      if (validated === null) {
        // No valid position found — downgrade to global
        console.error(
          `[Position][FALLBACK] converted inline → global ` +
          `file=${item.comment.file} original_line=${item.position.new_line}`,
        );
        item.type = 'global';
        item.position = undefined;
      } else {
        // Keep (possibly repaired) position
        item.position = validated;
      }
    }

    // INTEGRITY CHECK: every remaining inline item must satisfy validateGitLabPosition.
    const invalidInline = fanoutQueue.filter(
      item =>
        item.type === 'inline' &&
        item.position !== undefined &&
        !validateGitLabPosition(item.position, positionMap),
    );
    if (invalidInline.length > 0) {
      for (const item of invalidInline) {
        console.error(
          `[Position][INTEGRITY FAIL] inline item still invalid after repair — ` +
          `forcing global: file=${item.comment.file} line=${item.position!.new_line}`,
        );
        item.type = 'global';
        item.position = undefined;
      }
    }
  }

  // ---------------------------------------------------------
  // STEP 2: LOG SPLIT SUMMARY
  // ---------------------------------------------------------
  const inlineCount    = fanoutQueue.filter(i => i.type === 'inline'  && i.status !== 'skipped_duplicate').length;
  const globalCount    = fanoutQueue.filter(i => i.type === 'global'  && i.status !== 'skipped_duplicate').length;
  const skippedCount   = fanoutQueue.filter(i => i.status === 'skipped_duplicate').length;
  const failedPosCount = fanoutQueue.filter(i => i.status === 'failed_position').length;

  console.error(
    `[DiffGuard][FANOUT] queue: ${fanoutQueue.length} items | ` +
    `inline=${inlineCount} global=${globalCount} ` +
    `skipped_duplicate=${skippedCount} failed_position=${failedPosCount}`,
  );

  // ---------------------------------------------------------
  // STEP 3: FAN-OUT POSTING LOOP — 1 item = 1 GitLab request, no merging
  // ---------------------------------------------------------
  let postedCount = 0;

  const postItem = async (item: FanOutItem): Promise<void> => {
    const body = `${formatInlineBody(item.comment, item.snappedLine ?? -1)}\n[DiffGuardKey:${item.dedupeKey}]`;

    if (item.type === 'inline' && item.position !== undefined) {
      await axios.post(
        `${projectPath}/discussions`,
        { body, position: item.position },
        { headers: { 'PRIVATE-TOKEN': config.token }, timeout: AXIOS_TIMEOUT_MS },
      );
    } else {
      await axios.post(
        `${projectPath}/discussions`,
        { body },
        { headers: { 'PRIVATE-TOKEN': config.token }, timeout: AXIOS_TIMEOUT_MS },
      );
    }
  };

  for (const item of fanoutQueue) {
    if (item.status === 'skipped_duplicate') {
      console.error(`[DiffGuard][FANOUT] SKIP duplicate dedupeKey=${item.dedupeKey}`);
      continue;
    }

    console.error(
      `[GitLab][POST] file=${item.comment.file} type=${item.type} status=${item.status} dedupeKey=${item.dedupeKey}`,
    );

    try {
      await postItem(item);
      item.status = 'posted';
      existingKeys.add(item.dedupeKey);
      postedCount++;
      console.error(`[DiffGuard][POST OK] file=${item.comment.file} type=${item.type}`);
      await sleep(POST_RATE_LIMIT_DELAY_MS);
    } catch (err) {
      console.error('[DiffGuard][POST FAILED]', err instanceof Error ? err.message : String(err));

      if (isRetryable(err)) {
        await sleep(500);
        console.error(
          `[DiffGuard][RETRY] file=${item.comment.file} type=${item.type} dedupeKey=${item.dedupeKey}`,
        );
        try {
          await postItem(item);
          item.status = 'posted';
          existingKeys.add(item.dedupeKey);
          postedCount++;
          console.error(`[DiffGuard][POST OK] file=${item.comment.file} type=${item.type} (retry)`);
          await sleep(1000);
        } catch (retryErr) {
          console.error(
            '[DiffGuard][POST FAILED]',
            retryErr instanceof Error ? retryErr.message : String(retryErr),
          );
        }
      }
    }
  }

  console.error(
    `[DiffGuard][FANOUT] complete: posted=${postedCount} skipped=${skippedCount} total=${totalComments}`,
  );
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
  validateGitLabBaseUrl(config);
  const apiBase = `${config.baseUrl}/api/v4`;
  const positionMap: MRPositionMap = new Map();
  const fileContexts: FileContext[] = [];

  const url = `${apiBase}/projects/${encodeURIComponent(config.projectId)}/merge_requests/${config.mrIid}/changes`;
  const response = await axios.get<{ changes: GitLabDiffEntry[] }>(url, {
    headers: { 'PRIVATE-TOKEN': config.token },
    timeout: AXIOS_TIMEOUT_MS,
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
          const parsedOld = parseInt(m[1], 10);
          const parsedNew = parseInt(m[2], 10);
          if (!isNaN(parsedOld)) oldLineNum = parsedOld;
          if (!isNaN(parsedNew)) newLineNum = parsedNew;
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

// ---------------------------------------------------------------------------
// extractLineFromDiff — find new_line for a search pattern in a unified diff
// ---------------------------------------------------------------------------

/**
 * Scans a unified diff string for the first added (`+`) or context (` `) line
 * that contains `searchPattern` and returns its new-file line number (1-based).
 *
 * Returns -1 when:
 *   - `searchPattern` is empty or `diff` is empty.
 *   - The pattern is not found in any reachable `+` or context line.
 *
 * Deleted lines (`-`) are intentionally excluded because they do not exist in
 * the new file and therefore cannot be targeted by a GitLab inline position.
 */
export function extractLineFromDiff(diff: string, searchPattern: string): number {
  if (!diff || !searchPattern) return -1;

  let newLineNum = 0;

  for (const raw of diff.split('\n')) {
    // Hunk header — resets the new-file line counter for each hunk.
    if (raw.startsWith('@@')) {
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      // Start at (newStart - 1): the counter is incremented before the line is
      // examined, so this correctly yields newStart on the first line of the hunk.
      if (m) {
        const parsed = parseInt(m[1], 10);
        if (!isNaN(parsed)) newLineNum = parsed - 1;
      }
      continue;
    }

    // Skip unified diff meta-headers (present in some GitLab API responses).
    if (
      raw.startsWith('+++') ||
      raw.startsWith('---') ||
      raw.startsWith('diff ') ||
      raw.startsWith('index ')
    ) {
      continue;
    }

    if (raw.startsWith('+')) {
      newLineNum++;
      if (raw.slice(1).includes(searchPattern)) return newLineNum;
    } else if (raw.startsWith('-')) {
      // Deleted lines do not advance the new-file counter.
    } else if (raw.startsWith(' ')) {
      newLineNum++;
      if (raw.slice(1).includes(searchPattern)) return newLineNum;
    }
  }

  return -1;
}

// ---------------------------------------------------------------------------
// postInlineMRComment — post a single positioned discussion on a GitLab MR
// ---------------------------------------------------------------------------

/**
 * Posts a single inline (line-level) GitLab MR discussion using the
 * Discussions API (`POST /projects/:id/merge_requests/:iid/discussions`).
 *
 * Never uses /notes or /diffs endpoints.
 *
 * Line resolution:
 *   1. Snap issue.lineHint to the nearest changed line via provider.
 *   2. No position resolved → file-level discussion (discussions API, no position).
 */
export async function postInlineMRComment(
  config: GitLabConfig,
  issue: InlineMRIssue,
  provider: ResolvedPositionProvider,
  version: GitLabMRVersion,
): Promise<void> {
  validateGitLabBaseUrl(config);

  const { base_sha, start_sha, head_sha } = version;

  // ─────────────────────────────────────────────
  // STEP 1: resolve position ONLY via provider
  // ─────────────────────────────────────────────
  const positioned = provider.resolve(
    {
      file: issue.filePath,
      lineHint: issue.lineHint ?? null,
      violatingStatement: '',
      message: issue.message,
      executionPath: '',
      suggestion: '',
      severity: 'low',
      ruleId: issue.ruleId,
    },
    { version },
  );

  console.error('[DiffGuard][INLINE][RESOLVE]', {
    file: issue.filePath,
    lineHint: issue.lineHint,
    hasPosition: !!positioned,
  });

  const apiBase = `${config.baseUrl}/api/v4`;
  const discussionsUrl =
    `${apiBase}/projects/${encodeURIComponent(config.projectId)}` +
    `/merge_requests/${config.mrIid}/discussions`;

  // ─────────────────────────────────────────────
  // STEP 2: INLINE COMMENT (only if valid)
  // ─────────────────────────────────────────────
  if (positioned?.position) {
    const { position } = positioned;

    const payload = {
      body: issue.message,
      position: {
        position_type: 'text',
        base_sha,
        start_sha,
        head_sha,
        new_path: position.new_path,
        new_line: position.new_line,
      },
    };

    console.error(
      '[DiffGuard][INLINE][POST]',
      JSON.stringify(payload, null, 2),
    );

    try {
      await axios.post(discussionsUrl, payload, {
        headers: { 'PRIVATE-TOKEN': config.token },
        timeout: AXIOS_TIMEOUT_MS,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[DiffGuard] Failed to post inline MR comment: ${msg}`);
    }

    return;
  }

  // ─────────────────────────────────────────────
  // STEP 3: GLOBAL COMMENT (no position)
  // ─────────────────────────────────────────────
  console.error('[DiffGuard][GLOBAL]', {
    file: issue.filePath,
    reason: 'no inline position → posting global MR comment',
  });

  const body = `**File: ${issue.filePath}**\n\n${issue.message}`;

  try {
    await axios.post(
      discussionsUrl,
      { body },
      { headers: { 'PRIVATE-TOKEN': config.token }, timeout: AXIOS_TIMEOUT_MS },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[DiffGuard] Failed to post global MR comment: ${msg}`);
  }
}