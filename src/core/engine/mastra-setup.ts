import { Mastra } from '@mastra/core';
import { MastraCompositeStore, WorkflowsInMemory, InMemoryDB } from '@mastra/core/storage';
import type { Workflow } from '@mastra/core/workflows';

export interface MastraEngineConfig {
  workflows: Record<string, Workflow>;
}

export function createMastraEngine({ workflows }: MastraEngineConfig): Mastra {
  const db = new InMemoryDB();
  const workflowsStore = new WorkflowsInMemory({ db });
  const storage = new MastraCompositeStore({
    id: 'devtask',
    domains: { workflows: workflowsStore },
  });

  return new Mastra({ workflows, storage });
}
