# Auth And Environment

Use this as the onboarding checklist for local `devtask` usage. Core orchestration is local, but agent execution, attachable terminals, publishing, and source ingestion depend on external tools.

## Core Requirements

Required for normal work:

- Git with worktree support
- Git user configured with `user.name` and `user.email`
- push access to the target repository remotes
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

## tmux

tmux is recommended. When configured, agent stages start in detached but attachable sessions:

```bash
tmux -V
devtask config runtime attachable
devtask work attach <work-id> --target <target-id>
devtask work steer <work-id> --target <target-id> "message"
```

Without tmux, `devtask` can still run in plain background mode, but live attach and steer are unavailable.

## GitHub

Used by:

- `devtask work pr <work>`
- `devtask work ci <work>`
- `devtask task pr <task>`
- `devtask task ci <task>`

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

- `devtask work pr <work>`
- `devtask work ci <work>`
- `devtask task pr <task>`
- `devtask task ci <task>`

Required environment:

```bash
export BITBUCKET_EMAIL="<atlassian-account-email>"
export BITBUCKET_API_TOKEN="<api-token-with-scopes>"
```

These are account-level environment variables. Set them in the shell that runs `devtask`; they apply to every Bitbucket repository your account can access.

Required token scopes depend on the operation:

- PR creation: repository read/write and pull request read/write
- CI checks: pipeline read

Bitbucket API tokens are sent as HTTP Basic auth using:

```text
BITBUCKET_EMAIL:BITBUCKET_API_TOKEN
```

Persistent zsh setup:

```bash
echo 'export BITBUCKET_EMAIL="<atlassian-account-email>"' >> ~/.zshrc
echo 'export BITBUCKET_API_TOKEN="<api-token-with-scopes>"' >> ~/.zshrc
source ~/.zshrc
```

Validate credentials against one target repository:

```bash
curl --user "$BITBUCKET_EMAIL:$BITBUCKET_API_TOKEN" \
  https://api.bitbucket.org/2.0/repositories/<workspace>/<repo_slug>
```

Bitbucket Cloud does not support draft pull requests in devtask. Use `--ready`.

## GitLab

Used by:

- `devtask work pr <work>`
- `devtask task pr <task>`

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
- `devtask work create <issue> --from-jira`

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

The Jira token is account-level. When `cloudId` is configured, `devtask` calls Atlassian's gateway URL:

```text
https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/...
```

Quick checks:

```bash
test -n "$JIRA_API_TOKEN"
devtask jira doctor
```

## Recommended Doctor Flow

```bash
devtask doctor
devtask jira doctor
devtask work board <work-id>
```

`doctor` checks local runtime setup. Provider-specific failures should be fixed before publishing or CI inspection.
