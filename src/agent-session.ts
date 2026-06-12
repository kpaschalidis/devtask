export type AgentProvider = "codex" | "cursor";

export interface AgentSessionRef {
  provider: AgentProvider;
  transportId: string | null;
  providerSessionId: string | null;
  conversationId: string | null;
  resumeTarget: string | null;
  storageRoot: string | null;
  transcriptPath: string | null;
  summary: string | null;
  summaryIsFallback: boolean | null;
}

export function emptyAgentSessionRef(provider: AgentProvider = "codex"): AgentSessionRef {
  return {
    provider,
    transportId: null,
    providerSessionId: null,
    conversationId: null,
    resumeTarget: null,
    storageRoot: null,
    transcriptPath: null,
    summary: null,
    summaryIsFallback: null
  };
}
