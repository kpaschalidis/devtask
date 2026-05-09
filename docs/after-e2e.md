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

## Long-Term Shape

The long-term model is:

```text
work item = durable orchestration root
target graph = approved decomposition
repo task = execution unit
work board = developer cockpit
stage ledger = recovery and audit trail
provider adapters = external integration boundary
```

The end state is not “more commands”. The end state is fewer decisions for the developer, with explicit human gates and recoverable automation.
