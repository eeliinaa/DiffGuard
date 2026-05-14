/**
 * GitLab Smart Issue Clustering Layer
 *
 * Groups AI-generated ReviewComments into root-cause clusters before they are
 * posted to GitLab, reducing noise while preserving every distinct failure mode.
 *
 * Pipeline
 * --------
 *  1. Normalize   — lowercase + collapse whitespace → normalizedMessage
 *  2. Cluster     — primary key: file + ruleId
 *                   sub-cluster: same severity | lineHint within ±3 | similar wording
 *  3. Represent   — derive a representative message, severity, lineHint
 *  4. Validate    — every input comment is accounted for (no-loss guarantee)
 */

import { AIReviewResult, ClusteringResult, ClusteredComment, ReviewComment, ReviewSeverity } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum line-hint distance for two comments to be considered the same region. */
const LINE_SNAP_TOLERANCE = 3;

/** Severity rank for "highest severity wins" selection. */
const SEVERITY_RANK: Record<ReviewSeverity, number> = { low: 0, medium: 1, high: 2 };

// ---------------------------------------------------------------------------
// Step 1 — Normalisation
// ---------------------------------------------------------------------------

function normalizeMessage(message: string): string {
  return message.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Stable fingerprint built from the first 80 characters of the normalised
 * message.  Short enough to survive minor rephrasing, long enough to capture
 * distinct content.
 */
function messageFingerprint(normalized: string): string {
  return normalized.slice(0, 80);
}

// ---------------------------------------------------------------------------
// Step 2 — Merge predicate
// ---------------------------------------------------------------------------

/**
 * Returns true when two comments belong to the same sub-cluster (should be
 * merged into a single root-cause entry).
 *
 * Pre-condition: both comments already share the same `file` + `ruleId`
 * (primary cluster key); here we decide on the semantic sub-cluster.
 *
 * MERGE when ANY of the following hold:
 *   a. Same severity
 *   b. lineHint values are within ±LINE_SNAP_TOLERANCE (or one/both are null)
 *   c. Normalised messages share a ≥40-character common prefix (same wording)
 *
 * DO NOT MERGE when:
 *   • Different ruleId   (checked before this function is called)
 *   • Different file     (checked before this function is called)
 */
function shouldMerge(a: ReviewComment, b: ReviewComment): boolean {
  const normA = normalizeMessage(a.message);
  const normB = normalizeMessage(b.message);

  // (a) same severity
  if (a.severity === b.severity) return true;

  // (b) same code region
  if (a.lineHint === null || b.lineHint === null) return true;
  if (Math.abs(a.lineHint - b.lineHint) <= LINE_SNAP_TOLERANCE) return true;

  // (c) wording similarity — shared normalised prefix ≥40 chars
  const minLen = Math.min(normA.length, normB.length);
  if (minLen >= 40) {
    let shared = 0;
    while (shared < minLen && normA[shared] === normB[shared]) shared++;
    if (shared >= 40) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Step 3 — Represent a cluster
// ---------------------------------------------------------------------------

/**
 * Selects the highest severity found in a group.
 */
function highestSeverity(comments: ReviewComment[]): ReviewSeverity {
  return comments.reduce<ReviewSeverity>((best, c) => {
    return SEVERITY_RANK[c.severity] > SEVERITY_RANK[best] ? c.severity : best;
  }, 'low');
}

/**
 * Step 4 — Line selection rule:
 *   1. Most frequent lineHint in the group.
 *   2. If tie, smallest line number.
 *   3. null when all are null.
 */
function representativeLineHint(comments: ReviewComment[]): number | null {
  const counts = new Map<number, number>();
  for (const c of comments) {
    if (c.lineHint !== null) {
      counts.set(c.lineHint, (counts.get(c.lineHint) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;

  let bestLine: number | null = null;
  let bestCount = 0;
  for (const [line, count] of counts) {
    if (count > bestCount || (count === bestCount && bestLine !== null && line < bestLine)) {
      bestLine = line;
      bestCount = count;
    }
  }
  return bestLine;
}

/**
 * Derives a root-cause message for a cluster.
 *
 * Rules (in priority order):
 *  1. If only one comment: use its message verbatim (no rewriting).
 *  2. Pick the comment whose normalised message is the median length
 *     (avoids both terse and overly-verbose messages).
 *  3. Trim to the first sentence to stay concise.
 *
 * We deliberately do NOT synthesise new text — only select from originals.
 */
function rootCauseMessage(comments: ReviewComment[]): string {
  if (comments.length === 1) return comments[0].message;

  // Sort by normalised-message length, pick the median
  const sorted = [...comments].sort(
    (a, b) => normalizeMessage(a.message).length - normalizeMessage(b.message).length,
  );
  const median = sorted[Math.floor(sorted.length / 2)];
  const msg = median.message;

  // Trim to first sentence if the message is longer than one sentence
  const firstStop = msg.search(/[.!?]\s/);
  if (firstStop !== -1 && firstStop + 1 < msg.length) {
    return msg.slice(0, firstStop + 1).trim();
  }
  return msg.trim();
}

// ---------------------------------------------------------------------------
// Step 2 (cont.) — Sub-cluster builder
// ---------------------------------------------------------------------------

/**
 * Given a flat list of comments that share the same primary key (file+ruleId),
 * partition them into sub-clusters using a greedy merge strategy.
 *
 * Each sub-cluster is guaranteed to contain at least one comment.
 */
function buildSubClusters(comments: ReviewComment[]): ReviewComment[][] {
  const clusters: ReviewComment[][] = [];

  for (const comment of comments) {
    let merged = false;
    for (const cluster of clusters) {
      // Check against every member of the cluster (not just the first)
      if (cluster.some(existing => shouldMerge(existing, comment))) {
        cluster.push(comment);
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push([comment]);
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Clusters `result.comments` into root-cause groups and returns a
 * ClusteringResult whose `comments` array has ≤ N entries (N = input length).
 *
 * Guarantees:
 *  - Every input comment appears in exactly one `mergedFrom` array.
 *  - Output has no duplicate root-cause entries.
 *  - No comment is silently dropped.
 */
export function clusterComments(result: AIReviewResult): ClusteringResult {
  const { comments, summary } = result;

  if (comments.length === 0) {
    return { comments: [], summary };
  }

  // -----------------------------------------------------------------------
  // Step 1 — group by primary cluster key: file + ruleId
  // -----------------------------------------------------------------------
  const primaryGroups = new Map<string, ReviewComment[]>();

  for (const comment of comments) {
    const key = `${comment.file}\x00${comment.ruleId ?? ''}`;
    const group = primaryGroups.get(key);
    if (group) {
      group.push(comment);
    } else {
      primaryGroups.set(key, [comment]);
    }
  }

  // -----------------------------------------------------------------------
  // Step 2+3 — sub-cluster and build ClusteredComments
  // -----------------------------------------------------------------------
  const clustered: ClusteredComment[] = [];

  for (const group of primaryGroups.values()) {
    const subClusters = buildSubClusters(group);

    for (const subCluster of subClusters) {
      const representative = subCluster[0];
      clustered.push({
        file: representative.file,
        ruleId: representative.ruleId ?? '',
        severity: highestSeverity(subCluster),
        message: rootCauseMessage(subCluster),
        lineHint: representativeLineHint(subCluster),
        mergedFrom: subCluster,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Integrity check — every input comment must appear in exactly one cluster
  // -----------------------------------------------------------------------
  const covered = new Set<ReviewComment>();
  for (const c of clustered) {
    for (const original of c.mergedFrom) {
      if (covered.has(original)) {
        throw new Error(
          `[DiffGuard][Clustering] Comment appeared in multiple clusters: "${original.message}"`,
        );
      }
      covered.add(original);
    }
  }
  for (const original of comments) {
    if (!covered.has(original)) {
      throw new Error(
        `[DiffGuard][Clustering] Comment was silently dropped: "${original.message}"`,
      );
    }
  }

  return { comments: clustered, summary };
}

/**
 * Converts a ClusteredComment back into a plain ReviewComment so that
 * downstream code (fanout, positionValidator, etc.) can consume it unchanged.
 */
export function clusteredToReviewComment(c: ClusteredComment): ReviewComment {
  // Preserve suggestion from the highest-severity original, or the first one.
  const best =
    c.mergedFrom.find(m => m.severity === c.severity) ?? c.mergedFrom[0];
  return {
    file: c.file,
    severity: c.severity,
    lineHint: c.lineHint,
    violatingStatement: best.violatingStatement,
    message: c.message,
    executionPath: best.executionPath,
    suggestion: best.suggestion,
    ruleId: c.ruleId || undefined,
  };
}
