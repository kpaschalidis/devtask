# devtask

`devtask` is a local CLI for running persistent, parallel agent tasks against a git repository.

Each task gets:

- a durable task directory under `.devtask/tasks/<id>`
- its own git worktree under `.devtask/worktrees/<id>`
- task, state, result, run, and log files
- a background worker lifecycle you can run, continue, pause, cancel, inspect, check, and review

The goal is to remove the friction of manually juggling multiple agent terminals while keeping each task isolated and inspectable.

One installed `devtask` command can be used across all of your local repositories. State is intentionally repo-local: each target repository gets its own `.devtask` directory, tasks, worktrees, and branches.

## Install

## Prerequisites

- Git with worktree support.
- Node.js 22.x recommended. Use one Node version consistently in every shell that runs `devtask`.
- npm matching that Node installation.
- Codex CLI installed and authenticated.
- GitHub CLI (`gh`) installed and authenticated for `devtask pr` and `devtask ci`.
- tmux installed only if you want attachable task sessions with `devtask run --tmux`.

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
devtask config check 'npm test -w @converge/v0' 'npm run typecheck -w @converge/v0'

devtask create fix-login \
  --goal "Fix login redirect loop and add regression coverage"

devtask run fix-login

devtask list
devtask board
devtask next fix-login
devtask advance fix-login
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

If a worker command exits successfully but does not write a terminal `result.json`, devtask moves the task to `review` instead of looping forever. If the worker writes `{"status":"done"}`, devtask marks the worker run as `done`.

```bash
devtask inspect fix-login
```

`done` means the coding worker believes the task is complete. It does not mean the diff was reviewed, accepted, merged, or shipped. After `done`, inspect the diff, run checks, run review, then mark the task approved when you accept it:

```bash
devtask inspect fix-login
devtask check fix-login
devtask review fix-login
devtask mark fix-login approved
devtask pr fix-login
```

`devtask inspect` summarizes task metadata, the latest run, latest checks, latest review artifact, current worktree changes, and `result.json`. It is the command to use when a worker stops, reaches `review`, or you want to decide whether to check, review, merge, continue, or discard the task worktree.

`devtask check` runs deterministic commands configured with `devtask config check`, such as tests, typecheck, and lint.

`devtask review` runs a read-only Codex review pass and stores the artifact under `.devtask/tasks/<id>/reviews/`.

`devtask board` shows every task as a cockpit view: task status, latest check, latest review, PR state, and the next recommended command.

`devtask next <id>` explains the next action for one task. Without an id, it prints recommendations for all tasks.

`devtask advance <id>` runs the next safe step automatically. It can start or continue a worker, run checks, run the review agent, open an approved PR, or check CI. It stops at human approval and prints the command to run after you inspect the work.

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
- `done`: the worker reported completion; human review and approval may still be required
- `approved`: human accepted the local diff and it can be turned into a PR
- `pr-open`: a GitHub PR exists
- `ci-passed` / `ci-failed`: PR checks were inspected

Run a task inside tmux when you want an attachable terminal:

```bash
devtask run fix-login --tmux
devtask attach fix-login
```

Pause future runs without killing the current command:

```bash
devtask pause fix-login
devtask continue fix-login
```

Cancel the supervisor process group:

```bash
devtask cancel fix-login
```

Inspect stale process metadata or missing worktrees:

```bash
devtask doctor
```

## Multi-Repo Groups

A group coordinates multiple repo-local tasks from one control repository. Each repo still owns its own `.devtask` state, task worktree, checks, review, PR, and CI lifecycle. The group stores only cross-repo coordination metadata.

```bash
devtask group create billing-export \
  --goal "Add billing export across frontend and backend"

devtask group add billing-export backend ~/projects/api \
  --task billing-export-api \
  --goal "Add the billing export API"

devtask group add billing-export frontend ~/projects/web \
  --task billing-export-ui \
  --goal "Add the billing export UI"
```

Use the group cockpit:

```bash
devtask group list
devtask group show billing-export
devtask group inspect billing-export
devtask group board billing-export
devtask group next billing-export
devtask group logs billing-export
devtask group logs billing-export --repo backend -f
devtask group check billing-export
devtask group review billing-export
devtask group run billing-export
devtask group advance billing-export
devtask group remove billing-export frontend
```

`devtask group board` shows every repo task with status, latest check, latest review, PR state, and next command. `devtask group advance` runs safe next steps across repos, using the same single-repo task lifecycle. It still stops at human approval, review findings, failed checks, and ambiguous states.

`devtask group check <id>` and `devtask group review <id>` run the same repo-local lifecycle across every repo in the group. Use `--repo <name>` to run only one member.

`devtask group remove <id> <repo-name>` only removes the repo from the group. Pass `--delete-task` to also delete that repo task's `.devtask/tasks/<task-id>` metadata directory. It does not remove the task worktree or revert code changes.

V1 groups do not do cross-repo handoff generation, dependency ordering, grouped PR creation, or grouped CI fixing. Those belong above the basic coordination layer.

## Task Layout

```text
.devtask/
  groups/
    <id>/
      group.json
      state.md
      plan.md
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

Configure check commands per repository:

```bash
devtask config check 'npm test' 'npm run typecheck'
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
