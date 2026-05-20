# devtask

`devtask` is a local control plane for managing multiple AI-assisted work items across multiple repositories.

It is workspace-first and work-first:

- register repos once per workspace
- create or import work
- build a work spec across affected repos
- materialize repo-local worktrees and sessions
- run check, review, verify, PR, and CI capabilities independently
- inspect everything from one board

`devtask` wraps repo-local agent work. It does not try to replace the agent.

## Requirements

- Git with worktree support
- Node.js 22.x and npm from the same installation
- Codex CLI installed and authenticated
- tmux recommended for attachable sessions
- provider auth for PR/CI operations:
  - GitHub: `gh`
  - Bitbucket Cloud: `BITBUCKET_EMAIL` and `BITBUCKET_API_TOKEN`
  - GitLab: `glab`
- Jira auth if you import work from Jira

See [Auth And Environment](docs/auth-and-environment.md).

## Install

```bash
npm install
npm run build
npm link
devtask --help
```

## Quick Start

Single repo:

```bash
cd /path/to/repo
devtask init

devtask work create fix-login \
  --title "Fix login redirect loop" \
  --body "Fix the redirect loop and add regression coverage."

devtask work spec fix-login
devtask work board fix-login
```

Multi repo:

```bash
cd /path/to/product-workspace
devtask init
devtask repo add backend ./backend --kind backend
devtask repo add web ./web --kind frontend

devtask work import jira APP-123
devtask work spec APP-123
devtask work board APP-123
```

Typical work flow:

```bash
devtask work spec APP-123
devtask work implement APP-123
devtask work check APP-123
devtask work review APP-123
devtask work verify APP-123
devtask work pr APP-123 --ready
devtask work ci APP-123
```

These are capabilities, not hard gates. `devtask` records results and suggests next actions, but the developer stays in control.

## Main Commands

```bash
devtask workspace list
devtask repo list
devtask work list
devtask board
devtask board work <work-id>
devtask session list <work-id>
devtask worktree list <work-id>
```

Per-work capabilities:

```bash
devtask work plan <work-id>
devtask work spec <work-id>
devtask work implement <work-id>
devtask work check <work-id>
devtask work review <work-id>
devtask work verify <work-id>
devtask work pr <work-id> --ready
devtask work ci <work-id>
devtask work cleanup <work-id> --dry-run
```

## Documentation

- [Getting Started](docs/getting-started.md)
- [Auth And Environment](docs/auth-and-environment.md)
- [Storage Model](docs/storage-model.md)
- [Config Contract](docs/config-contract.md)
- [Artifact Contract](docs/artifact-contract.md)
- [CLI Redesign](docs/cli-redesign.md)
- [Control Plane Phases](docs/control-plane-phases.md)

## Scope

`devtask` is intentionally local-first. It manages workspaces, repos, work items, worktrees, sessions, and durable artifacts. Final merge judgment stays with the developer and the provider UI.
