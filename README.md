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

```bash
npm install
npm run build
npm link
```

## Basic Workflow

```bash
devtask init
devtask config model gpt-5.2

devtask create fix-login \
  --goal "Fix login redirect loop and add regression coverage"

devtask start fix-login

devtask list
devtask status fix-login
devtask logs fix-login
devtask review fix-login
```

If a worker command exits successfully but does not write a terminal `result.json`, devtask moves the task to `review` instead of looping forever. Inspect it with:

```bash
devtask review fix-login
```

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
