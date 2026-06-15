# Plan: Planning-Only Workflow

**Generated**: 2026-05-22
**Estimated Complexity**: Medium

## Overview

Make planning-only tickets a first-class workflow in `devtask` rather than a partial use of the implementation pipeline. The target user experience is:

`create/import -> spec -> plan -> optional repo-plan -> planning done`

This should preserve the current execution-oriented flow for implementation tickets while making planning-only work explicit in CLI semantics, board status, and stored metadata.

## Assumptions

- Planning-only tickets still use agent-backed `spec`, `plan`, and optionally `repo-plan`.
- Planning-only tickets should not require worktree materialization or review artifacts unless explicitly transitioned into implementation.
- Existing artifacts such as `spec.md`, `plan.md`, and `repo-plans/*.md` remain valid and should not be duplicated into a second planning-specific artifact model.

## Sprint 1: Define The Workflow Contract
**Goal**: Introduce a clear planning-only concept in the domain model without breaking the current workflow.

**Demo/Validation**:
- Create one planning-only work item and one implementation work item.
- Confirm both can coexist in storage and on the board.
- Confirm no existing command breaks for old work items.

### Task 1.1: Add explicit work intent to metadata
- **Location**: `src/storage/work-store.ts`, `docs/architecture/artifact-contract.md`
- **Description**: Extend work item metadata with an explicit intent such as `planning` or `delivery`.
- **Dependencies**: None
- **Acceptance Criteria**:
  - New work items can persist an intent value.
  - Existing work items without intent continue to load with a safe default.
  - Artifact docs describe the field and migration behavior.
- **Validation**:
  - Add storage tests for create/read compatibility.

### Task 1.2: Define planning lifecycle states
- **Location**: `src/board/*`, `src/services/work-service.ts`, `docs/architecture/artifact-contract.md`
- **Description**: Add derived status semantics that represent planning progress cleanly, such as `draft`, `spec-ready`, `planned`, `repo-planned`, `planning-done`.
- **Dependencies**: Task 1.1
- **Acceptance Criteria**:
  - Board/read-model logic can distinguish planning progress from implementation progress.
  - Planning-only items never imply implementation work is pending unless explicitly transitioned.
- **Validation**:
  - Add board/read-model tests covering planning-only and delivery items.

### Task 1.3: Define transition rules
- **Location**: `docs/architecture/artifact-contract.md`, `CLI.md`, `README.md`
- **Description**: Document how a planning-only work item can remain complete after planning or later be promoted into delivery work.
- **Dependencies**: Task 1.2
- **Acceptance Criteria**:
  - There is one documented promotion path from planning-only to delivery.
  - The plan does not require duplicate artifacts or destructive state rewrites.
- **Validation**:
  - Review docs for a complete example flow.

## Sprint 2: Add A First-Class Planning CLI Path
**Goal**: Make planning-only usage obvious and short on the command line.

**Demo/Validation**:
- Run a planning-only workflow from CLI without touching worktrees.
- Confirm help output shows the shorter path clearly.

### Task 2.1: Add planning intent at work creation/import time
- **Location**: `src/cli/work.ts`, `src/services/work-service.ts`, `CLI.md`, `README.md`
- **Description**: Support creating/importing work with an explicit planning intent, for example `--intent planning`.
- **Dependencies**: Sprint 1
- **Acceptance Criteria**:
  - Users can mark work as planning-only at creation or import.
  - Default behavior for existing users remains unchanged.
- **Validation**:
  - CLI tests for create/import parsing and persisted metadata.

### Task 2.2: Add a single planning command
- **Location**: `src/cli/work.ts`, `src/services/work-service.ts`
- **Description**: Add a command such as `devtask work planning <work-id>` that orchestrates `spec -> plan` and optionally `repo-plan`.
- **Dependencies**: Task 2.1
- **Acceptance Criteria**:
  - The command can run the planning pipeline without materializing worktrees.
  - Failure output identifies which stage failed.
  - Optional repo planning is explicit rather than heuristic.
- **Validation**:
  - Service tests for successful and failing multi-stage planning runs.

