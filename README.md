# devtask

`devtask` is a local CLI for turning one ticket or task into isolated, persistent agent work that can span one repository or many repositories.

The public workflow is `work` first:

- ingest or create a work item
- plan affected targets
- approve the execution graph
- materialize repo-local tasks
- run agents in isolated worktrees
- check, review, approve, commit, publish PRs, and inspect CI

Repo-local task commands still exist under `devtask task ...`, but they are advanced primitives. Most day-to-day usage should go through `devtask work ...`.

## Requirements

- Git with worktree support
- Node.js 22.x and npm from the same Node installation
- Codex CLI installed and authenticated
- tmux recommended for attachable agent sessions
- provider auth for publishing:
  - GitHub: `gh`
  - Bitbucket Cloud: `BITBUCKET_EMAIL` and `BITBUCKET_API_TOKEN`
  - GitLab: `glab`
- tracker auth when creating work from a tracker source

See [Auth And Environment](docs/auth-and-environment.md) for setup details.

## Install

```bash
npm install
npm run build
npm link
devtask --help
```

## Single-Repo Workflow

```bash
cd /path/to/repo

devtask init
devtask workspace target add app . --kind app

devtask work create fix-login \
  --title "Fix login redirect loop" \
  --body "Fix the redirect loop and add regression coverage."

devtask work plan fix-login
devtask work approve-plan fix-login
devtask work repo-plan fix-login
devtask work run fix-login --follow
devtask work check fix-login
devtask work review fix-login
devtask work approve fix-login
devtask work commit fix-login
devtask work pr fix-login --ready
devtask work ci fix-login
```

## Polyrepo Workflow

```bash
cd /path/to/product-workspace

devtask init --workspace
devtask workspace target add backend ./backend --kind backend
devtask workspace target add web ./web --kind frontend

devtask work create APP-123 --from-jira
devtask work plan APP-123
devtask work approve-plan APP-123
devtask work repo-plan APP-123
devtask work run APP-123 --follow
devtask work board APP-123
```

The work planner reads the source artifact and configured targets, then proposes a graph. Graph approval is explicit so the developer can catch wrong target selection before repo tasks are created.

## Useful Commands

```bash
devtask work show <work-id>
devtask work board <work-id>
devtask work logs <work-id> --target <target-id> --stage run
devtask work attach <work-id> --target <target-id>
devtask work steer <work-id> --target <target-id> "Please keep this scoped."
devtask work fix <work-id> --target <target-id> --from check
devtask work cleanup <work-id> --dry-run
```

Advanced repo-local primitives:

```bash
devtask task --help
devtask task status <task-id>
devtask task logs -f <task-id>
devtask task attach <task-id>
```

## Documentation

- [Getting Started](docs/getting-started.md)
- [Auth And Environment](docs/auth-and-environment.md)
- [Workspace And Work Contracts](docs/work-contracts.md)
- [Lifecycle Contracts](docs/lifecycle-contracts.md)
- [Task Commands](docs/task-commands.md)
- [Target Architecture](docs/target-architecture.md)

## Current Scope

`devtask` is intentionally local-first. It does not host a service, merge PRs, or hide human approval gates. V1 leaves final PR review and merge to the developer or provider UI.
