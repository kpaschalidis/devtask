import type { ServerResponse } from "node:http";

export interface SseStream {
  send(event: string, data: unknown, id?: string): void;
  heartbeat(): void;
  close(): void;
}

export function openSseStream(response: ServerResponse): SseStream {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  response.flushHeaders?.();
  response.write(": connected\n\n");

  return {
    send(event: string, data: unknown, id?: string) {
      if (id) {
        response.write(`id: ${id}\n`);
      }
      response.write(`event: ${event}\n`);
      const payload = JSON.stringify(data);
      for (const line of payload.split("\n")) {
        response.write(`data: ${line}\n`);
      }
      response.write("\n");
    },
    heartbeat() {
      response.write(": heartbeat\n\n");
    },
    close() {
      response.end();
    },
  };
}

export function parseLastEventId(value: string | string[] | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries.map(([key, child]) => [key, sortValue(child)]));
}
