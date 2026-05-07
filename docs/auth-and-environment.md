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
export BITBUCKET_USERNAME="<username>"
export BITBUCKET_APP_PASSWORD="<app-password>"
```

The app password needs repository and pull request permissions. At minimum, use permissions that allow reading the repository, pushing branches, and creating pull requests.

Bitbucket Cloud does not support draft pull requests in devtask. Use:

```bash
devtask pr <task> --ready
devtask group pr <group> --ready
```

`--draft` fails before pushing or creating a pull request for Bitbucket repos.

Quick checks:

```bash
test -n "$BITBUCKET_USERNAME"
test -n "$BITBUCKET_APP_PASSWORD"
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
