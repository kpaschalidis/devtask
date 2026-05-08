# Lifecycle Contracts

`devtask` is an opinionated local workflow for moving task work from agent execution to reviewed, committed PRs. This document defines the current stage contracts so commands can grow without turning into ad hoc wrappers.

## Principles

- Each stage has explicit inputs, outputs, artifacts, and a clear owner.
- Agent stages may continue from durable context instead of starting over.
- Deterministic stages record machine-readable artifacts.
- Human gates are explicit and should not be hidden inside publishing commands.
- PR creation publishes existing commits only. It must not silently commit dirty work.
- Group commands coordinate repo-local stages. They do not replace the per-repo task lifecycle.

## Stage Summary

| Stage | Owner | Main inputs | Main artifacts | Exit |
| --- | --- | --- | --- | --- |
| `create` | CLI | task id, goal, repo config, optional model/command | task directory, worktree, branch, metadata | created task |
| `plan` | agent or human | ticket/context/assets, repo structure, optional group goal | plan document, state updates | planned or blocked |
| `run` | coding agent | task prompt, state, optional plan, existing diff | code/docs changes, logs, state, result | review, done, blocked, failed |
| `inspect` | CLI/human | metadata, logs, result, diff, artifacts | terminal summary | next decision |
| `check` | configured commands | task worktree, repo check config | verification record | passed or failed |
| `review` | review agent | task context, diff, latest check result | review record | passed or findings |
| `approve` | human | diff, task result, check result, review result | approved status | approved or rejected |
| `commit` | agent or CLI fallback | accepted worktree changes | git commit | committed branch |
| `pr` | CLI/provider | clean worktree, branch commits, provider auth | PR/MR URL, `pr-open` status | published or failed |
| `ci` | CLI/provider | PR/MR URL | CI status record | passed, failed, or pending |
| `cleanup` | CLI | task or group id | removed metadata/worktree | removed local task record |

## Stage Contracts

### Create

`devtask create <id>` creates a durable task and isolated worktree.

Inputs:

- task id
- goal text or goal file
- repo-local configuration
- optional model and worker command

Artifacts:

- `.devtask/tasks/<id>/task.md`
- `.devtask/tasks/<id>/state.md`
- `.devtask/tasks/<id>/result.json`
- `.devtask/tasks/<id>/meta.json`
- `.devtask/worktrees/<id>/`
- task branch

The create stage should not run the agent.

### Plan

`devtask plan <id>` runs a planning-only agent and writes a durable task plan.

Inputs:

- ticket title and description
- relevant assets, links, or constraints
- repo structure discovered by the agent
- optional group goal for polyrepo work

Artifacts:

- `.devtask/tasks/<id>/plan.md`
- plan run records under `.devtask/tasks/<id>/plans/`
- state updates explaining what was inspected and decided

Rules:

- planning should not modify the task worktree
- planning is available before approval and publishing
- if a plan exists, `run` includes it in the worker prompt
- `review` checks the implementation against the accepted plan

Future direction:

- support interactive planning sessions
- allow explicit human acceptance or replacement of a plan artifact

### Run

`devtask run <id>` starts or continues the worker loop for the same task. It does not start from scratch.

Inputs:

- task prompt
- durable state
- previous result
- optional plan
- current worktree contents
- latest check, review, or CI feedback when the task is continued

Artifacts:

- code or documentation changes in the task worktree
- logs under `.devtask/tasks/<id>/logs/`
- run records under `.devtask/tasks/<id>/runs/`
- updates to `state.md`
- terminal `result.json` when the worker is done or blocked

The worker should commit completed work itself when it is confident, but V1 also provides `devtask commit` as a manual recovery path.

Runtime behavior:

- attachable mode uses tmux and is the preferred runtime when available
- attachable tasks can be entered with `devtask attach <id>`
- live feedback can be sent with `devtask steer <id> "message"`
- plain mode is a degraded fallback and does not support live attach or steer

### Inspect

`devtask inspect <id>` is the local decision point after a worker stops or when a task looks ambiguous.

Inputs:

- metadata
- latest run
- latest result
- latest logs
- latest check and review artifacts
- worktree diff and status

Output:

- a readable summary of what happened
- current worktree state
- recommended next command

Inspect does not change task state.

### Check

`devtask check <id>` runs the repo-configured verification commands in the task worktree.

Inputs:

- commands configured with `devtask config check`
- task worktree

