import type { RuntimeHandle } from './session.js';

interface KernelHandleState {
  instructionCleanup?: () => Promise<void>;
  sessionThreadId?: string;
  sessionHistoryVisibility?: 'visible' | 'hidden';
}

const KEY = '__kernel';

export function getKernelHandleState(handle: RuntimeHandle): KernelHandleState {
  const state = handle.data[KEY];
  if (!state || typeof state !== 'object') {
    const initial: KernelHandleState = {};
    handle.data[KEY] = initial;
    return initial;
  }
  return state as KernelHandleState;
}

export function setInstructionCleanup(handle: RuntimeHandle, cleanup?: () => Promise<void>): void {
  getKernelHandleState(handle).instructionCleanup = cleanup;
}

export function getInstructionCleanup(handle: RuntimeHandle): (() => Promise<void>) | undefined {
  return getKernelHandleState(handle).instructionCleanup;
}

export function clearInstructionCleanup(handle: RuntimeHandle): (() => Promise<void>) | undefined {
  const state = getKernelHandleState(handle);
  const cleanup = state.instructionCleanup;
  delete state.instructionCleanup;
  return cleanup;
}

export function setSessionThreadId(handle: RuntimeHandle, threadId: string): void {
  getKernelHandleState(handle).sessionThreadId = threadId;
}

export function getSessionThreadId(handle: RuntimeHandle): string | undefined {
  return getKernelHandleState(handle).sessionThreadId;
}

export function setSessionHistoryVisibility(handle: RuntimeHandle, visibility: 'visible' | 'hidden'): void {
  getKernelHandleState(handle).sessionHistoryVisibility = visibility;
}
