# AI Code Review Engine

## 1. Overview

This project is a CLI-based AI-powered code review tool built with Node.js (TypeScript).  
It analyzes Git diffs and provides structured code review feedback for developers in GitLab Merge Requests.

The system combines:
- Git diff analysis (primary input)
- Static guideline rules (YAML/JSON in repo)
- AI-based reasoning for soft rules (clean code, architecture, readability)
- ESLint-compatible logic (but not replacing ESLint)

The tool is designed for CI execution inside GitLab pipelines and local usage.

---

## 2. Goals

- Provide consistent code review feedback for all developers
- Detect architecture issues, clean code violations, and naming problems
- Reduce manual reviewer load for team leads
- Provide educational feedback (not only strict enforcement)
- Integrate with GitLab Merge Requests

---

## 3. Non-goals

- Not a replacement for ESLint or unit tests
- Not an autonomous refactoring tool
- Not a chat assistant for coding

---

## 4. Tech Stack

- Node.js
- TypeScript
- Git CLI (for diff extraction)
- GitLab REST API
- AI model API (configurable)
- YAML/JSON for guideline rules

---

## 5. Execution Modes

### 5.1 CLI Mode

Run manually or in CI:

```bash
ai-review --staged
ai-review --diff origin/main...HEAD
ai-review --file src/example.tsx
```

### 5.2 GitLab CI Mode

The tool runs as a GitLab CI job in merge request pipelines.

It runs automatically on:
- Merge Request creation
- Merge Request updates (new commits)
- Optional: push events to feature branches

### CI Job Example

```yaml id="c1p9lm"
ai-review:
  stage: test
  image: node:20
  script:
    - npm ci
    - npm run build
    - node dist/cli.js --staged
```

## 6. Input Sources

### 6.1 Git Diff (Primary Source)

- Uses git diff or staged changes
- Must include file paths, line numbers, and change context

### 6.2 File Context

For each changed file:
- Include ±50–200 lines of surrounding context

### 6.3 Guidelines (Repo-based)

Stored in:
/review-guidelines/rules.yaml

Example:

```yaml
rules:
  - id: no-business-in-ui
    type: ai
    severity: warning
    description: Business logic should not be inside React components

  - id: naming-conventions
    type: ai
    description: Use descriptive variable and component names
```

## 7. Rule Types

### 7.1 Deterministic Rules (future extension)

- Not primary in MVP
- Can be added later

### 7.2 AI Rules (primary focus)

Used for:

- Clean code analysis
- Architecture issues
- Readability improvements
- Complexity detection
- Refactoring suggestions

## 8. AI Review Behavior

### 8.1 Input to AI

AI receives:

- git diff
- file context
- relevant guidelines
- language context (React / TypeScript)

### 8.2 Output format (STRICT)

AI must return structured JSON:
```json
{
  "summary": "string",
  "inline": [
    {
      "file": "string",
      "line": number,
      "severity": "info",
      "message": "string",
      "ruleId": "string"
    }
  ],
  "general": [
    {
      "message": "string",
      "category": "architecture | clean-code | naming"
    }
  ]
}
```

Allowed values:
- severity: "info", "warning", "error"
- category: "architecture", "clean-code", "naming"

## 9. Comment Deduplication Rules

- Do not repeat identical issues in multiple places
- Group similar issues into single comment where possible
- Max 5–10 inline comments per Merge Request
- Prioritize high-impact issues

## 10. GitLab Integration

### 10.1 Authentication

Uses GitLab Personal Access Token (PAT):

- Scope: api
- Stored in environment variable: GITLAB_TOKEN

### 10.2 Posting Comments

Two types:

#### Inline Comment (preferred)
- Attached to file + line number
- Shown in merge request diff view

#### General Comment
- MR summary feedback
- Architecture overview

### 10.3 API usage

- Merge Request discussions endpoint
- Notes endpoint for general comments


## 11. Workflow

1. Get diff
2. Load guidelines
3. Build AI prompt
4. Run AI analysis
5. Parse structured response
6. Post results to GitLab MR

## 12. CLI Design

Commands
```bash
ai-review --staged
ai-review --diff <branch>
ai-review --file <path>
ai-review --mr <id>
```

Output modes:
- console output (default)
- JSON output
- GitLab posting mode

## 13. Design Principles

- Deterministic behavior for identical inputs
- Minimal noise (no spam comments)
- Focus on high-impact issues
- Educational tone in feedback
- AI is advisory, not authoritative

## 14. Future Extensions

- Webhook-based GitLab bot
- VS Code extension integration
- caching AI responses
- team-specific guideline profiles
- historical review learning

