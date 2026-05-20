# Workspace Team Onboarding

This document describes the current workspace onboarding model.

## Core Model

`devtask` is local-first.

The shared concept is:
- `workspaceId`

Not:
- a single common local workspace root path across developers

Each developer can keep repos wherever they want locally. They bind those local clone paths to shared repo ids.

## Storage Layers

1. shared workspace artifacts
2. local machine state
3. repo-local worktrees

Shared and local workspace state live under:

```text
~/.devtask/workspaces/<workspaceId>/
```

Repo-local execution surface:

```text
<repo-root>/.devtask/worktrees/
```

## Shared Bundle

The onboarding artifact is a zip bundle exported from workspace `shared/`.

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

Repo paths in `repos.json` are only `pathHint` bootstrap hints.

## Commands

Current workspace commands:

- `devtask workspace create --id <workspace-id> --name <name>`
- `devtask workspace import --file <bundle.zip>`
- `devtask workspace export --workspace <workspace-id> --out <bundle.zip>`
- `devtask workspace list`
- `devtask workspace show`

Current repo binding commands:

- `devtask repo bind --workspace <workspace-id> <repo-id> <path>`
- `devtask repo bind --workspace <workspace-id> --here <repo-id>`
- `devtask repo bindings --workspace <workspace-id>`
- `devtask repo doctor --workspace <workspace-id>`

## Tech Lead Flow

1. Create the workspace:

```bash
devtask workspace create --id platform --name Platform
```

2. Add repos from the local workspace root:

```bash
devtask repo add backend ./backend --kind service
devtask repo add web ./web --kind frontend
```

3. Create shared planning artifacts as needed:
- `devtask work spec <work-id>`
- `devtask work plan <work-id>`
- `devtask work repo-plan <work-id>`

4. Export a bundle:

```bash
devtask workspace export --workspace platform --out platform.bundle.zip
```

## Joining Developer Flow

1. Import the bundle:

```bash
devtask workspace import --file platform.bundle.zip
```

2. Inspect binding state:

```bash
devtask repo bindings --workspace platform
```

3. Bind local clone paths:

```bash
devtask repo bind --workspace platform backend /path/to/backend
devtask repo bind --workspace platform web /path/to/web
```

Or from inside a repo:

```bash
devtask repo bind --workspace platform --here backend
```

4. Validate local setup:

```bash
devtask repo doctor --workspace platform
```

## Warning Model

`repo doctor` and related commands should surface:
- missing local repo binding
- repo path does not exist
- repo path is not a git repo
- repo scope path does not exist

These should normally be warnings, not hard blockers, unless a command actually needs that repo binding to proceed.