Artifacts:

- verification record under the task directory

The command name is `check` because it can include tests, typecheck, lint, build, or repo-specific validation. In developer conversation, "run tests" may still mean `devtask check`.

### Review

`devtask review <id>` runs a read-only review agent against the task diff and records the result.

Inputs:

- task prompt and state
- current diff
- latest check result when available
- repository conventions visible in the worktree

Artifacts:

- review prompt and output under `.devtask/tasks/<id>/reviews/`
- structured pass/fail status when the review output is parseable

The review stage should not fix findings in the same turn. Findings are inputs to the next `run` or human edit cycle.

### Approve

`devtask approve <id>` is the human acceptance gate before PR creation.

Inputs:

- task result
- worktree diff
- latest check result
- latest review result

Current V1 policy:

- task must be stopped
- if check commands are configured, the latest check must pass
- latest review must pass
- `--force` can override the policy with an explicit human decision

TODO: replace this artifact-level policy with a stage contract baseline that tracks the last content-changing event. That will let devtask distinguish stale checks/reviews from metadata-only updates without relying on timestamps.

`devtask mark <id> approved` remains a lower-level status override. Normal workflow recommendations should use `devtask approve <id>`.

### Commit

`devtask commit <id>` commits current task worktree changes without pushing.

Inputs:

- approved or otherwise accepted worktree changes
- generated or supplied commit message

Artifacts:

- git commit on the task branch

This command is intentionally separate from PR creation. It exists as a convenience when the agent did not commit its completed work.

### PR

`devtask pr <id>` publishes existing task branch commits and opens a provider PR or MR.

Inputs:

- clean task worktree
- branch commits to publish
- provider auth and remote information
- mode, such as ready or draft where supported

Artifacts:

- provider PR/MR URL
- task status `pr-open`

Rules:

- no implicit commit
- no PR when the worktree is dirty
- no PR when there are no branch commits to publish
- provider limitations are enforced before publishing when known

Current provider support:

- GitHub through `gh`
- Bitbucket Cloud through REST API
- GitLab through `glab`

### CI

`devtask ci <id>` checks provider CI status for an opened PR.

Inputs:

- stored PR URL
- provider CLI or API access

Artifacts:

- task status such as `ci-passed` or `ci-failed`

Future direction:

- add CI monitoring loops
- feed CI failures back into `run`
- require human approval before another publish step when fixes change the diff

### Cleanup

`devtask cleanup <id>` removes local task records and the task worktree.

Inputs:

- task id
- optional `--dry-run`
- optional `--force`

Rules:

- refuses running tasks unless forced
- refuses dirty worktrees unless forced
- does not revert or delete remote branches

## Group Contracts

Groups coordinate the same lifecycle across multiple repositories.

Group metadata stores:

- group id
- group goal
- member repo name
- member repo path
- member task id

Each member repo still owns:

- `.devtask/tasks/<task-id>/`
- `.devtask/worktrees/<task-id>/`
- branch
- check, review, approve, commit, PR, and CI artifacts

Group commands such as `devtask group plan <id>`, `devtask group check <id>`, `devtask group review <id>`, `devtask group approve <id>`, `devtask group commit <id>`, and `devtask group pr <id>` fan out repo-local lifecycle commands. Use `--repo <name>` to target one member.

`devtask group attach <id> --repo <name>` and `devtask group steer <id> --repo <name> "message"` target one repo task. Group steering is intentionally one-repo-at-a-time in V1.

V1 groups do not yet provide dependency ordering, cross-repo handoff generation, grouped CI repair, or a single combined PR object. Those belong above the current coordination layer.

## Command Mapping

Single repo:

```bash
devtask create <id> --goal "..."
devtask plan <id>
devtask run <id>
devtask inspect <id>
devtask check <id>
devtask review <id>
devtask approve <id>
devtask commit <id>
devtask pr <id>
devtask ci <id>
devtask cleanup <id>
```

Polyrepo:

```bash
devtask group create <id> --goal-file goal.md \
  --repo api=../api:<task-id-api> \
  --repo web=../web:<task-id-web>

devtask group plan <id>
devtask group run <id>
devtask group attach <id> --repo api
devtask group steer <id> --repo api "message"
devtask group inspect <id>
devtask group check <id>
devtask group review <id>
devtask group approve <id>
devtask group commit <id>
devtask group pr <id>
devtask group cleanup <id>
```
