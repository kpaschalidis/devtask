export function buildCodexCommand(
  options: { model?: string | null; fullAuto?: boolean; skipGitRepoCheck?: boolean; addDirs?: readonly string[] } = {}
): string {
  const args = ["codex", "exec"];
  if (options.fullAuto !== false) {
    args.push("--full-auto");
  }
  if (options.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  args.push("--add-dir", '"$DEVTASK_TASK_DIR"');
  for (const dir of options.addDirs ?? []) {
    args.push("--add-dir", shellQuote(dir));
  }
  if (options.model) {
    args.push("-m", shellQuote(options.model));
  }
  args.push("-", "<", '"$DEVTASK_TASK_PATH"');
  return args.join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._/:@+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}
