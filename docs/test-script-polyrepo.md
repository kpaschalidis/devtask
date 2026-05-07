# Polyrepo Group Test Script

Use this script to test `devtask group` with multiple repositories. It is designed for safe README-only tasks.

Runnable helper after installing scripts into a control workspace:

```bash
devtask init --workspace
devtask scripts install
devtask scripts run smoke-polyrepo help
```

You can either follow this document manually or edit/pass constants to the helper script.

## Installed Helper Workflow

Install scripts in the control workspace. This can be a non-git product folder that contains the member repos:

```bash
cd /path/to/control/workspace

devtask init --workspace
devtask scripts install
devtask scripts list
ls -la .devtask/scripts
```

Edit the installed script:

```bash
vim .devtask/scripts/smoke-polyrepo.sh
```

Update the constants at the top for the current run:

```bash
CONTROL_ROOT="/path/to/control/workspace"
REPO_A_PATH="/path/to/frontend"
REPO_B_PATH="/path/to/backend"
```

Run the installed script through `devtask`:

```bash
devtask scripts run smoke-polyrepo setup
devtask scripts run smoke-polyrepo create
devtask scripts run smoke-polyrepo run
devtask scripts run smoke-polyrepo logs-a
```

When the workers finish:

```bash
devtask scripts run smoke-polyrepo inspect
devtask scripts run smoke-polyrepo check
devtask scripts run smoke-polyrepo review
devtask scripts run smoke-polyrepo cleanup-plan
```

You can also avoid editing the file by passing environment overrides:

```bash
CONTROL_ROOT=/path/to/control/workspace REPO_A_PATH=/path/to/frontend REPO_B_PATH=/path/to/backend \
  devtask scripts run smoke-polyrepo setup
```

## 0. Use The Latest Local CLI

Run this from the `devtask-orchestration` repo:

```bash
cd /Users/konstantinospaschalides/Workspace/kpaschal/projects/devtask-orchestration
nvm use 22
npm run build
npm link
hash -r

devtask group --help
```

Confirm help includes:

```text
create
add
remove
inspect
logs
check
review
board
next
run
advance
```

## 1. Choose A Control Workspace

The control workspace stores group metadata under its own `.devtask/groups/<id>`. It does not own the member repos' task state. Use `devtask init --workspace` when the control folder is not a git repository.

```bash
cd /path/to/control/workspace
devtask init --workspace
```

For a first test, the control root can still be one of the member repos with normal `devtask init`, but a product folder initialized with `devtask init --workspace` is usually clearer for polyrepo work.

## 2. Choose Member Repos

Pick two local repos where tiny README-only changes are safe:

```bash
FRONTEND_REPO=/path/to/frontend
BACKEND_REPO=/path/to/backend

git -C "$FRONTEND_REPO" status --short
git -C "$BACKEND_REPO" status --short
```

Each member repo gets its own `.devtask` directory, task metadata, and task worktree.

## 3. Configure Each Member Repo

Set checks per repo. Use commands that are valid for that repo.

```bash
cd "$FRONTEND_REPO"
devtask init
devtask config model gpt-5.2
devtask config check 'npm test' 'npm run typecheck'

cd "$BACKEND_REPO"
devtask init
devtask config model gpt-5.2
devtask config check 'npm test' 'npm run typecheck'
```

If a repo does not have both commands, configure only what exists:

```bash
devtask config check 'npm run typecheck'
```

Return to the control workspace:

```bash
cd /path/to/control/workspace
```

## 4. Create A Group

```bash
cat > docs-polyrepo-smoke-goal.md <<'EOF'
Test multi-repo group workflow with README-only changes.

Each repo task should inspect its own repository first, make one tiny README wording improvement only, and keep changes docs-only and scoped to README.md.
EOF

devtask group create docs-polyrepo-smoke \
  --goal-file docs-polyrepo-smoke-goal.md \
  --repo "frontend=$FRONTEND_REPO:docs-smoke-frontend" \
  --repo "backend=$BACKEND_REPO:docs-smoke-backend"
```

Each `--repo` value is `name=repo-path:task-id`. The command creates the group and the repo-local tasks in one step.

## 5. Inspect Group State

```bash
devtask group list
devtask group show docs-polyrepo-smoke
devtask group board docs-polyrepo-smoke
devtask group next docs-polyrepo-smoke
```

