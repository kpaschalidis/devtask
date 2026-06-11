# devtask

`devtask` is a local tool for managing AI-assisted work across multiple projects, workspaces, repos, and tickets.

It is built for setups with:
- multiple repos per product
- vague Jira tickets that need refinement before coding
- one or more developers working locally with Codex
- deterministic checks plus agent-assisted planning and review

`devtask` is not a workflow engine. It is a local control plane around:
- workspaces
- repo bindings
- work items
- shared specs and plans
- global worktrees
- agent sessions

## Requirements

- Node.js 22.x
- Git with worktree support
- Codex CLI or Cursor Agent CLI installed and authenticated
- provider auth for PR/CI operations:
  - GitHub: `gh`
  - Bitbucket Cloud: `BITBUCKET_EMAIL` and `BITBUCKET_API_TOKEN`
  - GitLab: `glab`
- Jira auth if you import work from Jira

See [docs/auth-and-environment.md](docs/auth-and-environment.md).

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

If you want Cursor Agent instead of the default Codex runner:

```bash
devtask config agent cursor
```

To smoke-test the configured agent integration:

```bash
devtask agent test
devtask agent test "Reply with the current agent provider only."
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

`work repo-plan` is triggered manually and covers every affected repo in the work item. Today it runs one repo plan after another under a single command.

Then execute and validate:

```bash
devtask work materialize APP-123
devtask work execute APP-123
devtask work check APP-123
devtask work verify APP-123
devtask work review APP-123
devtask work pr APP-123 --ready
devtask work compound APP-123
```

`work materialize <work-id>` creates repo tasks and global workspace worktrees. `work execute <work-id>` launches or resumes the attachable coding sessions for those materialized tasks.

Use the board to keep track of active work:

```bash
devtask board
devtask board serve --workspace platform
devtask board html --workspace platform
devtask board work APP-123
devtask work diagnose APP-123
devtask work inspect APP-123
devtask work runs APP-123 --latest
devtask work runs show APP-123 execute backend
devtask session list APP-123
```

Current observability UX is terminal output plus optional web views. `board serve` starts a local read-only board app that rereads current state on refresh, and `board html` still generates a static snapshot when you want a file artifact.

## Team Onboarding

Workspaces are local-first and exportable.

Create and export a workspace bundle:

```bash
devtask workspace create --id platform --name Platform
devtask workspace export --workspace platform --out platform.bundle.zip
```

Import it on another machine and bind local repos:

```bash
devtask workspace import --file platform.bundle.zip
devtask repo bind --workspace platform backend /path/to/backend
devtask repo bind --workspace platform web /path/to/web
```

Repo paths inside the bundle are only hints. Local bindings are per machine.

## Main Flow

The intended flow is:

```text
spec -> plan -> repo-plan -> materialize -> execute -> check/verify -> review -> pr -> ci -> compound
```

Notes:
- `spec` refines the ticket into a shared spec artifact
- `plan` builds the global multi-repo plan
- `repo-plan` builds per-repo implementation plans for all affected repos
- `materialize` creates repo-local task records and global workspace worktrees from the approved graph
- `execute` launches or resumes the repo-task coding sessions
- `check` and `verify` are deterministic
- `review` is agent-backed
- `compound` captures reusable lessons into file-backed workspace/local memory artifacts
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
- no required devtask runtime state for workspace flows

See [docs/architecture/storage-model.md](docs/architecture/storage-model.md) and [docs/architecture/workspace-team-onboarding.md](docs/architecture/workspace-team-onboarding.md).

## Documentation

- [CLI.md](CLI.md)
- [docs/auth-and-environment.md](docs/auth-and-environment.md)
- [docs/architecture/storage-model.md](docs/architecture/storage-model.md)
- [docs/architecture/config-contract.md](docs/architecture/config-contract.md)
- [docs/architecture/artifact-contract.md](docs/architecture/artifact-contract.md)
- [docs/architecture/workspace-team-onboarding.md](docs/architecture/workspace-team-onboarding.md)
- [docs/architecture/self-improvement.md](docs/architecture/self-improvement.md)
