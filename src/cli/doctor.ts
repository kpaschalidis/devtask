import { execSync } from "node:child_process";
import { Command } from "commander";
import { findWorkspaceRoot } from "../infra/paths.js";

interface Check {
  label: string;
  run: () => boolean;
  fix: string;
}

function commandExists(cmd: string, args: string[]): boolean {
  try {
    execSync([cmd, ...args].join(" "), { stdio: "ignore" });
    return true;
  } catch (err: unknown) {
    // ENOENT means the binary is not on PATH; non-zero exit still means it exists
    if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    return true;
  }
}

const checks: Check[] = [
  {
    label: "Node.js >= 22",
    run: () => {
      const [major] = process.versions.node.split(".").map(Number);
      return major >= 22;
    },
    fix: "Run: nvm install 22 && nvm use 22"
  },
  {
    label: "git",
    run: () => commandExists("git", ["--version"]),
    fix: "Install git: https://git-scm.com/downloads"
  },
  {
    label: "tmux",
    run: () => commandExists("tmux", ["-V"]),
    fix: "Install tmux: brew install tmux  (macOS) or apt install tmux  (Linux)"
  },
  {
    label: "codex CLI",
    run: () => commandExists("codex", ["--version"]),
    fix: "Install Codex CLI: npm install -g @openai/codex"
  },
  {
    label: "claude CLI",
    run: () => commandExists("claude", ["--version"]),
    fix: "Install Claude Code: npm install -g @anthropic-ai/claude-code"
  },
  {
    label: "devtask workspace",
    run: () => findWorkspaceRoot() !== null,
    fix: "Run: devtask init  (from inside a git repository)"
  }
];

export function registerDoctorCommands(program: Command): void {
  program
    .command("doctor")
    .description("Check prerequisites for running devtask.")
    .action(() => {
      let allPassed = true;

      for (const check of checks) {
        const passed = check.run();
        if (passed) {
          console.log(`✓ ${check.label}`);
        } else {
          console.log(`✗ ${check.label} — ${check.fix}`);
          allPassed = false;
        }
      }

      if (!allPassed) {
        process.exit(1);
      }
    });
}
