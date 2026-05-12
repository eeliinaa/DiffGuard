import { DiffGuardConfig, GitLabConfig } from './types.js';

export function loadConfig(): DiffGuardConfig {
  const apiKey = process.env['OPENROUTER_API_KEY'] ?? process.env['OPENAI_API_KEY'];
  if (!apiKey || !apiKey.trim()) {
    console.error('[DiffGuard] OPENROUTER_API_KEY is not set. Set the environment variable and retry.');
    process.exit(1);
  }

  const maxRetries = parseInt(process.env['DIFFGUARD_MAX_RETRIES'] ?? '3', 10);
  const timeoutMs = parseInt(process.env['DIFFGUARD_TIMEOUT_MS'] ?? '30000', 10);

  if (isNaN(maxRetries) || maxRetries < 1) {
    console.error('[DiffGuard] DIFFGUARD_MAX_RETRIES must be a positive integer.');
    process.exit(1);
  }
  if (isNaN(timeoutMs) || timeoutMs < 1000) {
    console.error('[DiffGuard] DIFFGUARD_TIMEOUT_MS must be >= 1000.');
    process.exit(1);
  }

  return {
    apiKey,
    model: process.env['DIFFGUARD_MODEL'] ?? 'openai/gpt-4o',
    baseUrl: process.env['DIFFGUARD_API_URL'] ?? 'https://openrouter.ai/api/v1',
    maxRetries,
    timeoutMs,
  };
}

export function loadGitLabConfig(): GitLabConfig {
  const token = process.env['GITLAB_TOKEN'];
  const projectId = process.env['GITLAB_PROJECT_ID'];
  const mrIidRaw = process.env['GITLAB_MR_IID'];

  if (!token || !projectId || !mrIidRaw) {
    throw new Error('GitLab config incomplete: GITLAB_TOKEN, GITLAB_PROJECT_ID, and GITLAB_MR_IID are required');
  }

  const mrIid = parseInt(mrIidRaw, 10);
  if (isNaN(mrIid)) {
    throw new Error('GITLAB_MR_IID is not a valid number');
  }

  const baseUrl = process.env['GITLAB_BASE_URL'];
  if (!baseUrl || !baseUrl.trim()) {
    throw new Error('[DiffGuard] GITLAB_BASE_URL is required. No safe default allowed.');
  }
  const failOnError = process.env['GITLAB_FAIL_ON_ERROR'] === '1';

  return { token, projectId, mrIid, baseUrl, failOnError };
}
