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
  message: string;
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
}

/** Diff version metadata returned by the GitLab MR versions API. */
export interface GitLabMRVersion {
  base_sha: string;
  start_sha: string;
  head_sha: string;
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

/** Runtime configuration loaded from environment variables. */
export interface DiffGuardConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxRetries: number;
  timeoutMs: number;
}
