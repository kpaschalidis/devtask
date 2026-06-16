import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../infra/atomic-write.js";
import { DevtaskError } from "../infra/errors.js";

export interface PrWatchState {
  processedCommentIds: string[];
}

export const EMPTY_PR_WATCH_STATE: PrWatchState = {
  processedCommentIds: []
};

export function readPrWatchState(filePath: string): PrWatchState {
  if (!fs.existsSync(filePath)) {
    return EMPTY_PR_WATCH_STATE;
  }
  return parsePrWatchState(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown, filePath);
}

export function writePrWatchState(filePath: string, state: PrWatchState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, `${JSON.stringify(normalizePrWatchState(state), null, 2)}\n`);
}

function parsePrWatchState(value: unknown, filePath: string): PrWatchState {
  if (!isRecord(value) || !Array.isArray(value.processedCommentIds)) {
    throw new DevtaskError(`Invalid PR watch state file: ${filePath}`);
  }

  const processedCommentIds = value.processedCommentIds.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new DevtaskError(`Invalid PR watch state file: ${filePath}`);
    }
    return entry;
  });

  return normalizePrWatchState({ processedCommentIds });
}

function normalizePrWatchState(state: PrWatchState): PrWatchState {
  return {
    processedCommentIds: [...new Set(state.processedCommentIds)]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
