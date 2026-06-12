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
  args.push("-");
  args.push("<", '"$DEVTASK_TASK_PATH"');
  return args.join(" ");
}

export function buildCodexCommandArgs(
  options: { model?: string | null; fullAuto?: boolean; skipGitRepoCheck?: boolean; addDirs?: readonly string[] } = {}
): string[] {
  const args = ["exec"];
  if (options.fullAuto !== false) {
    args.push("--full-auto");
  }
  if (options.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  args.push("--add-dir", "$DEVTASK_TASK_DIR");
  for (const dir of options.addDirs ?? []) {
    args.push("--add-dir", dir);
  }
  if (options.model) {
    args.push("-m", options.model);
  }
  args.push("-");
  return args;
}

export function buildCodexResumeCommand(
  sessionId: string,
  options: { codexHome?: string | null; model?: string | null; prompt?: string | null } = {}
): string {
  const args = [];
  args.push("CODEX_DISABLE_UPDATE_CHECK=1");
  if (options.codexHome?.trim()) {
    args.push(`CODEX_HOME=${shellQuote(options.codexHome)}`);
  }
  args.push("codex", "exec", "resume", shellQuote(sessionId));
  if (options.model) {
    args.push("-m", shellQuote(options.model));
  }
  if (options.prompt?.trim()) {
    args.push(shellQuote(options.prompt.trim()));
  }
  return args.join(" ");
}

export function buildCodexInteractiveResumeCommand(
  sessionId: string,
  options: { codexHome?: string | null; model?: string | null; prompt?: string | null } = {}
): string {
  const args = [];
  args.push("CODEX_DISABLE_UPDATE_CHECK=1");
  if (options.codexHome?.trim()) {
    args.push(`CODEX_HOME=${shellQuote(options.codexHome)}`);
  }
  args.push("codex", "resume", shellQuote(sessionId));
  args.push("-c", shellQuote("check_for_update_on_startup=false"));
  if (options.model) {
    args.push("-m", shellQuote(options.model));
  }
  if (options.prompt?.trim()) {
    args.push(shellQuote(options.prompt.trim()));
  }
  return args.join(" ");
}

export function buildCodexInteractiveStartCommand(
  prompt: string,
  options: {
    codexHome?: string | null;
    model?: string | null;
    fullAuto?: boolean;
    addDirs?: readonly string[];
  } = {}
): string {
  const args = [];
  args.push("CODEX_DISABLE_UPDATE_CHECK=1");
  if (options.codexHome?.trim()) {
    args.push(`CODEX_HOME=${shellQuote(options.codexHome)}`);
  }
  args.push("codex", "--no-alt-screen");
  args.push("-c", shellQuote("check_for_update_on_startup=false"));
  if (options.fullAuto !== false) {
    args.push("-a", "never", "-s", "danger-full-access");
  }
  for (const dir of options.addDirs ?? []) {
    args.push("--add-dir", shellQuote(dir));
  }
  if (options.model) {
    args.push("-m", shellQuote(options.model));
  }
  args.push(shellQuote(prompt));
  return args.join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._/:@+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}
