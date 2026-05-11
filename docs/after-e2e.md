# After The First End-To-End Architecture

This document describes what comes after the first complete work-item flow.

The first end-to-end architecture means:

```text
source -> work plan -> approve plan -> repo plan -> run -> check -> review -> approve -> commit -> PR -> CI
```

At that point `devtask` has a complete local path from external work to reviewable pull requests. The next phase is about reliability, ergonomics, and scaling the operating model.

## Command Model

`work` should become the primary developer workflow.

```bash
devtask work create ...
devtask work plan ...
devtask work approve-plan ...
devtask work repo-plan ...
devtask work run ...
devtask work check ...
devtask work review ...
devtask work approve ...
devtask work commit ...
devtask work pr ...
devtask work ci ...
```

Single task commands should remain as repo-local primitives:

- direct debugging
- manual recovery
- simple one-repo tasks
- implementation testing
- scripting internals

Group commands should become legacy-compatible convenience commands unless they keep a distinct use case. They are still useful for manually assembled multi-repo tasks, but the target direction is that work items replace most group usage because work items own source artifacts, planning, graph approval, and materialization.

Do not remove single task or group commands early. First make `work` clearly better, then decide whether group commands should be deprecated, hidden from the main docs, or kept as advanced commands.

## Reliability Layer

After E2E, the most important work is recovery.

Priorities:

1. **Transactional materialization**
   - `approve-plan` should not leave ambiguous partial state.
   - If task creation fails halfway, devtask should either roll back or record a recovery artifact.

2. **Work-level stage ledger**
   - Repo tasks already have stage records.
   - Work items should also record stage attempts and aggregate outputs.
   - `work board` should rely on durable work-level state where useful, not only live recomputation.

3. **Idempotent multi-repo commands**
   - Re-running `work commit`, `work pr`, and `work ci` should be safe.
   - Existing successful per-repo results should be recognized and skipped.
   - Failed items should be clearly retryable.

## CI And Fix Loop

`work ci` should stay simpler than `ci-watch`.

`work ci`:

- reads materialized tasks
- checks PR CI status per repo task
- records/prints aggregate status
- does not poll indefinitely
- does not fix anything

`ci-watch` is a later reliability feature.

It needs explicit policy:

- polling interval
- timeout
- terminal states
- retry limit
- whether auto-fix is enabled
- when a fix needs human approval again
- how failures map back to repo tasks

The first version of `ci-watch` should observe and summarize. Auto-fix should come after observation is reliable.

## Developer Experience

After E2E works, improve the cockpit.

Priorities:

- `work board` should show current stage, blockers, PRs, CI, and next command.
- `work next <id>` should explain the next safe action.
- `work advance <id>` should run safe automatic steps and stop at human gates.
- Error messages should always include the exact recovery command.

The goal is that the developer can manage a multi-repo task mostly from:

```bash
devtask work board <id>
devtask work next <id>
devtask work advance <id>
```

## Repo-Specialist Planning

The first E2E flow may keep `work repo-plan` mechanical: it renders repo-local plans from the approved graph and work-level plan.

After the first E2E path is proven, `work repo-plan` should become a parallel repo-specialist planning stage:

- one planning agent per materialized repo task
- each agent inspects only its target repo/scope
- each agent receives the approved graph node, work-level plan, source artifact, ownership boundaries, and dependency context
- repo agents refine **how** to implement inside their repo, not **what/where** the work belongs
- repo agents must not silently add targets, change dependencies, or broaden ownership
- if the approved graph is wrong, repo agents should produce a blocker and suggested graph change

This keeps the work-level orchestrator responsible for target selection and dependency shape, while repo specialists improve local implementation quality before coding starts.

## Policy And Configuration

Hardcoded policy should become explicit configuration only after real usage proves the options.

Likely policy areas:

- dependency completion policy for `work run`
- required checks before approval
- required review behavior
- PR draft vs ready default
- CI watch timeout and retry limits
- provider-specific auth requirements

