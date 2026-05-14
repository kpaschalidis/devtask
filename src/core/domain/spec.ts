export interface QAEntry {
  questions: string[];
  answers: Record<string, string>;
}

export interface Spec {
  id: string;
  workId: string;
  content: string;          // locked spec markdown
  affectedRepoPaths: string[];
  qaHistory: QAEntry[];
  status: 'draft' | 'locked';
  createdAt: string;
  updatedAt: string;
}
