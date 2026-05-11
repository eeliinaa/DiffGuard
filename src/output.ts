// Output rendering and safety gates
import { AIResponse } from './types';

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
