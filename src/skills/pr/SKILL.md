---
name: pr
description: |
  Use when creating a pull request for a completed devtask task.
  TRIGGER: devtask work pr, opening a PR, creating a pull request, submitting changes for review.
  DO NOT TRIGGER: reviewing existing PRs, committing code, planning, running validation.
---

# Pull Request Convention

## Title format

`{kind}({repoId}): {goal summary}`

- `kind` — the work item kind from `graph.json` (`feature`, `bugfix`, `refactor`)
- `repoId` — the repo identifier for this task
- `goal summary` — imperative phrase under 60 characters summarising what the PR does

Examples:
```
feature(api): add PR comment routing to orchestrator
bugfix(cli): prevent gate approval throwing on exited session
refactor(storage): replace phase-run shims with session-run
```

## Body sections

```markdown
## Summary
<!-- 1-3 bullets: what changed and why -->

## Work Item
<!-- devtask work item ID, e.g. WORK-PR-COMMENT -->

## Changes
<!-- bullet list of significant changes by file or area -->

## Validation
<!-- how this was validated: test suite, manual steps, validator output -->
```

## Creating the PR

```bash
gh pr create \
  --title "{kind}({repoId}): {goal summary}" \
  --body "$(cat /tmp/pr-body.md)" \
  --base main
```

Write the body to a temp file first if it is long.

## Rules

- Base branch is `main` unless the task dependencies specify otherwise
- Do not mark as draft unless the task is explicitly incomplete
- Link the work item ID in the body so it is traceable
