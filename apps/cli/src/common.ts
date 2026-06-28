import { DevtaskError } from "devtask/infra/errors";

export function printError(error: unknown): never {
  if (error instanceof DevtaskError) {
    console.error(`devtask: ${error.message}`);
    process.exit(1);
  }

  throw error;
}

export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => displayWidth(row[index] ?? "")))
  );

  console.log(headers.map((header, index) => header.padEnd(widths[index])).join("  "));
  for (const row of rows) {
    console.log(headers.map((_header, index) => (row[index] ?? "").padEnd(widths[index])).join("  "));
  }
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function displayWidth(value: string): number {
  return Array.from(value).length;
}
