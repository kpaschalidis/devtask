# Self-Improvement Model

This document proposes how `devtask` can support self-improvement without turning into a workflow engine, a self-modifying agent shell, or an opaque memory pile.

The goal is simple:

```text
improve future agent-assisted work by learning from prior work
```

That means improving:
- what context gets loaded
- what reusable guidance gets applied
- what failure patterns get remembered
- what plans and prompts get replayed
- what regressions are caught before a learning is trusted

It does not mean:
- model fine-tuning inside `devtask`
- autonomous codebase mutation without review
- hard-gating the developer behind an adaptive workflow
- storing raw transcripts as the main learning system

## Why This Fits `devtask`

`devtask` is already a control plane around:
- shared specs and plans
- repo execution surfaces
- deterministic checks and verification
- agent-backed planning and review

That makes it a good place to improve the harness around agent work rather than the model itself.

The core idea is:

```text
run work -> capture outcome -> extract structured learnings -> replay on later work
```

This matches the existing product direction:
- shared artifacts stay explicit
- local operational state stays local
- deterministic checks remain the trust boundary
- the developer stays in control

## What Popular Projects Actually Do

Most open source agent projects do not perform true self-training. They usually improve one or more of these layers:

1. persistent repo guidance
2. memory and retrieval
3. benchmark and replay loops
4. lint, test, and verification feedback loops
5. failure analysis and regression control

Examples:
- OpenHands emphasizes repo guidance and reusable skills, then measures improvement with benchmarks.
- Aider improves iteration quality through strong context selection and deterministic lint and test loops.
- LangMem focuses on long-term memory extraction, consolidation, and retrieval.
- AutoGPT and `agbenchmark` emphasize stable contracts and benchmark-driven improvement.
- `auto-harness` is the clearest reference for a failure-driven loop that analyzes outcomes, proposes changes, and guards against regressions.

For `devtask`, the best fit is not "teach the model." The best fit is "improve the work harness."

## Improvement Layers

`devtask` should treat self-improvement as four separate layers.

### 1. Shared Guidance

Durable guidance that helps everyone in the workspace.

Examples:
- planning patterns that repeatedly work
- repo-specific implementation constraints
- review checklists
- known integration pitfalls
- stable context snippets worth loading for certain repo kinds

This should be explicit and reviewable.

### 2. Local Runtime Learning

Per-developer or per-machine operational learning.

Examples:
- which checks usually fail first
- which local commands are reliable for verification
- recent failures from a work item
- local session notes that should not be promoted yet

This is useful immediately but should not become shared truth by default.

### 3. Task Replay And Evaluation

A learning only matters if it improves future outcomes.

`devtask` should be able to replay known work patterns and compare:
- success or failure
- check and verify results
- review findings
- task completion quality
- time or iteration count when relevant

### 4. Promotion

Not every observation becomes shared memory.

`devtask` should promote a learning from local to shared only when it has shown repeated value and survives deterministic validation.

## Proposed Artifact Model

The artifact model should follow the existing storage split.

### Shared

```text
~/.devtask/workspaces/<workspaceId>/shared/
└── improvement/
    ├── policies/
    │   ├── planning.md
    │   ├── implementation.md
    │   └── review.md
    ├── learnings/
    │   ├── <learningId>.json
    │   └── ...
    ├── patterns/
    │   ├── <patternId>.md
    │   └── ...
    └── evals/
        ├── suites.json
        └── baselines/
```

Purpose:
- store approved, shared learnings
- store reusable guidance and patterns
- define replay and evaluation suites

### Local

```text
~/.devtask/workspaces/<workspaceId>/local/
└── improvement/
    ├── observations/
    │   ├── <observationId>.json
    │   └── ...
    ├── proposals/
    │   ├── <proposalId>.json
    │   └── ...
    ├── eval-runs/
    │   ├── <runId>.json
    │   └── ...
    └── cache/
```

Purpose:
- store raw but structured observations
- track candidate learnings before promotion
- record replay and evaluation runs

This preserves the current ownership model:
- shared state holds durable team knowledge
- local state holds operational and provisional learning

## Core Data Shapes

Keep the schema small and boring.

### Observation

Captured from a real work run or review.

Example shape:

```json
{
  "schemaVersion": 1,
  "id": "obs_2026_05_25_001",
  "workspaceId": "platform",
  "scope": {
    "workId": "APP-123",
    "repoId": "backend",
    "taskId": "APP-123-backend"
  },
  "kind": "verification-failure",
  "summary": "Generated implementation omitted required migration step.",
  "evidence": {
    "resultArtifact": "local/work/APP-123/results/verify.json",
    "sourceArtifacts": [
      "shared/work/APP-123/spec.md",
      "shared/work/APP-123/repo-plans/backend.md"
    ]
  },
  "proposedAction": {
    "type": "planning-guidance",
    "target": "repo-plan",
    "change": "Require schema and data migration review when persistence layer changes."
  },
  "createdAt": "2026-05-25T10:00:00.000Z"
}
```

