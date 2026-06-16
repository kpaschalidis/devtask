---
name: commit
description: |
  Use when committing code changes for a devtask task.
  TRIGGER: git commit, staging changes, finalizing work in a task worktree, writing a commit message.
  DO NOT TRIGGER: reviewing code, creating PRs, planning, running tests.
---

# Commit Convention

Use Conventional Commits format: `type(scope): description`

## Type

Choose based on what the commit does:
- `feat` — adds new behaviour
- `fix` — corrects a defect
- `refactor` — changes structure without changing behaviour
- `test` — adds or updates tests only
- `chore` — tooling, config, build, dependencies
- `docs` — documentation only

## Scope

Use the `repoId` of the task (found in `$DEVTASK_TASK_DIR/task.md` or the task goal). Keep it short — one word or hyphenated phrase matching the repo or subsystem.

## Description

- Imperative mood: "add", "fix", "remove" — not "added", "fixes", "removed"
- No capital first letter, no trailing period
- Under 72 characters

## Body (optional)

Include a body when the why is non-obvious. Separate from the subject with a blank line. Wrap at 72 characters.

## Multiple commits

Break into multiple commits when changes are logically independent. Each commit should pass tests on its own. Prefer one commit per logical unit of work rather than one commit per file.

## Examples

```
feat(api): add PR comment routing to orchestrator session
fix(cli): prevent gate approval from throwing on exited session
refactor(storage): extract session-run from phase-run module
```
