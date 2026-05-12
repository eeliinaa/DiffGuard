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
