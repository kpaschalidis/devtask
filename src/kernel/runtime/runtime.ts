import type { RuntimeHandle } from '../sessions/session.js';

export type { RuntimeHandle };

export interface RuntimeCreateConfig {
  sessionId: string;
  workspacePath: string;
  launchCommand: string;
  environment: Record<string, string>;
}

export interface AttachInfo {
  command: string;
  description: string;
}

export interface Runtime {
  readonly name: string;
  preflight?(): Promise<void>;
  create(config: RuntimeCreateConfig): Promise<RuntimeHandle>;
  destroy(handle: RuntimeHandle): Promise<void>;
  sendMessage(handle: RuntimeHandle, message: string): Promise<void>;
  isAlive(handle: RuntimeHandle): Promise<boolean>;
  isProcessRunning?(handle: RuntimeHandle, processName: string): Promise<boolean>;
  captureOutput?(handle: RuntimeHandle, lines?: number): Promise<string>;
  getAttachInfo?(handle: RuntimeHandle): AttachInfo;
}
