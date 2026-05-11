import fs from 'fs';
import yaml from 'js-yaml';
import { Rule } from './types';

export function loadRules(rulesPath: string): Rule[] {
  const file = fs.readFileSync(rulesPath, 'utf8');
  const doc = yaml.load(file) as { rules: Rule[] };
  if (!doc || !Array.isArray(doc.rules)) {
    throw new Error('Invalid rules file: missing or malformed rules array');
  }
  // Deterministic sort by id
  return doc.rules.slice().sort((a, b) => a.id.localeCompare(b.id));
}
