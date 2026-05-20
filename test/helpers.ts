import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommandOrThrow } from "../src/infra/process-runner.js";

export async function makeTempRepo(options: { withCommit?: boolean } = {}): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-test-"));
  await runCommandOrThrow("git", ["init"], { cwd: dir });
  await runCommandOrThrow("git", ["config", "user.email", "devtask@example.local"], { cwd: dir });
  await runCommandOrThrow("git", ["config", "user.name", "Devtask Test"], { cwd: dir });

  if (options.withCommit) {
    fs.writeFileSync(path.join(dir, "README.md"), "# Test Repo\n");
    await runCommandOrThrow("git", ["add", "README.md"], { cwd: dir });
    await runCommandOrThrow("git", ["commit", "-m", "initial commit"], { cwd: dir });
  }

  return dir;
}
