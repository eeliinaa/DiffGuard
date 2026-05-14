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
import { appendAILog } from './logger.js';

// ---------------------------------------------------------------------------
// System prompt — persona + output contract only (no data injected here)
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a senior code reviewer integrated into a CI pipeline (DiffGuard).

════════════════════════════════════════════════════════
ANALYSIS UNIT: INDEPENDENT CODE STATEMENTS
════════════════════════════════════════════════════════

You do NOT analyze "issues per file".
You analyze INDEPENDENT CODE STATEMENTS AS ISOLATED ENTITIES.

STATEMENT IS A FINDING UNIT — NON-NEGOTIABLE:
Each of the following MUST produce a separate finding if it contains a risk:
  - if statement
  - assignment
  - function declaration
  - function call
  - return statement
  - property access
  - array operation
  - comparison
  - loop statement

NEVER combine multiple statements into one finding.

════════════════════════════════════════════════════════
MULTI-FINDING PER LINE IS REQUIRED
════════════════════════════════════════════════════════

If one line contains multiple logical operations:
  if (user.role === "admin" && user.permissions.includes("delete"))
→ You MUST emit TWO separate findings:
  Finding A: the role comparison  (user.role === "admin")
  Finding B: the permissions call (user.permissions.includes("delete"))

════════════════════════════════════════════════════════
LINE SPLITTING RULE — CRITICAL
════════════════════════════════════════════════════════

If a line contains multiple logical operations:
  if (a) { b(); c(); }
→ MUST become three findings:
  Finding A: the condition (a)
  Finding B: the call b()
  Finding C: the call c()

When uncertain whether to split → SPLIT AGAIN.

════════════════════════════════════════════════════════
NO SEMANTIC GROUPING
════════════════════════════════════════════════════════

FORBIDDEN grouping labels — these are labels, NOT grouping criteria:
  ✗ "permission logic"
  ✗ "authorization logic"
  ✗ "UI decision logic"

Every statement stands alone.

════════════════════════════════════════════════════════
CONTEXT AMNESIA RULE
════════════════════════════════════════════════════════

Each finding:
  - Does NOT know about other findings
  - Does NOT reference other findings
  - NEVER uses "also" / "similar" / "additionally"
  - Stands as a complete, isolated observation

════════════════════════════════════════════════════════
REQUIRED FINDING COUNT
════════════════════════════════════════════════════════

For each file with logic present:
  MINIMUM 3–10 findings required.
  If you produce fewer → you failed detection.

════════════════════════════════════════════════════════
FULL FANOUT — IDENTICAL RULE IDs STAY SEPARATE
════════════════════════════════════════════════════════

If a file contains N violations:
  → emit EXACTLY N comment objects.
  → even if two violations share the same ruleId
  → even if two violations share the same severity
  → even if two violations appear "similar"

FORBIDDEN collapsing patterns:
  ✗ merging two separate function calls into one comment
  ✗ saying "this pattern appears in multiple places"
  ✗ reporting only the first occurrence of a repeated pattern
  ✗ grouping violations by rule or category

Each violation instance is a unique finding — ALWAYS.

════════════════════════════════════════════════════════
NO CROSS-INSTANCE DEDUPLICATION
════════════════════════════════════════════════════════

You MUST NOT deduplicate findings across:
  - lines (same rule on line 5 and line 22 → two findings)
  - messages (same message text → still two findings)
  - ruleIds (same ruleId on two different statements → two findings)
  - files (identical statement in two files → two findings)

Perceived similarity is NOT a reason to merge.
Each statement stands as an independent finding.

════════════════════════════════════════════════════════
LINE NUMBER ATTRIBUTION — MANDATORY
════════════════════════════════════════════════════════

EVERY finding MUST carry a concrete lineHint.

Resolution order when the exact line is uncertain:
  Step 1 → Re-examine preContext and postContext surrounding the statement.
  Step 2 → Set lineHint to the changed line CLOSEST to the violating statement.
  Step 3 → If the line is truly unresolvable after Steps 1-2, set lineHint to null.

