#!/usr/bin/env bash
set -euo pipefail

# Edit these constants for each smoke run.
TARGET_REPO="${TARGET_REPO:-/path/to/your/repo}"
TASK_ID="${TASK_ID:-readme-smoke}"
MODEL="${MODEL:-gpt-5.2}"
GOAL="${GOAL:-Make one tiny README wording improvement only. Keep changes docs-only and scoped to README.md. Do not change code, package files, config, generated files, or lockfiles.}"

# Edit these checks to match the target repo. Leave empty to skip config.
CHECK_COMMAND_1="${CHECK_COMMAND_1:-npm test}"
CHECK_COMMAND_2="${CHECK_COMMAND_2:-npm run typecheck}"

ACTION="${1:-help}"

die() {
  echo "smoke-regular: $*" >&2
  exit 1
}

repo() {
  [[ "$TARGET_REPO" != "/path/to/your/repo" ]] || die "edit TARGET_REPO at the top of this script or pass TARGET_REPO=/path/to/repo"
  [[ -d "$TARGET_REPO" ]] || die "TARGET_REPO does not exist: $TARGET_REPO"
  cd "$TARGET_REPO"
}

configure_checks() {
  local checks=()
  [[ -z "$CHECK_COMMAND_1" ]] || checks+=("$CHECK_COMMAND_1")
  [[ -z "$CHECK_COMMAND_2" ]] || checks+=("$CHECK_COMMAND_2")
  if [[ "${#checks[@]}" -gt 0 ]]; then
    devtask config check "${checks[@]}"
  fi
}

case "$ACTION" in
  setup)
    repo
    devtask init
    devtask config model "$MODEL"
    configure_checks
    devtask config show
    ;;

  create)
    repo
    devtask create "$TASK_ID" --goal "$GOAL"
    ;;

  run)
    repo
    devtask run "$TASK_ID"
    devtask board
    ;;

  logs)
    repo
    devtask logs -f "$TASK_ID"
    ;;

  inspect)
    repo
    devtask status "$TASK_ID"
    devtask inspect "$TASK_ID"
    echo
    echo "Worktree diff:"
    git -C ".devtask/worktrees/$TASK_ID" status --short
    git -C ".devtask/worktrees/$TASK_ID" diff
    ;;

  check)
    repo
    devtask check "$TASK_ID"
    ;;

  review)
    repo
    devtask review "$TASK_ID"
    ;;

  approve)
    repo
    devtask mark "$TASK_ID" approved
    devtask board
    ;;

  cleanup-plan)
    repo
    devtask cleanup "$TASK_ID" --dry-run
    ;;

  cleanup)
    repo
    devtask cleanup "$TASK_ID"
    ;;

  help|*)
    cat <<EOF
Usage:
  TARGET_REPO=/path/to/repo TASK_ID=readme-smoke $0 <action>

Actions:
  setup         init devtask and configure model/checks
  create        create the docs-only task
  run           start the task worker
  logs          follow task logs
  inspect       show task state and worktree diff
  check         run configured checks
  review        run review agent
  approve       mark task approved
  cleanup-plan  preview cleanup
  cleanup       remove task worktree and metadata

Typical flow:
  $0 setup
  $0 create
  $0 run
  $0 logs
  $0 inspect
  $0 check
  $0 review
  $0 approve
  $0 cleanup-plan
EOF
    ;;
esac
