import type { MissionSnapshot } from '../domain/types.js';

export interface NewMissionEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface MissionEvent {
  id: string;
  missionId: string;
  sequence: number;
  occurredAt: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface MissionCommit {
  id: string;
  expectedRevision: number;
  snapshot: MissionSnapshot;
  events: NewMissionEvent[];
}

export interface MissionStore {
  create(snapshot: MissionSnapshot, events: NewMissionEvent[]): MissionSnapshot;
  get(id: string): MissionSnapshot | null;
  commit(input: MissionCommit): MissionSnapshot;
  listEvents(id: string, afterSequence?: number): MissionEvent[];
}
