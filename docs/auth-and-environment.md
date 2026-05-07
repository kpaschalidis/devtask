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

Required environment:

```bash
export BITBUCKET_USERNAME="<atlassian-account-email-or-bitbucket-username>"
export BITBUCKET_API_TOKEN="<api-token-with-scopes>"
```

These are account-level environment variables. You set them once in the shell that runs `devtask`, and they apply to every Bitbucket repo your Bitbucket user can access. They are not configured per repo.

The API token needs repository and pull request scopes. At minimum, use scopes that allow reading/writing repositories and reading/writing pull requests.

For a one-off shell session:

```bash
export BITBUCKET_USERNAME="<atlassian-account-email-or-bitbucket-username>"
export BITBUCKET_API_TOKEN="<api-token-with-scopes>"
```

For a persistent local setup on zsh, add the exports to `~/.zshrc`:

```bash
echo 'export BITBUCKET_USERNAME="<atlassian-account-email-or-bitbucket-username>"' >> ~/.zshrc
echo 'export BITBUCKET_API_TOKEN="<api-token-with-scopes>"' >> ~/.zshrc
source ~/.zshrc
```

Prefer storing the token in a password manager and pasting it into your shell profile intentionally. Do not commit these values to a repository, `.env` file, task file, or docs.

Older Bitbucket app-password setups are still accepted through `BITBUCKET_APP_PASSWORD` as a fallback, but new onboarding should use `BITBUCKET_API_TOKEN`.

Bitbucket Cloud does not support draft pull requests in devtask. Use:

```bash
devtask pr <task> --ready
devtask group pr <group> --ready
```

`--draft` fails before pushing or creating a pull request for Bitbucket repos.

Quick checks:

```bash
test -n "$BITBUCKET_USERNAME"
test -n "$BITBUCKET_API_TOKEN"
git remote get-url origin
```

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

## Optional Tools

### tmux

Required only for attachable task sessions:

```bash
devtask run <task> --tmux
devtask attach <task>
```

Quick check:

```bash
tmux -V
```

## Current Doctor Command

`devtask doctor` currently inspects task metadata for stale process and filesystem state.

```bash
devtask doctor
```

Planned follow-up checks:

```bash
devtask doctor auth
devtask doctor scm
```

Those should eventually validate provider auth, required CLIs, Bitbucket environment variables, and remote/provider detection.
