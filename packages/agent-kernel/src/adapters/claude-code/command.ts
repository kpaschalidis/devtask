export function buildClaudeCodePrintCommand(
  options: {
    model?: string | null;
    promptPath: string;
    completionCommand?: string | null;
  },
): string {
  const parts: string[] = [];

  const args = ['claude', '--dangerously-skip-permissions', '--print'];
  if (options.model) {
    args.push('--model', shellQuote(options.model));
  }
  args.push('<', shellQuote(options.promptPath));
  parts.push(args.join(' '));

  if (options.completionCommand?.trim()) {
    parts.push(options.completionCommand.trim());
  }

  return parts.join('; ');
}

export function buildClaudeCodeCommand(
  options: { model?: string | null; dangerouslySkipPermissions?: boolean } = {},
): string {
  const args = ['claude', '--print'];
  if (options.dangerouslySkipPermissions !== false) {
    args.push('--dangerously-skip-permissions');
  }
  if (options.model) {
    args.push('--model', shellQuote(options.model));
  }
  args.push('<', '"$DEVTASK_TASK_PATH"');
  return args.join(' ');
}

export function buildClaudeCodeInteractiveStartCommand(
  prompt: string,
  options: {
    model?: string | null;
    dangerouslySkipPermissions?: boolean;
    completionCommand?: string | null;
    nodeExecPath?: string | null;
  } = {},
): string {
  const parts: string[] = [];

  if (options.nodeExecPath) {
    const nodeBinDir = options.nodeExecPath.replace(/\/node$/, '');
    parts.push(`export PATH=${shellQuote(nodeBinDir)}:"$PATH"`);
  }

  const args = ['claude', '--print'];
  if (options.dangerouslySkipPermissions !== false) {
    args.push('--dangerously-skip-permissions');
  }
  if (options.model) {
    args.push('--model', shellQuote(options.model));
  }
  args.push(shellQuote(prompt));
  parts.push(args.join(' '));

  if (options.completionCommand?.trim()) {
    parts.push(options.completionCommand.trim());
  }

  return parts.join('; ');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._/:@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
