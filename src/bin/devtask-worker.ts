#!/usr/bin/env node
import { runWorker } from "../worker.js";

const id = process.argv[2];
const rootFlagIndex = process.argv.indexOf("--root");
const root = rootFlagIndex === -1 ? undefined : process.argv[rootFlagIndex + 1];

if (!id) {
  console.error("devtask-worker: missing task id");
  process.exit(1);
}

await runWorker(id, { root });
