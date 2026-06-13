import type { WorkItem } from "../storage/work-store.js";

export function recommendWorkNextAction(
  item: WorkItem,
  options: { hasOrchestratedPlan: boolean; isMaterialized: boolean; hasActiveSession: boolean }
): string {
  if (!options.hasOrchestratedPlan) {
    return `devtask work orchestrate ${shellQuote(item.id)}`;
  }
  if (!options.isMaterialized) {
    return `devtask work materialize ${shellQuote(item.id)}`;
  }
  if (options.hasActiveSession) {
    return `devtask work board ${shellQuote(item.id)}`;
  }
  return `devtask work execute ${shellQuote(item.id)}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
