export type AgentProvider = "codex" | "cursor" | "claude-code";

export interface AgentSessionRef {
  provider: AgentProvider;
  transportId: string | null;
  resumeContext: Record<string, string | null>;
  summary: string | null;
  summaryIsFallback: boolean | null;
}
