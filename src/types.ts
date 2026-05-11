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
