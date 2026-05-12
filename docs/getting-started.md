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
```

In a git repository, `devtask init` creates a workspace and adds the default target `app -> .`.

For a product folder that contains multiple repositories:

```bash
cd /path/to/product
devtask init
devtask workspace target add backend ./backend --kind backend
devtask workspace target add web ./web --kind frontend
devtask workspace target list
```

Targets are stable addresses the work planner can assign tasks to. A target can be a whole repo or a scoped folder inside a repo. Adding a target also initializes that target repo's `.devtask/` execution storage if needed.

## 3. Configure Checks

Configure checks for each target repository that will execute repo-local tasks:

```bash
cd /path/to/repo
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

## 5. Build And Approve The Spec

```bash
devtask work spec APP-123
devtask work show APP-123
devtask work approve-spec APP-123
```

`spec` creates or updates the complete planning package:

- `.devtask/work/<id>/plan.md`
- `.devtask/work/<id>/graph.json`
- `.devtask/work/<id>/approved-graph.json`
- `.devtask/work/<id>/materialization.json`
- repo-local tasks, worktrees, and repo-specific `plan.md` files

`approve-spec` is the human gate before implementation. It approves the holistic workspace plan plus the repo-specific plans.

## 6. Execute Implementation

```bash
devtask work exec APP-123 --auto
devtask work board APP-123
```

`exec --auto` starts ready repo tasks, respects graph dependencies, runs checks, runs review, and stops before publishing. If a check or review fails, inspect logs and run `fix`, then run `exec --auto` again.

Attach or steer one target when tmux runtime is available:

```bash
devtask work attach APP-123 --target backend
devtask work steer APP-123 --target backend "Keep the API change backward-compatible."
```

## 7. Manual Recovery And Quality Gates

```bash
devtask work check APP-123
devtask work review APP-123
devtask work fix APP-123 --target backend --from check
```

If checks fail:

```bash
devtask work logs APP-123 --target backend --stage check
devtask work fix APP-123 --target backend --from check
devtask work check APP-123 --target backend
```

The low-level stage commands are available for manual recovery. The main path is still `work exec --auto`.

## 8. Approve And Publish

```bash
devtask work approve-exec APP-123
```

`approve-exec` is the human gate for implementation. It validates checks/review, approves repo tasks, creates PRs from existing commits, and checks CI once.

Low-level publish commands remain available:

```bash
devtask work approve APP-123
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

## 10. Find Work Later

`devtask init` registers the workspace in the global disposable index under `~/.devtask/index.json`.

```bash
devtask recent
devtask where APP-123
devtask registry list
```

The global index is for discovery only. Workspace and repo-local `.devtask/` artifacts remain the source of truth.
