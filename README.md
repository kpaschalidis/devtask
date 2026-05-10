# devtask

`devtask` is a local CLI for running persistent, parallel agent tasks against a git repository and moving them through an opinionated task-to-PR workflow.

Each task gets:

- a durable task directory under `.devtask/tasks/<id>`
- its own git worktree under `.devtask/worktrees/<id>`
- task, state, result, run, and log files
- a background worker lifecycle you can run, continue, pause, cancel, inspect, check, and review

The goal is to remove the friction of manually juggling multiple agent terminals while keeping each task isolated and inspectable.

One installed `devtask` command can be used across all of your local repositories. State is intentionally repo-local: each target repository gets its own `.devtask` directory, tasks, worktrees, and branches.

## Install

## Prerequisites

- Git with worktree support.
- Node.js 22.x recommended. Use one Node version consistently in every shell that runs `devtask`.
- npm matching that Node installation.
- Codex CLI installed and authenticated.
- GitHub CLI (`gh`) installed and authenticated for GitHub `devtask pr` and `devtask ci`.
- Bitbucket Cloud PR creation requires `BITBUCKET_EMAIL` and `BITBUCKET_API_TOKEN`.
- Jira source ingestion requires `devtask config jira ...` and `JIRA_API_TOKEN`.
- GitLab PR creation requires GitLab CLI (`glab`) installed and authenticated.
- tmux recommended for the default attachable runtime, `devtask attach`, and `devtask steer`.

See [Auth And Environment](docs/auth-and-environment.md) for provider auth, environment variables, and optional tools. See [Lifecycle Contracts](docs/lifecycle-contracts.md) for the stage model behind `create`, `run`, `check`, `review`, `approve`, `commit`, `pr`, `ci`, and group workflows. See [Target Architecture](docs/target-architecture.md) for the long-term tracker-to-PR work-item model, and [Workspace And Work Contracts](docs/work-contracts.md) for workspace/work command contracts.

Recommended local setup:

```bash
nvm use 22
nvm alias default 22
node --version
gh auth status
codex --version
```

```bash
npm install
npm run build
npm link
```

## Basic Workflow

```bash
devtask init
devtask config model gpt-5.2
devtask config check 'npm test -w @converge/v0' 'npm run typecheck -w @converge/v0'

devtask create fix-login \
  --goal "Fix login redirect loop and add regression coverage"

devtask plan fix-login
devtask run fix-login
devtask attach fix-login
devtask steer fix-login "Use the existing middleware pattern."

devtask list
devtask board
devtask next fix-login
devtask advance fix-login
devtask status fix-login
devtask logs fix-login
devtask logs -f fix-login
devtask inspect fix-login
devtask check fix-login
devtask review fix-login
devtask approve fix-login
devtask commit fix-login
devtask pr fix-login
devtask ci fix-login
devtask cleanup fix-login --dry-run
```

## Jira Source Workflow

Configure Jira once in the repo or workspace where you create tasks:

```bash
devtask config jira \
  --base-url https://company.atlassian.net \
  --email you@company.com \
  --cloud-id <cloudId>

export JIRA_API_TOKEN="<jira-api-token>"
devtask jira doctor
```

Get `cloudId` once per Jira site:

```bash
curl https://company.atlassian.net/_edge/tenant_info
```

Fetch an issue into durable local source artifacts:

```bash
devtask jira fetch APP-123
```

Create a single-repo task from a Jira issue:

```bash
devtask jira create APP-123 --task app-123
devtask plan app-123
devtask run app-123
```

Create a polyrepo group from a Jira issue with explicit repo ownership:

```bash
devtask jira group APP-123 \
  --repo backend=./backend:app-123-backend \
  --repo web=./web:app-123-web

devtask group orchestrate app-123
devtask group plan app-123
devtask group run app-123
```

Jira artifacts are written under `.devtask/sources/jira/`. V1 does not guess affected repositories from ticket text; pass every repo explicitly with `--repo name=path:task-id`. `devtask group orchestrate <id>` creates the shared cross-repo contract before repo-local planning starts.

If a worker command exits successfully but does not write a terminal `result.json`, devtask moves the task to `review` instead of looping forever. If the worker writes `{"status":"done"}`, devtask marks the worker run as `done`.

```bash
devtask inspect fix-login
```

`done` means the coding worker believes the task is complete. It does not mean the diff was reviewed, accepted, merged, or shipped. After `done`, inspect the diff, run checks, run review, then mark the task approved when you accept it:

