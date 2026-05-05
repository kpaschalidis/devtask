import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

export async function makeTempRepo(options: { withCommit?: boolean } = {}): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtask-test-"));
  await execa("git", ["init"], { cwd: dir });
  await execa("git", ["config", "user.email", "devtask@example.local"], { cwd: dir });
  await execa("git", ["config", "user.name", "Devtask Test"], { cwd: dir });

  if (options.withCommit) {
    fs.writeFileSync(path.join(dir, "README.md"), "# Test Repo\n");
    await execa("git", ["add", "README.md"], { cwd: dir });
    await execa("git", ["commit", "-m", "initial commit"], { cwd: dir });
  }

  return dir;
}
