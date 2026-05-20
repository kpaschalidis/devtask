import type { DevtaskPaths } from "../paths.js";
import { buildWorkBoardRows } from "../work-board.js";
import { getWorkItem } from "../work-store.js";

export type RepoTaskBoardRow = Awaited<ReturnType<typeof buildWorkBoardRows>>[number];

export async function buildControlPlaneWorkBoard(paths: DevtaskPaths, workId: string): Promise<RepoTaskBoardRow[]> {
  return buildWorkBoardRows(paths, getWorkItem(paths, workId));
}
