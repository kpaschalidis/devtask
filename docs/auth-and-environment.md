# Auth And Environment

Use this as the practical setup checklist for the current `devtask` control-plane workflow.

## Core Requirements

- Git with worktree support
- Git user configured with `user.name` and `user.email`
- push access to the repo remotes you plan to publish from
- Node.js 22.x
- npm from the same Node installation
- Codex CLI or Cursor Agent CLI installed and authenticated

Quick checks:

```bash
node --version
npm --version
git --version
git config user.name
git config user.email
codex --version
agent --help
```

## tmux

tmux is recommended for attachable repo-local sessions:

```bash
tmux -V
devtask config runtime attachable
devtask work spec <work-id>
devtask work spec attach <work-id>
devtask work spec feedback <work-id> "message"
devtask work execute attach <work-id> <repo-id>
devtask work execute <work-id>
```

Without tmux, `devtask` can still manage artifacts and state, but live attach/feedback behavior is limited.

## GitHub

Used by:

- `devtask work pr <work-id>`
- `devtask work ci <work-id>`

Required:

- GitHub CLI `gh`
- authenticated `gh` session
- remote push access

Checks:

```bash
devtask config scm github
gh --version
gh auth status
git remote get-url origin
```

## Bitbucket Cloud

Used by:

- `devtask work pr <work-id>`
- `devtask work ci <work-id>`

Workspace config:

```bash
devtask config scm bitbucket
```

Required environment:

```bash
export BITBUCKET_EMAIL="<atlassian-account-email>"
export BITBUCKET_API_TOKEN="<api-token-with-scopes>"
```

Scopes:

- PR creation: repository read/write and pull request read/write
- CI checks: pipeline read

Validation:

```bash
curl --user "$BITBUCKET_EMAIL:$BITBUCKET_API_TOKEN" \
  https://api.bitbucket.org/2.0/repositories/<workspace>/<repo_slug>
```

Bitbucket draft PRs are not supported; use `--ready`.

## GitLab

Used by:

- `devtask work pr <work-id>`

Workspace config:

```bash
devtask config scm gitlab
```

Required:

- GitLab CLI `glab`
- authenticated `glab` session
- remote push access

Checks:

```bash
glab --version
glab auth status
git remote get-url origin
```

## Jira

Used by:

- `devtask work import jira <issue-key>`

Workspace config:

```bash
devtask config tracker jira
devtask config jira \
  --base-url https://company.atlassian.net \
  --email you@company.com \
  --cloud-id <cloudId>
```

Required environment:

```bash
export JIRA_API_TOKEN="<jira-api-token>"
```

Summary:
- workspace config chooses tracker and SCM identity
- environment variables provide secrets

## Verify Commands

`work check` and `work verify` use the repo-local `verify` command list from `.devtask/config.json`.

Example:

```json
{
  "verify": ["npm test", "npm run typecheck"]
}
```

Use repo-specific commands per repository.
