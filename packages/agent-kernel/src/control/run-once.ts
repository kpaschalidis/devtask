import type { AgentSessionInfo, RunEvent, RunOptions, SendMessageOptions } from '../agent/agent.js';
import type { SessionLabels, SessionOwner } from '../trace/session-history.js';
import type { SessionInstructions } from '../instructions/instruction-payload.js';
import type { RuntimeHandle } from '../sessions/session.js';
import type { SessionCoordinator } from '../sessions/session-coordinator.js';

export interface RunOnceInput {
  coordinator: SessionCoordinator;
  workspacePath: string;
  prompt: string;
  sessionId?: string;
  instructions?: SessionInstructions;
  owner?: SessionOwner;
  labels?: SessionLabels;
  metadata?: Record<string, unknown>;
  runOptions?: RunOptions;
  sendMessageOptions?: SendMessageOptions;
  onEvent?: (event: RunEvent) => void;
}

export interface RunOnceResult {
  status: 'completed' | 'failed' | 'input_required' | 'stalled';
  error: string | null;
  handle: RuntimeHandle;
  sessionInfo: AgentSessionInfo | null;
}

export async function runOnce(input: RunOnceInput): Promise<RunOnceResult> {
  const handle = await input.coordinator.startSession({
    sessionId: input.sessionId,
    workspacePath: input.workspacePath,
    instructions: input.instructions,
    owner: input.owner,
    labels: input.labels,
    metadata: input.metadata,
  });

  let status: RunOnceResult['status'] = 'failed';
  let error: string | null = null;

  try {
    await input.coordinator.sendMessage(handle, input.prompt, input.sendMessageOptions);
    for await (const event of input.coordinator.readEvents(handle, input.runOptions)) {
      input.onEvent?.(event);

      if (event.kind === 'completed') {
        status = 'completed';
        break;
      }
      if (event.kind === 'input_required') {
        status = 'input_required';
        error = event.prompt;
        break;
      }
      if (event.kind === 'stalled' || event.kind === 'max_turn_exceeded') {
        status = 'stalled';
        break;
      }
      if (event.kind === 'failed') {
        status = 'failed';
        error = event.error;
        break;
      }
    }
  } finally {
    const sessionInfo = await input.coordinator.getSessionInfo(handle);
    await input.coordinator.stopSession(handle, status === 'completed' ? 'completed' : 'failed');
    return {
      status,
      error,
      handle,
      sessionInfo,
    };
  }
}
