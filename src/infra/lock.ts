import fs from "node:fs";
import { DevtaskError } from "./errors.js";
import { isProcessAlive } from "./processes.js";

export interface TaskLock {
  pid: number;
  acquiredAt: string;
}

export function acquireLock(lockPath: string): boolean {
  const lock: TaskLock = {
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  };

  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`);
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw error;
    }
  }

  const existing = readLock(lockPath);
  if (existing && isProcessAlive(existing.pid)) {
    return false;
  }

  fs.rmSync(lockPath, { force: true });
  return acquireLock(lockPath);
}

export function releaseLock(lockPath: string): void {
  const existing = readLock(lockPath);
  if (!existing || existing.pid === process.pid) {
    fs.rmSync(lockPath, { force: true });
    return;
  }

  throw new DevtaskError(`Refusing to release lock owned by process ${existing.pid}`);
}

function readLock(lockPath: string): TaskLock | null {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<TaskLock>;
    if (typeof value.pid !== "number" || typeof value.acquiredAt !== "string") {
      return null;
    }
    return { pid: value.pid, acquiredAt: value.acquiredAt };
  } catch {
    return null;
  }
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
