# devtask

`devtask` is a local CLI for running persistent, parallel agent tasks against a git repository.

Each task gets:

- a durable task directory under `.devtask/tasks/<id>`
- its own git worktree under `.devtask/worktrees/<id>`
- task, state, result, run, and log files
- a background worker lifecycle you can start, pause, resume, cancel, inspect, and review

The goal is to remove the friction of manually juggling multiple agent terminals while keeping each task isolated and inspectable.

One installed `devtask` command can be used across all of your local repositories. State is intentionally repo-local: each target repository gets its own `.devtask` directory, tasks, worktrees, and branches.

## Install

## Prerequisites

- Git with worktree support.
- Node.js 22.x recommended. Use one Node version consistently in every shell that runs `devtask`.
- npm matching that Node installation.
- Codex CLI installed and authenticated.
- GitHub CLI (`gh`) installed and authenticated for `devtask pr` and `devtask ci`.
- tmux installed only if you want attachable task sessions with `devtask start --tmux`.

Recommended local setup:

```bash
nvm use 22
nvm alias default 22
node --version
gh auth status
codex --version
```

```bash
npm install
npm run build
npm link
```

## Basic Workflow

```bash
devtask init
devtask config model gpt-5.2
devtask config verify 'npm test -w @converge/v0' 'npm run typecheck -w @converge/v0'

devtask create fix-login \
  --goal "Fix login redirect loop and add regression coverage"

devtask start fix-login

devtask list
devtask status fix-login
devtask logs fix-login
devtask logs -f fix-login
devtask inspect fix-login
devtask check fix-login
devtask review fix-login
devtask mark fix-login approved
devtask pr fix-login
devtask ci fix-login
```

If a worker command exits successfully but does not write a terminal `result.json`, devtask moves the task to `review` instead of looping forever. Inspect it with:

```bash
devtask inspect fix-login
```

`devtask inspect` summarizes task metadata, the latest run, latest checks, latest review artifact, current worktree changes, and `result.json`. It is the command to use when a worker stops, reaches `review`, or you want to decide whether to check, review, merge, resume, or discard the task worktree.

`devtask check` runs deterministic commands configured with `devtask config verify`, such as tests, typecheck, and lint.

`devtask review` runs a read-only Codex review pass and stores the artifact under `.devtask/tasks/<id>/reviews/`.

You can correct or record human decisions on stopped tasks:

```bash
devtask mark fix-login review
devtask mark fix-login approved
devtask mark fix-login done
devtask mark fix-login blocked
devtask mark fix-login cancelled
```

Common states:

- `review`: useful work exists and needs human inspection
- `approved`: human accepted the local diff and it can be turned into a PR
- `pr-open`: a GitHub PR exists
- `ci-passed` / `ci-failed`: PR checks were inspected
- `done`: accepted and complete

Run a task inside tmux when you want an attachable terminal:

```bash
devtask start fix-login --tmux
devtask attach fix-login
```

Pause future runs without killing the current command:

```bash
devtask pause fix-login
devtask resume fix-login
```

Cancel the supervisor process group:

```bash
devtask cancel fix-login
```

Inspect stale process metadata or missing worktrees:

```bash
devtask doctor
```

## Task Layout

```text
.devtask/
  tasks/
    <id>/
      task.md
      state.md
      result.json
      meta.json
      lock.json
      logs/
      runs/
  worktrees/
    <id>/
```

## Worker Contract

By default, a task runs:

```bash
codex exec --full-auto --add-dir "$DEVTASK_TASK_DIR" - < "$DEVTASK_TASK_PATH"
```

You can override it at creation time:

```bash
devtask create my-task --cmd "npm test"
```

Set the default Codex model per repository:

```bash
devtask config model gpt-5.2
```

Override one task:

```bash
devtask create my-task --model gpt-5.2
devtask model my-task gpt-5.2
```

You can also update an existing task command:

```bash
devtask command my-task 'npm test'
```

Configure verification commands per repository:

```bash
devtask config verify 'npm test' 'npm run typecheck'
devtask check my-task
```

Open a draft PR after review/approval:

```bash
devtask mark my-task approved
devtask pr my-task
devtask ci my-task
```

The worker command runs from the task worktree and receives these environment variables:

- `DEVTASK_ROOT`
- `DEVTASK_TASK_ID`
- `DEVTASK_TASK_DIR`
- `DEVTASK_TASK_PATH`
- `DEVTASK_STATE_PATH`
- `DEVTASK_RESULT_PATH`

When the command writes this result, the worker marks the task as done:

```json
{
  "status": "done"
}
```
