export function buildCursorCommand(
  options: { model?: string | null; fullAuto?: boolean } = {}
): string {
  const args = ["agent"];
  if (options.fullAuto !== false) {
    args.push("--force", "--sandbox", "disabled", "--approve-mcps");
  }
  if (options.model) {
    args.push("--model", shellQuote(options.model));
  }
  args.push("--", '"$(cat "$DEVTASK_TASK_PATH")"');
  return args.join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._/:@+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}
