# Polyrepo Group Test Script

Use this script to test `devtask group` with multiple repositories. It is designed for safe README-only tasks.

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

## 1. Choose A Control Repo

The control repo stores group metadata under its own `.devtask/groups/<id>`. It does not own the member repos' task state.

```bash
cd /path/to/control/repo
git status --short
devtask init
```

For a first test, the control repo can be one of the member repos, but using a stable local repo as the control point is easier to reason about.

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

Return to the control repo:

```bash
cd /path/to/control/repo
```

## 4. Create A Group

```bash
devtask group create docs-polyrepo-smoke \
  --goal "Test multi-repo group workflow with README-only changes"
```

Add each repo. This creates repo-local tasks in the target repos:

```bash
devtask group add docs-polyrepo-smoke frontend "$FRONTEND_REPO" \
  --task docs-smoke-frontend \
  --goal "Make one tiny README wording improvement only. Keep changes docs-only and scoped to README.md."

devtask group add docs-polyrepo-smoke backend "$BACKEND_REPO" \
  --task docs-smoke-backend \
  --goal "Make one tiny README wording improvement only. Keep changes docs-only and scoped to README.md."
```

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

Return to the control repo:

```bash
cd /path/to/control/repo
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

When you accept a repo's diff, approve it from that repo:

```bash
cd "$FRONTEND_REPO"
devtask mark docs-smoke-frontend approved

cd "$BACKEND_REPO"
devtask mark docs-smoke-backend approved
```

Return to the control repo:

```bash
cd /path/to/control/repo
devtask group board docs-polyrepo-smoke
```

## 10. Optional PR Flow

Group-level PR creation is not implemented yet. Create PRs repo-by-repo:

```bash
cd "$FRONTEND_REPO"
devtask pr docs-smoke-frontend
devtask ci docs-smoke-frontend

cd "$BACKEND_REPO"
devtask pr docs-smoke-backend
devtask ci docs-smoke-backend
```

## 11. Cleanup Notes

Preview full group cleanup:

```bash
cd /path/to/control/repo
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

Group metadata lives in the control repo:

```bash
rm -rf .devtask/groups/docs-polyrepo-smoke
```
