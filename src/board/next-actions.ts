import type { WorkItem } from "../work-store.js";

export function recommendWorkNextAction(
  item: WorkItem,
  options: { hasPlan: boolean; isMaterialized: boolean; hasActiveSession: boolean }
): string {
  if (!options.hasPlan) {
    return `devtask work plan ${shellQuote(item.id)}`;
  }
  if (!options.isMaterialized) {
    return `devtask work implement ${shellQuote(item.id)}`;
  }
  if (options.hasActiveSession) {
    return `devtask work board ${shellQuote(item.id)}`;
  }
  return `devtask session list ${shellQuote(item.id)}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
