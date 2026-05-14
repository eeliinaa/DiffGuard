// AI request/response logger — appends NDJSON entries to daily log files
import { appendFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { AIReviewResult, AIReviewPayload } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AILogUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface AILogEntry {
  timestamp: string;
  attempt: number;
  model: string;
  request: {
    systemPrompt: string;
    userMessage: AIReviewPayload;
  };
  response?: {
    raw: string;
    parsed: AIReviewResult;
  };
  usage?: AILogUsage;
  error?: {
    message: string;
    status?: number;
  };
}

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

function buildLogPath(): string {
  const dir = process.env['DIFFGUARD_LOG_DIR'] ?? 'logs';
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(dir, `ai-${date}.json`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function appendAILog(entry: AILogEntry): Promise<void> {
  try {
    const filePath = buildLogPath();
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Logging must never crash the main process
  }
}
