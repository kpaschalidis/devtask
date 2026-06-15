# Config Contract

This document describes the current config model and the intended precedence rules.

## Current Implemented Locations

Workspace config:

```text
~/.devtask/workspaces/<workspaceId>/shared/config.json
```

Repo config:

```text
<repo-root>/.devtask/config.json
```

## Current Workspace Config Shape

The active config schema is:

```json
{
  "schemaVersion": 1,
  "tracker": {
    "provider": null
  },
  "scm": {
    "provider": null
  "agent": {
    "provider": "codex"
  },
  "codex": {
    "model": null,
    "fullAuto": true
  },
  "runtime": {
    "mode": "attachable",
    "backend": "tmux"
  },
  "runtimeConfigured": false,
  "jira": {
    "baseUrl": null,
    "email": null,
    "cloudId": null
  },
  "ci": {
    "maxFixAttempts": 3
  },
  "verify": []
}
```

## Meaning Of Current Fields

### `tracker`

- `provider`
  - currently `jira` or `null`

This controls tracker identity at the workspace level.

### `scm`

- `provider`
  - currently `github`, `bitbucket`, `gitlab`, or `null`

This controls expected SCM identity at the workspace level.

### `agent`

- `provider`
  - selects the default agent runner
  - supported values: `codex`, `cursor`

### `codex`

- `model`
  - default model for agent execution
- `fullAuto`
  - whether agent bootstrap commands should use auto-approval mode when supported by the selected provider

### `runtime`

- `mode`
  - `attachable` or `plain`
- `backend`
  - currently `tmux` or `null`

### `runtimeConfigured`

Tracks whether the runtime choice was explicitly configured by the user.

### `jira`

Workspace-level Jira settings:
- `baseUrl`
- `email`
- `cloudId`

### `ci`

- `maxFixAttempts`
  - maximum number of scoped auto-fix attempts `work ci-watch` should make after CI failures before marking the work item blocked

### `verify`

List of deterministic verify commands to run in repo worktrees.

## CLI Support

Current config commands:

```bash
devtask config show
devtask config tracker [provider]
devtask config scm [provider]
devtask config agent [codex|cursor]
devtask config model [model]
devtask config jira [--base-url <url>] [--email <email>] [--cloud-id <cloudId>]
```

Repo-specific verify behavior is still primarily managed through repo-local config files and direct file editing rather than a large CLI surface.

## Precedence Direction

The intended precedence remains:

```text
work override > repo override > workspace default
```

Current implementation status:
- workspace config: implemented
- repo config: implemented
- rich work-level override support: only partial

## Non-Goals

Config should not:
- encode workflow gates
- force a lifecycle order
- duplicate workspace config into every repo
- store runtime/session state
