# @devtask/mission

Standalone mission coordination package. Owns Spec and Mission workflows.

No runtime dependencies beyond `zod` and built-in `node:sqlite`. No imports from agent-kernel, devtask, Git, filesystem, tmux, or UI.

## Public API

- `createMissionController(store, agents)` — mission lifecycle controller
- `createSpecWorkflow(planner)` — spec draft/revise/approve/implement workflow
- `InMemoryMissionStore` — in-memory store for testing
- `SqliteMissionStore` — SQLite-backed store for production
- `validateMissionDefinition(definition)` — validate a mission definition
