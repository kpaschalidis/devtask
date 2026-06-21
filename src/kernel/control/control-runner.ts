import type { RunEvent, RunOptions, SendMessageOptions } from '../agent/agent.js';
import type { RuntimeHandle } from '../sessions/session.js';
import type { AgentControlTurn, AgentControlTurnResult } from './control-turn.js';
import { KernelError } from '../shared/errors.js';

export interface AgentControlTransport {
  sendMessage(handle: RuntimeHandle, input: string, opts?: SendMessageOptions): Promise<void>;
  readEvents(handle: RuntimeHandle, opts?: RunOptions): AsyncIterable<RunEvent>;
}

export async function runControlTurn<T>(
  transport: AgentControlTransport,
  turn: AgentControlTurn<T>,
): Promise<AgentControlTurnResult<T>> {
  const attempts = Math.max(1, turn.maxAttempts ?? 2);
  let prompt = turn.prompt;
  let lastOutput = '';
  let lastError = '';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await transport.sendMessage(turn.handle, prompt, {
      outputSchema: turn.outputSchema,
      history: { kind: 'control', visible: false },
    });
    const output = await collectTurnOutput(transport, turn.handle);
    lastOutput = output;

    try {
      const parsed = JSON.parse(output.trim()) as unknown;
      return { value: turn.validator.parse(parsed), rawOutput: output };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      prompt = [
        'Your previous response did not match the required structured output contract.',
        'Return only a valid JSON object matching the schema for this turn.',
        'Do not include markdown, prose, or code fences.',
        '',
        `Validation error: ${lastError}`,
      ].join('\n');
    }
  }

  throw new KernelError(`Agent returned invalid structured output: ${lastError}\n${lastOutput}`);
}

async function collectTurnOutput(transport: AgentControlTransport, handle: AgentControlTurn<unknown>['handle']): Promise<string> {
  let output = '';
  for await (const event of transport.readEvents(handle)) {
    if (event.kind === 'output') {
      output += event.text;
    }
    if (event.kind === 'failed') throw new KernelError(event.error);
    if (event.kind === 'stalled') throw new KernelError('Agent control turn stalled');
    if (event.kind === 'max_turn_exceeded') throw new KernelError('Agent control turn hit max duration');
    if (event.kind === 'completed') return output;
  }
  return output;
}
