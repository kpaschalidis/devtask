export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function terminateProcessGroup(pid: number | null | undefined): void {
  if (!pid) return;

  try {
    process.kill(-pid, "SIGTERM");
    return;
  } catch {
    // Fall back to killing the process directly when it is not a process-group leader.
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The process may already be gone; lifecycle reconciliation handles stale metadata.
  }
}
