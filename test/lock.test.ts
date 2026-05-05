import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, releaseLock } from "../src/lock.js";

describe("lock", () => {
  it("acquires and releases an atomic lock", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-lock-"));
    const lockPath = path.join(dir, "lock.json");

    expect(acquireLock(lockPath)).toBe(true);
    expect(acquireLock(lockPath)).toBe(false);

    releaseLock(lockPath);

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(acquireLock(lockPath)).toBe(true);
  });

  it("reclaims a stale lock whose process is gone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-lock-"));
    const lockPath = path.join(dir, "lock.json");
    fs.writeFileSync(lockPath, "{\n  \"pid\": 99999999,\n  \"acquiredAt\": \"2026-01-01T00:00:00.000Z\"\n}\n");

    expect(acquireLock(lockPath)).toBe(true);
  });
});
