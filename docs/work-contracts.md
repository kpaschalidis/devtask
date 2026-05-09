# Workspace And Work Contracts

This document defines the contract for workspace and work-item commands.

The goal is to keep the work-item layer predictable before it grows into execution fan-out, dependency handling, and provider automation.

## Principles

- Workspace commands manage local inventory, not implementation state.
- Work commands manage source-to-graph orchestration, not repo-local code directly.
- Repo-local tasks remain the unit of execution, branch, worktree, checks, review, commits, and PRs.
- Human gates are explicit: graph approval is separate from diff approval.
- Every stage leaves durable artifacts that can be inspected later.
- Read commands should not mutate local state.

## Workspace Contracts

### `devtask init --workspace`

Creates a non-git control root for work items, targets, groups, sources, and helper scripts.

Inputs:

- current directory

Artifacts:

- `.devtask/workspace.json`
- `.devtask/config.json`
- `.devtask/groups/`
- `.devtask/work/`
- `.devtask/scripts/`

Rules:

- must not require the workspace root itself to be a git repository
- must not initialize member repositories
- member repositories still require repo-local `devtask init` when they need runtime/check configuration

### `devtask workspace target add <id> <repo-path>`

Adds a stable work assignment target.

Inputs:

- target id
- repo path
- optional scope
- optional kind

Artifacts:

- `.devtask/targets.json`

Preconditions:

- target id is valid and unique
- repo path resolves to a git repository
- scope, when provided, is relative to the repo and exists
- repo/scope pair is unique

Rules:

- target id is the durable reference used by work graphs
- `kind` is descriptive metadata only
- target creation must not create repo tasks or worktrees

### `devtask workspace target list`

Lists configured targets.

Inputs:

- `.devtask/targets.json`

Output:

- target id
- kind
- repo path
- scope

Rules:

- read-only
- must not create `.devtask/` files
- should validate stored target metadata before printing

### `devtask workspace target show <id>`

Shows one configured target.

Inputs:

- target id
- `.devtask/targets.json`

Output:

- target metadata JSON

Rules:

- read-only
- must not create `.devtask/` files
- should fail clearly when the target does not exist

### `devtask workspace target remove <id>`

Removes a target from workspace inventory.

Inputs:

- target id

Artifacts:

- updates `.devtask/targets.json`

Rules:

- must not delete repo task metadata
- must not delete worktrees
- must not mutate repositories
- future work should refuse removal when an approved/materialized work item still references the target, unless forced

## Work Contracts

### `devtask work create <id>`

Creates a durable work item from manual input or a tracker source.

Inputs:

- work id
- manual title/body, or provider source id

Artifacts:

- `.devtask/work/<work-id>/work.json`
- `.devtask/work/<work-id>/state.md`
- `.devtask/work/<work-id>/source.md` for manual work
- `.devtask/sources/<provider>/<source-id>.json` for provider-backed work
- `.devtask/sources/<provider>/<source-id>.md` for provider-backed work

Preconditions:

- work id is valid and unique
- provider auth is configured when using provider-backed creation

Rules:

- must not create repo tasks
- must not create branches or worktrees
- must preserve the source artifact for later planning and audit

### `devtask work list`

Lists durable work items.

Inputs:

- `.devtask/work/*/work.json`

Output:

- work id
- status
- source type
- title
- updated time

Rules:

- read-only
- must not create workspace files

### `devtask work show <id>`

Shows one work item.

Inputs:

- work id
- `.devtask/work/<work-id>/work.json`

Output:

- work item metadata JSON

Rules:

- read-only
- must validate referenced source artifacts

### `devtask work plan <id>`

Creates or refreshes the work-level plan and proposed execution graph.

Inputs:

- work item metadata
- source artifact
- workspace target inventory
- target repo/scope contents
- workspace configuration

Artifacts:

- `.devtask/work/<work-id>/plan.md`
- `.devtask/work/<work-id>/graph.json`
- `.devtask/work/<work-id>/plans/<run-id>.prompt.md`
- `.devtask/work/<work-id>/plans/<run-id>.md`
- `.devtask/work/<work-id>/plans/<run-id>.json`

Output:

- `planned` or `failed`

Rules:

- must not create repo tasks
- must not create branches or worktrees
- must not edit target repositories
- must only use configured target ids
- must write fresh `plan.md` and valid fresh `graph.json` to succeed
- graph tasks must describe proposed ownership and dependencies, not implementation state

Graph contract:

```json
{
  "schemaVersion": 1,
  "workId": "WORK-123",
  "tasks": [
    {
      "id": "work-123-api",
      "target": "backend",
      "goal": "Repo/scope-local goal",
      "owns": ["path/or/scope/**"],
      "dependsOn": []
    }
  ],
  "validation": ["validation responsibility"],
  "openQuestions": []
}
```

### `devtask work board <id>`

Shows the current work-level stage and, after materialization, the repo-local task lifecycle state for each target task.

Inputs:

- `.devtask/work/<work-id>/work.json`
- `.devtask/work/<work-id>/plan.md`, if present
- `.devtask/work/<work-id>/graph.json`, if present
- `.devtask/work/<work-id>/materialization.json`, if present
- repo-local task metadata and stage artifacts for materialized tasks

