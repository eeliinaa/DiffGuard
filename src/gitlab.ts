// GitLab API integration (PAT auth, MR discussions/notes posting)
import axios from 'axios';

export async function postInlineComments(mrId: string, findings: any[]): Promise<void> {
  // TODO: Implement inline comment posting
  throw new Error('Not implemented');
}

export async function postGeneralComment(mrId: string, summary: string): Promise<void> {
  // TODO: Implement general comment posting
  throw new Error('Not implemented');
}
