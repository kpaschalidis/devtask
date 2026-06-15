import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const originalDevtaskHome = process.env.DEVTASK_HOME;
const originalMkdtempSync = fs.mkdtempSync.bind(fs);
const originalPromisesMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
const trackedTempDirs = new Set<string>();

process.env.DEVTASK_HOME = originalMkdtempSync(path.join(os.tmpdir(), "devtask-home-suite-"));
trackedTempDirs.add(process.env.DEVTASK_HOME);

fs.mkdtempSync = ((prefix: string, options?: Parameters<typeof originalMkdtempSync>[1]) => {
  const dir = originalMkdtempSync(prefix, options);
  trackedTempDirs.add(dir);
  return dir;
}) as typeof fs.mkdtempSync;

fs.promises.mkdtemp = (async (prefix: string, options?: Parameters<typeof originalPromisesMkdtemp>[1]) => {
  const dir = await originalPromisesMkdtemp(prefix, options);
  trackedTempDirs.add(dir);
  return dir;
}) as typeof fs.promises.mkdtemp;

afterAll(() => {
  fs.mkdtempSync = originalMkdtempSync;
  fs.promises.mkdtemp = originalPromisesMkdtemp;

  if (originalDevtaskHome === undefined) {
    delete process.env.DEVTASK_HOME;
  } else {
    process.env.DEVTASK_HOME = originalDevtaskHome;
  }

  for (const dir of [...trackedTempDirs].sort((left, right) => right.length - left.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
