import type {
  SessionHistoryEvent,
  SessionThread,
  TimelineBlock,
  TranscriptMessage,
} from './session-history.js';

export function buildTranscript(
  threads: SessionThread[],
  eventsForThread: (threadId: string) => SessionHistoryEvent[],
  deliveredAtForMessage: (messageId: string) => string | null,
): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const thread of threads) {
    let assistantContent = '';
    let assistantStartedAt: string | null = null;

    const flushAssistant = (createdAt: string, open = false) => {
      if (!assistantContent) return;
      messages.push({
        id: `${thread.id}:assistant:${messages.length}`,
        owner: thread.owner,
        labels: thread.labels,
        role: 'agent',
        kind: 'output',
        content: assistantContent,
        createdAt: assistantStartedAt ?? createdAt,
        ...(open ? {} : { deliveredAt: createdAt }),
      });
      assistantContent = '';
      assistantStartedAt = null;
    };

    for (const event of eventsForThread(thread.id)) {
      if (event.visibility === 'hidden') continue;
      if (event.type === 'message.sent' && event.payload['role'] === 'user') {
        flushAssistant(event.occurredAt);
        messages.push({
          id: event.id,
          owner: thread.owner,
          labels: thread.labels,
          role: 'user',
          kind: transcriptKind(event.payload['kind']) ?? 'user-initiated',
          content: String(event.payload['text'] ?? ''),
          createdAt: event.occurredAt,
          deliveredAt: deliveredAtForMessage(event.id) ?? undefined,
        });
      } else if (event.type === 'message.delta' && event.payload['role'] === 'assistant') {
        assistantStartedAt ??= event.occurredAt;
        assistantContent += String(event.payload['text'] ?? '');
      } else if (event.type === 'message.completed' || event.type === 'turn.completed' || event.type === 'turn.failed') {
        flushAssistant(event.occurredAt);
      } else if (event.type === 'human_input.requested') {
        flushAssistant(event.occurredAt);
        messages.push({
          id: event.id,
          owner: thread.owner,
          labels: thread.labels,
          role: 'agent',
          kind: 'question',
          content: String(event.payload['prompt'] ?? event.payload['question'] ?? ''),
          createdAt: event.occurredAt,
        });
      }
    }
    flushAssistant(thread.endedAt ?? new Date().toISOString(), true);
  }
  return messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function buildTimelineBlocks(threadId: string, events: SessionHistoryEvent[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  const openByKey = new Map<string, TimelineBlock>();
  const push = (block: Omit<TimelineBlock, 'id' | 'blockSeq'>) => {
    const complete = { ...block, id: `${threadId}:block:${blocks.length + 1}`, blockSeq: blocks.length + 1 };
    blocks.push(complete);
    return complete;
  };
  const close = (block: TimelineBlock | null, endedAt: string, status: TimelineBlock['status'] = 'completed') => {
    if (!block) return;
    block.endedAt = endedAt;
    block.status = status;
  };
  const keyFor = (event: SessionHistoryEvent, kind: TimelineBlock['kind']) => `${kind}:${event.itemId ?? event.turnId ?? 'default'}`;
  const metadataFor = (event: SessionHistoryEvent, extra: Record<string, unknown> = {}) => ({
    turnId: event.turnId,
    itemId: event.itemId,
    parentItemId: event.parentItemId,
    visible: event.visibility !== 'hidden',
    ...extra,
  });

  for (const event of events) {
    const open = (kind: TimelineBlock['kind'], title: string, bodyText = '', extra: Record<string, unknown> = {}) => {
      const block = push({
        threadId,
        kind,
        status: 'open',
        startedAt: event.occurredAt,
        endedAt: null,
        title,
        bodyText,
        metadata: metadataFor(event, extra),
      });
      openByKey.set(keyFor(event, kind), block);
      return block;
    };
    switch (event.type) {
      case 'reasoning.started':
        open('reasoning', stringValue(event.payload['title']) ?? 'Thinking');
        break;
      case 'reasoning.delta': {
        const block = openByKey.get(keyFor(event, 'reasoning')) ?? open('reasoning', stringValue(event.payload['title']) ?? 'Thinking');
        block.bodyText += String(event.payload['text'] ?? '');
        break;
      }
      case 'reasoning.completed':
      case 'message.completed':
      case 'tool.completed': {
        const kind = event.type.split('.')[0] as TimelineBlock['kind'];
        const key = keyFor(event, kind);
        const status = event.type === 'tool.completed' && typeof event.payload['exitCode'] === 'number' && event.payload['exitCode'] !== 0
          ? 'failed'
          : 'completed';
        close(openByKey.get(key) ?? null, event.occurredAt, status);
        openByKey.delete(key);
        break;
      }
      case 'message.sent':
        push({
          threadId,
          kind: 'message',
          status: 'completed',
          startedAt: event.occurredAt,
          endedAt: event.occurredAt,
          title: stringValue(event.payload['title']) ?? titleForRole(event.payload['role']),
          bodyText: String(event.payload['text'] ?? ''),
          metadata: metadataFor(event, { role: event.payload['role'], kind: event.payload['kind'] }),
        });
        break;
      case 'message.delta': {
        const block = openByKey.get(keyFor(event, 'message')) ?? open('message', stringValue(event.payload['title']) ?? titleForRole(event.payload['role']), '', { role: event.payload['role'] });
        block.bodyText += String(event.payload['text'] ?? '');
        break;
      }
      case 'tool.started':
        open('tool', stringValue(event.payload['title']) ?? String(event.payload['name'] ?? 'Tool'), event.payload['input'] === undefined ? '' : JSON.stringify(event.payload['input'], null, 2), { name: event.payload['name'] });
        break;
      case 'tool.output.delta': {
        const block = openByKey.get(keyFor(event, 'tool')) ?? open('tool', stringValue(event.payload['title']) ?? 'Tool output');
        block.bodyText += String(event.payload['text'] ?? '');
        break;
      }
      case 'file.changed':
      case 'patch.generated':
        push({
          threadId,
          kind: 'file',
          status: 'completed',
          startedAt: event.occurredAt,
          endedAt: event.occurredAt,
          title: stringValue(event.payload['title']) ?? String(event.payload['path'] ?? 'File changed'),
          bodyText: String(event.payload['diff'] ?? event.payload['text'] ?? ''),
          metadata: metadataFor(event, { path: event.payload['path'], action: event.payload['action'] }),
        });
        break;
      case 'human_input.requested':
      case 'human_input.resolved':
        push({
          threadId,
          kind: 'human_input',
          status: 'completed',
          startedAt: event.occurredAt,
          endedAt: event.occurredAt,
          title: event.type === 'human_input.requested' ? 'Input requested' : 'Input resolved',
          bodyText: String(event.payload['prompt'] ?? event.payload['response'] ?? ''),
          metadata: metadataFor(event, event.payload),
        });
        break;
      case 'turn.completed':
      case 'turn.failed':
        for (const [key, block] of openByKey) {
          if (block.metadata['turnId'] === event.turnId || !event.turnId) {
            close(block, event.occurredAt, event.type === 'turn.failed' ? 'failed' : 'completed');
            openByKey.delete(key);
          }
        }
        break;
    }
  }
  return blocks;
}

function transcriptKind(value: unknown): TranscriptMessage['kind'] | null {
  return value === 'output' || value === 'thinking' || value === 'question' || value === 'answer' || value === 'user-initiated'
    ? value
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function titleForRole(role: unknown): string {
  return role === 'user' ? 'User' : role === 'system' ? 'System' : role === 'tool' ? 'Tool' : 'Assistant';
}
