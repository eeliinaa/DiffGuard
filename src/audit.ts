import { RuleAuditEntry, Rule } from './types';
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
