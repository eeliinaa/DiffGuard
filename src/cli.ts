#!/usr/bin/env node

import minimist from 'minimist';
import path from 'path';
import { AIReviewResult, FileContext } from './types.js';
import { loadConfig } from './config.js';
import { loadRules } from './rules.js';
import { initRuleAudit, updateAuditAfterEval } from './audit.js';
import * as git from './git.js';
import { evaluateWithAI } from './ai.js';
import { renderConsoleAIResult, renderJSONAIResult } from './output.js';

async function main() {
  const argv = minimist(process.argv.slice(2));

  // Flags
  const outputMode: 'console' | 'json' = argv['output'] === 'json' ? 'json' : 'console';
  const dryRun = !!argv['dry-run'];

  // Fail fast at startup if API key is missing — skip in dry-run mode
  const config = dryRun ? null : loadConfig();

  // Load rules
  const rulesPath =
    typeof argv['rules-path'] === 'string'
      ? argv['rules-path']
      : path.join(process.cwd(), 'review-guidelines', 'rules.yaml');

  let rules;
  try {
    rules = loadRules(rulesPath);
    console.error(`[DiffGuard] Loaded ${rules.length} rules from ${rulesPath}`);
  } catch (err) {
    console.error('[DiffGuard] Failed to load rules:', err);
    process.exit(1);
  }

  const auditTable = initRuleAudit(rules);

  // Determine input mode
  let mode: 'staged' | 'diff' | 'file' | 'mr' = 'staged';
  if (typeof argv['diff'] === 'string' && argv['diff']) mode = 'diff';
  else if (typeof argv['file'] === 'string' && argv['file']) mode = 'file';
  else if (typeof argv['mr'] === 'string' && argv['mr']) mode = 'mr';

  for (const flag of ['diff', 'file', 'mr'] as const) {
    if (argv[flag] !== undefined && typeof argv[flag] !== 'string') {
      console.error(`[DiffGuard] Warning: --${flag} was passed without a value; falling back to staged mode.`);
    }
  }

  // Extract diff and build file contexts
  let diffResult = '';
  let fileContexts: FileContext[] = [];

  try {
    switch (mode) {
      case 'staged':
        diffResult = await git.getGitDiff();
        break;
      case 'diff':
        diffResult = await git.getGitDiff(typeof argv['diff'] === 'string' ? argv['diff'] : undefined);
        break;
      case 'file':
        diffResult = await git.getGitDiff(typeof argv['file'] === 'string' ? argv['file'] : undefined);
        break;
      case 'mr':
        diffResult = await git.getGitDiff(typeof argv['mr'] === 'string' ? argv['mr'] : undefined);
        break;
      default:
        throw new Error('Unknown input mode');
    }

    // Empty diff — short-circuit before any API call
    if (!diffResult.trim()) {
      console.error('[DiffGuard] No diff found. Nothing to review.');
      const lgtm: AIReviewResult = { summary: 'LGTM', comments: [] };
      outputMode === 'json' ? renderJSONAIResult(lgtm) : renderConsoleAIResult(lgtm);
      return;
    }

    const normalizedDiff = git.parseUnifiedDiff(diffResult);
    fileContexts = git.extractFileContexts(normalizedDiff);
    console.error(`[DiffGuard] Extracted ${fileContexts.length} file context(s)`);
  } catch (err) {
    console.error('[DiffGuard] Failed to extract diff/context:', err);
    process.exit(1);
  }

  // Dry-run: skip AI call, confirm wiring is correct
  if (dryRun) {
    console.error('[DiffGuard] Dry-run mode — skipping AI call.');
    const dryResult: AIReviewResult = { summary: 'LGTM [dry-run]', comments: [] };
    outputMode === 'json' ? renderJSONAIResult(dryResult) : renderConsoleAIResult(dryResult);
    return;
  }

  // AI evaluation
  const result = await evaluateWithAI(fileContexts, rules, config!);
  updateAuditAfterEval(auditTable, result);

  if (outputMode === 'json') {
    renderJSONAIResult(result);
  } else {
    renderConsoleAIResult(result);
  }
}

// Top-level await for ESM
await main();

