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
    process.stdout.write(`${result.summary}
`);
    return;
  }
  process.stdout.write(`
${result.summary}

`);
  for (const comment of result.comments) {
    const loc = comment.lineHint != null ? `:${comment.lineHint}` : '';
    process.stdout.write(`[${comment.severity.toUpperCase()}] ${comment.file}${loc}
`);
    process.stdout.write(`  ${comment.message}
`);
    process.stdout.write(`  -> ${comment.suggestion}
`);
    if (comment.ruleId) {
      process.stdout.write(`  rule: ${comment.ruleId}
`);
    }
    process.stdout.write('\n');
  }
}

export function renderJSONAIResult(result: AIReviewResult): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
