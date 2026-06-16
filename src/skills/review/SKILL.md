---
name: review
description: |
  Use when reviewing code changes in a devtask task worktree.
  TRIGGER: code review, reviewing a diff, evaluating implementation quality, checking correctness.
  DO NOT TRIGGER: committing code, creating PRs, planning, evaluating validation contract assertions.
---

# Code Review

## Focus

Flag only issues you are confident about. Prioritize:
- Functional correctness — wrong logic, missing cases, off-by-one
- Security — injection, auth bypass, unsafe input handling
- Contract violations — broken API surface, missing required fields, wrong types
- Resource leaks — unclosed handles, missing error path cleanup

Do not flag style, naming, or speculative "what if" scenarios without a concrete trigger path.

## Severity levels

- **P0** — definite crash, data loss, or exploit. Blocks merge.
- **P1** — high-confidence correctness or security issue with a clear trigger path.
- **P2** — real bug with limited or narrow impact. Include only if you can verify the trigger.

## Evidence requirements

Every finding must cite specific evidence:
- Code issue: `file/path.ts:42` — quote the relevant line
- Test failure: exact test name and the failure output line
- Security issue: the concrete input or call path that triggers it

Never write "code exists" or "logic is correct" as evidence. Be specific.

## Finding format

```
[P1] Short imperative title under 80 chars
src/path/to/file.ts:42

One paragraph explaining why this is a bug and how it manifests.
```

## What not to flag

- Test hygiene (unused vars, setup patterns) unless it causes test failure
- Defensive "add a guard here" suggestions without a concrete failure path
- Cosmetic issues (message text, formatting, naming preferences)
- Duplicate findings — same root cause at different locations counts as one finding
