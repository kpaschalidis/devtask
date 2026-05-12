# Storage Model

This document defines the durable storage model for `devtask`.

It exists to answer these questions precisely:

- what artifacts and config files exist
- where they live
- which scope owns them
- which ones are authoritative versus derived
- who writes them
- how monorepo and polyrepo differ

This document should be treated as the storage contract that future CLI, automation, and UI work must follow.

## Principles

- Repo/workspace-local `.devtask/` is the execution truth.
- Global `~/.devtask/` is optional discovery/index state only.
- Every structured artifact must declare `schemaVersion`.
- Work orchestration and repo execution are separate concerns even when they share one filesystem root.
- Human approvals create immutable boundaries.
- Derived/index state must be safe to delete and rebuild.
- The future UI may inspect all artifacts, but it must not become the primary source of truth.

## Scope Model

`devtask` uses four logical scopes:

- `global`: machine-local discovery and cache
- `workspace`: orchestration scope
- `repo`: git execution scope
- `work` / `task`: durable workflow records within those scopes

The key distinction is:

- `workspace` decides what should happen
- `repo` owns where git changes happen
- `target` defines ownership boundaries inside the workspace
- `task` is the execution unit inside one repo

## Authority Model

Each artifact must fall into one of these categories:

- `authoritative`
  - source of truth for a scope or stage
- `derived`
  - generated from authoritative artifacts
- `index`
  - convenience pointer/cache for discovery
- `ephemeral`
  - runtime scratch files that may be recreated freely

Rules:

- CLI correctness must never depend on global index state.
- Repo/workspace-local artifacts must remain usable if `~/.devtask/` is deleted.
- If an authoritative artifact and a derived artifact disagree, the authoritative artifact wins.

## Physical Layout

### Global

Proposed home:

```text
~/.devtask/
```

This scope is optional.

It should contain only:

- discovery index
- recent work pointers
- UI/session convenience state
- caches that can be rebuilt

It must not contain:

- authoritative work graphs
- authoritative task ledgers
- task worktrees
- repo-local execution truth

### Workspace

Workspace truth lives at:

```text
<workspace-root>/.devtask/
```

This is used for:

- polyrepo orchestration across many repos
- monorepo orchestration across many targets in one repo
- single-repo work when workspace root equals repo root

### Repo

Repo truth lives at:

```text
<repo-root>/.devtask/
```

This is used for:

- repo-local config
- materialized repo tasks
- worktrees
- repo-local stage ledgers

In polyrepo, workspace and repo roots are different.

In monorepo, workspace root and repo root may be the same directory.

## Monorepo Rule

Monorepo overlap is intentional.

When:

```text
workspace root == repo root
```

there is still only one:

```text
.devtask/
```

The distinction is logical, not physical:

- workspace artifacts describe orchestration
- repo artifacts describe git execution
- target scope distinguishes ownership boundaries inside the same repo

Example:

```text
target api    -> repo=/monorepo, scope=packages/api
target web    -> repo=/monorepo, scope=apps/web
target worker -> repo=/monorepo, scope=packages/worker
```

Multiple repo tasks may therefore exist in the same repo while still belonging to different targets.

## Identity Rules

The storage model depends on stable identifiers:

- `workspace id`
  - stable local identifier for discovery/index use
- `target id`
  - unique within one workspace
- `work id`
  - unique within one workspace
- `task id`
  - unique within one repo
- `stage attempt id`
  - unique within one task and stage artifact family
- `source id`
  - provider-specific source identifier such as a Jira issue key

Rules:

- `target id` is the stable address used by work graphs.
- `task id` is the stable execution unit materialized from a work graph task.
- `graph task id` and `task id` may be the same today, but the contract should treat them as distinct concepts.

## Workspace Artifacts

### Directory

```text
<workspace-root>/.devtask/
```

### Catalog

`workspace.json`
- category: `authoritative`
- owner: workspace
- writer: `devtask init --workspace`
- purpose: marks a directory as a workspace root
- mutation: latest snapshot
- rebuildable: no

`config.json`
- category: `authoritative`
- owner: workspace or repo depending on location
- writer: `devtask init`, `devtask config ...`
- purpose: runtime/check/provider defaults for that root
- mutation: latest snapshot
- rebuildable: partially

`targets.json`
- category: `authoritative`
- owner: workspace
- writer: `devtask workspace target ...`
- purpose: stable target inventory
- mutation: latest snapshot
- rebuildable: no

`sources/<provider>/<source-id>.json`
- category: `authoritative`
- owner: workspace
- writer: provider ingestion command
- purpose: structured source artifact
- mutation: replaceable only by explicit refresh/re-fetch
- rebuildable: usually yes, if remote source still exists

`sources/<provider>/<source-id>.md`
- category: `derived`
- owner: workspace
- writer: provider ingestion command
- purpose: human-readable source artifact
- mutation: replaceable with source refresh
- rebuildable: yes

`work/<work-id>/`
- category: mixed
- owner: workspace
- purpose: durable work item artifacts

## Work Artifacts

### Directory

```text
<workspace-root>/.devtask/work/<work-id>/
```

### Catalog

