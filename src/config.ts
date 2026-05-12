import { DiffGuardConfig } from './types.js';

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
