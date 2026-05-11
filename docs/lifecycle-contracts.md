# Lifecycle Contracts

`devtask` is an opinionated local workflow for moving work from source input to reviewed PRs. The public lifecycle is work-item first; repo-local task commands are implementation primitives under `devtask task ...`.

## Principles

- Each stage has explicit inputs, outputs, artifacts, and ownership.
- Agent stages continue from durable context instead of starting over.
- Deterministic stages record machine-readable artifacts.
- Human gates are explicit.
- PR creation publishes existing commits only and must not silently commit dirty work.
- The same work lifecycle must support one repo, a scoped monorepo target, or many repos.

## Work Lifecycle

| Stage | Owner | Main inputs | Main artifacts | Exit |
| --- | --- | --- | --- | --- |
| `create` | CLI | source id/title/body | work item, source artifacts | work item created |
| `plan` | work planner agent | source artifact, target inventory, repo scopes | work plan, proposed graph | graph proposed or failed |
| `approve-plan` | human | proposed graph | approved graph, materialized tasks | repo tasks created |
| `repo-plan` | repo planner agents | approved graph, work plan, repo context | repo task plans | planned or blocked |
| `run` | coding agents | task prompt, repo plan, state, current diff | code/docs changes, logs, result | review, blocked, failed |
| `check` | configured commands | task worktree, repo config | verification record | passed or failed |
| `fix` | coding agent | failed-stage artifact, task context | code changes, fix request/record | ready for re-check |
| `review` | review agent | task diff, plan, latest check | review record | passed or findings |
| `approve` | human | diff, check, review | approved status | approved or rejected |
| `commit` | CLI fallback or agent | accepted worktree changes | git commit | committed branch |
| `pr` | CLI/provider | clean worktree, branch commits, auth | PR/MR URL | published or failed |
| `ci` | CLI/provider | PR/MR URL | CI status record | passed, failed, pending, skipped |
| `cleanup` | CLI | work id | removed local metadata/worktrees | local work removed |

## Stage Ledger

Every executable repo-local stage writes:

```text
.devtask/tasks/<task-id>/stages.json
```

The ledger stores the latest status, timestamps, input summary, output summary, artifacts, and failure reason for stages such as `plan`, `run`, `check`, `fix`, `review`, `approve`, `commit`, `pr`, and `ci`.

The detailed artifacts remain in stage-specific directories:

```text
.devtask/tasks/<task-id>/plans/
.devtask/tasks/<task-id>/runs/
.devtask/tasks/<task-id>/verifications/
.devtask/tasks/<task-id>/reviews/
.devtask/tasks/<task-id>/fixes/
```

`board`, `show`, and workflow decisions read the normalized ledger instead of scraping logs.

## Human Gates

There are two intentional gates:

- `work approve-plan`: accepts the execution graph before repo tasks are created.
- `work approve`: accepts implemented diffs after checks and review.

Publishing commands should not bypass these gates.

## Repo-Local Task Primitive

Materialized tasks live in each target repository:

```text
.devtask/tasks/<task-id>/
.devtask/worktrees/<task-id>/
```

The equivalent primitive commands are under `devtask task ...`:

```bash
devtask task plan <task-id>
devtask task run <task-id>
devtask task check <task-id>
devtask task review <task-id>
devtask task approve <task-id>
devtask task commit <task-id>
devtask task pr <task-id>
devtask task ci <task-id>
```

These commands are useful for recovery and debugging, but the work-item lifecycle should be the normal developer interface.
