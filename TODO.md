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

- [ ] Add atomic lock acquisition with stale lock recovery.
- [ ] Add supervisor loop with structured run records.
- [ ] Track supervisor and child process identifiers.
- [ ] Implement `start`, `pause`, `resume`, and `cancel`.
- [ ] Add tests for lifecycle transitions and lock behavior.

## Slice 3: Developer Control Surface

- [ ] Implement `logs`, `review`, and `doctor`.
- [ ] Add readable command output and actionable failure messages.
- [ ] Document local workflows in README.
