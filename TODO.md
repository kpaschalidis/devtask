# Devtask Implementation TODO

## Slice 1: Foundation

- [x] Create TypeScript CLI project structure.
- [x] Detect repository root explicitly instead of relying on caller cwd.
- [x] Define task metadata schema and durable filesystem layout.
- [x] Implement `init`, `create`, `list`, and `status`.
- [x] Create one git worktree per task during `create`.
- [x] Add focused tests for root detection and task creation.
- [ ] Run validation and commit the foundation.

## Slice 2: Worker Lifecycle

- [x] Add atomic lock acquisition with stale lock recovery.
- [x] Add supervisor loop with structured run records.
- [x] Track supervisor and child process identifiers.
- [x] Implement `start`, `pause`, `resume`, and `cancel`.
- [x] Add tests for lifecycle transitions and lock behavior.

## Slice 3: Developer Control Surface

- [x] Implement `logs`, `review`, and `doctor`.
- [x] Add readable command output and actionable failure messages.
- [x] Document local workflows in README.
