# Auth And Environment

Use this as the onboarding checklist for local `devtask` usage. Core task orchestration is local, but agent execution, branch publishing, PR creation, and attachable terminals depend on a few external tools.

## Core Requirements

Required for normal task work:

- Git with worktree support
- Git user configured with `user.name` and `user.email`
- push access to the target repo remote
- Node.js 22.x
- npm from the same Node installation
- Codex CLI installed and authenticated

Quick checks:

```bash
node --version
npm --version
git --version
git config user.name
git config user.email
codex --version
```

## GitHub

Used by:

- `devtask pr <task>` for GitHub repos
- `devtask group pr <group>` for GitHub repo members
- `devtask ci <task>`

Required:

- GitHub CLI `gh`
- authenticated `gh` session
- remote push access

Quick checks:

```bash
gh --version
gh auth status
git remote get-url origin
```

## Bitbucket Cloud

Used by:

- `devtask pr <task>` for Bitbucket Cloud repos
- `devtask group pr <group>` for Bitbucket Cloud repo members
- `devtask ci <task>` and `devtask work ci <work>` for Bitbucket Pipelines status

Required environment:

```bash
export BITBUCKET_EMAIL="<atlassian-account-email>"
export BITBUCKET_API_TOKEN="<api-token-with-scopes>"
```

These are account-level environment variables. You set them once in the shell that runs `devtask`, and they apply to every Bitbucket repo your Bitbucket user can access. They are not configured per repo.

For Bitbucket REST API calls, `BITBUCKET_EMAIL` must be your Atlassian account email. It is not the workspace name, repo name, or necessarily your Bitbucket username.

The API token needs scopes for the provider operations you use:

- PR creation: repository read/write and pull request read/write
- CI checks: pipeline read

Bitbucket API tokens are sent as HTTP Basic auth using:

```text
BITBUCKET_EMAIL:BITBUCKET_API_TOKEN
```

The endpoint docs also show bearer-token examples for OAuth access tokens. `devtask` does not use that OAuth flow for local CLI usage.

For a one-off shell session:

```bash
export BITBUCKET_EMAIL="<atlassian-account-email>"
export BITBUCKET_API_TOKEN="<api-token-with-scopes>"
```

For a persistent local setup on zsh, add the exports to `~/.zshrc`:

```bash
echo 'export BITBUCKET_EMAIL="<atlassian-account-email>"' >> ~/.zshrc
echo 'export BITBUCKET_API_TOKEN="<api-token-with-scopes>"' >> ~/.zshrc
source ~/.zshrc
```

Prefer storing the token in a password manager and pasting it into your shell profile intentionally. Do not commit these values to a repository, `.env` file, task file, or docs.

Older setups are still accepted through `BITBUCKET_USERNAME` and `BITBUCKET_APP_PASSWORD` as fallbacks, but new onboarding should use `BITBUCKET_EMAIL` and `BITBUCKET_API_TOKEN`.

Bitbucket Cloud does not support draft pull requests in devtask. Use:

```bash
devtask pr <task> --ready
devtask group pr <group> --ready
```

`--draft` fails before pushing or creating a pull request for Bitbucket repos.

Quick checks:

```bash
test -n "$BITBUCKET_EMAIL"
test -n "$BITBUCKET_API_TOKEN"
git remote get-url origin
```

You can validate credentials against a target repository before running `devtask pr`:

```bash
curl --user "$BITBUCKET_EMAIL:$BITBUCKET_API_TOKEN" \
  https://api.bitbucket.org/2.0/repositories/<workspace>/<repo_slug>
```

If that returns 401 or 403, fix the email/token/scopes first. `devtask` uses the same authentication form and checks the target repository before pushing.

## GitLab

Used by:

- `devtask pr <task>` for GitLab repos
- `devtask group pr <group>` for GitLab repo members

Required:

- GitLab CLI `glab`
- authenticated `glab` session
- remote push access

Quick checks:

```bash
glab --version
glab auth status
git remote get-url origin
```

Draft GitLab merge requests are not supported yet. Use `--ready`.

## Jira

Used by:

- `devtask jira fetch <issue>`
- `devtask jira create <issue>`
- `devtask jira group <issue>`

Required config:

```bash
devtask config jira \
  --base-url https://company.atlassian.net \
  --email you@company.com \
  --cloud-id <cloudId>
```

Get `cloudId` once per Jira site:

```bash
curl https://company.atlassian.net/_edge/tenant_info
```

Required environment:

```bash
export JIRA_API_TOKEN="<jira-api-token>"
```

The Jira token is an Atlassian account API token. It is account-level, not repo-specific. `devtask` uses it with your configured Jira email via HTTP Basic auth.

When `cloudId` is configured, `devtask` calls Atlassian's gateway URL:

```text
https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/...
```

Without `cloudId`, `devtask` falls back to the classic site-local URL:

```text
https://company.atlassian.net/rest/api/3/...
```

Quick checks:

```bash
devtask jira doctor
test -n "$JIRA_API_TOKEN"
```

For polyrepo work, configure Jira in the workspace folder where you run `devtask init --workspace`, then create a group with explicit repo ownership:

```bash
devtask jira group APP-123 \
  --repo backend=./backend:app-123-backend \
  --repo web=./web:app-123-web
```

## Optional Tools

### tmux

Recommended for the default attachable runtime. When tmux is available during `devtask init`, `devtask run <task>` starts a detached but attachable session, so you can enter or steer the live agent later:

```bash
devtask run <task>
devtask attach <task>
devtask steer <task> "Use the existing project convention."
```

If tmux is missing, devtask falls back to plain mode. Plain mode can run background workers, but `attach` and `steer` are unavailable.

Quick check:

```bash
tmux -V
```

## Current Doctor Command

`devtask doctor` inspects runtime configuration, tmux availability, and task metadata for stale process and filesystem state.

```bash
devtask doctor
```

Planned follow-up checks:

```bash
devtask doctor auth
```

Group-level SCM readiness checks are available with:

```bash
devtask group doctor <group>
```

This validates repo-local runtime mode, attach/steer availability, provider auth, Bitbucket environment variables, remote/provider detection, dirty worktrees, and branch commits for each repo task. In workspace mode, group metadata lives in the workspace folder, but runtime configuration still lives in each member repository. Run `devtask init` inside each member repo to configure attachable runtime defaults.