### Learning

A promoted, reusable lesson.

Example shape:

```json
{
  "schemaVersion": 1,
  "id": "learning_backend_migrations_checklist",
  "status": "active",
  "category": "implementation-guardrail",
  "appliesTo": {
    "repoIds": ["backend"],
    "repoKinds": ["service"]
  },
  "statement": "When data models change, inspect migration, rollback, and data backfill implications.",
  "sourceObservations": [
    "obs_2026_05_25_001",
    "obs_2026_05_28_004"
  ],
  "validation": {
    "evalSuiteIds": ["backend-change-replay"],
    "lastValidatedAt": "2026-05-28T11:30:00.000Z"
  },
  "createdAt": "2026-05-28T11:40:00.000Z",
  "updatedAt": "2026-05-28T11:40:00.000Z"
}
```

## Retrieval Model

Do not load all learnings all the time.

Retrieve by explicit scope:
- command stage: `spec`, `plan`, `repo-plan`, `implement`, `review`
- repo kind
- repo id
- work labels or source type
- prior failure category

Example:
- `repo-plan` for a backend repo should load backend planning and implementation learnings
- `review` should load review-specific checklists and similar historical failure patterns
- `verify` should not use heuristic narrative memory at all; it should stay deterministic

This keeps memory narrow and explainable.

## Minimal Improvement Loop

The first version should be intentionally small.

### Step 1. Observe

Capture structured observations from:
- failed `check`
- failed `verify`
- review findings
- repeated implementation retries
- explicit user corrections

### Step 2. Propose

Turn observations into a candidate improvement:
- add or refine guidance
- add a reusable checklist
- improve prompt context selection
- add a replay scenario

### Step 3. Replay

Run the candidate against a small set of known work examples.

Success criteria should be mostly deterministic:
- more checks passing
- more verifies passing
- fewer review findings
- no regression on previous passing cases

### Step 4. Promote

If the candidate shows repeated value, promote it to shared learning.

If it is useful only on one machine or one developer's setup, keep it local.

## What Should Improve

The improvement target should be the `devtask` harness, not hidden model behavior.

Good targets:
- stage-specific prompts
- reusable plan and review guidance
- context loading rules
- repo-kind checklists
- replay suites
- deterministic checks discovered from repeated failures

Bad targets:
- opaque accumulated prompt sludge
- raw transcript dumping
- auto-generated rules with no validation
- agent-only state that cannot be inspected later

## Command Surface Direction

This should start as a narrow capability set.

Possible future commands:

```text
devtask improve observe <work-id>
devtask improve list
devtask improve show <id>
devtask improve replay [--suite <suite-id>]
devtask improve promote <proposal-id>
```

Notes:
- `observe` collects structured observations from existing artifacts
- `replay` is deterministic where possible and agent-guided where necessary
- `promote` is explicit and reviewable

This stays aligned with `devtask` as a guided control plane.

## Read Model Direction

The board should eventually surface improvement state as a read model, not as hidden agent internals.

Useful views:
- recent repeated failure categories
- active candidate learnings
- promoted learnings by repo
- replay suite health
- learnings that have gone stale or unvalidated

That keeps the UX explainable and operationally useful.

## Guardrails

To keep this production-safe:

1. never let self-improvement bypass `check` or `verify`
2. never promote raw transcripts as shared truth
3. never make shared learning implicit or unreviewable
4. prefer artifact updates over prompt accretion
5. keep repo-local state minimal
6. preserve developer control over promotion and adoption

## Recommended First Slice

A small first implementation is enough to prove value.

### Phase 1

- add local observation artifacts
- derive observations from `verify`, `review`, and repeated failures
- add a simple `improve list` or internal service for inspection

### Phase 2

- add shared learning artifacts
- add explicit promotion from local observation clusters to shared learnings
- load shared learnings into `repo-plan`, `implement`, and `review`

### Phase 3

- add replay suites and baseline scoring
- validate new learnings before promotion
- expose improvement health on the board

## Recommended Design Decision

The best model for `devtask` is:

```text
self-improvement = structured learning + replay + explicit promotion
```

Not:

```text
self-improvement = autonomous hidden memory that keeps growing
```

That keeps the system:
- local-first
- auditable
- debuggable
- aligned with the current storage model
- useful across repos and work items

## Summary

If `devtask` adds self-improvement, it should improve the work harness around agents.

The practical design is:
- capture structured observations locally
- turn repeated observations into candidate learnings
- replay against known tasks
- promote only validated learnings into shared workspace state
- retrieve narrowly by stage and repo scope

That is the simplest model that is useful, scalable, and consistent with the current architecture.
