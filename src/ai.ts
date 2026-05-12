// AI service adapter — GPT-4o via OpenAI-compatible API
import axios from 'axios';
import {
  AIReviewPayload,
  AIReviewResult,
  DiffGuardConfig,
  FileContext,
  ReviewComment,
  Rule,
  SerializedRule,
} from './types.js';

// ---------------------------------------------------------------------------
// System prompt — persona + output contract only (no data injected here)
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a senior code reviewer integrated into a CI pipeline (DiffGuard).

Your task:
Analyze a structured git diff context against the provided rules and produce concise, actionable review comments.

You MUST:
- Focus only on real issues: bugs, edge cases, performance, security, logic errors
- Enforce each rule in the provided rules array; reference its id in ruleId when violated
- Ignore style preferences unless they indicate a bug or maintainability risk
- Be precise and reference file + line context when possible
- Avoid long explanations, repeating the diff, or generic advice

INPUT FORMAT:
You receive a JSON object with two fields:
1. "rules": array of review guidelines — each has: id, title, description, rule_notes
2. "fileContexts": array of FileContext objects — each has: file, changedLines, preContext, postContext

REVIEW RULES:
1. Treat each FileContext as an isolated review unit
2. Use changedLines to understand the scope of the change
3. Use preContext/postContext only for local reasoning
4. Detect:
   - logic bugs and missing null/undefined checks
   - async/await misuse and race conditions
   - security risks (input handling, injection, unsafe API calls)
   - performance issues (unnecessary loops, re-renders, redundant work)
   - incorrect state handling (React state, async mutations)
   - violations of any rule in the provided rules array
5. If no issues found → return LGTM result

OUTPUT FORMAT — return JSON only, matching this exact shape:
{
  "summary": string,
  "comments": [
    {
      "file": string,
      "severity": "low" | "medium" | "high",
      "lineHint": number | null,
      "message": string,
      "suggestion": string,
      "ruleId": string | null
    }
  ]
}

COMMENT RULES:
- Keep each comment under 3-5 lines
- Be direct — no polite filler
- Suggest concrete fixes, not theory
- Separate entries for multiple issues in the same file
- Severity "high" must clearly state the risk

If everything is correct:
{"summary":"LGTM","comments":[]}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([429, 500, 502, 503]);
const TOKEN_BUDGET_CHARS = 400_000;

function serializeRules(rules: Rule[]): SerializedRule[] {
  return rules.map(r => ({
    id: r.id,
    ...(r.title ? { title: r.title } : {}),
    description: r.description,
    ...(r.rule_notes?.length ? { rule_notes: r.rule_notes } : {}),
  }));
}

function truncateToTokenBudget(payload: AIReviewPayload, budgetChars: number): AIReviewPayload {
  const full = JSON.stringify(payload);
  if (full.length <= budgetChars) return payload;

  const rulesJson = JSON.stringify(payload.rules);
  const filesBudget = budgetChars - rulesJson.length - 100;

  // Prioritise files with the most changed lines
  const sorted = [...payload.fileContexts].sort(
    (a, b) => b.changedLines.length - a.changedLines.length
  );

  const included: FileContext[] = [];
  const excluded: string[] = [];
  let used = 0;

  for (const ctx of sorted) {
    const len = JSON.stringify(ctx).length;
    if (used + len <= filesBudget) {
      included.push(ctx);
      used += len;
    } else {
      excluded.push(ctx.file);
    }
  }

  if (excluded.length > 0) {
    console.error(
      `[DiffGuard] Token budget exceeded. Excluded ${excluded.length} file(s): ${excluded.join(', ')}`
    );
  }

  return { rules: payload.rules, fileContexts: included };
}

function isAIReviewResult(val: unknown): val is AIReviewResult {
  if (!val || typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  if (typeof obj['summary'] !== 'string') return false;
  if (!Array.isArray(obj['comments'])) return false;
  for (const c of obj['comments']) {
    if (!c || typeof c !== 'object') return false;
    const comment = c as Record<string, unknown>;
    if (typeof comment['file'] !== 'string') return false;
    if (!['low', 'medium', 'high'].includes(comment['severity'] as string)) return false;
    if (comment['lineHint'] !== null && typeof comment['lineHint'] !== 'number') return false;
    if (typeof comment['message'] !== 'string') return false;
    if (typeof comment['suggestion'] !== 'string') return false;
    if (
      comment['ruleId'] !== undefined &&
      comment['ruleId'] !== null &&
      typeof comment['ruleId'] !== 'string'
    ) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main evaluation function
// ---------------------------------------------------------------------------

export async function evaluateWithAI(
  fileContexts: FileContext[],
  rules: Rule[],
  config: DiffGuardConfig
): Promise<AIReviewResult> {
  const serializedRules = serializeRules(rules);
  const rawPayload: AIReviewPayload = { rules: serializedRules, fileContexts };
  const payload = truncateToTokenBudget(rawPayload, TOKEN_BUDGET_CHARS);
  const userMessage = JSON.stringify(payload);

  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await axios.post(
        `${config.baseUrl}/chat/completions`,
        {
          model: config.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'http://localhost',
            'X-Title': 'DiffGuard',
          },
          timeout: config.timeoutMs,
        }
      );

      const raw: unknown = response.data?.choices?.[0]?.message?.content;
      if (typeof raw !== 'string') {
        console.error('[DiffGuard] AI response missing content field. Raw response:', JSON.stringify(response.data).slice(0, 500));
        process.exit(1);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.error('[DiffGuard] AI returned non-JSON content:', raw.slice(0, 500));
        process.exit(1);
      }

      if (!isAIReviewResult(parsed)) {
        console.error('[DiffGuard] AI returned invalid shape:', JSON.stringify(parsed).slice(0, 500));
        process.exit(1);
      }

      // Normalise nullable ruleId fields (model may omit the key entirely)
      for (const comment of parsed.comments) {
        if (comment.ruleId === undefined) {
          (comment as unknown as Record<string, unknown>)['ruleId'] = null;
        }
      }

      return parsed;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const code = err.code;
        const status = err.response?.status;

        // Timeout — not retryable
        if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
          console.error(`[DiffGuard] API timeout after ${config.timeoutMs}ms. Aborting.`);
          process.exit(1);
        }

        // Non-retryable HTTP error (4xx except 429)
        if (status !== undefined && !RETRYABLE_STATUS.has(status)) {
          console.error(
            `[DiffGuard] API error (non-retryable) HTTP ${status}:`,
            JSON.stringify(err.response?.data).slice(0, 500)
          );
          process.exit(1);
        }

        // Retryable
        lastError = err;
        if (attempt < config.maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 1000;
          console.error(
            `[DiffGuard] API error HTTP ${status ?? 'unknown'}, retrying in ${delay}ms (attempt ${attempt}/${config.maxRetries})`
          );
          await new Promise<void>(res => setTimeout(res, delay));
        }
      } else {
        // Non-axios error — not retryable
        console.error('[DiffGuard] Unexpected error during AI evaluation:', err);
        process.exit(1);
      }
    }
  }

  console.error(
    `[DiffGuard] AI evaluation failed after ${config.maxRetries} attempt(s):`,
    lastError instanceof Error ? lastError.message : String(lastError)
  );
  process.exit(1);
}