`work.json`
- category: `authoritative`
- owner: work item
- writer: `devtask work create`
- purpose: base work metadata and source linkage
- mutation: latest snapshot
- rebuildable: no

`state.md`
- category: `authoritative`
- owner: work item
- writer: CLI and future orchestrator stages
- purpose: durable human-readable work progress
- mutation: append or replace, but must remain durable text state
- rebuildable: partially

`source.md`
- category: `authoritative` for manual work only
- owner: work item
- writer: `devtask work create --title/--body`
- purpose: preserved manual source input
- mutation: immutable after create unless explicit refresh workflow exists
- rebuildable: no

`plan.md`
- category: `authoritative`
- owner: work item
- writer: `devtask work plan`
- purpose: human-readable orchestration/spec plan
- mutation: replaceable only before approval, or by explicit refresh rules
- rebuildable: yes from source + targets, but not equivalent once human-reviewed

`graph.json`
- category: `authoritative`
- owner: work item
- writer: `devtask work plan`
- purpose: proposed execution graph
- mutation: replaceable only before plan approval or through explicit refresh
- rebuildable: yes before approval

`approved-graph.json`
- category: `authoritative`
- owner: work item
- writer: `devtask work approve-plan`
- purpose: frozen approved graph
- mutation: immutable after approval unless the workflow explicitly resets/re-materializes
- rebuildable: no, because it represents a human decision boundary

`materialization.json`
- category: `authoritative`
- owner: work item
- writer: `devtask work approve-plan`
- purpose: maps approved graph tasks to repo-local tasks, branches, and worktrees
- mutation: append/replace only by explicit re-materialization rules
- rebuildable: partly, but should be treated as durable execution mapping

`plans/<run-id>.prompt.md`
- category: `derived`
- owner: work item
- writer: planner stage
- purpose: exact planner prompt audit trail
- mutation: immutable per attempt
- rebuildable: yes

`plans/<run-id>.md`
- category: `derived`
- owner: work item
- writer: planner stage
- purpose: raw planner output log
- mutation: immutable per attempt
- rebuildable: yes

`plans/<run-id>.json`
- category: `authoritative`
- owner: work planning stage attempt
- writer: planner stage
- purpose: machine-readable attempt record
- mutation: immutable per attempt
- rebuildable: no

Future:

`stages.json`
- category: `authoritative`
- owner: work item
- writer: work-level stages
- purpose: normalized latest work-level stage ledger
- mutation: latest snapshot per stage, append semantics via per-stage records if needed
- rebuildable: partially, but should be treated as primary workflow summary once introduced

## Repo Artifacts

### Directory

```text
<repo-root>/.devtask/
```

### Catalog

`config.json`
- category: `authoritative`
- owner: repo
- writer: `devtask init`, `devtask config ...`
- purpose: repo-local runtime/check/provider defaults
- mutation: latest snapshot
- rebuildable: partially

`tasks/`
- category: mixed
- owner: repo
- purpose: task metadata and stage artifacts

`worktrees/`
- category: `authoritative`
- owner: repo execution layer
- writer: task creation/materialization
- purpose: isolated git worktrees
- mutation: created and deleted by lifecycle/cleanup
- rebuildable: yes from branch/task metadata if inputs still exist

## Task Artifacts

### Directory

```text
<repo-root>/.devtask/tasks/<task-id>/
```

### Catalog

`meta.json`
- category: `authoritative`
- owner: task
- writer: task lifecycle
- purpose: task status, branch, worktree path, command, runtime pointers
- mutation: latest snapshot
- rebuildable: partially

`task.md`
- category: `authoritative`
- owner: task
- writer: task creation/materialization
- purpose: durable task prompt/spec
- mutation: generally immutable after creation except explicit operator edits
- rebuildable: no

`plan.md`
- category: `authoritative`
- owner: task
- writer: `devtask task plan` or `devtask work repo-plan`
- purpose: repo-specialist implementation plan
- mutation: replaceable before run or via explicit refresh
- rebuildable: yes before execution, but not once accepted as reviewed context

`state.md`
- category: `authoritative`
- owner: task
- writer: coding agent / lifecycle
- purpose: durable human-readable task progress
- mutation: append/replace
- rebuildable: partially

`result.json`
- category: `authoritative`
- owner: task
- writer: coding agent / lifecycle
- purpose: terminal task result contract
- mutation: latest snapshot
- rebuildable: no

`stages.json`
- category: `authoritative`
- owner: task
- writer: stage execution
- purpose: normalized latest stage ledger
- mutation: latest snapshot per stage
- rebuildable: partially from rich stage artifacts, but should be treated as primary summary

`plans/<attempt-id>.*`
- category: mixed
- owner: task planning stage
- purpose: prompt/output/attempt record

`runs/<attempt-id>.json`
- category: `authoritative`
- owner: run stage attempt
- writer: worker lifecycle
- purpose: machine-readable run attempt
- mutation: immutable per attempt
- rebuildable: no

`logs/<attempt-id>.log`
- category: `derived`
- owner: run or stage attempt
- writer: command/stage runtime
- purpose: human-readable logs
- mutation: append during attempt, immutable after completion
- rebuildable: no

