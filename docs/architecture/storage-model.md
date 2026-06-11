# Storage Model

This document describes the current storage model implemented by `devtask`.

## Principles

- workspace identity is shared by `workspaceId`, not by a common filesystem layout
- durable workspace artifacts live under `~/.devtask/workspaces/<workspaceId>/`
- shared artifacts and local operational state are split
- repo-local state stays minimal
- worktrees live under workspace-local global storage as execution surfaces

## Scope Model

`devtask` currently uses four relevant scopes:

1. global machine state
2. workspace shared state
3. workspace local state
4. repo-local execution state

## Global Machine State

Location:

```text
~/.devtask/
```

Current contents:
- `index.json`
- `workspaces/`

Purpose:
- machine-local discovery
- workspace registration
- recent work aggregation

This layer is not the source of truth for repo execution or work history by itself.

## Workspace Marker

Each developer can choose their own local workspace root. That root contains a minimal marker:

```text
<workspace-root>/.devtask/workspace.json
```

Purpose:
- map a local folder to a `workspaceId`
- allow `resolveWorkspacePaths()` to discover the workspace from the current directory

The marker is intentionally small and not the main storage location.

## Workspace Storage

Primary workspace storage:

```text
~/.devtask/workspaces/<workspaceId>/
├── shared/
└── local/
```

### Shared

Location:

```text
~/.devtask/workspaces/<workspaceId>/shared/
```

Purpose:
- shared workspace metadata
- workspace config
- shared repo registry
- shareable work artifacts

Examples:
- `workspace.json`
- `config.json`
- `repos.json`
- `work/<workId>/work.json`
- `work/<workId>/source.md`
- `work/<workId>/spec.md`
- `work/<workId>/plan.md`
- `work/<workId>/graph.json`
- `work/<workId>/repo-plans/<repoId>.md`

### Local

Location:

```text
~/.devtask/workspaces/<workspaceId>/local/
```

Purpose:
- per-developer repo bindings
- local runtime/session state
- local materialization
- local result artifacts
- local scripts and caches

Examples:
- `repos.local.json`
- `tasks/<taskId>/...`
- `work/<workId>/materialization.json`
- `work/<workId>/results/*.json`
- `work/<workId>/reviews/`
- `work/<workId>/plans/`
- `work/<workId>/spec-runs/`
- `work/<workId>/phase-runs/<phase>/...`

Observability-relevant local artifacts include:
- task metadata with runtime state, paused/blocked reasons, tmux session name, thread id, and agent session id
- persisted phase-run records that link phase status to prompt path, output path, artifact paths, and session metadata
- materialization, result, and review artifacts used by `work diagnose`, `work inspect`, `work runs`, and `session list/show`

## Repo-Local State

Repo-local `devtask` state is intentionally minimized.

Current location for workspace flows:

```text
~/.devtask/workspaces/<workspaceId>/local/worktrees/
```

Purpose:
- hold actual git worktrees used by repo tasks

Long-term direction remains the same: keep repo-local state as small as possible.

## Configuration Ownership

Current implemented config locations:

- workspace config:
  - `~/.devtask/workspaces/<workspaceId>/shared/config.json`
- repo config:
  - `<repo-root>/.devtask/config.json`

Current precedence direction:

```text
work override > repo override > workspace default
```

The current code fully implements workspace config and repo config. Work-level overrides remain more of a contract direction than a rich implemented feature set.

## Cleanup Semantics

Default cleanup should remove:
- repo-local worktrees
- dead local runtime/session state
- local temporary execution artifacts when appropriate

Default cleanup should preserve:
- shared workspace artifacts
- shared specs and plans
- repo plans
- local work history

So cleanup is operational cleanup, not history deletion.