Avoid adding broad configuration before the workflow has stable defaults.

## Provider Neutrality

Keep provider-specific code behind small interfaces.

Expected providers:

- source: Jira, Linear, GitHub Issues, manual Markdown
- source control: GitHub, Bitbucket, GitLab
- CI: provider-native checks/pipelines

The work-item layer should talk in terms of source artifacts, PRs/MRs, and CI status. It should not encode provider-specific workflow rules directly.

## Context Artifacts

`devtask` should treat context as a durable input to the lifecycle, not as throwaway prompt text.

The near-term goal is not to build a proprietary semantic index. The near-term goal is an inspectable context artifact pipeline.

For each work item, `devtask` should be able to build and persist:

- source context: ticket text, links, assets, comments, and external references
- workspace context: configured targets, repo paths, scopes, and target kinds
- repo maps: package structure, key commands, important docs, and local conventions
- candidate files: likely relevant files per target with reasons
- dependency hints: APIs, shared packages, frontend/backend contracts, and cross-repo touchpoints
- instruction context: `AGENTS.md`, `CLAUDE.md`, README, local runbooks, and configured prompts
- stage context: work plan, approved graph, repo plans, check output, review findings, PR and CI state

The first useful shape is:

```text
.devtask/work/<id>/context/
  source.md
  workspace.md
  targets.json
  summary.md
  repo-map/<target>.md
  candidate-files/<target>.json
  instructions/<target>.md
```

Every agent-backed stage should consume the appropriate context slice:

- `work plan` consumes source, workspace, and target context
- `work repo-plan` consumes source, work plan, graph node, and repo-local context
- `work run` consumes the accepted repo plan and target-specific context
- `work review` consumes source, graph, repo plan, diff, checks, and dependency context
- future CI fix loops consume failing CI output plus the same accepted context

Avoid starting with a vector database, background index daemon, or opaque memory. Those may become useful later, but the first version should be deterministic, reviewable, and easy to debug.

Longer term, context providers can become pluggable:

- filesystem scanner
- git history reader
- source tracker adapter
- documentation/wiki connector
- MCP context provider
- optional semantic search/index provider

The key contract is that context is an artifact with provenance. The developer should be able to inspect what the agent knew and why a repo/file was considered relevant.

## Self-Improvement

`devtask` should learn from completed work, but only through explicit, reviewable artifacts.

Self-improvement should not mean silently changing prompts or policies. It should mean capturing useful lessons and proposing changes that a developer can accept.

Useful inputs:

- review findings
- check failures
- CI failures
- user steering messages
- manual corrections after agent output
- files changed after review
- PR comments
- repeated blockers across tasks

Possible outputs:

- proposed updates to repo instructions
- proposed updates to workspace target metadata
- better check commands
- recurring dependency or ownership hints
- reusable task templates
- review rules that caught real bugs
- context artifact improvements

The workflow should be explicit:

```bash
devtask improve suggest <work-id>
devtask improve apply <suggestion-id>
```

or, at work level:

```bash
devtask work improve <id>
```

The suggestion artifact should explain:

- what happened
- what pattern was observed
- what change is proposed
- which future stage would benefit
- what file/config would change

Guardrails:

- no silent mutation of prompts, instructions, or config
- no domain-specific heuristic unless it is stored as project-local, reviewable policy
- no global memory that cannot be inspected
- every accepted improvement should be diffable and reversible

The goal is compounding local workflow quality: each completed task can improve future planning, context selection, review quality, and recovery guidance without turning `devtask` into a black box.

## Long-Term Shape

The long-term model is:

```text
work item = durable orchestration root
target graph = approved decomposition
repo task = execution unit
context artifacts = inspectable knowledge input
work board = developer cockpit
stage ledger = recovery and audit trail
provider adapters = external integration boundary
self-improvement = reviewable workflow learning
```

The end state is not “more commands”. The end state is fewer decisions for the developer, with explicit human gates and recoverable automation.
