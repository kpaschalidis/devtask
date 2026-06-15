---
name: mission-validate
description: Validate the devtask mission/role architecture redesign (Steps 1–7) was implemented correctly
---

# Goal: Validate Mission / Role Architecture Redesign

Verify that all 7 steps of the mission/role architecture redesign were implemented correctly in this repo. **Do not implement anything.** Only inspect, grep, and report. The full plan is at `.claude/plans/yes-this-is-correct-async-karp.md`.

Run each check below. After all checks, run `npm run check && npm test`. Report which checks passed, which failed, and any specific diff from what was expected.

---

## Step 1: Instructions as `.md` files

**Files must exist and be non-empty:**
```
src/instructions/loader.ts
src/instructions/orchestrator.md
src/instructions/repo-plan.md
src/instructions/validator.md
src/instructions/compound.md
```

**`loader.ts` must use `import.meta.url` to resolve co-located `.md` files and export `loadInstruction`:**
```
grep -n "import.meta.url\|fileURLToPath" src/instructions/loader.ts
grep -n "export.*loadInstruction" src/instructions/loader.ts
```

**No old prompt-builder imports remain in `src/`:**
```
grep -r "prompts/orchestrator\|prompts/repo-plan\|prompts/review" src/
```
Expected: no output.

**Callers use `loadInstruction` instead of old builders:**
```
grep -rn "loadInstruction" src/phases/ src/roles/ src/services/work-service.ts src/repo-plan.ts
```
Expected: at least one hit per caller (orchestrator, repo-plan, validator).

---

## Step 2: Mission gates

**Gate path helper in `src/infra/paths.ts`:**
```
grep -n "workItemGatesDir" src/infra/paths.ts
```
Expected: function that returns `workItemLocalDir(paths, id)/gates/`.

**`src/mission/gates.ts` must define the types and functions:**
```
grep -n "GateName\|GateStatus\|GateState\|readGateState\|writeGateState" src/mission/gates.ts
```
Expected: all five names present.

**`src/mission/approve.ts` must exist with `approveWorkGate`:**
```
grep -n "approveWorkGate" src/mission/approve.ts src/services/work-service.ts src/cli/work.ts
```
Expected: defined in `approve.ts`, re-exported from `work-service.ts`, used in `work.ts`.

**CLI commands present in `src/cli/work.ts`:**
```
grep -n "work approve\|work stop\|\.command.*approve\|\.command.*stop" src/cli/work.ts
```
Expected: both commands registered.

**Orchestrator instruction has Gate 1 and Gate 2 pause blocks:**
```
grep -n "Gate 1\|Gate 2\|Awaiting approval" src/instructions/orchestrator.md
```
Expected: at least two gate markers.

---

## Step 3: Incremental validation

**`src/work-materializer.ts` has `WorkGraphFeature` and backward-compat `features` parsing:**
```
grep -n "WorkGraphFeature\|featureId\|features" src/work-materializer.ts
```
Expected: `WorkGraphFeature` interface, `features` in `WorkGraph`, `featureId` in `WorkGraphTask`, and a fallback `Array.isArray(value.features) ? value.features : \[\]`.

**Orchestrator instruction references `features[]` and `_validate-worker`:**
```
grep -n "features\|_validate-worker\|featureId" src/instructions/orchestrator.md
```
Expected: `features` array schema, `_validate-worker` command line, `featureId` per task.

**`runValidateWorker` defined in `src/services/work-service.ts`:**
```
grep -n "runValidateWorker" src/services/work-service.ts src/cli/work.ts
```
Expected: defined in `work-service.ts`, invoked in `work.ts` `_validate-worker` command handler.

**Hidden `_validate-worker` command in `src/cli/work.ts`:**
```
grep -n "_validate-worker\|validate-worker" src/cli/work.ts
```
Expected: command registration and `--work-id`/`--feature-id` options.

---

## Step 4: Validator redesign

**`src/instructions/validator.md` is agent-driven (reads `AGENTS.md`, not hardcoded commands):**
```
grep -n "AGENTS.md\|validation-contract\|VAL-\|result.json\|passed.*failed\|schemaVersion" src/instructions/validator.md
```
Expected: all of these concepts present.

