import { DevtaskError } from "./errors.js";
import { resolvePaths, resolveWorkspacePaths, type DevtaskPaths } from "./paths.js";
import { getWorkspaceTarget } from "./workspace-targets.js";

export interface TaskCommandTarget {
  paths: DevtaskPaths;
  taskId: string;
  displayId: string;
}

export function resolveTaskCommandTarget(reference: string, start = process.cwd()): TaskCommandTarget {
  const qualified = parseQualifiedTaskReference(reference);
  if (!qualified) {
    return {
      paths: resolvePaths(start),
      taskId: reference,
      displayId: reference
    };
  }

  const workspacePaths = resolveWorkspacePaths(start);
  const target = getWorkspaceTarget(workspacePaths, qualified.targetId);
  return {
    paths: resolvePaths(target.repoPath),
    taskId: qualified.taskId,
    displayId: `${qualified.targetId}/${qualified.taskId}`
  };
}

function parseQualifiedTaskReference(reference: string): { targetId: string; taskId: string } | null {
  const slash = reference.indexOf("/");
  if (slash === -1) {
    return null;
  }

  const targetId = reference.slice(0, slash).trim();
  const taskId = reference.slice(slash + 1).trim();
  if (!targetId || !taskId) {
    throw new DevtaskError(`Invalid task reference ${reference}. Use <task-id> or <target>/<task-id>.`);
  }
  return {
    targetId,
    taskId
  };
}
