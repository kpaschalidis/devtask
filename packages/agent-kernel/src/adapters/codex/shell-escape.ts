export function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9/_.-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