**Validator instruction uses template placeholders (not hardcoded paths):**
```
grep -n "{{WORK_ID}}\|{{REPO_ID}}\|{{CONTRACT_PATH}}\|{{RESULT_PATH}}\|{{WORKTREE_PATH}}" src/instructions/validator.md
```
Expected: all five placeholders present.

**`finalize()` in the review/validator role accepts `"passed"` as a success status:**
```
grep -n '"passed"\|passed.*failed\|approved.*passed' src/roles/validator.ts src/phases/review.ts 2>/dev/null | head -20
```
Expected: at least one hit showing `"passed"` is treated as success.

**`loadInstruction("validator", ...)` call with new placeholders:**
```
grep -n 'loadInstruction.*validator\|RESULT_PATH\|CONTRACT_PATH' src/roles/validator.ts src/phases/review.ts 2>/dev/null
```
Expected: `loadInstruction("validator", {...})` with at least `RESULT_PATH` and `CONTRACT_PATH` args.

---

## Step 5: Simple mode

**`src/cli/agent.ts` exists with `--context` option and direct agent launch:**
```
grep -n "\-\-context\|spawnSync\|buildAgentBootstrapCommand\|action" src/cli/agent.ts
```
Expected: `--context` option, `spawnSync` or equivalent direct-exec call, `.action(` handler.

**`devtask agent` is wired in `src/cli.ts`:**
```
grep -n "agent\|cli/agent" src/cli.ts
```
Expected: the agent module imported and registered as a top-level command.

---

## Step 6: Skills directory

**Workspace init creates `.agents/skills/`:**
```
grep -n "\.agents.*skills\|skills.*mkdir" src/services/workspace-service.ts
```
Expected: `fs.mkdirSync(path.join(root, ".agents", "skills"), { recursive: true })` or equivalent.

---

## Step 7: Rename phases → roles

**`src/roles/` files exist:**
```
ls src/roles/
```
Expected: `types.ts`, `runner.ts`, `orchestrator.ts`, `execute.ts`, `validator.ts`.

**New type names in `src/roles/types.ts`:**
```
grep -n "RoleConfig\|RoleScope\|RoleFreshScope\|RoleLaunchResult\|RoleResult" src/roles/types.ts
```
Expected: all five defined.

**`src/infra/session-run.ts` exists with renamed types:**
```
grep -n "SessionRun\|SessionPhase\|SessionRunRecord" src/infra/session-run.ts
```
Expected: all three present as interface/type definitions.

**`src/services/session-run-service.ts` exists:**
```
grep -n "listWorkPhaseSessions\|listWorkPhaseRuns\|hasWorkPhaseRuns" src/services/session-run-service.ts
```
Expected: all three functions defined.

**Old `src/phases/` files are shims (re-export only, no implementation):**
```
grep -rn "export \*\|export type" src/phases/types.ts src/phases/runner.ts src/phases/orchestrator.ts src/phases/execute.ts src/phases/review.ts
```
Expected: only re-export lines, no function bodies.

**Old `src/infra/phase-run.ts` is a shim:**
```
grep -n "export \*\|export type.*PhaseRun\|export type.*PhaseRunPhase" src/infra/phase-run.ts
```
Expected: `export * from "./session-run.js"` and type alias exports.

---

## Final gate

```bash
npm run check
npm test
```

Both must pass with zero errors and all tests green. Report the exact count of passing/failing tests and any TypeScript diagnostics.

---

## Report format

Summarize results as a checklist:

- [ ] Step 1: Instructions as .md files
- [ ] Step 2: Mission gates
- [ ] Step 3: Incremental validation
- [ ] Step 4: Validator redesign
- [ ] Step 5: Simple mode
- [ ] Step 6: Skills directory
- [ ] Step 7: Rename phases → roles
- [ ] `npm run check` — zero errors
- [ ] `npm test` — all green

For any failed check, quote the exact grep output (or lack thereof) that shows what is missing.
