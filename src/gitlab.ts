// GitLab API integration (PAT auth, MR notes posting)
import axios from 'axios';
import { AIReviewResult, GitLabConfig } from './types.js';

const MAX_NOTE_SIZE = 1_000_000;
const TRUNCATION_SUFFIX = '\n\n*(truncated — exceeded GitLab note size limit)*';

function buildNoteBody(result: AIReviewResult): string {
  if (result.comments.length === 0) {
    return result.summary;
  }

  // Group comments by file
  const byFile = new Map<string, typeof result.comments>();
  for (const comment of result.comments) {
    const existing = byFile.get(comment.file) ?? [];
    existing.push(comment);
    byFile.set(comment.file, existing);
  }

  const sections: string[] = [];
  for (const [file, comments] of byFile) {
    const lines = [`### ${file}`];
    for (const c of comments) {
      lines.push(`- [${c.severity}]: ${c.message}`);
      lines.push(`  suggestion: ${c.suggestion}`);
    }
    sections.push(lines.join('\n'));
  }

  return `${result.summary}\n\n${sections.join('\n\n')}`;
}

function truncateBody(body: string): string {
  if (body.length <= MAX_NOTE_SIZE) {
    return body;
  }
  const limit = MAX_NOTE_SIZE - TRUNCATION_SUFFIX.length;
  const lines = body.split('\n');
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    // +1 for the newline that join('\n') adds between lines
    const added = (kept.length === 0 ? 0 : 1) + line.length;
    if (length + added > limit) break;
    kept.push(line);
    length += added;
  }
  return kept.join('\n') + TRUNCATION_SUFFIX;
}

export async function postGitLabMR(result: AIReviewResult, config: GitLabConfig): Promise<void> {
  const body = truncateBody(buildNoteBody(result));
  const url = `${config.baseUrl}/projects/${encodeURIComponent(config.projectId)}/merge_requests/${config.mrIid}/notes`;

  try {
    await axios.post(url, { body }, {
      headers: { 'PRIVATE-TOKEN': config.token },
    });
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')) {
      throw new Error('GitLab request timeout');
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`GitLab API error: ${message}`);
  }
}
