# Polyrepo Test Script

Use this as a safe multi-repo smoke test. Edit the constants before running commands.

## Constants

```bash
WORKSPACE="/path/to/product"
REPO_A_ID="backend"
REPO_A_PATH="./backend"
REPO_A_KIND="backend"
REPO_A_CHECK="npm test"
REPO_B_ID="web"
REPO_B_PATH="./web"
REPO_B_KIND="frontend"
REPO_B_CHECK="npm run build"
WORK_ID="docs-polyrepo-smoke"
```

## Workspace Setup

```bash
cd "$WORKSPACE"
devtask init
devtask workspace target add "$REPO_A_ID" "$REPO_A_PATH" --kind "$REPO_A_KIND"
devtask workspace target add "$REPO_B_ID" "$REPO_B_PATH" --kind "$REPO_B_KIND"
devtask workspace target list
```

Configure each member repo:

```bash
cd "$WORKSPACE/$REPO_A_PATH"
devtask config check "$REPO_A_CHECK"
devtask config runtime attachable

cd "$WORKSPACE/$REPO_B_PATH"
devtask config check "$REPO_B_CHECK"
devtask config runtime attachable
```

## Create Work

```bash
cd "$WORKSPACE"
devtask work create "$WORK_ID" \
  --title "Improve agent documentation across selected repos" \
  --body "Add or improve AGENTS.md guidance in the configured targets. Keep changes documentation-only and repo-specific."
```

## Work Plan

```bash
devtask work plan "$WORK_ID" --refresh
devtask work show "$WORK_ID"
```

Validate:

- the plan references only configured targets
- `.devtask/work/$WORK_ID/graph.json` has one task per affected target
- dependencies are explicit and justified
- no repo tasks exist yet if the plan is not approved

## Approve And Materialize

```bash
devtask work approve-plan "$WORK_ID"
devtask work board "$WORK_ID"
```

Expected:

- repo-local tasks and worktrees are created inside the member repos
- board shows one row per materialized target

## Repo Planning And Run

```bash
devtask work repo-plan "$WORK_ID" --refresh
devtask work run "$WORK_ID" --follow
devtask work board "$WORK_ID"
```

Expected:

- ready tasks run in parallel
- blocked tasks wait for dependencies
- each target has its own logs and worktree

Inspect one target:

```bash
devtask work logs "$WORK_ID" --target "$REPO_A_ID" --stage run
devtask work attach "$WORK_ID" --target "$REPO_A_ID"
```

## Quality Gates

```bash
devtask work check "$WORK_ID"
devtask work review "$WORK_ID"
devtask work approve "$WORK_ID"
devtask work board "$WORK_ID"
```

Target one repo when needed:

```bash
devtask work check "$WORK_ID" --target "$REPO_A_ID"
devtask work review "$WORK_ID" --target "$REPO_B_ID"
```

## Fix Loop

```bash
devtask work logs "$WORK_ID" --target "$REPO_A_ID" --stage check
devtask work fix "$WORK_ID" --target "$REPO_A_ID" --from check
devtask work check "$WORK_ID" --target "$REPO_A_ID"
```

## Publish

```bash
devtask work commit "$WORK_ID"
devtask work pr "$WORK_ID" --ready
devtask work ci "$WORK_ID"
devtask work show "$WORK_ID"
```

Expected:

- each publishable target gets its own PR
- targets without provider CI can be marked `ci unavailable`
- V1 leaves final review and merge to the developer

## Cleanup

```bash
devtask work cleanup "$WORK_ID" --dry-run
devtask work cleanup "$WORK_ID"
```

Cleanup removes local work metadata, materialized repo task metadata, and worktrees. It does not close PRs or revert commits.
