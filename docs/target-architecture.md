# Target Architecture

Local-first workflow controller for turning external work into reviewed pull requests.

The target flow is:

```text
tracker item -> work item -> target graph -> approved worktrees -> agents -> checks/review -> commits -> pull requests -> CI follow-up
```

Examples of tracker and source control providers include Jira, Linear, GitHub Issues, Bitbucket, GitHub, and GitLab. The architecture should stay provider-neutral.

## Core Objects

### Workspace

A workspace is the local control root for related repositories or repo scopes.

It owns:

- workspace configuration
- target inventory
- work items
- source artifacts
- orchestration artifacts

It does not own implementation changes. Code changes live in repo-local worktrees.

### Target

A target is a stable address for work assignment.

```text
target = repo + optional scope
```

Examples:

```text
backend        -> ./backend
web            -> ./web
api            -> . + packages/api
docs           -> . + docs
```

Targets unify single-repo, monorepo, and polyrepo work. The planner should choose targets, not hard-code repo assumptions.

### Work Item

A work item is the durable root object for external or manual work.

It owns:

- source type
- source artifact
- current work status
- work-level plan
- proposed execution graph
- materialized task references

The work item decides neither implementation details nor final PR content by itself. It coordinates the flow.

### Execution Graph

The graph is the approved plan for turning a work item into repo/scope tasks.

It defines:

- proposed tasks
- target for each task
- local goal for each task
- ownership boundaries
- dependencies
- validation expectations
- open questions

The graph is proposed by the work planner and approved by a human before repo-local tasks are created.

### Repo Task

A repo task is the existing repo-local execution unit.

It owns:

- task metadata
- branch
- isolated worktree
- repo-specific plan
- agent run state
- checks/review/commit/PR lifecycle

Repo tasks are created from approved graph nodes.

## Stage Flow

### 1. Create Work

```bash
devtask work create <id> --from-tracker
devtask work create <id> --title "..."
```

Stores the source and creates the durable work item. No repo tasks are created.

### 2. Work Plan

```bash
devtask work plan <id>
```

The work planner reads:

- source artifact
- workspace target inventory
- target repos/scopes

It writes:

- `plan.md`
- `graph.json`

The work planner owns **what**, **where**, **boundaries**, and **dependencies**. It does not own exact implementation.

### 3. Approve Plan

```bash
devtask work approve-plan <id>
```

This is the human gate before materialization.

It should:

- validate graph schema
- validate target ids
- validate task ids
- validate dependency references
- create repo-local task metadata
- create branches and worktrees
- record materialized tasks under the work item

It should not run agents.

### 4. Repo Plan

Each materialized repo task gets a repo-specific plan.

The repo planner reads:

- original source
- work-level plan
- graph node
- target repo/scope
- dependency context

The repo planner owns **how** inside its repo/scope:

- exact files
- local conventions
- test strategy
- implementation risks

### 5. Run

```bash
devtask work run <id>
```

Runs repo-local agents in parallel when dependencies allow.

Each agent works inside its own worktree. A task may use a simple single-agent runtime or a richer team/swarm runtime, but `devtask` remains the lifecycle owner.

### 6. Check And Review

```bash
devtask work check <id>
devtask work review <id>
```

Runs configured validation and review across materialized tasks. Dependency failures should block dependent tasks from advancing.

### 7. Human Approval

```bash
devtask work approve <id>
```

Human approval accepts the local diffs and review/check state before publishing.

This is separate from `approve-plan`.

### 8. Commit And Pull Request

```bash
devtask work commit <id>
devtask work pr <id>
```

Publishes existing commits from each repo task branch and creates provider pull requests or merge requests.

PR creation must remain strict:

- no dirty worktree
- no silent commits
- no publishing without approval
- no provider-specific assumptions in core workflow code

### 9. CI Follow-Up

```bash
devtask work ci <id>
devtask work ci-watch <id>
```

CI monitoring should:

- poll provider status
- summarize failures
- route failures back to the owning repo task
- rerun fix loops with limits
- stop at human gates when judgment is needed

## Responsibility Boundaries

```text
work orchestrator:
  owns source understanding, target selection, task graph, ownership, dependencies

repo planner:
  owns repo-specific implementation plan

repo agent:
  owns code changes inside one worktree

devtask:
  owns durable state, lifecycle, worktrees, gates, provider handoffs

human:
  owns plan approval, diff approval, merge judgment
```

## Current Implementation

Implemented:

- workspace targets
- work item creation
- tracker-backed work source artifacts for one provider
- work-level planning
- proposed `graph.json`
- repo-local task lifecycle
- group coordination lifecycle
- checks, review, approval, commit, PR, and CI primitives

Not yet implemented:

- `work approve-plan`
- materializing graph nodes into repo-local tasks
- work-level run/check/review/commit/PR fan-out
- dependency-aware execution
- CI watch/fix loop
- provider-neutral tracker abstraction beyond the current first provider

## Design Principles

- Keep source control, tracker, agent, and runtime providers replaceable.
- Keep work item orchestration separate from repo-local implementation.
- Prefer explicit graph contracts over natural-language handoffs.
- Create worktrees only after human approval of the proposed graph.
- Preserve local inspectability: every prompt, plan, graph, log, worktree, commit, and PR should be traceable.
- Do not optimize for autonomous magic at the cost of developer control.
