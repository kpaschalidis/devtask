export interface AgentQuestion {
  id: string;
  workId: string;
  taskId: string | null;
  runAttemptId: string;
  question: string;
  answer: string | null;
  askedAt: string;
  answeredAt: string | null;
}