### Task 2.3: Improve next-step guidance
- **Location**: `src/board/next-actions.ts`, `src/cli/work.ts`
- **Description**: Tailor next actions based on intent so planning-only items suggest plan review or promotion, not implementation.
- **Dependencies**: Task 2.2
- **Acceptance Criteria**:
  - Planning-only board rows never point to `implement` by default.
  - Delivery items keep the current behavior.
- **Validation**:
  - Board/CLI snapshot tests for both intents.

## Sprint 3: Make Planning Output Reviewable
**Goal**: Make the result of planning-only tickets easy to inspect, approve, and hand off.

**Demo/Validation**:
- A user can tell whether a planning-only item is ready for handoff from the board and work show output.

### Task 3.1: Add planning summary/read model
- **Location**: `src/services/board-service.ts`, `src/cli/work.ts`
- **Description**: Surface a concise planning summary that shows whether `spec`, `plan`, and `repo-plan` exist and are fresh.
- **Dependencies**: Sprint 2
- **Acceptance Criteria**:
  - `work show` and board views display planning completeness clearly.
  - Users do not need to inspect the filesystem to know if planning is done.
- **Validation**:
  - Read-model tests for artifact presence combinations.

### Task 3.2: Add explicit planning completion semantics
- **Location**: `src/cli/work.ts`, `src/services/work-service.ts`, `docs/architecture/artifact-contract.md`
- **Description**: Add a lightweight command or derived rule to mark a planning-only item complete once the planning artifacts are accepted.
- **Dependencies**: Task 3.1
- **Acceptance Criteria**:
  - Planning-only work can end cleanly without review, worktrees, or PR flow.
  - Completion does not block later promotion into delivery mode.
- **Validation**:
  - Tests for completion and later promotion behavior.

## Sprint 4: Preserve Delivery Workflow Compatibility
**Goal**: Ensure the new planning lane does not weaken the current implementation lane.

**Demo/Validation**:
- Existing delivery tickets still follow `spec -> plan -> repo-plan -> materialize -> execute -> verify/review -> pr`.

### Task 4.1: Backward compatibility pass
- **Location**: `src/storage/*`, `src/services/*`, `src/cli/*`
- **Description**: Audit old assumptions that every planned item leads to implementation and patch them behind explicit intent checks.
- **Dependencies**: Sprints 1-3
- **Acceptance Criteria**:
  - Old work items load correctly.
  - Existing delivery commands behave the same for default intent.
- **Validation**:
  - Regression test suite for current work lifecycle commands.

### Task 4.2: Documentation pass
- **Location**: `README.md`, `CLI.md`, `docs/architecture/artifact-contract.md`
- **Description**: Rewrite top-level docs around two supported modes: planning-only and delivery.
- **Dependencies**: Task 4.1
- **Acceptance Criteria**:
  - New users can understand the difference in under five minutes.
  - Examples show when to stop after planning and when to continue into implementation.
- **Validation**:
  - Manual doc review against actual CLI.

## Testing Strategy

- Unit tests for work metadata compatibility and defaults.
- Service tests for planning orchestration and promotion flow.
- Board/read-model tests for derived status and next-step behavior.
- CLI tests for new flags and commands.
- Regression coverage for the existing delivery pipeline.

## Potential Risks & Gotchas

- If intent is modeled only as a status, the workflow will become brittle and hard to evolve. Keep intent separate from execution progress.
- If planning-only introduces duplicate artifacts, the system will drift and users will lose trust. Reuse the current `spec.md`, `plan.md`, and `repo-plans/*.md`.
- If `repo-plan` stays mandatory for every planning-only ticket, simple planning cases will remain too heavy. Make it optional and explicit.
- If the board continues to derive “next” from delivery assumptions, the UX will still feel wrong even after adding intent.

## Rollback Plan

- Leave new metadata fields backward-compatible and optional.
- Gate new CLI commands and intent-aware behavior behind additive changes.
- If the planning lane causes confusion, keep the stored intent field but revert command and board behavior to the old default flow.
