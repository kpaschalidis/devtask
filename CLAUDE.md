# CLAUDE.md

This file gives Claude-oriented guidance for working in this repository.

## What This Repo Is

`devtask` is a local-first tool for coordinating AI-assisted development across multiple repos and work items.

The active model is:
- workspace-first
- work-first
- shared specs and plans
- repo-local worktrees
- local runtime state

The tool wraps coding agents. It should not become the agent itself.

## Current Flow

Use this as the mental model:

```text
work spec
work plan
work repo-plan
work implement
work check / work verify
work review
work pr
```

Clarifications:
- `spec` is a distinct capability
- `plan` is the global multi-repo plan
- `repo-plan` is per-repo implementation planning
- `check` and `verify` are deterministic
- `review` is agent-backed

## Current Storage Model

Shared workspace state:

```text
~/.devtask/workspaces/<workspaceId>/shared
```

Local machine state:

```text
~/.devtask/workspaces/<workspaceId>/local
```

Repo-local:

```text
<repo-root>/.devtask/worktrees
```

Minimal workspace marker:

```text
<workspace-root>/.devtask/workspace.json
```

Do not write new features against the older “workspace-root `.devtask` as main storage” assumption.

## Code Organization

Important directories:
- `src/cli/`
- `src/services/`
- `src/board/`
- `src/adapters/`
- `src/storage/`
- `src/infra/`

Important root modules:
- `src/agent.ts`
- `src/global-plan.ts`
- `src/repo-plan.ts`
- `src/work-materializer.ts`
- `src/work-cleanup.ts`

Prompt definitions live under:
- `src/prompts/`

Do not scatter prompt builders back into unrelated service files.

## Agent Boundaries

Keep this separation:
- services know the neutral agent interface
- adapters know provider specifics

Codex-specific command building belongs under:
- `src/adapters/codex/`

Do not leak provider-specific execution details into generic application code.

## Documentation Structure

Keep the docs split like this:
- `README.md`
  - short overview and quick start
- `CLI.md`
  - command reference
- `docs/architecture/`
  - deeper design notes

Remove or rewrite docs if they drift from the code.

## Implementation Style

Favor:
- explicit ownership
- small, understandable services
- stable artifacts
- minimal but durable abstractions

Avoid:
- over-engineering
- speculative abstractions
- hard-coded workflow gates
- domain-specific heuristics that do not scale

## Validation

For meaningful code changes, run:

```bash
npm run check
npm test
```

If not run, say why.