```bash
devtask inspect fix-login
devtask check fix-login
devtask review fix-login
devtask approve fix-login
devtask commit fix-login
devtask pr fix-login
```

`devtask inspect` summarizes task metadata, the latest run, latest checks, latest review artifact, current worktree changes, and `result.json`. It is the command to use when a worker stops, reaches `review`, or you want to decide whether to check, review, merge, continue, or discard the task worktree.

`devtask plan` runs a planning-only agent and writes `.devtask/tasks/<id>/plan.md`. It is useful before implementation, and `devtask run` includes the plan in the worker prompt when one exists.

By default, `devtask run` uses an attachable tmux runtime when tmux is available during `devtask init`. The command still returns immediately, but the live agent can be entered or steered later:

```bash
devtask attach fix-login
devtask steer fix-login "Adjust the implementation before continuing."
```

If tmux is not installed, devtask configures plain mode. Plain mode can run background workers, but live `attach` and `steer` are unavailable:

```bash
devtask config runtime
devtask config runtime attachable
devtask run fix-login --plain
```

`devtask check` runs deterministic commands configured with `devtask config check`, such as tests, typecheck, and lint.

`devtask review` runs a read-only Codex review pass and stores the artifact under `.devtask/tasks/<id>/reviews/`.

`devtask board` shows every task as a cockpit view: task status, latest check, latest review, PR state, and the next recommended command.

`devtask next <id>` explains the next action for one task. Without an id, it prints recommendations for all tasks.

`devtask commit <id>` commits current task worktree changes without pushing. Workers are instructed to commit completed work themselves, so this is mainly a manual recovery command.

`devtask pr <id>` pushes existing task branch commits and opens a provider PR/MR. It detects GitHub, Bitbucket Cloud, or GitLab from `origin`. It does not commit uncommitted work. If the task worktree is dirty or the branch has no commits to publish, it stops with a clear error.

Bitbucket Cloud does not support draft pull requests in devtask. Use `--ready` for Bitbucket repos. Passing `--draft` to a Bitbucket repo fails before creating the PR.

`devtask advance <id>` runs the next safe step automatically. It can start or continue a worker, run checks, run the review agent, open an approved PR, or check CI. It stops at human approval and prints the command to run after you inspect the work.

Use `approve` as the normal human gate. It requires passing configured checks and a passing review by default:

```bash
devtask approve fix-login
devtask approve fix-login --force
```

You can correct or record lower-level human decisions on stopped tasks:

```bash
devtask mark fix-login review
devtask mark fix-login approved
devtask mark fix-login done
devtask mark fix-login blocked
devtask mark fix-login cancelled
```

Common states:

- `review`: useful work exists and needs human inspection
- `done`: the worker reported completion; human review and approval may still be required
- `approved`: human accepted the local diff and it can be turned into a PR
- `pr-open`: a GitHub PR exists
- `ci-passed` / `ci-failed`: PR checks were inspected

Attach to a live task or send steering feedback:

```bash
devtask attach fix-login
devtask steer fix-login "Keep the change scoped to the API layer."
```

Pause future runs without killing the current command:

```bash
devtask pause fix-login
devtask continue fix-login
```

Cancel the supervisor process group:

```bash
devtask cancel fix-login
```

Inspect stale process metadata or missing worktrees:

```bash
devtask doctor
```

Install editable helper scripts into the current repo:

```bash
devtask scripts list
devtask scripts install
devtask scripts run smoke-regular help
devtask scripts run smoke-polyrepo help
```

Installed scripts live under `.devtask/scripts/`. Edit their constants per repo, or pass environment overrides when running them.

For a product folder that contains multiple repositories but is not itself a git repo, initialize workspace mode first:

```bash
cd ~/projects/product-folder
devtask init --workspace
devtask scripts install
```

Workspace mode stores group metadata and helper scripts in the product folder's `.devtask/` directory. Repo-local task commands still run inside the member git repositories. Run `devtask init` inside each member repo to configure its runtime mode, checks, and provider-local task storage.

Register workspace targets to describe the repos or repo scopes that future work-item orchestration can reason about:

```bash
devtask workspace target add backend ./backend --kind api
devtask workspace target add dragonfly ./dragonfly --kind frontend
devtask workspace target add api . --scope packages/api --kind api
devtask workspace target list
```

A target is a stable orchestration address. It can point at a whole repo in a polyrepo workspace, or at a scoped folder inside a monorepo. Existing task and group commands still work; targets are the inventory layer for the work-item flow.

