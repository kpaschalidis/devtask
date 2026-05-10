# Orchestration UX Roadmap

This checklist tracks the developer-productivity work needed to move `devtask work` from a set of commands into a dependable work cockpit.

## Principles

- The engineer should run work-level commands, not manually choose repos.
- The approved graph should describe lifecycle semantics, not just a loose task list.
- Parallelism should be the default when there is no explicit lifecycle blocker.
- The board should explain the next command, its effect, and why anything is waiting.
- Agent-backed stages should be inspectable and steerable when the runtime supports it.

## Checklist

- [x] Idempotent stage reruns with explicit `--refresh`.
- [x] Work board columns for latest result, blocking reason, and work-level next commands.
- [x] Typed work graph dependencies.
  - [x] Add lifecycle dependency types: `run`, `review`, `approval`, `publish`, `validation`.
  - [x] Make planner output typed dependencies.
  - [x] Make graph validation reject unknown dependency targets and invalid dependency types.
- [ ] Board summary above the table.
  - [ ] Show next command.
  - [ ] Show what the command will start.
  - [ ] Show what is waiting and why.
- [ ] Lifecycle-aware work commands.
  - [x] `work run` blocks only on `run` dependencies.
  - [ ] Later stages honor their relevant dependency types.
  - [ ] Commands should skip not-ready tasks with clear reasons.
- [ ] `work run --follow`.
  - [ ] Start currently runnable tasks.
  - [ ] Wait for running tasks.
  - [ ] Start newly unblocked tasks.
  - [ ] Stop on failure/blocker with a useful board summary.
- [ ] Attachable agent stages.
  - [ ] Make agent-backed stages attachable by default where possible.
  - [ ] Add an opt-out flag.
  - [ ] Support stage-scoped attach commands.
- [ ] Repo-specialist planning.
  - [ ] Replace mechanical repo-plan with one constrained planner per repo task.
  - [ ] Repo planners refine how, not what/where.
  - [ ] Graph changes become blockers/suggestions, not silent scope expansion.

## Dependency Semantics

Typed dependencies describe when one task should wait for another.

- `run`: the dependent task cannot start until the dependency is done.
- `review`: implementation may run, but review should wait for the dependency.
- `approval`: review may happen, but human approval should wait for the dependency.
- `publish`: PR/MR publishing should wait for the dependency.
- `validation`: repo-local work can proceed; final work-level validation/completion depends on the relationship.

Use `run` dependencies sparingly. If two repos can implement against an agreed contract in parallel, prefer `validation` or `approval` dependency instead of blocking execution.
