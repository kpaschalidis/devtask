import { createRequire } from 'node:module';
import path from 'node:path';
import type { SessionHistoryStore } from './session-history-store.js';
import { FileSessionHistoryStore } from '../storage/file/session-history-store.js';
import { SqliteSessionHistoryStore } from '../storage/sqlite/session-history-store.js';

export interface PersistentSessionHistoryStoreHandle {
  store: SessionHistoryStore;
  backend: 'sqlite' | 'file';
  close(): void;
}

const require = createRequire(import.meta.url);

export function openPersistentSessionHistoryStore(
  preferredPath: string,
): PersistentSessionHistoryStoreHandle {
  const sqlite = loadNodeSqlite();
  if (sqlite) {
    const db = new sqlite.DatabaseSync(preferredPath);
    const store = new SqliteSessionHistoryStore(db);
    return {
      store,
      backend: 'sqlite',
      close() {
        db.close();
      },
    };
  }

  const filePath = `${stripExtension(preferredPath)}.json`;
  const store = new FileSessionHistoryStore(filePath);
  return {
    store,
    backend: 'file',
    close() {
      store.close();
    },
  };
}

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown;
  };
  close(): void;
}

function loadNodeSqlite(): { DatabaseSync: new (path: string) => DatabaseSyncLike } | null {
  try {
    return require('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSyncLike };
  } catch {
    return null;
  }
}

function stripExtension(filePath: string): string {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, parsed.name);
}
