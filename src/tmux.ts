import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { DevtaskPaths } from "./paths.js";
import { DevtaskError } from "./errors.js";

export function tmuxSessionName(paths: DevtaskPaths, taskId: string): string {
  const repoName = path.basename(paths.root).replace(/[^A-Za-z0-9_-]/g, "-");
  const rootHash = crypto.createHash("sha1").update(paths.root).digest("hex").slice(0, 8);
  const safeTaskId = taskId.replace(/[^A-Za-z0-9_-]/g, "-");
  return `devtask-${repoName}-${rootHash}-${safeTaskId}`;
}

export function assertTmuxAvailable(): void {
  const result = spawnSync("tmux", ["-V"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new DevtaskError("tmux is not available. Install tmux or start without --tmux.");
  }
}

export function tmuxSessionExists(session: string): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" });
  return result.status === 0;
}

export function startTmuxSession(session: string, command: string[], cwd: string): void {
  assertTmuxAvailable();
  if (tmuxSessionExists(session)) {
    throw new DevtaskError(`tmux session ${session} already exists`);
  }

  const result = spawnSync("tmux", ["new-session", "-d", "-s", session, ...command], {
    cwd,
    stdio: "inherit"
  });

  if (result.error || result.status !== 0) {
    throw new DevtaskError(`Failed to start tmux session ${session}`);
  }
}

export function attachTmuxSession(session: string): void {
  assertTmuxAvailable();
  if (!tmuxSessionExists(session)) {
    throw new DevtaskError(`tmux session ${session} does not exist`);
  }

  const result = spawnSync("tmux", ["attach-session", "-t", session], { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new DevtaskError(`Failed to attach tmux session ${session}`);
  }
}

export function killTmuxSession(session: string): void {
  assertTmuxAvailable();
  if (!tmuxSessionExists(session)) {
    return;
  }

  const result = spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new DevtaskError(`Failed to kill tmux session ${session}`);
  }
}
