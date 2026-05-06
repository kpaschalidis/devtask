#!/usr/bin/env bash
set -euo pipefail

# Edit these constants for each smoke run.
CONTROL_REPO="${CONTROL_REPO:-/path/to/control/repo}"
GROUP_ID="${GROUP_ID:-docs-polyrepo-smoke}"
MODEL="${MODEL:-gpt-5.2}"
GROUP_GOAL="${GROUP_GOAL:-Test multi-repo group workflow with README-only changes}"

REPO_A_NAME="${REPO_A_NAME:-frontend}"
REPO_A_PATH="${REPO_A_PATH:-/path/to/frontend}"
REPO_A_TASK="${REPO_A_TASK:-docs-smoke-frontend}"
REPO_A_GOAL="${REPO_A_GOAL:-Make one tiny README wording improvement only. Keep changes docs-only and scoped to README.md.}"
REPO_A_CHECK_1="${REPO_A_CHECK_1:-npm test}"
REPO_A_CHECK_2="${REPO_A_CHECK_2:-npm run typecheck}"

REPO_B_NAME="${REPO_B_NAME:-backend}"
REPO_B_PATH="${REPO_B_PATH:-/path/to/backend}"
REPO_B_TASK="${REPO_B_TASK:-docs-smoke-backend}"
REPO_B_GOAL="${REPO_B_GOAL:-Make one tiny README wording improvement only. Keep changes docs-only and scoped to README.md.}"
REPO_B_CHECK_1="${REPO_B_CHECK_1:-npm test}"
REPO_B_CHECK_2="${REPO_B_CHECK_2:-npm run typecheck}"

ACTION="${1:-help}"

die() {
  echo "smoke-polyrepo: $*" >&2
  exit 1
}

require_repo() {
  local label="$1"
  local repo_path="$2"
  [[ "$repo_path" != /path/to/* ]] || die "edit ${label} path at the top of this script or pass it as an environment variable"
  [[ -d "$repo_path" ]] || die "${label} does not exist: $repo_path"
}

control() {
  require_repo "CONTROL_REPO" "$CONTROL_REPO"
  cd "$CONTROL_REPO"
}

configure_member_repo() {
  local repo_path="$1"
  local check_1="$2"
  local check_2="$3"
  local checks=()

  require_repo "member repo" "$repo_path"
  cd "$repo_path"
  devtask init
  devtask config model "$MODEL"
  [[ -z "$check_1" ]] || checks+=("$check_1")
  [[ -z "$check_2" ]] || checks+=("$check_2")
  if [[ "${#checks[@]}" -gt 0 ]]; then
    devtask config check "${checks[@]}"
  fi
}

case "$ACTION" in
  setup)
    control
    devtask init
    configure_member_repo "$REPO_A_PATH" "$REPO_A_CHECK_1" "$REPO_A_CHECK_2"
    configure_member_repo "$REPO_B_PATH" "$REPO_B_CHECK_1" "$REPO_B_CHECK_2"
    control
    ;;

  create)
    control
    devtask group create "$GROUP_ID" --goal "$GROUP_GOAL"
    devtask group add "$GROUP_ID" "$REPO_A_NAME" "$REPO_A_PATH" --task "$REPO_A_TASK" --goal "$REPO_A_GOAL"
    devtask group add "$GROUP_ID" "$REPO_B_NAME" "$REPO_B_PATH" --task "$REPO_B_TASK" --goal "$REPO_B_GOAL"
    devtask group board "$GROUP_ID"
    ;;

  run)
    control
    devtask group run "$GROUP_ID"
    devtask group board "$GROUP_ID"
    ;;

  logs-a)
    control
    devtask group logs "$GROUP_ID" --repo "$REPO_A_NAME" -f
    ;;

  logs-b)
    control
    devtask group logs "$GROUP_ID" --repo "$REPO_B_NAME" -f
    ;;

  logs)
    control
    devtask group logs "$GROUP_ID"
    ;;

  inspect)
    control
    devtask group inspect "$GROUP_ID"
    echo
    echo "$REPO_A_NAME worktree diff:"
    git -C "$REPO_A_PATH/.devtask/worktrees/$REPO_A_TASK" status --short
    git -C "$REPO_A_PATH/.devtask/worktrees/$REPO_A_TASK" diff
    echo
    echo "$REPO_B_NAME worktree diff:"
    git -C "$REPO_B_PATH/.devtask/worktrees/$REPO_B_TASK" status --short
    git -C "$REPO_B_PATH/.devtask/worktrees/$REPO_B_TASK" diff
    ;;

  check)
    control
    devtask group check "$GROUP_ID"
    ;;

  review)
    control
    devtask group review "$GROUP_ID"
    ;;

  next)
    control
    devtask group board "$GROUP_ID"
    devtask group next "$GROUP_ID"
    ;;

  advance)
    control
    devtask group advance "$GROUP_ID"
    ;;

  cleanup-plan)
    control
    devtask group cleanup "$GROUP_ID" --dry-run
    ;;

  cleanup)
    control
    devtask group cleanup "$GROUP_ID"
    ;;

  help|*)
    cat <<EOF
Usage:
  CONTROL_REPO=/path/to/control REPO_A_PATH=/path/to/a REPO_B_PATH=/path/to/b $0 <action>

Actions:
  setup         init control/member repos and configure model/checks
  create        create group and member repo tasks
  run           start created/paused member tasks
  logs-a        follow repo A logs
  logs-b        follow repo B logs
  logs          print latest logs for all repos
  inspect       inspect group and member worktree diffs
  check         run group checks
  review        run group review agents
  next          show board and recommendations
  advance       run safe next group actions
  cleanup-plan  preview group cleanup
  cleanup       remove member task worktrees/metadata and group metadata

Typical flow:
  $0 setup
  $0 create
  $0 run
  $0 logs-a
  $0 inspect
  $0 check
  $0 review
  $0 next
  $0 cleanup-plan
EOF
    ;;
esac
