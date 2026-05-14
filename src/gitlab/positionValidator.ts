// Position Validator — Hard Guarantee Layer for GitLab inline comment placement.
//
// Rules:
//   1. A position is VALID only when new_path exists in the MR diff map AND
//      new_line exists as a changed-line entry for that file.
//   2. If invalid, attempt REPAIR in order:
//        Step 1 — snap to nearest changed line within ±2 lines.
//        Step 2 — fallback to any changed line in the same file.
//        Step 3 — downgrade to global comment (return null).
//   3. Every decision is emitted as a diagnostic log.
//
// NEVER silently accepts an invalid position.

import {
  GitLabInlinePosition,
  MRPositionMap,
} from '../types.js';

const REPAIR_SNAP_TOLERANCE = 2; // ±2 lines for Step 1 repair

// ---------------------------------------------------------------------------
// validateGitLabPosition
// ---------------------------------------------------------------------------

/**
 * Returns `true` only when:
 *   - `position.new_path` is present in `positionMap`, AND
 *   - `position.new_line` matches at least one entry in that file's list.
 */
export function validateGitLabPosition(
  position: GitLabInlinePosition,
  positionMap: MRPositionMap,
): boolean {
  const entries = positionMap.get(position.new_path);
  if (!entries || entries.length === 0) return false;
  return entries.some(e => e.new_line === position.new_line);
}

// ---------------------------------------------------------------------------
// repairGitLabPosition
// ---------------------------------------------------------------------------

/**
 * Attempts to repair an invalid `GitLabInlinePosition` against the live
 * `positionMap`.
 *
 * Returns:
 *   - A repaired `GitLabInlinePosition` (with updated `new_line`) when a
 *     valid candidate is found.
 *   - `null` when no repair is possible (caller must downgrade to global).
 *
 * Repair steps (applied in order, first success wins):
 *   Step 1 — Snap to nearest changed line within ±REPAIR_SNAP_TOLERANCE lines.
 *   Step 2 — Use any changed line in the same file (first entry).
 *   Step 3 — File not in diff map → cannot repair → return null.
 */
export function repairGitLabPosition(
  position: GitLabInlinePosition,
  positionMap: MRPositionMap,
): GitLabInlinePosition | null {
  const entries = positionMap.get(position.new_path);

  if (!entries || entries.length === 0) {
    // File not in diff map at all — cannot repair.
    console.error(
      `[Position][FALLBACK] file=${position.new_path} new_line=${position.new_line} — ` +
      `file not in diff map → downgrading to global`,
    );
    return null;
  }

  // Step 1: nearest changed line within ±REPAIR_SNAP_TOLERANCE
  let nearest: number | null = null;
  let nearestDist = Infinity;
  for (const entry of entries) {
    const dist = Math.abs(entry.new_line - position.new_line);
    if (dist <= REPAIR_SNAP_TOLERANCE && dist < nearestDist) {
      nearest = entry.new_line;
      nearestDist = dist;
    }
  }

  if (nearest !== null) {
    console.error(
      `[Position][REPAIR] file=${position.new_path} snapped from ${position.new_line} → ${nearest}`,
    );
    return { ...position, new_line: nearest };
  }

  // Step 2: any changed line in the same file
  const fallbackLine = entries[0].new_line;
  console.error(
    `[Position][REPAIR] file=${position.new_path} no nearby line — ` +
    `using first changed line ${fallbackLine} (original=${position.new_line})`,
  );
  return { ...position, new_line: fallbackLine };
}

// ---------------------------------------------------------------------------
// validateAndRepairPosition
// ---------------------------------------------------------------------------

/**
 * Single entry point for the hard-guarantee layer.
 *
 * Given a candidate `position`:
 *   - If VALID → logs [VALID] and returns position unchanged.
 *   - If INVALID → attempts repair via `repairGitLabPosition`.
 *     - Repaired → returns repaired position.
 *     - Cannot repair → logs [FALLBACK] and returns `null`.
 *
 * Caller MUST downgrade to global comment when `null` is returned.
 */
export function validateAndRepairPosition(
  position: GitLabInlinePosition,
  positionMap: MRPositionMap,
): GitLabInlinePosition | null {
  if (validateGitLabPosition(position, positionMap)) {
    console.error(
      `[Position][VALID] file=${position.new_path} new_line=${position.new_line}`,
    );
    return position;
  }

  console.error(
    `[Position][INVALID] file=${position.new_path} new_line=${position.new_line} — attempting repair`,
  );
  const repaired = repairGitLabPosition(position, positionMap);

  if (repaired === null) {
    // repairGitLabPosition already logged [FALLBACK]
    return null;
  }

  // Sanity-check the repaired position against the map.
  if (!validateGitLabPosition(repaired, positionMap)) {
    console.error(
      `[Position][FALLBACK] file=${position.new_path} — repaired line ${repaired.new_line} ` +
      `still invalid → downgrading to global`,
    );
    return null;
  }

  return repaired;
}
