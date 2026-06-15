---
name: mission-redesign
description: Implement the devtask mission/role architecture redesign (Steps 1–7)
---

# Goal: Mission / Role Architecture Redesign

Implement the mission/role architecture redesign for devtask. The full plan is at `.claude/plans/yes-this-is-correct-async-karp.md`. Work in the project root.

## Phase 1: Validate Step 1 (instructions as .md files)

Step 1 is claimed complete. Verify before proceeding.

1. Confirm these files exist and are non-empty:
   - `src/instructions/loader.ts`
   - `src/instructions/orchestrator.md`, `repo-plan.md`, `validator.md`, `compound.md`

2. No stale imports remain:
   ```
   grep -r "prompts/orchestrator\|prompts/repo-plan\|prompts/review" src/
   ```
   Expected: no output.

3. `npm run check && npm test` — both must pass. Fix any failures before continuing.

If Step 1 is broken, fix it first. The .md files should contain the full instruction text extracted from the old TypeScript prompt builders, with `{{PLACEHOLDER}}` vars for dynamic values. `loader.ts` reads the file co-located with itself using `import.meta.url` and replaces `{{KEY}}` with values from a string map.

## Phase 2: Implement Steps 2–7

Work through each step in order. Run `npm run check && npm test` after each step. Fix failures before moving on — do not accumulate broken state across steps.

### Step 2: Mission gates

- Add `workItemGatesDir(paths, id)` path helper to `src/infra/paths.ts` → `workItemLocalDir(paths, id)/gates/`
- Create `src/mission/gates.ts`: `GateName = "gate-1" | "gate-2"`, `GateStatus = "pending" | "approved" | "rejected"`, `GateState` interface, `readGateState` and `writeGateState` functions
- Create `src/mission/approve.ts`: `approveWorkGate(paths, workId, message?)` — reads live orchestrator `PhaseRun`, calls `sendWorkPhaseFeedback` with the message, writes gate state
- Export `approveWorkGate` from `src/services/work-service.ts`
- Add `work approve <work-id> [--message <msg>]` to `src/cli/work.ts`
- Add `work stop <work-id>` to `src/cli/work.ts` — calls `killLiveSession(paths, workId, "orchestrate", null)`
- Update `src/instructions/orchestrator.md`: after Step 4 (repo-plan workers) add Gate 1 pause block; after execution+validation add Gate 2 pause block. Both tell the agent to wait for an approval message before proceeding.

### Step 3: Incremental validation

- Update graph.json schema in `src/instructions/orchestrator.md`: add `features[]` array. Each feature has `id`, `title`, `taskIds[]`, `validationRequired`. Each task gains a `featureId` field.
- Instruct the orchestrator (in the .md file) to: group tasks into features by logical boundary; after all tasks in a feature complete, spawn `devtask work _validate-worker --work-id ID --feature-id ID` before proceeding to the next feature.
- Add hidden `work _validate-worker --work-id <id> --feature-id <id>` command to `src/cli/work.ts`
- Add `runValidateWorker(paths, workId, featureId)` to `src/services/work-service.ts` — reads graph.json, finds the feature's tasks, launches the validator role for each task's worktree
- Update graph.json parsing in `src/work-materializer.ts` to tolerate `features` being absent (backward-compat)

### Step 4: Validator redesign

- Rewrite `src/instructions/validator.md`: agent reads `AGENTS.md` from the worktree to discover build/test/lint commands, runs them, reads `validation-contract.md`, checks each `VAL-XXX` assertion against command output, writes `result.json` as `{ schemaVersion: 1, status: "passed"|"failed", assertions: [{id, status, evidence}], commands: [{command, exitCode, output}] }`
- Update `src/phases/review.ts` `freshScope`: add `DEVTASK_VALIDATION_CONTRACT_PATH` env var (path from `workItemValidationContractPath`)
- Update `src/phases/review.ts` `finalize()`: read `status: "passed"|"failed"` from result JSON; keep backward compat by also accepting `"approved"` as passing

### Step 5: Simple mode

- In `src/cli/agent.ts` (create if absent), add top-level `agent [--context <path>]` command: reads config, calls `createDefaultAgentRunner`, launches interactively with no completion hooks; if `--context` given, load file as initial prompt
- Wire the agent command through `src/cli.ts` — check how other top-level commands are registered there and follow the same pattern

### Step 6: Skills directory

- In `src/services/workspace-service.ts`, find the workspace creation/init code path and add `fs.mkdirSync(path.join(root, ".agents", "skills"), { recursive: true })`

### Step 7: Rename phases → roles

- Create `src/roles/`: copy `types.ts`, `runner.ts`, `orchestrator.ts`, `execute.ts`; copy `review.ts` → `validator.ts`
- Rename in the new files: `PhaseConfig → RoleConfig`, `PhaseScope → RoleScope`, `PhaseFreshScope → RoleFreshScope`, `PhaseLaunchResult → RoleLaunchResult`, `PhaseResult → RoleResult`
- Create `src/infra/session-run.ts` from `phase-run.ts`: rename `PhaseRun → SessionRun`, `PhaseRunPhase → SessionPhase`, `PhaseRunRecord → SessionRunRecord`
- Create `src/services/session-run-service.ts` from `phase-run-service.ts`, update imports
- Update all callers (cli/work.ts, services/work-service.ts, services/work-inspection-service.ts, board/workspace-board.ts, repo-plan.ts, infra/paths.ts)
- Leave old `src/phases/` files as re-export shims (`export * from "../roles/types.js"` etc.) until all callers are updated, then delete them

## Constraints

- Do not add `Co-Authored-By` to commits
- Do not commit unless explicitly asked
- Do not update README.md, CLI.md, or docs/
- Do not change storage schemas (work.json, index.json, graph.json schema version)
- Keep `check` and `verify` CLI commands unchanged

## Done

`npm run check` zero errors, `npm test` all green.
