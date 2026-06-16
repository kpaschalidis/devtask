---
name: branch
description: |
  Use when classifying a work item's kind for branch naming and graph.json authoring.
  TRIGGER: writing or updating graph.json, deciding the top-level "kind" field, classifying whether work is a new capability, a defect fix, or a structural change.
  DO NOT TRIGGER: general git operations, committing code, creating PRs, running tests.
---

# Branch Kind Classification

When writing `graph.json` for a work item, set the top-level `"kind"` field to one of:

- `"feature"` — new user-facing capability, new API, new command, new integration
- `"bugfix"` — corrects incorrect behaviour, fixes a defect, addresses a regression
- `"refactor"` — structural change with no new behavior and no bug fix (rename, extract, reorganize)

## Classification rules

Choose `"bugfix"` if the source ticket or spec describes something that is broken or incorrect.
Choose `"refactor"` if the change touches only internal structure and the observable behavior is unchanged.
Default to `"feature"` when in doubt or when the work adds something that did not exist before.

A single work item has one kind. If the work genuinely spans multiple kinds, split it into separate work items.

## Output

Set `"kind"` at the top level of `graph.json`, alongside `"schemaVersion"` and `"workId"`. `devtask` enforces the branch naming convention `{kind}/{work-id}-{task-id}` for newly materialized tasks, so agents should classify the work item kind rather than invent branch names:

```json
{
  "schemaVersion": 1,
  "workId": "WORK-123",
  "kind": "feature",
  "tasks": [ ... ],
  "features": [ ... ]
}
```
