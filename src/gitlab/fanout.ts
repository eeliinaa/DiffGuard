// Fan-out queue builder — guarantees 1 AI comment → 1 FanOutItem, zero drops.
import {
  AIReviewResult,
  GitLabInlinePosition,
  GitLabMRVersion,
  ReviewComment,
  ResolvedPositionProvider,
} from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FanOutStatus = 'ready' | 'skipped_duplicate' | 'failed_position' | 'posted';

export type FanOutItem = {
  /** Stable unique identifier for this item within the queue. */
  id: string;
  comment: ReviewComment;
  type: 'inline' | 'global';
  /** Present only when type === 'inline' and position resolution succeeded. */
  position?: GitLabInlinePosition;
  snappedLine?: number;
  /** Stable dedupe key: file:snappedLine:ruleId:normalizedMessage. */
  dedupeKey: string;
  /** Mutable: updated to 'posted' by the posting loop. */
  status: FanOutStatus;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildInlineDedupeKey(
  comment: ReviewComment,
  snappedLine: number,
): string {
  const normalizedMessage = comment.message
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  return [
    comment.file,
    snappedLine,
    comment.ruleId ?? 'no-rule',
    normalizedMessage,
  ].join(':');
}

// ---------------------------------------------------------------------------
// buildFanOutQueue
// ---------------------------------------------------------------------------

/**
 * Converts every AIReviewResult comment into exactly one FanOutItem.
 *
 * Rules:
 * - resolve() succeeds       → type='inline', status='ready'
 * - resolve() fails OR null  → type='global', status='failed_position' (if lineHint set)
 *                              OR type='global', status='ready' (if lineHint null)
 * - dedupeKey in existingKeys → status='skipped_duplicate' (item still included for integrity)
 *
 * NEVER drops a comment silently. All comments produce an item.
 */
export function buildFanOutQueue(
  result: AIReviewResult,
  provider: ResolvedPositionProvider,
  version: GitLabMRVersion,
  existingKeys: Set<string>,
): FanOutItem[] {
  const items: FanOutItem[] = [];

  for (let i = 0; i < result.comments.length; i++) {
    const comment = result.comments[i];

    let resolved: { position: GitLabInlinePosition; snappedLine: number } | null = null;
    try {
      resolved = provider.resolve(comment, { version }) ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[DiffGuard][FANOUT] resolve() threw for ${comment.file}: ${msg}`);
      resolved = null;
    }

    const hasPosition = resolved !== null;
    const type: 'inline' | 'global' = hasPosition ? 'inline' : 'global';
    const snappedLine = hasPosition ? resolved!.snappedLine : undefined;

    // Inline items use the resolved snapped line; global items use the AI
    // lineHint (or -1 as a sentinel for null) so the key always includes a
    // concrete number — never a lossy 'null' string.
    const effectiveLine = snappedLine !== undefined ? snappedLine : (comment.lineHint ?? -1);
    const dedupeKey = buildInlineDedupeKey(comment, effectiveLine);

    console.error(
      '[DiffGuard][DEDUPE]',
      JSON.stringify({
        dedupeKey,
        file: comment.file,
        line: effectiveLine,
      }),
    );

    // A comment is 'failed_position' when resolve returned null but a lineHint
    // existed (i.e. the AI expected an inline placement that couldn't be mapped).
    const positionFailed = !hasPosition && comment.lineHint !== null;

    let status: FanOutStatus;
    if (existingKeys.has(dedupeKey)) {
      status = 'skipped_duplicate';
    } else if (positionFailed) {
      status = 'failed_position';
    } else {
      status = 'ready';
    }

    items.push({
      id: `fanout-${i}`,
      comment,
      type,
      position: hasPosition ? resolved!.position : undefined,
      snappedLine,
      dedupeKey,
      status,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// validateFanOutIntegrity
// ---------------------------------------------------------------------------

/**
 * Hard assertion: every input comment must produce exactly one FanOutItem.
 * Throws immediately if the counts diverge — this is a programming error.
 */
export function validateFanOutIntegrity(inputCount: number, fanoutItems: FanOutItem[]): void {
  if (fanoutItems.length !== inputCount) {
    throw new Error(
      `[DiffGuard] Fan-out integrity violation: expected ${inputCount} items, got ${fanoutItems.length}`,
    );
  }
}
