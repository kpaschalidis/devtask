# devtask

`devtask` is a local tool I use to manage AI-assisted work across multiple projects, workspaces, repos, and tickets.

It is built for a setup like:
- multiple repos per product
- vague Jira tickets that need refinement before coding
- one or more developers working locally with Codex
- deterministic checks plus agent-assisted planning and review

`devtask` is not trying to be a workflow engine. It is a local control plane around:
- workspaces
- repo bindings
- work items
- shared specs and plans
- repo-local worktrees
- agent sessions

## Requirements

- Node.js 22.x
- Git with worktree support
- Codex CLI installed and authenticated
- provider auth for PR/CI operations:
  - GitHub: `gh`
  - Bitbucket Cloud: `BITBUCKET_EMAIL` and `BITBUCKET_API_TOKEN`
  - GitLab: `glab`
- Jira auth if you import work from Jira

See [docs/auth-and-environment.md](/Users/konstantinospaschalides/Workspace/kpaschal/projects/devtask-orchestration-v1/docs/auth-and-environment.md).

## Install

```bash
npm install
npm run build
npm link
devtask --help
```

## Quick Start

Create a workspace and register it locally:

```bash
cd /path/to/product
devtask workspace create --id platform --name Platform
```

Add repos to that workspace:

```bash
devtask repo add backend ./backend --kind service
devtask repo add web ./web --kind frontend
```

Create or import work:

```bash
devtask work import jira APP-123
```

Refine and plan it:

```bash
devtask work spec APP-123
devtask work plan APP-123
devtask work repo-plan APP-123
```

Then execute and validate:

```bash
devtask work implement APP-123
devtask work check APP-123
devtask work verify APP-123
devtask work review APP-123
devtask work pr APP-123 --ready
```

Use the board to keep track of active work:

```bash
devtask board
devtask board work APP-123
```

## Team Onboarding

Workspaces are local-first and exportable.

Tech lead:

```bash
devtask workspace create --id platform --name Platform
devtask workspace export --workspace platform --out platform.bundle.zip
```

Another developer:

```bash
devtask workspace import --file platform.bundle.zip
devtask repo bind --workspace platform backend /path/to/backend
devtask repo bind --workspace platform web /path/to/web
```

Repo paths inside the bundle are only hints. Each developer owns their own local bindings.

## Main Flow

The intended flow is:

```text
spec -> plan -> repo-plan -> implement -> check/verify -> review -> pr
```

Notes:
- `spec` refines the ticket into a shared spec artifact
- `plan` builds the global multi-repo plan
- `repo-plan` builds per-repo implementation plans
- `check` and `verify` are deterministic
- `review` is agent-backed
- later commands are mostly guided, not hard-gated

## Storage Model

Shared and local workspace state live under:

```text
~/.devtask/workspaces/<workspaceId>/
```

Split into:
- `shared/` for workspace metadata, shared docs, approved spec, global plan, repo plans
- `local/` for local bindings, runtime state, results, reviews

Repo-local state is intentionally minimal:
- worktrees only

See [docs/architecture/storage-model.md](/Users/konstantinospaschalides/Workspace/kpaschal/projects/devtask-orchestration-v1/docs/architecture/storage-model.md) and [docs/architecture/workspace-team-onboarding.md](/Users/konstantinospaschalides/Workspace/kpaschal/projects/devtask-orchestration-v1/docs/architecture/workspace-team-onboarding.md).

## Documentation

- [CLI.md](/Users/konstantinospaschalides/Workspace/kpaschal/projects/devtask-orchestration-v1/CLI.md)
- [docs/auth-and-environment.md](/Users/konstantinospaschalides/Workspace/kpaschal/projects/devtask-orchestration-v1/docs/auth-and-environment.md)
- [docs/architecture/storage-model.md](/Users/konstantinospaschalides/Workspace/kpaschal/projects/devtask-orchestration-v1/docs/architecture/storage-model.md)
- [docs/architecture/config-contract.md](/Users/konstantinospaschalides/Workspace/kpaschal/projects/devtask-orchestration-v1/docs/architecture/config-contract.md)
- [docs/architecture/artifact-contract.md](/Users/konstantinospaschalides/Workspace/kpaschal/projects/devtask-orchestration-v1/docs/architecture/artifact-contract.md)
- [docs/architecture/workspace-team-onboarding.md](/Users/konstantinospaschalides/Workspace/kpaschal/projects/devtask-orchestration-v1/docs/architecture/workspace-team-onboarding.md)