Create durable work items before deciding whether the work is single-repo, monorepo scoped, or polyrepo:

```bash
devtask work create improve-install --title "Improve install docs" --body "Clarify npm link and basic workflow."
devtask work create CPS-549 --from-jira
devtask work plan CPS-549
devtask work board CPS-549
devtask work approve-plan CPS-549
devtask work repo-plan CPS-549
devtask work run CPS-549
devtask work check CPS-549
devtask work review CPS-549
devtask work approve CPS-549
devtask work commit CPS-549
devtask work pr CPS-549 --ready
devtask work ci CPS-549
devtask work board CPS-549
devtask work list
devtask work show CPS-549
```

A work item stores the original source under `.devtask/work/<id>/` and is the foundation for the planned work-item flow: source input, target selection, orchestration graph, repo/scope tasks, review, PRs, and CI follow-up. `devtask work plan <id>` writes a human plan to `.devtask/work/<id>/plan.md` and a proposed machine-readable graph to `.devtask/work/<id>/graph.json`; it does not create repo tasks yet. `devtask work board <id>` shows the work item's current stage and, after materialization, each repo-local task with its next command. `devtask work approve-plan <id>` validates the graph, freezes it as `.devtask/work/<id>/approved-graph.json`, creates repo-local task worktrees, and records the mapping in `.devtask/work/<id>/materialization.json`. `devtask work repo-plan <id>` turns the approved graph into repo-local task plans and marks those tasks ready to run. `devtask work run <id>` starts ready repo tasks and waits only on `run` dependencies; `validation` and later-stage dependencies do not block parallel implementation. `devtask work check/review/approve <id>` lift the repo-local quality gates to the work item. `devtask work commit/pr/ci <id>` publish and inspect the materialized repo task PRs.

Planning stages are idempotent by default. If `devtask work plan <id>` already has `plan.md` and `graph.json`, it prints the existing artifacts and the next command instead of overwriting them. Use `devtask work plan <id> --refresh` only before `approve-plan`. After materialization, replan by cleaning up the work item and creating it again. `devtask work repo-plan <id>` similarly reports existing repo plans by default; use `--refresh` to regenerate repo-local plans before tasks run.

Remove a task worktree and metadata when you no longer need the local task record:

```bash
devtask cleanup fix-login --dry-run
devtask cleanup fix-login
```

Cleanup refuses running tasks and dirty worktrees unless you pass `--force`.

## Local Cleanup

Use cleanup commands when a local test task, group, or work item is no longer useful. Always preview destructive cleanup first:

```bash
devtask cleanup <task-id> --dry-run
devtask group cleanup <group-id> --dry-run
```

Then run the cleanup:

```bash
devtask cleanup <task-id>
devtask group cleanup <group-id>
```

`devtask cleanup <task-id>` removes that task's local metadata and worktree. `devtask group cleanup <group-id>` removes every member task worktree and metadata directory, then removes the group metadata.

If cleanup refuses because a task is running or the task worktree is dirty, inspect it first:

```bash
devtask status <task-id>
git -C .devtask/worktrees/<task-id> status --short
```

Use `--force` only when you intentionally want to discard the local task worktree state:

```bash
devtask cleanup <task-id> --force
devtask group cleanup <group-id> --force
```

Work items currently store source and planning artifacts only. Remove a local work item manually when you want to reset a work-item test:

```bash
rm -rf .devtask/work/<work-id>
```

Do not delete the whole `.devtask/` directory unless you want to reset workspace config, targets, scripts, groups, work items, and source artifacts.

## Multi-Repo Groups

A group coordinates multiple repo-local tasks from one control root. The control root can be either a git repository initialized with `devtask init` or a non-git product folder initialized with `devtask init --workspace`. Each repo still owns its own `.devtask` state, task worktree, checks, review, PR, and CI lifecycle. The group stores only cross-repo coordination metadata.

For a product folder that contains several repos:

```bash
cd ~/projects/product-folder
devtask init --workspace
```

Then add member repos by path:

```bash
devtask group create billing-export \
  --goal-file billing-export-goal.md \
  --repo backend=~/projects/api:billing-export-api \
  --repo frontend=~/projects/web:billing-export-ui
```

This creates the group and the repo-local tasks in one step. Each `--repo` value uses:

```text
name=repo-path:task-id
```

You can also add repos incrementally:

```bash
devtask group create billing-export \
  --goal "Add billing export across frontend and backend"

devtask group add billing-export backend ~/projects/api \
  --task billing-export-api \
  --goal "Add the billing export API"

devtask group add billing-export frontend ~/projects/web \
  --task billing-export-ui \
  --goal "Add the billing export UI"
```

