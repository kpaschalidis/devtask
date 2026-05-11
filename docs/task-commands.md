# Task Commands

`devtask task ...` commands are repo-local primitives used by the work engine.

Most developers should start with `devtask work ...`. Use `devtask task ...` when you need to inspect, recover, or manually control one materialized repo task.

## Create And Run

```bash
devtask task create <task-id> --goal "..."
devtask task plan <task-id>
devtask task run <task-id>
devtask task attach <task-id>
devtask task steer <task-id> "message"
```

Task state is stored under:

```text
.devtask/tasks/<task-id>/
.devtask/worktrees/<task-id>/
```

`run` continues the same task, branch, worktree, state, and result files. It is not a fresh start.

## Inspect

```bash
devtask task list
devtask task board
devtask task status <task-id>
devtask task inspect <task-id>
devtask task logs <task-id>
devtask task logs -f <task-id>
```

## Quality And Publishing

```bash
devtask task check <task-id>
devtask task review <task-id>
devtask task approve <task-id>
devtask task commit <task-id>
devtask task pr <task-id> --ready
devtask task ci <task-id>
```

`task pr` publishes existing commits only. It refuses dirty worktrees and branches with no publishable commits.

## Recovery

```bash
devtask task fix <task-id> --from check
devtask task continue <task-id>
devtask task pause <task-id>
devtask task cancel <task-id>
devtask task cleanup <task-id> --dry-run
devtask task cleanup <task-id>
```

`task mark` is a low-level manual override:

```bash
devtask task mark <task-id> approved
```

Prefer `devtask task approve` or `devtask work approve` during normal workflow because they enforce policy.
