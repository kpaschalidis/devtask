import crypto from 'node:crypto';
import type { MissionSnapshot } from '../domain/types.js';
import { StaleRevisionError, MissionAlreadyExistsError } from '../domain/errors.js';
import type { MissionStore, NewMissionEvent, MissionEvent, MissionCommit } from './store.js';

export class InMemoryMissionStore implements MissionStore {
  private snapshots = new Map<string, MissionSnapshot>();
  private events = new Map<string, MissionEvent[]>();
  private sequences = new Map<string, number>();

  create(snapshot: MissionSnapshot, events: NewMissionEvent[]): MissionSnapshot {
    if (this.snapshots.has(snapshot.id)) throw new MissionAlreadyExistsError(snapshot.id);
    const stored: MissionSnapshot = structuredClone({ ...snapshot, revision: 0 });
    this.snapshots.set(stored.id, stored);
    this.sequences.set(stored.id, 0);
    this.events.set(stored.id, []);
    this.appendEvents(stored.id, events);
    return structuredClone(stored);
  }

  get(id: string): MissionSnapshot | null {
    const stored = this.snapshots.get(id);
    return stored ? structuredClone(stored) : null;
  }

  commit(input: MissionCommit): MissionSnapshot {
    const current = this.snapshots.get(input.id);
    if (!current) throw new StaleRevisionError(input.id, input.expectedRevision, -1);
    if (current.revision !== input.expectedRevision) {
      throw new StaleRevisionError(input.id, input.expectedRevision, current.revision);
    }
    const stored: MissionSnapshot = structuredClone({ ...input.snapshot, revision: input.expectedRevision + 1 });
    this.snapshots.set(input.id, stored);
    this.appendEvents(input.id, input.events);
    return structuredClone(stored);
  }

  listEvents(id: string, afterSequence?: number): MissionEvent[] {
    const all = this.events.get(id) ?? [];
    const filtered = afterSequence === undefined ? all : all.filter((e) => e.sequence > afterSequence);
    return structuredClone(filtered);
  }

  private appendEvents(missionId: string, newEvents: NewMissionEvent[]): void {
    const existing = this.events.get(missionId) ?? [];
    let seq = this.sequences.get(missionId) ?? 0;
    const now = new Date().toISOString();
    for (const ev of newEvents) {
      seq += 1;
      existing.push({
        id: crypto.randomUUID(),
        missionId,
        sequence: seq,
        occurredAt: now,
        type: ev.type,
        payload: structuredClone(ev.payload),
      });
    }
    this.sequences.set(missionId, seq);
    this.events.set(missionId, existing);
  }
}