Use the group cockpit:

```bash
devtask group list
devtask group show billing-export
devtask group inspect billing-export
devtask group board billing-export
devtask group next billing-export
devtask group logs billing-export
devtask group logs billing-export --repo backend -f
devtask group attach billing-export --repo backend
devtask group steer billing-export --repo backend "Keep this scoped to backend conventions."
devtask group orchestrate billing-export
devtask group plan billing-export
devtask group check billing-export
devtask group review billing-export
devtask group approve billing-export
devtask group commit billing-export
devtask group doctor billing-export
devtask group pr billing-export --draft
devtask group run billing-export
devtask group advance billing-export
devtask group remove billing-export frontend
devtask group cleanup billing-export --dry-run
```

`devtask group board` shows every repo task with lifecycle stage, status, latest check, latest review, PR state, and next command. `devtask group advance` runs safe next steps across repos, using the same single-repo task lifecycle. It still stops at human approval, review findings, failed checks, and ambiguous states.

`devtask group orchestrate <id>` creates or refreshes `.devtask/groups/<id>/orchestration.md`. The orchestration plan is the shared cross-repo contract: affected repos, responsibilities, dependencies, ownership boundaries, validation plan, risks, and open questions. `devtask group plan <id>` automatically feeds this orchestration context into each repo-local planning agent when it exists.

`devtask group plan <id>`, `devtask group check <id>`, and `devtask group review <id>` run the same repo-local lifecycle across every repo in the group. Use `--repo <name>` to run only one member.

`devtask group attach <id> --repo <name>` and `devtask group steer <id> --repo <name> "message"` target one repo task at a time. Group steering does not broadcast by default.

`devtask group approve <id>` applies the approval policy across repo tasks. Use `--repo <name>` to approve one member or `--force` to override missing/failing checks or review.

`devtask group mark <id> <status>` is the lower-level manual status override across the group.

`devtask group commit <id>` and `devtask group pr <id>` run the commit and PR lifecycle across every repo in the group. Use `--repo <name>` to run only one member. Group PR creation follows the same strict rule as repo-level PR creation: it only publishes existing commits and refuses dirty worktrees.

`devtask group doctor <id>` checks runtime attachability, SCM provider/auth readiness, clean worktrees, and branch commits for every repo task. `devtask group pr <id>` prints the same style of preflight table before opening PRs and stops before publishing when a repo is not ready.

`devtask group remove <id> <repo-name>` only removes the repo from the group. Pass `--delete-task` to also delete that repo task's `.devtask/tasks/<task-id>` metadata directory. It does not remove the task worktree or revert code changes.

`devtask group cleanup <id>` removes every member task worktree and metadata directory, then removes the group metadata. Use `--dry-run` first. It refuses running tasks and dirty worktrees unless you pass `--force`.

V1 groups do not execute dependency ordering, grouped PR creation, or grouped CI fixing automatically. Those belong above the basic coordination layer.

## Task Layout

```text
.devtask/
  groups/
    <id>/
      group.json
      state.md
      plan.md
  tasks/
    <id>/
      task.md
      state.md
      result.json
      meta.json
      lock.json
      logs/
      runs/
  worktrees/
    <id>/
```

## Worker Contract

By default, a task runs:

```bash
codex exec --full-auto --add-dir "$DEVTASK_TASK_DIR" - < "$DEVTASK_TASK_PATH"
```

You can override it at creation time:

```bash
devtask create my-task --cmd "npm test"
```

Set the default Codex model per repository:

```bash
devtask config model gpt-5.2
```

Override one task:

```bash
devtask create my-task --model gpt-5.2
devtask model my-task gpt-5.2
```

You can also update an existing task command:

```bash
devtask command my-task 'npm test'
```

Configure check commands per repository:

```bash
devtask config check 'npm test' 'npm run typecheck'
devtask check my-task
```

Open a draft PR after review/approval:

```bash
devtask approve my-task
devtask commit my-task
devtask pr my-task
devtask ci my-task
```

The worker command runs from the task worktree and receives these environment variables:

- `DEVTASK_ROOT`
- `DEVTASK_TASK_ID`
- `DEVTASK_TASK_DIR`
- `DEVTASK_TASK_PATH`
- `DEVTASK_STATE_PATH`
- `DEVTASK_RESULT_PATH`

When the command writes this result, the worker marks the task as done:

```json
{
  "status": "done"
}
```
