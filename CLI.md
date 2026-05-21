# CLI Reference

This document reflects the current CLI surface.

## Workspace

Initialize the current directory as a workspace:

```bash
devtask init
```

Create an explicit workspace identity:

```bash
devtask workspace create --id <workspace-id> --name <name>
```

Import or export a workspace bundle:

```bash
devtask workspace import --file <bundle.zip>
devtask workspace export --workspace <workspace-id> --out <bundle.zip>
```

Inspect and manage registered workspaces:

```bash
devtask workspace show
devtask workspace list
devtask workspace add [path]
devtask workspace remove <id-or-path>
devtask workspace recent
devtask workspace where <work-id>
```

## Repo

Manage repos in the current workspace:

```bash
devtask repo list
devtask repo show <repo-id>
devtask repo add <repo-id> <path> [--kind <kind>] [--scope <scope>]
devtask repo remove <repo-id>
```

Manage local bindings for a shared workspace:

```bash
devtask repo bind --workspace <workspace-id> <repo-id> <path>
devtask repo bind --workspace <workspace-id> --here <repo-id>
devtask repo bindings --workspace <workspace-id>
devtask repo doctor --workspace <workspace-id>
```

## Work

Create or import work:

```bash
devtask work create <work-id> --title <title> [--body <body>]
devtask work import jira <jira-key> [--id <work-id>]
devtask work list
devtask work show <work-id>
```

Inspect work:

```bash
devtask work board <work-id>
devtask work next <work-id>
```

Main flow:

```bash
devtask work spec <work-id>
devtask work plan <work-id>
devtask work repo-plan <work-id> [--refresh]
devtask work implement <work-id>
devtask work check <work-id>
devtask work verify <work-id>
devtask work review <work-id>
devtask work pr <work-id> [--ready]
devtask work ci <work-id>
devtask work cleanup <work-id> [--dry-run]
```

Notes:
- `spec` refines the source into a spec artifact
- `plan` builds the global work plan
- `repo-plan` is triggered manually and builds per-repo implementation plans for all affected repos in the work item
- current `repo-plan` execution is sequential, not parallel
- `implement` materializes repo tasks and worktrees for all repos in the work item
- `check` and `verify` are deterministic
- `review` is agent-backed

## Board

Workspace board:

```bash
devtask board
```

Single work board:

```bash
devtask board work <work-id>
```

Current board UX is terminal table output built from read models. It is not a TUI yet.

## Session

Repo task sessions:

```bash
devtask session list <work-id>
devtask session show <work-id> <repo-id>
devtask session attach <work-id> <repo-id>
devtask session send <work-id> <repo-id> <message>
```

Current CLI support is narrower than the target direction:
- `list`
- `show`
- `attach`
- `send`
- current session steering is tmux-backed

## Worktree

Repo-local worktrees:

```bash
devtask worktree list <work-id>
devtask worktree cleanup <work-id>
```

## Config

Current config commands are minimal:

```bash
devtask config show
devtask config tracker [provider]
devtask config scm [provider]
devtask config model [model]
devtask config jira [--base-url <url>] [--email <email>] [--cloud-id <cloudId>]
```

See [docs/architecture/config-contract.md](docs/architecture/config-contract.md) for the current config model.