`verifications/<attempt-id>.json`
- category: `authoritative`
- owner: check stage attempt
- writer: check stage
- purpose: deterministic verification result
- mutation: immutable per attempt
- rebuildable: no

`reviews/<attempt-id>.json`
- category: `authoritative`
- owner: review stage attempt
- writer: review stage
- purpose: machine-readable review result
- mutation: immutable per attempt
- rebuildable: no

`reviews/<attempt-id>.md`
- category: `derived`
- owner: review stage attempt
- writer: review stage
- purpose: human-readable review output
- mutation: immutable per attempt
- rebuildable: yes from raw output if preserved

`fixes/<attempt-id>.json`
- category: `authoritative`
- owner: fix stage request/attempt
- writer: fix lifecycle
- purpose: ties a fix run to a failed stage artifact
- mutation: immutable per attempt
- rebuildable: no

### Runtime Scratch Files

The following are ephemeral worktree-local transport files:

```text
<worktree>/.devtask_state.md
<worktree>/.devtask_result.json
<worktree>/.devtask_plan.md
<worktree>/.devtask_plan_state.md
<worktree>/.devtask_plan_result.json
```

These are:

- category: `ephemeral`
- owner: runtime transport layer
- writer: worker/planner runtime
- purpose: bridge writable sandbox and durable task storage
- mutation: replaceable
- rebuildable: yes

They must not be treated as durable state once their contents have been persisted back into task artifacts.

## Target Semantics

Each target defines:

- `target id`
- `repo path`
- optional `scope`
- optional `kind`

The `scope` should be treated as:

- planning boundary
- review boundary
- ownership hint

It should not yet be treated as a hard execution sandbox. A task may still need to read outside its scope to understand shared interfaces and tests.

## Cross-Link Rules

Artifacts must reference each other explicitly where possible.

At minimum:

- `work.json` references the source artifact
- `materialization.json` references approved graph task ids and repo task ids
- `task.md` should include parent work id and target id for materialized tasks
- `stages.json` should include artifact paths for the latest stage outputs
- provider PR state in task metadata should link back to the task and branch

This is required so a UI or CLI can navigate artifacts without path guessing.

## Mutation Rules

### Immutable After Approval

These artifacts represent human decision boundaries and should not change in place:

- `approved-graph.json`
- historical stage attempt records
- historical verification/review/fix/run attempt artifacts

### Refreshable Before Boundary

These artifacts may be replaced before the corresponding approval boundary:

- `work/<id>/plan.md`
- `work/<id>/graph.json`
- `tasks/<id>/plan.md`

### Latest Snapshot

These are mutable current-state files:

- `config.json`
- `meta.json`
- `result.json`
- `stages.json`
- `targets.json`
- `work.json`

## Rebuild Rules

Safe to delete and rebuild:

- global index state under `~/.devtask/`
- markdown renderings derived from structured provider source
- worktree-local runtime scratch files
- some summaries derived from task/work ledgers

Not safe to delete without loss:

- `task.md`
- `plan.md` after human review/approval
- `approved-graph.json`
- `materialization.json`
- stage attempt records
- verification/review/fix attempt records

## Cleanup Rules

Cleanup must respect scope:

- `task cleanup`
  - removes one repo task metadata directory
  - optionally removes its worktree

- `work cleanup`
  - removes work-level metadata
  - removes all materialized repo task metadata/worktrees linked from `materialization.json`

Cleanup must not:

- mutate unrelated repos
- silently remove authoritative artifacts still needed by another active work item
- depend on global index state

## Stage To Artifact Mapping

`create`
- writes `work.json` or `task.md` / `meta.json`

`work plan`
- writes `work/<id>/plan.md`
- writes `work/<id>/graph.json`
- writes `work/<id>/plans/*`

`approve-plan`
- writes `approved-graph.json`
- writes `materialization.json`
- creates repo tasks/worktrees

`repo-plan`
- writes `tasks/<id>/plan.md`
- writes `tasks/<id>/plans/*`

`run`
- writes `state.md`
- writes `result.json`
- writes `runs/*`
- writes `logs/*`
- updates `stages.json`

`check`
- writes `verifications/*`
- updates `stages.json`

`fix`
- writes `fixes/*`
- may start new run attempts
- updates `stages.json`

`review`
- writes `reviews/*`
- updates `stages.json`

`approve`
- updates task status and stage ledger

`commit`
- records commit stage output

`pr`
- records PR URL/state in task metadata and stage ledger

`ci`
- records CI state in task metadata and stage ledger

## Future UI Constraint

The future UI should assume:

- artifact truth is local-first
- every important artifact has a stable path
- every important structured artifact has a schema version
- artifact discovery should prefer explicit references over path conventions

The UI may use a global index for discovery, but it must read authoritative state from workspace/repo-local artifacts.

## Open Decisions

- exact format of future global index under `~/.devtask/`
- whether work items also get a normalized `stages.json`
- whether repo task ids and graph task ids should stay identical or diverge explicitly
- how strict scope enforcement should become in monorepo targets
- whether task/work state markdown should become append-only event logs plus rendered summary, or remain mutable narrative files
