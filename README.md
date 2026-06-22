# devtask

`devtask` is a local tool for managing AI-assisted work across multiple repos and workspaces.

Built for setups with multiple repos per product, vague tickets that need refinement before coding, and one or more developers working locally with Codex or Cursor Agent.

## Requirements

- Node.js 20.19+ (current LTS or newer)
- Git with worktree support
- Codex CLI or Cursor Agent CLI installed and authenticated
- Provider auth for PR/CI operations: `gh` (GitHub), `glab` (GitLab), or `BITBUCKET_EMAIL` + `BITBUCKET_API_TOKEN`
- Jira auth if importing work from Jira

See [docs/auth-and-environment.md](docs/auth-and-environment.md).

## Install

```bash
npm install
npm run build
npm link
devtask --help
```

## Run API
```bash
node dist/cli.js serve --port 43210
```

## Quick Start

```bash
# Create a workspace and register repos
devtask workspace create --id platform --name Platform
devtask repo add backend ./backend --kind service
devtask repo add web ./web --kind frontend

# Import or create a work item
devtask work import jira APP-123
# or: devtask work create --title "My task"

# Run it
devtask work orchestrate APP-123
```

## Main Flow

The primary flow is a single orchestrated mission:

```bash
devtask work orchestrate <work-id>
```

The orchestrator runs as an agent session and drives the work item end-to-end:

1. Produces a spec, global plan, and per-repo implementation plans
2. **Gate 1** — pauses for human approval of the plan before any code is written
3. Materializes worktrees and spawns per-repo coding sessions
4. Runs validation against each repo's contract
5. **Gate 2** — pauses for human approval before opening pull requests
6. Opens pull requests for all affected repos

Approve a gate:

```bash
devtask work approve <work-id> --gate gate-1
devtask work approve <work-id> --gate gate-1 --message "Looks good, but keep the API surface minimal"
```

To auto-approve both gates without interruption:

```bash
devtask work orchestrate <work-id> --auto
```

## Observability

```bash
devtask work status <work-id>       # gate states, active session, validator result
devtask work inspect <work-id>      # artifacts, latest runs, live sessions
devtask work diagnose <work-id>     # what is blocking and why
devtask work runs <work-id> --latest
devtask board
devtask board serve --workspace platform
```

## Manual Escape Hatches

The orchestrator coordinates these commands internally. Run them directly when you need to intervene:

```bash
devtask work spec <work-id>                     # refine ticket into spec artifact
devtask work plan <work-id>                     # build global multi-repo plan
devtask work repo-plan <work-id>                # build per-repo implementation plans
devtask work materialize <work-id>              # create task records and worktrees
devtask work execute <work-id> [--repo <id>]    # launch or resume coding sessions
devtask work check <work-id>                    # deterministic checks
devtask work verify <work-id>                   # verify against validation contract
devtask work review <work-id> [--repo <id>]     # agent-backed review
devtask work pr <work-id> --ready               # open pull requests
devtask work pr-watch <work-id>                 # route /devtask PR comments into session
devtask work ci-watch <work-id>                 # watch CI, inject failures, push fixes
devtask work compound <work-id>                 # write a human-readable learning report
```

Attach to or send feedback into a running session:

```bash
devtask work orchestrate attach <work-id>
devtask work orchestrate feedback <work-id> "Your message"
devtask work execute attach <work-id> <repo-id>
devtask work review attach <work-id> <repo-id>
```

## Storage Model

```text
~/.devtask/workspaces/<workspaceId>/shared/   # specs, plans, shared docs
~/.devtask/workspaces/<workspaceId>/local/    # bindings, runtime state, results
```

See [docs/architecture/storage-model.md](docs/architecture/storage-model.md).

## Team Onboarding

```bash
# Export workspace bundle
devtask workspace export --workspace platform --out platform.bundle.zip

# Import on another machine and bind local paths
devtask workspace import --file platform.bundle.zip
devtask repo bind --workspace platform backend /path/to/backend
```

Repo paths inside the bundle are hints only — local bindings are per machine.

## Documentation

- [CLI.md](CLI.md)
