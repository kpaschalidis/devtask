export type AgentControlEvent<TType extends string = string, TPayload = unknown> = {
  type: TType;
} & TPayload;

export interface ControlTurnFailure {
  kind: 'invalid_output' | 'agent_failed' | 'stalled';
  message: string;
  rawOutput?: string;
}
