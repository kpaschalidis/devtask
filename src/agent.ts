import { captureOutputAsync, getForegroundCommand, isSessionAliveAsync, sendKeyAsync } from "./tmux.js";

export const CODEX_PROCESS_NAME = "codex";
export const CLAUDE_PROCESS_NAME = "claude";

// Codex ships as a Node.js script — pane_current_command returns "node".
// Map agent names to the actual foreground process names tmux reports.
const FOREGROUND_ALIASES: Record<string, string[]> = {
  codex: ["codex", "node"],
  claude: ["claude", "node"]
};

const UPDATE_PROMPT_RE = /Update available!/;

export async function waitForAgentReady(
  session: string,
  processName: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  const validForegrounds = new Set(FOREGROUND_ALIASES[processName] ?? [processName]);
  let stableCount = 0;
  let lastOutput = "";

  while (Date.now() < deadline) {
    const [alive, foreground, output] = await Promise.all([
      isSessionAliveAsync(session),
      getForegroundCommand(session),
      captureOutputAsync(session, 20)
    ]);

    if (!alive) return false;

    // Dismiss the codex update prompt whenever it appears, regardless of
    // whether the foreground name matched yet.
    if (UPDATE_PROMPT_RE.test(output)) {
      await sendKeyAsync(session, "Down");
      await sleep(200);
      await sendKeyAsync(session, "Enter");
      stableCount = 0;
      lastOutput = "";
      await sleep(pollMs);
      continue;
    }

    const isActive = foreground !== null && validForegrounds.has(foreground);
    if (!isActive) {
      stableCount = 0;
      lastOutput = "";
      await sleep(pollMs);
      continue;
    }

    if (output === lastOutput) {
      stableCount++;
    } else {
      stableCount = 0;
      lastOutput = output;
    }

    if (stableCount >= 2) return true;

    await sleep(pollMs);
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
