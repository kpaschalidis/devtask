import fs from "node:fs";
import type { DevtaskPaths } from "./paths.js";

export interface DevtaskConfig {
  schemaVersion: 1;
  codex: {
    model: string | null;
    fullAuto: boolean;
  };
}

export const DEFAULT_CONFIG: DevtaskConfig = {
  schemaVersion: 1,
  codex: {
    model: null,
    fullAuto: true
  }
};

export function readConfig(paths: DevtaskPaths): DevtaskConfig {
  if (!fs.existsSync(paths.configPath)) {
    return DEFAULT_CONFIG;
  }

  const value = JSON.parse(fs.readFileSync(paths.configPath, "utf8")) as Partial<DevtaskConfig>;
  return {
    schemaVersion: 1,
    codex: {
      model: typeof value.codex?.model === "string" ? value.codex.model : null,
      fullAuto: typeof value.codex?.fullAuto === "boolean" ? value.codex.fullAuto : true
    }
  };
}

export function writeConfig(paths: DevtaskPaths, config: DevtaskConfig): void {
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function buildCodexCommand(options: { model?: string | null; fullAuto?: boolean } = {}): string {
  const args = ["codex", "exec"];
  if (options.fullAuto !== false) {
    args.push("--full-auto");
  }
  args.push("--add-dir", '"$DEVTASK_TASK_DIR"');
  if (options.model) {
    args.push("-m", shellQuote(options.model));
  }
  args.push("-", "<", '"$DEVTASK_TASK_PATH"');
  return args.join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._/:@+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}
