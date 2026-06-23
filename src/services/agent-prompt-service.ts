import type { DevtaskConfig } from "../infra/config.js";
import { DevtaskError } from "../infra/errors.js";
import type { AgentPromptResult, AgentStartOptions, RunOptions } from "../adapters/agent-kernel/run-once.js";
import { runKernelOneShot } from "../adapters/agent-kernel/run-once.js";

export async function runWorkAgentPrompt(
  config: DevtaskConfig,
  startOptions: AgentStartOptions,
  prompt: string,
  options: {
    outputPath: string;
    runOptions?: RunOptions;
    onOutput?: (chunk: string) => void;
  },
): Promise<AgentPromptResult> {
  const kernelResult = await runKernelOneShot(config, startOptions, prompt, options);
  if (kernelResult) {
    return kernelResult;
  }
  throw new DevtaskError(`Kernel one-shot execution does not support agent provider: ${config.agent.provider}`);
}
