#!/usr/bin/env node

import minimist from 'minimist';
import path from 'path';
import {
  AIReviewResult,
  FileContext,
  GitLabConfig,
  GitLabMRVersion,
  ResolvedPositionProvider,
} from './types.js';
import { loadConfig, loadGitLabConfig } from './config.js';
import { loadRules } from './rules.js';
import { initRuleAudit, updateAuditAfterEval } from './audit.js';
import * as git from './git.js';
import { evaluateWithAI } from './ai.js';
import { renderConsoleAIResult, renderJSONAIResult } from './output.js';
import {
  fetchExistingDiscussionKeys,
  fetchExistingNoteHashes,
  fetchMRVersion,
  getMergeRequestFileContexts,
  LocalPositionProvider,
  MRPositionProvider,
  postGitLabMR,
} from './gitlab.js';

async function main() {
  const argv = minimist(process.argv.slice(2));

  // Flags
  const outputMode: 'console' | 'json' = argv['output'] === 'json' ? 'json' : 'console';
  const dryRun = !!argv['dry-run'];
  const gitlabEnabled = !!argv['gitlab'];

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
  else if (argv['mr']) mode = 'mr'; // boolean flag — MR identity comes from env vars

  for (const flag of ['diff', 'file'] as const) {
    if (argv[flag] !== undefined && typeof argv[flag] !== 'string') {
      console.error(`[DiffGuard] Warning: --${flag} was passed without a value; falling back to staged mode.`);
    }
  }

  // Hoisted across switch and posting block
  let gitlabConfig: GitLabConfig | null = null;
  let positionProvider: ResolvedPositionProvider | null = null;
  let mrVersion: GitLabMRVersion | null = null;

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
      case 'mr': {
        // MR mode: fetch diff entirely from GitLab API — no local git state used
        try {
          gitlabConfig = loadGitLabConfig();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[DiffGuard] ${msg}`);
          process.exit(1);
        }
        console.error('[DiffGuard] Using GitLab base URL:', gitlabConfig!.baseUrl);
        mrVersion = await fetchMRVersion(gitlabConfig!);
        const mrResult = await getMergeRequestFileContexts(gitlabConfig!);
        fileContexts = mrResult.fileContexts;
        positionProvider = new MRPositionProvider(mrResult.positionMap);
        break;
      }
      default:
        throw new Error('Unknown input mode');
    }

    if (mode !== 'mr') {
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
    }
  } catch (err) {
    console.error('[DiffGuard] Failed to extract diff/context:', err);
    process.exit(1);
  }

  // Set position provider for local modes (after fileContexts is populated)
  if (mode !== 'mr') {
    positionProvider = new LocalPositionProvider(fileContexts);
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

  // GitLab MR integration — side-effect only, runs after all output
  if (gitlabEnabled) {
    const cliFailOnError = !!argv['gitlab-fail-on-error'];
    let failOnError = cliFailOnError; // safe fallback if loadGitLabConfig throws
    try {
      const resolvedConfig = gitlabConfig ?? loadGitLabConfig();
      failOnError = resolvedConfig.failOnError || cliFailOnError; // merge: env OR flag
      // Version: already fetched for MR mode; explicitly fetched for local modes
      const version = mode === 'mr' ? mrVersion! : await fetchMRVersion(resolvedConfig);
      const existingState = mode === 'mr' ? {
        discussionKeys: await fetchExistingDiscussionKeys(resolvedConfig),
        noteHashes: await fetchExistingNoteHashes(resolvedConfig),
      } : undefined;
      await postGitLabMR(result, resolvedConfig, positionProvider!, version, existingState);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[DiffGuard] GitLab error:', message);
      if (failOnError) {
        process.exitCode = 1;
      }
    }
  }
}

// Top-level await for ESM
await main();

