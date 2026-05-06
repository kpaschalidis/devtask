# Regular / Monorepo Test Script

Use this script to test the single-repo `devtask` lifecycle in a safe way. It is designed for docs-only changes.

## 0. Use The Latest Local CLI

Run this from the `devtask-orchestration` repo:

```bash
cd /Users/konstantinospaschalides/Workspace/kpaschal/projects/devtask-orchestration
nvm use 22
npm run build
npm link
hash -r

devtask --help
```

Confirm help includes:

```text
inspect
board
next
check
review
advance
run
continue
```

## 1. Pick A Target Repo

Use a repo where a tiny README-only change is safe:

```bash
cd /path/to/your/repo
git status --short
```

If the repo already has unrelated changes, keep that in mind when reviewing the task worktree.

## 2. Initialize And Configure

```bash
devtask init
devtask config model gpt-5.2
devtask config check 'npm test' 'npm run typecheck'
devtask config show
```

Adjust the check commands to match the repo. For example, if the repo has only typecheck:

```bash
devtask config check 'npm run typecheck'
```

## 3. Create A Safe Task

```bash
devtask create readme-smoke \
  --goal "Make one tiny README wording improvement only. Keep changes docs-only and scoped to README.md. Do not change code, package files, config, generated files, or lockfiles."
```

## 4. Run The Worker

```bash
devtask run readme-smoke
devtask board
devtask logs -f readme-smoke
```

Stop following logs with `Ctrl-C`. This does not cancel the worker.

## 5. Inspect The Result

```bash
devtask status readme-smoke
devtask inspect readme-smoke
devtask next readme-smoke
```

Inspect the actual worktree diff:

```bash
cd .devtask/worktrees/readme-smoke
git status --short
git diff
```

Expected: a small `README.md` diff only.

Return to the repo root:

```bash
cd -
```

## 6. Run Checks And Review

```bash
devtask check readme-smoke
devtask review readme-smoke
```

Expected:

- `devtask check` prints each configured command before running it.
- `devtask review` streams the review agent output and writes a review artifact.

## 7. Approve Or Continue

If the diff is acceptable and checks/review passed:

```bash
devtask mark readme-smoke approved
devtask board
```

If checks or review found issues:

```bash
devtask continue readme-smoke
devtask logs -f readme-smoke
```

## 8. Optional PR Flow

Only do this if the repo has a remote and you are comfortable creating a draft PR:

```bash
devtask pr readme-smoke
devtask ci readme-smoke
```

## 9. Cleanup Notes

There is no full cleanup command yet. For manual cleanup, inspect first:

```bash
devtask status readme-smoke
git worktree list
```

If you want to remove the task worktree manually:

```bash
git worktree remove .devtask/worktrees/readme-smoke
```

Then remove task metadata if you no longer need the record:

```bash
rm -rf .devtask/tasks/readme-smoke
```

Do not remove task metadata if you still want logs, run records, review artifacts, or task history.