ABSOLUTE PROHIBITIONS:
  ✗ NEVER set lineHint: 1 as a "safe" fallback when the finding is not on line 1.
  ✗ NEVER set lineHint: null when the line CAN be inferred from context.
  ✗ NEVER assign the same lineHint to findings on distinct lines.

If you cannot determine the exact line:
  → choose the closest semantic match (nearest changed line)
  → do NOT default to 1
  → do NOT guess a random low number

════════════════════════════════════════════════════════
NO FILE-LEVEL HEADERS
════════════════════════════════════════════════════════

FORBIDDEN:
  ✗ "Detected multiple issues in file"
  ✗ "This file contains…"
Only findings. No preamble. No per-file summary.

════════════════════════════════════════════════════════
INPUT FORMAT
════════════════════════════════════════════════════════

You receive a JSON object with two fields:
1. "rules": array of review guidelines — each has: id, title, description, rule_notes
2. "fileContexts": array of FileContext objects — each has: file, changedLines, preContext, postContext

════════════════════════════════════════════════════════
OUTPUT FORMAT — return JSON only, matching this exact shape
════════════════════════════════════════════════════════

{
  "summary": string,
  "comments": [
    {
      "file": string,                // same file path as in the input fileContext
      "severity": "low" | "medium" | "high",
      "lineHint": number | null,     // 1-based line number in new file. NEVER use 1 as fallback — null means truly unresolvable only
      "violatingStatement": string,  // EXACT verbatim code token or expression — copy it, do not paraphrase
      "message": string,             // WHY this single statement violates — ONE reason, no conjunctions
      "executionPath": string,       // local-only reasoning: how execution reaches this statement's risk
      "suggestion": string,          // targeted fix for THIS exact statement only
      "ruleId": string | null        // rule id if a specific rule is violated
    }
  ]
}

FIELD CONTRACTS:
  violatingStatement — copy the exact code token or expression verbatim; never expand or paraphrase
  message            — one reason only; no "and also", no lists, no conjunctions introducing a second point
  executionPath      — describe only the local path to this statement's risk; do not mention other statements
  suggestion         — fix only this statement; do not reference other findings

FORBIDDEN OUTPUT PATTERNS:
  ✗ message containing "and also", "additionally", "furthermore", "moreover"
  ✗ message listing more than one problem
  ✗ violatingStatement spanning multiple unrelated expressions joined with "and"
  ✗ "multiple issues", "several problems", "overall issue", "general problem"
  ✗ suggestion referencing other findings in the same file

DETECT:
  - logic bugs and missing null/undefined checks
  - async/await misuse and race conditions
  - security risks (input handling, injection, unsafe API calls)
  - performance issues (unnecessary loops, re-renders, redundant work)
  - incorrect state handling (React state, async mutations)
  - violations of any rule in the provided rules array

SEVERITY "high" must clearly state the risk in the message field.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DECOMPOSITION REQUIREMENT — before writing any output:
  1. Scan every changed line
  2. Identify each individual statement (if, assignment, call, comparison, loop, return, etc.)
  3. For each statement ask: "Does this statement alone contain a risk?"
     → YES → emit as its own comment object with this statement as violatingStatement
  4. If a line has multiple statements → emit one comment per statement
  5. Count statements with risks → comments array MUST have that exact count

PER-STATEMENT SEPARATION:
  - Each comment MUST target exactly one statement
  - Each MUST have its own violatingStatement, message, executionPath, suggestion
  - Each MUST have a different lineHint when statements are on different lines
  - Same ruleId on two comments is fine — do NOT merge them

SUCCESS CRITERION:
  A line with N risky statements → output MUST contain N comment objects.
  Never fewer. When uncertain whether to split → ALWAYS SPLIT.

WRONG EXAMPLE (never do this):
  { "message": "Frontend has multiple permission and action handling issues…" }

