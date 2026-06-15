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
devtask workspace prune
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
devtask work diagnose <work-id>
devtask work inspect <work-id>
devtask work runs <work-id> [--phase <phase>] [--repo <repo-id>] [--latest]
devtask work runs show <work-id> <phase> [repo-id]
```

Main flow:

```bash
devtask work spec <work-id>
devtask work plan <work-id>
devtask work repo-plan <work-id> [--refresh]
devtask work materialize <work-id>
devtask work execute <work-id>
devtask work check <work-id>
devtask work verify <work-id>
devtask work review <work-id>
devtask work pr <work-id> [--ready]
devtask work ci <work-id>
devtask work compound <work-id>
devtask work cleanup <work-id> [--dry-run]
```

Notes:
- `spec` refines the source into a spec artifact
- `plan` builds the global work plan
- `repo-plan` is triggered manually and builds per-repo implementation plans for all affected repos in the work item
- current `repo-plan` execution is sequential, not parallel
- agent-backed phases persist neutral session records and, for Codex today, run in isolated persisted session roots rather than the current interactive Codex thread
- managed `fresh` and `feedback` runs for `spec`, `plan`, `repo-plan`, and `review` install provider-scoped completion hooks automatically; no global hook setup is required
- `materialize` creates repo task records and global workspace worktrees for all repos in the work item
- `execute` launches or resumes the attachable execution sessions for those repo tasks
- `check` and `verify` are deterministic
- `review` is agent-backed
- `compound` writes reusable guidance and local notes into file-backed improvement artifacts

## Board

Workspace board:

```bash
devtask board
```

Static HTML board report:

```bash
devtask board html
devtask board html --workspace <workspace-id>
devtask board html --out <dir>
```

Live local board app:

```bash
devtask board serve
devtask board serve --workspace <workspace-id>
devtask board serve --host 127.0.0.1 --port 4310
```

Single work board:

```bash
devtask board work <work-id>
```

Current board UX is terminal table output plus optional HTML surfaces built from the same read models. `board serve` is a local read-only app, not a separate product backend.

Current diagnostic workflow is:
- `work board` for a compact repo-task status table
- `work diagnose` for why the work or repo task is waiting and which artifact is missing
- `work inspect` for stored artifact paths, latest phase runs, and blocked/failed/paused repo tasks
- `work runs` and `work runs show` for persisted prompt/output/artifact/session traceability by phase, including isolated Codex session metadata

Phase controls:

```bash
devtask work spec <work-id>
devtask work spec attach <work-id>
devtask work spec feedback <work-id> <message>
devtask work spec fresh <work-id>

devtask work plan <work-id>
devtask work plan attach <work-id>
devtask work plan feedback <work-id> <message>
devtask work plan fresh <work-id>

devtask work repo-plan <work-id>
devtask work repo-plan attach <work-id> <repo-id>
devtask work repo-plan feedback <work-id> <repo-id> <message>
devtask work repo-plan fresh <work-id> <repo-id>

devtask work review <work-id>
devtask work review attach <work-id> <repo-id>
devtask work review feedback <work-id> <repo-id> <message>
devtask work review fresh <work-id> <repo-id>

devtask work execute <work-id>
devtask work execute attach <work-id> <repo-id>
devtask work execute feedback <work-id> <repo-id> <message>
devtask work execute fresh <work-id> <repo-id>
```

`spec`, `plan`, `repo-plan`, and `review` start managed background sessions for `fresh` and `feedback`, finalize automatically when the provider reports the turn stopped, and then close their managed tmux session. `attach` opens the live session if one exists, or reopens a finished phase interactively without turning that manual continuation into a new tracked run.

## Worktree

Worktrees:

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
devtask config agent [codex|cursor]
devtask config model [model]
devtask config jira [--base-url <url>] [--email <email>] [--cloud-id <cloudId>]
```

See [docs/architecture/config-contract.md](docs/architecture/config-contract.md) for the current config model.

## Agent

Test the configured agent integration:

```bash
devtask agent test
devtask agent test "Reply with exactly OK"
```
