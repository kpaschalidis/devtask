import fs from "node:fs";
import path from "node:path";
import type { DevtaskPaths } from "../infra/paths.js";
import { workItemResultsDir } from "../infra/paths.js";
import type { VerifyTaskResult, VerifyWorkResult } from "./work-service.js";

export function writeWorkResult(paths: DevtaskPaths, workId: string, name: string, value: unknown): void {
  const dir = workItemResultsDir(paths, workId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeScopedVerifyResult(paths: DevtaskPaths, workId: string, name: string, task: VerifyTaskResult): void {
  const existing = readVerifyWorkResult(paths, workId, name);
  const tasks = existing.tasks.filter((entry) => entry.repoId !== task.repoId);
  tasks.push(task);
  tasks.sort((left, right) => left.repoId.localeCompare(right.repoId));
  writeWorkResult(paths, workId, name, {
    workId,
    tasks,
    generatedAt: new Date().toISOString()
  });
}

export function readVerifyWorkResult(paths: DevtaskPaths, workId: string, name: string): VerifyWorkResult {
  try {
    const filePath = path.join(workItemResultsDir(paths, workId), `${name}.json`);
    if (!fs.existsSync(filePath)) {
      return { workId, tasks: [], generatedAt: new Date(0).toISOString() };
    }
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<VerifyWorkResult>;
    return {
      workId,
      tasks: Array.isArray(value.tasks) ? value.tasks as VerifyTaskResult[] : [],
      generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : new Date(0).toISOString()
    };
  } catch {
    return { workId, tasks: [], generatedAt: new Date(0).toISOString() };
  }
}