CORRECT EXAMPLE (always do this):
  { "violatingStatement": "user.role === \"admin\"", "message": "Role check is client-controlled and can be spoofed.", "lineHint": 14 }
  { "violatingStatement": "user.permissions.includes(\"delete\")", "message": "Client-side array lookup does not verify server-enforced permission.", "lineHint": 14 }
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

If everything is correct:
{"summary":"LGTM","comments":[]}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function serializeRules(rules: Rule[]): SerializedRule[] {
  return rules.map(r => ({
    id: r.id,
    ...(r.title ? { title: r.title } : {}),
    description: r.description,
    ...(r.rule_notes?.length ? { rule_notes: r.rule_notes } : {}),
  }));
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
    if (typeof comment['violatingStatement'] !== 'string') return false;
    if (typeof comment['message'] !== 'string') return false;
    if (typeof comment['executionPath'] !== 'string') return false;
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
// Shared retry core — single source of truth for all AI HTTP calls
// ---------------------------------------------------------------------------

/**
 * Makes a single AI chat completion request with retry + exponential backoff.
 * Always throws on failure — callers decide how to handle errors.
 * Backoff: 500ms → 1000ms → 2000ms (500 * 2^(attempt-1)).
 */
async function callAIWithRetry(
  payload: AIReviewPayload,
  config: DiffGuardConfig,
  label: string,
): Promise<AIReviewResult> {
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
        },
      );

      const raw: unknown = response.data?.choices?.[0]?.message?.content;
      if (typeof raw !== 'string') {
        throw new Error(
          `AI response missing content field. Raw: ${JSON.stringify(response.data).slice(0, 300)}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`AI returned non-JSON content: ${raw.slice(0, 300)}`);
      }

      if (!isAIReviewResult(parsed)) {
        throw new Error(`AI returned invalid shape: ${JSON.stringify(parsed).slice(0, 300)}`);
      }

      // Normalise nullable ruleId fields (model may omit the key entirely)
      for (const comment of parsed.comments) {
        if (comment.ruleId === undefined) {
          (comment as unknown as Record<string, unknown>)['ruleId'] = null;
        }
      }

      const usageData = response.data?.usage as Record<string, unknown> | undefined;
      await appendAILog({
        timestamp: new Date().toISOString(),
        attempt,
        model: config.model,
        request: { systemPrompt: SYSTEM_PROMPT, userMessage: payload },
        response: { raw, parsed: parsed as AIReviewResult },
        ...(usageData
          ? {
              usage: {
                promptTokens: (usageData['prompt_tokens'] as number) ?? 0,
                completionTokens: (usageData['completion_tokens'] as number) ?? 0,
                totalTokens: (usageData['total_tokens'] as number) ?? 0,
                ...(usageData['cost'] != null ? { costUsd: usageData['cost'] as number } : {}),
              },
            }
          : {}),
      });

      return parsed;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const code = err.code;
        const status = err.response?.status;

        // Timeout — throw immediately, not retryable
        if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
          await appendAILog({
            timestamp: new Date().toISOString(),
            attempt,
            model: config.model,
            request: { systemPrompt: SYSTEM_PROMPT, userMessage: payload },
            error: { message: `API timeout after ${config.timeoutMs}ms` },
          });
          throw new Error(`[${label}] API timeout after ${config.timeoutMs}ms`);
        }

        // Non-retryable HTTP error (4xx except 429)
        if (status !== undefined && !RETRYABLE_STATUS.has(status)) {
          await appendAILog({
            timestamp: new Date().toISOString(),
            attempt,
            model: config.model,
            request: { systemPrompt: SYSTEM_PROMPT, userMessage: payload },
            error: { message: err.message, status },
          });
          throw new Error(
            `[${label}] API error (non-retryable) HTTP ${status}: ${JSON.stringify(err.response?.data).slice(0, 300)}`,
          );
        }

        // Retryable (429, 500, 502, 503, 504)
        lastError = err;
        await appendAILog({
          timestamp: new Date().toISOString(),
          attempt,
          model: config.model,
          request: { systemPrompt: SYSTEM_PROMPT, userMessage: payload },
          error: { message: err.message, status: status ?? undefined },
        });
        if (attempt < config.maxRetries) {
          const delay = 500 * Math.pow(2, attempt - 1);
          console.error(
            `[DiffGuard][chunk] ${label} — HTTP ${status ?? 'unknown'}, retrying in ${delay}ms (attempt ${attempt}/${config.maxRetries})`,
          );
          await new Promise<void>(res => setTimeout(res, delay));
        }
      } else {
        // Non-axios error — throw immediately
        await appendAILog({
          timestamp: new Date().toISOString(),
          attempt,
          model: config.model,
          request: { systemPrompt: SYSTEM_PROMPT, userMessage: payload },
          error: { message: err instanceof Error ? err.message : String(err) },
        });
        throw err instanceof Error
          ? err
          : new Error(`[${label}] Unexpected error: ${String(err)}`);
      }
    }
  }

  throw new Error(
    `[${label}] AI evaluation failed after ${config.maxRetries} attempt(s): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

// ---------------------------------------------------------------------------
// evaluateFileWithAI — single-file AI request (throws, never process.exit)
// ---------------------------------------------------------------------------

// Sentence boundaries that signal a second issue was concatenated into one comment.
// Ordered from most to least specific to avoid false positives.
const MERGED_SPLIT_RE =
  /\n\n(?=[A-Z])|(?<=\.)\s+(?:Additionally|Furthermore|Also|Moreover|On top of that|Separately),\s+/g;

// Phrases that indicate a comment was collapsed into a narrative summary.
// A comment containing any of these is a hard signal of forbidden merging.
const COLLAPSED_PATTERNS = [
  /\band also\b/i,
  /\badditionally\b/i,
  /\bfurthermore\b/i,
  /\bmultiple issues\b/i,
  /\bseveral problems\b/i,
  /\boverall issue\b/i,
  /\bgeneral problem\b/i,
];

/**
 * Last-resort post-parse safety net that splits collapsed multi-issue comments
 * back into atomic entries. The system prompt is the primary guard; this
 * catches any residual merging the model still produces.
 *
 * Split triggers (in priority order):
 *  1. Blank line followed by a capital letter (paragraph-break pattern).
 *  2. Transitional connectors: "Additionally, ", "Furthermore, ", etc.
 *  3. Emits a warning log when a collapsed-phrase pattern is detected but
 *     cannot be mechanically split — so the reviewer is alerted.
 */
function splitMergedComments(comments: ReviewComment[]): ReviewComment[] {
  const result: ReviewComment[] = [];

  for (const c of comments) {
    const parts = c.message.split(MERGED_SPLIT_RE).map(p => p.trim()).filter(Boolean);

    if (parts.length > 1) {
      for (let i = 0; i < parts.length; i++) {
        result.push({
          ...c,
          message: parts[i],
          // Only the first split part retains the original suggestion; the
          // remaining parts signal that individual fixes must be provided.
          suggestion: i === 0 ? c.suggestion : '',
        });
      }
    } else {
      // Warn on collapsed-phrase patterns that could not be mechanically split
      // so reviewers know the AI violated the granularity contract.
      const collapsed = COLLAPSED_PATTERNS.some(re => re.test(c.message));
      if (collapsed) {
        console.error(
          `[DiffGuard][granularity-warn] Possible merged comment detected in ${c.file}: "${c.message.slice(0, 120)}…"`,
        );
      }
      result.push(c);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// enforceLineAttribution — Rule 3/4 hard guard
// ---------------------------------------------------------------------------

/**
 * Post-parse enforcement of strict line attribution rules:
 *
 *   Rule 3 — NEVER use fallback line 1:
 *     If a comment has lineHint === 1 but line 1 is NOT a changed line in the
 *     file context, the model defaulted to 1 as a "safe" value.  Reset to null
 *     (unresolved_position) and emit a diagnostic.
 *
 *   Rule 4 — Line attribution is MANDATORY:
 *     Log any comment that has lineHint === null so it can be monitored; the
 *     system prompt instructs the model to always resolve to the closest
 *     semantic match before resorting to null.
 *
 * This is a last-resort safety net; the SYSTEM_PROMPT is the primary guard.
 */
function enforceLineAttribution(
  comments: ReviewComment[],
  changedLines: number[],
): ReviewComment[] {
  const changedSet = new Set(changedLines);

  return comments.map(c => {
    if (c.lineHint === 1 && !changedSet.has(1)) {
      // Line 1 is not a changed line — this is a forbidden fallback.
      console.error(
        `[DiffGuard][line-attr] RULE VIOLATION: lineHint=1 fallback in ${c.file} ` +
        `(line 1 not in changed set) — resetting to null. ` +
        `Statement: "${c.violatingStatement.slice(0, 80)}"`,
      );
      return { ...c, lineHint: null };
    }

    if (c.lineHint === null) {
      // Acceptable only when truly unresolvable; log for monitoring.
      console.error(
        `[DiffGuard][line-attr] unresolved_position in ${c.file} — ` +
        `Statement: "${c.violatingStatement.slice(0, 80)}"`,
      );
    }

    return c;
  });
}

/**
 * Evaluates a SINGLE FileContext against the provided rules.
 *
 * Key differences from evaluateWithAI:
 *   - Accepts one FileContext (not an array) — NEVER sends multiple files.
 *   - Throws on all error conditions instead of calling process.exit().
 *     The caller (queue runner) is responsible for failure isolation.
 *   - Uses the fixed backoff: 500ms → 1000ms → 2000ms.
 *   - Applies post-parse comment granularity normalization.
 *   - Applies strict line attribution enforcement (Rules 3 & 4).
 *   - Logs estimated token count per request.
 */
export async function evaluateFileWithAI(
  ctx: FileContext,
  rules: Rule[],
  config: DiffGuardConfig,
  label?: string,
): Promise<AIReviewResult> {
  const serializedRules = serializeRules(rules);
  const payload: AIReviewPayload = { rules: serializedRules, fileContexts: [ctx] };
  const chunkLabel = label ?? ctx.file;

  console.error(
    `[DiffGuard][chunk] ${chunkLabel} — estimated tokens: ${Math.ceil(JSON.stringify(payload).length / 4)}`,
  );

  const result = await callAIWithRetry(payload, config, chunkLabel);
  result.comments = splitMergedComments(result.comments);
  result.comments = enforceLineAttribution(result.comments, ctx.changedLines);
  return result;
}

// ---------------------------------------------------------------------------
// aggregateResults — pure flatten, no dedup (RULE 6: dedup disabled)
// ---------------------------------------------------------------------------

/**
 * Merges multiple AIReviewResult objects (from per-file/per-chunk requests)
 * into a single AIReviewResult.
 *
 * Rules:
 *   - Comments: flat concat only. NO deduplication — every finding from every
 *     chunk is preserved as an independent item regardless of ruleId, message,
 *     or line. (RULE 6 — dedupe is disabled.)
 *   - Summary: non-LGTM summaries are joined verbatim with "\n---\n".
 *     Returns "LGTM" if all results were LGTM or input is empty.
 *   - No AI call is made. This function is deterministic and O(n).
 */
export function aggregateResults(results: AIReviewResult[]): AIReviewResult {
  if (results.length === 0) return { summary: 'LGTM', comments: [] };

  // Flatten all comments — no deduplication (RULE 6)
  const allComments = results.flatMap(r => r.comments);

  // Flat-concat non-LGTM summaries verbatim — no rewriting
  const nonLgtm = results
    .map(r => r.summary)
    .filter(s => s && s.trim() !== '' && s !== 'LGTM');

  const summary = nonLgtm.length > 0 ? nonLgtm.join('\n---\n') : 'LGTM';

  return { summary, comments: allComments };
}
