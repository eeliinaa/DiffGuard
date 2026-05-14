// Output rendering and safety gates
import { AIResponse, AIReviewResult } from './types.js';

export function renderConsoleOutput(response: AIResponse) {
  console.log('Summary:', response.summary);
  for (const finding of response.inline) {
    console.log(`[${finding.severity}] ${finding.file}:${finding.line} (${finding.ruleId}): ${finding.message}`);
  }
  for (const general of response.general) {
    console.log(`[${general.category}] ${general.message}`);
  }
}

export function renderJSONOutput(response: AIResponse) {
  console.log(JSON.stringify(response, null, 2));
}

export function renderConsoleAIResult(result: AIReviewResult): void {
  if (result.comments.length === 0) {
    process.stdout.write(`${result.summary}\n`);
    return;
  }
  process.stdout.write(`\n${result.summary}\n\n`);
  result.comments.forEach((comment, idx) => {
    const loc = comment.lineHint != null ? `:${comment.lineHint}` : '';
    process.stdout.write(`Finding ${idx + 1} — ${comment.file}${loc} · ${comment.severity.toUpperCase()}\n\n`);
    process.stdout.write(`Violating statement:\n${comment.violatingStatement}\n\n`);
    process.stdout.write(`Why it violates:\n${comment.message}\n\n`);
    process.stdout.write(`Execution path:\n${comment.executionPath}\n\n`);
    process.stdout.write(`Fix:\n${comment.suggestion}\n`);
    if (comment.ruleId) {
      process.stdout.write(`rule: ${comment.ruleId}\n`);
    }
    process.stdout.write('\n');
  });
}

export function renderJSONAIResult(result: AIReviewResult): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// renderFanoutStrictJSON — LINE-LEVEL FANOUT STRICT MODE output (Rule 7)
// ---------------------------------------------------------------------------

/**
 * Flat JSON array output for LINE-LEVEL FANOUT STRICT MODE.
 *
 * Shape per finding:
 *   { file, line, severity, message, ruleId, snippet }
 *
 * line is the 1-based lineHint.
 * When lineHint is null (truly unresolvable position), line is set to
 * "failed_position" — never to 1 or any other numeric fallback.
 */
export function renderFanoutStrictJSON(result: AIReviewResult): void {
  const findings = result.comments.map(c => ({
    file: c.file,
    line: c.lineHint !== null ? c.lineHint : 'failed_position',
    severity: c.severity,
    message: c.message,
    ruleId: c.ruleId ?? '',
    snippet: c.violatingStatement,
  }));
  process.stdout.write(JSON.stringify(findings, null, 2) + '\n');
}
