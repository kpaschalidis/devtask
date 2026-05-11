# Getting Started

This is the recommended developer workflow for real local use.

## 1. Install The CLI

```bash
npm install
npm run build
npm link
devtask --help
```

If the linked command looks stale:

```bash
npm run build
npm link
hash -r
which -a devtask
devtask --help
```

## 2. Initialize A Workspace

For a single repository:

```bash
cd /path/to/repo
devtask init
devtask workspace target add app . --kind app
```

For a product folder that contains multiple repositories:

```bash
cd /path/to/product
devtask init --workspace
devtask workspace target add backend ./backend --kind backend
devtask workspace target add web ./web --kind frontend
devtask workspace target list
```

Targets are stable addresses the work planner can assign tasks to. A target can be a whole repo or a scoped folder inside a repo.

## 3. Configure Checks

Run this inside each target repository that will execute repo-local tasks:

```bash
cd /path/to/repo
devtask init
devtask config check 'npm test' 'npm run typecheck'
devtask config runtime attachable
```

Use repo-specific commands. For example, a backend might use `./manage.sh build`, while a frontend might use `npm run build`.

## 4. Create Work

Manual source:

```bash
devtask work create fix-login \
  --title "Fix login redirect loop" \
  --body "Fix the redirect loop and add regression coverage."
```

Tracker source:

```bash
devtask work create APP-123 --from-jira
```

## 5. Plan And Approve The Graph

```bash
devtask work plan APP-123
devtask work show APP-123
devtask work approve-plan APP-123
```

`plan` creates:

- `.devtask/work/<id>/plan.md`
- `.devtask/work/<id>/graph.json`

`approve-plan` freezes the proposed graph into:

- `.devtask/work/<id>/approved-graph.json`
- repo-local tasks and worktrees

## 6. Repo Plans And Implementation

```bash
devtask work repo-plan APP-123
devtask work run APP-123 --follow
devtask work board APP-123
```

`repo-plan` creates task-specific implementation plans. `run` starts ready repo tasks and respects graph dependencies. `--follow` keeps the terminal open and prints progress; without it, workers run in the background.

Attach or steer one target when tmux runtime is available:

```bash
devtask work attach APP-123 --target backend
devtask work steer APP-123 --target backend "Keep the API change backward-compatible."
```

## 7. Quality Gates

```bash
devtask work check APP-123
devtask work review APP-123
devtask work approve APP-123
```

If checks fail:

```bash
devtask work logs APP-123 --target backend --stage check
devtask work fix APP-123 --target backend --from check
devtask work check APP-123 --target backend
```

`approve` is the human gate before publishing. It validates the configured policy unless `--force` is used.

## 8. Publish

```bash
devtask work commit APP-123
devtask work pr APP-123 --ready
devtask work ci APP-123
```

PR creation publishes existing commits. It does not silently commit dirty worktrees. If the preflight says a target is dirty, inspect and commit first.

## 9. Cleanup

Preview first:

```bash
devtask work cleanup APP-123 --dry-run
```

Then remove local work metadata and worktrees:

```bash
devtask work cleanup APP-123
```

Cleanup does not revert merged code or delete remote branches.
