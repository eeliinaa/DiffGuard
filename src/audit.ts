import { RuleAuditEntry, Rule, AIReviewResult } from './types.js';
import crypto from 'crypto';

export function hashRule(rule: Rule): string {
  return crypto.createHash('sha256').update(JSON.stringify(rule)).digest('hex');
}

export function initRuleAudit(rules: Rule[]): RuleAuditEntry[] {
  const now = new Date().toISOString();
  return rules.map(rule => ({
    ruleId: rule.id,
    sourceHash: hashRule(rule),
    evaluatedStatus: 'skipped', // will be updated after evaluation
    evidenceRefs: [],
    aiReferenced: false,
    violationDetected: false,
    outputEmitted: false,
    skipReason: 'not yet evaluated',
    timestamp: now
  }));
}

export function updateAuditAfterEval(
  auditTable: RuleAuditEntry[],
  result: AIReviewResult
): void {
  const now = new Date().toISOString();

  for (const entry of auditTable) {
    entry.evaluatedStatus = 'evaluated';
    entry.skipReason = undefined;
    entry.timestamp = now;
  }

  for (const comment of result.comments) {
    if (!comment.ruleId) continue;
    const entry = auditTable.find(e => e.ruleId === comment.ruleId);
    if (!entry) continue;
    entry.aiReferenced = true;
    entry.violationDetected = true;
    entry.outputEmitted = true;
    if (!entry.evidenceRefs.includes(comment.file)) {
      entry.evidenceRefs.push(comment.file);
    }
  }
}
