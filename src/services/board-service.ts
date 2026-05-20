import type { DevtaskPaths } from "../paths.js";
import { buildWorkspaceBoard, type WorkspaceBoardRow } from "../board/workspace-board.js";
import { buildWorkBoard, type RepoTaskBoardRow } from "../board/work-board.js";

export async function getWorkspaceBoard(paths: DevtaskPaths): Promise<WorkspaceBoardRow[]> {
  return buildWorkspaceBoard(paths);
}

export async function getWorkBoard(paths: DevtaskPaths, workId: string): Promise<RepoTaskBoardRow[]> {
  return buildWorkBoard(paths, workId);
}
