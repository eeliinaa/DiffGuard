# DiffGuard

AI-powered code review CLI for GitLab, enforcing repository guidelines via AI and strict rule evaluation.

## Features
- Deterministic, auditable rule enforcement from `review-guidelines/rules.yaml`
- Git diff and file context analysis
- AI-powered evaluation (AI is advisory only; CLI enforces all rules)
- GitLab Merge Request integration (inline and general comments)
- Production-ready error handling and audit logging

## Quick Start

1. **Install dependencies:**
   ```bash
   npm ci
   ```
2. **Build:**
   ```bash
   npm run build
   ```

3. **Run CLI:**
   ```bash
   node dist/cli.js --staged
   # or
   node dist/cli.js --diff origin/main...HEAD
   # or
   node dist/cli.js --file src/example.tsx
   # or
   node dist/cli.js --mr <id>
   ```

> **Note:** Running the CLI from `src/cli.ts` or using `ts-node` is not supported. Always build first and run from `dist/cli.js`.

## Configuration
- **Rules file:** Place your rules in `review-guidelines/rules.yaml` (see example in repo)
- **GitLab Token:** Set `GITLAB_TOKEN` in your environment for MR posting
- **AI Provider:** Configure endpoint/model via environment variables (see future docs)

## Output Modes
- Console (default)
- JSON (`--json`)
- GitLab posting (`--gitlab`)

## CI Usage Example
```yaml
ai-review:
  stage: test
  image: node:20
  script:
    - npm ci
    - npm run build
    - node dist/cli.js --staged --gitlab
```

## Pipeline Flow
1. Input collection (diff, context)
2. Rule loading and audit initialization
3. AI evaluation (advisory only)
4. Response validation and reconciliation
5. Deduplication and prioritization
6. Output rendering and (optional) GitLab posting
7. Final run report and audit log

## Failure Handling
- All failures are explicit and non-silent
- No partial or malformed MR comments are posted
- Structured fallback output on AI or posting errors

## License
MIT
