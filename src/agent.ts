import { captureOutputAsync, getForegroundCommand, isSessionAliveAsync } from "./tmux.js";

export const CODEX_PROCESS_NAME = "codex";
export const CLAUDE_PROCESS_NAME = "claude";

export async function waitForAgentReady(
  session: string,
  processName: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let stableCount = 0;
  let lastOutput = "";

  while (Date.now() < deadline) {
    const [alive, foreground, output] = await Promise.all([
      isSessionAliveAsync(session),
      getForegroundCommand(session),
      captureOutputAsync(session, 20)
    ]);

    if (!alive) return false;

    const isActive = foreground === processName || (foreground?.includes(processName) ?? false);
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
