export type AgentProvider = "codex" | "cursor";

export interface AgentSessionRef {
  provider: AgentProvider;
  transportId: string | null;
  resumeContext: Record<string, string | null>;
  summary: string | null;
  summaryIsFallback: boolean | null;
}

export function emptyAgentSessionRef(provider: AgentProvider = "codex"): AgentSessionRef {
  return {
    provider,
    transportId: null,
    resumeContext: {},
    summary: null,
    summaryIsFallback: null
  };
}
