// Core type contracts for DiffGuard CLI

export type Severity = 'info' | 'warning' | 'error';
export type Category = 'architecture' | 'clean-code' | 'naming';

export interface Rule {
  id: string;
  type: 'ai';
  severity: Severity;
  category?: Category;
  title?: string;
  description: string;
  backend_example?: { language: string; code: string };
  frontend_example?: { language: string; code: string };
  rule_notes?: string[];
}

export interface DiffHunk {
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface FileContext {
  file: string;
  preContext: string[];
  postContext: string[];
  changedLines: number[];
  contextType?: 'changed' | 'deleted';
}

export interface AIRuleFinding {
  file: string;
  line: number;
  severity: Severity;
  message: string;
  ruleId: string;
}

export interface AIGeneralFinding {
  message: string;
  category: Category;
}

export interface AIResponse {
  summary: string;
  inline: AIRuleFinding[];
  general: AIGeneralFinding[];
}

export interface RuleAuditEntry {
  ruleId: string;
  sourceHash: string;
  evaluatedStatus: 'evaluated' | 'skipped';
  evidenceRefs: string[];
  aiReferenced: boolean;
  violationDetected: boolean;
  outputEmitted: boolean;
  skipReason?: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// AI review output contract (spec-aligned, separate from legacy AIResponse)
// ---------------------------------------------------------------------------

export type ReviewSeverity = 'low' | 'medium' | 'high';

export interface ReviewComment {
  file: string;
  severity: ReviewSeverity;
  lineHint: number | null;
  /** Exact verbatim code statement that is the subject of this finding. */
  violatingStatement: string;
  /** Single isolated reason why this statement violates. */
  message: string;
  /** Local-only execution path reasoning for how the risk is reached. */
  executionPath: string;
  suggestion: string;
  ruleId?: string;
}

export interface AIReviewResult {
  summary: string;
  comments: ReviewComment[];
}

/** Configuration for GitLab MR integration. */
export interface GitLabConfig {
  token: string;
  projectId: string;
  mrIid: number;
  baseUrl: string;
  failOnError: boolean;
  allowInsecureHttp?: boolean;
}

/** Diff version metadata returned by the GitLab MR versions API. */
export interface GitLabMRVersion {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

/**
 * Context required by postInlineMRComment to resolve and post a positioned
 * discussion on a GitLab MR. SHAs must come directly from the MR diff_refs.
 */
export interface DiffContext {
  base_sha: string;
  start_sha: string;
  head_sha: string;
  /** Raw unified diff text for the file, as returned by the GitLab /changes API. */
  diff: string;
}

/**
 * Issue descriptor passed to postInlineMRComment.
 * Represents a single detected rule violation for a specific file.
 */
export interface InlineMRIssue {
  /** File path in the new (head) version of the MR (new_path from /changes API). */
  filePath: string;
  /** Rule identifier — used as a fallback search pattern in extractLineFromDiff. */
  ruleId: string;
  /** Human-readable message to post as the discussion body. */
  message: string;
  /** Optional AI-suggested line hint (1-based). May be absent or imprecise. */
  lineHint?: number;
}

/** Position payload for a GitLab inline discussion on a text diff. */
export interface GitLabInlinePosition {
  position_type: 'text';
  base_sha: string;
  start_sha: string;
  head_sha: string;
  new_path: string;
  new_line: number;
}

/** Minimal position data for a single changed line from a GitLab MR diff. */
export interface GitLabDiffPosition {
  new_line: number;
  new_path: string;
}

/** Map from file path to its list of changed-line positions from the MR diff. */
export type MRPositionMap = Map<string, GitLabDiffPosition[]>;

/** Combined result of fetching MR diff data from GitLab: contexts and position map. */
export interface MRDiffResult {
  fileContexts: FileContext[];
  positionMap: MRPositionMap;
}

/** Runtime context passed to ResolvedPositionProvider.resolve — always contains version SHAs. */
export type ResolveContext = {
  version: GitLabMRVersion;
};

/** Pluggable strategy for resolving a ReviewComment to a GitLab inline position. */
export interface ResolvedPositionProvider {
  resolve(
    comment: ReviewComment,
    context: ResolveContext,
  ): { position: GitLabInlinePosition; snappedLine: number } | null;
}

/** Projected rule shape sent to the AI — strips verbose code examples. */
export interface SerializedRule {
  id: string;
  title?: string;
  description: string;
  rule_notes?: string[];
}

/** Payload serialized into the AI user message. */
export interface AIReviewPayload {
  rules: SerializedRule[];
  fileContexts: FileContext[];
}

// ---------------------------------------------------------------------------
// Clustering types
// ---------------------------------------------------------------------------

/**
 * A single comment produced by the clustering layer.
 * Summarises one root-cause group; `mergedFrom` retains every original comment.
 */
export interface ClusteredComment {
  file: string;
  ruleId: string;
  severity: ReviewSeverity;
  message: string;
  lineHint: number | null;
  /** All original ReviewComments collapsed into this cluster. */
  mergedFrom: ReviewComment[];
}

/** Output of the clustering pass — drop-in replacement for AIReviewResult.comments. */
export interface ClusteringResult {
  comments: ClusteredComment[];
  summary: string;
}

/** Runtime configuration loaded from environment variables. */
export interface DiffGuardConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxRetries: number;
  timeoutMs: number;
  /** Max concurrent AI requests (clamped to [1, 3]). Default: 2. */
  maxConcurrency: number;
  /** Max changed lines per AI chunk. Default: 300. */
  chunkSize: number;
}