Expected: both repo tasks are `created`, with next actions pointing to `devtask run`.

## 6. Run The Group

```bash
devtask group run docs-polyrepo-smoke
devtask group board docs-polyrepo-smoke
```

Follow one repo's logs:

```bash
devtask group logs docs-polyrepo-smoke --repo frontend -f
```

Stop following logs with `Ctrl-C`. This does not cancel the worker.

Print all latest logs:

```bash
devtask group logs docs-polyrepo-smoke
```

## 7. Inspect Diffs

```bash
devtask group inspect docs-polyrepo-smoke
```

Inspect member worktrees directly:

```bash
cd "$FRONTEND_REPO/.devtask/worktrees/docs-smoke-frontend"
git status --short
git diff

cd "$BACKEND_REPO/.devtask/worktrees/docs-smoke-backend"
git status --short
git diff
```

Expected: tiny `README.md` changes only.

Return to the control workspace:

```bash
cd /path/to/control/workspace
```

## 8. Run Group Checks And Reviews

Run checks across all group members:

```bash
devtask group check docs-polyrepo-smoke
```

Run review across all group members:

```bash
devtask group review docs-polyrepo-smoke
```

Run one repo only when iterating:

```bash
devtask group check docs-polyrepo-smoke --repo frontend
devtask group review docs-polyrepo-smoke --repo backend
```

Expected:

- commands continue across repos
- output identifies each `repo/task`
- exit code is nonzero if any repo fails

## 9. Advance Or Manually Approve

Use the board and next actions:

```bash
devtask group board docs-polyrepo-smoke
devtask group next docs-polyrepo-smoke
```

`group advance` runs safe next actions but stops at human approval:

```bash
devtask group advance docs-polyrepo-smoke
```

When you accept the diffs, approve the repo tasks from the control workspace:

```bash
devtask group mark docs-polyrepo-smoke approved
```

Approve only one repo when iterating:

```bash
devtask group mark docs-polyrepo-smoke approved --repo frontend
```

Then check the control workspace board:

```bash
cd /path/to/control/workspace
devtask group board docs-polyrepo-smoke
```

## 10. Optional PR Flow

Commit any remaining uncommitted task worktree changes from the control workspace:

```bash
devtask group commit docs-polyrepo-smoke
```

Create draft PRs across the group:

```bash
devtask group pr docs-polyrepo-smoke --draft
```

Narrow to one repo when iterating:

```bash
devtask group commit docs-polyrepo-smoke --repo frontend
devtask group pr docs-polyrepo-smoke --repo frontend --draft
```

Repo-level commands are still available from each member repo:

```bash
cd "$FRONTEND_REPO"
devtask commit docs-smoke-frontend
devtask pr docs-smoke-frontend
devtask ci docs-smoke-frontend

cd "$BACKEND_REPO"
devtask commit docs-smoke-backend
devtask pr docs-smoke-backend
devtask ci docs-smoke-backend
```

`devtask pr` and `devtask group pr` publish existing commits only. They refuse dirty worktrees instead of committing implicitly.

## 11. Cleanup Notes

Preview full group cleanup:

```bash
cd /path/to/control/workspace
devtask group cleanup docs-polyrepo-smoke --dry-run
```

Remove every member task worktree, every member task metadata directory, and the group metadata:

```bash
devtask group cleanup docs-polyrepo-smoke
```

Cleanup refuses running tasks and dirty worktrees unless you pass `--force`.

Remove a repo from the group only:

```bash
devtask group remove docs-polyrepo-smoke frontend
```

Remove a repo from the group and delete its repo-local task metadata:

```bash
devtask group remove docs-polyrepo-smoke backend --delete-task
```

`group remove` does not remove task worktrees or revert code changes. Remove worktrees manually from each member repo if needed:

```bash
git -C "$FRONTEND_REPO" worktree remove "$FRONTEND_REPO/.devtask/worktrees/docs-smoke-frontend"
git -C "$BACKEND_REPO" worktree remove "$BACKEND_REPO/.devtask/worktrees/docs-smoke-backend"
```

Group metadata lives in the control workspace:

```bash
rm -rf .devtask/groups/docs-polyrepo-smoke
```
