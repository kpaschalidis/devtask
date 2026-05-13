import type { StageHandler } from './stage-handler.js';
import { CoreError } from '../errors/index.js';

export class HandlerRegistry {
  private readonly handlers = new Map<string, StageHandler>();

  register(name: string, handler: StageHandler): void {
    this.handlers.set(name, handler);
  }

  get(name: string): StageHandler {
    const handler = this.handlers.get(name);
    if (!handler) throw new CoreError(`No handler registered for stage: '${name}'`);
    return handler;
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }
}
