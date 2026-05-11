#!/usr/bin/env node
import minimist from 'minimist';
import { loadRules } from './rules';
import { Rule } from './types';
import { initRuleAudit } from './audit';
import path from 'path';

function main() {
  const argv = minimist(process.argv.slice(2));
  const rulesPath = argv['rules-path'] || path.join(process.cwd(), 'review-guidelines', 'rules.yaml');
  let rules: Rule[] = [];
  try {
    rules = loadRules(rulesPath);
    console.log(`[DiffGuard] Loaded ${rules.length} rules from ${rulesPath}`);
  } catch (err) {
    console.error(`[DiffGuard] Failed to load rules:`, err);
    process.exit(1);
  }
  // Deterministic audit table initialization
  const auditTable = initRuleAudit(rules);

  // Input acquisition: determine mode
  let mode: 'staged' | 'diff' | 'file' | 'mr' = 'staged';
  if (argv['diff']) mode = 'diff';
  else if (argv['file']) mode = 'file';
  else if (argv['mr']) mode = 'mr';

  // Placeholder: extract diff/context based on mode
  let diffResult: string = '';
  let normalizedDiff: any = null;
  let fileContexts: any = null;
  try {
    const git = await import('./git');
    switch (mode) {
      case 'staged':
        diffResult = await git.getGitDiff();
        break;
      case 'diff':
        diffResult = await git.getGitDiff(argv['diff']);
        break;
      case 'file':
        diffResult = await git.getGitDiff(argv['file']);
        break;
      case 'mr':
        diffResult = await git.getGitDiff(argv['mr']);
        break;
      default:
        throw new Error('Unknown input mode');
    }
    normalizedDiff = git.parseUnifiedDiff(diffResult);
    fileContexts = git.extractFileContexts(normalizedDiff, 100);
    console.log(`[DiffGuard] Raw diff (truncated):\n${diffResult.substring(0, 1000)}${diffResult.length > 1000 ? '\n...truncated...' : ''}`);
    console.log(`[DiffGuard] Normalized diff:`);
    console.dir(normalizedDiff, { depth: 4 });
    console.log(`[DiffGuard] File context:`);
    console.dir(fileContexts, { depth: 4 });
  } catch (err) {
    console.error(`[DiffGuard] Failed to extract diff/context:`, err);
    process.exit(1);
  }
}

main();
