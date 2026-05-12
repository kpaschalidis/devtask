# UI Direction

This document defines the intended UI beyond the CLI.

The UI should be a local work cockpit for inspecting and controlling `devtask` work. It should not become a project management system, a cloud service, or a new source of truth.

## Product Intent

The CLI is the engine. The UI is the review and control surface.

The UI should make these questions trivial:

- What work is active?
- What stage is each work item in?
- What plan/spec needs review?
- Which targets are affected?
- What artifacts explain the work?
- What is the next safe action?

The developer should not need to remember work ids, target repos, artifact paths, or commands during normal use.

## Storage Constraint

The UI must follow the storage model:

- workspace/repo-local `.devtask/` remains authoritative
- global `~/.devtask/` is discovery/index state only
- UI state must be disposable
- UI actions call the same lifecycle operations as the CLI
- structured artifacts and explicit cross-links should be preferred over path guessing

The UI may cache rendered views, but it must be able to recover by re-reading local artifacts.

## V1 Scope

V1 should be deliberately small:

- local web app started by `devtask ui`
- read active/recent work across known workspaces
- show one work item in detail
- make work and repo plans easy to view and edit
- show the approved graph and target status
- expose the next lifecycle action
- open logs, review findings, diffs, PR links, and CI state from one place

V1 should not include:

- multi-user collaboration
- hosted backend
- replacing Jira/Linear/GitHub/Bitbucket
- merge automation
- UI-only workflow state

## Primary Screens

### Work List

Shows active and recent work:

```text
ID       TITLE                         STAGE     STATUS       UPDATED
CPS-549  Unlink music release          CI        partial      10m ago
APP-123  Billing export                Review    needs input  1h ago
BUG-88   Login redirect loop           Plan      pending      2h ago
```

The work list should support:

- search by id/title/source
- filtering by stage/status
- grouping by workspace
- opening the work detail page

### Work Detail

Shows the selected work item:

```text
Source | Plan | Graph | Targets | Logs | Reviews | PRs | CI
```

The top of the page should show:

- work id and title
- source link/artifact
- current stage
- next action
- approval state
- target summary

### Plan Review

Plan review is the most important V1 UX.

The UI must support viewing and editing:

- work source artifact
- generated work plan
- proposed graph
- repo-specific plans after materialization

Before `approve-plan`, the developer should be able to:

- read the source and generated plan side by side
- edit `work/<id>/plan.md`
- edit or inspect `work/<id>/graph.json`
- refresh the generated plan
- approve the graph

After materialization, the developer should be able to:

- read each repo task plan
- edit `tasks/<task-id>/plan.md` before implementation
- compare repo plans with the approved work graph

Edits must write back to the authoritative local artifact files. The UI should not store a second copy of a plan.

## Plan Editing Rules

Plan editing must be explicit and auditable:

- editing a work plan before approval is allowed
- editing a proposed graph before approval is allowed, but must validate schema before approval
- editing an approved graph in place is not allowed
- changing an approved graph requires a reset/replan/rematerialize workflow
- editing a repo plan before `run` is allowed
- editing a repo plan after `run` should be allowed only as a new revision or with clear warning

The UI should show whether a plan is:

- generated
- edited by human
- approved
- stale relative to source/graph/task state

Future structured metadata can record plan edit history, but V1 may rely on file modification time and stage state until a formal plan revision artifact exists.

## Target Rows

Each materialized target should show:

```text
TARGET     TASK       PLAN     RUN      CHECK    REVIEW   PR      CI      NEXT
backend    api-task   ready    passed   passed   passed   open    passed  done
web        ui-task    ready    passed   passed   failed   -       -       fix
```

Clicking a target should reveal:

- target metadata
- repo plan
- latest logs
- changed files/diff summary
- check output
- review findings
- PR and CI details

## Actions

The UI may expose lifecycle buttons:

- `Refresh Plan`
- `Approve Plan`
- `Repo Plan`
- `Run`
- `Check`
- `Review`
- `Fix`
- `Approve`
- `Commit`
- `Create PR`
- `Check CI`

Actions must use the same lifecycle rules as the CLI. The UI must not bypass approval gates.

## Next Action Model

Every work detail page should show one recommended next action.

The next action should be computed from:

- work-level artifacts
- materialization
- target stage ledgers
- check/review/PR/CI state
- dependency graph

The UI should show why the action is blocked when it cannot proceed.

## Global Discovery

The UI needs a way to find work across local workspaces.

The intended model is:

```text
~/.devtask/index.json
```

This index should contain pointers only:

- workspace id
- workspace path
- recent work ids
- last seen stage/status summaries
- artifact pointers for convenience

The index is not authoritative. If it is deleted, devtask can rebuild it from explicitly registered workspace roots and from workspaces encountered by normal CLI usage.

## Implementation Direction

The first implementation should prioritize stable read APIs over frontend complexity.

Needed CLI/API support:

- `devtask work list --json`
- `devtask work show <id> --json`
- `devtask work board <id> --json`
- `devtask work artifacts <id> --json`
- `devtask task inspect <id> --json`

The UI should consume structured data from these commands or from shared modules, not parse terminal tables.

## Non-Goals

- replacing the CLI engine
- creating a separate database of truth
- hiding the filesystem artifacts
- guessing workflows from provider state without local artifacts
- supporting remote teams in V1

## Open Decisions

- whether `devtask ui` serves a static app plus local API or launches a TUI-like browser view
- exact global index schema
- whether plan edit history gets a first-class `plan-revisions/` directory
- whether graph editing is raw JSON only in V1 or a form-based editor
- how to safely show and refresh git diffs for large repos
