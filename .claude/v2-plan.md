# devtask v2 — Implementation Plan

## Goal

Convert devtask-orchestration from a single-package CLI into a monorepo.
Foundation = Converge infrastructure packages (copied verbatim, renamed).
Core = new `packages/core` built from the v2 brainstorming doc.
Workflow logic = ported from devtask v1 src/.

## Package map

### Copy from Converge (rename only)
| Converge | v2 |
|---|---|
| packages/server | packages/server-api |
| packages/runner-claude-code | packages/agent-claude-code |
| packages/runner-codex | packages/agent-codex |
| packages/tracker-linear | packages/source-linear |
| packages/runtime-docker | packages/runtime-docker |
| packages/scm-github | packages/publish-github |

### Copy from Converge (keep name)
- packages/cli (starting point, CLI shell + daemon client pattern)

### Build new
- packages/core (delete Converge core, build from scratch)
- packages/runtime-tmux (from devtask v1 src/tmux.ts)
- packages/source-jira (from devtask v1 jira integration)
- packages/publish-bitbucket (from devtask v1)
- packages/storage-local (SQLite from Converge SqliteEventStore)
- packages/daemon (Converge daemon pattern + devtask follow loop)
- packages/agent-codex (Converge runner-codex + devtask agent.ts)

## New packages/core structure

```
packages/core/src/
  domain/
    work.ts               — Work, WorkStatus
    source-artifact.ts    — SourceArtifact
    execution-graph.ts    — ExecutionGraph, RepoTask
    stage-attempt.ts      — StageAttempt, StageStatus
    run-attempt.ts        — RunAttempt, RunStatus, SessionHandle
    artifact.ts           — Artifact, ArtifactRef
    review-ref.ts         — ReviewRef
    ci-status.ts          — CiStatus
    index.ts

  engine/
    workflow-engine.ts    — top-level orchestration loop
    stage-machine.ts      — stage transitions (plan→run→check→fix→review→pr)
    scheduler.ts          — dependency-aware task scheduling
    gates.ts              — human gate pause/resume
    retry-policy.ts       — fix loop, max retries, backoff
    recovery.ts           — detect dead attempts, restart
    idempotency.ts        — dedup on restart
    index.ts

  ports/
    source-provider.ts    — fetch work from external tracker
    agent-runner.ts       — start/stop/query agent session
    runtime-backend.ts    — spawn processes (tmux, docker, local)
    publish-provider.ts   — open PR / push branch
    ci-provider.ts        — query CI status
    context-provider.ts   — build context artifacts
    store.ts              — work/attempt/artifact storage
    index.ts

  storage/
    work-store.ts         — interface
    artifact-store.ts     — interface
    attempt-store.ts      — interface
    ledger-store.ts       — interface

  policy/
    approval-policy.ts
    publish-policy.ts
    ci-policy.ts
    defaults.ts

  events/
    domain-events.ts
    event-store.ts        — interface (Converge SqliteEventStore impl goes in storage-local)

  errors/
    index.ts

  index.ts
```

## Execution order

1. [x] Create v2 branch
2. [ ] Set up monorepo root (package.json workspaces, tsconfig base)
3. [ ] Copy Converge packages (rename as per map above)
4. [ ] Delete Converge's packages/core, replace with new scaffold
5. [ ] Implement packages/core domain types (Work, StageAttempt, RunAttempt, etc.)
6. [ ] Implement packages/core ports (interfaces only)
7. [ ] Implement packages/core engine (stage-machine first, then scheduler, gates, retry, recovery)
8. [ ] Port devtask v1 runtime logic → packages/runtime-tmux
9. [ ] Wire packages/daemon (Converge daemon + devtask follow loop)
10. [ ] Wire packages/cli (thin client to daemon)
11. [ ] Validate end-to-end with a single task
