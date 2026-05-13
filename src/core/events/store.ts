import type { DomainEvent } from './domain-events.js';

export interface EventStore {
  append(event: DomainEvent): void;
  history(workId: string): DomainEvent[];
  close(): void;
}
