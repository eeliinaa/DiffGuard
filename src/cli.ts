#!/usr/bin/env node

import minimist from 'minimist';
import fs from 'fs';
import yaml from 'js-yaml';
import { Rule } from './types.js';
import { initRuleAudit } from './audit.js';
import * as git from './git.js';
import path from 'path';

async function main() {
  const argv = minimist(process.argv.slice(2));
  const rulesPath = argv['rules-path'] || path.join(process.cwd(), 'review-guidelines', 'rules.yaml');
  let rules: Rule[] = [];
  try {
    const file = fs.readFileSync(rulesPath, 'utf8');
    const doc = yaml.load(file) as { rules: Rule[] };
    if (!doc || !Array.isArray(doc.rules)) {
      throw new Error('Invalid rules file: missing or malformed rules array');
    }
    rules = doc.rules.slice().sort((a, b) => a.id.localeCompare(b.id));
    console.log(`[DiffGuard] Loaded ${rules.length} rules from ${rulesPath}`);
  } catch (err) {
    console.error(`[DiffGuard] Failed to load rules:`, err);
    process.exit(1);
  }
  // Deterministic audit table initialization
  const auditTable = initRuleAudit(rules);

  // Input acquisition: determine mode
  let mode: 'staged' | 'diff' | 'file' | 'mr' = 'staged';
  if (typeof argv['diff'] === 'string' && argv['diff']) mode = 'diff';
  else if (typeof argv['file'] === 'string' && argv['file']) mode = 'file';
  else if (typeof argv['mr'] === 'string' && argv['mr']) mode = 'mr';

  for (const flag of ['diff', 'file', 'mr'] as const) {
    if (argv[flag] !== undefined && typeof argv[flag] !== 'string') {
      console.warn(`[DiffGuard] Warning: --${flag} was passed without a value; falling back to staged mode.`);
    }
  }

  // Placeholder: extract diff/context based on mode
  let diffResult: string | null = null;
  let normalizedDiff = null;
  let fileContexts = null;
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
    console.log(`[DiffGuard] Raw diff (truncated):\n${diffResult.substring(0, 1000)}${diffResult.length > 1000 ? '\n...truncated...' : ''}`);
    normalizedDiff = git.parseUnifiedDiff(diffResult);
    fileContexts = git.extractFileContexts(normalizedDiff, 100);
    console.log(`[DiffGuard] Normalized diff:`);
    console.dir(normalizedDiff, { depth: 4 });
    console.log(`[DiffGuard] File context:`);
    console.dir(fileContexts, { depth: 4 });
  } catch (err) {
    console.error(`[DiffGuard] Failed to extract diff/context:`, err);
    process.exit(1);
  }
}

// Top-level await for ESM
await main();
