# Context And Learning

`devtask` preserves two different kinds of information:

- context needed by agents working on the current work item
- knowledge deliberately maintained for future work

It also produces a historical learning report after work completes. These
concepts remain separate so generated output cannot silently affect later work.

## Current-Work Context

The orchestrator writes one context artifact for every affected repository:

```text
shared/work/<workId>/repo-plans/<repoId>.context.md
```

Context is written after the global graph and before repo planning starts. It
records relevant decisions, rejected alternatives, risks, codebase constraints,
assumptions, and escalation conditions.

The repo-plan worker reads this context when creating its implementation plan.
Materialization also appends it to the implementation task. Context belongs only
to that work item and is not reused as knowledge.

## Active Knowledge

Active knowledge is ordinary Markdown maintained by users:

```text
shared/improvement/<phase>.md
shared/improvement/repos/<repoId>/<phase>.md
local/improvement/<phase>.md
local/improvement/repos/<repoId>/<phase>.md
```

Supported phases are:

- `planning`
- `implementation`
- `review`

Shared files contain workspace guidance. Local files contain machine- or
developer-specific guidance. Repo-specific files supplement global files.

Knowledge is injected by phase:

```text
orchestrator       <- global planning knowledge
repo-plan worker   <- global and repo planning knowledge
execution worker   <- global and repo implementation knowledge
validator/reviewer <- global and repo review knowledge
```

Missing or empty files are ignored. Loaded sections include their source path
so the guidance remains inspectable.

## Learning Report

After a work item, this command:

```bash
devtask work compound <work-id>
```

writes exactly one shared artifact:

```text
shared/work/<workId>/learnings.md
```

The report summarizes reusable planning observations, implementation
observations, review findings, successful patterns, and supporting evidence.
It may use the source, plans, repo context, execution results, validation
results, and reviews.

The report is historical output. It is not a proposal, candidate, approval
record, or active knowledge file. `compound` never modifies active knowledge.

Users may inspect the report and manually edit active knowledge files when a
lesson is genuinely worth preserving.

## Activation Boundary

The central invariant is:

```text
generated learning != active knowledge
```

Only the explicit `improvement/<phase>.md` and
`improvement/repos/<repoId>/<phase>.md` files are loaded as knowledge.

The following are never loaded as active knowledge:

- work-item context
- learning reports
- execution or validation results
- review artifacts
- old proposals or proposal archives
- historical improvement archives
- agent transcripts

Existing historical files remain on disk but are inert.

## Design Rules

- Keep knowledge explicit, file-based, and easy to inspect.
- Do not add approval states, promotion commands, schemas, or retrieval
  heuristics without a demonstrated need.
- Prefer fixing recurring problems in `devtask`, repository tooling, or
  configuration instead of accumulating compensating instructions.
- Keep deterministic `check` and `verify` behavior independent from narrative
  knowledge.
- Do not treat generated output as trusted guidance for future work.

Cross-session aggregation may later produce better learning reports, but it
must preserve the same activation boundary: generated analysis remains
inactive until a user manually changes an active knowledge file.
