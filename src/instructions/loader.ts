import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INSTRUCTIONS_DIR = path.dirname(fileURLToPath(import.meta.url));

export function loadInstruction(name: string, vars: Record<string, string>): string {
  const templatePath = path.join(INSTRUCTIONS_DIR, `${name}.md`);
  let content = fs.readFileSync(templatePath, "utf8");
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content;
}
