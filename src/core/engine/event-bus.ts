import type { DomainEvent } from '../events/domain-events.js';

export interface EventBus {
  publish(event: DomainEvent): void;
  subscribe(handler: (event: DomainEvent) => void): () => void;  // returns unsubscribe fn
}

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Set<(event: DomainEvent) => void>();

  publish(event: DomainEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  subscribe(handler: (event: DomainEvent) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }
}
