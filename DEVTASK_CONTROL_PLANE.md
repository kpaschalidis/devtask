# Devtask Control Plane Direction

## Product Thesis

`devtask` is a local developer control plane for managing multiple AI-assisted work items across multiple repositories and multiple workspaces.

It should feel like working with `codex`, `claude-code`, or `cursor`, but with first-class support for:

- multiple active tickets
- tickets spanning multiple repos
- repo-local worktrees and agent sessions
- centralized status, feedback, and steering

The product is not a workflow engine. It is a coordinated developer workbench.

## What It Is

`devtask` should help a developer:

- create or import work
- refine vague tickets into usable specs
- identify and split work across repos
- start planning across repos with one command
- start implementation across repos with one command
- steer repo-local agents independently
- manage many active works from one board
- keep context across interruptions

## What It Is Not

Non-goals:

- hard-gated workflow enforcement
- generalized BPM or orchestration engine
- enterprise approvals system
- project management replacement
- mandatory autonomous execution
- deleting history as part of cleanup

## Core Model

`workspace`
- A local product workspace.
- Contains repo registry, defaults, tracker config, and agent config.

`repo`
- A repository registered in a workspace.
- Carries local path and optional metadata.

`work`
- One ticket, task, or request.
- Parent container for source, spec, plan, repo scope, sessions, and artifacts.

`repo task`
- Repo-local slice of a work item.
- Owns worktree, branch, local status, agent session, and feedback thread.

`session`
- Live agent context for one repo task.

`board`
- Read model across all active works, repos, and sessions.

## Command Philosophy

Commands should be available when technically possible, not blocked by abstract workflow policy.

Prefer:

- recommendations
- warnings
- suggestions
- pending-input markers
- next-action hints

Avoid:

- "you may not do this because another phase was not approved"
- "the engine owns progression"

Examples:

- `verify` can run before or after review
- `pr` can run even if verify failed
- `review` can run repeatedly at any time
- `implement` can restart for one repo without restarting the whole work

The system should say:

- "verify has not run on `web-app`"
- "review found findings on `identity-api`"
- "`shared-contracts` is waiting for your answer"

It should not say:

- "action forbidden because phase order is invalid"

## State Model

Keep user-facing state simple.

Work state:

- `new`
- `refining`
- `planning`
- `implementing`
- `needs-input`
- `blocked`
- `ready-for-pr`
- `completed`
- `failed`

Repo task state:

- `pending`
- `planning`
- `ready`
- `implementing`
- `needs-input`
- `blocked`
- `reviewing`
- `verifying`
- `ready-for-pr`
- `done`
- `failed`

Derived signals:

- `warnings`
- `findings`
- `open questions`
- `recommended next actions`

These signals matter more than rigid phase transitions.

## UX Center

The center of the product is the board, not the phase engine.

The board should answer:

- what work is active?
- which repos are involved?
- which sessions are running?
- which agents need input?
- what is blocked?
- what changed recently?
- what should I resume next?

It should work across:

- many works
- many repos
- many workspaces

## Execution Model

Planning and execution should fan out naturally.

One command can:

- start refine/spec work for one ticket
- start planning across affected repos
- start implementation across repo-local tasks

But the developer must retain local control:

- steer a single repo without disturbing others
- pause one work while another continues
- rerun review independently
- skip verify and still create a PR if they choose

## Cleanup Philosophy

Cleanup should remove ephemeral execution surfaces:

- worktrees
- dead sessions
- temporary runtime files

Cleanup should preserve durable work history:

- imported source
- spec
- plan
- repo split
- messages
- findings
- PR links
- decision trail

## Architecture Implications

Refactoring direction:

Keep:

- workspace/project service
- work as the primary unit
- repo-local child tasks
- session abstraction
- board/read models
- Jira/tracker import
- agent-assisted refine/plan/implement loops

Reduce or remove:

- hard workflow gating
- phase-coupled command restrictions
- engine-owned progression semantics
- approval-heavy lifecycle assumptions
- internal runtime concepts leaking into UX

Reframe:

- workflow engine -> coordination/runtime helper
- phases -> capabilities or activity types
- gates -> warnings and live prompts
- approvals -> optional operator actions, not mandatory blockers

## Design Principle

The product should optimize for this feeling:

"I am working on several tickets across several repos, with several agents helping me, and I can always see what is happening and intervene instantly."

If that feeling is strong, the architecture is correct.
