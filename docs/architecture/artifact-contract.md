# Artifact Contract

This document describes the current artifact layout in the codebase.

It is intentionally implementation-oriented:
- paths match the active code
- shared vs local ownership is explicit
- repo-local state is limited to execution surfaces

## Workspace Identity

`devtask` uses two workspace anchors:

1. a minimal marker in the developer's chosen workspace root
2. the real shared/local storage under `~/.devtask`

Workspace marker:

```text
<workspace-root>/.devtask/workspace.json
```

Current shape:

```json
{
  "schemaVersion": 1,
  "workspaceId": "platform",
  "root": "/Users/alex/src/platform",
  "createdAt": "2026-05-20T10:00:00.000Z"
}
```

This marker is only a pointer from a local folder to a `workspaceId`.

## Workspace Storage

Primary workspace storage:

```text
~/.devtask/workspaces/<workspaceId>/
├── shared/
└── local/
```

`shared/` contains durable, shareable artifacts.

`local/` contains developer-specific operational state.

## Shared Workspace Artifacts

```text
~/.devtask/workspaces/<workspaceId>/shared/
├── workspace.json
├── config.json
├── repos.json
├── sources/
│   └── jira/
└── work/
    └── <workId>/
        ├── work.json
        ├── source.md
        ├── spec.md
        ├── plan.md
        ├── graph.json
        └── repo-plans/
            └── <repoId>.md
```

### `shared/workspace.json`

Current shape:

```json
{
  "schemaVersion": 1,
  "id": "platform",
  "name": "Platform",
  "root": "/Users/alex/src/platform",
  "createdAt": "2026-05-20T10:00:00.000Z",
  "updatedAt": "2026-05-20T10:00:00.000Z"
}
```

Notes:
- `root` is the local root used when this workspace was created on this machine
- shared identity is `id`

### `shared/config.json`

Workspace-wide config. Current schema lives in [config-contract.md](config-contract.md).

### `shared/repos.json`

Current shape:

```json
{
  "schemaVersion": 1,
  "repos": [
    {
      "id": "backend",
      "scope": null,
      "kind": "service",
      "pathHint": "/Users/lead/src/backend",
      "createdAt": "2026-05-20T10:00:00.000Z",
      "updatedAt": "2026-05-20T10:00:00.000Z"
    }
  ]
}
```

Notes:
- `pathHint` is a bootstrap hint only
- local repo bindings are stored separately

### `shared/work/<workId>/work.json`

Current shape:

```json
{
  "schemaVersion": 1,
  "id": "APP-123",
  "status": "created",
  "source": {
    "type": "jira",
    "key": "APP-123",
    "title": "Add billing export",
    "url": "https://example.atlassian.net/browse/APP-123",
    "artifact": "/abs/path/to/source.json"
  },
  "createdAt": "2026-05-20T10:10:00.000Z",
  "updatedAt": "2026-05-20T10:10:00.000Z"
}
```

Current status support is still minimal in code. Richer status semantics are derived by board/read-model logic.

### `shared/work/<workId>/source.md`

Manual source artifact for manually created work.

### `shared/work/<workId>/spec.md`

Refined shared spec produced by:

```text
devtask work spec <work-id>
```

### `shared/work/<workId>/plan.md`

Global shared plan produced by:

```text
devtask work plan <work-id>
```

### `shared/work/<workId>/graph.json`

Global cross-repo graph produced with the plan.

### `shared/work/<workId>/repo-plans/<repoId>.md`

Per-repo implementation plan produced by:

```text
devtask work repo-plan <work-id>
```

These are intentionally shared for visibility.

## Local Workspace Artifacts

```text
~/.devtask/workspaces/<workspaceId>/local/
├── repos.local.json
├── scripts/
├── tasks/
│   └── <taskId>/
│       ├── meta.json
│       ├── task.md
│       ├── plan.md
│       ├── state.md
│       ├── result.json
│       ├── runs/
│       └── logs/
├── worktrees/
└── work/
    └── <workId>/
        ├── state.md
        ├── graph.snapshot.json
        ├── materialization.json
        ├── results/
        │   ├── check.json
        │   ├── verify.json
        │   ├── review.json
        │   ├── pr.json
        │   └── ci.json
        ├── reviews/
        ├── plans/
        └── spec-runs/
```

### `local/repos.local.json`

Current shape:

```json
{
  "schemaVersion": 1,
  "repos": [
    {
      "id": "backend",
      "repoPath": "/Users/alex/src/backend",
      "createdAt": "2026-05-20T10:00:00.000Z",
      "updatedAt": "2026-05-20T10:00:00.000Z"
    }
  ]
}
```

This is authoritative for local execution.

### `local/work/<workId>/materialization.json`

Local materialization record for repo tasks and worktrees.

### `local/work/<workId>/results/*.json`

Current result artifacts for:
- `check`
- `verify`
- `review`
- `pr`
- `ci`

These are local operational outputs and are not part of the shareable bundle.

### `local/tasks/<taskId>/meta.json`

Repo task execution metadata, including:
- branch
- worktree path
- command
- runtime/session identifiers
- current task status

## Repo-Local Artifacts

Repo-local `devtask` state should stay minimal.

Current execution surface:

```text
<repo-root>/.devtask/worktrees/<taskId>/
```

Worktrees remain repo-local because they are tied directly to git execution.

## Bundle Contents

Current exported bundle is built from `shared/` only.

Included:
- `workspace.json`
- `config.json`
- `repos.json`
- shared docs if present
- shared work artifacts

Not included:
- `repos.local.json`
- local runtime/session state
- result artifacts
- worktrees
