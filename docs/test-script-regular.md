# Regular Repo Test Script

Use this as a safe single-repo smoke test. Edit the constants before running commands.

## Constants

```bash
TARGET_REPO="/path/to/repo"
WORK_ID="readme-smoke"
TARGET_ID="app"
CHECK_1="npm test"
CHECK_2="npm run typecheck"
```

## Setup

```bash
cd "$TARGET_REPO"
devtask init
devtask workspace target add "$TARGET_ID" . --kind app
devtask config check "$CHECK_1" "$CHECK_2"
devtask config runtime attachable
```

Expected:

- `.devtask/config.json` exists
- `devtask workspace target list` shows one target

## Create

```bash
devtask work create "$WORK_ID" \
  --title "Improve README wording" \
  --body "Make a small README-only wording improvement. Do not change runtime code."
```

Expected:

- `devtask work list` shows the work item
- `devtask work show "$WORK_ID"` shows source metadata

## Plan

```bash
devtask work plan "$WORK_ID" --refresh
devtask work show "$WORK_ID"
```

Validate:

- `.devtask/work/$WORK_ID/plan.md` exists
- `.devtask/work/$WORK_ID/graph.json` exists
- graph contains only the configured target
- task goal is documentation-only

## Approve And Materialize

```bash
devtask work approve-plan "$WORK_ID"
devtask work board "$WORK_ID"
```

Expected:

- one repo task exists
- next stage is `repo-plan`

## Repo Plan And Run

```bash
devtask work repo-plan "$WORK_ID" --refresh
devtask work run "$WORK_ID" --follow
devtask work board "$WORK_ID"
```

Expected:

- repo plan artifact exists
- worker finishes with staged lifecycle moving toward `check`
- changed files are limited to README/docs

## Check, Review, Approve

```bash
devtask work check "$WORK_ID"
devtask work review "$WORK_ID"
devtask work approve "$WORK_ID"
devtask work board "$WORK_ID"
```

If checks fail:

```bash
devtask work logs "$WORK_ID" --target "$TARGET_ID" --stage check
devtask work fix "$WORK_ID" --target "$TARGET_ID" --from check
devtask work check "$WORK_ID" --target "$TARGET_ID"
```

## Publish

```bash
devtask work commit "$WORK_ID"
devtask work pr "$WORK_ID" --ready
devtask work ci "$WORK_ID"
devtask work show "$WORK_ID"
```

Expected:

- PR URL appears in `work show`
- CI is `passed`, `pending`, `failed`, or `skipped`

## Cleanup

```bash
devtask work cleanup "$WORK_ID" --dry-run
devtask work cleanup "$WORK_ID"
```

Cleanup removes local work/task metadata and worktrees. It does not delete remote PRs or revert commits.
