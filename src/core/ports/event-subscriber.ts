import type { DomainEvent } from '../events/domain-events.js';

export interface EventSubscriber {
  onEvent(event: DomainEvent): void | Promise<void>;
}
