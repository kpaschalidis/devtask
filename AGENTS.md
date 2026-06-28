# AGENTS.md

This repository builds `devtask` as a local-first tool for coordinating AI-assisted development across:
- multiple workspaces
- multiple repos
- multiple work items
- shared specs and plans
- repo-local worktrees and sessions

## Product Direction

Treat `devtask` as:
- a workspace-first control plane
- a work-first orchestration tool
- a wrapper around coding agents, not a replacement for them

Do not treat it as:
- a workflow engine
- a hard-gated lifecycle manager
- a generic BPM system

The intended flow is:

```text
spec -> plan -> repo-plan -> implement -> check/verify -> review -> pr
```

Important:
- `spec`, `plan`, `repo-plan`, and `review` are agent-driven capabilities
- `check` and `verify` are deterministic
- later steps should usually be guided, not hard-blocked
- the developer remains in control

## Storage And Ownership

Current storage model:
- shared workspace state:
  - `~/.devtask/workspaces/<workspaceId>/shared`
- local machine state:
  - `~/.devtask/workspaces/<workspaceId>/local`
- repo-local state:
  - worktrees only

Minimal workspace marker:
- `<workspace-root>/.devtask/workspace.json`

Shared artifacts include:
- workspace metadata
- config
- shared repo registry
- shared work artifacts
- shared spec
- shared global plan
- shared repo plans

Local artifacts include:
- local repo bindings
- materialization
- task runtime metadata
- sessions
- results
- reviews

Do not reintroduce a model where the workspace root `.devtask/` becomes the main source of truth.

## Architecture Expectations

Respect the current boundaries:
- `apps/cli/`
  - command surface only
- `src/services/`
  - orchestration and use-case logic
- `src/board/`
  - read models and board derivation
- `src/adapters/`
  - external integrations and agent/provider boundaries
- `src/storage/`
  - durable local state
- `src/infra/`
  - infrastructure utilities

Agent-facing code should depend on the neutral contract in:
- `src/agent.ts`

Application code should not know Codex-specific command details.

## Implementation Rules

When implementing:
1. Think
2. Plan
3. Implement
4. Review the change critically
5. Rework if needed
6. Only stop when the result is production-ready and not over-engineered

Avoid:
- quick heuristics that do not scale
- product-specific hacks
- domain-specific shortcuts that break the general model
- reintroducing hard workflow gates unless there is a real technical dependency

Prefer:
- explicit data ownership
- small, composable services
- stable artifact contracts
- read-model-driven UX
- boring, debuggable code

## Docs Expectations

Keep documentation consistent with the implemented model.

Primary docs:
- `README.md`
- `CLI.md`

Architecture docs:
- `docs/architecture/`

If behavior changes, update the relevant docs in the same pass.

## Testing Expectations

Before closing a meaningful change:
- run `npm run check`
- run `npm test`

If a change is docs-only, say so explicitly.

## Git Expectations

- work on a real branch, not detached HEAD
- do not assume `origin` is the only remote
- be careful with worktrees: one local branch cannot be checked out in two worktrees at once

## Non-Goals

Do not drift the project toward:
- complex workflow approval systems
- cloud sync implementation unless explicitly requested
- generalized agent framework work beyond what `devtask` needs
- repo-local state sprawl