Artifacts:

- none

Rules:

- must be read-only
- before materialization, must show the next work-level command
- after materialization, must show one row per repo-local task
- repo task next commands must be executable from the workspace by including the target repo directory
- must not infer affected targets beyond the approved materialization artifact

### `devtask work approve-plan <id>`

Approves the proposed graph and materializes repo-local tasks.

Inputs:

- `.devtask/work/<work-id>/plan.md`
- `.devtask/work/<work-id>/graph.json`
- workspace target inventory
- repo-local configuration for each target repo

Artifacts:

- `.devtask/work/<work-id>/approved-graph.json`
- `.devtask/work/<work-id>/materialization.json`
- `<repo>/.devtask/tasks/<task-id>/`
- `<repo>/.devtask/worktrees/<task-id>/`
- task branch in each target repo

Preconditions:

- human-readable work plan exists
- graph schema is valid
- graph `workId` matches the work item
- all task ids are valid and unique
- all target ids exist
- all dependencies reference graph task ids
- no materialization already exists
- no repo-local task with the same id already exists

Rules:

- this is a human gate
- must freeze the approved graph before creating repo tasks
- must create repo-local tasks but must not run agents
- materialized repo tasks must include access to work/source artifacts in their managed command
- must fail before partial creation when validation or preflight fails

Current limitation:

- if task creation fails after preflight, rollback is not yet guaranteed. Future implementation should make materialization transactional or record partial materialization for recovery.

### `devtask work repo-plan <id>`

Runs repo-specific planning for materialized tasks.

Inputs:

- source artifact
- work-level `plan.md`
- approved graph
- graph task node
- target repo/scope
- dependency context

Artifacts:

- repo-local `.devtask/tasks/<task-id>/plan.md`
- repo-local plan stage records

Rules:

- must not modify runtime code
- must not create additional repo tasks
- must use the approved graph, not the mutable proposed graph
- must mark each repo-local task as `planned`
- must fail if a repo-local task has moved past planning
- plan should be scoped to the graph node ownership
- dependencies should be visible in the repo plan

### `devtask work run <id>`

Runs materialized repo tasks.

Inputs:

- materialization record
- dependency graph
- repo-local task metadata

Artifacts:

- repo-local run logs
- repo-local state/result updates
- code changes inside task worktrees

Rules:

- may run independent tasks in parallel
- must respect `dependsOn`
- must not run a dependent task before dependencies are `done`
- must only start repo tasks in `planned` or `paused`
- should support per-task attach/steer through existing repo-local runtime

### `devtask work check <id>`

Runs repo-local validation for materialized tasks.

Inputs:

- materialization record
- repo-local check configuration

Artifacts:

- repo-local verification records

Rules:

- must run configured repo-local checks
- missing check config should be explicit
- failed repo checks should fail the work-level command
- must preserve repo-local check details

### `devtask work review <id>`

Runs review across materialized task diffs.

Inputs:

- materialization record
- repo-local task metadata and diffs

Artifacts:

- repo-local review records

Rules:

- review must be read-only
- review findings should fail the work-level command
- review should not fix findings in the same stage

### `devtask work approve <id>`

Human approval gate for materialized implementation.

Inputs:

- materialization record
- repo-local task results
- diffs
- check results
- review results

Artifacts:

- repo-local approval status where applicable

Rules:

- separate from `approve-plan`
- approves implementation diffs, not planning graph
- must not publish PRs

### `devtask work commit <id>`

Commits materialized task worktree changes.

Inputs:

- approved implementation
- repo-local dirty worktrees

Artifacts:

- git commits on task branches
- work-level commit summary

Rules:

- must not push
- must reuse repo-local commit policy
- commit boundaries should match repo-local task ownership

### `devtask work pr <id>`

Publishes materialized task branches.

Inputs:

- clean repo-local task worktrees
- branch commits
- provider auth
- work-level approval

Artifacts:

- repo-local PR/MR URLs

Rules:

- must not silently commit
- must refuse dirty worktrees
- must refuse branches with no commits
- must preserve provider-neutral core workflow

### Future: `devtask work ci <id>` and `devtask work ci-watch <id>`

Checks or monitors CI for published PRs/MRs.

Inputs:

- publication summary
- provider CI status

Artifacts:

- repo-local CI records
- work-level CI summary

Rules:

- failures should route to the owning repo task
- fix loops should have limits
- human gates should remain explicit before republishing when diffs change

## Status Model

Initial work statuses should stay small:

```text
created
planned
materialized
running
review
approved
pr-open
ci-running
ci-failed
ci-passed
blocked
done
failed
cancelled
```

Current implementation only persists `created` on `work.json`; richer status should be introduced with a stage ledger rather than ad hoc metadata updates.

## Next Implementation Focus

Beside real testing, the next implementation focus should be:

1. work-level CI commands that operate from durable publication artifacts.
2. CI watch/fix loop with retry limits.
3. dependency policy configuration for work-level run, if `done` proves too strict in practice.

`work board` now provides the first cockpit for the new work-item flow; the next steps should make the cockpit actionable without hiding human gates.
