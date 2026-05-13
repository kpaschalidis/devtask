# DevTask Local TODO

Temporary working list for the current development thread. Do not commit.

## Pending

- [ ] Validate new `devtask init` UX
  - [ ] single repo
  - [ ] monorepo
  - [ ] non-git product workspace with multiple repo targets

- [ ] Validate global discovery
  - [ ] `devtask registry list`
  - [ ] `devtask recent`
  - [ ] `devtask where <work-id>`

- [ ] Add auto mode after approved plan
  - [ ] run lifecycle from `repo-plan` through PR/CI where safe
  - [ ] stop at human gates
  - [ ] reuse fix loop for check failures

- [ ] Harden lifecycle behavior
  - [ ] stale checks/reviews
  - [ ] skipped CI
  - [ ] failed stages
  - [ ] reruns/refresh behavior

- [ ] Polish `work board`
  - [ ] current stage
  - [ ] latest stage result
  - [ ] blockers
  - [ ] next command
  - [ ] human-input waits

- [ ] Make agent-backed stages consistently attachable/steerable
  - [ ] split terminal attachability from true interactive agent runtime
  - [ ] stop treating `tmux + codex exec` as an interactive session
  - [ ] add an interactive Codex runtime path where attach means the engineer can type to the agent
  - [ ] store per-stage runtime metadata: `batch | interactive`, session name, command, stdin support
  - [ ] plan
  - [ ] repo-plan
  - [ ] run
  - [ ] fix
  - [ ] review

- [ ] Strengthen repo-specialist planning consistency
  - [ ] compare repo plans against approved work graph
  - [ ] surface cross-repo inconsistencies
  - [ ] require explicit refresh/approval when graph intent changes

- [ ] Add CI watch/fix loop
  - [ ] poll CI
  - [ ] fetch failure logs
  - [ ] run fix agent
  - [ ] re-check/re-push with retry limits

- [ ] Clean up public docs
  - [ ] getting started
  - [ ] architecture
  - [ ] workflow
  - [ ] auth/environment
  - [ ] command reference
